const helpers = this.helpers;
const env = {
  SUPABASE_URL: $env.SUPABASE_URL,
  SUPABASE_KEY: $env.SUPABASE_SERVICE_KEY,
  OPENAI_KEY: $env.OPENAI_API_KEY,
  META_TOKEN: $env.META_ACCESS_TOKEN,
  META_PHONE_ID: $env.META_PHONE_NUMBER_ID,
  N8N_BASE_URL: $env.N8N_BASE_URL,
};

const sbHeaders = {
  apikey: env.SUPABASE_KEY,
  Authorization: `Bearer ${env.SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

async function sbRequest(method, path, body, extraHeaders) {
  return helpers.httpRequest({
    method,
    url: `${env.SUPABASE_URL}/rest/v1/${path}`,
    headers: { ...sbHeaders, ...(extraHeaders || {}) },
    body,
    json: true,
    timeout: 15000,
  });
}

async function sbPatch(path, body) {
  return sbRequest('PATCH', path, body, { Prefer: 'return=representation' });
}

async function askOpenAIJson(systemPrompt, userText) {
  const res = await helpers.httpRequest({
    method: 'POST',
    url: 'https://api.openai.com/v1/chat/completions',
    headers: {
      Authorization: `Bearer ${env.OPENAI_KEY}`,
      'Content-Type': 'application/json',
    },
    body: {
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText || '' },
      ],
    },
    json: true,
    timeout: 30000,
  });
  try {
    return JSON.parse(res.choices[0].message.content);
  } catch (e) {
    return null;
  }
}

function sanitizeTemplateParam(text) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' -- ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 1000) || '(see details)';
}

// WhatsApp rejects free-form text once 24h have passed since the recipient's
// last inbound message (error 131047) -- many of our sends (PM notifications,
// escalations, staff pings) are proactive and can easily land outside that
// window. Fall back to the approved "bali_notification" utility template
// (single body variable) instead of the send just failing.
async function sendWhatsAppTemplate(toNumber, text) {
  const res = await helpers.httpRequest({
    method: 'POST',
    url: `https://graph.facebook.com/v20.0/${env.META_PHONE_ID}/messages`,
    headers: { Authorization: `Bearer ${env.META_TOKEN}`, 'Content-Type': 'application/json' },
    body: {
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'template',
      template: {
        name: 'bali_notification',
        language: { code: 'en_US' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: sanitizeTemplateParam(text) }] }],
      },
    },
    json: true,
    timeout: 20000,
  });
  return res?.messages?.[0]?.id || null;
}

async function sendWhatsApp(toNumber, text) {
  try {
    const res = await helpers.httpRequest({
      method: 'POST',
      url: `https://graph.facebook.com/v20.0/${env.META_PHONE_ID}/messages`,
      headers: {
        Authorization: `Bearer ${env.META_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: {
        messaging_product: 'whatsapp',
        to: toNumber,
        type: 'text',
        text: { body: text },
      },
      json: true,
      timeout: 20000,
    });
    return res?.messages?.[0]?.id || null;
  } catch (err) {
    let errStr;
    try { errStr = JSON.stringify(err, Object.getOwnPropertyNames(err)); } catch (e) { errStr = String(err); }
    errStr += JSON.stringify(err?.response?.data || err?.response?.body || '');
    if (errStr.includes('131047')) {
      return sendWhatsAppTemplate(toNumber, text);
    }
    throw err;
  }
}

// Real booking history for this contact (signed/onboarded only -- not just
// self-reported) so "returning client" means something verified, not just
// whatever the client happened to claim.
async function getPastBookings(contactId, excludeBookingId) {
  return sbRequest(
    'GET',
    `bookings?client_contact_id=eq.${contactId}&status=in.(signed,onboarded)&id=neq.${excludeBookingId}&select=event_name,event_date&order=event_date.desc&limit=5`
  );
}

// Intake just finished. Negotiation is a one-at-a-time, single-slot
// conversation (bookings.mode = 'pm-led', DB-enforced to at most one row) --
// if the PM is free, take this straight to the front and open it
// automatically, no reason to make him type "open X" for the only thing
// waiting. If he's already mid-negotiation with someone else, this joins
// the FIFO queue instead (ordered by negotiation_queued_at) and opens
// itself automatically the moment he types "close" -- see pm-toggle-code.js.
async function notifyPmOfCompletedIntake(booking) {
  const pmRows = await sbRequest('GET', 'contacts?role=eq.pm&select=*&limit=1');
  const pm = pmRows[0];
  if (!pm) return;

  let historyLine = null;
  if (booking.is_existing_client) {
    const past = await getPastBookings(booking.client_contact_id, booking.id);
    if (past.length > 0) {
      historyLine = `Past bookings: ${past.map((b) => `"${b.event_name}" (${b.event_date || 'date unknown'})`).join(', ')}`;
    }
  }

  const summaryLines = [
    `New booking ready: "${booking.event_name}"`,
    `Date: ${booking.event_date}`,
    `Type: ${booking.event_type}`,
    `${booking.is_existing_client ? 'Returning' : 'New'} client${booking.client_reference ? ` -- ${booking.client_reference}` : ''}`,
    ...(historyLine ? [historyLine] : []),
  ];

  const activeRows = await sbRequest('GET', 'bookings?mode=eq.pm-led&limit=1&select=id');
  if (activeRows.length === 0) {
    // Nobody's open right now -- take this straight to the front.
    await sbPatch(`bookings?id=eq.${booking.id}`, { mode: 'pm-led' });
    const history = await sbRequest(
      'GET',
      `conversations?booking_id=eq.${booking.id}&order=created_at.asc&select=direction,message_text`
    );
    const transcriptLines = history.length > 0
      ? [`Conversation so far for "${booking.event_name}":`, ...history.map((m) => `${m.direction === 'inbound' ? 'Client' : 'Bali'}: ${m.message_text}`)]
      : [];
    await sendWhatsApp(pm.phone_number, [
      ...summaryLines,
      '',
      ...transcriptLines,
      ...(transcriptLines.length > 0 ? [''] : []),
      `Opened "${booking.event_name}" -- I'll relay everything straight through until you type "close".`,
    ].join('\n'));
    return;
  }

  // Someone else is already open -- join the queue instead of asking the PM
  // to juggle a manual "open" command he can't act on yet anyway.
  const queued = await sbRequest('GET', 'bookings?status=eq.negotiating&mode=eq.bot-led&select=id');
  const aheadCount = Math.max(queued.length - 1, 0); // this booking is included in queued
  await sendWhatsApp(pm.phone_number, [
    ...summaryLines,
    '',
    aheadCount === 0
      ? "You're still with another client -- I'll bring this one up automatically as soon as you type \"close\"."
      : `Queued behind ${aheadCount} other${aheadCount === 1 ? '' : 's'} -- I'll bring it up automatically once it's next.`,
  ].join('\n'));
}

// Voice notes arrive as WhatsApp "audio" media -- download via Meta's media API
// (a media id resolves to a short-lived URL, not the bytes directly), then
// transcribe with Whisper so the rest of the pipeline just sees text like normal.
async function transcribeVoiceNote(mediaId) {
  const meta = await helpers.httpRequest({
    method: 'GET',
    url: `https://graph.facebook.com/v20.0/${mediaId}`,
    headers: { Authorization: `Bearer ${env.META_TOKEN}` },
    json: true,
    timeout: 15000,
  });
  if (!meta?.url) return null;

  const audioBytes = await helpers.httpRequest({
    method: 'GET',
    url: meta.url,
    headers: { Authorization: `Bearer ${env.META_TOKEN}` },
    encoding: 'arraybuffer',
    json: false,
    timeout: 30000,
  });

  const transcription = await helpers.httpRequest({
    method: 'POST',
    url: 'https://api.openai.com/v1/audio/transcriptions',
    headers: { Authorization: `Bearer ${env.OPENAI_KEY}` },
    formData: {
      model: 'whisper-1',
      file: {
        value: Buffer.isBuffer(audioBytes) ? audioBytes : Buffer.from(audioBytes),
        options: { filename: 'voice-note.ogg', contentType: meta.mime_type || 'audio/ogg' },
      },
    },
    json: true,
    timeout: 45000,
  });
  return transcription?.text || null;
}

// Relative dates ("next Friday", "this weekend") need an anchor, but even with
// one, gpt-4o-mini's own date arithmetic is unreliable (verified: it resolved
// "friday next week" to a Tuesday). Resolve the common patterns deterministically
// in code instead of trusting the model's arithmetic -- only fall back to the
// model's answer for things actual date parsing can't help with (e.g. "August 4th").
const today = new Date();
const todayStr = today.toISOString().slice(0, 10);
const todayWeekday = today.toLocaleDateString('en-US', { weekday: 'long' });

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function resolveRelativeDate(rawText) {
  const text = (rawText || '').toLowerCase();

  function addDays(base, n) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + n);
    return d;
  }
  function toISO(d) {
    return d.toISOString().slice(0, 10);
  }

  // Monday-anchored week boundaries -- "next Friday" means the Friday that
  // falls in next calendar week, which is NOT always "the nearest Friday plus
  // 7 days" (if today is already late in the week, the nearest Friday might
  // already BE next week's Friday).
  const todayDow = today.getUTCDay(); // 0=Sun..6=Sat
  const mondayOffset = (todayDow + 6) % 7; // days since this week's Monday
  const thisMonday = addDays(today, -mondayOffset);
  const nextMonday = addDays(thisMonday, 7);

  if (/\btoday\b/.test(text)) return toISO(today);
  if (/\btomorrow\b/.test(text)) return toISO(addDays(today, 1));

  const isNext = /\bnext\b/.test(text);

  const weekdayName = WEEKDAYS.find((w) => new RegExp(`\\b${w}\\b`).test(text));
  if (weekdayName) {
    const targetDow = WEEKDAYS.indexOf(weekdayName);
    const targetOffsetFromMonday = (targetDow + 6) % 7; // 0=Mon..6=Sun
    // Explicitly "next", or this week's occurrence has already passed (or is
    // today, which the day-name-alone case treats as "the upcoming one" not
    // "today") -- use next week's; otherwise this week's.
    if (isNext || targetOffsetFromMonday < mondayOffset) {
      return toISO(addDays(nextMonday, targetOffsetFromMonday));
    }
    return toISO(addDays(thisMonday, targetOffsetFromMonday));
  }

  if (/\bweekend\b/.test(text)) {
    const satOffsetFromMonday = 5; // Saturday
    if (isNext || satOffsetFromMonday < mondayOffset) {
      return toISO(addDays(nextMonday, satOffsetFromMonday));
    }
    return toISO(addDays(thisMonday, satOffsetFromMonday));
  }

  const inMatch = text.match(/\bin\s+(\d+)\s+(day|days|week|weeks)\b/);
  if (inMatch) {
    const n = parseInt(inMatch[1], 10);
    return toISO(addDays(today, n * (inMatch[2].startsWith('week') ? 7 : 1)));
  }

  return null; // not a relative phrase we handle -- let the model's own reading stand
}

const GREETING = "Hey! 😊 Interested in booking Bali? Just share: the date, event type, event name, and any IG/website you've got.";

const FIELD_LABELS = {
  event_date: 'the date',
  event_name: 'a short name for it',
  event_type: 'what type of event it is',
  is_existing_client: 'if they have booked with us before',
  client_reference: 'their IG, TikTok, or website',
};

// Asked of every client now, not just returning ones -- useful context for the
// PM regardless of whether this is their first booking or not.
function fieldOrder() {
  return ['event_date', 'event_name', 'event_type', 'is_existing_client', 'client_reference'];
}

// These 4 are asked together, up front, in the greeting -- matches how a
// person would naturally describe their event in one go, rather than
// interrogating them field by field. "Have you booked with us before?" is
// deliberately NOT in this group -- it doesn't fit naturally into "tell me
// about your event" and reads better as its own short follow-up once the
// event itself is nailed down.
const UPFRONT_FIELDS = ['event_date', 'event_type', 'event_name', 'client_reference'];

const input = $input.first().json.body;
const { from_number, text, contact_id: routerContactId, media_type, media_id } = input;

// 1. Look up the contact by phone; only create one (as 'customer') if none
// exists yet. Must NEVER touch an existing contact's role -- that's
// admin-managed (PM/lawyer/staff via Retool), and an upsert with role
// hardcoded to 'customer' would silently clobber it back on conflict
// (confirmed live: a misrouted PM message reset a real PM back to 'customer').
const existingContacts = await sbRequest('GET', `contacts?phone_number=eq.${encodeURIComponent(from_number)}&select=*`);
let contact = existingContacts[0];
if (!contact) {
  const created = await sbRequest('POST', 'contacts', { phone_number: from_number, role: 'customer' }, { Prefer: 'return=representation' });
  contact = created[0];
}

// 2. Find the latest non-cancelled booking for this contact.
const existingBookings = await sbRequest(
  'GET',
  `bookings?client_contact_id=eq.${contact.id}&status=neq.cancelled&order=created_at.desc&limit=1`
);
let booking = existingBookings[0] || null;

const logs = [];
let replyText = null;

// Voice notes are transcribed once, up front, so every branch below (intake,
// the legal-name step, etc.) just works with text like it always has.
let effectiveText = text;
if (media_type === 'audio' && media_id) {
  effectiveText = await transcribeVoiceNote(media_id);
}

if (!booking) {
  // First-ever message from this client: create the booking, send the scripted greeting.
  const created = await sbRequest('POST', 'bookings', {
    client_contact_id: contact.id,
    status: 'inquiry',
    mode: 'bot-led',
  }, { Prefer: 'return=representation' });
  booking = created[0];
  replyText = GREETING;
} else if (booking.status === 'sent_to_client' && input.media_type === 'document') {
  // Stage 4 signature detection: client sent back a PDF while we're waiting on the
  // signed contract. No e-signature tool for v1 -- ask the PM to confirm receipt/validity.
  logs.push({ booking_id: booking.id, sender_contact_id: contact.id, direction: 'inbound', message_text: '[PDF received]', media_url: input.media_id, stage: booking.status });
  await sbRequest('POST', 'conversations', logs);
  const pmRows = await sbRequest('GET', 'contacts?role=eq.pm&select=*&limit=1');
  const pm = pmRows[0];
  if (pm) {
    const questionText = `"${booking.event_name}": client sent back a signed PDF. Confirm it's valid? Reply yes or no.`;
    const pendingRows = await sbRequest('POST', 'pending_questions', {
      booking_id: booking.id,
      field_name: 'contract_confirmed',
      question_text: questionText,
    }, { Prefer: 'return=representation' });
    const msgId = await sendWhatsApp(pm.phone_number, questionText);
    if (msgId) await sbPatch(`pending_questions?id=eq.${pendingRows[0].id}`, { whatsapp_message_id: msgId });
  }
  return [{ json: { action: 'signature_pending_pm_confirmation', booking_id: booking.id } }];
} else if (booking.status === 'invoiced' && (input.media_type === 'image' || input.media_type === 'document')) {
  // Stage 3: client sent proof of payment -- forward to PM to confirm receipt.
  logs.push({ booking_id: booking.id, sender_contact_id: contact.id, direction: 'inbound', message_text: '[proof of payment received]', media_url: input.media_id, stage: booking.status });
  await sbRequest('POST', 'conversations', logs);
  const pmRows = await sbRequest('GET', 'contacts?role=eq.pm&select=*&limit=1');
  const pm = pmRows[0];
  if (pm) {
    const questionText = `"${booking.event_name}": client sent proof of payment. Confirm receipt? Reply yes or no.`;
    const pendingRows = await sbRequest('POST', 'pending_questions', {
      booking_id: booking.id,
      field_name: 'payment_confirmed',
      question_text: questionText,
    }, { Prefer: 'return=representation' });
    const msgId = await sendWhatsApp(pm.phone_number, questionText);
    if (msgId) await sbPatch(`pending_questions?id=eq.${pendingRows[0].id}`, { whatsapp_message_id: msgId });
  }
  await sendWhatsApp(from_number, "Got it, thanks. Confirming with our team now.");
  return [{ json: { action: 'payment_proof_pending_pm_confirmation', booking_id: booking.id } }];
} else if (booking.status === 'awaiting_contract') {
  // Stage 4: organizer legal name + registered address must be explicitly confirmed
  // with the client, never assumed from their WhatsApp profile name.
  const contractRows = await sbRequest('GET', `contracts?booking_id=eq.${booking.id}&order=created_at.desc&limit=1&select=*`);
  const contract = contractRows[0];
  logs.push({ booking_id: booking.id, sender_contact_id: contact.id, direction: 'inbound', message_text: effectiveText, stage: booking.status });

  if (contract && (!contract.organizer_legal_name || !contract.organizer_registered_address)) {
    const extraction = await askOpenAIJson(
      'Extract the organization\'s full legal name and its official registered address from this WhatsApp message. Reply ONLY with JSON: {"understood": true/false, "organizer_legal_name": "...", "organizer_registered_address": "..."}. Both fields must be present for understood to be true.',
      effectiveText || ''
    );
    if (!extraction?.understood) {
      replyText = "Sorry, I need both the full legal name and the official registered address together. Could you send them again?";
    } else {
      await sbPatch(`contracts?id=eq.${contract.id}`, {
        organizer_legal_name: extraction.organizer_legal_name,
        organizer_registered_address: extraction.organizer_registered_address,
      });
      await helpers.httpRequest({
        method: 'POST',
        url: `${env.N8N_BASE_URL}/webhook/stage3-4`,
        headers: { 'Content-Type': 'application/json' },
        body: { action: 'send_to_lawyer', booking_id: booking.id },
        json: true,
        timeout: 15000,
      });
      replyText = "Thank you. Passing this to our lawyer to draft the contract now.";
    }
  }
  // If there's no contract row yet, or it's already fully collected, nothing to ask --
  // just log passively (mirrors the general Stage 2+ passive rule below).
  if (replyText) {
    await sendWhatsApp(from_number, replyText);
    logs.push({ booking_id: booking.id, sender_contact_id: null, direction: 'outbound', message_text: replyText, stage: booking.status });
  }
  await sbRequest('POST', 'conversations', logs);
  return [{ json: { action: 'awaiting_contract_handled', booking_id: booking.id, replied: !!replyText } }];
} else if (booking.status === 'signed' || booking.status === 'onboarded') {
  // Event is booked -- planning is an open-ended, ongoing relationship with
  // the PM (decor tweaks, timing changes, etc.), not a single negotiation
  // session, so there's no "open"/"close" toggle here: always relay straight
  // through. Prefixed with the event name since the PM may have several of
  // these going at once (see pm-toggle-code.js's planning-relay routing,
  // which uses this exact prefix to route his replies back).
  logs.push({ booking_id: booking.id, sender_contact_id: contact.id, direction: 'inbound', message_text: effectiveText, stage: 'planning_relay' });
  const pmRows = await sbRequest('GET', 'contacts?role=eq.pm&select=*&limit=1');
  const pm = pmRows[0];
  if (pm) {
    const forwardText = `${booking.event_name}: ${effectiveText}`;
    const msgId = await sendWhatsApp(pm.phone_number, forwardText);
    logs.push({
      booking_id: booking.id,
      sender_contact_id: null,
      direction: 'outbound',
      message_text: forwardText,
      stage: 'planning_relay_to_pm',
      whatsapp_message_id: msgId || null,
    });
  }
  await sbRequest('POST', 'conversations', logs);
  return [{ json: { action: 'planning_relayed_to_pm', booking_id: booking.id } }];
} else if (booking.status !== 'inquiry' && booking.mode === 'pm-led') {
  // The PM has explicitly "opened" this booking and is live-driving the
  // conversation (Section 3) -- pm-toggle-code.js relays the PM's replies to
  // the client, but the client's own messages need the same relay in the
  // other direction, or the PM never actually sees what the client says.
  logs.push({ booking_id: booking.id, sender_contact_id: contact.id, direction: 'inbound', message_text: effectiveText, stage: booking.status });
  const pmRows = await sbRequest('GET', 'contacts?role=eq.pm&select=*&limit=1');
  const pm = pmRows[0];
  if (pm) {
    await sendWhatsApp(pm.phone_number, `"${booking.event_name}": ${effectiveText}`);
    logs.push({ booking_id: booking.id, sender_contact_id: null, direction: 'outbound', message_text: `[relayed to PM] ${effectiveText}`, stage: booking.status });
  }
  await sbRequest('POST', 'conversations', logs);
  return [{ json: { action: 'relayed_to_pm', booking_id: booking.id } }];
} else if (booking.status !== 'inquiry') {
  // Intake is done but the PM hasn't opened this booking yet (still bot-led).
  // Going completely silent here reads as broken -- actually answer genuine
  // questions via the knowledge base, and give a warm, freshly-worded
  // reassurance for anything else, instead of ignoring the client.
  logs.push({ booking_id: booking.id, sender_contact_id: contact.id, direction: 'inbound', message_text: effectiveText, stage: booking.status });

  const history = await sbRequest(
    'GET',
    `conversations?booking_id=eq.${booking.id}&order=created_at.desc&select=direction,message_text&limit=10`
  );
  const recentTranscript = history.reverse().map((m) => `${m.direction === 'inbound' ? 'Client' : 'Bali'}: ${m.message_text}`).join('\n');

  const check = await askOpenAIJson(
    `A client is waiting to hear back about their booking "${booking.event_name}", already handed off to the team. They just said: "${effectiveText}".

Decide: does this message contain ANYTHING the team needs to know or act on -- a genuine question about the venue/event (pricing, parking, capacity, what's included, timing, etc.), new or corrected information about their booking, something they explicitly say they forgot to send or still need to send, or a request/instruction -- or is the ENTIRE message just a greeting/pleasantry/impatience with zero informational content?

Judge the full message, not just its opening words. A casual opener like "hey" or "so" does NOT make the rest of the message a check-in if real content follows it -- e.g. "hey I didn't send my ig" needs attention because of "I didn't send my ig", even though it starts with "hey". When genuinely unsure, prefer needs_attention:true -- missing something real is worse than an unnecessary check-in reassurance.

Examples that need NO attention (nothing but a greeting or impatience, no content at all): "hey", "any update?", "did you see my message?", "??", "still there?", "just checking in", "hello?", "so?", "how far?". Examples that DO need attention: "do you have parking?", "how much does it cost?", "actually make it 150 guests", "I want to add something", "can you also arrange decor?", "hey I didn't send my ig" (forgot to send something, wants to now), "also check my instagram" (pointing them to something to look at/add), "I want to change something" (signals a change is coming).

Reply ONLY with JSON: {"needs_attention": true/false}.`,
    effectiveText || ''
  );

  if (check?.needs_attention) {
    await helpers.httpRequest({
      method: 'POST',
      url: `${env.N8N_BASE_URL}/webhook/kb-check`,
      headers: { 'Content-Type': 'application/json' },
      body: { action: 'check', from_number, text: effectiveText, contact_id: contact.id, booking_id: booking.id },
      json: true,
      timeout: 15000,
    });
  } else {
    const waitingReplyResult = await askOpenAIJson(
      `You're Bali's WhatsApp assistant. A client is waiting to hear back from the events manager about their booking "${booking.event_name}", which is already with the team. They just said: "${effectiveText}" -- just a check-in, not a real question.

Recent conversation:
${recentTranscript}

Write one brief, warm, professional reassurance letting them know you're still on it -- vary the wording from anything you've said recently in this conversation, never "Awesome" or over-enthusiastic. Reply ONLY with JSON: {"reply": "..."}`,
      effectiveText || ''
    );
    const waitingReply = waitingReplyResult?.reply || "Still with our team on this, I'll follow up as soon as I can.";
    await sendWhatsApp(from_number, waitingReply);
    logs.push({ booking_id: booking.id, sender_contact_id: null, direction: 'outbound', message_text: waitingReply, stage: booking.status });
  }

  await sbRequest('POST', 'conversations', logs);
  return [{ json: { action: 'post_intake_handled', booking_id: booking.id } }];
} else {
  // Mid-intake -- this is the part that actually needs to feel like a
  // conversation. Two passes: (1) read the whole conversation so far and
  // extract whatever fields the client's latest message provides -- possibly
  // several at once, possibly out of order, exactly like a person would type
  // it, not just "does this one message answer the one field I'm stuck on."
  // (2) write ONE fresh reply grounded in what actually just happened (a real
  // DB-checked date result, what's still missing) -- never a fixed canned
  // string, so two visits to the same field never sound identical.

  // If we can already PROVE this is a returning client from real booking
  // history, don't bother asking -- a self-report is only needed when we
  // genuinely don't know.
  if (booking.is_existing_client === null || booking.is_existing_client === undefined) {
    const pastBookings = await getPastBookings(contact.id, booking.id);
    if (pastBookings.length > 0) {
      await sbPatch(`bookings?id=eq.${booking.id}`, { is_existing_client: true });
      booking.is_existing_client = true;
    }
  }

  const history = await sbRequest(
    'GET',
    `conversations?booking_id=eq.${booking.id}&order=created_at.asc&select=direction,message_text&limit=40`
  );
  const transcript = history
    .map((m) => `${m.direction === 'inbound' ? 'Client' : 'Bali'}: ${m.message_text}`)
    .join('\n');

  const known = {
    event_date: booking.event_date,
    event_name: booking.event_name,
    event_type: booking.event_type,
    is_existing_client: booking.is_existing_client,
    client_reference: booking.client_reference,
  };
  const missingBefore = fieldOrder().filter(
    (f) => known[f] === null || known[f] === undefined
  );

  const extraction = await askOpenAIJson(
    `You're reading a WhatsApp conversation between a client and Bali, an event venue, during the booking intake stage. Today is ${todayWeekday}, ${todayStr}.

Already confirmed about this booking: ${JSON.stringify(known)}
Still needed (in priority order, but the client may answer out of order or give several at once): ${JSON.stringify(missingBefore)}

Conversation so far:
${transcript}

Client's latest message: "${effectiveText || ''}"

Extract EVERY still-needed field this message provides, not just the one you were "expecting" next -- e.g. "birthday party for my sister" gives you both event_type ("birthday party") AND enough for event_name ("Sister's Birthday Party"), extract both in the same pass rather than leaving event_type blank because event_name came first in priority order. Resolve relative dates ("next Friday", "this weekend", a bare day name) against today's date. If the message is instead (or also) a genuine question or comment not covered by the fields above (pricing, parking, capacity, "what dates are open", small talk, etc.), note it as off_topic -- something the venue needs to actually answer, not guess at.

Reply ONLY with JSON: {"extracted": {"event_date"?: "YYYY-MM-DD", "event_name"?: "...", "event_type"?: "...", "is_existing_client"?: true/false, "client_reference"?: "..."}, "off_topic": "..." or null}`,
    effectiveText || ''
  );

  const extracted = extraction?.extracted || {};
  const patch = {};
  for (const f of missingBefore) {
    if (extracted[f] !== undefined && extracted[f] !== null && extracted[f] !== '') {
      patch[f] = extracted[f];
    }
  }

  // The model's own date arithmetic isn't trustworthy (verified: it got a
  // relative date wrong even with today's date given) -- deterministic parsing
  // wins whenever the message matches a pattern it understands.
  if (missingBefore.includes('event_date')) {
    const resolved = resolveRelativeDate(effectiveText);
    if (resolved) patch.event_date = resolved;
  }

  // The date is the one field with a real business rule -- never trust the
  // model's word for it, always check the actual table (one event/day).
  let dateRejected = false;
  if (patch.event_date) {
    const collisions = await sbRequest(
      'GET',
      `bookings?event_date=eq.${patch.event_date}&status=neq.cancelled&id=neq.${booking.id}&select=id`
    );
    if (collisions.length > 0) {
      dateRejected = true;
      delete patch.event_date;
    }
  }

  if (Object.keys(patch).length > 0) {
    await sbPatch(`bookings?id=eq.${booking.id}`, patch);
    Object.assign(booking, patch);
  }

  const missingAfter = fieldOrder().filter(
    (f) => booking[f] === null || booking[f] === undefined
  );
  const justCompleted = missingAfter.length === 0 && booking.status === 'inquiry';
  if (justCompleted) {
    await sbPatch(`bookings?id=eq.${booking.id}`, { status: 'negotiating', negotiation_queued_at: new Date().toISOString() });
    booking.status = 'negotiating';
  }

  // A genuine off-topic question gets a real answer from the knowledge base
  // (or escalated to the PM) -- the reply below just needs to know it's pending,
  // it doesn't try to answer it itself.
  let kbPending = false;
  if (extraction?.off_topic) {
    kbPending = true;
    await helpers.httpRequest({
      method: 'POST',
      url: `${env.N8N_BASE_URL}/webhook/kb-check`,
      headers: { 'Content-Type': 'application/json' },
      body: { action: 'check', from_number, text: extraction.off_topic, contact_id: contact.id, booking_id: booking.id },
      json: true,
      timeout: 15000,
    });
  }

  // Upfront fields (date, event type, name, social/website) are asked
  // together as a batch, like a person naturally describing their event in
  // one go -- only once all of those are in do we ask the one-off "have you
  // booked with us before?" by itself, since it doesn't fit naturally
  // bundled with "tell me about your event."
  const missingUpfront = missingAfter.filter((f) => UPFRONT_FIELDS.includes(f));
  const askingReturningClientAlone = missingUpfront.length === 0 && missingAfter.includes('is_existing_client');

  const replyResult = await askOpenAIJson(
    `You're Bali, an event venue's WhatsApp assistant, texting a client during booking intake. Warm, professional, and helpful -- brief and human, like a staff member texting. Never sound like an AI or a hype machine: no "Awesome!", no exclamation-point enthusiasm, no repeating a phrase you've already used earlier in this conversation.

KEEP IT SHORT -- this is WhatsApp, not email. One short sentence, occasionally two. Never a paragraph, never more than about 25 words, no line breaks, no bullet points or numbered lists -- the client shouldn't have to scroll to read it. Even when asking about several missing details at once, fit them into one tight, casual sentence (e.g. "What's the date, event type, and do you have an IG or website for it?"), not a formal itemized list.

Conversation so far:
${transcript}
Client: ${effectiveText || ''}

What actually happened this turn: ${JSON.stringify({
      saved_this_turn: patch,
      date_rejected_already_booked: dateRejected,
      knowledge_base_question_pending: kbPending,
      still_missing_event_details: missingUpfront.map((f) => FIELD_LABELS[f]),
      still_need_returning_client_question_alone: askingReturningClientAlone,
      intake_just_completed: justCompleted,
    })}

Write the next message to send the client, in plain text (not JSON, this field's value IS the message). Rules: if still_missing_event_details has more than one item, ask for all of them together in ONE short sentence -- not a list. If it has exactly one item, just ask that one thing. If a date was just rejected as already booked, say so plainly and ask for an alternative -- don't apologize excessively -- and still fold in any other still_missing_event_details into the same short message. When asking about event type, ask it open-ended -- never offer a multiple-choice list like "a birthday, a wedding, or something else", just ask what kind of event it is. If still_need_returning_client_question_alone is true, ask ONLY "have you booked with us before?" (or similar) by itself, nothing else bundled in. If intake_just_completed is true, say only something brief like "Give me a moment, I'll follow up with you shortly" -- do NOT mention an events manager or any other person, just that you'll follow up, and don't ask anything further. If a knowledge base question is pending, briefly acknowledge you're checking on it, then still ask about whatever's in still_missing_event_details or still_need_returning_client_question_alone (or note you'll follow up if both are empty/false) -- still one short sentence total. If nothing new was understood at all, ask again for whatever's still missing, phrased differently than however you might have asked it earlier in this conversation, still short.

Reply ONLY with JSON: {"reply": "..."}`,
    effectiveText || ''
  );

  replyText = replyResult?.reply || null;
  if (!replyText) {
    // Model call failed outright -- fall back to something serviceable rather
    // than sending nothing.
    if (missingUpfront.length > 0) {
      replyText = `Could you let me know ${missingUpfront.map((f) => FIELD_LABELS[f]).join(', ')}?`;
    } else if (askingReturningClientAlone) {
      replyText = `Could you let me know ${FIELD_LABELS.is_existing_client}?`;
    } else {
      replyText = "Give me a moment, I'll follow up with you shortly.";
    }
  }

  if (justCompleted) {
    await notifyPmOfCompletedIntake(booking);
  }
}

logs.push({ booking_id: booking.id, sender_contact_id: contact.id, direction: 'inbound', message_text: effectiveText, stage: 'stage1_intake' });
if (replyText) {
  await sendWhatsApp(from_number, replyText);
  logs.push({ booking_id: booking.id, sender_contact_id: null, direction: 'outbound', message_text: replyText, stage: 'stage1_intake' });
}
await sbRequest('POST', 'conversations', logs);

return [{ json: { booking_id: booking.id, reply_sent: replyText } }];

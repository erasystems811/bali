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

async function sendWhatsApp(toNumber, text) {
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
}

// Intake just finished -- give the PM a summary (not a play-by-play) and the
// exact command to take over the live conversation directly with the client.
async function notifyPmOfCompletedIntake(booking) {
  const pmRows = await sbRequest('GET', 'contacts?role=eq.pm&select=*&limit=1');
  const pm = pmRows[0];
  if (!pm) return;

  const lines = [
    `New booking ready: "${booking.event_name}"`,
    `Date: ${booking.event_date}`,
    `Type: ${booking.event_type}`,
    `${booking.is_existing_client ? 'Returning' : 'New'} client${booking.client_reference ? ` -- ${booking.client_reference}` : ''}`,
    '',
    `Reply "open ${booking.event_name}" when you're ready to talk pricing directly with the client -- I'll relay everything through until you type "close".`,
  ];
  await sendWhatsApp(pm.phone_number, lines.join('\n'));
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

const GREETING = "Hey! 😊 Would you be interested in booking Bali for your event? Just let me know the date you're looking at and I'll check what's available.";

const FIELD_LABELS = {
  event_date: 'the event date',
  event_name: 'a short name for the event',
  event_type: 'what type of event it is and how we can help make it work',
  is_existing_client: 'whether they have booked with us before',
  client_reference: 'their Instagram, TikTok, website, or other page for the event/business',
};

// Asked of every client now, not just returning ones -- useful context for the
// PM regardless of whether this is their first booking or not.
function fieldOrder() {
  return ['event_date', 'event_name', 'event_type', 'is_existing_client', 'client_reference'];
}

const input = $input.first().json.body;
const { from_number, text, contact_id: routerContactId, media_type, media_id } = input;

// 1. Upsert contact (creates if unrecognized, per Section 9a; no-op update if it already exists).
const contactRows = await sbRequest(
  'POST',
  'contacts?on_conflict=phone_number',
  { phone_number: from_number, role: 'customer' },
  { Prefer: 'resolution=merge-duplicates,return=representation' }
);
const contact = contactRows[0];

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
} else if (booking.status !== 'inquiry') {
  // Stage 1 already complete for this client (negotiating or later) -- bot stays
  // passive per Stage 2 / the PM-led toggle. Just log the inbound message.
  logs.push({ booking_id: booking.id, sender_contact_id: contact.id, direction: 'inbound', message_text: effectiveText, stage: booking.status });
  await sbRequest('POST', 'conversations', logs);
  return [{ json: { skipped: true, reason: 'booking not in inquiry stage', booking_id: booking.id } }];
} else {
  // Mid-intake -- this is the part that actually needs to feel like a
  // conversation. Two passes: (1) read the whole conversation so far and
  // extract whatever fields the client's latest message provides -- possibly
  // several at once, possibly out of order, exactly like a person would type
  // it, not just "does this one message answer the one field I'm stuck on."
  // (2) write ONE fresh reply grounded in what actually just happened (a real
  // DB-checked date result, what's still missing) -- never a fixed canned
  // string, so two visits to the same field never sound identical.
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
    await sbPatch(`bookings?id=eq.${booking.id}`, { status: 'negotiating' });
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

  const nextField = missingAfter[0] || null;

  const replyResult = await askOpenAIJson(
    `You're Bali, an event venue's WhatsApp assistant, texting a client during booking intake. Warm, professional, and helpful -- brief and human, like a staff member texting. Never sound like an AI or a hype machine: no "Awesome!", no exclamation-point enthusiasm, no repeating a phrase you've already used earlier in this conversation. Ask about exactly ONE thing in your message, never a checklist of several questions at once -- even if more than one thing is still missing.

Conversation so far:
${transcript}
Client: ${effectiveText || ''}

What actually happened this turn: ${JSON.stringify({
      saved_this_turn: patch,
      date_rejected_already_booked: dateRejected,
      knowledge_base_question_pending: kbPending,
      next_single_thing_to_ask_about: nextField ? FIELD_LABELS[nextField] : null,
      intake_just_completed: justCompleted,
    })}

Write the next message to send the client, in plain text (not JSON, this field's value IS the message). Rules: if a date was just rejected as already booked, say so plainly and ask for an alternative -- don't apologize excessively. If a date was just confirmed available, acknowledge it in one brief phrase (not "Awesome" or similar), THEN ask about next_single_thing_to_ask_about -- that acknowledgment plus that one question, nothing else. When asking about event type, ask it open-ended -- never offer a multiple-choice list like "a birthday, a wedding, or something else", just ask what kind of event it is and how we can help. If intake_just_completed is true, say only something brief like "Give me a moment, I'll follow up with you shortly" -- do NOT mention an events manager or any other person, just that you'll follow up, and don't ask anything further. If a knowledge base question is pending, briefly acknowledge you're checking on it, then still ask about next_single_thing_to_ask_about if it's not null (or note you'll follow up if it is null). If nothing new was understood at all, ask about next_single_thing_to_ask_about again, phrased differently than however you might have asked it earlier in this conversation.

Reply ONLY with JSON: {"reply": "..."}`,
    effectiveText || ''
  );

  replyText = replyResult?.reply || null;
  if (!replyText) {
    // Model call failed outright -- fall back to something serviceable rather
    // than sending nothing.
    replyText = missingAfter.length > 0
      ? `Could you let me know ${FIELD_LABELS[missingAfter[0]]}?`
      : "Give me a moment, I'll follow up with you shortly.";
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

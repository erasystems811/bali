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

// Strips markdown formatting artifacts out of an LLM's free-text output
// before it ever reaches a WhatsApp send. See stage5-fanout-code.js's
// version for the full explanation -- owner's explicit, repeated rule is no
// "*" or "-" anywhere in this bot's messages, but nothing enforced that on
// LLM-generated free text (only ever applied to hand-written fixed
// strings). Hard backstop, not just a prompt ask.
function stripMarkdown(text) {
  return String(text || '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/`+/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// Sandbox mode: on when there's no real Meta token configured (the sandbox
// n8n instance is deliberately deployed without one, so it's structurally
// incapable of reaching real WhatsApp, not just told not to). Every outbound
// send is captured in `sandbox_outbound` instead, for the test webpage to
// display, and a fake message id stands in for the real one.
const SANDBOX = !env.META_TOKEN;
async function sandboxLog(toNumber, text, kind) {
  const messageId = `sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await sbRequest('POST', 'sandbox_outbound', { to_number: toNumber, kind: kind || 'text', message_text: text, message_id: messageId });
  } catch (e) {}
  return messageId;
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
      model: 'gpt-4o',
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
// window. Fall back to the approved "bali_update" utility template instead
// of the send just failing.
//
// Owner's explicit correction (2026-08-03): this used to stuff the ENTIRE
// message text into the template's one body variable -- so a normal PM
// relay like "Mad Party: hey, any update?" came out wrapped as "Bali update
// for you: Mad Party: hey, any update?. Please take a look when you get a
// chance.", mangling the owner's own intentional message format/wording.
// Now the template only ever carries a SHORT label (an event name, or a
// generic fallback) -- the real content always follows as a genuine,
// unmodified follow-up send in sendWhatsApp below, exactly as it would have
// read without any window issue at all.
async function sendWhatsAppTemplate(toNumber, shortLabel) {
  if (SANDBOX) return sandboxLog(toNumber, shortLabel, 'template');
  const res = await helpers.httpRequest({
    method: 'POST',
    url: `https://graph.facebook.com/v20.0/${env.META_PHONE_ID}/messages`,
    headers: { Authorization: `Bearer ${env.META_TOKEN}`, 'Content-Type': 'application/json' },
    body: {
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'template',
      template: {
        name: 'bali_update',
        language: { code: 'en_US' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: sanitizeTemplateParam(shortLabel) }] }],
      },
    },
    json: true,
    timeout: 20000,
  });
  return res?.messages?.[0]?.id || null;
}

// Confirmed live: a direct text send to a contact whose last inbound message
// was well over 24h old returned 200 with a real message id from Meta, but
// never actually delivered -- outside the messaging window, Meta accepts the
// call and silently drops it instead of rejecting it synchronously with
// 131047 (delivery failure only shows up later via a status webhook we don't
// listen for). Catching 131047 reactively therefore doesn't reliably work.
// Check the window proactively instead, from the contact's own last inbound
// message, and go straight to the template when it's closed.
async function isWithinMessagingWindow(toNumber) {
  // Confirmed live 2026-08-03: a brand-new customer's very first-ever message
  // triggered this on their own greeting reply, sending them a raw
  // "This is an automated notification..." template instead of the real
  // GREETING text. Root cause: this function looks up the contact's most
  // recent INBOUND conversations row, but that row (their current message,
  // the one we're replying to right now) hasn't been inserted into the DB
  // yet -- logs.push() batches it into one insert that only happens AFTER
  // this reply is sent, at the very bottom of this file. With zero rows
  // found, this always returned false for anyone's first-ever message,
  // regardless of how obviously "in window" they actually are (they just
  // texted us, this same execution). Short-circuit true whenever toNumber
  // is the live sender of the message currently being processed -- no DB
  // round trip needed, this is always correct.
  if (toNumber === from_number) return true;
  const contacts = await sbRequest('GET', `contacts?phone_number=eq.${encodeURIComponent(toNumber)}&select=id`);
  const contactId = contacts[0]?.id;
  if (!contactId) return false;
  const rows = await sbRequest(
    'GET',
    `conversations?sender_contact_id=eq.${contactId}&direction=eq.inbound&select=created_at&order=created_at.desc&limit=1`
  );
  if (!rows[0]) return false;
  const hoursSinceLastInbound = (Date.now() - new Date(rows[0].created_at).getTime()) / (1000 * 60 * 60);
  return hoursSinceLastInbound < 23; // stay a safety margin under the real 24h cutoff
}

async function sendRawText(toNumber, text) {
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

// Owner's explicit correction (2026-08-03): don't even attempt the real
// content right behind the template anymore -- Meta doesn't grant a fresh
// window just because WE sent a template, only the recipient actually
// replying does, so that immediate follow-up attempt was itself unreliable.
// Instead, park the real content here. It's released by a single universal
// mechanism in 01-inbound-router.json (not per-file/per-role) -- ANY
// inbound message whose text contains "okay" flushes everything queued for
// that sender, before role-based routing even happens, so this works
// identically for every role (including ones with no other reply-handling
// logic at all: HR, security, procurement, accounts, event_assistant,
// supervisor, facility_manager, general staff). See queued_messages in
// schema.sql and 01-inbound-router.json's "Parse Inbound Message" node.
async function queueMessage(toNumber, text) {
  await sbRequest('POST', 'queued_messages', { phone_number: toNumber, message_text: text });
}

// shortLabel: what to put in the template's body variable if this lands
// outside the messaging window -- an event name, or any short description
// of what this message is about. Falls back to a generic phrase if omitted.
// See sendWhatsAppTemplate above for why this is a separate, short value
// rather than the message text itself.
async function sendWhatsApp(toNumber, text, shortLabel) {
  if (SANDBOX) return sandboxLog(toNumber, text, 'text');
  if (!(await isWithinMessagingWindow(toNumber))) {
    await sendWhatsAppTemplate(toNumber, shortLabel || 'an update');
    await queueMessage(toNumber, text);
    return null;
  }
  try {
    return await sendRawText(toNumber, text);
  } catch (err) {
    let errStr;
    try { errStr = JSON.stringify(err, Object.getOwnPropertyNames(err)); } catch (e) { errStr = String(err); }
    errStr += JSON.stringify(err?.response?.data || err?.response?.body || '');
    if (errStr.includes('131047')) {
      await sendWhatsAppTemplate(toNumber, shortLabel || 'an update');
      await queueMessage(toNumber, text);
      return null;
    }
    throw err;
  }
}

// Forwards a customer-sent image/document to someone else (e.g. proof of
// payment to the PM) by reusing the same media id Meta already has -- no
// re-upload needed, matching sendWhatsAppDocument's pattern in
// stage3-4-action-code.js (used the same way for contract drafts). No window/
// template fallback here, same as that one: media sends don't have a
// template equivalent to fall back to.
async function sendWhatsAppMedia(toNumber, mediaType, mediaId, caption) {
  if (SANDBOX) return sandboxLog(toNumber, `[${mediaType}]${caption ? ' ' + caption : ''}`, mediaType);
  const res = await helpers.httpRequest({
    method: 'POST',
    url: `https://graph.facebook.com/v20.0/${env.META_PHONE_ID}/messages`,
    headers: { Authorization: `Bearer ${env.META_TOKEN}`, 'Content-Type': 'application/json' },
    body: {
      messaging_product: 'whatsapp',
      to: toNumber,
      type: mediaType,
      [mediaType]: { id: mediaId, caption },
    },
    json: true,
    timeout: 20000,
  });
  return res?.messages?.[0]?.id || null;
}

// Whether the awaiting_contract form still has something to ask this
// client for. booking.status stays 'awaiting_contract' the whole time the
// lawyer is drafting (it only moves on once they send a draft back), so
// without this check every message after the form actually finished would
// keep landing in that branch and just get logged with no reply and no
// relay at all -- confirmed live. Once nothing's left to collect, this
// returns false and the normal connected-to-PM relay below takes over.
async function contractInfoStillMissing(booking) {
  if (booking.status !== 'awaiting_contract') return false;
  const contractRows = await sbRequest('GET', `contracts?booking_id=eq.${booking.id}&order=created_at.desc&limit=1&select=*`);
  const contract = contractRows[0];
  return !!(contract && (!contract.organizer_legal_name || !contract.organizer_registered_address || !contract.details_confirmed_at || !booking.event_type));
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

// 7 days after the event date, a booking's chat stops staying permanently
// connected to the PM and falls back to the normal automated flow -- see
// the comment on bookings.connected_to_pm_at in schema.sql. No event_date
// yet means it can't have happened, so never past cutoff. Exception: if the
// PM manually reached back out after that cutoff already passed (see the
// "X: message" convenience path in pm-toggle-code.js, which only refreshes
// connected_to_pm_at when the booking wasn't already connected or was past
// cutoff), that explicit action wins over the passive auto-expiry until the
// PM closes it again.
function isPastConnectionCutoff(booking) {
  if (!booking.event_date) return false;
  const cutoff = new Date(`${booking.event_date}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() + 7);
  if (Date.now() < cutoff.getTime()) return false;
  if (booking.connected_to_pm_at && new Date(booking.connected_to_pm_at).getTime() >= cutoff.getTime()) return false;
  return true;
}

// Same KB-lookup logic as kb-check-code.js's own inline check -- duplicated
// rather than called cross-workflow (matching this codebase's existing
// pattern of small per-file helper duplication) so the "connected" branch
// below can get a synchronous found/answer decision without a network
// round-trip through another workflow.
async function checkKnowledgeBase(text) {
  const kb = await sbRequest('GET', 'knowledge_base?select=question,answer&order=last_updated.desc');
  const kbText = kb.map((row, i) => `${i + 1}. Q: ${row.question}\n   A: ${row.answer}`).join('\n') || '(knowledge base is empty)';
  const result = await askOpenAIJson(
    `You are answering a WhatsApp question for an event venue called Bali, in a warm, brief, conversational tone (never sound like an AI or a company bot). Use ONLY the knowledge base below to answer -- do not make anything up. If the knowledge base doesn't confidently cover the client's question, say so.\n\nKnowledge base:\n${kbText}\n\nReply ONLY with JSON: {"found": true/false, "answer": "..."} -- "answer" is the warm reply to send if found, or omitted/empty if not found.`,
    text || ''
  );
  return result || { found: false };
}

// Intake just finished. No single-slot/FIFO lock any more -- every booking
// connects to the PM immediately, all at once, regardless of how many
// others are already connected. He never needs to "open"/"close" one before
// working another; each customer's messages carry their own event-name
// prefix and each forwarded message is individually swipe-repliable, so
// distinguishing between simultaneous conversations doesn't need a
// single-active-booking concept at all. See pm-toggle-code.js.
async function notifyPmOfCompletedIntake(booking) {
  const pmRows = await sbRequest('GET', 'contacts?role=eq.pm&select=*&limit=1');
  const pm = pmRows[0];
  if (!pm) return;

  let historyLine = null;
  if (booking.is_existing_client) {
    const past = await getPastBookings(booking.client_contact_id, booking.id);
    if (past.length > 0) {
      historyLine = `Past bookings: ${past.map((b) => `${b.event_name} (${b.event_date || 'date unknown'})`).join(', ')}`;
    }
  }

  // Bulleted and addressed by name so it's scannable at a glance, not a
  // paragraph the PM has to read through -- owner's call. Kept deliberately
  // light on punctuation within each line (no quotes around the event name
  // repeated everywhere, no dashes) -- owner's ask, it read as overwhelming.
  const pmFirstName = pm.name ? pm.name.split(' ')[0] : null;
  const summaryLines = [
    pmFirstName ? `Hey ${pmFirstName}, you have a booking from ${booking.event_name}` : `You have a booking from ${booking.event_name}`,
    `- Date ${booking.event_date}`,
    `- Type ${booking.event_type}`,
    // "Experienced"/"First-time" describes general event-hosting experience
    // (anywhere, not specifically with us) -- the separate "Past bookings"
    // line below is what actually signals a real Bali repeat customer.
    `- ${booking.is_existing_client ? 'Experienced' : 'First-time'} client${booking.client_reference ? `, ${booking.client_reference}` : ''}`,
    ...(historyLine ? [`- ${historyLine}`] : []),
  ];

  // connected_to_pm_at is set once and never cleared -- see the comment on
  // that column in schema.sql.
  await sbPatch(`bookings?id=eq.${booking.id}`, { connected_to_pm_at: new Date().toISOString() });
  const history = await sbRequest(
    'GET',
    `conversations?booking_id=eq.${booking.id}&order=created_at.asc&select=direction,message_text`
  );
  // This transcript dump only ever happens here, once, the first time a
  // booking reaches the PM -- every message after this point is relayed
  // live as it happens (the connected-relay branch below), so there's
  // never anything to "catch up on" again later.
  const transcriptLines = history.length > 0
    ? [`Conversation so far for ${booking.event_name}`, ...history.map((m) => `${m.direction === 'inbound' ? 'Client' : 'Bali'}: ${m.message_text}`)]
    : [];
  const notifyText = [
    ...summaryLines,
    '',
    ...transcriptLines,
    ...(transcriptLines.length > 0 ? [''] : []),
    `Connected ${booking.event_name}.`,
    '',
    'Note:',
    `- Swipe-reply to this message (or to anything from them) to answer them directly, no need to type the event name. Only start with "${booking.event_name}: " if you're messaging them first since there's nothing to swipe-reply to, otherwise it stays between just us and won't reach them.`,
    `- Once you've agreed a price, say something like generate invoice for ${booking.event_name} and I'll send it out.`,
  ].join('\n');
  const msgId = await sendWhatsApp(pm.phone_number, notifyText, booking.event_name);
  // Logged with the same stage/whatsapp_message_id pattern as every other
  // customer-message forward -- swipe-replying to THIS notification relays
  // straight to the client, same rule as swipe-replying to anything else
  // they sent. Was never logged to conversations at all before -- invisible
  // in the dashboard even though it genuinely sent. Confirmed live 2026-08-01.
  await sbRequest('POST', 'conversations', [{ booking_id: booking.id, sender_contact_id: null, direction: 'outbound', message_text: notifyText, stage: 'connected_relay_to_pm', whatsapp_message_id: msgId || null }]);
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
// one, an LLM's own date arithmetic isn't reliable enough to trust outright
// (verified live with gpt-4o-mini: it resolved "friday next week" to a
// Tuesday). Resolve the common patterns deterministically in code instead of
// trusting the model's arithmetic -- only fall back to the model's answer for
// things actual date parsing can't help with (e.g. "August 4th").
const today = new Date();
const todayStr = today.toISOString().slice(0, 10);
const todayWeekday = today.toLocaleDateString('en-US', { weekday: 'long' });

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function formatDateForCustomer(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// Deterministically finds a month name/abbreviation in free text -- same
// "don't trust the model, match a small closed vocabulary in code" approach
// already used for weekday names in resolveRelativeDate. Matches "august",
// "aug", "Aug." etc; requires the abbreviation to be a real word boundary
// match (not a substring of something else).
function findMonthNumber(rawText) {
  const text = (rawText || '').toLowerCase();
  for (let i = 0; i < MONTHS.length; i++) {
    const name = MONTHS[i];
    const abbr = name.slice(0, 3);
    if (new RegExp(`\\b${name}\\b`).test(text) || new RegExp(`\\b${abbr}\\b`).test(text)) {
      return i + 1; // 1-indexed, matches ISO month numbering
    }
  }
  return null;
}

// Deterministically pulls a day-of-month number out of the "day_of_month_given"
// text the extraction prompt produces (e.g. "23rd", "the 5th", "3") -- always
// a small integer with an optional ordinal suffix, safe to regex rather than
// re-asking the model.
function findDayNumber(rawText) {
  const match = (rawText || '').match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
  return match ? parseInt(match[1], 10) : null;
}

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

const GREETING = "Hey! 😊 Would you be interested in booking Bali for your event? Let me know the date you're looking at and your name, and I'll check what's available.";

function returningGreeting(firstName) {
  return `Hey ${firstName}! 😊 Interested in booking Bali again? Let me know the date you're looking at and I'll check what's available.`;
}

// Descriptive phrase per field, used both in the extraction prompt's
// "already confirmed" summary and as the ask_about labels fed to the
// reply-generation prompt below.
const FIELD_LABELS = {
  event_date: 'the date',
  event_type: 'the event type',
  event_name: 'a short name to call the event (e.g. for scheduling, not a person\'s name)',
  is_existing_client: 'whether they have hosted an event before, anywhere at all (not specifically with us) -- just gauging their general experience level',
  client_reference: 'their IG, TikTok, or website',
};

// Intake order, one step at a time: date -> event type + name (asked
// together, one natural question) -> whether they've hosted with us before
// -> IG/TikTok/website, but ONLY for clients who said yes to the previous
// step (owner's call -- brand-new clients aren't asked for a social handle
// at all). fieldOrder() is conditional on the current booking's
// is_existing_client so client_reference only becomes "needed" once that's
// true; STEP_GROUPS mirrors the same order/grouping for deciding what to
// ask about on any given turn.
function fieldOrder(booking) {
  const order = ['event_date', 'event_type', 'event_name', 'is_existing_client'];
  if (booking.is_existing_client === true) order.push('client_reference');
  return order;
}

const STEP_GROUPS = [['event_date'], ['event_type', 'event_name'], ['is_existing_client'], ['client_reference']];

// Owner asked for this exact phrasing twice after the model paraphrased it
// differently each time -- lock it down instead of leaving it to the LLM.
// This combined step can only ever occur with date_confirmed_available
// either true (same turn the date was just resolved) or false (a later
// turn, e.g. the client asked something else without answering this yet);
// dateRejected can't co-occur with it since event_date re-enters the
// missing list and takes priority again before this step is ever reached.
const TYPE_NAME_QUESTION = "What's the name of the event, and what type of event is it?";
// Owner's call: keep this professional, not casual -- no "Good news!" /
// "works!" style phrasing.
const DATE_CONFIRMED_LEAD_INS = ["That date is available.", "That date is available for booking."];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Which fields to ask about THIS turn, in priority order, grouping event
// type+name into one combined question but keeping every other field its
// own separate step. Deciding WHICH fields belong in the ask is done here
// in code, not by the model -- live-testing showed gpt-4o-mini unreliably
// inventing fields or dropping questions when asked to reason about a
// longer, more open-ended situation object. Scoped down to a concrete 1-2
// item list like this, it phrases things naturally and reliably (verified
// across ~20 live API calls covering every step, including the
// previously-flaky "is_existing_client alone" case, before deploying).
function currentStepFields(missingAfter) {
  for (const group of STEP_GROUPS) {
    const stillMissing = group.filter((f) => missingAfter.includes(f));
    if (stillMissing.length > 0) return stillMissing;
  }
  return [];
}

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
  // First-ever message from this client (or their only prior bookings were
  // cancelled): create the booking, send the greeting. If we already have
  // their name saved from a past conversation, greet them by it and skip
  // asking again instead of using the generic first-timer script -- this is
  // the one place in the whole flow the customer's name gets used, on
  // purpose (see contact.name capture below): once per new conversation,
  // never repeated mid-conversation.
  const created = await sbRequest('POST', 'bookings', {
    client_contact_id: contact.id,
    status: 'inquiry',
    mode: 'bot-led',
  }, { Prefer: 'return=representation' });
  booking = created[0];
  replyText = contact.name ? returningGreeting(contact.name.split(' ')[0]) : GREETING;
} else if (booking.status === 'sent_to_client' && (input.media_type === 'document' || input.media_type === 'image')) {
  // Stage 4 signature detection: client sent back the signed contract while
  // we're waiting on it -- a proper PDF scan or just a photo of the signed
  // paper, both are real signed contracts and neither should be rejected
  // (a photo is often the more realistic case). No e-signature tool for v1
  // -- ask the PM to confirm receipt/validity either way.
  logs.push({ booking_id: booking.id, sender_contact_id: contact.id, direction: 'inbound', message_text: `[${input.media_type} received]`, media_url: input.media_id, stage: booking.status });
  await sbRequest('POST', 'conversations', logs);
  const pmRows = await sbRequest('GET', 'contacts?role=eq.pm&select=*&limit=1');
  const pm = pmRows[0];
  if (pm) {
    // Forward the actual signed file, not just a text notification -- same
    // fix already applied to proof-of-payment: the PM was being asked to
    // confirm a document he'd never actually seen.
    const questionText = `${booking.event_name}: client sent back the signed contract (above). Confirm it's valid? Reply yes or no.`;
    const pendingRows = await sbRequest('POST', 'pending_questions', {
      booking_id: booking.id,
      field_name: 'contract_confirmed',
      question_text: questionText,
    }, { Prefer: 'return=representation' });
    // Track the file's own message id (not just the confirm question below) as
    // a swipe-reply target for relaying straight back to the client -- swipe
    // to reply on the client's own message should always go to that person,
    // never get reinterpreted by the bot. See findPlanningBookingByForwardedMessageId
    // in pm-toggle-code.js.
    const docMsgId = await sendWhatsAppMedia(pm.phone_number, input.media_type, input.media_id, `${booking.event_name}, signed contract`);
    await sbRequest('POST', 'conversations', [{ booking_id: booking.id, sender_contact_id: null, direction: 'outbound', message_text: `[relayed signed ${input.media_type} to PM]`, stage: 'connected_relay_to_pm', whatsapp_message_id: docMsgId || null }]);
    const msgId = await sendWhatsApp(pm.phone_number, questionText, booking.event_name);
    if (msgId) await sbPatch(`pending_questions?id=eq.${pendingRows[0].id}`, { whatsapp_message_id: msgId });
  }
  return [{ json: { action: 'signature_pending_pm_confirmation', booking_id: booking.id } }];
} else if (booking.status === 'invoiced' && (input.media_type === 'image' || input.media_type === 'document')) {
  // Stage 3: client sent proof of payment -- forward the actual receipt to
  // the PM (reusing Meta's media id directly, no re-upload needed) so he can
  // actually see it before confirming, not just be told one arrived.
  logs.push({ booking_id: booking.id, sender_contact_id: contact.id, direction: 'inbound', message_text: '[proof of payment received]', media_url: input.media_id, stage: booking.status });
  await sbRequest('POST', 'conversations', logs);
  const pmRows = await sbRequest('GET', 'contacts?role=eq.pm&select=*&limit=1');
  const pm = pmRows[0];
  if (pm) {
    // Same swipe-reply-goes-to-that-person tracking as the signed-contract
    // branch above: the receipt's own message id, not just the confirm
    // question, needs to be swipeable straight back to the client.
    const docMsgId = await sendWhatsAppMedia(pm.phone_number, input.media_type, input.media_id, `${booking.event_name}, proof of payment`);
    await sbRequest('POST', 'conversations', [{ booking_id: booking.id, sender_contact_id: null, direction: 'outbound', message_text: '[relayed proof of payment to PM]', stage: 'connected_relay_to_pm', whatsapp_message_id: docMsgId || null }]);
    const questionText = `${booking.event_name}: client sent proof of payment (above). Confirm receipt? Reply yes or no.`;
    const pendingRows = await sbRequest('POST', 'pending_questions', {
      booking_id: booking.id,
      field_name: 'payment_confirmed',
      question_text: questionText,
    }, { Prefer: 'return=representation' });
    const msgId = await sendWhatsApp(pm.phone_number, questionText, booking.event_name);
    if (msgId) await sbPatch(`pending_questions?id=eq.${pendingRows[0].id}`, { whatsapp_message_id: msgId });
  }
  await sendWhatsApp(from_number, "Got it, thanks. Confirming with our team now.");
  return [{ json: { action: 'payment_proof_pending_pm_confirmation', booking_id: booking.id } }];
} else if (booking.status === 'awaiting_contract' && await contractInfoStillMissing(booking)) {
  // Stage 4: organizer legal name + registered address must be explicitly confirmed
  // with the client, never assumed from their WhatsApp profile name.
  const contractRows = await sbRequest('GET', `contracts?booking_id=eq.${booking.id}&order=created_at.desc&limit=1&select=*`);
  const contract = contractRows[0];
  logs.push({ booking_id: booking.id, sender_contact_id: contact.id, direction: 'inbound', message_text: effectiveText, stage: booking.status });

  // One field at a time, form-style -- same principle as the rest of intake
  // (fieldOrder/currentStepFields never bundle two ambiguous things into one
  // guess). Asking for name and address together and trying to split them
  // out of one freeform reply was the actual fragile part: any partial miss
  // discarded everything, even a field it DID understand. Each field here is
  // its own single-purpose extraction against its own single question, so
  // there's nothing to disambiguate between two things in the same message.
  const sendToLawyerNow = async () => {
    await helpers.httpRequest({
      method: 'POST',
      url: `${env.N8N_BASE_URL}/webhook/stage3-4`,
      headers: { 'Content-Type': 'application/json' },
      body: { action: 'send_to_lawyer', booking_id: booking.id },
      json: true,
      timeout: 15000,
    });
    return "Thank you. Will send you an agreement contract soon.";
  };

  if (contract && !contract.organizer_legal_name) {
    const extraction = await askOpenAIJson(
      'The venue asked a client for their organization\'s full legal name. Does this WhatsApp message actually state one? Accept ANY capitalization -- WhatsApp users often type in all lowercase, and a lowercase name is exactly as valid as a capitalized one (e.g. "mad party entertainment" is a valid answer, same as "Mad Party Entertainment"). Labels like "name:" are fine but not required. Reply ONLY with JSON: {"organizer_legal_name": "..." or null}.',
      effectiveText || ''
    );
    if (extraction?.organizer_legal_name) {
      await sbPatch(`contracts?id=eq.${contract.id}`, { organizer_legal_name: extraction.organizer_legal_name });
      replyText = "Got it, thanks. Now, what's your organization's official registered address?";
    } else {
      replyText = "Sorry, I need your organization's full legal name first, could you send that?";
    }
  } else if (contract && !contract.organizer_registered_address) {
    const extraction = await askOpenAIJson(
      'The venue asked a client for their organization\'s official registered address. Does this WhatsApp message actually state one? Accept any real address detail, in any combination: street, city, state, and/or country -- none of these are individually required, and none should be dropped if given. Just the street alone is fine, just the state and country alone is fine, a full combination is fine -- always keep every part they actually provide, exactly as given, never trim it down. Labels like "address:" are fine either way. Reply ONLY with JSON: {"organizer_registered_address": "..." or null}.',
      effectiveText || ''
    );
    if (extraction?.organizer_registered_address) {
      await sbPatch(`contracts?id=eq.${contract.id}`, { organizer_registered_address: extraction.organizer_registered_address });
      replyText = `Please confirm these are correct -- reply YES if accurate or NO if not.\nName: ${contract.organizer_legal_name}\nAddress: ${extraction.organizer_registered_address}`;
    } else {
      replyText = "Sorry, I need your organization's official registered address, could you send that?";
    }
  } else if (contract && !contract.details_confirmed_at) {
    const extraction = await askOpenAIJson(
      'The venue asked a client to confirm their organization name and address are accurate, by replying YES or NO. Does this WhatsApp message clearly say yes/confirm, or clearly say no/incorrect? Reply ONLY with JSON: {"confirmed": true, false, or null}. Use null if the message is not actually a yes/no answer to this.',
      effectiveText || ''
    );
    if (extraction?.confirmed === true) {
      await sbPatch(`contracts?id=eq.${contract.id}`, { details_confirmed_at: new Date().toISOString() });
      // Normal intake always collects event_type before a booking can even
      // reach negotiation, but a booking can land here without it having
      // ever gone through that (e.g. a PM-driven "invoice [event]" command
      // on a booking that skipped intake) -- catch that here, last, rather
      // than send the lawyer a contract request with the event type blank.
      replyText = booking.event_type ? await sendToLawyerNow() : "Thanks. One more thing, what type of event is this?";
    } else if (extraction?.confirmed === false) {
      await sbPatch(`contracts?id=eq.${contract.id}`, { organizer_legal_name: null, organizer_registered_address: null });
      replyText = "No problem, let's redo it. What's your organization's full legal name?";
    } else {
      replyText = "Sorry, just reply YES if those details are accurate, or NO if not.";
    }
  } else if (contract && !booking.event_type) {
    const extraction = await askOpenAIJson(
      'The venue asked a client what type of event this is (e.g. wedding, birthday party, corporate event, conference). Does this WhatsApp message actually state one? Reply ONLY with JSON: {"event_type": "..." or null}.',
      effectiveText || ''
    );
    if (extraction?.event_type) {
      await sbPatch(`bookings?id=eq.${booking.id}`, { event_type: extraction.event_type });
      replyText = await sendToLawyerNow();
    } else {
      replyText = "Sorry, I need to know what type of event this is, could you tell me?";
    }
  }
  if (replyText) {
    await sendWhatsApp(from_number, replyText);
    logs.push({ booking_id: booking.id, sender_contact_id: null, direction: 'outbound', message_text: replyText, stage: booking.status });
  }
  await sbRequest('POST', 'conversations', logs);
  return [{ json: { action: 'awaiting_contract_handled', booking_id: booking.id, replied: !!replyText } }];
} else if (booking.status !== 'inquiry' && booking.connected_to_pm_at && !isPastConnectionCutoff(booking)) {
  // Once this booking has connected to the PM at all, the chat stays
  // connected -- through invoicing, contract, and the ongoing
  // signed/onboarded relationship, alongside any number of other customers'
  // conversations at the same time (no single-slot lock any more -- see
  // notifyPmOfCompletedIntake). The one exception: if the bot has a confident knowledge-base answer, it
  // answers directly instead of bothering him. This connected period ends
  // 7 days after the event date (see isPastConnectionCutoff), after which
  // it falls through to the normal automated/KB-escalation flow below.
  // whatsapp_message_id must be present (even if null) on every row here --
  // PostgREST's bulk insert rejects the whole batch (PGRST102 "All object
  // keys must match") if one row in the array has a key another doesn't.
  // Confirmed live: this silently broke every post-intake customer message
  // once the relay path (which adds whatsapp_message_id) ran alongside the
  // inbound log (which didn't).
  logs.push({ booking_id: booking.id, sender_contact_id: contact.id, direction: 'inbound', message_text: effectiveText, stage: booking.status, whatsapp_message_id: null });

  const kb = await checkKnowledgeBase(effectiveText);
  if (kb?.found && kb.answer) {
    await sendWhatsApp(from_number, kb.answer);
    logs.push({ booking_id: booking.id, sender_contact_id: null, direction: 'outbound', message_text: kb.answer, stage: 'kb_answered', whatsapp_message_id: null });
  } else {
    const pmRows = await sbRequest('GET', 'contacts?role=eq.pm&select=*&limit=1');
    const pm = pmRows[0];
    // A document/image reaching a connected booking through this general
    // path (any status other than the specific invoiced/sent_to_client
    // stages that already handle their own media) is ONLY the signed
    // contract if a contract was actually sent to this client at some point
    // (PM often sends it manually rather than through the official
    // approve-and-send flow, which is the only thing that sets status to
    // 'sent_to_client') and hasn't already been marked signed. Checked
    // directly against the contract row's own sent_to_client_at/signed_at,
    // not inferred from booking.status. Confirmed live as a real bug without
    // this check: a document sent any time after invoice approval -- proof
    // of payment arriving late, or literally anything else -- got assumed
    // to be a signed contract and asked "confirm it's valid?" even though no
    // contract had ever been sent to sign in the first place.
    const activeContract = (await sbRequest(
      'GET',
      `contracts?booking_id=eq.${booking.id}&order=created_at.desc&limit=1&select=sent_to_client_at,signed_at`
    ))[0];
    const awaitingSignedContract = !!(activeContract && activeContract.sent_to_client_at && !activeContract.signed_at);

    if (pm && input.media_type && awaitingSignedContract) {
      const questionText = `${booking.event_name}: client sent back a signed PDF (above). Confirm it's valid? Reply yes or no.`;
      const pendingRows = await sbRequest('POST', 'pending_questions', {
        booking_id: booking.id,
        field_name: 'contract_confirmed',
        question_text: questionText,
      }, { Prefer: 'return=representation' });
      // The forwarded document itself (not the confirm question) is what the
      // client actually sent -- swipe-reply to IT must relay straight back to
      // them, never get treated as an answer to the bot's own question.
      const docMsgId = await sendWhatsAppMedia(pm.phone_number, input.media_type, input.media_id, `${booking.event_name}, signed contract`);
      logs.push({ booking_id: booking.id, sender_contact_id: null, direction: 'outbound', message_text: `[relayed ${input.media_type} to PM]`, stage: 'connected_relay_to_pm', whatsapp_message_id: docMsgId || null });
      const msgId = await sendWhatsApp(pm.phone_number, questionText, booking.event_name);
      if (msgId) await sbPatch(`pending_questions?id=eq.${pendingRows[0].id}`, { whatsapp_message_id: msgId });
    } else if (pm && input.media_type) {
      // No contract awaiting signature -- just forward whatever it is,
      // no "is this signed?" assumption attached.
      const docMsgId = await sendWhatsAppMedia(pm.phone_number, input.media_type, input.media_id, `${booking.event_name}, from client`);
      logs.push({ booking_id: booking.id, sender_contact_id: null, direction: 'outbound', message_text: `[relayed ${input.media_type} to PM]`, stage: 'connected_relay_to_pm', whatsapp_message_id: docMsgId || null });
    } else if (pm) {
      const forwardText = `${booking.event_name}: ${effectiveText}`;
      const msgId = await sendWhatsApp(pm.phone_number, forwardText, booking.event_name);
      logs.push({ booking_id: booking.id, sender_contact_id: null, direction: 'outbound', message_text: `[relayed to PM] ${effectiveText}`, stage: 'connected_relay_to_pm', whatsapp_message_id: msgId || null });
    }
  }
  await sbRequest('POST', 'conversations', logs);
  return [{ json: { action: 'connected_relay_handled', booking_id: booking.id } }];
} else if (booking.status !== 'inquiry') {
  // Never connected yet, or past the 7-day-post-event connection cutoff -- either way, back to the
  // normal automated flow. Going completely silent here reads as broken --
  // actually answer genuine questions via the knowledge base, and give a
  // warm, freshly-worded reassurance for anything else, instead of ignoring
  // the client.
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
    const waitingReply = stripMarkdown(waitingReplyResult?.reply) || "Still with our team on this, I'll follow up as soon as I can.";
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

  // A real past Bali booking is sufficient proof they've hosted an event
  // before (it's a subset of "anywhere at all") -- don't bother asking in
  // that case. A self-report is only needed when we genuinely don't know.
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
    event_type: booking.event_type,
    event_name: booking.event_name,
    is_existing_client: booking.is_existing_client,
    client_reference: booking.client_reference,
  };
  const missingBefore = fieldOrder(booking).filter(
    (f) => known[f] === null || known[f] === undefined
  );

  const extraction = await askOpenAIJson(
    `You're reading a WhatsApp conversation between a client and Bali, an event venue, during the booking intake stage. Today is ${todayWeekday}, ${todayStr}.

Already confirmed about this booking: ${JSON.stringify(known)}
Still needed (in priority order, but the client may answer out of order or give several at once): ${JSON.stringify(missingBefore)}

Conversation so far:
${transcript}

Client's latest message: "${effectiveText || ''}"

Extract EVERY still-needed field this message provides, not just the one you were "expecting" next -- e.g. "birthday party for my sister" gives you both event_type ("birthday party") AND enough for event_name ("Sister's Birthday Party"), extract both in the same pass rather than leaving event_type blank because event_name came first in priority order. Resolve relative dates ("next Friday", "this weekend", a bare day name) against today's date; a full date (day AND month both stated) can be written in ANY order or format -- "3rd august", "aug 3", "september 20th", even a misspelled month name -- read it the way a person naturally would, there's no one fixed order to expect. If an event_date is extracted with no year stated (e.g. "24th july"), resolve it against the CURRENT year regardless of anything discussed earlier in the conversation -- never carry a year over from an earlier message or an earlier "did you mean [year]?" question. A bare day-of-month with NO month stated ANYWHERE (e.g. just "23rd", just "the 5th", nothing else) is NOT enough to extract a full event_date -- never guess or default a month for this specific case; leave event_date unextracted and instead set day_of_month_given to the day as they wrote it (e.g. "23rd"), so the reply can ask specifically which month. If the message is instead (or also) a genuine question or comment not covered by the fields above (pricing, parking, capacity, "what dates are open", small talk, etc.), note it as off_topic -- something the venue needs to actually answer, not guess at. Separately, if the client is stating or correcting their own name (e.g. "I'm Chidera", "my name is X", "it's actually X not Y"), extract it as customer_name -- never guess a name from anything else they say. Also extract customer_name if the venue's own message in the transcript just directly asked for their name (the very first greeting always does) and this message is a short direct answer to that -- a real name, a business/brand name, or a social handle they gave in reply all count, exactly as they wrote it (don't require "I'm"/"my name is" phrasing in this specific case, since it's a direct answer to being asked).

Reply ONLY with JSON: {"extracted": {"event_date"?: "YYYY-MM-DD", "event_type"?: "...", "event_name"?: "...", "is_existing_client"?: true/false, "client_reference"?: "..."}, "day_of_month_given": "..." or null, "off_topic": "..." or null, "customer_name": "..." or null}`,
    effectiveText || ''
  );

  const extracted = extraction?.extracted || {};
  const patch = {};
  for (const f of missingBefore) {
    if (extracted[f] !== undefined && extracted[f] !== null && extracted[f] !== '') {
      patch[f] = extracted[f];
    }
  }

  // The model's own event_date_year_stated claim isn't trustworthy either --
  // verified live: with an earlier "did you mean [year]?" question still
  // sitting in the transcript, it silently carried that year over onto a
  // completely different date the client typed next, one that never stated
  // a year at all, so the past-date check below never fired since the date
  // it was checking already had the wrong (future) year baked in. Decide
  // "did they actually state a year" deterministically from the raw message
  // instead, and strip any year the model invented when they didn't --
  // resolveRelativeDate's output is untouched by this since it never invents
  // a year the client didn't imply, it always resolves against `today`.
  const yearStatedInText = /\b(19|20)\d{2}\b/.test(effectiveText || '');
  if (patch.event_date && !yearStatedInText) {
    const [, m, d] = patch.event_date.split('-');
    patch.event_date = `${today.getUTCFullYear()}-${m}-${d}`;
  }

  // Customer name: captured (or corrected) whenever they state it, regardless
  // of what stage of intake they're at -- saved straight to the contact
  // record, never displayed back mid-conversation (see returningGreeting,
  // the only place it's actually used).
  if (extraction?.customer_name && extraction.customer_name !== contact.name) {
    await sbPatch(`contacts?id=eq.${contact.id}`, { name: extraction.customer_name });
    contact.name = extraction.customer_name;
  }

  // The model's own date arithmetic isn't trustworthy (verified: it got a
  // relative date wrong even with today's date given) -- deterministic parsing
  // wins whenever the message matches a pattern it understands.
  if (missingBefore.includes('event_date')) {
    const resolved = resolveRelativeDate(effectiveText);
    if (resolved) patch.event_date = resolved;
  }

  // If we're waiting on "did you mean [year]?" from a past date rejected on
  // an earlier turn, resolve it before running today's past-date check -- a
  // plain "yes" confirms the suggested date (already future, skips the check
  // below entirely); anything else supersedes it and today's own patch
  // (from extraction/resolveRelativeDate above) is used as normal.
  const openDateConfirm = (await sbRequest(
    'GET',
    `pending_questions?booking_id=eq.${booking.id}&field_name=eq.event_date_year_confirm&resolved_at=is.null&select=*`
  ))[0];
  if (openDateConfirm) {
    await sbPatch(`pending_questions?id=eq.${openDateConfirm.id}`, { resolved_at: new Date().toISOString() });
    if (/^(y(es)?|yeah|yep|yup|sure|ok(ay)?|correct)\b/i.test((effectiveText || '').trim())) {
      patch.event_date = openDateConfirm.question_text;
    }
  }

  // Confirmed live 2026-08-03: a client who gave a bare day-of-month ("3rd")
  // got asked "which month?" (see day_of_month_given handling below), but
  // that day was only ever held in this one turn's extraction result --
  // never saved anywhere. The NEXT turn's extraction runs fresh, with no
  // memory of it beyond re-reading the raw transcript text, and a bare
  // month-only reply ("August") doesn't match any case the extraction
  // prompt actually describes, so it went unacknowledged. Persist the day
  // the same way event_date_year_confirm already persists a suggested year
  // (a pending_questions row), and on the turn it's answered, combine the
  // saved day with a month found deterministically in this message (small
  // closed vocabulary, same reasoning as resolveRelativeDate not trusting
  // the model for date arithmetic) rather than asking the model to
  // reconstruct both halves from the transcript.
  const openMonthNeeded = (await sbRequest(
    'GET',
    `pending_questions?booking_id=eq.${booking.id}&field_name=eq.event_date_month_needed&resolved_at=is.null&select=*`
  ))[0];
  if (openMonthNeeded) {
    if (patch.event_date) {
      // A full date arrived this turn some other way (e.g. the client just
      // restated the whole date instead of answering "which month") -- their
      // answer wins outright, just clean up the now-stale pending row so it
      // doesn't sit open forever.
      await sbPatch(`pending_questions?id=eq.${openMonthNeeded.id}`, { resolved_at: new Date().toISOString() });
    } else {
      const day = findDayNumber(openMonthNeeded.question_text);
      const month = findMonthNumber(effectiveText);
      if (day && month) {
        await sbPatch(`pending_questions?id=eq.${openMonthNeeded.id}`, { resolved_at: new Date().toISOString() });
        patch.event_date = `${today.getUTCFullYear()}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
      // No month recognized this turn -- leave the pending row open rather
      // than resolving it against nothing; normal extraction/off-topic
      // handling still runs below for whatever they actually said.
    }
  } else if (!patch.event_date && extraction?.day_of_month_given) {
    // A fresh bare day-of-month with no pending month-question already open
    // for it -- persist it now so the combination above can find it on
    // whichever future turn actually supplies the month.
    await sbRequest('POST', 'pending_questions', {
      booking_id: booking.id,
      field_name: 'event_date_month_needed',
      question_text: extraction.day_of_month_given,
    });
  }

  // A date given without an explicit year can resolve to something already
  // in the past (e.g. "24th july" read literally once that day's already
  // gone by this year) -- never save that silently. Ask instead of guessing
  // which year they meant; if they DID give a year and it's still in the
  // past, don't presume a year-shift either, just ask for a different date.
  let datePast = false;
  let datePastSuggestion = null;
  if (patch.event_date && patch.event_date < todayStr) {
    datePast = true;
    if (!yearStatedInText) {
      const [y, m, d] = patch.event_date.split('-').map(Number);
      datePastSuggestion = `${y + 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      await sbRequest('POST', 'pending_questions', {
        booking_id: booking.id,
        field_name: 'event_date_year_confirm',
        question_text: datePastSuggestion,
      });
    }
    delete patch.event_date;
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
  // Only true when a date was newly given THIS turn and passed the
  // collision check -- patch.event_date is deleted above if rejected, so
  // its survival here already means "just confirmed available."
  const dateConfirmed = !!patch.event_date;

  if (Object.keys(patch).length > 0) {
    await sbPatch(`bookings?id=eq.${booking.id}`, patch);
    Object.assign(booking, patch);
  }

  const missingAfter = fieldOrder(booking).filter(
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

  // What to ask about THIS turn, decided deterministically in code -- see
  // the comment on currentStepFields for why. Fed to the model below only
  // as a fixed 1-2 item list to phrase naturally, never left for it to
  // decide on its own.
  const stepFields = currentStepFields(missingAfter);
  const stepLabels = stepFields.map((f) => FIELD_LABELS[f]);
  const isTypeNameStep = stepFields.length === 2 && stepFields.includes('event_type') && stepFields.includes('event_name');

  if (datePast) {
    // Fixed reply, no LLM call -- exact wording matters here, and this
    // shouldn't wait on a model call to tell the client their date's gone.
    replyText = datePastSuggestion
      ? `That date has passed. Did you mean ${formatDateForCustomer(datePastSuggestion)}?`
      : "That date has already passed. Could you give me a different date?";
  } else if (isTypeNameStep) {
    // Fixed question, no LLM call -- see the comment on TYPE_NAME_QUESTION.
    const leadIn = dateConfirmed ? pick(DATE_CONFIRMED_LEAD_INS) : (kbPending ? "Let me check on that for you." : null);
    replyText = leadIn ? `${leadIn} ${TYPE_NAME_QUESTION}` : TYPE_NAME_QUESTION;
  } else {
    const replyResult = await askOpenAIJson(
      `You're Bali, an event venue's WhatsApp assistant, texting a client during booking intake. Warm, professional, brief and human -- never sound like an AI, no "Awesome!", no repeating earlier phrasing. Keep it SHORT -- one short sentence, no lists, no line breaks, this is WhatsApp not email.

Conversation so far:
${transcript}
Client: ${effectiveText || ''}

What actually happened this turn: ${JSON.stringify({
        saved_this_turn: patch,
        date_confirmed_available: dateConfirmed,
        date_rejected_already_booked: dateRejected,
        date_day_given_needs_month: extraction?.day_of_month_given || null,
        knowledge_base_question_pending: kbPending,
        ask_about: stepLabels,
        intake_just_completed: justCompleted,
      })}

Write the next short message to the client. Rules: ask ONLY about the items in ask_about -- never invent or add anything not listed and not in ask_about. If date_confirmed_available is true, briefly confirm the date's available (e.g. "That date's available!") before asking about ask_about. If date_confirmed_available is FALSE, do NOT mention the date's availability at all, even if the conversation above already confirmed it earlier -- that was already said once, saying it again on a later turn is a real, repeated bug, never do it. If date_day_given_needs_month is set, the client gave that day of the month but not which month -- ask specifically which month it's for (referencing the day naturally, e.g. "The 23rd -- which month?"), and treat the date as still not answered (don't also ask about ask_about's other items yet if event_date is one of them, wait for the month first). If ask_about is empty and intake_just_completed is true, say only something brief like "Give me a moment, I'll follow up with you shortly" -- don't mention a person/manager, don't ask anything further. If a date was just rejected as already booked, mention that plainly first, then still ask about ask_about if not empty. If a knowledge base question is pending, briefly acknowledge you're checking on it, then still ask about ask_about if not empty (or just the acknowledgment if ask_about is empty).

Reply ONLY with JSON: {"reply": "..."}`,
      effectiveText || ''
    );

    replyText = stripMarkdown(replyResult?.reply) || null;
    if (!replyText) {
      // Model call failed outright -- fall back to something serviceable.
      replyText = stepLabels.length > 0
        ? `Could you let me know ${stepLabels.join(' and ')}?`
        : "Give me a moment, I'll follow up with you shortly.";
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

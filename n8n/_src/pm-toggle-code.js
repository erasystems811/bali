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

function sanitizeTemplateParam(text) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' -- ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 1000) || '(see details)';
}

// WhatsApp rejects free-form text once 24h have passed since the recipient's
// last inbound message (error 131047) -- fall back to the approved
// "bali_notification" utility template (single body variable) instead of
// the send just failing.
async function sendWhatsAppTemplate(toNumber, text) {
  if (SANDBOX) return sandboxLog(toNumber, text, 'template');
  return helpers.httpRequest({
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

async function sendWhatsApp(toNumber, text) {
  if (SANDBOX) return sandboxLog(toNumber, text, 'text');
  if (!(await isWithinMessagingWindow(toNumber))) {
    return sendWhatsAppTemplate(toNumber, text);
  }
  try {
    return await helpers.httpRequest({
      method: 'POST',
      url: `https://graph.facebook.com/v20.0/${env.META_PHONE_ID}/messages`,
      headers: {
        Authorization: `Bearer ${env.META_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: { messaging_product: 'whatsapp', to: toNumber, type: 'text', text: { body: text } },
      json: true,
      timeout: 20000,
    });
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

async function openaiExtract(fieldPrompt, userText) {
  const res = await helpers.httpRequest({
    method: 'POST',
    url: 'https://api.openai.com/v1/chat/completions',
    headers: { Authorization: `Bearer ${env.OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: {
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: fieldPrompt },
        { role: 'user', content: userText || '' },
      ],
    },
    json: true,
    timeout: 30000,
  });
  try {
    return JSON.parse(res.choices[0].message.content);
  } catch (e) {
    return { understood: false };
  }
}

async function askOpenAIText(systemPrompt, userText) {
  const res = await helpers.httpRequest({
    method: 'POST',
    url: 'https://api.openai.com/v1/chat/completions',
    headers: { Authorization: `Bearer ${env.OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText || '' },
      ],
    },
    json: true,
    timeout: 30000,
  });
  return res.choices?.[0]?.message?.content?.trim() || null;
}

const FIELD_PROMPTS = {
  staffing_type: 'The PM is answering whether the event needs full-time or part-time staff. Reply ONLY with JSON: {"understood": true/false, "value": "full-time"|"part-time"}.',
  security_count: 'The PM is answering how many security/bouncers are needed for the event. Reply ONLY with JSON: {"understood": true/false, "value": <integer>}.',
  security_notes: 'The PM is answering a question about special security/"vigilante" needs for the event. Reply ONLY with JSON: {"understood": true/false, "value": "..."}.',
};

async function findContactByPhone(phone) {
  const rows = await sbRequest('GET', `contacts?phone_number=eq.${encodeURIComponent(phone)}&select=*`);
  return rows[0] || null;
}

async function findPmLedBooking() {
  const rows = await sbRequest('GET', 'bookings?mode=eq.pm-led&limit=1&select=*');
  return rows[0] || null;
}

// Shared by the manual "open [event name]" command and the auto-advance that
// fires on "close" -- opening a booking always means the same thing: flip
// the lock, show what's already been discussed, and tell the PM it's live.
async function openBookingForPm(booking, fromNumber, { auto } = {}) {
  // connected_to_pm_at is set once and never cleared -- see the comment on
  // that column in schema.sql. It's what keeps the client's messages
  // relaying straight to the PM even after "close" flips mode back to
  // 'bot-led' for the FIFO negotiation lock (e.g. once this booking moves
  // on to invoicing).
  await sbPatch(`bookings?id=eq.${booking.id}`, { mode: 'pm-led', connected_to_pm_at: new Date().toISOString() });

  const history = await sbRequest('GET', `conversations?booking_id=eq.${booking.id}&order=created_at.asc&select=direction,message_text`);
  if (history.length > 0) {
    const transcript = history.map((m) => `${m.direction === 'inbound' ? 'Client' : 'Bali'}: ${m.message_text}`).join('\n');
    await sendWhatsApp(fromNumber, `Conversation so far for ${booking.event_name}:\n${transcript}`);
  }

  const openedLine = auto
    ? `Next up: ${booking.event_name}.`
    : `Opened ${booking.event_name}.`;
  const tipLines = [
    'Note:',
    `- Swipe-reply to their message to answer them directly -- no need to type the event name. Only start with "${booking.event_name}: " if you're messaging them first (nothing to swipe-reply to); otherwise it stays between just us and will NOT reach them.`,
    `- Once you've agreed a price, say something like "generate invoice for ${booking.event_name}" and I'll send it out.`,
    `- "${booking.event_name}: close" ends that conversation and hands the customer back to me.`,
    `- "${booking.event_name}: open" reconnects it.`,
  ].join('\n');
  await sendWhatsApp(fromNumber, `${openedLine}\n\n${tipLines}`);
}

async function findOpenPendingQuestions() {
  return sbRequest('GET', 'pending_questions?resolved_at=is.null&select=*,bookings(*)');
}

async function logConversation(bookingId, senderContactId, direction, text, stage, whatsappMessageId) {
  await sbRequest('POST', 'conversations', [
    { booking_id: bookingId, sender_contact_id: senderContactId, direction, message_text: text, stage, whatsapp_message_id: whatsappMessageId || null },
  ]);
}

// Signed/onboarded bookings are always-on planning conversations (no
// open/close toggle) -- "awaiting reply" means the client's latest message
// on that thread hasn't been answered by the PM yet.
async function findAwaitingPlanningBookings() {
  const bookings = await sbRequest('GET', 'bookings?status=in.(signed,onboarded)&select=id,event_name,client_contact_id');
  const awaiting = [];
  for (const booking of bookings) {
    const latest = await sbRequest(
      'GET',
      `conversations?booking_id=eq.${booking.id}&stage=eq.planning_relay&order=created_at.desc&limit=1&select=direction`
    );
    if (latest[0]?.direction === 'inbound') {
      awaiting.push(booking);
    }
  }
  return awaiting;
}

// Matches a PM swipe-reply against the specific "forwarded to PM" message for
// a client's message (logged with stage 'connected_relay_to_pm' -- see the
// unified connected branch in stage1-code.js). This is the primary way a PM
// replies to a customer now: swipe-reply to what the client said, no need to
// type the event name -- the event name prefix is only the fallback for when
// there's nothing to swipe-reply to (the PM messaging first, or the message
// having scrolled out of easy reach).
async function findPlanningBookingByForwardedMessageId(messageId) {
  if (!messageId) return null;
  const rows = await sbRequest(
    'GET',
    `conversations?whatsapp_message_id=eq.${encodeURIComponent(messageId)}&stage=eq.connected_relay_to_pm&select=booking_id&limit=1`
  );
  if (!rows[0]) return null;
  const booking = await sbRequest('GET', `bookings?id=eq.${rows[0].booking_id}&select=id,event_name,client_contact_id`);
  return booking[0] || null;
}

// Same pattern as findPlanningBookingByForwardedMessageId, for a lawyer
// question forwarded to the PM (see handleLawyerInbound in
// stage3-4-action-code.js) -- matched against conversations, not
// pending_questions, specifically so swipe-replying to that SAME forwarded
// message works every time, not just the first -- confirmed live, a
// one-shot pending_questions row meant the second reply fell through to the
// generic fallback chat instead of ever reaching the lawyer.
async function findLawyerRelayBookingIdByForwardedMessageId(messageId) {
  if (!messageId) return null;
  const rows = await sbRequest(
    'GET',
    `conversations?whatsapp_message_id=eq.${encodeURIComponent(messageId)}&stage=eq.lawyer_question_relay&select=booking_id&limit=1`
  );
  return rows[0]?.booking_id || null;
}

const input = $input.first().json.body;
const { from_number, text, reply_to_message_id, contact_id } = input;
const trimmed = (text || '').trim();

// --- Command: "lawyer: message" -- explicit, deliberate way to reach the
// lawyer directly, same idea as the "[event name]: message" client relay
// below but for a fixed keyword instead of a looked-up event name (never
// collides with a real event since "lawyer" isn't one). Swipe-reply already
// handled above takes priority if both somehow applied. Logged against
// whichever contract is currently active with him, if any, purely for
// conversation history -- the send itself only needs his phone number.
const lawyerMatch = !reply_to_message_id ? trimmed.match(/^lawyer\s*:\s*([\s\S]+)$/i) : null;
if (lawyerMatch) {
  const lawyerMsg = lawyerMatch[1].trim();
  const lawyer = (await sbRequest('GET', 'contacts?role=eq.lawyer&select=*&limit=1'))[0];
  if (!lawyer) {
    await sendWhatsApp(from_number, "No lawyer contact set up yet.");
    return [{ json: { action: 'lawyer_relay_no_lawyer' } }];
  }
  await sendWhatsApp(lawyer.phone_number, lawyerMsg);
  const activeContract = (await sbRequest('GET', 'contracts?sent_to_lawyer_at=not.is.null&select=booking_id&order=sent_to_lawyer_at.desc&limit=1'))[0];
  if (activeContract) {
    await logConversation(activeContract.booking_id, contact_id, 'inbound', trimmed, 'pm_message');
    await logConversation(activeContract.booking_id, null, 'outbound', lawyerMsg, 'lawyer_question_relay');
  }
  return [{ json: { action: 'lawyer_message_relayed' } }];
}

// --- Command: "invoice [event name][: details]" -- manual trigger to draft
// the invoice, directly to the bot -- no underlying client conversation
// needed. Fuzzy on purpose -- the PM shouldn't have to remember an exact
// phrase. Matches "invoice X", "generate invoice for X", "please create an
// invoice for X", "send invoice to X", etc. Optionally, anything after a
// colon is treated as the agreed items/price straight from the PM (e.g.
// "generate invoice for Soundwave: 2m for sound, screen and staff") and gets
// fed into the exact same extraction the bot already runs on a real
// negotiation transcript -- same collective-vs-itemized handling, same
// final-agreed-state logic, just with this one line standing in for (or
// added on top of) whatever's actually in the conversation history.
const invoiceMatch = trimmed.match(/^(?:please\s+)?(?:generate|create|make|send|draft)?\s*(?:an?\s+)?invoice(?:\s+(?:for|to))?\s+(.+)$/i);
if (invoiceMatch) {
  const rest = invoiceMatch[1].trim();
  const colonIdx = rest.indexOf(':');
  const eventName = (colonIdx === -1 ? rest : rest.slice(0, colonIdx)).trim();
  const pmDetails = colonIdx === -1 ? null : rest.slice(colonIdx + 1).trim();
  const matches = await sbRequest('GET', `bookings?event_name=ilike.*${encodeURIComponent(eventName)}*&status=neq.cancelled&select=*`);
  if (matches.length === 0) {
    await sendWhatsApp(from_number, `Couldn't find a booking called "${eventName}". Check the spelling?`);
    return [{ json: { action: 'invoice_command_not_found', query: eventName } }];
  }
  await helpers.httpRequest({
    method: 'POST',
    url: `${env.N8N_BASE_URL}/webhook/stage3-4`,
    headers: { 'Content-Type': 'application/json' },
    body: { action: 'draft_invoice', booking_id: matches[0].id, pm_details: pmDetails },
    json: true,
    timeout: 15000,
  });
  return [{ json: { action: 'invoice_command_triggered', booking_id: matches[0].id } }];
}

// --- Command: "open [event name]" -------------------------------------------------
const openMatch = trimmed.match(/^open\s+(.+)$/i);
if (openMatch) {
  const eventName = openMatch[1].trim();
  const alreadyOpen = await findPmLedBooking();
  if (alreadyOpen) {
    await sendWhatsApp(from_number, `You've still got ${alreadyOpen.event_name} open. Type close first before opening another one.`);
    return [{ json: { action: 'open_blocked', open_booking: alreadyOpen.id } }];
  }
  const matches = await sbRequest('GET', `bookings?event_name=ilike.*${encodeURIComponent(eventName)}*&status=neq.cancelled&select=*`);
  if (matches.length === 0) {
    await sendWhatsApp(from_number, `Couldn't find a booking called ${eventName}. Check the spelling?`);
    return [{ json: { action: 'open_not_found', query: eventName } }];
  }
  const booking = matches[0];
  await openBookingForPm(booking, from_number);
  return [{ json: { action: 'opened', booking_id: booking.id } }];
}

// --- Command: rename the event's name -- natural-language, not a fixed
// phrase. Classified by the model rather than matched by a rigid regex, since
// the PM shouldn't have to remember an exact "rename X to Y" pattern -- any
// wording that means "change the name" should work. This is NOT the same
// category as the client-relay safety gate elsewhere in this file (which must
// stay deterministic, zero LLM discretion, per the owner's explicit rule) --
// misclassifying this only costs a wrong DB field getting updated or a
// clarifying follow-up, it never sends anything to a client, so LLM judgment
// is an acceptable trade here. Verified against 14 phrasings (positive and
// negative, including "change the price/date/staffing to X" near-misses)
// before deploying -- 14/14 correct.
const renameIntent = await openaiExtract(
  'The PM (venue staff) is messaging Bali, an internal WhatsApp assistant, about ONE of their event bookings. Decide if this message is asking to CHANGE/RENAME the event\'s name specifically (not the price, date, staffing, or anything else about the event). If yes, extract the new name they want, and the OLD/current name if they explicitly mentioned one (null if they didn\'t -- e.g. "change the name to Soundwave 2" gives no old name, they just mean whichever event is currently open/being discussed). Reply ONLY with JSON: {"is_rename": true/false, "new_name": "..."|null, "old_name": "..."|null}.',
  trimmed
);
if (renameIntent?.is_rename && renameIntent.new_name) {
  let booking = null;
  if (renameIntent.old_name) {
    const matches = await sbRequest('GET', `bookings?event_name=ilike.*${encodeURIComponent(renameIntent.old_name)}*&status=neq.cancelled&select=*`);
    if (matches.length === 0) {
      await sendWhatsApp(from_number, `Couldn't find a booking called "${renameIntent.old_name}". Check the spelling?`);
      return [{ json: { action: 'rename_not_found', query: renameIntent.old_name } }];
    }
    booking = matches[0];
  } else {
    // No old name given -- assume whichever booking is currently open with a
    // client (the one thing being actively discussed), same "current"
    // resolution used elsewhere (e.g. the free-form fallback reply below).
    booking = await findPmLedBooking();
    if (!booking) {
      await sendWhatsApp(from_number, 'Which event? Nothing\'s currently open, so give me the current name too, e.g. "rename Mad Party to Soundwave 2".');
      return [{ json: { action: 'rename_no_target' } }];
    }
  }
  const oldName = booking.event_name;
  await sbPatch(`bookings?id=eq.${booking.id}`, { event_name: renameIntent.new_name });
  await sendWhatsApp(from_number, `Renamed "${oldName}" to "${renameIntent.new_name}".`);
  return [{ json: { action: 'renamed', booking_id: booking.id, old_name: oldName, new_name: renameIntent.new_name } }];
}

// --- Command: "close" --------------------------------------------------------------
if (trimmed.toLowerCase() === 'close') {
  const open = await findPmLedBooking();
  if (!open) {
    await sendWhatsApp(from_number, "Nothing's open right now.");
    return [{ json: { action: 'close_noop' } }];
  }
  await sbPatch(`bookings?id=eq.${open.id}`, { mode: 'bot-led' });
  await sendWhatsApp(from_number, `Closed ${open.event_name}. Back to automated.`);

  // Closing a still-negotiating booking is taken as "price agreed" -- kicks off Stage 3.
  // If that's wrong (PM just stepping away mid-negotiation), re-open with "open [event name]"
  // -- nothing below has moved the booking past 'negotiating' yet.
  if (open.status === 'negotiating') {
    await helpers.httpRequest({
      method: 'POST',
      url: `${env.N8N_BASE_URL}/webhook/stage3-4`,
      headers: { 'Content-Type': 'application/json' },
      body: { action: 'draft_invoice', booking_id: open.id },
      json: true,
      timeout: 15000,
    });
  }

  // FIFO auto-advance: whoever's been waiting longest opens automatically,
  // no need for the PM to know their name or type "open" himself.
  const nextInQueue = await sbRequest(
    'GET',
    'bookings?status=eq.negotiating&mode=eq.bot-led&order=negotiation_queued_at.asc&limit=1&select=*'
  );
  if (nextInQueue.length > 0) {
    await openBookingForPm(nextInQueue[0], from_number, { auto: true });
  }

  return [{ json: { action: 'closed', booking_id: open.id, next_booking_id: nextInQueue[0]?.id || null } }];
}

// --- Swipe-reply resolution -- the PRIMARY way the PM replies to a client.
// Checked first, ahead of everything else that follows: if the PM
// swipe-replied to a specific WhatsApp message, that unambiguously
// identifies what he's responding to, so there's no need to type the event
// name -- and it avoids a colon anywhere in his reply text being misread as
// an explicit "[event]:" prefix aimed at some other booking. Typing the
// event name (below) is only the fallback for when there's nothing to
// swipe-reply to: the PM messaging a client first, or the original message
// having scrolled out of easy reach.
const pending = await findOpenPendingQuestions();
const planningCandidates = await findAwaitingPlanningBookings();

let target = null; // a pending_questions row
let planningTarget = null; // a booking row (signed/onboarded, or connected, awaiting reply)
// The PM's actual reply text to act on -- normally the full message, but when
// disambiguating by number (e.g. "2: yes") it's just the part after "2:".
let answerText = text;

// When the booking to relay to was already resolved some other way (swipe-
// reply, or auto-matched as the sole thing awaiting a reply), the PM doesn't
// NEED to type the event name -- but habit means they sometimes do anyway
// (e.g. "mad hey" for booking "Mad's Birthday Party"). Unlike the explicit
// "[event name] message" addressing path (which is the only place a leading
// event name is actually required, and already strips it via
// stripLeadingEventName below), these already-resolved paths used to relay
// the raw text unstripped, leaking the event name straight to the client
// verbatim -- confirmed live 2026-07-30 ("mad hey, setup starts at 2pm" sent
// to the client exactly as typed). Strip it here too whenever it happens to
// lead the text, using the SAME stripLeadingEventName helper (declared below
// -- function declarations hoist, so this earlier call is fine).
function stripAccidentalEventPrefix(rawText, eventName) {
  const stripped = stripLeadingEventName(rawText, eventName);
  return stripped !== null ? stripped : rawText;
}

if (reply_to_message_id) {
  target = pending.find((p) => p.whatsapp_message_id === reply_to_message_id) || null;
  if (!target) {
    planningTarget = await findPlanningBookingByForwardedMessageId(reply_to_message_id);
  }
  if (planningTarget) {
    const client = (await sbRequest('GET', `contacts?id=eq.${planningTarget.client_contact_id}&select=*`))[0];
    const relayText = stripAccidentalEventPrefix(answerText, planningTarget.event_name);
    if (client?.phone_number) {
      await sendWhatsApp(client.phone_number, relayText);
      await logConversation(planningTarget.id, null, 'outbound', relayText, 'planning_relay');
    }
    await logConversation(planningTarget.id, contact_id, 'inbound', answerText, 'pm_message');
    return [{ json: { action: 'planning_relayed_to_client', booking_id: planningTarget.id } }];
  }
  if (!target) {
    const lawyerRelayBookingId = await findLawyerRelayBookingIdByForwardedMessageId(reply_to_message_id);
    if (lawyerRelayBookingId) {
      const lawyer = (await sbRequest('GET', 'contacts?role=eq.lawyer&select=*&limit=1'))[0];
      if (lawyer) await sendWhatsApp(lawyer.phone_number, answerText);
      await logConversation(lawyerRelayBookingId, null, 'outbound', answerText, 'lawyer_question_relay', undefined);
      await logConversation(lawyerRelayBookingId, contact_id, 'inbound', answerText, 'pm_message');
      return [{ json: { action: 'lawyer_question_relayed', booking_id: lawyerRelayBookingId } }];
    }
  }
  // target set (a pending question) falls through -- resolved by the generic
  // field-answer logic further down, same as any other match.
}

// --- Explicit "[event name] message" -- typed fallback when there's nothing
// to swipe-reply to. This is how the PM addresses a specific booking
// directly and unambiguously when messaging first, or running the per-event
// "close"/"open" commands below -- several bookings can be connected at once
// (invoiced, awaiting contract, signed, onboarded...), so there's no single
// implicit target the way there is during live negotiation. No colon (or
// any other punctuation) is required between the event name and the
// message -- "Mad Party hey", "Mad Party: hey", "Mad Party, hey" all work.
// What makes this an explicit address rather than an implicit guess is that
// the text has to actually start with a REAL connected booking's full event
// name (letters/numbers only, case and spacing ignored) -- not any
// punctuation shape. Skipped entirely if swipe-reply above already resolved
// a target.
function normalizeEventRef(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Tries to consume `eventName` (letters/numbers only, case-insensitive) off
// the front of `text`, skipping over any punctuation/whitespace in `text`
// along the way. Requires a real boundary right after the match (end of
// string, or a non-letter/number character) so a short event name can't
// accidentally match as a prefix of an unrelated longer word (e.g. "Mad"
// swallowing "Madrid"). Returns the remaining text (leading separators
// trimmed) on success, or null if `eventName` isn't a match at the start.
function stripLeadingEventName(text, eventName) {
  const wanted = normalizeEventRef(eventName);
  if (!wanted) return null;
  let consumed = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/[a-z0-9]/i.test(ch)) {
      consumed += ch.toLowerCase();
      if (consumed === wanted) {
        const next = text[i + 1];
        if (next && /[a-z0-9]/i.test(next)) return null; // e.g. "Mad" inside "Madrid" -- no boundary
        return text.slice(i + 1).replace(/^[\s:,.\-–—]+/, '');
      }
      if (consumed.length > wanted.length) return null;
    }
  }
  return null;
}

// Same rule as stage1-code.js's isPastConnectionCutoff (duplicated per this
// codebase's existing per-file helper convention -- see e.g. sandboxLog):
// 7 days after the event, a booking stops staying connected to the PM,
// UNLESS he's manually reached back out since (connected_to_pm_at refreshed
// at/after the cutoff) -- that explicit action wins until he closes it again.
function isPastConnectionCutoff(booking) {
  if (!booking.event_date) return false;
  const cutoff = new Date(`${booking.event_date}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() + 7);
  if (Date.now() < cutoff.getTime()) return false;
  if (booking.connected_to_pm_at && new Date(booking.connected_to_pm_at).getTime() >= cutoff.getTime()) return false;
  return true;
}

async function findLeadingEventMatch(text) {
  const candidates = await sbRequest(
    'GET',
    'bookings?status=neq.cancelled&event_name=not.is.null&select=id,event_name,client_contact_id,connected_to_pm_at,event_date'
  );
  // Longest event name first, so "Mad Party 2" is tried before "Mad Party".
  candidates.sort((a, b) => (b.event_name || '').length - (a.event_name || '').length);
  for (const booking of candidates) {
    const rest = stripLeadingEventName(text, booking.event_name);
    if (rest !== null) return { booking, rest };
  }
  return null;
}

const leadingMatch = !target && trimmed ? await findLeadingEventMatch(trimmed) : null;
if (leadingMatch) {
  const { booking } = leadingMatch;
  const suffix = leadingMatch.rest.trim().toLowerCase();

  // Per-event close/open -- separate from the bare "close" command below,
  // which only ever affects whichever single booking is currently live-
  // negotiating (mode='pm-led'). This one can disconnect or reconnect any
  // booking by name, regardless of its status or the negotiation lock.
  if (suffix === 'close') {
    if (!booking.connected_to_pm_at) {
      await sendWhatsApp(from_number, `${booking.event_name} isn't connected right now.`);
    } else {
      await sbPatch(`bookings?id=eq.${booking.id}`, { connected_to_pm_at: null });
      await sendWhatsApp(from_number, `Closed ${booking.event_name}. Back to automated.`);
    }
    return [{ json: { action: 'connected_closed', booking_id: booking.id } }];
  }
  if (suffix === 'open') {
    await sbPatch(`bookings?id=eq.${booking.id}`, { connected_to_pm_at: new Date().toISOString() });
    await sendWhatsApp(from_number, `Reopened ${booking.event_name}. I'll relay everything straight through until you say "${booking.event_name}: close".`);
    return [{ json: { action: 'connected_reopened', booking_id: booking.id } }];
  }

  if (leadingMatch.rest.trim()) {
    // A plain message to a not-yet-connected booking counts as the PM
    // engaging with it directly -- connect it as a side effect, same as
    // "open", so future client messages keep relaying to him too. Also
    // covers a booking that's simply aged past the 7-day cutoff (still
    // has an old connected_to_pm_at, so not "falsy") -- refresh it the same
    // way, and tell him it's back open, same as the explicit "open" command.
    if (!booking.connected_to_pm_at || isPastConnectionCutoff(booking)) {
      await sbPatch(`bookings?id=eq.${booking.id}`, { connected_to_pm_at: new Date().toISOString() });
      await sendWhatsApp(from_number, `Opened ${booking.event_name}. I'll relay everything straight through until you say "${booking.event_name}: close".`);
    }

    const client = (await sbRequest('GET', `contacts?id=eq.${booking.client_contact_id}&select=*`))[0];
    const replyBody = leadingMatch.rest;
    if (client?.phone_number) {
      await sendWhatsApp(client.phone_number, replyBody);
      await logConversation(booking.id, null, 'outbound', replyBody, 'planning_relay');
    }
    await logConversation(booking.id, contact_id, 'inbound', replyBody, 'pm_message');
    return [{ json: { action: 'planning_relayed_to_client', booking_id: booking.id } }];
  }
  // Matched just the event name with nothing meaningful after it (and it
  // wasn't "close"/"open") -- nothing useful to do, fall through to the
  // no-implicit-relay path below rather than connecting on an empty message.
}

// --- No implicit relay path. A message only ever reaches a client via the
// explicit "[event name]: message" syntax above -- never as a side effect of
// a booking merely being open/pm-led. There used to be a catch-all here that
// forwarded any plain reply verbatim whenever a booking was pm-led; removed
// entirely (owner's explicit call, zero tolerance for accidental leaks) --
// it already caused a real leak once (a plain "full time" answer to the
// bot's own staffing_type question reached the customer instead of being
// captured) and gating it on "is there a pending question" was judged not
// safe enough.
//
// Bigger picture, per the owner: Bali isn't just a sales bot with client
// relay as its default mode -- it's meant to grow into a full operational
// system the PM (and eventually other staff) talks to directly for many
// things beyond this one sales/onboarding workflow (messaging other staff,
// pulling reports, etc. -- not built yet). So the default for any PM message
// is "this is a request to me", full stop -- reaching a client is the one
// deliberate exception, gated behind an explicit prefix, never the fallback.
// Any plain-text reply from here on is checked ONLY against open pending
// questions / planning conversations below; if it's not explicitly prefixed
// and doesn't match one of those, it never leaves this chat with the PM.

// --- Is this an answer to a pending question, or a reply on an always-on
// planning conversation, identified by COUNT rather than a swipe-reply?
// (pending/planningCandidates/target/planningTarget/answerText were already
// declared above -- reply_to_message_id, if present, was already fully
// resolved there, so this only runs for plain-typed messages with nothing to
// swipe-reply to.) Treat both pools as one so a lone open item of either
// kind auto-matches, a numbered reply ("2: ...") picks a specific one out of
// several. Owner's call: multiple pending items with no swipe-reply/number
// used to force the PM to pick one before anything else could happen -- that
// got in the way of just answering him. Now it falls through to the normal
// fallback chat below instead, which tries to actually act on whatever he
// said (and can list what's pending if he genuinely asks, see its prompt) --
// bot serves the PM, not the other way around. --------------------------
if (!reply_to_message_id) {
  const totalCandidates = pending.length + planningCandidates.length;
  if (totalCandidates === 1) {
    if (pending.length === 1) target = pending[0];
    else planningTarget = planningCandidates[0];
  } else if (totalCandidates > 1) {
    const numberedMatch = trimmed.match(/^(\d+)[:.)]\s*([\s\S]+)$/);
    const idx = numberedMatch ? parseInt(numberedMatch[1], 10) - 1 : -1;
    if (idx >= 0 && idx < pending.length) {
      target = pending[idx];
      answerText = numberedMatch[2];
    } else if (idx >= pending.length && idx < totalCandidates) {
      planningTarget = planningCandidates[idx - pending.length];
      answerText = numberedMatch[2];
    }
    // No swipe-reply and no number given -- don't force a choice, fall
    // through to the fallback chat and let it actually address what he said.
  }
}

if (planningTarget) {
  const client = (await sbRequest('GET', `contacts?id=eq.${planningTarget.client_contact_id}&select=*`))[0];
  const relayText = stripAccidentalEventPrefix(answerText, planningTarget.event_name);
  if (client?.phone_number) {
    await sendWhatsApp(client.phone_number, relayText);
    await logConversation(planningTarget.id, null, 'outbound', relayText, 'planning_relay');
  }
  await logConversation(planningTarget.id, contact_id, 'inbound', answerText, 'pm_message');
  return [{ json: { action: 'planning_relayed_to_client', booking_id: planningTarget.id } }];
}

if (!target) {
  // A message with no event-name prefix is always to me directly, never to a
  // client -- see the header comment above. Owner's explicit call: no more
  // pre-classifying and picking between canned replies -- this is meant to
  // be an operational system, so just let the model actually answer the
  // question or help with the task, and be honest about what it can't do
  // yet, rather than routing through fixed template text.
  const pmLed = await findPmLedBooking();

  // Which booking this whole fallback exchange is actually about. Usually
  // whichever one is currently open -- but the PM confirming "close" (see
  // below) clears that, so a FOLLOW-UP confirmation ("yes i do" to a
  // "reopen it?" question) needs to still resolve to the same booking even
  // though it's no longer pmLed by then. Falls back to whichever booking
  // this fallback chat was most recently logged against.
  let subjectBooking = pmLed;
  if (!subjectBooking) {
    const lastChat = await sbRequest(
      'GET',
      `conversations?stage=eq.pm_fallback_chat&order=created_at.desc&limit=1&select=booking_id`
    );
    if (lastChat[0]) {
      subjectBooking = (await sbRequest('GET', `bookings?id=eq.${lastChat[0].booking_id}&select=*`))[0] || null;
    }
  }

  // Real bug, reported live: this fallback used to be a single stateless
  // completion with zero memory of its OWN previous turn -- so when the bot
  // itself asked a clarifying question ("...let me know if you need to
  // reopen it or make any changes") and the PM answered "yes i do", the next
  // call had no idea what "yes" was answering and produced a generic
  // non-response. Fixed by keeping a short rolling transcript of this
  // fallback chat, scoped to subjectBooking (there's nowhere schema-valid to
  // log it when no booking is in play at all, since conversations.booking_id
  // is NOT NULL -- that narrower case is unchanged).
  let recentTranscript = '';
  if (subjectBooking) {
    const recent = await sbRequest(
      'GET',
      `conversations?booking_id=eq.${subjectBooking.id}&stage=eq.pm_fallback_chat&order=created_at.desc&limit=6&select=direction,message_text`
    );
    if (recent.length > 0) {
      recentTranscript = recent
        .reverse()
        .map((m) => `${m.direction === 'inbound' ? 'PM' : 'Bali'}: ${m.message_text}`)
        .join('\n');
    }
  }

  // Owner's ask: once the PM actually confirms an action here (not just
  // discusses it), really do it -- don't just talk about it. Scoped to
  // close/reopen for now, the exact case reported live ("yes i do" to the
  // bot's own "need to reopen it?" question got a generic non-answer AND
  // never actually reopened anything). This is a judgment call, same class
  // as the natural-language rename feature -- NOT the deterministic
  // client-relay safety gate elsewhere in this file, so LLM discretion is an
  // acceptable trade: misjudging it only flips a connection flag on the
  // PM's own booking, it can never reach a client.
  if (subjectBooking) {
    const actionIntent = await openaiExtract(
      `The PM is chatting with Bali (an internal assistant) about their booking "${subjectBooking.event_name}". Decide if the PM's LATEST message is a clear, direct confirmation that they want to CLOSE this booking's connection (hand it back to automated handling) or REOPEN it. Only pick "close" or "open" if the PM is clearly asking for that specific action to happen right now -- a rejection ("no", "leave it as is") or an unrelated message is "none", even if the word "open" appears in it. Reply ONLY with JSON: {"action": "close"|"open"|"none"}.\n\nRecent conversation:\n${recentTranscript || '(none yet)'}`,
      text || ''
    );
    if (actionIntent?.action === 'close' || actionIntent?.action === 'open') {
      let confirmMsg;
      if (actionIntent.action === 'close') {
        confirmMsg = subjectBooking.connected_to_pm_at
          ? `Closed ${subjectBooking.event_name}. Back to automated.`
          : `${subjectBooking.event_name} isn't connected right now.`;
        if (subjectBooking.connected_to_pm_at) {
          await sbPatch(`bookings?id=eq.${subjectBooking.id}`, { connected_to_pm_at: null });
        }
      } else {
        await sbPatch(`bookings?id=eq.${subjectBooking.id}`, { connected_to_pm_at: new Date().toISOString() });
        confirmMsg = `Reopened ${subjectBooking.event_name}. I'll relay everything straight through until you say "${subjectBooking.event_name}: close".`;
      }
      await sendWhatsApp(from_number, confirmMsg);
      await logConversation(subjectBooking.id, contact_id, 'inbound', text || '', 'pm_fallback_chat');
      await logConversation(subjectBooking.id, null, 'outbound', confirmMsg, 'pm_fallback_chat');
      return [{ json: { action: `fallback_${actionIntent.action}d`, booking_id: subjectBooking.id } }];
    }

    // A plain-typed invoice correction (e.g. "make light 2.3m") only reaches
    // this generic fallback because nothing was open to auto-match it to --
    // typically the PM already confirmed or asked a question earlier, so the
    // pending_questions row that would normally catch this is already
    // resolved. Without this, the fallback below has no idea an invoice
    // exists and just tells the PM it can't help -- confirmed live. Route it
    // to the same correction logic stage3-4-action-code.js already uses,
    // via its webhook, instead of duplicating that extraction here.
    const latestInvoice = (await sbRequest(
      'GET',
      `invoices?booking_id=eq.${subjectBooking.id}&order=created_at.desc&limit=1&select=id,line_items,payment_terms`
    ))[0];
    if (latestInvoice) {
      const invoiceIntent = await openaiExtract(
        `The PM is chatting with Bali about their booking "${subjectBooking.event_name}", which has a draft invoice with these line items: ${JSON.stringify(latestInvoice.line_items)}. Decide if the PM's LATEST message is a direct request to change a SPECIFIC amount, item, or payment term on that invoice (e.g. "make light 2.3m", "remove screen", "actually 60/40 split") -- it must name or clearly imply what to change. A bare approval/confirmation word alone ("yes", "approved", "ok", "confirmed", "sounds good") is NOT a correction even if an invoice exists -- that's an approval with nothing left open to approve here, not a change request; is_correction must be false for those. Also false for a question, small talk, or anything already handled above. Reply ONLY with JSON: {"is_correction": true/false}.\n\nRecent conversation:\n${recentTranscript || '(none yet)'}`,
        text || ''
      );
      if (invoiceIntent?.is_correction) {
        await helpers.httpRequest({
          method: 'POST',
          url: `${env.N8N_BASE_URL}/webhook/stage3-4`,
          headers: { 'Content-Type': 'application/json' },
          body: { action: 'correct_invoice_from_fallback', booking_id: subjectBooking.id, answer_text: text },
          json: true,
          timeout: 15000,
        });
        await logConversation(subjectBooking.id, contact_id, 'inbound', text || '', 'pm_fallback_chat');
        return [{ json: { action: 'fallback_invoice_corrected', booking_id: subjectBooking.id } }];
      }
    }
  }

  const pendingSummary = [
    ...pending.map((p) => `${p.bookings?.event_name || 'an event'}: ${p.question_text}`),
    ...planningCandidates.map((b) => `${b.event_name}: ongoing conversation awaiting your reply`),
  ].join('\n');

  const reply = await askOpenAIText(
    `You are Bali, an event venue's own WhatsApp operational assistant. You're talking directly with venue staff (the PM) here, no client is on this thread, and nothing you say here is ever sent to a client. Your job is to actually get things done for him, run errands, take action, and answer questions, effectively, not make him work to get a straight answer. Answer his question or act on what he's asking using anything below that's relevant. If the recent back-and-forth below shows you just asked him something, treat his new message as answering that, not as a brand-new unrelated request.

What you can actually do today: manage one client negotiation at a time (open an event name, or close), generate invoices, correct a draft invoice's amounts, items, or terms even without swiping to reply to it, rename an event, and relay a message to a specific client only when a message starts with the event name followed by a colon. Reaching a client always requires that exact prefix, if he seems to want something sent to a client, say so and tell him to prefix it with the event name.

For anything else, messaging other staff, pulling reports, other operational tasks, you don't have that built yet. If asked for something like that, say plainly that you can't do it yet rather than pretending to. Keep your reply short, natural, and professional, no filler, no fake enthusiasm.

Pending items waiting on him right now (only mention or list these if he explicitly asks what's pending, what's outstanding, or similar, never bring them up on your own, and never let them stop you from just handling whatever he actually said this message): ${pendingSummary || 'none'}

${pmLed ? `Currently open with a client: ${pmLed.event_name}.` : 'Nothing currently open with a client.'}${recentTranscript ? `\n\nYour recent back-and-forth with the PM about this:\n${recentTranscript}` : ''}`,
    text || ''
  ) || "Sorry, I couldn't process that, try rephrasing?";
  await sendWhatsApp(from_number, reply);
  if (subjectBooking) {
    await logConversation(subjectBooking.id, contact_id, 'inbound', text || '', 'pm_fallback_chat');
    await logConversation(subjectBooking.id, null, 'outbound', reply, 'pm_fallback_chat');
  }
  return [{ json: { action: 'unclassified' } }];
}

// Resolve the matched pending question.
if (target.field_name === 'kb_escalation' || target.field_name === 'kb_save_confirm') {
  // Delegate to the KB workflow, which handles relaying the answer to the client
  // and the opt-in KB-save prompt (Section 8).
  const action = target.field_name === 'kb_escalation' ? 'resolve_escalation' : 'resolve_kb_save_confirm';
  await helpers.httpRequest({
    method: 'POST',
    url: `${env.N8N_BASE_URL}/webhook/kb-check`,
    headers: { 'Content-Type': 'application/json' },
    body: { action, pending_question_id: target.id, answer_text: answerText },
    json: true,
    timeout: 15000,
  });
  await sbPatch(`pending_questions?id=eq.${target.id}`, { resolved_at: new Date().toISOString() });
  return [{ json: { action: `${target.field_name}_resolved`, pending_question_id: target.id } }];
}

const STAGE3_4_DELEGATED_FIELDS = {
  invoice_draft_confirm: 'resolve_invoice_draft_confirm',
  invoice_approval: 'resolve_invoice_approval',
  contract_approval: 'resolve_contract_approval',
  payment_confirmed: 'resolve_payment_confirmed',
  payment_terms_confirm: 'resolve_payment_terms_confirm',
};
if (STAGE3_4_DELEGATED_FIELDS[target.field_name]) {
  // Fire-and-forget: the stage3-4 webhook responds immediately on receipt
  // (responseMode "onReceived"), before its actual handler even runs, so
  // there's no way to learn synchronously what it decided to do. Whether
  // this pending question is actually resolved is therefore the delegated
  // handler's own call, not made here -- e.g. resolveInvoiceDraftConfirm
  // deliberately leaves it open when the PM only asked a question, so the
  // same message is still swipe-repliable afterward. Marking it resolved
  // here unconditionally (the old behavior) silently closed it out even for
  // a mere question, breaking every plain-typed follow-up after -- confirmed
  // live.
  await helpers.httpRequest({
    method: 'POST',
    url: `${env.N8N_BASE_URL}/webhook/stage3-4`,
    headers: { 'Content-Type': 'application/json' },
    body: { action: STAGE3_4_DELEGATED_FIELDS[target.field_name], pending_question_id: target.id, answer_text: answerText },
    json: true,
    timeout: 15000,
  });
  return [{ json: { action: `${target.field_name}_delegated`, pending_question_id: target.id } }];
}

if (target.field_name === 'contract_confirmed') {
  const saysYes = /^(y(es)?|yeah|yep|yup|sure|ok(ay)?|approved?|agreed?|confirmed)\b/i.test(answerText.trim());
  if (saysYes) {
    // Release the negotiation lock (mode) along with the status flip -- once
    // signed, this booking moves to the always-on planning relay instead of
    // the single-slot "open"/"close" negotiation toggle, so the slot should
    // free up immediately rather than staying occupied until someone
    // remembers to "close" it.
    await sbPatch(`bookings?id=eq.${target.booking_id}`, { status: 'signed', mode: 'bot-led' });
    await sendWhatsApp(from_number, "Marked as signed. Fanning out to departments now.");
  } else {
    await sendWhatsApp(from_number, "Got it, not confirmed. Ask the client to resend a valid signed copy.");
  }
  await sbPatch(`pending_questions?id=eq.${target.id}`, { resolved_at: new Date().toISOString() });
  return [{ json: { action: 'contract_confirmation_resolved', signed: saysYes } }];
}

const prompt = FIELD_PROMPTS[target.field_name];
const extraction = prompt ? await openaiExtract(prompt, answerText || '') : { understood: true, value: answerText };

if (!extraction.understood) {
  await sendWhatsApp(from_number, `Sorry, I didn't catch that. ${target.question_text}`);
  return [{ json: { action: 're_ask', pending_question_id: target.id } }];
}

await sbPatch(`bookings?id=eq.${target.booking_id}`, { [target.field_name]: extraction.value });
await sbPatch(`pending_questions?id=eq.${target.id}`, { resolved_at: new Date().toISOString() });
await logConversation(target.booking_id, contact_id, 'inbound', answerText, 'pm_answer');

return [{ json: { action: 'field_resolved', booking_id: target.booking_id, field: target.field_name } }];

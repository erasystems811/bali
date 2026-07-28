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
    await sendWhatsApp(fromNumber, `Conversation so far for "${booking.event_name}":\n${transcript}`);
  }

  const openedLine = auto
    ? `Next up: "${booking.event_name}". I'll relay everything straight through until you type "close".`
    : `Opened "${booking.event_name}". I'll relay everything straight through until you type "close".`;
  const tipLines = [
    'Note:',
    `- Start replies with the event name, e.g. "${booking.event_name}: your message" -- helps me tell customers apart when more than one is texting at once.`,
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

// Matches a PM swipe-reply against the specific "forwarded to PM" message
// for a planning conversation (as opposed to the client-facing thread).
async function findPlanningBookingByForwardedMessageId(messageId) {
  if (!messageId) return null;
  const rows = await sbRequest(
    'GET',
    `conversations?whatsapp_message_id=eq.${encodeURIComponent(messageId)}&stage=eq.planning_relay_to_pm&select=booking_id&limit=1`
  );
  if (!rows[0]) return null;
  const booking = await sbRequest('GET', `bookings?id=eq.${rows[0].booking_id}&select=id,event_name,client_contact_id`);
  return booking[0] || null;
}

const input = $input.first().json.body;
const { from_number, text, reply_to_message_id, contact_id } = input;
const trimmed = (text || '').trim();

// --- Command: "invoice [event name]" -- manual trigger to draft the invoice --------
// Fuzzy on purpose -- the PM shouldn't have to remember an exact phrase.
// Matches "invoice X", "generate invoice for X", "please create an invoice
// for X", "send invoice to X", etc.
const invoiceMatch = trimmed.match(/^(?:please\s+)?(?:generate|create|make|send|draft)?\s*(?:an?\s+)?invoice(?:\s+(?:for|to))?\s+(.+)$/i);
if (invoiceMatch) {
  const eventName = invoiceMatch[1].trim();
  const matches = await sbRequest('GET', `bookings?event_name=ilike.*${encodeURIComponent(eventName)}*&status=neq.cancelled&select=*`);
  if (matches.length === 0) {
    await sendWhatsApp(from_number, `Couldn't find a booking called "${eventName}". Check the spelling?`);
    return [{ json: { action: 'invoice_command_not_found', query: eventName } }];
  }
  await helpers.httpRequest({
    method: 'POST',
    url: `${env.N8N_BASE_URL}/webhook/stage3-4`,
    headers: { 'Content-Type': 'application/json' },
    body: { action: 'draft_invoice', booking_id: matches[0].id },
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
    await sendWhatsApp(from_number, `You've still got "${alreadyOpen.event_name}" open. Type "close" first before opening another one.`);
    return [{ json: { action: 'open_blocked', open_booking: alreadyOpen.id } }];
  }
  const matches = await sbRequest('GET', `bookings?event_name=ilike.*${encodeURIComponent(eventName)}*&status=neq.cancelled&select=*`);
  if (matches.length === 0) {
    await sendWhatsApp(from_number, `Couldn't find a booking called "${eventName}". Check the spelling?`);
    return [{ json: { action: 'open_not_found', query: eventName } }];
  }
  const booking = matches[0];
  await openBookingForPm(booking, from_number);
  return [{ json: { action: 'opened', booking_id: booking.id } }];
}

// --- Command: "close" --------------------------------------------------------------
if (trimmed.toLowerCase() === 'close') {
  const open = await findPmLedBooking();
  if (!open) {
    await sendWhatsApp(from_number, "Nothing's open right now.");
    return [{ json: { action: 'close_noop' } }];
  }
  await sbPatch(`bookings?id=eq.${open.id}`, { mode: 'bot-led' });
  await sendWhatsApp(from_number, `Closed "${open.event_name}". Back to automated.`);

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

// --- Explicit "[event name]: message" -- always-on connected conversations -------
// This is how the PM addresses a specific booking directly and
// unambiguously, whether replying, messaging first, or running the
// per-event "close"/"open" commands below -- several bookings can be
// connected at once (invoiced, awaiting contract, signed, onboarded...), so
// there's no single implicit target the way there is during live
// negotiation. Matching is fuzzy (case, spacing, and punctuation all
// ignored) so the PM doesn't have to type the event name exactly -- see
// normalizeEventRef. Checked before everything else since it's explicit.
function normalizeEventRef(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const prefixMatch = trimmed.match(/^([^:]{2,60}):\s*([\s\S]+)$/);
if (prefixMatch) {
  const typedRef = normalizeEventRef(prefixMatch[1]);
  const candidates = typedRef
    ? await sbRequest('GET', 'bookings?status=neq.cancelled&event_name=not.is.null&select=id,event_name,client_contact_id,connected_to_pm_at')
    : [];
  const matches = candidates.filter((b) => {
    const ref = normalizeEventRef(b.event_name);
    return ref && (ref.includes(typedRef) || typedRef.includes(ref));
  });

  if (matches.length === 1) {
    const booking = matches[0];
    const suffix = prefixMatch[2].trim().toLowerCase();

    // Per-event close/open -- separate from the bare "close" command below,
    // which only ever affects whichever single booking is currently live-
    // negotiating (mode='pm-led'). This one can disconnect or reconnect any
    // booking by name, regardless of its status or the negotiation lock.
    if (suffix === 'close') {
      if (!booking.connected_to_pm_at) {
        await sendWhatsApp(from_number, `"${booking.event_name}" isn't connected right now.`);
      } else {
        await sbPatch(`bookings?id=eq.${booking.id}`, { connected_to_pm_at: null });
        await sendWhatsApp(from_number, `Closed "${booking.event_name}". Back to automated.`);
      }
      return [{ json: { action: 'connected_closed', booking_id: booking.id } }];
    }
    if (suffix === 'open') {
      await sbPatch(`bookings?id=eq.${booking.id}`, { connected_to_pm_at: new Date().toISOString() });
      await sendWhatsApp(from_number, `Reopened "${booking.event_name}". I'll relay everything straight through until you say "${booking.event_name}: close".`);
      return [{ json: { action: 'connected_reopened', booking_id: booking.id } }];
    }

    // A plain message to a not-yet-connected booking counts as the PM
    // engaging with it directly -- connect it as a side effect, same as
    // "open", so future client messages keep relaying to him too.
    if (!booking.connected_to_pm_at) {
      await sbPatch(`bookings?id=eq.${booking.id}`, { connected_to_pm_at: new Date().toISOString() });
    }

    const client = (await sbRequest('GET', `contacts?id=eq.${booking.client_contact_id}&select=*`))[0];
    const replyBody = prefixMatch[2];
    if (client?.phone_number) {
      await sendWhatsApp(client.phone_number, replyBody);
      await logConversation(booking.id, null, 'outbound', replyBody, 'planning_relay');
    }
    await logConversation(booking.id, contact_id, 'inbound', replyBody, 'pm_message');
    return [{ json: { action: 'planning_relayed_to_client', booking_id: booking.id } }];
  }
}

// --- Relay: a PM-led booking is open, forward verbatim to that client --------------
// Only when there's nothing else this reply could be answering -- `mode`
// stays 'pm-led' all the way through invoicing (only the explicit "close"
// command resets it), so the bot can still ask the PM a direct question
// (e.g. staffing_type right after invoicing) while a booking is open.
// Confirmed live: without this check, a plain "full time" answer to that
// question got blindly relayed straight to the customer instead of being
// captured, and a swipe-reply to a specific pending question would have hit
// the same bug. Skip the blind relay whenever this is an explicit reply to
// an earlier message, or this booking itself has something open waiting on
// the PM -- either way, fall through to the pending-question matching below.
const pmLed = await findPmLedBooking();
if (pmLed) {
  const ownPending = reply_to_message_id
    ? []
    : await sbRequest('GET', `pending_questions?booking_id=eq.${pmLed.id}&resolved_at=is.null&limit=1&select=id`);
  if (!reply_to_message_id && ownPending.length === 0) {
    const client = await sbRequest('GET', `contacts?id=eq.${pmLed.client_contact_id}&select=*`);
    const clientPhone = client[0]?.phone_number;
    if (clientPhone) {
      await sendWhatsApp(clientPhone, text || '');
    }
    await logConversation(pmLed.id, contact_id, 'inbound', text, 'pm_led_relay');
    await logConversation(pmLed.id, null, 'outbound', text, 'pm_led_relay');
    return [{ json: { action: 'relayed', booking_id: pmLed.id } }];
  }
}

// --- Otherwise: is this an answer to a pending question, or a reply on an
// always-on planning conversation? Treat both as one pool of "things needing
// the PM's attention" so a lone open item -- of either kind -- auto-matches,
// and only a genuine mix asks which one. -------------------------------------
const pending = await findOpenPendingQuestions();
const planningCandidates = await findAwaitingPlanningBookings();

let target = null; // a pending_questions row
let planningTarget = null; // a booking row (signed/onboarded, awaiting reply)
// The PM's actual reply text to act on -- normally the full message, but when
// disambiguating by number (e.g. "2: yes") it's just the part after "2:".
let answerText = text;

if (reply_to_message_id) {
  target = pending.find((p) => p.whatsapp_message_id === reply_to_message_id) || null;
  if (!target) {
    planningTarget = await findPlanningBookingByForwardedMessageId(reply_to_message_id);
  }
} else {
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

    if (!target && !planningTarget) {
      const items = [
        ...pending.map((p) => `"${p.bookings?.event_name || 'unknown event'}" -- ${p.question_text}`),
        ...planningCandidates.map((b) => `"${b.event_name}" -- ongoing conversation, awaiting your reply`),
      ];
      const list = items.map((line, i) => `${i + 1}. ${line}`).join('\n');
      await sendWhatsApp(
        from_number,
        `I've got a few things pending:\n${list}\n\nReply directly to the specific message (swipe to reply), start with the event name (e.g. "${planningCandidates[0]?.event_name || items[0] || 'Event'}: ..."), or just give me the number.`
      );
      return [{ json: { action: 'disambiguation_needed', pending_count: pending.length, planning_count: planningCandidates.length } }];
    }
  }
}

if (planningTarget) {
  const client = (await sbRequest('GET', `contacts?id=eq.${planningTarget.client_contact_id}&select=*`))[0];
  if (client?.phone_number) {
    await sendWhatsApp(client.phone_number, answerText);
    await logConversation(planningTarget.id, null, 'outbound', answerText, 'planning_relay');
  }
  await logConversation(planningTarget.id, contact_id, 'inbound', answerText, 'pm_message');
  return [{ json: { action: 'planning_relayed_to_client', booking_id: planningTarget.id } }];
}

if (!target) {
  await sendWhatsApp(
    from_number,
    'Not sure what that\'s for. Type "open [event name]" to take over a negotiation, start your message with the event name (e.g. "Amara\'s Wedding: ...") to reach a client directly, or let me know what you mean.'
  );
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
};
if (STAGE3_4_DELEGATED_FIELDS[target.field_name]) {
  await helpers.httpRequest({
    method: 'POST',
    url: `${env.N8N_BASE_URL}/webhook/stage3-4`,
    headers: { 'Content-Type': 'application/json' },
    body: { action: STAGE3_4_DELEGATED_FIELDS[target.field_name], pending_question_id: target.id, answer_text: answerText },
    json: true,
    timeout: 15000,
  });
  await sbPatch(`pending_questions?id=eq.${target.id}`, { resolved_at: new Date().toISOString() });
  return [{ json: { action: `${target.field_name}_resolved`, pending_question_id: target.id } }];
}

if (target.field_name === 'contract_confirmed') {
  const saysYes = /^y(es)?\b/i.test(answerText.trim());
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

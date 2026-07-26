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

async function sendWhatsApp(toNumber, text) {
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

async function findOpenPendingQuestions() {
  return sbRequest('GET', 'pending_questions?resolved_at=is.null&select=*,bookings(*)');
}

async function logConversation(bookingId, senderContactId, direction, text, stage) {
  await sbRequest('POST', 'conversations', [
    { booking_id: bookingId, sender_contact_id: senderContactId, direction, message_text: text, stage },
  ]);
}

const input = $input.first().json.body;
const { from_number, text, reply_to_message_id, contact_id } = input;
const trimmed = (text || '').trim();

// --- Command: "invoice [event name]" -- manual trigger to draft the invoice --------
const invoiceMatch = trimmed.match(/^invoice\s+(.+)$/i);
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
  await sbPatch(`bookings?id=eq.${booking.id}`, { mode: 'pm-led' });

  // The PM shouldn't have to go dig through Retool to see what the bot and
  // client already discussed before taking over.
  const history = await sbRequest('GET', `conversations?booking_id=eq.${booking.id}&order=created_at.asc&select=direction,message_text`);
  if (history.length > 0) {
    const transcript = history.map((m) => `${m.direction === 'inbound' ? 'Client' : 'Bali'}: ${m.message_text}`).join('\n');
    await sendWhatsApp(from_number, `Conversation so far for "${booking.event_name}":\n${transcript}`);
  }

  await sendWhatsApp(from_number, `Opened "${booking.event_name}". I'll relay everything straight through until you type "close".`);
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
  return [{ json: { action: 'closed', booking_id: open.id } }];
}

// --- Relay: a PM-led booking is open, forward verbatim to that client --------------
const pmLed = await findPmLedBooking();
if (pmLed) {
  const client = await sbRequest('GET', `contacts?id=eq.${pmLed.client_contact_id}&select=*`);
  const clientPhone = client[0]?.phone_number;
  if (clientPhone) {
    await sendWhatsApp(clientPhone, text || '');
  }
  await logConversation(pmLed.id, contact_id, 'inbound', text, 'pm_led_relay');
  await logConversation(pmLed.id, null, 'outbound', text, 'pm_led_relay');
  return [{ json: { action: 'relayed', booking_id: pmLed.id } }];
}

// --- Otherwise: is this an answer to a pending question? ---------------------------
const pending = await findOpenPendingQuestions();

let target = null;
// The PM's actual reply text to act on -- normally the full message, but when
// disambiguating by number (e.g. "2: yes") it's just the part after "2:".
let answerText = text;

if (reply_to_message_id) {
  target = pending.find((p) => p.whatsapp_message_id === reply_to_message_id) || null;
} else if (pending.length === 1) {
  target = pending[0];
} else if (pending.length > 1) {
  const numberedMatch = trimmed.match(/^(\d+)[:.)]\s*([\s\S]+)$/);
  const numbered = numberedMatch && pending[parseInt(numberedMatch[1], 10) - 1];
  if (numbered) {
    target = numbered;
    answerText = numberedMatch[2];
  }
}

if (!target && pending.length > 1) {
  const list = pending
    .map((p, i) => `${i + 1}. "${p.bookings?.event_name || 'unknown event'}" -- ${p.question_text}`)
    .join('\n');
  await sendWhatsApp(
    from_number,
    `I've got a few things pending:\n${list}\n\nReply directly to the specific message (swipe to reply), or just tell me the number and your answer, e.g. "2: yes".`
  );
  return [{ json: { action: 'disambiguation_needed', pending_count: pending.length } }];
}

if (!target) {
  await sendWhatsApp(from_number, "Not sure what that's for. Type \"open [event name]\" to take over a conversation, or let me know what you mean.");
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
    await sbPatch(`bookings?id=eq.${target.booking_id}`, { status: 'signed' });
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

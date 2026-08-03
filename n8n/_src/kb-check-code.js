const helpers = this.helpers;
const env = {
  SUPABASE_URL: $env.SUPABASE_URL,
  SUPABASE_KEY: $env.SUPABASE_SERVICE_KEY,
  OPENAI_KEY: $env.OPENAI_API_KEY,
  META_TOKEN: $env.META_ACCESS_TOKEN,
  META_PHONE_ID: $env.META_PHONE_NUMBER_ID,
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

async function sbInsert(path, body) {
  return sbRequest('POST', path, body, { Prefer: 'return=representation' });
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
// "bali_update" utility template instead of the send just failing.
//
// Owner's explicit correction (2026-08-03): this used to stuff the ENTIRE
// message text into the template's one body variable, mangling the owner's
// own intentional message formats. shortLabel is now a short description
// instead (an event name, or a generic fallback) -- the real content always
// follows as a genuine, unmodified send in sendWhatsApp below.
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
// Set right after `input` is parsed below, before this function is ever
// called -- see the fix note inside the function itself.
let CURRENT_INBOUND_SENDER = null;

async function isWithinMessagingWindow(toNumber) {
  // Same fix as stage1-code.js's version -- see that file for the full
  // explanation. Whoever just messaged us this exact execution is trivially
  // within-window right now regardless of what's in the DB yet, since their
  // inbound row for THIS message isn't logged until after the reply is sent.
  // from_number itself is block-scoped to the 'check' action branch below,
  // not visible here, hence the module-level CURRENT_INBOUND_SENDER instead.
  if (toNumber === CURRENT_INBOUND_SENDER) return true;
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
    headers: { Authorization: `Bearer ${env.META_TOKEN}`, 'Content-Type': 'application/json' },
    body: { messaging_product: 'whatsapp', to: toNumber, type: 'text', text: { body: text } },
    json: true,
    timeout: 20000,
  });
  return res?.messages?.[0]?.id || null;
}

// shortLabel: see sendWhatsAppTemplate above.
async function sendWhatsApp(toNumber, text, shortLabel) {
  if (SANDBOX) return sandboxLog(toNumber, text, 'text');
  if (!(await isWithinMessagingWindow(toNumber))) {
    await sendWhatsAppTemplate(toNumber, shortLabel || 'an update');
    // Known, accepted risk (owner's explicit call, 2026-08-03) -- see
    // stage1-code.js's version of this function for the full explanation.
    return sendRawText(toNumber, text).catch(() => null);
  }
  try {
    return await sendRawText(toNumber, text);
  } catch (err) {
    let errStr;
    try { errStr = JSON.stringify(err, Object.getOwnPropertyNames(err)); } catch (e) { errStr = String(err); }
    errStr += JSON.stringify(err?.response?.data || err?.response?.body || '');
    if (errStr.includes('131047')) {
      await sendWhatsAppTemplate(toNumber, shortLabel || 'an update');
      return sendRawText(toNumber, text).catch(() => null);
    }
    throw err;
  }
}

// See stage5-fanout-code.js's version for the full explanation -- owner's
// explicit, repeated rule is no "*" or "-" anywhere in this bot's messages,
// but nothing enforced that on LLM-generated free text (only ever applied
// to hand-written fixed strings). Hard backstop, not just a prompt ask.
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

async function askOpenAI(systemPrompt, userText) {
  const res = await helpers.httpRequest({
    method: 'POST',
    url: 'https://api.openai.com/v1/chat/completions',
    headers: { Authorization: `Bearer ${env.OPENAI_KEY}`, 'Content-Type': 'application/json' },
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
    return { found: false };
  }
}

async function findPm() {
  const rows = await sbRequest('GET', 'contacts?role=eq.pm&select=*&limit=1');
  return rows[0] || null;
}

async function logConversation(bookingId, senderContactId, direction, text, stage, whatsappMessageId) {
  await sbInsert('conversations', [
    { booking_id: bookingId, sender_contact_id: senderContactId, direction, message_text: text, stage, whatsapp_message_id: whatsappMessageId || null },
  ]);
}

const input = $input.first().json.body || $input.first().json;
const action = input.action || 'check';
CURRENT_INBOUND_SENDER = input.from_number || null;

if (action === 'check') {
  const { from_number, text, contact_id, booking_id } = input;

  const kb = await sbRequest('GET', 'knowledge_base?select=question,answer&order=last_updated.desc');
  const kbText = kb.map((row, i) => `${i + 1}. Q: ${row.question}\n   A: ${row.answer}`).join('\n') || '(knowledge base is empty)';

  const systemPrompt = `You are answering a WhatsApp question for an event venue called Bali, in a warm, brief, conversational tone (never sound like an AI or a company bot). Use ONLY the knowledge base below to answer -- do not make anything up. If the knowledge base doesn't cover the client's question, say so.\n\nKnowledge base:\n${kbText}\n\nReply ONLY with JSON: {"found": true/false, "answer": "..."} -- "answer" is the warm reply to send if found, or omitted/empty if not found.`;

  const result = await askOpenAI(systemPrompt, text || '');

  let booking = null;
  if (booking_id) {
    booking = (await sbRequest('GET', `bookings?id=eq.${booking_id}&select=*`))[0] || null;
  } else {
    const rows = await sbRequest('GET', `bookings?client_contact_id=eq.${contact_id}&status=neq.cancelled&order=created_at.desc&limit=1&select=*`);
    booking = rows[0] || null;
  }
  const bookingId = booking?.id || null;

  if (result.found && result.answer) {
    const answer = stripMarkdown(result.answer);
    await sendWhatsApp(from_number, answer);
    if (bookingId) await logConversation(bookingId, contact_id, 'outbound', answer, 'kb_answered');
    return [{ json: { action: 'kb_answered' } }];
  }

  // Not found in the knowledge base -- connect this booking to the PM (same
  // as him manually opening one) and relay the client's actual message
  // straight through, tracked the same durable way as any other connected
  // relay (see stage1-code.js) so a swipe-reply to it keeps working and every
  // future message from this client just flows through automatically from
  // here on. No more one-shot "reply to this exact message" escalation with
  // its own separate stall-tier/resolve/KB-save-prompt machinery -- once the
  // bot can't handle something itself, it hands off for real instead of
  // staging a ping-pong. See [[project_bali]]: "messages go directly now and
  // stay open" is the standing rule, not just for already-connected bookings.
  const pm = await findPm();
  if (!booking || !pm) {
    const fallbackText = "Let me check on that and get back to you.";
    await sendWhatsApp(from_number, fallbackText);
    if (bookingId) await logConversation(bookingId, contact_id, 'outbound', fallbackText, 'kb_not_found');
    return [{ json: { action: 'kb_not_found_no_target' } }];
  }

  if (!booking.connected_to_pm_at) {
    await sbPatch(`bookings?id=eq.${booking.id}`, { connected_to_pm_at: new Date().toISOString() });
  }

  const forwardText = `${booking.event_name || 'New inquiry'}: ${text}`;
  const msgId = await sendWhatsApp(pm.phone_number, forwardText, booking.event_name);
  await logConversation(bookingId, null, 'outbound', `[relayed to PM] ${text}`, 'connected_relay_to_pm', msgId);

  return [{ json: { action: 'kb_not_found_connected_and_relayed', booking_id: bookingId } }];
}

return [{ json: { action: 'unknown_action', received: action } }];

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

// Department fan-out and day-of checklists go to staff who may have never
// texted the bot at all -- these will very often land outside the 24h window
// (error 131047). Fall back to the approved "bali_notification" utility
// template (single body variable) instead of the send just failing.
async function sendWhatsAppTemplate(toNumber, text) {
  if (SANDBOX) return sandboxLog(toNumber, text, 'template');
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
    const res = await helpers.httpRequest({
      method: 'POST',
      url: `https://graph.facebook.com/v20.0/${env.META_PHONE_ID}/messages`,
      headers: { Authorization: `Bearer ${env.META_TOKEN}`, 'Content-Type': 'application/json' },
      body: { messaging_product: 'whatsapp', to: toNumber, type: 'text', text: { body: text } },
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

async function contactsByRole(role) {
  return sbRequest('GET', `contacts?role=eq.${role}&select=*`);
}

async function askOpenAI(systemPrompt, userText) {
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
  return res?.choices?.[0]?.message?.content || '';
}

async function askPmDirectly(bookingId, fieldName, questionText) {
  const pm = (await contactsByRole('pm'))[0];
  if (!pm) return;
  const pending = (await sbInsert('pending_questions', { booking_id: bookingId, field_name: fieldName, question_text: questionText }))[0];
  const msgId = await sendWhatsApp(pm.phone_number, questionText);
  if (msgId) await sbPatch(`pending_questions?id=eq.${pending.id}`, { whatsapp_message_id: msgId });
}

async function fanOutBooking(booking) {
  const dateStr = booking.event_date || 'TBD';

  // HR: event date, staff count/type
  const hr = await contactsByRole('hr');
  if (booking.staffing_type) {
    for (const c of hr) await sendWhatsApp(c.phone_number, `New event onboarded: ${booking.event_name} on ${dateStr}. Staffing: ${booking.staffing_type}.`);
  } else {
    await askPmDirectly(booking.id, 'staffing_type', `For ${booking.event_name} (${dateStr}), full-time or part-time staff needed?`);
  }

  // Procurement: current stock + stock needed. Recipe-based inventory (Section 7) isn't
  // built yet -- send the date only for now, flagged clearly so it isn't mistaken for a real brief.
  const procurement = await contactsByRole('procurement');
  for (const c of procurement) {
    await sendWhatsApp(c.phone_number, `New event onboarded: ${booking.event_name} on ${dateStr}. Stock requirements pending (inventory system not live yet).`);
  }

  // Accounts: the finalized invoice itself, not a placeholder -- it was
  // already generated back in Stage 3, re-rendered and sent fresh from the
  // same stored data the client's copy came from (stage3-4-action-code.js's
  // sendInvoiceToAccounts, same cross-workflow call pattern stage1-code.js
  // already uses for send_to_lawyer).
  const accounts = await contactsByRole('accounts');
  if (accounts.length > 0) {
    await helpers.httpRequest({
      method: 'POST',
      url: `${env.N8N_BASE_URL}/webhook/stage3-4`,
      headers: { 'Content-Type': 'application/json' },
      body: { action: 'send_invoice_to_accounts', booking_id: booking.id },
      json: true,
      timeout: 15000,
    });
  }

  // Event Assistant: general brief from the negotiation conversation, no revenue/payment info.
  const eventAssistant = await contactsByRole('event_assistant');
  if (eventAssistant.length > 0) {
    const convo = await sbRequest('GET', `conversations?booking_id=eq.${booking.id}&order=created_at.asc&select=direction,message_text`);
    const transcript = convo.map((m) => `${m.direction}: ${m.message_text}`).join('\n');
    const brief = await askOpenAI(
      'Summarize this WhatsApp conversation into a short event overview brief for the on-site Event Assistant. Do NOT include any prices, payment amounts, or revenue figures. Warm, brief, plain language.',
      transcript
    );
    for (const c of eventAssistant) await sendWhatsApp(c.phone_number, `Event brief for ${booking.event_name} (${dateStr}):\n${brief}`);
  }

  // Security: bouncer count + "vigilante" needs, collected from PM if missing.
  const security = await contactsByRole('security');
  if (booking.security_count !== null && booking.security_count !== undefined) {
    for (const c of security) {
      await sendWhatsApp(c.phone_number, `New event: ${booking.event_name} on ${dateStr}. Security needed: ${booking.security_count}.${booking.security_notes ? ' Notes: ' + booking.security_notes : ''}`);
    }
  } else {
    await askPmDirectly(booking.id, 'security_count', `For ${booking.event_name} (${dateStr}), how many security/bouncers are needed?`);
  }

  // All staff: event date announcement.
  const allStaff = await sbRequest('GET', "contacts?role=in.(staff,hr,procurement,accounts,event_assistant,security,supervisor,facility_manager)&select=*");
  for (const c of allStaff) await sendWhatsApp(c.phone_number, `Heads up, ${booking.event_name} is confirmed for ${dateStr}.`);
}

async function sendDayOfChecklist(booking) {
  const roles = ['supervisor', 'facility_manager'];
  for (const role of roles) {
    const people = await contactsByRole(role);
    for (const c of people) {
      await sendWhatsApp(c.phone_number, `Day-of checklist for ${booking.event_name}: please confirm event setup is complete and ready.`);
    }
  }
  await sbPatch(`bookings?id=eq.${booking.id}`, { day_of_checklist_sent_at: new Date().toISOString() });
}

// 1. Fan out newly-signed bookings, then mark them onboarded.
const signed = await sbRequest('GET', 'bookings?status=eq.signed&select=*');
for (const booking of signed) {
  await fanOutBooking(booking);
  await sbPatch(`bookings?id=eq.${booking.id}`, { status: 'onboarded' });
}

// 2. Day-of checklist for events happening today that haven't had one sent yet.
const today = new Date().toISOString().slice(0, 10);
const dueToday = await sbRequest('GET', `bookings?status=eq.onboarded&event_date=eq.${today}&day_of_checklist_sent_at=is.null&select=*`);
for (const booking of dueToday) {
  await sendDayOfChecklist(booking);
}

return [{ json: { fanned_out: signed.length, day_of_checklists_sent: dueToday.length } }];

// Stage 3/4 -- 24h lawyer nudge (Section 5, bullet 5). This is the Schedule
// Trigger half of the Stage 3/4 workflow; the Webhook half (draft invoice,
// approvals, lawyer draft handling) lives in stage3-4-action-code.js.

const helpers = this.helpers;
const env = {
  SUPABASE_URL: $env.SUPABASE_URL,
  SUPABASE_KEY: $env.SUPABASE_SERVICE_KEY,
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

// A daily scheduled nudge almost never lands inside the lawyer's 24h window --
// fall back to the approved "bali_update" utility template whenever the
// free-form send is rejected with error 131047.
//
// Owner's explicit correction (2026-08-03): this used to stuff the ENTIRE
// message text into the template's one body variable. shortLabel is now a
// short description instead (an event name, or a generic fallback) -- the
// real content always follows as a genuine, unmodified send in sendWhatsApp
// below.
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

const DAY_MS = 24 * 60 * 60 * 1000;

const lawyer = (await sbRequest('GET', 'contacts?role=eq.lawyer&select=*&limit=1'))[0];
if (!lawyer) {
  return [{ json: { skipped: true, reason: 'no lawyer contact configured yet' } }];
}

const waiting = await sbRequest('GET', 'bookings?status=eq.awaiting_contract&select=*');
let nudged = 0;

for (const booking of waiting) {
  const last = booking.last_lawyer_nudge_at ? new Date(booking.last_lawyer_nudge_at).getTime() : 0;
  if (Date.now() - last >= DAY_MS) {
    await sendWhatsApp(lawyer.phone_number, `Reminder: still waiting on the contract draft for ${booking.event_name} (event date ${booking.event_date || 'TBD'}).`, booking.event_name);
    await sbPatch(`bookings?id=eq.${booking.id}`, { last_lawyer_nudge_at: new Date().toISOString() });
    nudged += 1;
  }
}

return [{ json: { checked: waiting.length, nudged } }];

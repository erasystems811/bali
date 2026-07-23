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
  });
}

async function sbPatch(path, body) {
  return sbRequest('PATCH', path, body, { Prefer: 'return=representation' });
}

async function sendWhatsApp(toNumber, text) {
  return helpers.httpRequest({
    method: 'POST',
    url: `https://graph.facebook.com/v20.0/${env.META_PHONE_ID}/messages`,
    headers: { Authorization: `Bearer ${env.META_TOKEN}`, 'Content-Type': 'application/json' },
    body: { messaging_product: 'whatsapp', to: toNumber, type: 'text', text: { body: text } },
    json: true,
  });
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
    await sendWhatsApp(lawyer.phone_number, `Reminder: still waiting on the contract draft for "${booking.event_name}" (event date ${booking.event_date || 'TBD'}).`);
    await sbPatch(`bookings?id=eq.${booking.id}`, { last_lawyer_nudge_at: new Date().toISOString() });
    nudged += 1;
  }
}

return [{ json: { checked: waiting.length, nudged } }];

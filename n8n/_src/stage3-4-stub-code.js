// Stage 3 (Invoice) & Stage 4 (Contract) -- PARTIAL STUB.
// Blocked on real invoice/contract samples (spec Section 10) so the bot knows
// which fields to pull from the negotiation log. NOT built here:
//   - drafting the invoice from the negotiation log (paid items only)
//   - sending the invoice + collecting proof of payment
//   - bot sending event details to the lawyer to kick off a contract draft
//   - lawyer draft -> PM approval -> send to client
// Ready-to-go once those exist: signature detection + PM confirmation is
// already implemented in 02-stage1-sales-flow.json (booking.status ===
// 'sent_to_client' branch) and 03-pm-toggle.json ('contract_confirmed').
//
// What IS built here: the 24h lawyer nudge (Section 5, bullet 5) -- it's a
// standalone, self-contained rule ("nudge every 24h while awaiting_contract")
// that doesn't depend on the missing samples, so it's live now and will just
// start firing once bookings actually reach awaiting_contract.

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

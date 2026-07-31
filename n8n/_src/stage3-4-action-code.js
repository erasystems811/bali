// Stage 3 (Invoice) & Stage 4 (Contract) -- real implementation.
// Single webhook handles several actions (discriminated by input.action),
// mirroring the pattern used by 04-kb-check.json.

const helpers = this.helpers;
const env = {
  SUPABASE_URL: $env.SUPABASE_URL,
  SUPABASE_KEY: $env.SUPABASE_SERVICE_KEY,
  OPENAI_KEY: $env.OPENAI_API_KEY,
  META_TOKEN: $env.META_ACCESS_TOKEN,
  META_PHONE_ID: $env.META_PHONE_NUMBER_ID,
  GOTENBERG_URL: $env.GOTENBERG_URL,
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
async function sbInsert(path, body) { return sbRequest('POST', path, body, { Prefer: 'return=representation' }); }
async function sbPatch(path, body) { return sbRequest('PATCH', path, body, { Prefer: 'return=representation' }); }

// Sandbox mode: on when there's no real Meta token configured (the sandbox
// n8n instance is deliberately deployed without one, so it's structurally
// incapable of reaching real WhatsApp, not just told not to). Every outbound
// send is captured in `sandbox_outbound` instead, for the test webpage to
// display, and a fake message id/media id stands in for the real one. PDF
// rendering (Gotenberg) still runs for real in sandbox -- it's self-hosted,
// nothing leaves the server -- only the Meta upload/send steps are stubbed.
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

async function sendWhatsAppDocument(toNumber, mediaId, filename, caption) {
  if (SANDBOX) return sandboxLog(toNumber, `[document] ${filename}${caption ? ': ' + caption : ''}`, 'document');
  const res = await helpers.httpRequest({
    method: 'POST',
    url: `https://graph.facebook.com/v20.0/${env.META_PHONE_ID}/messages`,
    headers: { Authorization: `Bearer ${env.META_TOKEN}`, 'Content-Type': 'application/json' },
    body: {
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'document',
      document: { id: mediaId, filename, caption },
    },
    json: true,
    timeout: 20000,
  });
  return res?.messages?.[0]?.id || null;
}

// Renders invoice HTML (styled to match the real BALI-2026-003 template) to a
// PDF Buffer. Goes through a small internal sub-workflow (Webhook -> Code
// [prepareBinaryData] -> HTTP Request -> Respond to Webhook) instead of
// calling Gotenberg directly from this Code node -- confirmed live that this
// n8n version's Code-node `helpers.httpRequest` cannot correctly send
// multipart/form-data (every construction attempt either sent 0 bytes,
// mangled the buffer into something ~100x larger than intended, or got the
// Content-Type/boundary wrong -- verified via Gotenberg's own server logs,
// not guesswork). The dedicated HTTP Request node has mature native
// multipart/binary support and is confirmed working. See the "Render PDF"
// node chain in this workflow (Webhook path `bali-render-pdf`).
async function renderPdf(html) {
  return helpers.httpRequest({
    method: 'POST',
    url: `${env.N8N_BASE_URL}/webhook/bali-render-pdf`,
    body: { html },
    json: true,
    encoding: 'arraybuffer',
    timeout: 30000,
  });
}

// Uploads a PDF buffer to Meta's media library so it can be attached to a
// WhatsApp document message. Returns the media id. Same reason as renderPdf:
// goes through a dedicated HTTP Request node sub-workflow (Webhook ->
// prepareBinaryData -> HTTP Request -> Respond) instead of a direct
// helpers.httpRequest formData call, which is confirmed broken in this
// n8n version for multipart uploads.
async function uploadWhatsAppMedia(pdfBuffer, filename) {
  if (SANDBOX) return `sandbox-media-${filename}`;
  const buf = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
  const res = await helpers.httpRequest({
    method: 'POST',
    url: `${env.N8N_BASE_URL}/webhook/bali-upload-media`,
    body: { pdfBase64: buf.toString('base64'), filename },
    json: true,
    timeout: 30000,
  });
  return res?.id || null;
}

async function askOpenAIJson(systemPrompt, userText, temperature) {
  const res = await helpers.httpRequest({
    method: 'POST',
    url: 'https://api.openai.com/v1/chat/completions',
    headers: { Authorization: `Bearer ${env.OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: {
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      ...(temperature !== undefined ? { temperature } : {}),
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

async function findPm() { return (await sbRequest('GET', 'contacts?role=eq.pm&select=*&limit=1'))[0] || null; }
async function findLawyer() { return (await sbRequest('GET', 'contacts?role=eq.lawyer&select=*&limit=1'))[0] || null; }
async function getBooking(id) { return (await sbRequest('GET', `bookings?id=eq.${id}&select=*`))[0] || null; }
async function getContact(id) { return (await sbRequest('GET', `contacts?id=eq.${id}&select=*`))[0] || null; }

async function logConversation(bookingId, senderContactId, direction, text, stage) {
  await sbInsert('conversations', [{ booking_id: bookingId, sender_contact_id: senderContactId, direction, message_text: text, stage }]);
}

async function askPmDirectly(bookingId, fieldName, questionText) {
  const pm = await findPm();
  if (!pm) return null;
  const pending = (await sbInsert('pending_questions', { booking_id: bookingId, field_name: fieldName, question_text: questionText }))[0];
  const msgId = await sendWhatsApp(pm.phone_number, questionText);
  if (msgId) await sbPatch(`pending_questions?id=eq.${pending.id}`, { whatsapp_message_id: msgId });
  return pending;
}

function formatMoney(n) {
  return 'N' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDatePdf(d) {
  return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Styled to match the real BALI-2026-003 reference invoice: gold wordmark top
// left, dark table header, red WHT deduction, twin payment-info/terms boxes.
function formatInvoiceHtml(inv, booking) {
  const rows = (inv.line_items || []).map((li) => `
    <tr>
      <td class="desc">${escapeHtml(li.description)}</td>
      <td class="amt">${formatMoney(li.amount)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1F2937; margin: 0; padding: 40px 48px; font-size: 13px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; }
  .logo { font-size: 22px; font-weight: bold; color: #1F2937; letter-spacing: 1px; }
  .logo span { color: #C9973E; }
  .company { color: #6B7280; font-size: 11px; margin-top: 4px; }
  .doc-title { text-align: right; }
  .doc-title h1 { margin: 0; font-size: 30px; letter-spacing: 2px; color: #1F2937; }
  .doc-title .meta { color: #374151; font-size: 12px; margin-top: 6px; }
  .bill-to { background: #F3F4F6; padding: 14px 18px; margin: 28px 0 18px; }
  .bill-to .label { font-size: 10px; letter-spacing: 1px; color: #6B7280; font-weight: bold; }
  .bill-to .name { font-weight: bold; font-size: 14px; margin-top: 2px; }
  .bill-to .loc { color: #6B7280; }
  .project { margin: 0 0 18px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  thead th { background: #28374B; color: #fff; text-align: left; font-size: 10px; letter-spacing: 1px; padding: 10px 12px; }
  thead th.amt { text-align: right; }
  td { padding: 10px 12px; border-bottom: 1px solid #E5E7EB; }
  td.amt { text-align: right; white-space: nowrap; }
  .totals { width: 100%; margin-top: 14px; }
  .totals td { border: none; padding: 4px 12px; }
  .totals .label { text-align: right; color: #374151; }
  .totals .val { text-align: right; font-weight: bold; white-space: nowrap; width: 140px; }
  .totals .wht .val { color: #DC2626; }
  .totals .total td { border-top: 1px solid #1F2937; padding-top: 8px; font-size: 15px; }
  .boxes { display: flex; gap: 16px; margin-top: 28px; }
  .box { flex: 1; background: #F9FAFB; border: 1px solid #E5E7EB; padding: 14px 18px; }
  .box .label { font-size: 10px; letter-spacing: 1px; color: #6B7280; font-weight: bold; border-bottom: 1px solid #E5E7EB; padding-bottom: 6px; margin-bottom: 8px; }
  .box p { margin: 3px 0; }
  .footer { text-align: center; color: #9CA3AF; font-size: 10px; margin-top: 32px; }
</style></head>
<body>
  <div class="header">
    <div>
      <div class="logo"><img src="data:image/png;base64,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" alt="Bali" /></div>
      <div class="company">BALI RECREATION CENTER LIMITED</div>
    </div>
    <div class="doc-title">
      <h1>INVOICE</h1>
      <div class="meta"><strong>Invoice #:</strong> #${escapeHtml(inv.invoice_number)}<br><strong>Date Issued:</strong> ${formatDatePdf(inv.date_issued)}</div>
    </div>
  </div>

  <div class="bill-to">
    <div class="label">BILL TO</div>
    <div class="name">${escapeHtml(inv.bill_to_name || '[to confirm]')}</div>
    <div class="loc">${escapeHtml(inv.bill_to_location || '')}</div>
  </div>

  <p class="project"><strong>Project:</strong> ${escapeHtml(booking.event_name)}</p>

  <table>
    <thead><tr><th>DESCRIPTION</th><th class="amt">AMOUNT</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <table class="totals">
    <tr><td class="label">Subtotal:</td><td class="val">${formatMoney(inv.subtotal)}</td></tr>
    <tr><td class="label">VAT (7.5%):</td><td class="val">+${formatMoney(inv.vat_amount)}</td></tr>
    <tr class="wht"><td class="label">WHT Deduction (2%):</td><td class="val">-${formatMoney(inv.wht_amount)}</td></tr>
    <tr class="total"><td class="label">Total Net Payable Due:</td><td class="val">${formatMoney(inv.total_net_payable)}</td></tr>
  </table>

  <div class="boxes">
    <div class="box">
      <div class="label">PAYMENT INFORMATION</div>
      <p><strong>Bank:</strong> Moniepoint MFB</p>
      <p><strong>Account Name:</strong> BALI RECREATION CENTER LIMITED</p>
      <p><strong>Account Number:</strong> 5129398200</p>
      <p><strong>Reference:</strong> ${escapeHtml(inv.invoice_number)}</p>
    </div>
    <div class="box">
      <div class="label">PAYMENT TERMS</div>
      <p><strong>${escapeHtml(inv.payment_terms || 'Full Payment Due')}:</strong> ${formatMoney(inv.total_net_payable)}</p>
    </div>
  </div>

  <div class="footer">BALI RECREATION CENTER LIMITED &bull; Abuja, Nigeria &bull; info@baliexperience.com</div>
</body></html>`;
}

// Renders the invoice to a styled PDF, uploads it to WhatsApp, and sends it
// as a document message. Returns the outbound WhatsApp message id.
async function sendInvoicePdf(toNumber, invoice, booking, caption) {
  const html = formatInvoiceHtml(invoice, booking);
  const pdf = await renderPdf(html);
  const mediaId = await uploadWhatsAppMedia(pdf, `${invoice.invoice_number}.pdf`);
  if (!mediaId) return null;
  return sendWhatsAppDocument(toNumber, mediaId, `${invoice.invoice_number}.pdf`, caption);
}

async function nextInvoiceNumber() {
  const year = new Date().getFullYear();
  const existing = await sbRequest('GET', `invoices?invoice_number=like.BALI-${year}-*&select=invoice_number`);
  const seq = existing.length + 1;
  return `BALI-${year}-${String(seq).padStart(3, '0')}`;
}

// Plain-text summary of the extracted line items/terms, sent to the PM
// BEFORE any PDF is generated -- owner's call: confirm the underlying
// numbers are right first, don't waste a PDF render on a misread.
function formatInvoiceDraftText(invoice, booking) {
  const lines = [
    `Draft invoice details for ${booking.event_name}, please confirm this is accurate before I generate the PDF`,
    ...invoice.line_items.map((li) => `- ${li.description}: ${formatMoney(li.amount)}`),
    `- Payment terms: ${invoice.payment_terms || 'not specified'}`,
    `- Bill to: ${invoice.bill_to_name ? invoice.bill_to_name + (invoice.bill_to_location ? `, ${invoice.bill_to_location}` : '') : 'not specified'}`,
    '',
    'Reply yes if this is accurate, or tell me what to add or change.',
  ];
  return lines.join('\n');
}

// Extracts a corrected {line_items, payment_terms, bill_to_name,
// bill_to_location} from the PM's free-text correction against the
// invoice's current values -- shared by both the pre-PDF draft-confirm
// loop and the post-PDF approval loop.
async function extractInvoiceCorrection(invoice, answerText) {
  return askOpenAIJson(
    `Here is a draft invoice's current line items and payment terms as JSON: ${JSON.stringify({ line_items: invoice.line_items, payment_terms: invoice.payment_terms, bill_to_name: invoice.bill_to_name, bill_to_location: invoice.bill_to_location })}\n\nThe PM has requested this correction: "${answerText}"\n\nAmounts are in Nigerian Naira -- shorthand like "6m" means 6,000,000 and "500k" means 500,000, convert to a plain number. If the correction names a SPECIFIC existing line item with a new amount (e.g. "sound is 2.7m now"), update just that item's amount and leave every other line item exactly as it was -- don't touch or merge unrelated lines. If the correction states a genuinely new collective price for multiple items that don't already have their own separate line items, use exactly ONE line item listing all those items with that one amount -- never repeat the same amount across several line items. If the correction is a bare lump number with no item named, and it matches the sum of the current line items (or the current line items minus one being dropped), keep the remaining items on their own separate lines at their existing amounts rather than merging them into one line -- a lump number alone is not by itself a request to combine already-separate line items. Reply ONLY with the corrected JSON in the exact same shape: {"line_items": [{"description": "...", "amount": <number>}], "payment_terms": "...", "bill_to_name": "...", "bill_to_location": "..."}.`,
    answerText,
    0
  );
}

function recomputeInvoiceTotals(lineItems) {
  const subtotal = lineItems.reduce((s, li) => s + Number(li.amount || 0), 0);
  const vat = subtotal * 0.075;
  const wht = subtotal * 0.02;
  const total = subtotal + vat - wht;
  return { subtotal, vat, wht, total };
}

// Phase 2: generates the actual PDF from the now-confirmed invoice and
// sends it to the PM for final visual approval before it goes to the client.
async function sendInvoiceForFinalApproval(invoice, booking) {
  const pm = await findPm();
  const caption = `Invoice ${invoice.invoice_number} for ${booking.event_name}, reply to THIS message with any corrections, or reply yes to approve and send to the client.`;
  const pending = (await sbInsert('pending_questions', { booking_id: booking.id, field_name: 'invoice_approval', question_text: caption }))[0];
  if (pm) {
    const msgId = await sendInvoicePdf(pm.phone_number, invoice, booking, caption);
    if (msgId) await sbPatch(`pending_questions?id=eq.${pending.id}`, { whatsapp_message_id: msgId });
  }
}

// Some stages log the same relayed message twice (once as the PM/client's
// own line, once as the verbatim copy delivered to the other side) -- a
// naive inbound=Client/outbound=Bali mapping over the raw table would
// misattribute the PM's own words to the client and duplicate every line.
// Confirmed live: this is exactly why invoice extraction failed on a real
// booking -- the PM's own "6m" and item list came through unattributed and
// doubled, and the model gave up rather than guess who said what.
const RELAY_ECHO_STAGES = new Set(['connected_relay_to_pm', 'planning_relay']);
function speakerFor(row) {
  if (RELAY_ECHO_STAGES.has(row.stage) || (row.stage === 'pm_led_relay' && row.direction === 'outbound')) {
    return null; // redundant client-facing copy of a message already captured under its PM/Bali line
  }
  if (row.direction === 'inbound') {
    return row.stage === 'pm_message' || row.stage === 'pm_led_relay' ? 'PM' : 'Client';
  }
  return 'Bali';
}

async function buildNegotiationTranscript(bookingId) {
  const convo = await sbRequest('GET', `conversations?booking_id=eq.${bookingId}&order=created_at.asc&select=direction,message_text,stage`);
  return convo
    .map((m) => ({ speaker: speakerFor(m), text: m.message_text }))
    .filter((m) => m.speaker)
    .map((m) => `${m.speaker}: ${m.text}`)
    .join('\n');
}

async function draftInvoice(bookingId, pmDetails) {
  const booking = await getBooking(bookingId);
  // pmDetails lets the PM hand the bot agreed items/price directly (e.g. the
  // "invoice [event]: 2m for sound, screen and staff" command) with no real
  // negotiation conversation on record -- appended as one more "PM:" line so
  // the exact same extraction logic below (collective-vs-itemized, final-
  // agreed-state) handles it, on top of whatever's actually in the history.
  const history = await buildNegotiationTranscript(bookingId);
  const transcript = pmDetails ? `${history}${history ? '\n' : ''}PM: ${pmDetails}` : history;

  const extraction = await askOpenAIJson(
    `Extract invoice details from this WhatsApp negotiation transcript for an event venue called Bali. "PM" is the venue's own negotiator -- treat PM lines as authoritative for what was agreed, alongside anything the Client said.

A negotiation is not a shopping list -- items and prices get proposed, countered, dropped, and changed as the conversation goes on. Only extract what was FINALLY agreed, not everything that was ever mentioned. If an item was discussed but later removed, replaced, or never confirmed, leave it out. If a price for an item changed partway through, use the LATEST stated figure, not an earlier offer. Read the whole conversation in order and settle on its end state before extracting -- don't just collect every item/number that appears anywhere in it.

Typical items for this venue: stage, sound, screen, power (sometimes called "light" or "electricity"), staff, security (sometimes "vigilante"), vendors/vendor management, ticketing, internet, payment system, technical support, police. Not every client wants every item -- only include items that ended up actually agreed for this specific booking, however they're phrased (comma-separated, listed plainly, spread across separate messages, casual wording).

Two pricing patterns to watch for:
1. ITEMIZED -- each item has its own stated amount: extract one line item per item with its own amount.
2. COLLECTIVE -- a single overall price is agreed for a set of items that were NEVER given individual amounts anywhere in the conversation: output exactly ONE line item whose description lists all the agreed items (comma-separated) and whose amount is that collective price. Never invent a per-item split that was never stated.

If the transcript mixes both patterns (some items individually priced, the rest priced as one group), represent that mix faithfully: one line item per individually-priced item, plus one combined line item for whatever was priced together.

Two different things can look similar but must be told apart:
- A later message naming a SPECIFIC item with a new amount (e.g. "sound is 4m" then later "sound for 2.7m") is a price correction for that one item -- the latest stated amount for that item wins, replacing its earlier price, but it stays its own line item.
- A later bare lump number with no item names attached, coming after items were already individually priced, is usually just confirming (or re-totaling after one item got dropped) that same itemized breakdown -- NOT a brand new collective quote. Check whether it matches the sum of the still-included items' last individual prices; if so, keep each item as its own line at its last individually-stated amount, don't collapse them into one combined line.

Worked example -- a lump confirmation after dropping an item, NOT a new collective price:
PM: sound is 2m, light 2m, screen 2m
Client: actually I don't need sound
PM: okay then 4m
-> 4m is confirming the two remaining already-itemized items (light 2m + screen 2m = 4m). Correct output: TWO line items, {"description": "light", "amount": 2000000} and {"description": "screen", "amount": 2000000}. WRONG: one line item "light, screen": 4000000 -- that discards real itemization that was already established.

Worked example of a genuine COLLECTIVE case (items never individually priced):
PM: 6m
PM: Sound, screen, power, staff, ticketing
-> This is ONE collective price for FIVE items that were never given individual amounts. Correct output has exactly ONE line item: {"description": "Sound, screen, power, staff, ticketing", "amount": 6000000}. WRONG: five line items each at 6000000 (that inflates the real total 5x -- never repeat one stated price across multiple line items).

Amounts are in Nigerian Naira. Shorthand like "6m" means 6,000,000 and "500k" means 500,000 -- convert to a plain number, no currency symbols or commas. Only include PAID items (things the client is actually being charged for).

payment_terms must be null unless the transcript explicitly states one -- if it does, phrase it the way it was actually agreed (things like "100% Full Payment Due" or "60/40 split" are just illustrations of the KIND of value this field holds, not something to output when nothing was actually said).

Reply ONLY with JSON: {"line_items": [{"description": "...", "amount": <number>}], "payment_terms": "<string exactly as agreed in the transcript, or null if not discussed>", "bill_to_name": "<the client's real name or organization ONLY if actually stated somewhere in the transcript, else null (never a generic placeholder like the word \"Client\") -- the invoice defaults to billing the event name itself when this is null, so leave it null rather than guessing>", "bill_to_location": "<client city/location if mentioned, else null>"}.`,
    transcript,
    0
  );
  if (!extraction || !Array.isArray(extraction.line_items) || extraction.line_items.length === 0) {
    const pm = await findPm();
    if (pm) await sendWhatsApp(pm.phone_number, `Couldn't figure out the invoice line items for ${booking.event_name} from the conversation, can you send me the agreed items and amounts directly?`);
    return { ok: false, reason: 'extraction_failed' };
  }

  if (!extraction.payment_terms) {
    // Don't send an invoice with payment terms missing -- ask the PM
    // directly instead. His answer gets appended to the transcript and this
    // whole function re-runs (see resolvePaymentTermsConfirm below), so
    // however he describes it -- a percentage split, amount parts, "full
    // payment", whatever phrasing -- goes through the exact same flexible
    // extraction above that already handles items and prices, not a
    // separate rigid parser bolted on just for this.
    await askPmDirectly(bookingId, 'payment_terms_confirm', `For ${booking.event_name}, is payment full or in parts? If in parts, let me know the split.`);
    return { ok: true, action: 'awaiting_payment_terms' };
  }

  const { subtotal, vat, wht, total } = recomputeInvoiceTotals(extraction.line_items);
  const invoiceNumber = await nextInvoiceNumber();

  const invoice = (await sbInsert('invoices', {
    booking_id: bookingId,
    invoice_number: invoiceNumber,
    // Owner's call: bill to the event name by default -- unless the PM
    // explicitly gave a different name/org, which extraction would have
    // picked up above.
    bill_to_name: extraction.bill_to_name || booking.event_name || null,
    bill_to_location: extraction.bill_to_location || null,
    line_items: extraction.line_items,
    payment_terms: extraction.payment_terms || null,
    subtotal,
    vat_amount: vat,
    wht_amount: wht,
    total_net_payable: total,
    status: 'pending_pm_approval',
  }))[0];

  // Phase 1: confirm the underlying numbers as plain text before spending a
  // PDF render on them -- see formatInvoiceDraftText.
  const pm = await findPm();
  const draftText = formatInvoiceDraftText(invoice, booking);
  const pending = (await sbInsert('pending_questions', { booking_id: bookingId, field_name: 'invoice_draft_confirm', question_text: draftText }))[0];
  if (pm) {
    const msgId = await sendWhatsApp(pm.phone_number, draftText);
    if (msgId) await sbPatch(`pending_questions?id=eq.${pending.id}`, { whatsapp_message_id: msgId });
  }

  // Safety net for the manual "invoice [event]" command, which can trigger
  // this without the booking ever having gone through openBookingForPm --
  // connected_to_pm_at (see schema.sql) needs to be set regardless, or the
  // client's subsequent messages would fall through to the pre-connection
  // automated flow instead of staying connected to the PM.
  await sbPatch(`bookings?id=eq.${bookingId}`, { status: 'invoiced', connected_to_pm_at: booking.connected_to_pm_at || new Date().toISOString() });

  if (booking.staffing_type === null || booking.staffing_type === undefined) {
    await askPmDirectly(bookingId, 'staffing_type', `For ${booking.event_name}, full-time or part-time staff needed?`);
  }

  return { ok: true, invoice_id: invoice.id };
}

// Phase 1 resolution: PM confirming/correcting the plain-text draft, before
// any PDF exists yet.
async function resolveInvoiceDraftConfirm(pendingId, answerText) {
  const pq = (await sbRequest('GET', `pending_questions?id=eq.${pendingId}&select=*`))[0];
  const booking = await getBooking(pq.booking_id);
  const invoice = (await sbRequest('GET', `invoices?booking_id=eq.${pq.booking_id}&order=created_at.desc&limit=1&select=*`))[0];

  if (/^(y(es)?|yeah|yep|yup|sure|ok(ay)?|approved?|agreed?|confirmed)\b/i.test((answerText || '').trim())) {
    await sbPatch(`pending_questions?id=eq.${pendingId}`, { resolved_at: new Date().toISOString() });
    await sendInvoiceForFinalApproval(invoice, booking);
    return { ok: true, action: 'invoice_draft_confirmed_pdf_sent' };
  }

  // A genuine question about the draft (not a correction or a confirmation)
  // gets answered directly instead of being forced through the correction
  // extraction below, which has nothing to actually change and would just
  // silently resend the exact same draft with no acknowledgment of what was
  // asked. Deliberately does NOT resolve pendingId -- it's still
  // swipe-repliable for a real "yes" or correction afterward. (Whoever calls
  // this function must not resolve it either, or a plain-typed follow-up has
  // nothing left to auto-match against -- confirmed live.)
  const questionCheck = await askOpenAIJson(
    `The PM is reviewing this draft invoice for "${booking.event_name}": ${JSON.stringify({ line_items: invoice.line_items, payment_terms: invoice.payment_terms, subtotal: invoice.subtotal, vat_amount: invoice.vat_amount, wht_amount: invoice.wht_amount, total_net_payable: invoice.total_net_payable })}. VAT is a fixed 7.5% and WHT is a fixed 2% deduction, always. He just replied: "${answerText}". Is this a genuine question about the invoice (asking what/why/how about something on it) rather than a "yes"/confirmation or a request to change an amount/item/term? If it's a question, answer it briefly and accurately using only the numbers/terms above and the fixed VAT/WHT rates -- never invent a reason or number not shown here. Reply ONLY with JSON: {"is_question": true/false, "answer": "..." or null}.`,
    answerText || ''
  );
  if (questionCheck?.is_question && questionCheck.answer) {
    const pm = await findPm();
    if (pm) await sendWhatsApp(pm.phone_number, questionCheck.answer);
    return { ok: true, action: 'invoice_question_answered' };
  }

  await sbPatch(`pending_questions?id=eq.${pendingId}`, { resolved_at: new Date().toISOString() });
  return applyInvoiceCorrectionAndResend(booking, invoice, answerText);
}

// Shared by resolveInvoiceDraftConfirm (a swipe-reply/auto-matched correction
// to an open pending_questions row) and correctInvoiceFromFallbackChat (a
// plain-typed correction with nothing open to match, routed here instead of
// the PM fallback chat declining it) -- same extraction, same resend, just
// two different ways of arriving at "the PM wants this invoice changed."
async function applyInvoiceCorrectionAndResend(booking, invoice, answerText) {
  const extraction = await extractInvoiceCorrection(invoice, answerText);
  if (!extraction) {
    const pm = await findPm();
    if (pm) await sendWhatsApp(pm.phone_number, "Didn't catch that correction, can you say it again?");
    return { ok: false };
  }

  const { subtotal, vat, wht, total } = recomputeInvoiceTotals(extraction.line_items);
  const updated = (await sbPatch(`invoices?id=eq.${invoice.id}`, {
    line_items: extraction.line_items,
    payment_terms: extraction.payment_terms || invoice.payment_terms,
    bill_to_name: extraction.bill_to_name || invoice.bill_to_name,
    bill_to_location: extraction.bill_to_location || invoice.bill_to_location,
    subtotal,
    vat_amount: vat,
    wht_amount: wht,
    total_net_payable: total,
  }))[0];

  const pm = await findPm();
  const draftText = formatInvoiceDraftText(updated, booking);
  const pending = (await sbInsert('pending_questions', { booking_id: booking.id, field_name: 'invoice_draft_confirm', question_text: draftText }))[0];
  if (pm) {
    const msgId = await sendWhatsApp(pm.phone_number, draftText);
    if (msgId) await sbPatch(`pending_questions?id=eq.${pending.id}`, { whatsapp_message_id: msgId });
  }
  return { ok: true, action: 'invoice_draft_corrected' };
}

// Resolves the "is payment full or in parts?" question draftInvoice asks
// when the negotiation transcript never settled it. The PM's answer is
// simply appended to the transcript and the whole extraction re-runs --
// same reasoning as pmDetails above -- so a percentage split, amount parts,
// or "full payment" all get understood the same flexible way, and the
// invoice actually gets drafted this time instead of asking again.
async function resolvePaymentTermsConfirm(pendingId, answerText) {
  const pq = (await sbRequest('GET', `pending_questions?id=eq.${pendingId}&select=*`))[0];
  await sbPatch(`pending_questions?id=eq.${pendingId}`, { resolved_at: new Date().toISOString() });
  return draftInvoice(pq.booking_id, answerText);
}

// Entry point for the PM fallback chat (pm-toggle-code.js) when a plain-typed
// message names an invoice change but nothing is currently open to
// swipe-reply/auto-match to -- e.g. the PM already confirmed or asked a
// question earlier, so the pending_questions row that would normally catch
// this is already resolved. Looks up the booking's latest invoice directly
// instead of requiring a specific pending_question_id.
async function correctInvoiceFromFallbackChat(bookingId, answerText) {
  const booking = await getBooking(bookingId);
  const invoice = (await sbRequest('GET', `invoices?booking_id=eq.${bookingId}&order=created_at.desc&limit=1&select=*`))[0];
  if (!invoice) return { ok: false, reason: 'no_invoice' };
  return applyInvoiceCorrectionAndResend(booking, invoice, answerText);
}

// Phase 2 resolution: PM approving/correcting the actual PDF.
async function resolveInvoiceApproval(pendingId, answerText) {
  const pq = (await sbRequest('GET', `pending_questions?id=eq.${pendingId}&select=*`))[0];
  const booking = await getBooking(pq.booking_id);
  const invoice = (await sbRequest('GET', `invoices?booking_id=eq.${pq.booking_id}&order=created_at.desc&limit=1&select=*`))[0];
  // Every path below is a real resolution (approve or correct) -- unlike
  // resolveInvoiceDraftConfirm, this one has no "just answer a question,
  // leave it open" branch, so it's safe to resolve up front.
  await sbPatch(`pending_questions?id=eq.${pendingId}`, { resolved_at: new Date().toISOString() });

  if (/^(y(es)?|yeah|yep|yup|sure|ok(ay)?|approved?|agreed?|confirmed)\b/i.test((answerText || '').trim())) {
    await sbPatch(`invoices?id=eq.${invoice.id}`, { status: 'sent_to_client' });
    const client = await getContact(booking.client_contact_id);
    const caption = `Here's your invoice for ${booking.event_name}.`;
    await sendInvoicePdf(client.phone_number, invoice, booking, caption);
    await sendWhatsApp(client.phone_number, "Whenever you're ready, please send proof of payment and we'll get it confirmed.");
    await logConversation(booking.id, null, 'outbound', `[invoice PDF sent] ${invoice.invoice_number}`, 'invoice_sent');
    return { ok: true, action: 'invoice_sent_to_client' };
  }

  const extraction = await extractInvoiceCorrection(invoice, answerText);
  if (!extraction) {
    const pm = await findPm();
    if (pm) await sendWhatsApp(pm.phone_number, "Didn't catch that correction, can you say it again?");
    return { ok: false };
  }

  const { subtotal, vat, wht, total } = recomputeInvoiceTotals(extraction.line_items);
  const updated = (await sbPatch(`invoices?id=eq.${invoice.id}`, {
    line_items: extraction.line_items,
    payment_terms: extraction.payment_terms || invoice.payment_terms,
    bill_to_name: extraction.bill_to_name || invoice.bill_to_name,
    bill_to_location: extraction.bill_to_location || invoice.bill_to_location,
    subtotal,
    vat_amount: vat,
    wht_amount: wht,
    total_net_payable: total,
  }))[0];

  await sendInvoiceForFinalApproval(updated, booking);
  return { ok: true, action: 'invoice_corrected' };
}

async function resolvePaymentConfirmed(pendingId, answerText) {
  const pq = (await sbRequest('GET', `pending_questions?id=eq.${pendingId}&select=*`))[0];
  const booking = await getBooking(pq.booking_id);
  const invoice = (await sbRequest('GET', `invoices?booking_id=eq.${pq.booking_id}&order=created_at.desc&limit=1&select=*`))[0];
  await sbPatch(`pending_questions?id=eq.${pendingId}`, { resolved_at: new Date().toISOString() });

  if (!/^(y(es)?|yeah|yep|yup|sure|ok(ay)?|approved?|agreed?|confirmed)\b/i.test((answerText || '').trim())) {
    const client = await getContact(booking.client_contact_id);
    await sendWhatsApp(client.phone_number, "We couldn't confirm that payment yet, could you resend proof of payment?");
    return { ok: true, action: 'payment_not_confirmed' };
  }

  await sbPatch(`invoices?id=eq.${invoice.id}`, { status: 'paid' });
  await sbPatch(`bookings?id=eq.${booking.id}`, { status: 'awaiting_contract' });
  await sbInsert('contracts', { booking_id: booking.id, total_fee: invoice.total_net_payable, payment_terms: invoice.payment_terms });

  const client = await getContact(booking.client_contact_id);
  await sendWhatsApp(client.phone_number, "Payment confirmed, thank you! Last thing before we get the contract moving, what's your organization's full legal name?");
  return { ok: true, action: 'moved_to_awaiting_contract' };
}

async function sendToLawyer(bookingId) {
  const booking = await getBooking(bookingId);
  const contract = (await sbRequest('GET', `contracts?booking_id=eq.${bookingId}&order=created_at.desc&limit=1&select=*`))[0];
  const lawyer = await findLawyer();
  if (!lawyer) return { ok: false, reason: 'no_lawyer_contact' };

  const text = `New contract needed:\nOrganizer: ${contract.organizer_legal_name}, ${contract.organizer_registered_address}\nEvent: ${booking.event_name}, ${booking.event_date}\nType: ${booking.event_type}\nFee: ${formatMoney(contract.total_fee)}\nPayment: ${contract.payment_terms}`;
  await sendWhatsApp(lawyer.phone_number, text);
  await sbPatch(`contracts?id=eq.${contract.id}`, { sent_to_lawyer_at: new Date().toISOString() });
  return { ok: true };
}

async function handleLawyerInbound(input) {
  const { media_id, media_type, text, from_number } = input;
  const waiting = await sbRequest('GET', 'contracts?draft_received_at=is.null&sent_to_lawyer_at=not.is.null&select=*,bookings(*)&order=sent_to_lawyer_at.desc&limit=1');
  const contract = waiting[0];

  if (contract && media_type === 'document') {
    await sbPatch(`contracts?id=eq.${contract.id}`, { draft_media_id: media_id, draft_received_at: new Date().toISOString() });
    await sbPatch(`bookings?id=eq.${contract.booking_id}`, { status: 'contract_drafted' });

    const booking = contract.bookings;
    const pm = await findPm();
    const questionText = `Contract draft in for ${booking.event_name}, review and reply yes to approve and send to the client, or reply with changes for the lawyer.`;
    const pending = (await sbInsert('pending_questions', { booking_id: contract.booking_id, field_name: 'contract_approval', question_text: questionText }))[0];
    if (pm) {
      const msgId = await sendWhatsAppDocument(pm.phone_number, media_id, `${booking.event_name} - Contract Draft.pdf`, questionText);
      if (msgId) await sbPatch(`pending_questions?id=eq.${pending.id}`, { whatsapp_message_id: msgId });
    }
    return { ok: true, action: 'contract_draft_forwarded_to_pm' };
  }

  // A plain-text message from the lawyer (a question, most likely) -- this
  // used to just get logged with zero reply, confirmed live. Try to answer
  // it directly from whatever's already known about the contract they're
  // actively working on; anything not confidently answerable from that gets
  // forwarded to the PM instead of silently dropped, tracked the same way
  // client relays are (swipe-reply goes straight back to the lawyer).
  if (!text) return { ok: true, action: 'lawyer_message_logged' };

  const active = (await sbRequest(
    'GET',
    'contracts?sent_to_lawyer_at=not.is.null&select=*,bookings(*)&order=sent_to_lawyer_at.desc&limit=1'
  ))[0];
  if (!active) return { ok: true, action: 'lawyer_message_logged' };

  const booking = active.bookings;
  const knownDetails = {
    organizer_name: active.organizer_legal_name,
    organizer_address: active.organizer_registered_address,
    event_name: booking.event_name,
    event_date: booking.event_date ? formatDatePdf(booking.event_date) : null,
    event_type: booking.event_type,
    total_fee: active.total_fee ? formatMoney(active.total_fee) : null,
    payment_terms: active.payment_terms,
  };
  const answerCheck = await askOpenAIJson(
    `You're Bali, an event venue's assistant. The venue's lawyer is asking about a contract with these known details: ${JSON.stringify(knownDetails)}. They just asked: "${text}".

Say can_answer:true ONLY if the question is directly asking to be told the value of one of these known fields (organizer name, organizer address, event name/date/type, total fee, or payment terms) -- e.g. "what's the fee", "is payment full or split", "what's the organizer's address" are all can_answer:true, restating the relevant known value.

Say can_answer:false for anything that asks the venue/bot to make a legal judgment, decide on a policy, add or approve a contract clause or term, or state a rule/policy not literally one of the known fields above (deposits, cancellation policy, liability, force majeure, and similar are all can_answer:false) -- these need an actual person's decision, not a lookup. When genuinely unsure, false.

Reply ONLY with JSON: {"can_answer": true/false, "answer": "..." or null}.`,
    text
  );
  if (answerCheck?.can_answer && answerCheck.answer) {
    await sendWhatsApp(from_number, answerCheck.answer);
    return { ok: true, action: 'lawyer_question_answered' };
  }

  const pm = await findPm();
  if (pm) {
    const msgId = await sendWhatsApp(pm.phone_number, `lawyer: ${text}`);
    // Logged to conversations (not pending_questions) specifically so
    // swipe-replying to THIS message works every time, not just once --
    // pm-toggle-code.js's findLawyerRelayBookingIdByForwardedMessageId
    // matches against this same stage/whatsapp_message_id pair, mirroring
    // how the client-relay swipe-reply already works indefinitely rather
    // than a one-shot pending_questions row (confirmed live: the second
    // reply to the same forwarded question fell through to the generic
    // fallback chat instead of ever reaching the lawyer).
    await sbInsert('conversations', [{ booking_id: booking.id, sender_contact_id: null, direction: 'outbound', message_text: `lawyer: ${text}`, stage: 'lawyer_question_relay', whatsapp_message_id: msgId }]);
  }
  return { ok: true, action: 'lawyer_question_forwarded_to_pm' };
}

async function resolveContractApproval(pendingId, answerText) {
  const pq = (await sbRequest('GET', `pending_questions?id=eq.${pendingId}&select=*`))[0];
  const booking = await getBooking(pq.booking_id);
  const contract = (await sbRequest('GET', `contracts?booking_id=eq.${pq.booking_id}&order=created_at.desc&limit=1&select=*`))[0];
  await sbPatch(`pending_questions?id=eq.${pendingId}`, { resolved_at: new Date().toISOString() });

  if (/^(y(es)?|yeah|yep|yup|sure|ok(ay)?|approved?|agreed?|confirmed)\b/i.test((answerText || '').trim())) {
    await sbPatch(`bookings?id=eq.${booking.id}`, { status: 'sent_to_client' });
    await sbPatch(`contracts?id=eq.${contract.id}`, { approved_by_pm_at: new Date().toISOString(), sent_to_client_at: new Date().toISOString() });
    const client = await getContact(booking.client_contact_id);
    await sendWhatsAppDocument(
      client.phone_number,
      contract.draft_media_id,
      `${booking.event_name} - Contract.pdf`,
      `Here's your contract for ${booking.event_name}, please review, sign, and send it back as a PDF.`
    );
    return { ok: true, action: 'contract_sent_to_client' };
  }

  const lawyer = await findLawyer();
  if (lawyer) await sendWhatsApp(lawyer.phone_number, `PM requested a change on the ${booking.event_name} contract: "${answerText}"`);
  return { ok: true, action: 'change_relayed_to_lawyer' };
}

const input = $input.first().json.body || $input.first().json;
const action = input.action;

let result;
if (action === 'draft_invoice') result = await draftInvoice(input.booking_id, input.pm_details);
else if (action === 'resolve_invoice_draft_confirm') result = await resolveInvoiceDraftConfirm(input.pending_question_id, input.answer_text);
else if (action === 'correct_invoice_from_fallback') result = await correctInvoiceFromFallbackChat(input.booking_id, input.answer_text);
else if (action === 'resolve_payment_terms_confirm') result = await resolvePaymentTermsConfirm(input.pending_question_id, input.answer_text);
else if (action === 'resolve_invoice_approval') result = await resolveInvoiceApproval(input.pending_question_id, input.answer_text);
else if (action === 'resolve_payment_confirmed') result = await resolvePaymentConfirmed(input.pending_question_id, input.answer_text);
else if (action === 'send_to_lawyer') result = await sendToLawyer(input.booking_id);
else if (action === 'resolve_contract_approval') result = await resolveContractApproval(input.pending_question_id, input.answer_text);
else result = await handleLawyerInbound(input);

return [{ json: result }];

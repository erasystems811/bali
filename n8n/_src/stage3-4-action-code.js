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
  try {
    await sbRequest('POST', 'sandbox_outbound', { to_number: toNumber, kind: kind || 'text', message_text: text });
  } catch (e) {}
  return `sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
      <div class="logo"><span>&#9679;</span> BALI</div>
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
    `Draft invoice details for "${booking.event_name}" -- please confirm this is accurate before I generate the PDF:`,
    ...invoice.line_items.map((li) => `- ${li.description}: ${formatMoney(li.amount)}`),
    `- Payment terms: ${invoice.payment_terms || '(not specified)'}`,
    `- Bill to: ${invoice.bill_to_name ? invoice.bill_to_name + (invoice.bill_to_location ? `, ${invoice.bill_to_location}` : '') : '(not specified)'}`,
    '',
    'Reply "yes" if this is accurate, or tell me what to add or change.',
  ];
  return lines.join('\n');
}

// Extracts a corrected {line_items, payment_terms, bill_to_name,
// bill_to_location} from the PM's free-text correction against the
// invoice's current values -- shared by both the pre-PDF draft-confirm
// loop and the post-PDF approval loop.
async function extractInvoiceCorrection(invoice, answerText) {
  return askOpenAIJson(
    `Here is a draft invoice's current line items and payment terms as JSON: ${JSON.stringify({ line_items: invoice.line_items, payment_terms: invoice.payment_terms, bill_to_name: invoice.bill_to_name, bill_to_location: invoice.bill_to_location })}\n\nThe PM has requested this correction: "${answerText}"\n\nAmounts are in Nigerian Naira -- shorthand like "6m" means 6,000,000 and "500k" means 500,000, convert to a plain number. If the correction states one collective price for multiple items, use exactly ONE line item listing all those items with that one amount -- never repeat the same amount across several line items. Reply ONLY with the corrected JSON in the exact same shape: {"line_items": [{"description": "...", "amount": <number>}], "payment_terms": "...", "bill_to_name": "...", "bill_to_location": "..."}.`,
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
  const caption = `Invoice ${invoice.invoice_number} for "${booking.event_name}" -- reply to THIS message with any corrections, or reply "yes" to approve and send to the client.`;
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
2. COLLECTIVE -- a single overall price is agreed for a set of items with no per-item breakdown (e.g. a list of items in one message and one lump amount in another): output exactly ONE line item whose description lists all the agreed items (comma-separated) and whose amount is that collective price. Never invent a per-item split that was never stated.

If the transcript mixes both patterns (some items individually priced, the rest priced as one group), represent that mix faithfully: one line item per individually-priced item, plus one combined line item for whatever was priced together.

Worked example of the COLLECTIVE case -- get this exactly right:
PM: 6m
PM: Sound, screen, power, staff, ticketing
-> This is ONE collective price for FIVE items. Correct output has exactly ONE line item: {"description": "Sound, screen, power, staff, ticketing", "amount": 6000000}. WRONG: five line items each at 6000000 (that inflates the real total 5x -- never repeat one stated price across multiple line items).

Amounts are in Nigerian Naira. Shorthand like "6m" means 6,000,000 and "500k" means 500,000 -- convert to a plain number, no currency symbols or commas. Only include PAID items (things the client is actually being charged for).

payment_terms must be null unless the transcript explicitly states one -- if it does, phrase it the way it was actually agreed (things like "100% Full Payment Due" or "60/40 split" are just illustrations of the KIND of value this field holds, not something to output when nothing was actually said).

Reply ONLY with JSON: {"line_items": [{"description": "...", "amount": <number>}], "payment_terms": "<string exactly as agreed in the transcript, or null if not discussed>", "bill_to_name": "<the client's real name or organization ONLY if actually stated somewhere in the transcript, else null (never a generic placeholder like the word \"Client\") -- the invoice defaults to billing the event name itself when this is null, so leave it null rather than guessing>", "bill_to_location": "<client city/location if mentioned, else null>"}.`,
    transcript,
    0
  );
  if (!extraction || !Array.isArray(extraction.line_items) || extraction.line_items.length === 0) {
    const pm = await findPm();
    if (pm) await sendWhatsApp(pm.phone_number, `Couldn't figure out the invoice line items for "${booking.event_name}" from the conversation -- can you send me the agreed items and amounts directly?`);
    return { ok: false, reason: 'extraction_failed' };
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
    await askPmDirectly(bookingId, 'staffing_type', `For "${booking.event_name}" -- full-time or part-time staff needed?`);
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
    await sendInvoiceForFinalApproval(invoice, booking);
    return { ok: true, action: 'invoice_draft_confirmed_pdf_sent' };
  }

  const extraction = await extractInvoiceCorrection(invoice, answerText);
  if (!extraction) {
    const pm = await findPm();
    if (pm) await sendWhatsApp(pm.phone_number, "Didn't catch that correction -- can you say it again?");
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

// Phase 2 resolution: PM approving/correcting the actual PDF.
async function resolveInvoiceApproval(pendingId, answerText) {
  const pq = (await sbRequest('GET', `pending_questions?id=eq.${pendingId}&select=*`))[0];
  const booking = await getBooking(pq.booking_id);
  const invoice = (await sbRequest('GET', `invoices?booking_id=eq.${pq.booking_id}&order=created_at.desc&limit=1&select=*`))[0];

  if (/^(y(es)?|yeah|yep|yup|sure|ok(ay)?|approved?|agreed?|confirmed)\b/i.test((answerText || '').trim())) {
    await sbPatch(`invoices?id=eq.${invoice.id}`, { status: 'sent_to_client' });
    const client = await getContact(booking.client_contact_id);
    const caption = `Here's your invoice for "${booking.event_name}".`;
    await sendInvoicePdf(client.phone_number, invoice, booking, caption);
    await sendWhatsApp(client.phone_number, "Whenever you're ready, please send proof of payment and we'll get it confirmed.");
    await logConversation(booking.id, null, 'outbound', `[invoice PDF sent] ${invoice.invoice_number}`, 'invoice_sent');
    return { ok: true, action: 'invoice_sent_to_client' };
  }

  const extraction = await extractInvoiceCorrection(invoice, answerText);
  if (!extraction) {
    const pm = await findPm();
    if (pm) await sendWhatsApp(pm.phone_number, "Didn't catch that correction -- can you say it again?");
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

  if (!/^(y(es)?|yeah|yep|yup|sure|ok(ay)?|approved?|agreed?|confirmed)\b/i.test((answerText || '').trim())) {
    const client = await getContact(booking.client_contact_id);
    await sendWhatsApp(client.phone_number, "We couldn't confirm that payment yet -- could you resend proof of payment?");
    return { ok: true, action: 'payment_not_confirmed' };
  }

  await sbPatch(`invoices?id=eq.${invoice.id}`, { status: 'paid' });
  await sbPatch(`bookings?id=eq.${booking.id}`, { status: 'awaiting_contract' });
  await sbInsert('contracts', { booking_id: booking.id, total_fee: invoice.total_net_payable, payment_terms: invoice.payment_terms });

  const client = await getContact(booking.client_contact_id);
  await sendWhatsApp(client.phone_number, "Payment confirmed, thank you! Last thing before we get the contract moving -- could you send your organization's full legal name and its official registered address?");
  return { ok: true, action: 'moved_to_awaiting_contract' };
}

async function sendToLawyer(bookingId) {
  const booking = await getBooking(bookingId);
  const contract = (await sbRequest('GET', `contracts?booking_id=eq.${bookingId}&order=created_at.desc&limit=1&select=*`))[0];
  const lawyer = await findLawyer();
  if (!lawyer) return { ok: false, reason: 'no_lawyer_contact' };

  const text = `New contract needed:\nOrganizer -- ${contract.organizer_legal_name}, ${contract.organizer_registered_address}\nEvent -- ${booking.event_name}, ${booking.event_date}\nType -- ${booking.event_type}\nFee -- ${formatMoney(contract.total_fee)}\nPayment -- ${contract.payment_terms}`;
  await sendWhatsApp(lawyer.phone_number, text);
  await sbPatch(`contracts?id=eq.${contract.id}`, { sent_to_lawyer_at: new Date().toISOString() });
  return { ok: true };
}

async function handleLawyerInbound(input) {
  const { media_id, media_type } = input;
  const waiting = await sbRequest('GET', 'contracts?draft_received_at=is.null&sent_to_lawyer_at=not.is.null&select=*,bookings(*)&order=sent_to_lawyer_at.desc&limit=1');
  const contract = waiting[0];

  if (!contract || media_type !== 'document') {
    return { ok: true, action: 'lawyer_message_logged' };
  }

  await sbPatch(`contracts?id=eq.${contract.id}`, { draft_media_id: media_id, draft_received_at: new Date().toISOString() });
  await sbPatch(`bookings?id=eq.${contract.booking_id}`, { status: 'contract_drafted' });

  const booking = contract.bookings;
  const pm = await findPm();
  const questionText = `Contract draft in for "${booking.event_name}" -- review and reply "yes" to approve and send to the client, or reply with changes for the lawyer.`;
  const pending = (await sbInsert('pending_questions', { booking_id: contract.booking_id, field_name: 'contract_approval', question_text: questionText }))[0];
  if (pm) {
    const msgId = await sendWhatsAppDocument(pm.phone_number, media_id, `${booking.event_name} - Contract Draft.pdf`, questionText);
    if (msgId) await sbPatch(`pending_questions?id=eq.${pending.id}`, { whatsapp_message_id: msgId });
  }
  return { ok: true, action: 'contract_draft_forwarded_to_pm' };
}

async function resolveContractApproval(pendingId, answerText) {
  const pq = (await sbRequest('GET', `pending_questions?id=eq.${pendingId}&select=*`))[0];
  const booking = await getBooking(pq.booking_id);
  const contract = (await sbRequest('GET', `contracts?booking_id=eq.${pq.booking_id}&order=created_at.desc&limit=1&select=*`))[0];

  if (/^(y(es)?|yeah|yep|yup|sure|ok(ay)?|approved?|agreed?|confirmed)\b/i.test((answerText || '').trim())) {
    await sbPatch(`bookings?id=eq.${booking.id}`, { status: 'sent_to_client' });
    await sbPatch(`contracts?id=eq.${contract.id}`, { approved_by_pm_at: new Date().toISOString(), sent_to_client_at: new Date().toISOString() });
    const client = await getContact(booking.client_contact_id);
    await sendWhatsAppDocument(
      client.phone_number,
      contract.draft_media_id,
      `${booking.event_name} - Contract.pdf`,
      `Here's your contract for "${booking.event_name}" -- please review, sign, and send it back as a PDF.`
    );
    return { ok: true, action: 'contract_sent_to_client' };
  }

  const lawyer = await findLawyer();
  if (lawyer) await sendWhatsApp(lawyer.phone_number, `PM requested a change on the "${booking.event_name}" contract: "${answerText}"`);
  return { ok: true, action: 'change_relayed_to_lawyer' };
}

const input = $input.first().json.body || $input.first().json;
const action = input.action;

let result;
if (action === 'draft_invoice') result = await draftInvoice(input.booking_id, input.pm_details);
else if (action === 'resolve_invoice_draft_confirm') result = await resolveInvoiceDraftConfirm(input.pending_question_id, input.answer_text);
else if (action === 'resolve_invoice_approval') result = await resolveInvoiceApproval(input.pending_question_id, input.answer_text);
else if (action === 'resolve_payment_confirmed') result = await resolvePaymentConfirmed(input.pending_question_id, input.answer_text);
else if (action === 'send_to_lawyer') result = await sendToLawyer(input.booking_id);
else if (action === 'resolve_contract_approval') result = await resolveContractApproval(input.pending_question_id, input.answer_text);
else result = await handleLawyerInbound(input);

return [{ json: result }];

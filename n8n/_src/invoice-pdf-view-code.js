// Regenerates an invoice's PDF on demand from its stored data and returns it
// directly -- no PDF bytes are persisted anywhere (the WhatsApp-sent copy is
// gone once sent), so this is the only way to view a past invoice as a PDF
// (e.g. from the Retool dashboard). GET /webhook/invoice-pdf?invoice_number=...

const helpers = this.helpers;
const env = {
  SUPABASE_URL: $env.SUPABASE_URL,
  SUPABASE_KEY: $env.SUPABASE_SERVICE_KEY,
  N8N_BASE_URL: $env.N8N_BASE_URL,
};

const sbHeaders = {
  apikey: env.SUPABASE_KEY,
  Authorization: `Bearer ${env.SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

async function sbRequest(path) {
  return helpers.httpRequest({
    method: 'GET',
    url: `${env.SUPABASE_URL}/rest/v1/${path}`,
    headers: sbHeaders,
    json: true,
    timeout: 15000,
  });
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

// Kept byte-for-byte identical to formatInvoiceHtml in stage3-4-action-code.js
// -- these two must be updated together if the invoice layout ever changes.
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

const input = $input.first().json;
const invoiceNumber = input.query?.invoice_number;
if (!invoiceNumber) {
  throw new Error('invoice_number query parameter is required, e.g. ?invoice_number=BALI-2026-001');
}

const invoices = await sbRequest(`invoices?invoice_number=eq.${encodeURIComponent(invoiceNumber)}&select=*`);
const invoice = invoices[0];
if (!invoice) {
  throw new Error(`No invoice found for "${invoiceNumber}"`);
}
const bookings = await sbRequest(`bookings?id=eq.${invoice.booking_id}&select=*`);
const booking = bookings[0];

const html = formatInvoiceHtml(invoice, booking);
const pdfBuffer = await renderPdf(html);
const buf = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
const binaryData = await helpers.prepareBinaryData(buf, `${invoice.invoice_number}.pdf`, 'application/pdf');

return [{ json: {}, binary: { data: binaryData } }];

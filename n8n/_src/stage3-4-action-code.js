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
async function sbInsert(path, body) { return sbRequest('POST', path, body, { Prefer: 'return=representation' }); }
async function sbPatch(path, body) { return sbRequest('PATCH', path, body, { Prefer: 'return=representation' }); }

async function sendWhatsApp(toNumber, text) {
  const res = await helpers.httpRequest({
    method: 'POST',
    url: `https://graph.facebook.com/v20.0/${env.META_PHONE_ID}/messages`,
    headers: { Authorization: `Bearer ${env.META_TOKEN}`, 'Content-Type': 'application/json' },
    body: { messaging_product: 'whatsapp', to: toNumber, type: 'text', text: { body: text } },
    json: true,
  });
  return res?.messages?.[0]?.id || null;
}

async function askOpenAIJson(systemPrompt, userText) {
  const res = await helpers.httpRequest({
    method: 'POST',
    url: 'https://api.openai.com/v1/chat/completions',
    headers: { Authorization: `Bearer ${env.OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: {
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText || '' },
      ],
    },
    json: true,
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

function formatInvoiceText(inv, booking) {
  const lines = (inv.line_items || []).map((li) => `- ${li.description}: ${formatMoney(li.amount)}`).join('\n');
  return `INVOICE ${inv.invoice_number}\nEvent: ${booking.event_name}\nBill To: ${inv.bill_to_name || '[confirm with client]'}${inv.bill_to_location ? ', ' + inv.bill_to_location : ''}\n\n${lines}\n\nSubtotal: ${formatMoney(inv.subtotal)}\nVAT (7.5%): +${formatMoney(inv.vat_amount)}\nWHT Deduction (2%): -${formatMoney(inv.wht_amount)}\nTotal Net Payable: ${formatMoney(inv.total_net_payable)}\n\nPayment terms: ${inv.payment_terms || 'TBD'}\nBank: Moniepoint MFB | Account Name: BALI RECREATION CENTER LIMITED | Account Number: 5129398200\nReference: ${inv.invoice_number}`;
}

async function nextInvoiceNumber() {
  const year = new Date().getFullYear();
  const existing = await sbRequest('GET', `invoices?invoice_number=like.BALI-${year}-*&select=invoice_number`);
  const seq = existing.length + 1;
  return `BALI-${year}-${String(seq).padStart(3, '0')}`;
}

async function draftInvoice(bookingId) {
  const booking = await getBooking(bookingId);
  const convo = await sbRequest('GET', `conversations?booking_id=eq.${bookingId}&order=created_at.asc&select=direction,message_text`);
  const transcript = convo.map((m) => `${m.direction}: ${m.message_text}`).join('\n');

  const extraction = await askOpenAIJson(
    'Extract invoice details from this WhatsApp negotiation between a PM and a client for an event venue called Bali. Reply ONLY with JSON: {"line_items": [{"description": "...", "amount": <number>}], "payment_terms": "<e.g. \'100% Full Payment Due\', or \'60/40 split\', exactly as agreed>", "bill_to_name": "<client org/person name if mentioned, else null>", "bill_to_location": "<client city/location if mentioned, else null>"}. Only include PAID items (things the client is being charged for) as line items -- amounts are numbers in Nigerian Naira, no currency symbols or commas.',
    transcript
  );
  if (!extraction || !Array.isArray(extraction.line_items) || extraction.line_items.length === 0) {
    const pm = await findPm();
    if (pm) await sendWhatsApp(pm.phone_number, `Couldn't figure out the invoice line items for "${booking.event_name}" from the conversation -- can you send me the agreed items and amounts directly?`);
    return { ok: false, reason: 'extraction_failed' };
  }

  const subtotal = extraction.line_items.reduce((s, li) => s + Number(li.amount || 0), 0);
  const vat = subtotal * 0.075;
  const wht = subtotal * 0.02;
  const total = subtotal + vat - wht;
  const invoiceNumber = await nextInvoiceNumber();

  const invoice = (await sbInsert('invoices', {
    booking_id: bookingId,
    invoice_number: invoiceNumber,
    bill_to_name: extraction.bill_to_name || null,
    bill_to_location: extraction.bill_to_location || null,
    line_items: extraction.line_items,
    payment_terms: extraction.payment_terms || null,
    subtotal,
    vat_amount: vat,
    wht_amount: wht,
    total_net_payable: total,
    status: 'pending_pm_approval',
  }))[0];

  const pm = await findPm();
  const text = formatInvoiceText(invoice, booking) + '\n\nReply to THIS message with any corrections, or reply "yes" to approve and send to the client.';
  const pending = (await sbInsert('pending_questions', { booking_id: bookingId, field_name: 'invoice_approval', question_text: text }))[0];
  if (pm) {
    const msgId = await sendWhatsApp(pm.phone_number, text);
    if (msgId) await sbPatch(`pending_questions?id=eq.${pending.id}`, { whatsapp_message_id: msgId });
  }

  await sbPatch(`bookings?id=eq.${bookingId}`, { status: 'invoiced' });

  if (booking.staffing_type === null || booking.staffing_type === undefined) {
    await askPmDirectly(bookingId, 'staffing_type', `For "${booking.event_name}" -- full-time or part-time staff needed?`);
  }

  return { ok: true, invoice_id: invoice.id };
}

async function resolveInvoiceApproval(pendingId, answerText) {
  const pq = (await sbRequest('GET', `pending_questions?id=eq.${pendingId}&select=*`))[0];
  const booking = await getBooking(pq.booking_id);
  const invoice = (await sbRequest('GET', `invoices?booking_id=eq.${pq.booking_id}&order=created_at.desc&limit=1&select=*`))[0];

  if (/^y(es)?\b/i.test((answerText || '').trim())) {
    await sbPatch(`invoices?id=eq.${invoice.id}`, { status: 'sent_to_client' });
    const client = await getContact(booking.client_contact_id);
    const text = formatInvoiceText(invoice, booking);
    await sendWhatsApp(client.phone_number, text);
    await sendWhatsApp(client.phone_number, "Whenever you're ready, please send proof of payment and we'll get it confirmed.");
    await logConversation(booking.id, null, 'outbound', text, 'invoice_sent');
    return { ok: true, action: 'invoice_sent_to_client' };
  }

  const extraction = await askOpenAIJson(
    `Here is a draft invoice's current line items and payment terms as JSON: ${JSON.stringify({ line_items: invoice.line_items, payment_terms: invoice.payment_terms, bill_to_name: invoice.bill_to_name, bill_to_location: invoice.bill_to_location })}\n\nThe PM has requested this correction: "${answerText}"\n\nReply ONLY with the corrected JSON in the exact same shape: {"line_items": [{"description": "...", "amount": <number>}], "payment_terms": "...", "bill_to_name": "...", "bill_to_location": "..."}.`,
    answerText
  );
  if (!extraction) {
    const pm = await findPm();
    if (pm) await sendWhatsApp(pm.phone_number, "Didn't catch that correction -- can you say it again?");
    return { ok: false };
  }

  const subtotal = extraction.line_items.reduce((s, li) => s + Number(li.amount || 0), 0);
  const vat = subtotal * 0.075;
  const wht = subtotal * 0.02;
  const total = subtotal + vat - wht;

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
  const text = formatInvoiceText(updated, booking) + '\n\nUpdated -- reply to THIS message with corrections, or "yes" to approve.';
  const pending = (await sbInsert('pending_questions', { booking_id: booking.id, field_name: 'invoice_approval', question_text: text }))[0];
  if (pm) {
    const msgId = await sendWhatsApp(pm.phone_number, text);
    if (msgId) await sbPatch(`pending_questions?id=eq.${pending.id}`, { whatsapp_message_id: msgId });
  }
  return { ok: true, action: 'invoice_corrected' };
}

async function resolvePaymentConfirmed(pendingId, answerText) {
  const pq = (await sbRequest('GET', `pending_questions?id=eq.${pendingId}&select=*`))[0];
  const booking = await getBooking(pq.booking_id);
  const invoice = (await sbRequest('GET', `invoices?booking_id=eq.${pq.booking_id}&order=created_at.desc&limit=1&select=*`))[0];

  if (!/^y(es)?\b/i.test((answerText || '').trim())) {
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
    const msgId = await sendWhatsApp(pm.phone_number, questionText);
    if (msgId) await sbPatch(`pending_questions?id=eq.${pending.id}`, { whatsapp_message_id: msgId });
  }
  return { ok: true, action: 'contract_draft_forwarded_to_pm' };
}

async function resolveContractApproval(pendingId, answerText) {
  const pq = (await sbRequest('GET', `pending_questions?id=eq.${pendingId}&select=*`))[0];
  const booking = await getBooking(pq.booking_id);
  const contract = (await sbRequest('GET', `contracts?booking_id=eq.${pq.booking_id}&order=created_at.desc&limit=1&select=*`))[0];

  if (/^y(es)?\b/i.test((answerText || '').trim())) {
    await sbPatch(`bookings?id=eq.${booking.id}`, { status: 'sent_to_client' });
    await sbPatch(`contracts?id=eq.${contract.id}`, { approved_by_pm_at: new Date().toISOString(), sent_to_client_at: new Date().toISOString() });
    const client = await getContact(booking.client_contact_id);
    await sendWhatsApp(client.phone_number, `Here's your contract for "${booking.event_name}" -- please review, sign, and send it back as a PDF.`);
    return { ok: true, action: 'contract_sent_to_client' };
  }

  const lawyer = await findLawyer();
  if (lawyer) await sendWhatsApp(lawyer.phone_number, `PM requested a change on the "${booking.event_name}" contract: "${answerText}"`);
  return { ok: true, action: 'change_relayed_to_lawyer' };
}

const input = $input.first().json.body || $input.first().json;
const action = input.action;

let result;
if (action === 'draft_invoice') result = await draftInvoice(input.booking_id);
else if (action === 'resolve_invoice_approval') result = await resolveInvoiceApproval(input.pending_question_id, input.answer_text);
else if (action === 'resolve_payment_confirmed') result = await resolvePaymentConfirmed(input.pending_question_id, input.answer_text);
else if (action === 'send_to_lawyer') result = await sendToLawyer(input.booking_id);
else if (action === 'resolve_contract_approval') result = await resolveContractApproval(input.pending_question_id, input.answer_text);
else result = await handleLawyerInbound(input);

return [{ json: result }];

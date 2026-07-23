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
  });
}

async function sbPatch(path, body) {
  return sbRequest('PATCH', path, body, { Prefer: 'return=representation' });
}

async function openaiExtract(fieldPrompt, userText) {
  const res = await helpers.httpRequest({
    method: 'POST',
    url: 'https://api.openai.com/v1/chat/completions',
    headers: {
      Authorization: `Bearer ${env.OPENAI_KEY}`,
      'Content-Type': 'application/json',
    },
    body: {
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: fieldPrompt },
        { role: 'user', content: userText || '' },
      ],
    },
    json: true,
  });
  try {
    return JSON.parse(res.choices[0].message.content);
  } catch (e) {
    return { understood: false };
  }
}

async function sendWhatsApp(toNumber, text) {
  return helpers.httpRequest({
    method: 'POST',
    url: `https://graph.facebook.com/v20.0/${env.META_PHONE_ID}/messages`,
    headers: {
      Authorization: `Bearer ${env.META_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: {
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'text',
      text: { body: text },
    },
    json: true,
  });
}

const FIELD_PROMPTS = {
  event_date: 'Extract the event date the client mentions from their WhatsApp message. Reply ONLY with JSON: {"understood": true/false, "value": "YYYY-MM-DD"}. If no clear date is given, set understood to false.',
  event_name: 'Extract a short human-readable event name/title from the client\'s message (e.g. "Sarah\'s 30th Birthday"). Reply ONLY with JSON: {"understood": true/false, "value": "..."}. If the message clearly contains a name for the event, understood is true.',
  event_type: 'Extract the type of event (e.g. wedding, birthday, corporate event, private party) from the client\'s message. Reply ONLY with JSON: {"understood": true/false, "value": "..."}.',
  is_existing_client: 'Determine if the client is saying they are a NEW or an EXISTING/returning client. Reply ONLY with JSON: {"understood": true/false, "value": true/false} where value=true means existing/returning client, false means new client.',
  client_reference: 'Extract the Instagram handle or reference to a previous event the client mentions. Reply ONLY with JSON: {"understood": true/false, "value": "..."}.',
};

const FIELD_QUESTIONS = {
  event_name: "Awesome! What should we call this event? (just a short name so our team can reference it)",
  event_type: "Got it. And what kind of event is this — wedding, birthday, corporate, something else?",
  is_existing_client: "One more thing — have you booked with us before, or is this your first time?",
  client_reference: "Nice to have you back! Could you drop your Instagram handle or point me to a past event of yours? I'll pass it to our PM so they've got the history before jumping in.",
  negotiating_handoff: "Perfect, that's everything I need for now! Let me get our events manager to chat pricing with you — they'll be with you shortly.",
};

const GREETING = "Hey! 😊 Would you be interested in booking Bali for your event? Just let me know the date you're looking at and I'll check what's available.";

function fieldOrder(isExisting) {
  const base = ['event_date', 'event_name', 'event_type', 'is_existing_client'];
  return isExisting === true ? [...base, 'client_reference'] : base;
}

function nextMissingField(booking) {
  for (const f of fieldOrder(booking.is_existing_client)) {
    if (booking[f] === null || booking[f] === undefined) return f;
  }
  return null;
}

const input = $input.first().json.body;
const { from_number, text, contact_id: routerContactId } = input;

// 1. Upsert contact (creates if unrecognized, per Section 9a; no-op update if it already exists).
const contactRows = await sbRequest(
  'POST',
  'contacts?on_conflict=phone_number',
  { phone_number: from_number, role: 'customer' },
  { Prefer: 'resolution=merge-duplicates,return=representation' }
);
const contact = contactRows[0];

// 2. Find the latest non-cancelled booking for this contact.
const existingBookings = await sbRequest(
  'GET',
  `bookings?client_contact_id=eq.${contact.id}&status=neq.cancelled&order=created_at.desc&limit=1`
);
let booking = existingBookings[0] || null;

const logs = [];
let replyText = null;

if (!booking) {
  // First-ever message from this client: create the booking, send the scripted greeting.
  const created = await sbRequest('POST', 'bookings', {
    client_contact_id: contact.id,
    status: 'inquiry',
    mode: 'bot-led',
  }, { Prefer: 'return=representation' });
  booking = created[0];
  replyText = GREETING;
} else if (booking.status === 'sent_to_client' && input.media_type === 'document') {
  // Stage 4 signature detection: client sent back a PDF while we're waiting on the
  // signed contract. No e-signature tool for v1 -- ask the PM to confirm receipt/validity.
  logs.push({ booking_id: booking.id, sender_contact_id: contact.id, direction: 'inbound', message_text: '[PDF received]', media_url: input.media_id, stage: booking.status });
  await sbRequest('POST', 'conversations', logs);
  const pmRows = await sbRequest('GET', 'contacts?role=eq.pm&select=*&limit=1');
  const pm = pmRows[0];
  if (pm) {
    const questionText = `"${booking.event_name}" — client sent back a signed PDF. Confirm it's valid? Reply yes or no.`;
    const pendingRows = await sbRequest('POST', 'pending_questions', {
      booking_id: booking.id,
      field_name: 'contract_confirmed',
      question_text: questionText,
    }, { Prefer: 'return=representation' });
    const msgId = await sendWhatsApp(pm.phone_number, questionText);
    if (msgId) await sbPatch(`pending_questions?id=eq.${pendingRows[0].id}`, { whatsapp_message_id: msgId });
  }
  return [{ json: { action: 'signature_pending_pm_confirmation', booking_id: booking.id } }];
} else if (booking.status === 'invoiced' && (input.media_type === 'image' || input.media_type === 'document')) {
  // Stage 3: client sent proof of payment -- forward to PM to confirm receipt.
  logs.push({ booking_id: booking.id, sender_contact_id: contact.id, direction: 'inbound', message_text: '[proof of payment received]', media_url: input.media_id, stage: booking.status });
  await sbRequest('POST', 'conversations', logs);
  const pmRows = await sbRequest('GET', 'contacts?role=eq.pm&select=*&limit=1');
  const pm = pmRows[0];
  if (pm) {
    const questionText = `"${booking.event_name}" — client sent proof of payment. Confirm receipt? Reply yes or no.`;
    const pendingRows = await sbRequest('POST', 'pending_questions', {
      booking_id: booking.id,
      field_name: 'payment_confirmed',
      question_text: questionText,
    }, { Prefer: 'return=representation' });
    const msgId = await sendWhatsApp(pm.phone_number, questionText);
    if (msgId) await sbPatch(`pending_questions?id=eq.${pendingRows[0].id}`, { whatsapp_message_id: msgId });
  }
  await sendWhatsApp(from_number, "Got it, thanks! Confirming with our team now.");
  return [{ json: { action: 'payment_proof_pending_pm_confirmation', booking_id: booking.id } }];
} else if (booking.status === 'awaiting_contract') {
  // Stage 4: organizer legal name + registered address must be explicitly confirmed
  // with the client, never assumed from their WhatsApp profile name.
  const contractRows = await sbRequest('GET', `contracts?booking_id=eq.${booking.id}&order=created_at.desc&limit=1&select=*`);
  const contract = contractRows[0];
  logs.push({ booking_id: booking.id, sender_contact_id: contact.id, direction: 'inbound', message_text: text, stage: booking.status });

  if (contract && (!contract.organizer_legal_name || !contract.organizer_registered_address)) {
    const extraction = await openaiExtract(
      'Extract the organization\'s full legal name and its official registered address from this WhatsApp message. Reply ONLY with JSON: {"understood": true/false, "organizer_legal_name": "...", "organizer_registered_address": "..."}. Both fields must be present for understood to be true.',
      text || ''
    );
    if (!extraction.understood) {
      replyText = "Sorry, I need both the full legal name and the official registered address together -- could you send them again?";
    } else {
      await sbPatch(`contracts?id=eq.${contract.id}`, {
        organizer_legal_name: extraction.organizer_legal_name,
        organizer_registered_address: extraction.organizer_registered_address,
      });
      await helpers.httpRequest({
        method: 'POST',
        url: `${env.N8N_BASE_URL}/webhook/stage3-4`,
        headers: { 'Content-Type': 'application/json' },
        body: { action: 'send_to_lawyer', booking_id: booking.id },
        json: true,
      });
      replyText = "Perfect, thank you! Passing this to our lawyer to draft the contract now.";
    }
  }
  // If there's no contract row yet, or it's already fully collected, nothing to ask --
  // just log passively (mirrors the general Stage 2+ passive rule below).
  if (replyText) {
    await sendWhatsApp(from_number, replyText);
    logs.push({ booking_id: booking.id, sender_contact_id: null, direction: 'outbound', message_text: replyText, stage: booking.status });
  }
  await sbRequest('POST', 'conversations', logs);
  return [{ json: { action: 'awaiting_contract_handled', booking_id: booking.id, replied: !!replyText } }];
} else if (booking.status !== 'inquiry') {
  // Stage 1 already complete for this client (negotiating or later) -- bot stays
  // passive per Stage 2 / the PM-led toggle. Just log the inbound message.
  logs.push({ booking_id: booking.id, sender_contact_id: contact.id, direction: 'inbound', message_text: text, stage: booking.status });
  await sbRequest('POST', 'conversations', logs);
  return [{ json: { skipped: true, reason: 'booking not in inquiry stage', booking_id: booking.id } }];
} else {
  // Mid-intake: interpret this message as the answer to whichever field is still missing.
  const field = nextMissingField(booking);
  const extraction = await openaiExtract(FIELD_PROMPTS[field], text || '');

  if (!extraction.understood) {
    // Might be an off-script question rather than a bad answer (Section 8) --
    // let the KB workflow take a look and answer/escalate on its own, then
    // still re-ask whatever field we're waiting on.
    await helpers.httpRequest({
      method: 'POST',
      url: `${env.N8N_BASE_URL}/webhook/kb-check`,
      headers: { 'Content-Type': 'application/json' },
      body: { action: 'check', from_number, text, contact_id: contact.id, booking_id: booking.id },
      json: true,
    });
    replyText = `Anyway — ${FIELD_QUESTIONS[field] || 'could you say that again?'}`;
  } else if (field === 'event_date') {
    const collisions = await sbRequest('GET', `bookings?event_date=eq.${extraction.value}&status=neq.cancelled&id=neq.${booking.id}&select=id`);
    if (collisions.length > 0) {
      replyText = "Ah, that date's already booked! Do you have an alternative date in mind?";
    } else {
      await sbPatch(`bookings?id=eq.${booking.id}`, { event_date: extraction.value });
      booking.event_date = extraction.value;
      replyText = FIELD_QUESTIONS.event_name;
    }
  } else {
    const patch = { [field]: extraction.value };
    await sbPatch(`bookings?id=eq.${booking.id}`, patch);
    booking[field] = extraction.value;

    const next = nextMissingField(booking);
    if (!next) {
      await sbPatch(`bookings?id=eq.${booking.id}`, { status: 'negotiating' });
      replyText = FIELD_QUESTIONS.negotiating_handoff;
    } else {
      replyText = FIELD_QUESTIONS[next];
    }
  }
}

logs.push({ booking_id: booking.id, sender_contact_id: contact.id, direction: 'inbound', message_text: text, stage: 'stage1_intake' });
if (replyText) {
  await sendWhatsApp(from_number, replyText);
  logs.push({ booking_id: booking.id, sender_contact_id: null, direction: 'outbound', message_text: replyText, stage: 'stage1_intake' });
}
await sbRequest('POST', 'conversations', logs);

return [{ json: { booking_id: booking.id, reply_sent: replyText } }];

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

async function sendWhatsApp(toNumber, text) {
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

async function askOpenAI(systemPrompt, userText) {
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

async function logConversation(bookingId, senderContactId, direction, text, stage) {
  await sbInsert('conversations', [
    { booking_id: bookingId, sender_contact_id: senderContactId, direction, message_text: text, stage },
  ]);
}

const input = $input.first().json.body || $input.first().json;
const action = input.action || 'check';

if (action === 'check') {
  const { from_number, text, contact_id, booking_id } = input;

  const kb = await sbRequest('GET', 'knowledge_base?select=question,answer&order=last_updated.desc');
  const kbText = kb.map((row, i) => `${i + 1}. Q: ${row.question}\n   A: ${row.answer}`).join('\n') || '(knowledge base is empty)';

  const systemPrompt = `You are answering a WhatsApp question for an event venue called Bali, in a warm, brief, conversational tone (never sound like an AI or a company bot). Use ONLY the knowledge base below to answer -- do not make anything up. If the knowledge base doesn't cover the client's question, say so.\n\nKnowledge base:\n${kbText}\n\nReply ONLY with JSON: {"found": true/false, "answer": "..."} -- "answer" is the warm reply to send if found, or omitted/empty if not found.`;

  const result = await askOpenAI(systemPrompt, text || '');

  let bookingId = booking_id || null;
  if (!bookingId) {
    const rows = await sbRequest('GET', `bookings?client_contact_id=eq.${contact_id}&status=neq.cancelled&order=created_at.desc&limit=1`);
    bookingId = rows[0]?.id || null;
  }

  if (result.found && result.answer) {
    await sendWhatsApp(from_number, result.answer);
    if (bookingId) await logConversation(bookingId, contact_id, 'outbound', result.answer, 'kb_answered');
    return [{ json: { action: 'kb_answered' } }];
  }

  // Not found. If the client keeps asking while the PM still hasn't answered,
  // repeating the exact same "let me check" line every time reads as broken --
  // vary the wording by how many times this has already come up for this
  // booking, and only actually ping the PM once per still-open matter.
  const priorRows = bookingId
    ? await sbRequest('GET', `pending_questions?booking_id=eq.${bookingId}&field_name=eq.kb_escalation&select=id,resolved_at&order=asked_at.asc`)
    : [];
  const openRow = priorRows.find((r) => !r.resolved_at) || null;
  const STILL_WAITING_REPLIES = [
    "Good question, let me check on that and get back to you!",
    "Sorry, I'm still checking on that for you.",
    "Still haven't been able to confirm that, sorry for the long wait.",
  ];
  const tier = Math.min(priorRows.length, STILL_WAITING_REPLIES.length - 1);
  const waitingText = STILL_WAITING_REPLIES[tier];
  await sendWhatsApp(from_number, waitingText);
  if (bookingId) await logConversation(bookingId, contact_id, 'outbound', waitingText, 'kb_not_found');

  const pm = await findPm();
  if (!pm || !bookingId) {
    return [{ json: { action: 'kb_not_found_no_escalation_target' } }];
  }

  if (!openRow) {
    // First time this has come up, or the previous one already got answered --
    // create a fresh escalation and actually ping the PM.
    const booking = (await sbRequest('GET', `bookings?id=eq.${bookingId}&select=event_name`))[0];
    const pending = (await sbInsert('pending_questions', {
      booking_id: bookingId,
      field_name: 'kb_escalation',
      question_text: text,
    }))[0];

    const escalationText = `New question on "${booking?.event_name || 'an inquiry'}": "${text}"\nReply directly to this message with the answer.`;
    const msgId = await sendWhatsApp(pm.phone_number, escalationText);
    if (msgId) await sbPatch(`pending_questions?id=eq.${pending.id}`, { whatsapp_message_id: msgId });

    return [{ json: { action: 'kb_escalated', pending_question_id: pending.id } }];
  }

  // Already pending with the PM -- log a lightweight, auto-resolved tally row
  // (it's not something the PM replies to) so a further repeat picks the next
  // wording tier, without paging the PM again for the same still-open thing.
  await sbInsert('pending_questions', {
    booking_id: bookingId,
    field_name: 'kb_escalation',
    question_text: text,
    resolved_at: new Date().toISOString(),
  });
  return [{ json: { action: 'kb_still_waiting', pending_question_id: openRow.id } }];
}

if (action === 'resolve_escalation') {
  const { pending_question_id, answer_text } = input;
  const pq = (await sbRequest('GET', `pending_questions?id=eq.${pending_question_id}&select=*`))[0];
  const booking = (await sbRequest('GET', `bookings?id=eq.${pq.booking_id}&select=*`))[0];
  const client = (await sbRequest('GET', `contacts?id=eq.${booking.client_contact_id}&select=*`))[0];

  await sendWhatsApp(client.phone_number, answer_text);
  await logConversation(booking.id, null, 'outbound', answer_text, 'kb_escalation_answer');

  // Opt-in KB save (Section 8): only added if the PM says yes to this follow-up.
  const pm = await findPm();
  const savePayload = JSON.stringify({ question: pq.question_text, answer: answer_text });
  const savePending = (await sbInsert('pending_questions', {
    booking_id: booking.id,
    field_name: 'kb_save_confirm',
    question_text: savePayload,
  }))[0];
  const confirmText = `Save that as a knowledge-base answer for future questions like "${pq.question_text}"? Reply yes or no.`;
  const msgId = await sendWhatsApp(pm.phone_number, confirmText);
  if (msgId) await sbPatch(`pending_questions?id=eq.${savePending.id}`, { whatsapp_message_id: msgId });

  return [{ json: { action: 'escalation_resolved' } }];
}

if (action === 'resolve_kb_save_confirm') {
  const { pending_question_id, answer_text } = input;
  const pq = (await sbRequest('GET', `pending_questions?id=eq.${pending_question_id}&select=*`))[0];
  const pm = await findPm();
  const saysYes = /^y(es)?\b/i.test((answer_text || '').trim());

  if (saysYes) {
    const { question, answer } = JSON.parse(pq.question_text);
    await sbInsert('knowledge_base', { question, answer });
    await sendWhatsApp(pm.phone_number, 'Saved!');
  } else {
    await sendWhatsApp(pm.phone_number, "Got it, not saved.");
  }

  return [{ json: { action: 'kb_save_confirm_resolved', saved: saysYes } }];
}

return [{ json: { action: 'unknown_action', received: action } }];

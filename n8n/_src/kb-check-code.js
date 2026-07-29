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

  // Not found. Before treating this as an unanswerable question -- which
  // would either page the PM with a useless "reply directly to this
  // message" escalation, or fall back to a generic "I'll get back to you"
  // that ignores what the client is actually trying to do -- check whether
  // they're just signaling intent to add/change something without having
  // said what yet ("I want to add something", "can I give you an update?").
  // If so, just ask what, instead of stalling or escalating nothing.
  const intentCheck = await askOpenAI(
    `A client just said: "${text}". Are they signaling they want to add, change, or share some detail about their booking or event WITHOUT having actually stated what it is yet -- e.g. "I want to add something", "can I give you more details?", "I have an update for you", "one more thing"? Reply ONLY with JSON: {"wants_to_add_without_content": true/false}.`,
    text || ''
  );
  if (intentCheck?.wants_to_add_without_content) {
    const askText = "Sure, what would you like to add?";
    await sendWhatsApp(from_number, askText);
    if (bookingId) await logConversation(bookingId, contact_id, 'outbound', askText, 'kb_ask_for_details');
    return [{ json: { action: 'kb_ask_for_details' } }];
  }

  // If this is the first time this has come up, stall with a warm line and
  // actually escalate to the PM.
  const priorRows = bookingId
    ? await sbRequest('GET', `pending_questions?booking_id=eq.${bookingId}&field_name=eq.kb_escalation&select=id,question_text,resolved_at&order=asked_at.asc`)
    : [];
  const openRow = priorRows.find((r) => !r.resolved_at) || null;
  const pm = await findPm();

  if (!openRow) {
    const STILL_WAITING_REPLIES = [
      "Good question, let me check on that and get back to you!",
      "Sorry, I'm still checking on that for you.",
      "Still haven't been able to confirm that, sorry for the long wait.",
    ];
    const tier = Math.min(priorRows.length, STILL_WAITING_REPLIES.length - 1);
    const waitingText = STILL_WAITING_REPLIES[tier];
    await sendWhatsApp(from_number, waitingText);
    if (bookingId) await logConversation(bookingId, contact_id, 'outbound', waitingText, 'kb_not_found');

    if (!pm || !bookingId) {
      return [{ json: { action: 'kb_not_found_no_escalation_target' } }];
    }

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

  // Already pending with the PM. Rather than always repeating the same
  // generic "still checking" line, actually read what the client just said --
  // they might be adding a detail worth relaying to the PM, asking for a
  // clarification we can address from the conversation itself, or genuinely
  // just checking in with nothing new.
  if (!bookingId) {
    return [{ json: { action: 'kb_still_waiting_no_booking' } }];
  }

  const history = await sbRequest(
    'GET',
    `conversations?booking_id=eq.${bookingId}&order=created_at.desc&select=direction,message_text&limit=10`
  );
  const recentTranscript = history.reverse().map((m) => `${m.direction === 'inbound' ? 'Client' : 'Bali'}: ${m.message_text}`).join('\n');

  const followUp = await askOpenAI(
    `A client asked "${openRow.question_text}" and it's still waiting on an answer from our events team -- not something you can answer yourself. They just followed up with: "${text}"\n\nRecent conversation:\n${recentTranscript}\n\nClassify their follow-up and reply ONLY with JSON: {"type": "additional_info" | "clarification" | "check_in", "forward_note": "..." or null, "reply": "..."}\n\n- "additional_info": they're adding a new detail relevant to their booking or open question (a preference, a correction, extra context) that the team should know about. "forward_note" is a short, concrete note of what they added, to relay to the team. "reply" briefly and warmly confirms you've passed it along.\n- "clarification": they're asking you to restate or clarify something about their own situation, answerable from the conversation above without needing anything new from the team. "forward_note" is null. "reply" directly answers it, warm and brief.\n- "check_in": just checking in, repeating impatience, or nothing new to act on -- you genuinely don't have an answer yet. "forward_note" is null. "reply" is a warm acknowledgment that you're still on it -- vary the wording, never repeat a line already used in the conversation above.\n\nNever sound like an AI or a hype machine: no "Awesome!", no exclamation-point enthusiasm.`,
    text || ''
  );

  const followUpType = followUp?.type || 'check_in';
  const replyText = followUp?.reply || "Still checking on that for you, sorry for the wait.";

  if (followUpType === 'additional_info' && followUp.forward_note && pm) {
    // Actually resend the open question to the PM (not just a passive FYI) --
    // restate it in full with the new detail attached, and re-point the
    // pending question's whatsapp_message_id at this message so a swipe-reply
    // to it still matches correctly (the original escalation message may be
    // scrolled past by now).
    const booking = (await sbRequest('GET', `bookings?id=eq.${bookingId}&select=event_name`))[0];
    const forwardText = `Following up on "${booking?.event_name || 'an inquiry'}": "${openRow.question_text}"\n\nClient just added: ${followUp.forward_note}\n\nReply directly to this message with the answer.`;
    const msgId = await sendWhatsApp(pm.phone_number, forwardText);
    if (msgId) await sbPatch(`pending_questions?id=eq.${openRow.id}`, { whatsapp_message_id: msgId });
    await logConversation(bookingId, null, 'outbound', `[relayed to PM] ${followUp.forward_note}`, 'kb_additional_info_forwarded');
  }

  await sendWhatsApp(from_number, replyText);
  await logConversation(bookingId, null, 'outbound', replyText, `kb_${followUpType}`);

  // Tally row, resolved immediately -- not something the PM replies to, just
  // keeps the wording-tier count moving for any future genuinely-new question.
  await sbInsert('pending_questions', {
    booking_id: bookingId,
    field_name: 'kb_escalation',
    question_text: text,
    resolved_at: new Date().toISOString(),
  });
  return [{ json: { action: `kb_still_waiting_${followUpType}`, pending_question_id: openRow.id } }];
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
  const saysYes = /^(y(es)?|yeah|yep|yup|sure|ok(ay)?|approved?|agreed?|confirmed)\b/i.test((answer_text || '').trim());

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

// Bali table-reservation bot (replaces the old event-booking sales flow, 2026-11-23).
//
// One webhook handles every inbound message the router forwards:
//   role 'customer'            -> guest flow (book / change / cancel / status / questions)
//   role pm|floor_manager|staff|supervisor|facility_manager -> staff commands
//
// Design rules (from this codebase's hard-won lessons):
//  - Everything structural is deterministic code: dates, times, capacity, which field to ask
//    next, every reply. The LLM is ONLY used to read what the guest typed into fields
//    (temperature 0) and to answer a free-form question from the KB.
//  - A message reaches a guest ONLY via an explicit staff command ("tell ..." / cancel / move).
//    Staff free text is never relayed implicitly.
//  - No hyphens, em dashes or asterisks in guest-facing copy.
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
const SANDBOX = !env.META_TOKEN;
const STAFF_ROLES = ['pm', 'floor_manager', 'staff', 'supervisor', 'facility_manager'];
const NOTIFY_ROLES = ['pm', 'floor_manager'];

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
const enc = encodeURIComponent;

function stripMarkdown(text) {
  return String(text || '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/`+/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function askOpenAIJson(systemPrompt, userText) {
  try {
    const res = await helpers.httpRequest({
      method: 'POST',
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { Authorization: `Bearer ${env.OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: {
        model: 'gpt-4o',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText || '' },
        ],
      },
      json: true,
      timeout: 30000,
    });
    return JSON.parse(res.choices[0].message.content);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Settings + time helpers (all venue-local; Lagos has no DST so a fixed offset is exact)
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  open_time: '12:00',
  close_time: '22:00',
  slot_minutes: 60,
  max_guests_per_slot: 40,
  max_guests_per_booking: 12,
  min_notice_minutes: 60,
  max_days_ahead: 60,
  closed_weekdays: [],
  tz_offset_minutes: 60,
  venue_name: 'Bali',
  venue_notes: '',
};
let S = { ...DEFAULT_SETTINGS };

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WD_TITLE = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function nowLocal() { return new Date(Date.now() + S.tz_offset_minutes * 60000); } // read with getUTC*
function pad(n) { return String(n).padStart(2, '0'); }
function isoDate(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function todayStr() { return isoDate(nowLocal()); }
function addDaysISO(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}
function dowOf(iso) { return new Date(`${iso}T00:00:00Z`).getUTCDay(); }
function toMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function fromMin(m) { return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }
function localToUtcISO(date, hhmm) {
  return new Date(Date.parse(`${date}T${hhmm}:00Z`) - S.tz_offset_minutes * 60000).toISOString();
}
function utcToLocalParts(iso) {
  const d = new Date(new Date(iso).getTime() + S.tz_offset_minutes * 60000);
  return { date: isoDate(d), time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
}
function fmtDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const t = todayStr();
  if (iso === t) return 'today';
  if (iso === addDaysISO(t, 1)) return 'tomorrow';
  return `${WD_TITLE[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
function fmtTime(hhmm) {
  let [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return m === 0 ? `${h}${suffix}` : `${h}:${pad(m)}${suffix}`;
}
function guestWord(n) { return n === 1 ? '1 guest' : `${n} guests`; }
function lastSeatingMin() { return toMin(S.close_time) - S.slot_minutes; }

// "7pm", "7:30 pm", "19:00", "noon", "7" (bare hour => assume the sensible one inside opening hours)
function parseTime(raw) {
  if (raw === null || raw === undefined) return null;
  const t = String(raw).toLowerCase().trim();
  if (!t) return null;
  if (/\bnoon\b|\bmidday\b/.test(t)) return '12:00';
  if (/\bmidnight\b/.test(t)) return '00:00';
  const m = t.match(/\b(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const mer = m[3] ? m[3][0] : null;
  if (min > 59 || h > 24) return null;
  if (mer === 'p' && h < 12) h += 12;
  else if (mer === 'a' && h === 12) h = 0;
  else if (!mer && h <= 12 && !m[2] === !m[2]) {
    // no am/pm given and written 12 hour style: pick the reading that lands inside opening hours
    const openMin = toMin(S.open_time);
    const cand = [h % 12, (h % 12) + 12].map((x) => x * 60 + min);
    const inside = cand.filter((c) => c >= openMin && c <= toMin(S.close_time));
    if (h >= 13) { /* 24h already */ }
    else if (inside.length === 1) h = Math.floor(inside[0] / 60);
    else if (inside.length === 2) h = (h % 12) + 12 >= 12 && h < 12 ? h + 12 : h; // both fit: assume pm for 1..11
    else if (h < 12) h += 12;
  }
  if (h === 24) h = 0;
  return `${pad(h)}:${pad(min)}`;
}

// Relative phrases are resolved here, never by the model (LLM date math is unreliable).
function resolveRelativeDate(rawText) {
  const text = String(rawText || '').toLowerCase();
  const today = todayStr();
  const dow = dowOf(today);
  const mondayOffset = (dow + 6) % 7;
  const thisMonday = addDaysISO(today, -mondayOffset);
  const nextMonday = addDaysISO(thisMonday, 7);
  if (/\btoday\b|\btonight\b|\bthis evening\b/.test(text)) return today;
  if (/\bday after tomorrow\b/.test(text)) return addDaysISO(today, 2);
  if (/\btomorrow\b|\btmrw\b|\btmr\b/.test(text)) return addDaysISO(today, 1);
  const isNext = /\bnext\b/.test(text);
  const wd = WEEKDAYS.find((w) => new RegExp(`\\b${w}\\b`).test(text)) ||
    (/\bfri\b/.test(text) ? 'friday' : /\bsat\b/.test(text) ? 'saturday' : /\bsun\b/.test(text) ? 'sunday' : null);
  if (wd) {
    const off = (WEEKDAYS.indexOf(wd) + 6) % 7;
    if (isNext) return addDaysISO(nextMonday, off);
    // "friday" alone = the upcoming one (today counts if it is that day)
    return off >= mondayOffset ? addDaysISO(thisMonday, off) : addDaysISO(nextMonday, off);
  }
  if (/\bweekend\b/.test(text)) return isNext || 5 < mondayOffset ? addDaysISO(nextMonday, 5) : addDaysISO(thisMonday, 5);
  const inM = text.match(/\bin\s+(\d+)\s+(day|days|week|weeks)\b/);
  if (inM) return addDaysISO(today, parseInt(inM[1], 10) * (inM[2].startsWith('week') ? 7 : 1));
  return null;
}

// ---------------------------------------------------------------------------
// Messaging (24h window aware; template + queue fallback, same mechanism as the rest of Bali)
// ---------------------------------------------------------------------------
let CURRENT_SENDER = null;
async function logMsg(phone, direction, text) {
  try { await sbRequest('POST', 'reservation_log', { phone_number: phone, direction, message_text: text }); } catch (e) {}
}
async function sandboxLog(to, text, kind) {
  const id = `sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try { await sbRequest('POST', 'sandbox_outbound', { to_number: to, kind: kind || 'text', message_text: text, message_id: id }); } catch (e) {}
  return id;
}
async function withinWindow(to) {
  if (to === CURRENT_SENDER) return true;
  const rows = await sbRequest('GET', `reservation_log?phone_number=eq.${enc(to)}&direction=eq.inbound&select=created_at&order=created_at.desc&limit=1`);
  if (!rows[0]) return false;
  return (Date.now() - new Date(rows[0].created_at).getTime()) / 3600000 < 23;
}
async function graphSend(body) {
  const res = await helpers.httpRequest({
    method: 'POST',
    url: `https://graph.facebook.com/v20.0/${env.META_PHONE_ID}/messages`,
    headers: { Authorization: `Bearer ${env.META_TOKEN}`, 'Content-Type': 'application/json' },
    body: { messaging_product: 'whatsapp', ...body },
    json: true,
    timeout: 20000,
  });
  return res?.messages?.[0]?.id || null;
}
async function sendTemplate(to, label) {
  if (SANDBOX) return sandboxLog(to, label, 'template');
  return graphSend({
    to, type: 'template',
    template: { name: 'bali_update', language: { code: 'en_US' }, components: [{ type: 'body', parameters: [{ type: 'text', text: String(label || 'an update').replace(/\s+/g, ' ').slice(0, 200) }] }] },
  });
}
async function send(to, text, label) {
  const msg = stripMarkdown(text);
  await logMsg(to, 'outbound', msg);
  if (SANDBOX) return sandboxLog(to, msg, 'text');
  if (!(await withinWindow(to))) {
    await sendTemplate(to, label || 'a reservation update');
    await sbRequest('POST', 'queued_messages', { phone_number: to, message_text: msg });
    return null;
  }
  try {
    return await graphSend({ to, type: 'text', text: { body: msg } });
  } catch (err) {
    let s; try { s = JSON.stringify(err, Object.getOwnPropertyNames(err)); } catch (e) { s = String(err); }
    s += JSON.stringify(err?.response?.data || err?.response?.body || '');
    if (s.includes('131047')) {
      await sendTemplate(to, label || 'a reservation update');
      await sbRequest('POST', 'queued_messages', { phone_number: to, message_text: msg });
      return null;
    }
    throw err;
  }
}
async function notifyStaff(text, label) {
  let staff = [];
  try { staff = await sbRequest('GET', `contacts?role=in.(${NOTIFY_ROLES.join(',')})&select=phone_number`); } catch (e) {}
  for (const s of staff) {
    try { await send(s.phone_number, text, label || 'a new reservation'); } catch (e) {}
  }
  return staff.length;
}

// ---------------------------------------------------------------------------
// Reservation data access + capacity
// ---------------------------------------------------------------------------
function slotStartMin(hhmm) {
  const open = toMin(S.open_time);
  return open + Math.floor((toMin(hhmm) - open) / S.slot_minutes) * S.slot_minutes;
}
async function guestsBookedInSlot(date, hhmm, excludeRef) {
  const s = slotStartMin(hhmm);
  const from = localToUtcISO(date, fromMin(s));
  const to = localToUtcISO(date, fromMin(s + S.slot_minutes));
  let q = `reservations?status=eq.confirmed&starts_at=gte.${enc(from)}&starts_at=lt.${enc(to)}&select=guests,ref`;
  const rows = await sbRequest('GET', q);
  return rows.filter((r) => r.ref !== excludeRef).reduce((a, r) => a + r.guests, 0);
}
async function hasRoom(date, hhmm, guests, excludeRef) {
  return (await guestsBookedInSlot(date, hhmm, excludeRef)) + guests <= S.max_guests_per_slot;
}
async function alternativeTimes(date, guests, excludeRef) {
  const out = [];
  const isToday = date === todayStr();
  const nowMin = nowLocal().getUTCHours() * 60 + nowLocal().getUTCMinutes() + S.min_notice_minutes;
  for (let m = toMin(S.open_time); m <= lastSeatingMin(); m += S.slot_minutes) {
    if (isToday && m < nowMin) continue;
    if (await hasRoom(date, fromMin(m), guests, excludeRef)) out.push(fromMin(m));
  }
  return out;
}
function newRef() { return `R-${1000 + Math.floor(Math.random() * 9000)}`; }
async function createReservation(r) {
  for (let i = 0; i < 6; i++) {
    const ref = newRef();
    try {
      const rows = await sbRequest('POST', 'reservations', { ref, ...r }, { Prefer: 'return=representation' });
      return rows[0];
    } catch (e) { /* ref collision: retry */ }
  }
  throw new Error('could not allocate reservation ref');
}
async function upcomingFor(phone) {
  return sbRequest('GET', `reservations?phone_number=eq.${enc(phone)}&status=eq.confirmed&starts_at=gte.${enc(new Date(Date.now() - 3600000).toISOString())}&select=*&order=starts_at.asc`);
}
function fmtDateFull(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${WD_TITLE[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
function describe(r) {
  const p = utcToLocalParts(r.starts_at);
  return `${fmtDateFull(p.date)} at ${fmtTime(p.time)} for ${guestWord(r.guests)}`;
}

// Validation of one candidate (date/time/guests). Returns an error string or null.
function validateDate(date) {
  const t = todayStr();
  if (date < t) return 'past';
  if (date > addDaysISO(t, S.max_days_ahead)) return 'toofar';
  if ((S.closed_weekdays || []).includes(dowOf(date))) return 'closed';
  return null;
}
function validateTime(date, hhmm) {
  const m = toMin(hhmm);
  if (m < toMin(S.open_time) || m > lastSeatingMin()) return 'hours';
  if (date) {
    const startUtc = new Date(localToUtcISO(date, hhmm)).getTime();
    if (startUtc < Date.now() + S.min_notice_minutes * 60000) return 'notice';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Guest copy (small fixed pools; deterministic)
// ---------------------------------------------------------------------------
const COPY = {
  greet: () => pick([
    `Hi, welcome to ${S.venue_name}. I can book a table for you. What day would you like to come?`,
    `Hello, thanks for messaging ${S.venue_name}. I can reserve a table for you. Which day works?`,
  ]),
  askDate: () => pick(['What day would you like to come?', 'Which day should I book it for?']),
  askTime: (date) => pick([`What time on ${fmtDate(date)}?`, `And what time should I put down for ${fmtDate(date)}?`]),
  askGuests: () => pick(['How many guests will there be?', 'How many guests should I book for?']),
  askName: () => pick(['And what name should I put it under?', 'What name is the reservation for?']),
  pastDate: () => 'That date has already passed. Which day would you like instead?',
  tooFar: () => `I can only book up to ${S.max_days_ahead} days ahead. Which day would you like instead?`,
  closedDay: (date) => `We are closed on ${WD_TITLE[dowOf(date)]}s. Which other day works for you?`,
  badHours: () => `We take reservations between ${fmtTime(S.open_time)} and ${fmtTime(fromMin(lastSeatingMin()))}. What time within that works for you?`,
  tooSoon: () => `I need at least ${S.min_notice_minutes >= 60 ? Math.round(S.min_notice_minutes / 60) + ' hour' + (S.min_notice_minutes >= 120 ? 's' : '') : S.min_notice_minutes + ' minutes'} notice for a reservation. Could you pick a later time?`,
  bigParty: () => `For more than ${S.max_guests_per_booking} guests I need to check with the team. I have passed your request on and someone will message you shortly.`,
  badGuests: () => 'How many guests should I book for? Please send a number.',
  confirmed: (r, name) => `Your table is booked ✅\n\nRef: ${r.ref}\nName: ${name}\n${describe(r)}\n\nTo change or cancel, just message me here.`,
  updated: (r) => `Done, your reservation is updated ✅\n\nRef: ${r.ref}\n${describe(r)}`,
  full: (date, hhmm, alts) => alts.length
    ? `Sorry, ${fmtTime(hhmm)} on ${fmtDate(date)} is fully booked. These times still have space: ${alts.slice(0, 4).map(fmtTime).join(', ')}. Which would you like?`
    : `Sorry, ${fmtDate(date)} is fully booked. Would you like to try another day?`,
  nothing: () => 'You do not have an upcoming reservation with us. Would you like to book a table?',
  status: (rows) => rows.length === 1
    ? `You have a table booked: ${describe(rows[0])} (Ref ${rows[0].ref}).`
    : `You have ${rows.length} upcoming reservations:\n${rows.map((r) => `${r.ref}: ${describe(r)}`).join('\n')}`,
  confirmCancel: (r) => `Do you want me to cancel ${describe(r)} (Ref ${r.ref})? Reply YES to confirm.`,
  cancelled: (r) => `Your reservation for ${describe(r)} is cancelled. You are welcome to book again any time.`,
  keep: () => 'No problem, your reservation stays as it is.',
  whichCancel: (rows) => `Which reservation should I cancel? Reply with the ref:\n${rows.map((r) => `${r.ref}: ${describe(r)}`).join('\n')}`,
  whatChange: () => 'Sure, what would you like to change: the day, the time or the number of guests?',
  textOnly: () => 'I can only read text messages for now. Could you type that out for me?',
  handoff: () => 'Good question, let me check with the team. Someone will get back to you shortly.',
  dropped: () => 'Okay, I have dropped that request. Message me any time you want a table.',
};

// ---------------------------------------------------------------------------
// Reading the guest's message into fields
// ---------------------------------------------------------------------------
const AFFIRM = /^\s*(y|yes|yeah|yh|yep|yup|sure|ok|okay|please do|do it|confirm|go ahead)\b/i;
const NEGATE = /^\s*(n|no|nope|nah|don'?t|do not|keep it|leave it)\b/i;
const CANCEL_WORDS = /\b(cancel|call off|scrap)\b/i;

const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
function explicitDate(text) {
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const dm = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i)
    || null;
  if (dm) {
    const mi = MONTHS.map((m) => m.toLowerCase()).indexOf(dm[2].toLowerCase());
    const y = nowLocal().getUTCFullYear();
    let cand = `${y}-${pad(mi + 1)}-${pad(parseInt(dm[1], 10))}`;
    if (cand < todayStr()) cand = `${y + 1}-${pad(mi + 1)}-${pad(parseInt(dm[1], 10))}`;
    return cand;
  }
  const md = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (md) return explicitDate(`${md[2]} ${md[1]}`);
  return null;
}
// Rule based reader, used only when the model is unavailable. Conservative: anything unclear stays null.
function fallbackRead(t, draft, out) {
  const lower = t.toLowerCase();
  if (/\b(do i have|my (booking|reservation)|what time is my)\b/.test(lower)) { out.intent = 'status'; return out; }
  if (CANCEL_WORDS.test(lower)) { out.intent = 'cancel'; return out; }
  if (/\b(change|move|reschedule|switch|update)\b/.test(lower)) out.intent = 'change';
  out.date = resolveRelativeDate(lower) || explicitDate(lower);
  if (!out.date && /\byesterday\b/.test(lower)) out.date = addDaysISO(todayStr(), -1);
  const tm = lower.match(/\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2}|noon)\b/);
  if (tm) out.time = parseTime(tm[1]);
  else if (draft.asking === 'time') out.time = parseTime(lower);
  const gm = lower.match(/\b(?:for|table for|party of|we are|we're|total of)\s+(\d{1,2})\b(?!\s*(?:am|pm|:))/)
    || lower.match(/\b(\d{1,2})\s*(?:people|persons|person|guests|guest|pax|of us|adults)\b/);
  if (gm) out.guests = parseInt(gm[1], 10);
  else {
    const wm = lower.match(/\b(?:for|party of)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/)
      || lower.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:people|persons|guests|of us)\b/);
    if (wm) out.guests = NUM_WORDS[wm[1]];
    else if (draft.asking === 'guests' && NUM_WORDS[lower.trim()]) out.guests = NUM_WORDS[lower.trim()];
  }
  const nm = t.match(/\b(?:my name is|name is|name's|name|it'?s|this is|i am|i'm|under)\s+([A-Za-z][A-Za-z' ]{1,30}?)(?=[.,!?]|$|\s+(?:and|for|on|at)\b)/i);
  if (nm) out.name = nm[1].trim();
  const gotFields = out.date || out.time || out.guests !== null;
  if (!out.intent) {
    if (gotFields || /\b(book|reserve|reservation|table)\b/.test(lower)) out.intent = 'reserve';
    else if (draft.asking === 'name' || draft.asking === 'change') out.intent = 'reserve';
    else if (/\?|^(what|where|when|how|do you|is there|are you|can you|which)\b/.test(lower)) { out.intent = 'info'; out.question = t; }
    else if (/^(hi|hello|hey|good (morning|afternoon|evening)|yo)\b/.test(lower)) out.intent = 'greeting';
    else out.intent = 'other';
  }
  return out;
}

async function readMessage(text, draft, existingCount) {
  const asking = draft.asking || null;
  const t = String(text || '').trim();
  const out = { intent: null, date: null, date_phrase: null, time: null, guests: null, name: null, question: null };

  // deterministic fast paths for plain answers to what we just asked
  if (asking === 'guests' && /^\d{1,3}$/.test(t)) { out.intent = 'reserve'; out.guests = parseInt(t, 10); return out; }
  if (asking === 'time') { const tm = parseTime(t); if (tm && t.length <= 12) { out.intent = 'reserve'; out.time = tm; return out; } }

  const ctx = {
    today: todayStr(),
    weekday: WD_TITLE[dowOf(todayStr())],
    bot_just_asked_for: asking,
    draft_so_far: { date: draft.date || null, time: draft.time || null, guests: draft.guests || null, name: draft.name || null },
    guest_has_upcoming_reservation: existingCount > 0,
  };
  const res = await askOpenAIJson(
    `You read a WhatsApp message from a guest of a venue that takes table reservations and extract fields. You do not reply to the guest.
Context: ${JSON.stringify(ctx)}
Return ONLY JSON: {"intent": "reserve|change|cancel|status|info|greeting|other", "date": "YYYY-MM-DD or null", "date_phrase": "the exact words the guest used for the day, or null", "time_text": "the exact words used for the time, or null", "guests": integer or null, "name": "the guest's own name or null", "question": "the guest's question text if intent is info, else null"}
Rules:
- intent reserve: wants a table or is giving booking details (day, time, number of guests). change: wants to alter an existing reservation. cancel: wants to cancel. status: asks whether/when they have a booking. info: asks a question about the venue (hours, menu, location, parking...). greeting: only hello. other: thanks, ok, anything else.
- date: only if the guest named a specific calendar date (like "28 Nov" or "the 5th of December"); resolve to YYYY-MM-DD using today's date, choosing the next future occurrence. For relative phrases like "tomorrow", "friday", "next week" leave date null and put the words in date_phrase.
- time_text: copy the words exactly (e.g. "7pm", "around 8:30", "7"). Never convert.
- guests: the number of people attending ("table for 4", "me and 3 friends" is 4, "two of us" is 2). If the bot just asked for guests and the guest answers with a number, that is guests. Not a count of tables.
- name: only when the guest states their name ("it's Ada", "name is Tunde") or the bot just asked for the name and the reply is a name. Never invent one.
- Use null for anything not stated. Do not guess.`,
    t
  );
  if (!res) return fallbackRead(t, draft, out); // OpenAI down / key invalid: rule based reading
  out.intent = ['reserve', 'change', 'cancel', 'status', 'info', 'greeting', 'other'].includes(res.intent) ? res.intent : 'other';
  out.date = typeof res.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(res.date) ? res.date : null;
  out.date_phrase = res.date_phrase || null;
  out.time = parseTime(res.time_text);
  out.guests = Number.isInteger(res.guests) ? res.guests : null;
  out.name = typeof res.name === 'string' && res.name.trim() ? res.name.trim().slice(0, 60) : null;
  out.question = res.question || null;
  // relative phrases win over anything the model computed
  const rel = resolveRelativeDate(`${res.date_phrase || ''} ${t}`);
  if (rel) out.date = rel;
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const input = $input.first().json.body || $input.first().json;
const from = input.from_number;
const rawText = input.text;
const role = input.role || 'customer';
CURRENT_SENDER = from;

async function loadSettings() {
  try {
    const rows = await sbRequest('GET', 'reservation_settings?id=eq.1&select=*');
    if (rows[0]) S = { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.entries(rows[0]).filter(([, v]) => v !== null)) };
  } catch (e) {}
}

// ===================== STAFF =====================
function parseWhen(text) {
  // returns { date, time } from free staff text like "fri 8pm", "tomorrow 7:30pm", "2026-12-05 19:00"
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  let date = iso ? iso[1] : resolveRelativeDate(text);
  if (!date) {
    const dm = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i);
    if (dm) {
      const mi = MONTHS.map((m) => m.toLowerCase()).indexOf(dm[2].toLowerCase());
      let y = nowLocal().getUTCFullYear();
      let cand = `${y}-${pad(mi + 1)}-${pad(parseInt(dm[1], 10))}`;
      if (cand < todayStr()) cand = `${y + 1}-${pad(mi + 1)}-${pad(parseInt(dm[1], 10))}`;
      date = cand;
    }
  }
  const tm = text.match(/\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2}|noon)\b/i);
  return { date, time: tm ? parseTime(tm[1]) : null };
}
const STAFF_HELP = [
  'Staff commands:',
  'today / tomorrow / list fri / list 5 dec',
  'cancel R-1234 [reason]',
  'move R-1234 to fri 8pm',
  'guests R-1234 6',
  'tell 2348012345678 your message',
  'lookup 2348012345678',
].join('\n');

async function listDay(date) {
  const from_ = localToUtcISO(date, '00:00');
  const to_ = localToUtcISO(addDaysISO(date, 1), '00:00');
  const rows = await sbRequest('GET', `reservations?status=eq.confirmed&starts_at=gte.${enc(from_)}&starts_at=lt.${enc(to_)}&select=*&order=starts_at.asc`);
  if (!rows.length) return `No reservations for ${fmtDate(date)}.`;
  const total = rows.reduce((a, r) => a + r.guests, 0);
  return `${fmtDate(date)}: ${rows.length} bookings, ${total} guests\n` +
    rows.map((r) => `${r.ref} ${fmtTime(utcToLocalParts(r.starts_at).time)} ${r.guest_name || 'Guest'} x${r.guests}`).join('\n');
}

async function handleStaff() {
  const t = String(rawText || '').trim();
  const lower = t.toLowerCase();
  if (!t) { await send(from, STAFF_HELP); return { staff: 'help' }; }

  if (/^(today|tomorrow)\b/.test(lower)) {
    const d = lower.startsWith('today') ? todayStr() : addDaysISO(todayStr(), 1);
    await send(from, await listDay(d));
    return { staff: 'list' };
  }
  let m = lower.match(/^(list|show|bookings)\s+(.+)$/);
  if (m) {
    const w = parseWhen(m[2]);
    if (!w.date) { await send(from, 'Which day? e.g. list fri or list 5 dec'); return { staff: 'list-nodate' }; }
    await send(from, await listDay(w.date));
    return { staff: 'list' };
  }
  m = t.match(/^cancel\s+(R-\d{4})\s*(.*)$/i);
  if (m) {
    const ref = m[1].toUpperCase();
    const rows = await sbRequest('GET', `reservations?ref=eq.${ref}&select=*`);
    const r = rows[0];
    if (!r) { await send(from, `I can not find ${ref}.`); return { staff: 'cancel-notfound' }; }
    if (r.status !== 'confirmed') { await send(from, `${ref} is already ${r.status}.`); return { staff: 'cancel-noop' }; }
    await sbRequest('PATCH', `reservations?ref=eq.${ref}`, { status: 'cancelled', cancelled_by: 'staff', updated_at: new Date().toISOString() });
    const reason = m[2].trim();
    await send(r.phone_number, `Sorry, we had to cancel your reservation for ${describe(r)} (Ref ${ref}).${reason ? ' ' + reason : ''} Message me here and I will help you rebook.`, 'your reservation');
    await send(from, `${ref} cancelled and the guest has been told.`);
    return { staff: 'cancel' };
  }
  m = t.match(/^move\s+(R-\d{4})\s+(?:to\s+)?(.+)$/i);
  if (m) {
    const ref = m[1].toUpperCase();
    const rows = await sbRequest('GET', `reservations?ref=eq.${ref}&select=*`);
    const r = rows[0];
    if (!r || r.status !== 'confirmed') { await send(from, `${ref} is not an active reservation.`); return { staff: 'move-noop' }; }
    const cur = utcToLocalParts(r.starts_at);
    const w = parseWhen(m[2]);
    const date = w.date || cur.date;
    const time = w.time || cur.time;
    if (!w.date && !w.time) { await send(from, 'I did not catch the new day or time. Example: move R-1234 to fri 8pm'); return { staff: 'move-bad' }; }
    if (!(await hasRoom(date, time, r.guests, ref))) { await send(from, `No room for ${r.guests} at ${fmtTime(time)} on ${fmtDate(date)}.`); return { staff: 'move-full' }; }
    const upd = await sbRequest('PATCH', `reservations?ref=eq.${ref}`, { starts_at: localToUtcISO(date, time), updated_at: new Date().toISOString() }, { Prefer: 'return=representation' });
    await send(r.phone_number, `Your reservation has been moved: ${describe(upd[0])} (Ref ${ref}). Message me here if that does not work for you.`, 'your reservation');
    await send(from, `${ref} moved to ${describe(upd[0])} and the guest has been told.`);
    return { staff: 'move' };
  }
  m = t.match(/^guests\s+(R-\d{4})\s+(\d{1,3})$/i);
  if (m) {
    const ref = m[1].toUpperCase();
    const n = parseInt(m[2], 10);
    const rows = await sbRequest('GET', `reservations?ref=eq.${ref}&select=*`);
    const r = rows[0];
    if (!r || r.status !== 'confirmed') { await send(from, `${ref} is not an active reservation.`); return { staff: 'guests-noop' }; }
    const p = utcToLocalParts(r.starts_at);
    if (!(await hasRoom(p.date, p.time, n, ref))) { await send(from, `No room for ${n} guests at that time.`); return { staff: 'guests-full' }; }
    const upd = await sbRequest('PATCH', `reservations?ref=eq.${ref}`, { guests: n, updated_at: new Date().toISOString() }, { Prefer: 'return=representation' });
    await send(r.phone_number, `Your reservation is updated: ${describe(upd[0])} (Ref ${ref}).`, 'your reservation');
    await send(from, `${ref} now ${guestWord(n)}; the guest has been told.`);
    return { staff: 'guests' };
  }
  m = t.match(/^tell\s+\+?(\d{10,15})\s+([\s\S]+)$/i);
  if (m) {
    await send(m[1], m[2].trim(), 'a message from the team');
    await send(from, `Sent to ${m[1]}.`);
    return { staff: 'tell' };
  }
  m = lower.match(/^lookup\s+\+?(\d{10,15})$/);
  if (m) {
    const rows = await upcomingFor(m[1]);
    await send(from, rows.length ? rows.map((r) => `${r.ref} ${describe(r)}`).join('\n') : 'No upcoming reservations for that number.');
    return { staff: 'lookup' };
  }
  await send(from, STAFF_HELP);
  return { staff: 'help' };
}

// ===================== GUEST =====================
async function handleGuest() {
  // contact: create as customer only when new, never touch an existing role
  let contacts = await sbRequest('GET', `contacts?phone_number=eq.${enc(from)}&select=*`);
  let contact = contacts[0];
  if (!contact) {
    const created = await sbRequest('POST', 'contacts', { phone_number: from, role: 'customer' }, { Prefer: 'return=representation' });
    contact = created[0];
  }

  const drafts = await sbRequest('GET', `reservation_drafts?phone_number=eq.${enc(from)}&select=*`);
  let draft = (drafts[0] && drafts[0].data) || {};
  const draftAge = drafts[0] ? Date.now() - new Date(drafts[0].updated_at).getTime() : 0;
  if (draftAge > 6 * 3600000) draft = {}; // stale half finished request
  if (input.whatsapp_message_id && draft.last_msg_id === input.whatsapp_message_id) return { duplicate: true };
  draft.last_msg_id = input.whatsapp_message_id || null;

  await logMsg(from, 'inbound', rawText || `[${input.media_type || 'media'}]`);

  async function saveDraft() {
    await sbRequest('POST', 'reservation_drafts', { phone_number: from, data: draft, updated_at: new Date().toISOString() }, { Prefer: 'resolution=merge-duplicates' });
  }
  async function clearDraft() {
    draft = { last_msg_id: draft.last_msg_id };
    await saveDraft();
  }
  async function say(text) { await send(from, text); await saveDraft(); return { reply: text }; }

  if (!rawText) { return say(COPY.textOnly()); }

  const upcoming = await upcomingFor(from);

  // 1. yes/no to a pending cancel confirmation
  if (draft.pending_cancel) {
    const target = upcoming.find((r) => r.ref === draft.pending_cancel);
    if (AFFIRM.test(rawText) && target) {
      await sbRequest('PATCH', `reservations?ref=eq.${target.ref}`, { status: 'cancelled', cancelled_by: 'guest', updated_at: new Date().toISOString() });
      draft.pending_cancel = null;
      await notifyStaff(`Reservation cancelled by guest: ${target.ref} ${target.guest_name || ''} ${describe(target)} (${from})`, 'a cancelled reservation');
      return say(COPY.cancelled(target));
    }
    draft.pending_cancel = null;
    if (NEGATE.test(rawText) || AFFIRM.test(rawText)) return say(COPY.keep());
    // anything else: fall through and treat as a normal message
  }

  // 2. which reservation to cancel (guest replied with a ref)
  const refInText = String(rawText).match(/\bR-?(\d{4})\b/i);
  const readRes = await readMessage(rawText, draft, upcoming.length);
  let intent = readRes.intent;
  if (CANCEL_WORDS.test(rawText) && !/\b(don'?t|do not|not)\s+cancel\b/i.test(rawText)) intent = 'cancel';

  // Abandoning a half finished request
  if (intent === 'cancel' && (draft.date || draft.time || draft.guests) && !draft.change_ref && upcoming.length === 0) {
    await clearDraft();
    return say(COPY.dropped());
  }

  if (intent === 'cancel') {
    if (upcoming.length === 0) return say(COPY.nothing());
    let target = null;
    if (refInText) target = upcoming.find((r) => r.ref === `R-${refInText[1]}`);
    else if (upcoming.length === 1) target = upcoming[0];
    if (!target) return say(COPY.whichCancel(upcoming));
    draft.pending_cancel = target.ref;
    return say(COPY.confirmCancel(target));
  }

  if (intent === 'status') {
    return say(upcoming.length ? COPY.status(upcoming) : COPY.nothing());
  }

  if (intent === 'info') {
    const kb = await sbRequest('GET', 'knowledge_base?select=question,answer');
    const facts = {
      venue: S.venue_name,
      opening_hours: `${S.open_time} to ${S.close_time}`,
      last_reservation_time: fromMin(lastSeatingMin()),
      closed_days: (S.closed_weekdays || []).map((d) => WD_TITLE[d]),
      max_guests_per_reservation: S.max_guests_per_booking,
      notes: S.venue_notes || null,
      faq: kb,
    };
    const ans = await askOpenAIJson(
      `You answer a guest's question for a venue using ONLY these facts: ${JSON.stringify(facts)}
Reply ONLY with JSON: {"found": true|false, "answer": "short friendly answer, plain text, no hyphens or asterisks"}. If the facts do not clearly answer it, found must be false. Never invent anything.`,
      readRes.question || rawText
    );
    if (ans && ans.found && ans.answer) {
      const tail = draft.asking ? ' ' + (draft.asking === 'date' ? COPY.askDate() : '') : '';
      return say(stripMarkdown(ans.answer) + tail);
    }
    await notifyStaff(`Guest question from ${from}: "${(readRes.question || rawText).slice(0, 300)}". Reply with: tell ${from} your answer`, 'a guest question');
    return say(COPY.handoff());
  }

  // reserve / change / greeting / other: all go through the slot filler
  const editing = !!draft.change_ref;
  if (intent === 'change' && upcoming.length > 0 && !editing) {
    const target = refInText ? upcoming.find((r) => r.ref === `R-${refInText[1]}`) : upcoming[0];
    if (target) {
      const p = utcToLocalParts(target.starts_at);
      draft = { last_msg_id: draft.last_msg_id, change_ref: target.ref, date: p.date, time: p.time, guests: target.guests, name: target.guest_name, asking: null };
      const gotNew = readRes.date || readRes.time || readRes.guests;
      if (!gotNew) { draft.asking = 'change'; return say(COPY.whatChange()); }
    }
  }
  if (intent === 'greeting' && !draft.date && !draft.time && !draft.guests) {
    draft.asking = 'date';
    return say(COPY.greet());
  }
  if (intent === 'other' && !draft.asking && !readRes.date && !readRes.time && !readRes.guests) {
    // thanks / ok / unrelated with nothing in progress
    draft.asking = 'date';
    return say(upcoming.length ? 'Anything else I can help with? You can ask me to change or cancel your reservation, or book another table.' : COPY.greet());
  }

  // merge extracted fields, validating each as it arrives
  const problems = [];
  if (readRes.date) {
    const v = validateDate(readRes.date);
    if (v) { problems.push(v === 'past' ? COPY.pastDate() : v === 'toofar' ? COPY.tooFar() : COPY.closedDay(readRes.date)); draft.date = null; }
    else draft.date = readRes.date;
  }
  if (readRes.time) {
    const v = validateTime(draft.date || null, readRes.time);
    if (v === 'hours') { problems.push(COPY.badHours()); draft.time = null; }
    else if (v === 'notice') { problems.push(COPY.tooSoon()); draft.time = null; }
    else draft.time = readRes.time;
  }
  if (readRes.guests !== null) {
    if (readRes.guests < 1) problems.push(COPY.badGuests());
    else if (readRes.guests > S.max_guests_per_booking) {
      await notifyStaff(`Large party request from ${from} (${contact.name || 'guest'}): ${readRes.guests} guests${draft.date ? ' on ' + fmtDate(draft.date) : ''}${draft.time ? ' at ' + fmtTime(draft.time) : ''}. Reply with: tell ${from} your answer`, 'a large party request');
      draft.guests = null;
      await clearDraft();
      return say(COPY.bigParty());
    } else draft.guests = readRes.guests;
  }
  if (readRes.name) draft.name = readRes.name;
  else if (draft.asking === 'name' && !draft.name) {
    const t = String(rawText).trim();
    if (t.length >= 2 && t.length <= 40 && !/\d/.test(t) && !/\?/.test(t)) draft.name = t.replace(/^(it'?s|its|my name is|name is|i am|i'm)\s+/i, '').trim();
  }
  if (draft.name && !contact.name) {
    try { await sbRequest('PATCH', `contacts?id=eq.${contact.id}`, { name: draft.name }); contact.name = draft.name; } catch (e) {}
  }
  // time was validated before the date might have changed: re-check the pair
  if (draft.date && draft.time) {
    const v = validateTime(draft.date, draft.time);
    if (v === 'notice') { problems.push(COPY.tooSoon()); draft.time = null; }
  }

  if (problems.length) {
    draft.asking = !draft.date ? 'date' : !draft.time ? 'time' : 'guests';
    return say(problems[0]);
  }

  const nameForBooking = draft.name || contact.name || null;
  if (!draft.date) { draft.asking = 'date'; return say(COPY.askDate()); }
  if (!draft.time) { draft.asking = 'time'; return say(COPY.askTime(draft.date)); }
  if (!draft.guests) { draft.asking = 'guests'; return say(COPY.askGuests()); }
  if (!nameForBooking) { draft.asking = 'name'; return say(COPY.askName()); }

  // everything known: capacity check, then write
  const excl = draft.change_ref || null;
  if (!(await hasRoom(draft.date, draft.time, draft.guests, excl))) {
    const alts = await alternativeTimes(draft.date, draft.guests, excl);
    const badTime = draft.time;
    draft.time = null;
    draft.asking = alts.length ? 'time' : 'date';
    if (!alts.length) draft.date = null;
    return say(COPY.full(readRes.date || draft.date || todayStr(), badTime, alts));
  }

  if (excl) {
    const upd = await sbRequest('PATCH', `reservations?ref=eq.${excl}`, {
      starts_at: localToUtcISO(draft.date, draft.time), guests: draft.guests, guest_name: nameForBooking, updated_at: new Date().toISOString(),
    }, { Prefer: 'return=representation' });
    await notifyStaff(`Reservation changed by guest: ${excl} ${nameForBooking} ${describe(upd[0])} (${from})`, 'a changed reservation');
    await clearDraft();
    await send(from, COPY.updated(upd[0]));
    return { updated: excl };
  }
  const r = await createReservation({
    phone_number: from, contact_id: contact.id, guest_name: nameForBooking, guests: draft.guests,
    starts_at: localToUtcISO(draft.date, draft.time), status: 'confirmed',
  });
  await notifyStaff(`New reservation ${r.ref}: ${nameForBooking}, ${describe(r)} (${from})`, 'a new reservation');
  await clearDraft();
  await send(from, COPY.confirmed(r, nameForBooking));
  return { created: r.ref };
}

// ---------------------------------------------------------------------------
await loadSettings();
let result;
try {
  result = STAFF_ROLES.includes(role) ? await handleStaff() : await handleGuest();
} catch (err) {
  try { await send(from, 'Sorry, something went wrong on our side. Please try again in a moment.'); } catch (e) {}
  throw err;
}
return [{ json: result || {} }];

// Bali's own native WhatsApp form (a WhatsApp "Flow"). It opens INSIDE WhatsApp, no website, and runs the whole
// reservation: details -> live availability -> payment -> confirmation. The screens below are static; the live bits
// (today's date range, closed days, time slots) are sent with every message, and the server answers each step
// (lib/flowendpoint.js) so availability and payment are always current.
const fs = require('fs');
const path = require('path');
const { makeTime } = require('./core');

const SCREEN = 'RESERVE';

// Arrival time is picked from two lists (WhatsApp has no native clock): Hour starts at 12 and runs to 23, then 0 to 11
// (Bali is open 24 hours), Minute goes in 5s.
const HOURS = [...Array.from({ length: 12 }, (_, i) => 12 + i), ...Array.from({ length: 12 }, (_, i) => i)].map((h) => ({
  id: String(h).padStart(2, '0'),
  title: `${h % 12 || 12} ${h >= 12 ? 'PM' : 'AM'} (${h})`,
}));
const MINUTES = Array.from({ length: 12 }, (_, i) => ({ id: String(i * 5).padStart(2, '0'), title: ':' + String(i * 5).padStart(2, '0') }));

function flowJson(logoBase64) {
  const opt = { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } };
  const logo = { type: 'Image', src: logoBase64, height: 110, 'scale-type': 'contain' };
  const str = (ex) => ({ type: 'string', __example__: ex });
  return {
    version: '6.2',
    data_api_version: '3.0',
    routing_model: { RESERVE: ['PAY', 'DONE'], PAY: ['DONE'], DONE: [] },
    screens: [
      {
        id: 'RESERVE', title: 'Reserve a table',
        data: {
          intro: str('Tell us when you are coming and we will hold your table.'),
          has_error: { type: 'boolean', __example__: false },
          error: str(' '),
          name_init: str('Ada Okafor'), phone_init: str('+2348012345678'), date_init: str('2026-12-05'), hour_init: str('19'), minute_init: str('00'), guests_init: str('2'),
          min_date: str('2026-12-01'), max_date: str('2027-01-30'),
          unavailable: { type: 'array', items: { type: 'string' }, __example__: ['2026-12-07'] },
          guests_hint: str('Up to 12 guests online'),
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            logo,
            { type: 'TextHeading', text: 'Reserve your table' },
            { type: 'TextBody', text: '${data.intro}' },
            { type: 'TextBody', text: '${data.error}', visible: '${data.has_error}', 'font-weight': 'bold' },
            {
              type: 'Form', name: 'form',
              'init-values': { name: '${data.name_init}', phone: '${data.phone_init}', date: '${data.date_init}', hour: '${data.hour_init}', minute: '${data.minute_init}', guests: '${data.guests_init}' },
              children: [
                { type: 'TextInput', name: 'name', label: 'Full name', 'input-type': 'text', required: true },
                { type: 'TextInput', name: 'phone', label: 'Phone number', 'input-type': 'phone', required: true },
                { type: 'DatePicker', name: 'date', label: 'Date', required: true, 'min-date': '${data.min_date}', 'max-date': '${data.max_date}', 'unavailable-dates': '${data.unavailable}' },
                { type: 'Dropdown', name: 'hour', label: 'Arrival hour', required: true, 'data-source': HOURS },
                { type: 'Dropdown', name: 'minute', label: 'Arrival minutes', required: true, 'data-source': MINUTES },
                { type: 'TextInput', name: 'guests', label: 'Number of guests', 'input-type': 'number', required: true, 'helper-text': '${data.guests_hint}' },
                { type: 'TextCaption', text: 'Powered by ERA Systems' },
                { type: 'Footer', label: 'Continue', 'on-click-action': { name: 'data_exchange', payload: { action: 'reserve', name: '${form.name}', phone: '${form.phone}', date: '${form.date}', hour: '${form.hour}', minute: '${form.minute}', guests: '${form.guests}' } } },
              ],
            },
          ],
        },
      },
      {
        id: 'PAY', title: 'Confirm and pay',
        data: {
          summary: str('Ada Okafor\nFriday 5 Dec at 7pm for 4 guests\nRef R-1234'),
          detail: str('Pay ₦20,500 to confirm your table.'),
          amount_label: str('Pay ₦20,500'),
          pay_url: str('https://checkout.paystack.com/abc'),
          ref: str('R-1234'),
          has_note: { type: 'boolean', __example__: false },
          note: str(' '),
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            logo,
            { type: 'TextHeading', text: 'Confirm and pay' },
            { type: 'TextBody', text: '${data.summary}', 'font-weight': 'bold' },
            { type: 'TextBody', text: '${data.detail}' },
            { type: 'TextBody', text: '${data.note}', visible: '${data.has_note}' },
            { type: 'EmbeddedLink', text: '${data.amount_label}', 'on-click-action': { name: 'open_url', url: '${data.pay_url}' } },
            { type: 'TextCaption', text: 'After paying, come back here and tap "I have paid".' },
            { type: 'Footer', label: 'I have paid', 'on-click-action': { name: 'data_exchange', payload: { action: 'check', ref: '${data.ref}' } } },
          ],
        },
      },
      {
        id: 'DONE', title: 'Table confirmed', terminal: true, success: true,
        data: {
          summary: str('Ada Okafor\nFriday 5 Dec at 7pm for 4 guests\nRef R-1234'),
          credit: str('Your ₦20,000 is credited to your order on the day. Your confirmation and the link to order ahead are in this chat.'),
          ref: str('R-1234'),
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            logo,
            { type: 'TextHeading', text: 'Your table is confirmed ✅' },
            { type: 'TextBody', text: '${data.summary}', 'font-weight': 'bold' },
            { type: 'TextBody', text: '${data.credit}' },
            { type: 'Footer', label: 'Back to chat', 'on-click-action': { name: 'complete', payload: { ref: '${data.ref}' } } },
          ],
        },
      },
    ],
  };
}

function logoBase64() {
  return fs.readFileSync(path.join(__dirname, '..', 'public', 'welcome-flow.jpg')).toString('base64');
}

// the per-send data that makes the static form current
function flowData(S, { intro, nameInit, phoneInit, now } = {}) {
  const T = makeTime(S, now);
  const today = T.todayStr();
  const max = T.addDaysISO(today, S.max_days_ahead);
  const closed = S.closed_weekdays || [];
  const unavailable = [];
  if (closed.length) for (let d = today; d <= max; d = T.addDaysISO(d, 1)) if (closed.includes(T.dowOf(d))) unavailable.push(d);
  const evening = Math.min(Math.max(19 * 60, T.toMin(S.open_time)), T.lastSeatingMin());
  // sensible, VALID defaults so the form starts filled: the next open day, 7pm (or the first slot), 2 guests
  let first = T.addDaysISO(today, 1);
  while (first <= max && closed.includes(T.dowOf(first))) first = T.addDaysISO(first, 1);
  return {
    intro: intro || 'Tell us when you are coming and we will hold your table.',
    has_error: false, error: ' ',
    name_init: nameInit || '', phone_init: phoneInit || '',
    date_init: first <= max ? first : today, hour_init: String(Math.floor(evening / 60)).padStart(2, '0'), minute_init: String(Math.floor((evening % 60) / 5) * 5).padStart(2, '0'), guests_init: '2',
    min_date: today, max_date: max, unavailable: unavailable.length ? unavailable : ['2000-01-01'], // an empty list is rejected by WhatsApp
    guests_hint: S.max_guests_per_booking > 0 ? `Up to ${S.max_guests_per_booking} guests online` : 'Any number of guests',
  };
}

// DatePicker returns YYYY-MM-DD (newer) or a millisecond timestamp (older). Accept both.
function normalizeDate(v, S) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{11,14}$/.test(s)) return makeTime(S).isoDate(new Date(Number(s) + S.tz_offset_minutes * 60000));
  return s;
}

// What a guest types: 7pm, 7:30 PM, 7.30pm, 19:30, 0030, noon, midnight. Returns HH:MM, or null when it is ambiguous
// (a bare 7:30 could be morning or evening, so we ask rather than guess: Bali is open 24 hours).
function parseArrival(raw) {
  const t = String(raw || '').toLowerCase().replace(/\./g, ':').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (/^noon$|^midday$/.test(t)) return '12:00';
  if (/^midnight$/.test(t)) return '00:00';
  const m = t.match(/^(\d{1,2})(?::?(\d{2}))?\s*(a|p)\s*m?:?$/) || t.match(/^(\d{1,2})(?::?(\d{2}))?\s*()$/);
  if (!m) return null;
  let h = Number(m[1]); const min = m[2] ? Number(m[2]) : 0; const mer = m[3];
  if (min > 59) return null;
  if (mer) { if (h < 1 || h > 12) return null; if (mer === 'p' && h < 12) h += 12; if (mer === 'a' && h === 12) h = 0; }
  else {
    // no AM/PM: only unambiguous 24 hour writing is accepted (19:30, 07:30, 0030, 1930, 13:00). 7:30 or 730 could be either half of the day.
    const compact = /^\d{4}$/.test(t);
    const written24 = h >= 13 || h === 0 || /^0\d/.test(t) || compact;
    if (!written24 || h > 23) return null;
  }
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// What the form/webhook hands us as the time -> HH:MM, or the original text unchanged when it is ambiguous so validation asks again.
function normalizeTime(v) {
  const raw = String(v || '').trim();
  const noSeconds = raw.replace(/^(d{1,2}:d{2}):d{2}(?=s*[ap]?m?$|$)/i, '$1');
  return parseArrival(noSeconds) || raw;
}

module.exports = { SCREEN, flowJson, logoBase64, flowData, normalizeDate, normalizeTime, parseArrival };

// Bali's own native WhatsApp form (a WhatsApp "Flow"). It opens INSIDE WhatsApp, no website, and runs the whole
// reservation: details -> live availability -> payment -> confirmation. The screens below are static; the live bits
// (today's date range, closed days, time slots) are sent with every message, and the server answers each step
// (lib/flowendpoint.js) so availability and payment are always current.
const fs = require('fs');
const path = require('path');
const { makeTime } = require('./core');

const SCREEN = 'RESERVE';

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
          name_init: str('Ada Okafor'), phone_init: str('+2348012345678'), date_init: str('2026-12-05'), time_init: str('19:00'), guests_init: str('2'),
          min_date: str('2026-12-01'), max_date: str('2027-01-30'),
          unavailable: { type: 'array', items: { type: 'string' }, __example__: ['2026-12-07'] },
          times: { ...opt, __example__: [{ id: '19:15', title: '7:15 PM' }] },
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
              'init-values': { name: '${data.name_init}', phone: '${data.phone_init}', date: '${data.date_init}', time: '${data.time_init}', guests: '${data.guests_init}' },
              children: [
                { type: 'TextInput', name: 'name', label: 'Full name', 'input-type': 'text', required: true },
                { type: 'TextInput', name: 'phone', label: 'Phone number', 'input-type': 'phone', required: true },
                { type: 'DatePicker', name: 'date', label: 'Date', required: true, 'min-date': '${data.min_date}', 'max-date': '${data.max_date}', 'unavailable-dates': '${data.unavailable}' },
                { type: 'Dropdown', name: 'time', label: 'Arrival time', required: true, 'data-source': '${data.times}' },
                { type: 'TextInput', name: 'guests', label: 'Number of guests', 'input-type': 'number', required: true, 'helper-text': '${data.guests_hint}' },
                { type: 'TextCaption', text: 'Managed by ERA Systems' },
                { type: 'Footer', label: 'Continue', 'on-click-action': { name: 'data_exchange', payload: { action: 'reserve', name: '${form.name}', phone: '${form.phone}', date: '${form.date}', time: '${form.time}', guests: '${form.guests}' } } },
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
          credit: str('Your ₦20,000 is credited to your order on the day.'),
          order_url: str('https://baliabuja.mylo.africa'),
          ref: str('R-1234'),
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            logo,
            { type: 'TextHeading', text: 'Your table is confirmed ✅' },
            { type: 'TextBody', text: '${data.summary}', 'font-weight': 'bold' },
            { type: 'TextBody', text: '${data.credit}' },
            { type: 'EmbeddedLink', text: 'Place your order', 'on-click-action': { name: 'open_url', url: '${data.order_url}' } },
            { type: 'Footer', label: 'Done', 'on-click-action': { name: 'complete', payload: { ref: '${data.ref}' } } },
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
  const times = [];
  for (let m = T.toMin(S.open_time); m <= T.lastSeatingMin(); m += 15) times.push({ id: T.fromMin(m), title: `${Math.floor(m / 60) % 12 || 12}:${String(m % 60).padStart(2, '0')} ${m >= 720 ? 'PM' : 'AM'}` });
  // sensible, VALID defaults so the form starts filled: the next open day, 7pm (or the first slot), 2 guests
  let first = T.addDaysISO(today, 1);
  while (first <= max && closed.includes(T.dowOf(first))) first = T.addDaysISO(first, 1);
  const prefer = times.find((t) => t.id === '19:00') || times[0];
  return {
    intro: intro || 'Tell us when you are coming and we will hold your table.',
    has_error: false, error: ' ',
    name_init: nameInit || '', phone_init: phoneInit || '',
    date_init: first <= max ? first : today, time_init: prefer ? prefer.id : '', guests_init: '2',
    min_date: today, max_date: max, unavailable: unavailable.length ? unavailable : ['2000-01-01'], // an empty list is rejected by WhatsApp
    times, guests_hint: `Up to ${S.max_guests_per_booking} guests online`,
  };
}

// DatePicker returns YYYY-MM-DD (newer) or a millisecond timestamp (older). Accept both.
function normalizeDate(v, S) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{11,14}$/.test(s)) return makeTime(S).isoDate(new Date(Number(s) + S.tz_offset_minutes * 60000));
  return s;
}

// accepts 19:00, 7:15, 19:00:00 or 7:15 PM and returns HH:MM
function normalizeTime(v) {
  const m = String(v || '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?$/i);
  if (!m) return String(v || '');
  let h = Number(m[1]); const mer = (m[3] || '').toLowerCase();
  if (mer === 'pm' && h < 12) h += 12; if (mer === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

module.exports = { SCREEN, flowJson, logoBase64, flowData, normalizeDate, normalizeTime };

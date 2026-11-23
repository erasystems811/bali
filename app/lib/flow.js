// Bali's own native WhatsApp form (a WhatsApp "Flow"). The form opens INSIDE WhatsApp, no website.
// The definition below is static; the live bits (today's date range, closed days, time slots, guest counts) are
// passed in with every send, so the form is always current without re-publishing it.
const fs = require('fs');
const path = require('path');
const { makeTime, WD_TITLE, MONTHS } = require('./core');

const SCREEN = 'RESERVE';

function flowJson(logoBase64) {
  const opt = { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } };
  return {
    version: '6.2',
    screens: [{
      id: SCREEN, title: 'Reserve a table', terminal: true, success: true,
      data: {
        intro: { type: 'string', __example__: 'Tell us when you are coming and we will hold your table.' },
        name_init: { type: 'string', __example__: 'Ada Okafor' },
        phone_init: { type: 'string', __example__: '+2348012345678' },
        min_date: { type: 'string', __example__: '2026-12-01' },
        max_date: { type: 'string', __example__: '2027-01-30' },
        unavailable: { type: 'array', items: { type: 'string' }, __example__: ['2026-12-07'] },
        times: { ...opt, __example__: [{ id: '19:00', title: '7:00 PM' }] },
        guests: { ...opt, __example__: [{ id: '2', title: '2 guests' }] },
      },
      layout: {
        type: 'SingleColumnLayout',
        children: [
          { type: 'Image', src: logoBase64, height: 110, 'scale-type': 'contain' },
          { type: 'TextHeading', text: 'Reserve your table' },
          { type: 'TextBody', text: '${data.intro}' },
          {
            type: 'Form', name: 'form', 'init-values': { name: '${data.name_init}', phone: '${data.phone_init}' },
            children: [
              { type: 'TextInput', name: 'name', label: 'Full name', 'input-type': 'text', required: true },
              { type: 'TextInput', name: 'phone', label: 'Phone number', 'input-type': 'phone', required: true },
              { type: 'DatePicker', name: 'date', label: 'Date', required: true, 'min-date': '${data.min_date}', 'max-date': '${data.max_date}', 'unavailable-dates': '${data.unavailable}' },
              { type: 'Dropdown', name: 'time', label: 'Arrival time', required: true, 'data-source': '${data.times}' },
              { type: 'Dropdown', name: 'guests', label: 'Number of guests', required: true, 'data-source': '${data.guests}' },
              { type: 'Footer', label: 'Continue', 'on-click-action': { name: 'complete', payload: { name: '${form.name}', phone: '${form.phone}', date: '${form.date}', time: '${form.time}', guests: '${form.guests}' } } },
            ],
          },
        ],
      },
    }],
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
  const unavailable = [];
  if ((S.closed_weekdays || []).length) for (let d = today; d <= max; d = T.addDaysISO(d, 1)) if (S.closed_weekdays.includes(T.dowOf(d))) unavailable.push(d);
  const times = [];
  for (let m = T.toMin(S.open_time); m <= T.lastSeatingMin(); m += 30) times.push({ id: T.fromMin(m), title: `${Math.floor(m / 60) % 12 || 12}:${String(m % 60).padStart(2, '0')} ${m >= 720 ? 'PM' : 'AM'}` });
  const guests = Array.from({ length: Math.max(1, S.max_guests_per_booking) }, (_, i) => ({ id: String(i + 1), title: i === 0 ? '1 guest' : `${i + 1} guests` }));
  return {
    intro: intro || 'Tell us when you are coming and we will hold your table.',
    name_init: nameInit || '', phone_init: phoneInit || '',
    min_date: today, max_date: max, unavailable: unavailable.length ? unavailable : ['2000-01-01'], // an empty list is rejected by WhatsApp
    times, guests,
  };
}

// DatePicker returns YYYY-MM-DD (newer) or a millisecond timestamp (older). Accept both.
function normalizeDate(v, S) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{11,14}$/.test(s)) return makeTime(S).isoDate(new Date(Number(s) + S.tz_offset_minutes * 60000));
  return s;
}

module.exports = { SCREEN, flowJson, logoBase64, flowData, normalizeDate };

// Shared helpers: settings, venue-local time (Lagos has no DST so a fixed offset is exact), formatting.
const DEFAULTS = {
  venue_name: 'Bali',
  reminder_hours: 6, // reminder before each reservation, 0 = off
  open_24_7: true, // Bali opens 24 hours: any arrival time is accepted
  open_time: '12:00',
  close_time: '22:00',
  slot_minutes: 60,
  max_guests_per_slot: 0, // 0 = no limit (plenty of tables); set a number to cap guests per time slot
  max_guests_per_booking: 0, // 0 = any number of guests
  min_notice_minutes: 60,
  max_days_ahead: 60,
  closed_weekdays: [],
  tz_offset_minutes: 60,
  venue_notes: '',
  reservation_fee_kobo: 2000000,
  service_fee_kobo: 50000,
  hold_minutes: 15,
  refund_hours: 24,
  order_link: 'https://baliabuja.mylo.africa',
  welcome_image_url: null,
  welcome_text: '*Hey, welcome to Bali!* 👋\n\nTap the button below to make your table reservation.',
  handover_number: null,
  flow_id: null,
  payments_enabled: true,
  enquiry_intro: 'Hi, welcome to Bali. Ask me anything about the venue.',
};

async function loadSettings(ctx) {
  const { rows } = await ctx.pool.query('select * from reservation_settings where id = 1');
  const out = { ...DEFAULTS };
  if (rows[0]) for (const [k, v] of Object.entries(rows[0])) if (v !== null && v !== undefined) out[k] = v;
  if (out.open_24_7) { out.open_time = '00:00'; out.close_time = '24:00'; }
  return out;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WD_TITLE = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

function makeTime(S, nowFn = () => Date.now()) {
  const off = S.tz_offset_minutes * 60000;
  const nowLocal = () => new Date(nowFn() + off);
  const isoDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const todayStr = () => isoDate(nowLocal());
  const addDaysISO = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return isoDate(d); };
  const dowOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
  const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const localToUtcISO = (date, hhmm) => new Date(Date.parse(`${date}T${hhmm}:00Z`) - off).toISOString();
  const utcToLocalParts = (iso) => {
    const d = new Date(new Date(iso).getTime() + off);
    return { date: isoDate(d), time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
  };
  const fmtTime = (hhmm) => {
    let [h, m] = hhmm.split(':').map(Number);
    const suf = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return m === 0 ? `${h}${suf}` : `${h}:${pad(m)}${suf}`;
  };
  const fmtDateFull = (iso) => { const d = new Date(`${iso}T00:00:00Z`); return `${WD_TITLE[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
  const lastSeatingMin = () => (S.open_24_7 ? 1439 : toMin(S.close_time) - S.slot_minutes);
  return { nowLocal, todayStr, addDaysISO, dowOf, toMin, fromMin, localToUtcISO, utcToLocalParts, fmtTime, fmtDateFull, lastSeatingMin, isoDate };
}

const naira = (kobo) => `₦${Math.round(kobo / 100).toLocaleString('en-US')}`;
const guestWord = (n) => (n === 1 ? '1 guest' : `${n} guests`);

// Nigerian numbers: accepts 0803..., +234803..., 234803..., returns digits like 234803... or null
function normalizePhone(raw) {
  let d = String(raw || '').replace(/[^\d]/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0') && d.length === 11) d = '234' + d.slice(1);
  else if (d.length === 10 && /^[789]/.test(d)) d = '234' + d;
  if (d.length < 11 || d.length > 15) return null;
  return d;
}

function randHex(n) { return require('crypto').randomBytes(n).toString('hex'); }

module.exports = { DEFAULTS, loadSettings, makeTime, naira, guestWord, normalizePhone, randHex, WD_TITLE, WEEKDAYS, MONTHS, pad };

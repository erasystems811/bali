// Runs n8n/_src/reservation-code.js against an in-memory fake PostgREST + fake Meta, REAL OpenAI.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = fs.readFileSync(path.join(root, '.env'), 'utf8');
const OPENAI = envFile.match(/^OPENAI_API_KEY=(.*)$/m)[1].trim();
const code = fs.readFileSync(path.join(root, 'n8n/_src/reservation-code.js'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const PK = { reservation_drafts: 'phone_number', reservation_settings: 'id', contacts: 'phone_number', reservations: 'ref' };
export function makeDb() {
  const t = {
    contacts: [],
    reservations: [],
    reservation_drafts: [],
    reservation_log: [],
    reservation_settings: [{ id: 1, venue_name: 'Bali', open_time: '12:00', close_time: '22:00', slot_minutes: 60, max_guests_per_slot: 10, max_guests_per_booking: 8, min_notice_minutes: 60, max_days_ahead: 60, closed_weekdays: [], tz_offset_minutes: 60, venue_notes: '' }],
    knowledge_base: [{ question: 'Do you have parking?', answer: 'Yes, free parking is available on site.' }],
    queued_messages: [],
    sandbox_outbound: [],
  };
  let n = 0;
  return { t, nextId: () => `id-${++n}` };
}
function matchRow(row, key, cond) {
  const v = row[key];
  if (cond.startsWith('eq.')) return String(v) === cond.slice(3);
  if (cond.startsWith('gte.')) return new Date(v) >= new Date(cond.slice(4));
  if (cond.startsWith('lt.')) return new Date(v) < new Date(cond.slice(3));
  if (cond.startsWith('in.(')) return cond.slice(4, -1).split(',').includes(String(v));
  return true;
}
export function makeHelpers(db, sent) {
  return {
    async httpRequest(o) {
      const u = new URL(o.url);
      if (u.hostname === 'api.openai.com') {
        const r = await fetch(o.url, { method: 'POST', headers: o.headers, body: JSON.stringify(o.body) });
        const j = await r.json();
        if (!r.ok) throw new Error('openai ' + JSON.stringify(j));
        return j;
      }
      if (u.hostname === 'graph.facebook.com') {
        sent.push({ to: o.body.to, type: o.body.type, text: o.body.text?.body || o.body.template?.components?.[0]?.parameters?.[0]?.text });
        return { messages: [{ id: 'wamid.' + sent.length }] };
      }
      const table = u.pathname.split('/rest/v1/')[1];
      const rows = db.t[table];
      if (!rows) throw new Error('no table ' + table);
      const params = [...u.searchParams.entries()].filter(([k]) => !['select', 'order', 'limit'].includes(k));
      const filt = (r) => params.every(([k, c]) => matchRow(r, k, c));
      if (o.method === 'GET') {
        let out = rows.filter(filt);
        const ord = u.searchParams.get('order');
        if (ord) {
          const [c, d] = ord.split('.');
          out = [...out].sort((a, b) => (a[c] > b[c] ? 1 : -1) * (d === 'desc' ? -1 : 1));
        }
        const lim = u.searchParams.get('limit');
        if (lim) out = out.slice(0, +lim);
        return JSON.parse(JSON.stringify(out));
      }
      if (o.method === 'POST') {
        const items = Array.isArray(o.body) ? o.body : [o.body];
        const made = [];
        for (const it of items) {
          const row = { id: db.nextId(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...it };
          const pk = PK[table];
          if (pk) {
            const ex = rows.find((r) => r[pk] === row[pk]);
            if (ex) {
              if ((o.headers.Prefer || '').includes('merge-duplicates')) { Object.assign(ex, it); made.push(ex); continue; }
              throw new Error('duplicate ' + table);
            }
          }
          rows.push(row);
          made.push(row);
        }
        return JSON.parse(JSON.stringify(made));
      }
      if (o.method === 'PATCH') {
        const hit = rows.filter(filt);
        hit.forEach((r) => Object.assign(r, o.body));
        return JSON.parse(JSON.stringify(hit));
      }
      if (o.method === 'DELETE') { db.t[table] = rows.filter((r) => !filt(r)); return []; }
    },
  };
}
export async function run(db, sent, msg) {
  const fn = new AsyncFunction('$input', '$env', code);
  const helpers = makeHelpers(db, sent);
  const $env = { SUPABASE_URL: 'http://fake', SUPABASE_SERVICE_KEY: 'k', OPENAI_API_KEY: OPENAI, META_ACCESS_TOKEN: 'tok', META_PHONE_NUMBER_ID: '1' };
  const before = sent.length;
  const res = await fn.call({ helpers }, { first: () => ({ json: { body: { whatsapp_message_id: 'm' + Math.random(), role: 'customer', ...msg } } }) }, $env);
  return { res: res[0].json, replies: sent.slice(before) };
}

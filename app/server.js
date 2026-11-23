// Bali reservations app: WhatsApp webhook + reservation form + enquiry chat + staff dashboard. One process, one database.
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { Pool } = require('pg');
const { loadSettings, makeTime, normalizePhone, naira } = require('./lib/core');
const { createWa } = require('./lib/wa');
const { createPaystack } = require('./lib/paystack');
const { createResv } = require('./lib/resv');
const { createEnquiry } = require('./lib/enquiry');
const pages = require('./views/pages');

async function http(method, url, { headers, body } = {}) {
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  if (!res.ok) { const err = new Error(`HTTP ${res.status} ${url}`); err.body = json || text; throw err; }
  return json;
}

function buildApp(ctx) {
  const { pool, env } = ctx;
  const wa = createWa(ctx);
  const ps = createPaystack(ctx);
  const resv = createResv(ctx, wa, ps);
  const enquiry = createEnquiry(ctx, resv);
  const base = () => (env.APP_BASE_URL || '').replace(/\/$/, '');

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({
    secret: env.SESSION_SECRET || 'dev-secret', resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 },
  }));
  app.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

  // tiny in-memory rate limiter for public POSTs
  const hits = new Map();
  const limited = (key, max, windowMs) => {
    if (ctx.noRateLimit) return false;
    const now = Date.now(); const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now); hits.set(key, arr); return arr.length > max;
  };
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error(e); if (!res.headersSent) res.status(500).json({ error: 'Something went wrong' }); });

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.get('/', (req, res) => res.redirect('/dashboard/'));

  // ===================== WhatsApp webhook =====================
  app.get('/webhook/whatsapp', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === env.META_WEBHOOK_VERIFY_TOKEN) return res.status(200).send(String(req.query['hub.challenge']));
    res.sendStatus(403);
  });

  async function welcomeCard(S, phone) {
    const token = await resv.sessionToken(phone);
    const formUrl = `${base()}/reserve/${token}`;
    const askUrl = `${base()}/ask/${token}`;
    const { rows } = await pool.query('select welcomed_at from web_sessions where token=$1', [token]);
    const recent = rows[0]?.welcomed_at && Date.now() - new Date(rows[0].welcomed_at).getTime() < 12 * 3600000;
    await pool.query('update web_sessions set welcomed_at = now(), last_seen = now() where token=$1', [token]);
    if (recent) {
      await wa.send(phone, `Table reservation: ${formUrl}\nEnquiries: ${askUrl}`, 'your reservation links', { reply: true });
      return;
    }
    await wa.sendCta(phone, {
      image: S.welcome_image_url || `${base()}/assets/welcome.png`,
      body: `${S.welcome_text}\n\nHave a question instead? Tap here to chat: ${askUrl}`,
      button: 'TABLE RESERVATION',
      url: formUrl,
    });
  }

  app.post('/webhook/whatsapp', (req, res) => {
    if (!env.BALI_FORWARD_SECRET || req.query.k !== env.BALI_FORWARD_SECRET) return res.sendStatus(200); // ignore strangers, never reveal
    res.sendStatus(200); // Meta needs a fast 200; process after
    (async () => {
      const S = await loadSettings(ctx);
      const handover = normalizePhone(S.handover_number);
      for (const entry of req.body?.entry || []) for (const ch of entry.changes || []) for (const m of ch.value?.messages || []) {
        const ins = await pool.query('insert into wa_inbound (msg_id) values ($1) on conflict do nothing returning msg_id', [m.id]);
        if (!ins.rows[0]) continue; // duplicate delivery
        const from = m.from;
        await wa.log(from, 'inbound', m.text?.body || `[${m.type}]`);
        await wa.flushQueue(from);
        if (from === handover) continue; // the venue's own number never gets the guest welcome
        await welcomeCard(S, from);
      }
    })().catch((e) => console.error('webhook error', e));
  });

  app.post('/webhook/paystack', (req, res) => {
    res.sendStatus(200);
    const ref = req.body?.event === 'charge.success' && req.body?.data?.reference;
    if (!ref) return;
    (async () => {
      const { rows } = await pool.query('select * from reservations where paystack_ref=$1', [ref]);
      if (rows[0]) await resv.confirmPayment(rows[0]); // re-verified against Paystack, the webhook body is never trusted
    })().catch((e) => console.error('paystack webhook error', e));
  });

  // ===================== guest pages =====================
  async function sessionFor(token) {
    const { rows } = await pool.query('select * from web_sessions where token=$1', [token]);
    return rows[0] || null;
  }
  app.get('/reserve/:token', wrap(async (req, res) => {
    const s = await sessionFor(req.params.token);
    if (!s) return res.status(404).send(pages.notFound());
    const S = await loadSettings(ctx); const T = makeTime(S);
    res.send(pages.form({ S, T, token: req.params.token, phone: s.phone_number, askUrl: `${base()}/ask/${req.params.token}` }));
  }));
  app.post('/api/reserve/:token', wrap(async (req, res) => {
    if (limited(`res:${req.ip}`, 12, 60000)) return res.status(429).json({ errors: { _: 'Too many attempts, please wait a minute.' } });
    const s = await sessionFor(req.params.token);
    if (!s) return res.status(404).json({ errors: { _: 'This link is not valid.' } });
    const out = await resv.createFromForm(req.body || {}, s.phone_number);
    res.status(out.ok ? 200 : 422).json(out);
  }));
  app.get('/reserve/:token/done', wrap(async (req, res) => {
    const s = await sessionFor(req.params.token);
    if (!s) return res.status(404).send(pages.notFound());
    const S = await loadSettings(ctx); const T = makeTime(S);
    const { rows } = await pool.query('select * from reservations where phone_number=$1 and ref=$2', [s.phone_number, String(req.query.ref || '')]);
    let r = rows[0];
    if (!r) return res.status(404).send(pages.notFound());
    let state = r.status;
    if (r.status === 'pending_payment') { const c = await resv.confirmPayment(r); state = c.status; r = (await pool.query('select * from reservations where ref=$1', [r.ref])).rows[0]; }
    res.send(pages.done({ S, T, r, state, token: req.params.token, describe: resv.describe(r, T) }));
  }));

  app.get('/my/:token', wrap(async (req, res) => {
    const s = await sessionFor(req.params.token);
    if (!s) return res.status(404).send(pages.notFound());
    const S = await loadSettings(ctx); const T = makeTime(S);
    const list = await resv.forGuest(s.phone_number);
    res.send(pages.manage({ S, T, token: req.params.token, list: list.map((r) => ({ ...r, text: resv.describe(r, T), hoursAway: (new Date(r.starts_at).getTime() - Date.now()) / 3600000 })) , formUrl: `${base()}/reserve/${req.params.token}` }));
  }));
  app.post('/api/my/:token/cancel', wrap(async (req, res) => {
    const s = await sessionFor(req.params.token);
    if (!s) return res.status(404).json({ error: 'invalid link' });
    const { rows } = await pool.query('select phone_number from reservations where ref=$1', [String(req.body?.ref || '')]);
    if (!rows[0] || rows[0].phone_number !== s.phone_number) return res.status(404).json({ error: 'not found' });
    res.json(await resv.cancel(req.body.ref, 'guest', 'auto'));
  }));

  app.get('/ask/:token', wrap(async (req, res) => {
    const s = await sessionFor(req.params.token);
    if (!s) return res.status(404).send(pages.notFound());
    const S = await loadSettings(ctx);
    res.send(pages.ask({ S, token: req.params.token, formUrl: `${base()}/reserve/${req.params.token}`, chips: await enquiry.chips() }));
  }));
  app.get('/api/ask/:token/history', wrap(async (req, res) => {
    const s = await sessionFor(req.params.token);
    if (!s) return res.status(404).json({ error: 'invalid link' });
    const { rows } = await pool.query('select id, direction, body, interactive, created_at from web_messages where phone_number=$1 order by id asc limit 200', [s.phone_number]);
    res.json({ messages: rows });
  }));
  app.post('/api/ask/:token', wrap(async (req, res) => {
    if (limited(`ask:${req.ip}`, 40, 60000)) return res.status(429).json({ error: 'slow down' });
    const s = await sessionFor(req.params.token);
    if (!s) return res.status(404).json({ error: 'invalid link' });
    const text = String(req.body?.text || '').trim().slice(0, 500);
    if (!text) return res.status(400).json({ error: 'empty' });
    await pool.query("insert into web_messages (phone_number, direction, body) values ($1,'in',$2)", [s.phone_number, text]);
    const out = await enquiry.reply(s.phone_number, text);
    const interactive = out.action ? { type: 'cta_url', label: out.action.label, url: out.action.url } : null;
    await pool.query("insert into web_messages (phone_number, direction, body, interactive) values ($1,'out',$2,$3)", [s.phone_number, out.text, interactive]);
    res.json({ reply: out.text, action: out.action || null });
  }));

  // ===================== staff dashboard =====================
  const requireAuth = (req, res, next) => (req.session.userId ? next() : (req.originalUrl.startsWith('/api/') ? res.status(401).json({ error: 'login required' }) : res.redirect('/dashboard/login')));
  app.get('/dashboard/login', (req, res) => res.send(pages.login(req.query.e ? 'Wrong username or password.' : '')));
  app.post('/dashboard/login', wrap(async (req, res) => {
    if (limited(`login:${req.ip}`, 10, 5 * 60000)) return res.redirect('/dashboard/login?e=1');
    const { rows } = await pool.query('select id, password_hash from dashboard_users where username=$1', [String(req.body.username || '')]);
    if (rows[0] && (await bcrypt.compare(String(req.body.password || ''), rows[0].password_hash))) { req.session.userId = rows[0].id; return res.redirect('/dashboard/'); }
    res.redirect('/dashboard/login?e=1');
  }));
  app.post('/dashboard/logout', (req, res) => req.session.destroy(() => res.redirect('/dashboard/login')));
  app.get(['/dashboard', '/dashboard/'], requireAuth, (req, res) => res.send(pages.dashboard()));

  const api = express.Router();
  api.use(requireAuth);

  api.get('/overview', wrap(async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 365);
    const S = await loadSettings(ctx); const T = makeTime(S);
    const off = S.tz_offset_minutes;
    const today = T.todayStr();
    const loc = `(starts_at at time zone 'UTC' + make_interval(mins => ${off}))`;
    const live = "status in ('confirmed','completed','no_show')";
    const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);
    const [todayRow] = await q(`select count(*)::int as tables, coalesce(sum(guests),0)::int as guests from reservations where status='confirmed' and ${loc}::date = $1::date`, [today]);
    const [upRow] = await q("select count(*)::int as n, coalesce(sum(guests),0)::int as guests from reservations where status='confirmed' and starts_at >= now()");
    const [rev] = await q("select coalesce(sum(paid_amount_kobo),0)::bigint as paid, coalesce(sum(refund_amount_kobo),0)::bigint as refunded from reservations where paid_at >= now() - ($1 || ' days')::interval", [days]);
    const [cr] = await q("select count(*) filter (where status='cancelled')::int as cancelled, count(*) filter (where status in ('confirmed','completed','no_show','cancelled'))::int as total, coalesce(avg(guests) filter (where status in ('confirmed','completed','no_show')),0)::float as avg_party from reservations where created_at >= now() - ($1 || ' days')::interval", [days]);
    const byWeekday = await q(`select extract(dow from ${loc})::int as dow, count(*)::int as bookings, coalesce(sum(guests),0)::int as guests from reservations where ${live} and starts_at >= now() - ($1 || ' days')::interval group by 1`, [days]);
    const byHour = await q(`select extract(hour from ${loc})::int as hour, count(*)::int as bookings from reservations where ${live} and starts_at >= now() - ($1 || ' days')::interval group by 1 order by 1`, [days]);
    const upcomingDaily = await q(`select to_char(${loc}::date,'YYYY-MM-DD') as day, count(*)::int as bookings, coalesce(sum(guests),0)::int as guests from reservations where status='confirmed' and ${loc}::date >= $1::date and ${loc}::date < ($1::date + 30) group by 1 order by 1`, [today]);
    const topDays = await q(`select to_char(${loc}::date,'YYYY-MM-DD') as day, count(*)::int as bookings, coalesce(sum(guests),0)::int as guests from reservations where ${live} and starts_at >= now() - ($1 || ' days')::interval group by 1 order by guests desc, bookings desc limit 5`, [days]);
    const status = await q("select status, count(*)::int as n from reservations where created_at >= now() - ($1 || ' days')::interval group by 1", [days]);
    const created = await q(`select to_char((created_at at time zone 'UTC' + make_interval(mins => ${off}))::date,'YYYY-MM-DD') as day, count(*)::int as n from reservations where created_at >= now() - ($1 || ' days')::interval group by 1 order by 1`, [days]);
    res.json({
      today, days,
      kpis: { todayTables: todayRow.tables, todayGuests: todayRow.guests, upcoming: upRow.n, upcomingGuests: upRow.guests,
        revenueKobo: Number(rev.paid) - Number(rev.refunded), paidKobo: Number(rev.paid), refundedKobo: Number(rev.refunded),
        cancelRate: cr.total ? cr.cancelled / cr.total : 0, avgParty: cr.avg_party },
      byWeekday, byHour, upcomingDaily, topDays, status, created,
    });
  }));

  api.get('/reservations', wrap(async (req, res) => {
    const S = await loadSettings(ctx); const T = makeTime(S);
    const where = []; const p = [];
    if (req.query.status) { p.push(String(req.query.status)); where.push(`status = $${p.length}`); }
    if (req.query.from) { p.push(T.localToUtcISO(String(req.query.from), '00:00')); where.push(`starts_at >= $${p.length}`); }
    if (req.query.to) { p.push(T.localToUtcISO(T.addDaysISO(String(req.query.to), 1), '00:00')); where.push(`starts_at < $${p.length}`); }
    if (req.query.q) { p.push(`%${String(req.query.q).toLowerCase()}%`); where.push(`(lower(guest_name) like $${p.length} or contact_phone like $${p.length} or phone_number like $${p.length} or lower(ref) like $${p.length})`); }
    const { rows } = await pool.query(`select * from reservations ${where.length ? 'where ' + where.join(' and ') : ''} order by starts_at desc limit 500`, p);
    res.json({ rows: rows.map((r) => { const pt = T.utcToLocalParts(r.starts_at); return { ...r, local_date: pt.date, local_time: pt.time, date_label: T.fmtDateFull(pt.date), time_label: T.fmtTime(pt.time) }; }) });
  }));
  api.post('/reservations/:ref/cancel', wrap(async (req, res) => {
    const mode = ['auto', 'full', 'none'].includes(req.body?.refund) ? req.body.refund : 'auto';
    const out = await resv.cancel(req.params.ref, 'staff', mode);
    res.status(out.ok ? 200 : 400).json(out);
  }));
  api.post('/reservations/:ref/status', wrap(async (req, res) => {
    const st = req.body?.status;
    if (!['completed', 'no_show', 'confirmed'].includes(st)) return res.status(400).json({ error: 'bad status' });
    await pool.query("update reservations set status=$2, updated_at=now() where ref=$1 and status in ('confirmed','completed','no_show')", [req.params.ref, st]);
    res.json({ ok: true });
  }));

  api.get('/chats', wrap(async (req, res) => {
    const { rows } = await pool.query(`
      with msgs as (
        select phone_number, 'whatsapp' as channel, direction, message_text as body, created_at from reservation_log
        union all
        select phone_number, 'web', case when direction='in' then 'inbound' else 'outbound' end, body, created_at from web_messages
      ), last as (
        select distinct on (phone_number) phone_number, body as last_body, created_at as last_at, direction as last_dir from msgs order by phone_number, created_at desc
      ), counts as (select phone_number, count(*)::int as n, count(*) filter (where channel='web')::int as web_n from msgs group by 1)
      select l.phone_number, l.last_body, l.last_at, l.last_dir, c.n, c.web_n,
        (select guest_name from reservations r where r.phone_number = l.phone_number order by created_at desc limit 1) as name
      from last l join counts c using (phone_number) order by l.last_at desc limit 300`);
    res.json({ rows });
  }));
  api.get('/chats/:phone', wrap(async (req, res) => {
    const { rows } = await pool.query(`
      select * from (
        select 'whatsapp' as channel, direction, message_text as body, null::jsonb as interactive, created_at from reservation_log where phone_number=$1
        union all
        select 'web', case when direction='in' then 'inbound' else 'outbound' end, body, interactive, created_at from web_messages where phone_number=$1
      ) m order by created_at asc limit 600`, [req.params.phone]);
    const reservations = (await pool.query('select ref, status, guests, starts_at from reservations where phone_number=$1 order by created_at desc limit 5', [req.params.phone])).rows;
    res.json({ messages: rows, reservations });
  }));

  api.get('/kb', wrap(async (req, res) => {
    const { rows } = await pool.query('select id, question, answer, keywords, sort_order, last_updated from knowledge_base order by sort_order, last_updated');
    const un = await pool.query("select id, phone_number, question, created_at from kb_unanswered where resolved=false order by created_at desc limit 100");
    res.json({ rows, unanswered: un.rows });
  }));
  const kbBody = (b) => ({ question: String(b?.question || '').trim().slice(0, 300), answer: String(b?.answer || '').trim().slice(0, 2000), keywords: String(b?.keywords || '').trim().slice(0, 300) });
  api.post('/kb', wrap(async (req, res) => {
    const k = kbBody(req.body); if (!k.question || !k.answer) return res.status(400).json({ error: 'Question and answer are both required.' });
    const { rows } = await pool.query('insert into knowledge_base (question, answer, keywords, sort_order) values ($1,$2,$3,(select coalesce(max(sort_order),0)+1 from knowledge_base)) returning *', [k.question, k.answer, k.keywords]);
    res.json(rows[0]);
  }));
  api.put('/kb/:id', wrap(async (req, res) => {
    const k = kbBody(req.body); if (!k.question || !k.answer) return res.status(400).json({ error: 'Question and answer are both required.' });
    const { rows } = await pool.query('update knowledge_base set question=$2, answer=$3, keywords=$4, last_updated=now() where id=$1 returning *', [req.params.id, k.question, k.answer, k.keywords]);
    res.json(rows[0] || {});
  }));
  api.delete('/kb/:id', wrap(async (req, res) => { await pool.query('delete from knowledge_base where id=$1', [req.params.id]); res.json({ ok: true }); }));
  api.post('/kb/unanswered/:id/answer', wrap(async (req, res) => {
    const k = kbBody(req.body); if (!k.question || !k.answer) return res.status(400).json({ error: 'Question and answer are both required.' });
    await pool.query('insert into knowledge_base (question, answer, keywords, sort_order) values ($1,$2,$3,(select coalesce(max(sort_order),0)+1 from knowledge_base))', [k.question, k.answer, k.keywords]);
    await pool.query('update kb_unanswered set resolved=true where id=$1', [req.params.id]);
    res.json({ ok: true });
  }));
  api.delete('/kb/unanswered/:id', wrap(async (req, res) => { await pool.query('update kb_unanswered set resolved=true where id=$1', [req.params.id]); res.json({ ok: true }); }));

  const SETTING_FIELDS = {
    venue_name: 'text', open_time: 'time', close_time: 'time', slot_minutes: 'int', max_guests_per_slot: 'int', max_guests_per_booking: 'int',
    min_notice_minutes: 'int', max_days_ahead: 'int', closed_weekdays: 'intarr', reservation_fee_kobo: 'int', service_fee_kobo: 'int',
    hold_minutes: 'int', refund_hours: 'int', order_link: 'text', welcome_image_url: 'text', welcome_text: 'text', handover_number: 'phone',
    payments_enabled: 'bool', enquiry_intro: 'text', venue_notes: 'text',
  };
  api.get('/settings', wrap(async (req, res) => { const S = await loadSettings(ctx); res.json({ settings: S, paystackConfigured: ps.configured, whatsappConfigured: !!env.META_ACCESS_TOKEN }); }));
  api.put('/settings', wrap(async (req, res) => {
    const sets = []; const vals = []; const errors = {};
    for (const [k, type] of Object.entries(SETTING_FIELDS)) {
      if (!(k in (req.body || {}))) continue;
      let v = req.body[k];
      if (type === 'int') { v = Number(v); if (!Number.isInteger(v) || v < 0) { errors[k] = 'Enter a whole number.'; continue; } }
      else if (type === 'time') { if (!/^\d{2}:\d{2}$/.test(String(v))) { errors[k] = 'Use HH:MM.'; continue; } }
      else if (type === 'bool') v = !!v;
      else if (type === 'intarr') { v = (Array.isArray(v) ? v : []).map(Number).filter((n) => n >= 0 && n <= 6); }
      else if (type === 'phone') { if (v === '' || v === null) v = null; else { v = normalizePhone(v); if (!v) { errors[k] = 'Enter a valid phone number.'; continue; } } }
      else v = v === null ? null : String(v).slice(0, 1000);
      vals.push(v); sets.push(`${k} = $${vals.length}`);
    }
    if (Object.keys(errors).length) return res.status(400).json({ errors });
    if (sets.length) await pool.query(`update reservation_settings set ${sets.join(', ')} where id = 1`, vals);
    res.json({ ok: true, settings: await loadSettings(ctx) });
  }));
  api.post('/settings/test-handover', wrap(async (req, res) => {
    const S = await loadSettings(ctx);
    const ok = await resv.notifyHandover(S, `Test from the ${S.venue_name} reservations dashboard. If you can read this, new reservations will arrive on this number.`, 'a test message');
    res.json({ ok, note: ok ? 'Sent. If it does not show up, reply "okay" to the bot number once so WhatsApp releases it.' : 'No valid handover number saved yet.' });
  }));
  app.use('/api', api);

  return app;
}

module.exports = { buildApp, http };

if (require.main === module) {
  const env = process.env;
  const pool = new Pool({ host: env.DB_HOST || 'postgres', port: Number(env.DB_PORT || 5432), user: env.DB_USER || 'n8n', password: env.DB_PASSWORD, database: env.DB_NAME || 'bali' });
  const app = buildApp({ pool, env, http });
  const port = Number(env.PORT || 3000);
  // unpaid holds past their time are marked expired so the dashboard never shows stale "pending" rows
  setInterval(() => pool.query("update reservations set status='expired', updated_at=now() where status='pending_payment' and hold_expires_at < now()").catch(() => {}), 60000);
  app.listen(port, () => console.log(`Bali app listening on ${port}`));
}

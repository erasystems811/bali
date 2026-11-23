// End to end: real Express app + real Postgres (a throwaway database), fake WhatsApp/Paystack/OpenAI network.
// run: DB_HOST=... DB_PASSWORD=... DB_NAME=bali_test node test/app.test.js
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { buildApp } = require('../server');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL:', m); } else console.log('  ok:', m); };

const crypto = require('crypto');
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const env = {
  FLOW_PRIVATE_KEY: keys.privateKey,
  APP_BASE_URL: 'https://app.test', META_ACCESS_TOKEN: 'tok', META_PHONE_NUMBER_ID: '1', META_WEBHOOK_VERIFY_TOKEN: 'vt',
  BALI_FORWARD_SECRET: 'fsec', PAYSTACK_SECRET_KEY: 'sk_test', SESSION_SECRET: 's', NODE_ENV: 'test',
};
const sent = []; const refunds = []; const paid = new Set(); let paystackDown = false;
async function http(method, url, { body } = {}) {
  const u = new URL(url);
  if (u.hostname === 'graph.facebook.com') { sent.push({ to: body.to, type: body.type, text: body.text?.body || body.interactive?.body?.text || body.template?.components?.[0]?.parameters?.[0]?.text, interactive: body.interactive, template: body.type === 'template' }); return { messages: [{ id: 'wamid.' + sent.length }] }; }
  if (u.hostname === 'api.paystack.co') {
    if (u.pathname === '/transaction/initialize') { if (paystackDown) throw new Error('down'); return { data: { authorization_url: 'https://checkout.paystack.com/' + body.reference } }; }
    if (u.pathname.startsWith('/transaction/verify/')) { const ref = decodeURIComponent(u.pathname.split('/').pop()); return { data: paid.has(ref) ? { status: 'success', amount: 2050000 } : { status: 'abandoned', amount: 0 } }; }
    if (u.pathname === '/refund') { refunds.push(body); return { status: true }; }
  }
  if (u.hostname === 'api.openai.com') throw new Error('no key');
  throw new Error('unexpected ' + url);
}

(async () => {
  const pool = new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), user: process.env.DB_USER || 'n8n', password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'bali_test' });
  await pool.query('truncate reservations, reservation_log, web_messages, web_sessions, kb_unanswered, wa_inbound, queued_messages restart identity cascade');
  await pool.query('delete from knowledge_base'); await pool.query('delete from dashboard_users');
  await pool.query(`insert into knowledge_base (question, answer, keywords, sort_order) values
    ('What time do you open and close?', 'We are open from 12pm to 10pm.', 'hours opening closing', 1),
    ('How much is a reservation?', 'A reservation is NGN 20,500.', 'cost price fee pay', 2),
    ('Can I get a refund if I cancel?', 'Yes, if at least 24 hours before.', 'refund money back', 3),
    ('Do you have parking?', 'Yes, free parking on site.', 'park car', 4)`);
  await pool.query(`update reservation_settings set open_time='12:00', close_time='22:00', slot_minutes=60, max_guests_per_slot=10, max_guests_per_booking=8,
    min_notice_minutes=60, max_days_ahead=60, closed_weekdays='{}', open_24_7=false, payments_enabled=false, handover_number='08031112222', welcome_image_url=null where id=1`);
  await pool.query("insert into dashboard_users (username, password_hash) values ('admin', $1)", [await bcrypt.hash('pw', 4)]);

  const app = buildApp({ pool, env, http, noRateLimit: true });
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, cookie) => {
    const r = await fetch(base + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: r.status, text, json, headers: r.headers };
  };
  const settle = () => new Promise((r) => setTimeout(r, 400));
  const inbound = async (from, id, text = 'hi', k = 'fsec') => { await call('POST', `/webhook/whatsapp?k=${k}`, { entry: [{ changes: [{ value: { messages: [{ from, id, type: 'text', text: { body: text } }] } }] }] }); await settle(); };
  const tomorrow = () => { const d = new Date(Date.now() + 86400000 + 3600000); return d.toISOString().slice(0, 10); };
  const day = (n) => { const d = new Date(Date.now() + n * 86400000 + 3600000); return d.toISOString().slice(0, 10); };
  const form = (o = {}) => ({ name: 'Ada Okafor', phone: '08034445555', date: day(5), time: '19:00', guests: 4, ...o });
  const tokenOf = async (phone) => (await pool.query('select token from web_sessions where phone_number=$1', [phone])).rows[0]?.token;
  const HANDOVER = '2348031112222';

  console.log('\n1. WhatsApp webhook');
  const verify = await call('GET', '/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=999');
  ok(verify.text === '999', 'Meta verification handshake works');
  ok((await call('GET', '/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=999')).status === 403, 'wrong verify token refused');
  const G = '2348012345001';
  await inbound(G, 'm1', 'hi', 'wrong');
  ok(sent.length === 0, 'POST without the secret is ignored');
  await inbound(G, 'm1', 'hi');
  ok(sent.length === 1 && sent[0].interactive?.type === 'cta_url', 'guest gets ONE rich card');
  const tok = await tokenOf(G);
  ok(sent[0].interactive.action.parameters.display_text === 'TAP HERE TO RESERVE' && sent[0].interactive.action.parameters.url === `https://app.test/reserve/${tok}`, 'button opens the reservation form');
  ok(/WELCOME TO BALI/.test(sent[0].text) && sent[0].text.includes(`https://app.test/ask/${tok}`), 'card text has the welcome line and the enquiries link');
  ok(sent[0].interactive.header?.image?.link === 'https://app.test/assets/welcome.png', 'Bali picture in the card header');
  await inbound(G, 'm1', 'hi');
  ok(sent.length === 1, 'duplicate delivery is ignored');
  await inbound(G, 'm2', 'hello again');
  ok(sent.length === 2 && !sent[1].interactive && /reserve\//.test(sent[1].text) && /ask\//.test(sent[1].text), 'second text gets a short links message, not another card');
  await inbound(HANDOVER, 'm3', 'okay');
  ok(!sent.slice(2).some((x) => x.interactive), 'the handover number never receives the guest card');

  console.log('\n2. form page + validation');
  ok((await call('GET', `/reserve/${tok}`)).text.includes('Arrival time'), 'form page renders');
  ok((await call('GET', '/reserve/nonsense')).status === 404, 'bad link is a 404');
  const bad = await call('POST', `/api/reserve/${tok}`, { name: '', phone: '12', date: '2020-01-01', time: '03:00', guests: 0 });
  ok(bad.status === 422 && bad.json.errors.name && bad.json.errors.phone && bad.json.errors.date && bad.json.errors.guests, 'bad fields all reported');
  ok((await call('POST', `/api/reserve/${tok}`, form({ time: '03:00' }))).json.errors.time, '3am rejected');
  ok((await call('POST', `/api/reserve/${tok}`, form({ guests: 20 }))).json.errors.guests, 'party over the limit rejected');
  ok((await call('POST', `/api/reserve/${tok}`, form({ date: day(200) }))).json.errors.date, 'too far ahead rejected');

  console.log('\n3. booking without payment -> handover');
  const before = sent.length;
  const r1 = await call('POST', `/api/reserve/${tok}`, form());
  ok(r1.json.ok && r1.json.status === 'confirmed', 'confirmed immediately when payments are off');
  await settle();
  const ho = sent.slice(before).find((x) => x.to === HANDOVER);
  ok(ho && /Ada Okafor/.test(ho.text) && /2348034445555/.test(ho.text) && /19:00|7pm/.test(ho.text) && /Guests: 4/.test(ho.text), 'handover message has name, phone, date, arrival, guests');
  ok(sent.slice(before).some((x) => x.to === G && /confirmed/.test(x.text) && /baliabuja\.mylo\.africa/.test(x.text)), 'guest gets confirmation + order link');
  const row = (await pool.query('select * from reservations where ref=$1', [r1.json.ref])).rows[0];
  ok(row.handed_over_at && row.contact_phone === '2348034445555', 'stored with handover time and the typed phone');

  console.log('\n4. capacity');
  const G2 = '2348012345002'; await inbound(G2, 'c1'); const t2 = await tokenOf(G2);
  const full = await call('POST', `/api/reserve/${t2}`, form({ guests: 7 }));           // 4 + 7 > 10
  ok(!full.json.ok && /fully booked/.test(full.json.errors.time), 'over capacity refused with free times listed');
  ok((await call('POST', `/api/reserve/${t2}`, form({ guests: 6 }))).json.ok, 'exactly full is allowed (4+6=10)');
  const race = await Promise.all([1, 2, 3].map(async (i) => { const p = '23480123450' + (10 + i); await inbound(p, 'r' + i); return call('POST', `/api/reserve/${await tokenOf(p)}`, form({ date: day(9), time: '20:00', guests: 6, name: 'Race ' + i })); }));
  ok(race.filter((x) => x.json.ok).length === 1, 'simultaneous bookings cannot oversell a slot');

  console.log('\n5. payments on');
  await pool.query('update reservation_settings set payments_enabled=true where id=1');
  const P = '2348012345003'; await inbound(P, 'p1'); const tp = await tokenOf(P);
  const pr = await call('POST', `/api/reserve/${tp}`, form({ date: day(7), name: 'Tola', guests: 2 }));
  ok(pr.json.ok && pr.json.status === 'pending_payment' && /checkout\.paystack\.com/.test(pr.json.payUrl) && pr.json.amountKobo === 2050000, 'returns the Paystack link for N20,500');
  const pref = (await pool.query('select paystack_ref from reservations where ref=$1', [pr.json.ref])).rows[0].paystack_ref;
  const b2 = sent.length;
  ok(!sent.slice(b2).some((x) => x.to === HANDOVER), 'nothing handed over before payment');
  ok(/Waiting for your payment/.test((await call('GET', `/reserve/${tp}/done?ref=${pr.json.ref}`)).text), 'return page waits while unpaid');
  paid.add(pref);
  const done = await call('GET', `/reserve/${tp}/done?ref=${pr.json.ref}`); await settle();
  ok(/Your table is confirmed/.test(done.text) && /Place your order/.test(done.text), 'return page confirms and shows the order button');
  ok(sent.slice(b2).some((x) => x.to === HANDOVER && /Tola/.test(x.text) && /Paid: ₦20,500/.test(x.text)), 'handover sent AFTER payment');
  const nSent = sent.length;
  await call('POST', '/webhook/paystack', { event: 'charge.success', data: { reference: pref } }); await settle();
  await call('POST', '/webhook/paystack', { event: 'charge.success', data: { reference: 'NOPE' } }); await settle();
  ok(sent.length === nSent, 'replayed / unknown Paystack webhooks do nothing');
  const P2 = '2348012345004'; await inbound(P2, 'p2'); const tp2 = await tokenOf(P2);
  const pr2 = await call('POST', `/api/reserve/${tp2}`, form({ date: day(8), name: 'Bola', guests: 2 }));
  const pref2 = (await pool.query('select paystack_ref from reservations where ref=$1', [pr2.json.ref])).rows[0].paystack_ref;
  paid.add(pref2); await call('POST', '/webhook/paystack', { event: 'charge.success', data: { reference: pref2 } }); await settle();
  ok((await pool.query('select status from reservations where ref=$1', [pr2.json.ref])).rows[0].status === 'confirmed', 'Paystack webhook alone confirms (guest closed the page)');
  const P3 = '2348012345005'; await inbound(P3, 'p3'); const tp3 = await tokenOf(P3);
  const pr3 = await call('POST', `/api/reserve/${tp3}`, form({ date: day(8), time: '19:00', name: 'Hold', guests: 8 })); // 2 booked + 8 hold = 10
  ok(pr3.json.ok, 'unpaid hold taken');
  const P4 = '2348012345006'; await inbound(P4, 'p4');
  ok(!(await call('POST', `/api/reserve/${await tokenOf(P4)}`, form({ date: day(8), time: '19:00', name: 'Late', guests: 2 }))).json.ok, 'an unpaid hold blocks the slot');
  await pool.query("update reservations set hold_expires_at = now() - interval '1 minute' where ref=$1", [pr3.json.ref]);
  ok((await call('POST', `/api/reserve/${await tokenOf(P4)}`, form({ date: day(8), time: '19:00', name: 'Late', guests: 2 }))).json.ok, 'an expired hold frees the slot');
  paystackDown = true;
  const P5 = '2348012345007'; await inbound(P5, 'p5'); const b5 = sent.length;
  const dn = await call('POST', `/api/reserve/${await tokenOf(P5)}`, form({ date: day(12), name: 'Down' })); await settle();
  ok(!dn.json.ok && dn.json.code === 'paystack_failed' && (await pool.query("select count(*)::int n from reservations where guest_name='Down' and status='pending_payment'")).rows[0].n === 0, 'Paystack outage: clear error, no stuck hold');
  ok(sent.slice(b5).some((x) => x.to === HANDOVER && /Paystack/.test(x.text)), 'venue told about the payment problem');
  paystackDown = false;

  console.log('\n6. guest cancel + refunds');
  const tcan = await tokenOf(P);
  ok(/Cancel reservation/.test((await call('GET', `/my/${tcan}`)).text), 'manage page lists the reservation');
  ok((await call('POST', `/api/my/${tok}/cancel`, { ref: pr.json.ref })).status === 404, "cannot cancel someone else's reservation");
  const rc = await call('POST', `/api/my/${tcan}/cancel`, { ref: pr.json.ref });
  ok(rc.json.ok && rc.json.refund === 2000000 && refunds.some((x) => x.amount === 2000000), 'cancel 24h+ ahead refunds N20,000 (not the fee)');
  await pool.query("update reservations set starts_at = now() + interval '3 hours' where ref=$1", [pr2.json.ref]);
  const nref = refunds.length;
  const rc2 = await call('POST', `/api/my/${tp2}/cancel`, { ref: pr2.json.ref });
  ok(rc2.json.ok && rc2.json.refund === 0 && refunds.length === nref, 'cancel inside 24h refunds nothing');

  console.log('\n7. enquiry chat (always from the knowledge base)');
  const ask = async (t) => (await call('POST', `/api/ask/${tok}`, { text: t })).json;
  ok(/12pm to 10pm/.test((await ask('what time do you open?')).reply), 'opening hours come from the KB');
  ok(/20,500/.test((await ask('how much does it cost')).reply), 'price comes from the KB');
  ok(/24 hours/.test((await ask('can i get my money back if i cancel')).reply), 'refund question matches via keywords');
  ok(/parking/.test((await ask('is there parking?')).reply), 'parking matches');
  const mg = await ask('can I cancel my booking');
  ok(mg.action?.url === `https://app.test/my/${tok}`, 'cancel/change goes to the manage page');
  const bk = await ask('I want to book a table');
  ok(bk.action?.url === `https://app.test/go/${tok}/reserve`, 'booking intent gets the hand-over link');
  const b7 = sent.length;
  const unk = await ask('do you allow pets?');
  await settle();
  ok(/passed it to the team/.test(unk.reply), 'unknown question admits it and escalates');
  ok((await pool.query('select count(*)::int n from kb_unanswered')).rows[0].n === 1 && sent.slice(b7).some((x) => x.to === HANDOVER && /pets/.test(x.text)), 'unanswered question stored and sent to the handover number');
  const askPage = (await call('GET', `/ask/${tok}`)).text;
  ok(askPage.includes('Enquiries') && !askPage.includes('ERA Systems'), 'enquiry chat renders with no ERA branding line');
  ok((await call('GET', `/api/ask/${tok}/history`)).json.messages.length >= 8, 'chat history saved');

  console.log('\n7b. native WhatsApp form (Flow)');
  await pool.query("update reservation_settings set flow_id='FLOW1', closed_weekdays='{1}' where id=1");
  const submit = async (from, id, resp) => { await call('POST', '/webhook/whatsapp?k=fsec', { entry: [{ changes: [{ value: { messages: [{ from, id, type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', response_json: JSON.stringify({ ...resp, flow_token: 'bali-x' }) } } }] } }] }] }); await settle(); };
  const F = '2348012345101'; const bf = sent.length;
  await inbound(F, 'f1', 'hi');
  const fm = sent.slice(bf).find((x) => x.to === F);
  const fp = fm?.interactive?.action?.parameters;
  ok(fm?.interactive?.type === 'flow' && fp.flow_id === 'FLOW1' && fp.flow_cta === 'TAP HERE TO RESERVE' && fp.flow_action === 'navigate', 'welcome is the native form message with an obvious TAP HERE TO RESERVE button');
  ok(fm.interactive.header?.image?.link === 'https://app.test/assets/welcome.png' && /WELCOME TO BALI/.test(fm.text) && /\/ask\//.test(fm.text), 'has the Bali picture, welcome text and enquiries link');
  ok(fp.flow_token.startsWith('bali-') && fp.flow_action_payload.screen === 'RESERVE', 'flow token and first screen set');
  const fd = fp.flow_action_payload.data;
  ok(fd.times === undefined && fd.time_init === '7:00 PM', 'arrival time is typed, starting from a 7:00 PM suggestion');
  ok(fd.guests_hint === 'Up to 8 guests online' && fd.guests === undefined, 'guests is typed, with the online limit as a hint');
  ok(!('footer' in fm.interactive), 'no footer on the main welcome message');
  ok(fd.min_date === day(0) && fd.max_date === day(60) && fd.unavailable.length >= 8 && fd.unavailable.every((d) => new Date(d + 'T00:00:00Z').getUTCDay() === 1), 'date range is live and Mondays (closed) are unavailable');
  ok(fd.phone_init === '+' + F, 'phone is pre-filled');
  const b2f = sent.length; await inbound(F, 'f2', 'hello?');
  ok(sent.length === b2f, 'a rapid second text does not resend the form');
  await pool.query("update web_sessions set welcomed_at = now() - interval '5 minutes' where phone_number=$1", [F]);
  const dayOk = (n) => { let d = day(n); while (new Date(d + 'T00:00:00Z').getUTCDay() === 1) d = day(++n); return d; };
  const bs1 = sent.length;
  await submit(F, 's1', { name: 'Efe Obi', phone: '0803 555 6666', date: dayOk(14), time: '19:00', guests: '3' });
  const efe = (await pool.query("select * from reservations where guest_name='Efe Obi'")).rows[0];
  ok(efe && efe.status === 'pending_payment' && efe.guests === 3 && efe.contact_phone === '2348035556666', 'form submission creates a held reservation with the typed phone');
  const pm = sent.slice(bs1).find((x) => x.to === F && x.interactive?.type === 'cta_url');
  ok(pm && /20,500/.test(pm.text) && pm.interactive.action.parameters.display_text === 'PAY ₦20,500' && /checkout\.paystack\.com/.test(pm.interactive.action.parameters.url), 'guest gets a pay button for N20,500 right in WhatsApp');
  ok(!sent.slice(bs1).some((x) => x.to === HANDOVER), 'nothing handed over before payment');
  paid.add(efe.paystack_ref); await call('POST', '/webhook/paystack', { event: 'charge.success', data: { reference: efe.paystack_ref } }); await settle();
  ok(sent.slice(bs1).some((x) => x.to === HANDOVER && /Efe Obi/.test(x.text) && /2348035556666/.test(x.text) && /Guests: 3/.test(x.text)), 'details handed over after payment');
  const bs2 = sent.length;
  await submit(F, 's2', { name: 'Efe Obi', phone: '0803 555 6666', date: dayOk(15), time: '03:00', guests: '2' });
  const again = sent.slice(bs2).find((x) => x.to === F && x.interactive?.type === 'flow');
  ok(again && /^Sorry: Arrival time must be between/.test(again.text) && again.interactive.action.parameters.flow_action_payload.data.name_init === 'Efe Obi', 'a bad time re-opens the form with the reason and the name kept');
  const ms = String(Date.parse(dayOk(16) + 'T00:00:00Z'));
  await submit(F, 's3', { name: 'Ms Date', phone: '0803 555 7777', date: ms, time: '20:00', guests: '2' });
  ok((await pool.query("select count(*)::int n from reservations where guest_name='Ms Date'")).rows[0].n === 1, 'a millisecond-timestamp date from older WhatsApp is accepted');
  const b3 = sent.length; await submit(F, 's1', { name: 'Efe Obi', phone: '0803 555 6666', date: dayOk(14), time: '19:00', guests: '3' });
  ok(sent.length === b3, 'a duplicate delivery of the same submission is ignored');
  await pool.query("update reservation_settings set closed_weekdays='{}' where id=1");
  ok(require('../lib/flow').flowData(await require('../lib/core').loadSettings({ pool })).unavailable[0] === '2000-01-01', 'no closed days gives WhatsApp a valid placeholder list');
  await pool.query("update reservation_settings set flow_id=null where id=1");

  console.log('\n7c. "Reserve a table" buttons on the web open the WhatsApp form');
  await pool.query("update reservation_settings set flow_id='FLOW1' where id=1");
  const goTok = await tokenOf(F); const gb = sent.length;
  const g1 = await fetch(`${base}/go/${goTok}/reserve`, { redirect: 'manual' });
  ok(g1.status === 302 && g1.headers.get('location') === 'https://wa.me/2348140490247', 'window open: redirects into the WhatsApp chat');
  const pushed = sent.slice(gb).find((x) => x.to === F && x.interactive?.type === 'flow');
  ok(pushed && /Tap TAP HERE TO RESERVE below/.test(pushed.text) && !pushed.interactive.header, 'and pushes the native form into that chat first, as a short message with the button');
  await pool.query("delete from reservation_log where phone_number=$1 and direction='inbound'", [F]);
  const gb2 = sent.length;
  const g2 = await fetch(`${base}/go/${goTok}/reserve`, { redirect: 'manual' });
  ok(g2.headers.get('location') === 'https://wa.me/2348140490247?text=Table%20reservation' && sent.length === gb2, 'window closed: opens WhatsApp with the words pre-typed, nothing sent');
  await pool.query("update reservation_settings set flow_id=null where id=1");
  ok((await fetch(`${base}/go/${goTok}/reserve`, { redirect: 'manual' })).headers.get('location') === `/reserve/${goTok}`, 'no form configured: falls back to the website form');
  ok((await fetch(`${base}/go/nonsense/reserve`, { redirect: 'manual' })).status === 404, 'bad link is a 404');
  console.log('\n7d. payment INSIDE the WhatsApp form (encrypted endpoint)');
  const flowCall = async (obj, raw) => {
    const aes = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-128-gcm', aes, iv); const enc = Buffer.concat([c.update(JSON.stringify(obj)), c.final(), c.getAuthTag()]);
    const ek = crypto.publicEncrypt({ key: keys.publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aes);
    const body = raw || { encrypted_flow_data: enc.toString('base64'), encrypted_aes_key: ek.toString('base64'), initial_vector: iv.toString('base64') };
    const r = await fetch(base + '/flow/endpoint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status !== 200) return { status: r.status };
    const buf = Buffer.from(await r.text(), 'base64'); const flipped = Buffer.from([...iv].map((b) => ~b & 0xff));
    const d = crypto.createDecipheriv('aes-128-gcm', aes, flipped); d.setAuthTag(buf.subarray(-16));
    return { status: 200, json: JSON.parse(Buffer.concat([d.update(buf.subarray(0, -16)), d.final()]).toString()) };
  };
  ok((await flowCall({ action: 'ping', version: '3.0' })).json.data.status === 'active', 'Meta health check (ping) answered');
  ok((await flowCall(null, { encrypted_flow_data: 'AAAA', encrypted_aes_key: 'AAAA', initial_vector: 'AAAA' })).status === 421, 'undecryptable request gets 421 so Meta refreshes the key');
  ok((await flowCall(null, {})).status === 421, 'empty request gets 421');
  const H = '2348012345201'; await inbound(H, 'h1'); const hTok = await tokenOf(H); const FT = 'bali-' + hTok;
  const init = await flowCall({ action: 'INIT', flow_token: FT, version: '3.0' });
  ok(init.json.screen === 'RESERVE' && init.json.data.has_error === false, 'INIT returns the live form');
  ok(init.json.data.time_init === '7:00 PM' && init.json.data.guests_init === '2' && /^\d{4}-\d{2}-\d{2}$/.test(init.json.data.date_init), 'form starts with valid defaults');
  const ex = (data, token) => flowCall({ action: 'data_exchange', screen: 'RESERVE', flow_token: token || FT, version: '3.0', data });
  const bad7 = await ex({ action: 'reserve', name: 'Kunle Ade', phone: '0803 123 4567', date: day(20), time: '03:00', guests: '2' });
  ok(bad7.json.screen === 'RESERVE' && bad7.json.data.has_error && /between/.test(bad7.json.data.error) && bad7.json.data.name_init === 'Kunle Ade' && bad7.json.data.date_init === day(20), 'a bad time sends the guest back with the reason and their entries kept');
  ok((await ex({ action: 'reserve', name: 'Kunle Ade', phone: '0803', date: day(20), time: '19:00', guests: '2' })).json.data.error.includes('valid phone'), 'bad phone caught inside the form');
  ok((await ex({ action: 'reserve', name: 'Kunle Ade', phone: '0803 123 4567', date: day(20), time: '19:00', guests: '9' })).json.data.error.includes('more than 8'), 'too many guests caught inside the form');
  ok((await ex({ action: 'reserve', name: 'X', phone: '0803 123 4567', date: day(20), time: '19:00', guests: '2' }, 'bali-nope')).json.data.error.includes('expired'), 'a stale or forged form token is refused');
  const hb = sent.length;
  const good = await ex({ action: 'reserve', name: 'Kunle Ade', phone: '0803 123 4567', date: day(20), time: '19:15', guests: '4' });
  ok(good.json.screen === 'PAY' && /checkout\.paystack\.com/.test(good.json.data.pay_url) && good.json.data.amount_label === 'Pay ₦20,500' && /20,000/.test(good.json.data.detail) && /500 service fee/.test(good.json.data.detail), 'next screen is the payment screen with the Paystack link and the fee breakdown');
  ok(!sent.slice(hb).some((x) => x.to === HANDOVER), 'nothing handed over before payment');
  const kref = good.json.data.ref;
  const unpaid = await ex({ action: 'check', ref: kref });
  ok(unpaid.json.screen === 'PAY' && unpaid.json.data.has_note && /not received/.test(unpaid.json.data.note), 'tapping I have paid before paying shows a gentle note');
  const stolen = (await ex({ action: 'check', ref: kref }, 'bali-' + (await tokenOf('2348012345001')))).json;
  ok(stolen.screen === 'PAY' && stolen.data.amount_label === 'Start again' && !stolen.data.pay_url.includes('paystack'), "another guest's token cannot touch this reservation");
  const kr = (await pool.query('select paystack_ref from reservations where ref=$1', [kref])).rows[0].paystack_ref; paid.add(kr);
  const done7 = await ex({ action: 'check', ref: kref }); await settle();
  ok(done7.json.screen === 'DONE' && done7.json.data.credit.includes('credited') && /order link are in this chat/.test(done7.json.data.credit) && done7.json.data.order_url === undefined, 'after paying, the confirmation screen sends them back to the chat for the order link');
  ok(sent.slice(hb).some((x) => x.to === HANDOVER && /Kunle Ade/.test(x.text) && /2348031234567/.test(x.text) && /Guests: 4/.test(x.text) && /Arrival: 7:15pm/.test(x.text)), 'details handed over to the venue after payment');
  ok(sent.slice(hb).some((x) => x.to === H && /confirmed/.test(x.text) && /baliabuja/.test(x.text)), 'guest also gets the WhatsApp confirmation with the order link');
  const nb = sent.length; await submit(H, 'fin1', { ref: kref, flow_token: FT }); ok(sent.length === nb, 'finishing the form (Done) triggers nothing extra');
  const full7 = await ex({ action: 'reserve', name: 'Late Guest', phone: '0803 999 0000', date: day(20), time: '19:30', guests: '8' });
  ok(full7.json.screen === 'RESERVE' && /fully booked/.test(full7.json.data.error), 'a full time is reported inside the form');
  await pool.query("update reservation_settings set payments_enabled=false where id=1");
  const free7 = await ex({ action: 'reserve', name: 'Free Guest', phone: '0803 777 0000', date: day(21), time: '18:00', guests: '2' }); await settle();
  ok(free7.json.screen === 'DONE' && !free7.json.data.credit.includes('credited') && /order link are in this chat/.test(free7.json.data.credit), 'payments off: straight to the confirmation screen');
  await pool.query("update reservation_settings set payments_enabled=true where id=1");
  const fj = require('../lib/flow').flowJson('AAAA');
  ok(fj.screens.map((s) => s.id).join() === 'RESERVE,PAY,DONE' && fj.data_api_version === '3.0' && fj.screens[2].terminal, 'form definition has the three screens and an endpoint');

  console.log('\n7e. capacity is optional (0 = unlimited)');
  await pool.query("update reservation_settings set max_guests_per_slot=0 where id=1");
  const U = []; for (let i = 0; i < 4; i++) { const ph = '23480123453' + (10 + i); await inbound(ph, 'u' + i); U.push(await call('POST', `/api/reserve/${await tokenOf(ph)}`, form({ date: day(25), time: '19:00', guests: 8, name: 'Many ' + i }))); }
  ok(U.every((x) => x.json.ok), 'with no limit, many large parties at the same time are all accepted');
  ok((await pool.query("select count(*)::int n from reservations where guest_name like 'Many %'")).rows[0].n === 4, 'all four stored');
  await pool.query("update reservation_settings set max_guests_per_booking=0 where id=1");
  const BIG = '2348012345320'; await inbound(BIG, 'big1');
  const bigRes = await call('POST', `/api/reserve/${await tokenOf(BIG)}`, form({ date: day(26), time: '20:00', guests: 60, name: 'Big Party' }));
  ok(bigRes.json.ok, 'any number of guests is accepted (60 here)');
  ok(require('../lib/flow').flowData(await require('../lib/core').loadSettings({ pool })).guests_hint === 'Any number of guests', 'the form says any number of guests');
  ok(!(await call('POST', `/api/reserve/${await tokenOf(BIG)}`, form({ date: day(26), time: '20:00', guests: 5000, name: 'Silly' }))).json.ok, 'an absurd number is still rejected');
  await pool.query("update reservation_settings set max_guests_per_slot=10, max_guests_per_booking=8 where id=1");
  console.log('\n7f. Bali is open 24 hours: guests type the time');
  const pa = require('../lib/flow').parseArrival;
  const cases = { '7pm': '19:00', '7:30 PM': '19:30', '7.30pm': '19:30', '19:30': '19:30', '0030': '00:30', '12am': '00:00', '12 pm': '12:00', 'noon': '12:00', 'midnight': '00:00', '1:15 am': '01:15', '07:30': '07:30', '23:59': '23:59', '19': '19:00' };
  ok(Object.entries(cases).every(([k, v]) => pa(k) === v), 'typed times understood: ' + Object.keys(cases).join(', '));
  ok(['7', '7:30', '25:00', '13pm', '7:75pm', 'later', ''].every((k) => pa(k) === null), 'ambiguous or invalid times are rejected, never guessed: 7, 7:30, 25:00, 13pm, later');
  await pool.query("update reservation_settings set open_24_7=true, max_guests_per_slot=0, max_guests_per_booking=0 where id=1");
  const N24 = '2348012345330'; await inbound(N24, 'n1'); const t24 = await tokenOf(N24);
  const night = await call('POST', `/api/reserve/${t24}`, form({ date: day(27), time: '03:00', guests: 3, name: 'Night Owl' }));
  ok(night.json.ok, 'a 3am arrival is fine when open 24 hours');
  const ft24 = await flowCall({ action: 'data_exchange', screen: 'RESERVE', flow_token: 'bali-' + t24, version: '3.0', data: { action: 'reserve', name: 'Typed Time', phone: '0803 222 3333', date: day(27), time: '11:45 pm', guests: '2' } });
  ok(ft24.json.screen === 'PAY' || ft24.json.screen === 'DONE', 'typing "11:45 pm" in the form works');
  const amb = await flowCall({ action: 'data_exchange', screen: 'RESERVE', flow_token: 'bali-' + t24, version: '3.0', data: { action: 'reserve', name: 'Typed Time', phone: '0803 222 3333', date: day(27), time: '7:30', guests: '2' } });
  ok(amb.json.screen === 'RESERVE' && /AM or PM/.test(amb.json.data.error) && amb.json.data.time_init === '7:30', 'an ambiguous time is sent back asking for AM or PM, entry kept');
  const lo = await require('../lib/core').loadSettings({ pool });
  ok(lo.open_time === '00:00' && lo.close_time === '24:00', 'settings expose 24 hour hours');
  await pool.query("update reservation_settings set open_24_7=false, max_guests_per_slot=10, max_guests_per_booking=8 where id=1");
  console.log('\n8. dashboard');
  ok((await call('GET', '/api/overview')).status === 401, 'API needs login');
  ok((await call('GET', '/dashboard/')).status === 302, 'dashboard redirects to login');
  const lg = await fetch(base + '/dashboard/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=pw' });
  const cookie = (lg.headers.get('set-cookie') || '').split(';')[0];
  ok(lg.status === 302 && cookie, 'login works');
  ok((await fetch(base + '/dashboard/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=no' })).headers.get('location').includes('e=1'), 'wrong password refused');
  ok((await call('GET', '/dashboard/', null, cookie)).text.includes('dashboard.js'), 'dashboard shell loads');
  const ov = (await call('GET', '/api/overview?days=30', null, cookie)).json;
  ok(ov.kpis && ov.byWeekday.length > 0 && ov.upcomingDaily.length > 0 && ov.status.length > 0 && Array.isArray(ov.topDays), 'overview has KPIs and chart data');
  const rv = (await pool.query("select coalesce(sum(paid_amount_kobo),0)::bigint - coalesce(sum(refund_amount_kobo),0)::bigint as n from reservations where paid_at >= now() - interval '30 days'")).rows[0].n;
  ok(ov.kpis.revenueKobo === Number(rv) && ov.kpis.revenueKobo > 0, 'revenue = paid minus refunded');
  const rl = (await call('GET', '/api/reservations', null, cookie)).json.rows;
  ok(rl.length >= 5 && rl[0].date_label && rl[0].time_label, 'reservation list with labels');
  ok((await call('GET', '/api/reservations?q=ada', null, cookie)).json.rows.every((x) => /ada/i.test(x.guest_name)), 'search works');
  const ch = (await call('GET', '/api/chats', null, cookie)).json.rows;
  ok(ch.length >= 3 && ch.some((c) => c.web_n > 0), 'chat threads include WhatsApp and enquiry chat');
  const th = (await call('GET', `/api/chats/${G}`, null, cookie)).json;
  ok(th.messages.some((m) => m.channel === 'whatsapp') && th.messages.some((m) => m.channel === 'web'), 'one thread merges both channels');
  const kbc = (await call('POST', '/api/kb', { question: 'Do you allow pets?', answer: 'Small pets are welcome on the terrace.', keywords: 'dog cat animal' }, cookie)).json;
  ok(kbc.id, 'knowledge base entry added');
  ok(/terrace/.test((await ask('can I bring my dog')).reply), 'bot uses the new entry immediately');
  const kl = (await call('GET', '/api/kb', null, cookie)).json;
  ok(kl.unanswered.length === 1, 'unanswered list visible');
  await call('POST', `/api/kb/unanswered/${kl.unanswered[0].id}/answer`, { question: 'Do you allow pets?', answer: 'Yes on the terrace.' }, cookie);
  ok((await call('GET', '/api/kb', null, cookie)).json.unanswered.length === 0, 'answering clears it from the unanswered list');
  ok((await call('PUT', `/api/kb/${kbc.id}`, { question: 'Do you allow pets?', answer: 'Updated answer', keywords: '' }, cookie)).json.answer === 'Updated answer', 'edit works');
  await call('DELETE', `/api/kb/${kbc.id}`, null, cookie);
  ok(!(await call('GET', '/api/kb', null, cookie)).json.rows.some((r) => r.id === kbc.id), 'delete works');
  const bs = await call('PUT', '/api/settings', { handover_number: 'abc', open_time: '9am' }, cookie);
  ok(bs.status === 400 && bs.json.errors.handover_number && bs.json.errors.open_time, 'settings validation');
  const gs = await call('PUT', '/api/settings', { handover_number: '0803 999 8888', max_guests_per_slot: 12, closed_weekdays: [1] }, cookie);
  ok(gs.json.settings.handover_number === '2348039998888' && gs.json.settings.max_guests_per_slot === 12 && gs.json.settings.closed_weekdays[0] === 1, 'settings saved and normalised');
  const ts = await call('POST', '/api/settings/test-handover', null, cookie); await settle();
  ok(ts.json.ok && sent.some((x) => x.to === '2348039998888' && x.template), 'test message goes to the new handover number');
  await call('PUT', '/api/settings', { handover_number: '08031112222', max_guests_per_slot: 10, closed_weekdays: [] }, cookie);
  const stf = await call('POST', `/api/reservations/${pr3.json.ref}/cancel`, { refund: 'full' }, cookie);
  ok(stf.json.ok && stf.json.refund === 0, 'staff can clear a leftover unpaid hold (nothing to refund)');
  const pf = (await pool.query("select ref from reservations where status='confirmed' and paid_amount_kobo is not null limit 1")).rows[0];
  if (pf) { const rr = refunds.length; const sc = await call('POST', `/api/reservations/${pf.ref}/cancel`, { refund: 'full' }, cookie); ok(sc.json.ok && refunds.length === rr + 1 && refunds.at(-1).amount === 2050000, 'staff cancel with full refund returns N20,500'); }
  ok((await call('POST', `/api/reservations/${r1.json.ref}/status`, { status: 'completed' }, cookie)).json.ok, 'mark completed');

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  server.close(); await pool.end(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

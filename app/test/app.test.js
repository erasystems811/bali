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
const sent = []; const refunds = []; const paid = new Set(); let paystackDown = false; const monnifyCalls = []; const monnifyRefunds = []; let rejectReminderTemplate = false; let claudeFail = false; let payHang = false; let graphTransient = 0; let graphFlowDown = false;
const claudeCalls = [];
async function http(method, url, { body, headers } = {}) {
  const u = new URL(url);
  if (u.hostname === 'graph.facebook.com') {
    if (graphTransient > 0) { graphTransient -= 1; const e = new Error('HTTP 400 graph'); e.body = { error: { code: 2, is_transient: true, message: '(#2) Service temporarily unavailable' } }; throw e; }
    if (graphFlowDown && body.interactive?.type === 'flow') { const e = new Error('HTTP 400 graph'); e.body = { error: { code: 2, is_transient: true, message: '(#2) Service temporarily unavailable' } }; throw e; }
    if (rejectReminderTemplate && body.template?.name === 'bali_reservation_reminder') throw new Error('template not approved'); sent.push({ tname: body.template?.name, tcomponents: body.template?.components, to: body.to, type: body.type, text: body.text?.body || body.interactive?.body?.text || body.template?.components?.[0]?.parameters?.[0]?.text, interactive: body.interactive, template: body.type === 'template' }); return { messages: [{ id: 'wamid.' + sent.length }] }; }
  if (u.hostname === 'api.paystack.co') {
    if (u.pathname === '/transaction/initialize') { if (payHang) await new Promise((r) => setTimeout(r, 1500)); if (paystackDown) throw new Error('down'); return { data: { authorization_url: 'https://checkout.paystack.com/' + body.reference } }; }
    if (u.pathname.startsWith('/transaction/verify/')) { const ref = decodeURIComponent(u.pathname.split('/').pop()); return { data: paid.has(ref) ? { status: 'success', amount: 2050000 } : { status: 'abandoned', amount: 0 } }; }
    if (u.pathname === '/refund') { refunds.push(body); return { status: true }; }
  }
  if (u.hostname === 'sandbox.monnify.com') {
    monnifyCalls.push({ path: u.pathname, headers, body });
    if (u.pathname === '/api/v1/auth/login') return { requestSuccessful: true, responseBody: { accessToken: 'mtok', expiresIn: 3000 } };
    if (u.pathname === '/api/v1/merchant/transactions/init-transaction') return { requestSuccessful: true, responseBody: { checkoutUrl: 'https://sandbox.sdk.monnify.com/checkout/MNFY|90|' + body.paymentReference + '|000006', transactionReference: 'MNFY|' + body.paymentReference } };
    if (u.pathname === '/api/v2/merchant/transactions/query') { const ref = u.searchParams.get('paymentReference'); return { requestSuccessful: true, responseBody: { paymentStatus: paid.has(ref) ? 'PAID' : 'PENDING', amountPaid: paid.has(ref) ? 20500 : 0, transactionReference: 'MNFY|' + ref } }; }
    if (u.pathname === '/api/v1/refunds/initiate-refund') { monnifyRefunds.push(body); return { requestSuccessful: true, responseBody: { refundStatus: 'IN_PROGRESS' } }; }
  }
  if (u.hostname === 'api.anthropic.com') {
    claudeCalls.push({ headers, body });
    if (claudeFail) throw new Error('claude down');
    const q = body.messages[0].content;
    return { content: [{ type: 'text', text: 'Here you go: ' + JSON.stringify(/terrace/i.test(q) ? { found: true, answer: 'Yes, we have a terrace.' } : { found: false, answer: '' }) }] };
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
    min_notice_minutes=60, max_days_ahead=60, closed_weekdays='{}', open_24_7=false, confirm_via_webhook=false, payments_enabled=false, handover_number='08031112222', welcome_image_url=null where id=1`);
  await pool.query("insert into dashboard_users (username, password_hash) values ('admin', $1)", [await bcrypt.hash('pw', 4)]);

  const app = buildApp({ pool, env, http, noRateLimit: true, retryDelayMs: 1, flowTimeoutMs: 400 });
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
  ok(/Hey, welcome to Bali/.test(sent[0].text) && /Questions\? Chat with us:\n/.test(sent[0].text) && /https:\/\/app\.test\/c\/[a-f0-9]{12}$/.test(sent[0].text) && !/[a-f0-9]{32}/.test(sent[0].text), 'card text is tidy: greeting, instruction, then the short enquiries link (no long token)');
  ok(sent[0].interactive.header?.image?.link === 'https://app.test/assets/welcome.png', 'Bali picture in the card header');
  await inbound(G, 'm1', 'hi');
  ok(sent.length === 1, 'duplicate delivery is ignored');
  await inbound(G, 'm2', 'hello again');
  ok(sent.length === 2 && !sent[1].interactive && /reserve\//.test(sent[1].text) && /\/c\//.test(sent[1].text), 'second text gets a short links message, not another card');
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
  ok(r1.json.ref === 'R-001', 'the first reservation is R-001');

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
  ok(fm.interactive.header?.image?.link === 'https://app.test/assets/welcome.png' && /Hey, welcome to Bali/.test(fm.text) && /\n\nPlease tap the button below to make your table reservation\.\n\nQuestions\? Chat with us:\nhttps:\/\/app\.test\/c\/[a-f0-9]{12}$/.test(fm.text) && !/[a-f0-9]{32}/.test(fm.text), 'has the Bali picture and a clean three-part message: greeting, instruction, short chat link');
  const shortCode = fm.text.match(/\/c\/([a-f0-9]{12})/)[1]; const sRes = await fetch(`${base}/c/${shortCode}`, { redirect: 'manual' });
  ok(sRes.status === 302 && /^\/ask\/[a-f0-9]{32}$/.test(sRes.headers.get('location')) && (await fetch(`${base}/c/000000000000`, { redirect: 'manual' })).status === 404, 'the short link opens the enquiry chat; unknown codes 404');
  ok(fp.flow_token.startsWith('bali-') && fp.flow_action_payload.screen === 'RESERVE', 'flow token and first screen set');
  const fd = fp.flow_action_payload.data;
  ok(fd.times === undefined && fd.time_init === '19:00', 'arrival time starts from a 7:00 PM suggestion on the picker');
  const fjs = require('../lib/flow').flowJson('A'); const formKids = fjs.screens[0].layout.children.find((c) => c.type === 'Form').children;
  const timeDd = formKids.find((c) => c.name === 'time'); const hasHour = formKids.some((c) => c.name === 'hour' || c.name === 'minute');
  ok(timeDd.type === 'Dropdown' && !hasHour && timeDd['data-source'].length === 96 && timeDd['data-source'][0].id === '12:00' && timeDd['data-source'][0].title === '12:00 PM' && timeDd['data-source'][47].id === '23:45' && timeDd['data-source'][48].id === '00:00' && timeDd['data-source'][95].id === '11:45', 'ONE arrival time list: every 15 minutes, 12:00 PM to 11:45 PM then 12:00 AM to 11:45 AM');
  ok(fd.guests_hint === undefined && fd.guests === undefined, 'no helper text under the guests field');
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
  await pool.query("update web_sessions set welcomed_at = now() - interval '5 hours' where phone_number=$1", [F]);
  const g1 = await fetch(`${base}/go/${goTok}/reserve`, { redirect: 'manual' });
  ok(g1.status === 302 && g1.headers.get('location') === 'https://wa.me/2348140490247', 'window open: redirects into the WhatsApp chat');
  const pushed = sent.slice(gb).find((x) => x.to === F && x.interactive?.type === 'flow');
  ok(pushed && /Tap TAP HERE TO RESERVE below/.test(pushed.text) && !pushed.interactive.header, 'and pushes the native form into that chat first, as a short message with the button');
  const gbRecent = sent.length; const gRecent = await fetch(`${base}/go/${goTok}/reserve`, { redirect: 'manual' });
  ok(gRecent.status === 302 && gRecent.headers.get('location') === 'https://wa.me/2348140490247' && sent.length === gbRecent, 'a form button sent in the last 3 hours: no extra message, just opens the chat');
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
  ok(init.json.data.time_init === '19:00' && /^\d{4}-\d{2}-\d{2}$/.test(init.json.data.date_init) && init.json.data.guests_init === '2', 'form starts with valid defaults');
  const hm = (d) => d;
  const ex = (data, token) => flowCall({ action: 'data_exchange', screen: 'RESERVE', flow_token: token || FT, version: '3.0', data: hm(data) });
  const bad7 = await ex({ action: 'reserve', name: 'Kunle Ade', phone: '0803 123 4567', date: day(20), time: '03:00', guests: '2' });
  ok(bad7.json.screen === 'RESERVE' && bad7.json.data.has_error && /between/.test(bad7.json.data.error) && bad7.json.data.name_init === 'Kunle Ade' && bad7.json.data.date_init === day(20), 'a bad time sends the guest back with the reason and their entries kept');
  ok((await ex({ action: 'reserve', name: 'Kunle Ade', phone: '0803', date: day(20), time: '19:00', guests: '2' })).json.data.error.includes('valid phone'), 'bad phone caught inside the form');
  ok((await ex({ action: 'reserve', name: 'Kunle Ade', phone: '0803 123 4567', date: day(20), time: '19:00', guests: '9' })).json.data.error.includes('more than 8'), 'too many guests caught inside the form');
  ok((await ex({ action: 'reserve', name: 'X', phone: '0803 123 4567', date: day(20), time: '19:00', guests: '2' }, 'bali-nope')).json.data.error.includes('expired'), 'a stale or forged form token is refused');
  const hb = sent.length;
  const good = await ex({ action: 'reserve', name: 'Kunle Ade', phone: '0803 123 4567', date: day(20), time: '19:15', guests: '4' });
  ok(good.json.screen === 'PAY' && /checkout\.paystack\.com/.test(good.json.data.pay_url) && good.json.data.amount_label === 'Pay ₦20,500' && /20,000/.test(good.json.data.detail) && !/service/i.test(good.json.data.detail) && !/held for|15 minutes/i.test(good.json.data.detail) && good.json.data.has_fee_note === true && /includes a ₦500 service charge.$/.test(good.json.data.fee_note), 'payment screen: the total, no hold time, the service charge only as one small note at the end');
  ok(!sent.slice(hb).some((x) => x.to === HANDOVER), 'nothing handed over before payment');
  ok(!sent.slice(hb).some((x) => x.to === H), 'no WhatsApp message is sent when the payment screen appears (the form already shows it, saving a Meta message)');
  const kref = good.json.data.ref;
  const unpaid = await ex({ action: 'check', ref: kref });
  ok(unpaid.json.screen === 'PAY' && unpaid.json.data.has_note && /waiting for your payment/.test(unpaid.json.data.note), 'tapping I have paid before paying shows a gentle note');
  const stolen = (await ex({ action: 'check', ref: kref }, 'bali-' + (await tokenOf('2348012345001')))).json;
  ok(stolen.screen === 'PAY' && stolen.data.amount_label === 'Start again' && !stolen.data.pay_url.includes('paystack'), "another guest's token cannot touch this reservation");
  const kr = (await pool.query('select paystack_ref from reservations where ref=$1', [kref])).rows[0].paystack_ref; paid.add(kr);
  const done7 = await ex({ action: 'check', ref: kref }); await settle();
  ok(done7.json.screen === 'DONE' && done7.json.data.credit.includes('credited') && /link to order ahead are in this chat/.test(done7.json.data.credit) && done7.json.data.order_url === undefined, 'after paying, the confirmation screen sends them back to the chat for the order-ahead link');
  ok(sent.slice(hb).some((x) => x.to === HANDOVER && /Kunle Ade/.test(x.text) && /2348031234567/.test(x.text) && /Guests: 4/.test(x.text) && /Arrival: 7:15pm/.test(x.text)), 'details handed over to the venue after payment');
  ok(!sent.slice(hb).some((x) => x.to === H && /Your table at Bali is confirmed/.test(x.text || '')), 'the guest confirmation WAITS: it is not sent while they are still inside the form');
  const bdone = sent.length;
  await submit(H, 'fin-done', { ref: kref, flow_token: FT }); await settle();
  const conf7 = sent.slice(bdone).filter((x) => x.to === H);
  ok(conf7.length === 1 && /Your table at Bali is confirmed/.test(conf7[0].text) && /place an order ahead for that day, you can do that through this link: https:\/\/baliabuja\.mylo\.africa/.test(conf7[0].text) && conf7[0].interactive?.action?.parameters?.display_text === 'TAP TO MANAGE', 'tapping Done sends the confirmation right after their response, with the TAP TO MANAGE button');
  await submit(H, 'fin-done-2', { ref: kref, flow_token: FT }); await settle();
  ok(sent.slice(bdone).filter((x) => x.to === H).length === 1, 'the confirmation is only ever sent once');
  // (finishing the form is covered just above)
  const full7 = await ex({ action: 'reserve', name: 'Late Guest', phone: '0803 999 0000', date: day(20), time: '19:30', guests: '8' });
  ok(full7.json.screen === 'RESERVE' && /fully booked/.test(full7.json.data.error), 'a full time is reported inside the form');
  await pool.query("update reservation_settings set payments_enabled=false where id=1");
  const free7 = await ex({ action: 'reserve', name: 'Free Guest', phone: '0803 777 0000', date: day(21), time: '18:00', guests: '2' }); await settle();
  ok(free7.json.screen === 'DONE' && !free7.json.data.credit.includes('credited') && /link to order ahead are in this chat/.test(free7.json.data.credit), 'payments off: straight to the confirmation screen');
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
  ok(require('../lib/flow').flowData(await require('../lib/core').loadSettings({ pool })).guests_hint === undefined, 'nothing is said about guest limits on the form');
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
  ok(amb.json.screen === 'RESERVE' && /AM or PM/.test(amb.json.data.error), 'an ambiguous typed time (older form versions) is sent back asking for AM or PM');
  const lo = await require('../lib/core').loadSettings({ pool });
  ok(lo.open_time === '00:00' && lo.close_time === '24:00', 'settings expose 24 hour hours');
  await pool.query("update reservation_settings set open_24_7=false, max_guests_per_slot=10, max_guests_per_booking=8 where id=1");
  console.log('\n7g. reminders 6 hours before every reservation');
  await pool.query("update reservation_settings set reminder_hours=6 where id=1");
  const mk = async (ph, name, hoursAhead, createdHoursAgo) => (await pool.query("insert into reservations (ref, phone_number, contact_phone, guest_name, guests, starts_at, status, created_at) values ($1,$2,$2,$3,2, now() + ($4 || ' hours')::interval, 'confirmed', now() - ($5 || ' hours')::interval) returning ref", ['RM-' + (1000 + Math.floor(Math.random() * 9000)), ph, name, String(hoursAhead), String(createdHoursAgo)])).rows[0].ref;
  const RO = '2348012345401'; await inbound(RO, 'ro1'); const roTok = await tokenOf(RO);   // window open
  const RC = '2348012345402'; await pool.query("insert into web_sessions (token, phone_number) values ('tokRC', $1)", [RC]);                  // window closed (never messaged)
  const RJ = '2348012345403'; await pool.query("insert into web_sessions (token, phone_number) values ('tokRJ', $1)", [RJ]);                  // window closed, template not approved
  await mk(RO, 'Remy Open', 5, 48); await mk(RC, 'Remy Closed', 5, 48); await mk(RJ, 'Remy Reject', 5, 48);
  await mk('2348012345404', 'Remy Later', 9, 48);          // 9h away: not yet
  await mk('2348012345405', 'Remy LateBooked', 4, 1);      // booked inside the 6h: nothing to remind
  await pool.query("update reservations set status='cancelled' where guest_name='Remy Cancelled'");
  const rb = sent.length; rejectReminderTemplate = false;
  const mkC = await mk('2348012345406', 'Remy Cancelled', 5, 48); await pool.query("update reservations set status='cancelled' where ref=$1", [mkC]);
  const n1 = await app.reminders.tick(); await settle();
  const rsent = sent.slice(rb);
  const open = rsent.find((x) => x.to === RO);
  ok(open?.interactive?.type === 'cta_url' && open.interactive.action.parameters.display_text === 'CHAT WITH US' && open.interactive.action.parameters.url === `https://app.test/ask/${roTok}`, 'window open: reminder with a CHAT WITH US button that opens the enquiry chat');
  ok(/^Hey Remy, just a reminder that by \d{1,2}:\d{2} (AM|PM) (today|tomorrow) you'll be spending time with us at Bali\. We are excited and we can't wait to see you!/.test(open.text), 'the reminder is warm: Hey Remy, just a reminder that by <time> you will be spending time with us at Bali, we are excited and cannot wait to see you');
  ok(/Table for 2 guests, Ref RM-/.test(open.text) && /For further enquiries, you can tap the button below to chat with us\.$/.test(open.text), 'it carries the booking details and the enquiries line');
  const tpl = rsent.find((x) => x.to === RC);
  ok(tpl?.tname === 'bali_reservation_reminder' && tpl.tcomponents[0].parameters[0].text === 'Remy' && /^\d{1,2}:\d{2} (AM|PM) (today|tomorrow)$/.test(tpl.tcomponents[0].parameters[1].text) && /^Table for 2 guests, Ref RM-/.test(tpl.tcomponents[0].parameters[2].text) && tpl.tcomponents[1].sub_type === 'url' && tpl.tcomponents[1].parameters[0].text === 'tokRC', 'window closed: the approved reminder template with the chat button for this guest');
  ok(n1 === 3 && !rsent.some((x) => x.to === '2348012345404' || x.to === '2348012345405' || x.to === '2348012345406'), 'only due reservations are reminded (not 9h away, not booked late, not cancelled)');
  const n2 = await app.reminders.tick(); ok(n2 === 0, 'a reminder is sent once only');
  ok((await pool.query("select count(*)::int n from reservations where guest_name like 'Remy %' and reminder_sent_at is not null")).rows[0].n === 3, 'reminder time is recorded');
  await pool.query("update reservations set reminder_sent_at=null, reminder_tries=0 where guest_name='Remy Reject'"); rejectReminderTemplate = true; const rb2 = sent.length;
  await app.reminders.tick(); await settle();
  ok(sent.slice(rb2).some((x) => x.to === RJ && x.template) && (await pool.query("select message_text from queued_messages where phone_number=$1", [RJ])).rows.some((q) => /chat with us here: https:\/\/app\.test\/ask\/tokRJ/.test(q.message_text)), 'template not approved yet: falls back to the ping + queued text with the chat link');
  rejectReminderTemplate = false;
  await pool.query("update reservations set reminder_sent_at=null where guest_name='Remy Open'"); await pool.query("update reservation_settings set reminder_hours=0 where id=1");
  ok((await app.reminders.tick()) === 0, 'reminders can be turned off (0 hours)');
  await pool.query("update reservation_settings set reminder_hours=6 where id=1");
  console.log('\n7i. the real payload from WhatsApp (no instruction key) is still a reservation');
  const realBody = { name: 'Real Payload', phone: '0803 444 5555', date: day(30), time: '20:30', guests: '3' };
  const real = await flowCall({ action: 'data_exchange', screen: 'RESERVE', flow_token: FT, version: '3.0', data: realBody });
  ok(real.json.screen === 'PAY' || real.json.screen === 'DONE', 'details with no step key become a reservation, not a blank form');
  ok(!(real.json.screen === 'RESERVE'), 'and never wipe the guest\'s entries by returning an empty form');
  const withStep = await flowCall({ action: 'data_exchange', screen: 'RESERVE', flow_token: FT, version: '3.0', data: { ...realBody, step: 'reserve', name: 'Step Payload', date: day(31) } });
  ok(withStep.json.screen === 'PAY' || withStep.json.screen === 'DONE', 'the new step key works too');
  if (real.json.screen === 'PAY') {
    const chk = await flowCall({ action: 'data_exchange', screen: 'PAY', flow_token: FT, version: '3.0', data: { ref: real.json.data.ref } });
    ok(chk.json.screen === 'PAY' && chk.json.data.has_note, 'a payment check with only a ref is understood');
  }
  const errBack = await flowCall({ action: 'data_exchange', screen: 'RESERVE', flow_token: FT, version: '3.0', data: { ...realBody, name: 'Typed Name', phone: '0803 444 5555', time: '04:00', date: day(32), guests: 'abc' } });
  ok(errBack.json.screen === 'RESERVE' && errBack.json.data.name_init === 'Typed Name' && errBack.json.data.phone_init === '0803 444 5555', 'when something is wrong the typed name and phone come straight back');
  console.log('\n7j. the AI (Claude) answers only from the knowledge base');
  env.ANTHROPIC_API_KEY = 'ak-test';
  await pool.query("update knowledge_base set answer = 'We have a lovely terrace overlooking the garden.' where question = 'Do you have parking?'");
  await pool.query("insert into knowledge_base (question, answer, keywords, sort_order) values ('Is there an outdoor area?', 'Yes, we have a terrace.', '', 99)");
  const cb = claudeCalls.length;
  const kbHit = (await ask('is there parking?')).reply;
  ok(claudeCalls.length === cb && /terrace overlooking/.test(kbHit), 'a question the knowledge base matches never calls the AI');
  const viaAi = (await ask('hello, do you have somewhere to sit outside? a terrace maybe')).reply;
  ok(/Yes, we have a terrace\./.test(viaAi), 'when the matcher finds nothing, the AI answers from the knowledge base');
  const lastCall = claudeCalls.at(-1);
  ok(lastCall.headers['x-api-key'] === 'ak-test' && lastCall.headers['anthropic-version'] === '2023-06-01' && lastCall.body.model === 'claude-haiku-5-5', 'request goes to Claude with the key (model claude-haiku-5-5)');
  ok(/ONLY this knowledge base/.test(lastCall.body.system) && /terrace overlooking the garden/.test(lastCall.body.system) && /Never invent/.test(lastCall.body.system), 'the AI is shown the knowledge base and told never to invent');
  const un0 = (await pool.query('select count(*)::int n from kb_unanswered')).rows[0].n;
  const sentBefore = sent.length;
  const notKb = (await ask('what is the wifi password and do you sell cigars')).reply;
  await settle();
  ok(/passed it to the team/.test(notKb) && (await pool.query('select count(*)::int n from kb_unanswered')).rows[0].n === un0 + 1, 'AI says not found: the question goes to the venue instead of being invented');
  claudeFail = true;
  const failed = (await ask('another thing entirely about live music nights')).reply;
  ok(/passed it to the team/.test(failed), 'if the AI is down the bot still answers safely (escalates)');
  claudeFail = false;
  delete env.ANTHROPIC_API_KEY;
  const cb2 = claudeCalls.length; await ask('something about valet and shuttles'); ok(claudeCalls.length === cb2, 'no key set: the AI is never called');

  console.log('\n7k. guests change their own reservation');
  await pool.query("update reservation_settings set max_guests_per_slot=0, max_guests_per_booking=0, change_cutoff_hours=3, open_24_7=true, reminder_hours=6, payments_enabled=false where id=1");
  const CH = '2348012345501'; await inbound(CH, 'ch1'); const chTok = await tokenOf(CH);
  const chBook = await call('POST', `/api/reserve/${chTok}`, form({ date: day(40), time: '19:00', guests: 2, name: 'Chidi Change' }));
  const chRef = chBook.json.ref; await pool.query("update reservations set status='confirmed', paid_amount_kobo=2050000, paystack_ref='PS-CH' where ref=$1", [chRef]);
  const confMsg = sent.filter((x) => x.to === CH).at(-1);
  ok(confMsg.interactive?.type === 'cta_url' && confMsg.interactive.action.parameters.display_text === 'TAP TO MANAGE' && /^https:\/\/app\.test\/m\/[a-f0-9]{12}$/.test(confMsg.interactive.action.parameters.url) && !/Manage your reservation here/.test(confMsg.text) && /confirmed/.test(confMsg.text) && /To change or cancel your reservation, you can manage it using the button below\.$/.test(confMsg.text), 'the confirmation tells them they can manage it with the button below, and the button is named TAP TO MANAGE');
  const mCode = confMsg.interactive.action.parameters.url.match(/\/m\/([a-f0-9]{12})/)[1];
  const mRes = await fetch(`${base}/m/${mCode}`, { redirect: 'manual' });
  ok(mRes.status === 302 && mRes.headers.get('location') === `/my/${chTok}`, 'the short manage link opens their reservation page');
  const myPage = (await call('GET', `/my/${chTok}`)).text;
  ok(/data-change="/.test(myPage) && myPage.includes('Change your reservation') && myPage.includes('id="csave"'), 'the reservation page has a Change button and form');
  ok(myPage.includes('fixedpage') && myPage.includes('position:fixed') && !myPage.includes('Book a table'), 'the reservation page stays fixed on screen (no page scroll or bounce) and has no Book a table button');
  const hc = sent.length;
  const chOk = await call('POST', `/api/my/${chTok}/change`, { ref: chRef, date: day(41), time: '21:30', guests: 5 }); await settle();
  const after = (await pool.query('select * from reservations where ref=$1', [chRef])).rows[0];
  ok(chOk.json.ok && after.guests === 5 && after.paid_amount_kobo === 2050000 && after.status === 'confirmed' && new Date(after.starts_at).getTime() > Date.now() + 40.5 * 86400000, 'date, time and guests updated, payment and status kept');
  ok(sent.slice(hc).some((x) => x.to === HANDOVER && /changed by the guest/.test(x.text) && /Was: /.test(x.text) && /Now: /.test(x.text) && /Chidi Change/.test(x.text)), 'the venue is told what changed (was / now)');
  const chMsg = sent.slice(hc).filter((x) => x.to === CH);
  ok(chMsg.length === 1 && /updated ✅/.test(chMsg[0].text) && /5 guests/.test(chMsg[0].text) && chMsg[0].interactive?.action?.parameters?.display_text === 'TAP TO MANAGE', 'a change sends the guest a new confirmation with the TAP TO MANAGE button');
  ok((await call('POST', `/api/my/${chTok}/change`, { ref: chRef, date: day(41), time: '21:30', guests: 5 })).json.errors._ === 'Nothing has changed yet.', 'saving with no changes is refused');
  ok((await call('POST', `/api/my/${chTok}/change`, { ref: chRef, date: '2020-01-01', time: '21:30', guests: 5 })).json.errors.date, 'a past date is refused');
  ok((await call('POST', `/api/my/${chTok}/change`, { ref: chRef, guests: 0 })).json.errors.guests, 'bad guest count refused');
  ok((await call('POST', `/api/my/${tok}/change`, { ref: chRef, guests: 9 })).status === 422 && (await pool.query('select guests from reservations where ref=$1', [chRef])).rows[0].guests === 5, "another guest's link cannot change this reservation");
  await pool.query("update reservations set reminder_sent_at = now() where ref=$1", [chRef]);
  await call('POST', `/api/my/${chTok}/change`, { ref: chRef, guests: 6 });
  ok((await pool.query('select reminder_sent_at from reservations where ref=$1', [chRef])).rows[0].reminder_sent_at === null, 'a changed booking gets its reminder scheduled again');
  await pool.query("update reservations set starts_at = now() + interval '2 hours' where ref=$1", [chRef]);
  ok(/Changes close 3 hours/.test((await call('POST', `/api/my/${chTok}/change`, { ref: chRef, guests: 7 })).json.errors._), 'inside the cut-off the guest is asked to contact the venue');
  await pool.query("update reservation_settings set change_cutoff_hours=0 where id=1");
  ok((await call('POST', `/api/my/${chTok}/change`, { ref: chRef, guests: 7 })).json.ok, 'cut-off 0 means changes are allowed any time before it starts');
  await pool.query("update reservation_settings set change_cutoff_hours=3, max_guests_per_slot=10 where id=1");
  const CH2 = '2348012345502'; await inbound(CH2, 'ch2'); const ch2Tok = await tokenOf(CH2);
  await call('POST', `/api/reserve/${ch2Tok}`, form({ date: day(45), time: '18:00', guests: 8, name: 'Slot Holder' }));
  const ch3 = '2348012345503'; await inbound(ch3, 'ch3'); const ch3Tok = await tokenOf(ch3);
  const mv = await call('POST', `/api/reserve/${ch3Tok}`, form({ date: day(46), time: '18:00', guests: 4, name: 'Mover' }));
  await pool.query("update reservations set status='confirmed' where ref=$1", [mv.json.ref]);
  const fullChg = await call('POST', `/api/my/${ch3Tok}/change`, { ref: mv.json.ref, date: day(45) });
  ok(!fullChg.json.ok && /fully booked/.test(fullChg.json.errors.time), 'with a slot cap, a change into a full time is refused');
  // texting the bot "cancel" / "change": one tap-to-manage button
  await pool.query("update reservations set starts_at = now() + interval '10 days', status='confirmed' where ref=$1", [chRef]);
  const bm = sent.length; await inbound(CH, 'mg1', 'hi I want to cancel my reservation');
  const mgm = sent.slice(bm).filter((x) => x.to === CH);
  ok(mgm.length === 1 && mgm[0].interactive?.action?.parameters?.display_text === 'TAP TO MANAGE' && /\/m\/[a-f0-9]{12}$/.test(mgm[0].interactive.action.parameters.url), 'texting cancel or change gets ONE tap-to-manage button, not the whole welcome');
  const NOR = '2348012345510'; const bn = sent.length; await inbound(NOR, 'mg2', 'please cancel');
  ok(sent.slice(bn).filter((x) => x.to === NOR).every((x) => !(x.interactive?.action?.parameters?.display_text === 'TAP TO MANAGE')), 'someone with no reservation just gets the normal welcome');
  // guest cancel on the page: no WhatsApp message to the guest; the venue is told only when notify_changes is on
  const bc = sent.length; await call('POST', `/api/my/${chTok}/cancel`, { ref: chRef }); await settle();
  ok(sent.slice(bc).some((x) => x.to === CH && /is cancelled/.test(x.text)) && sent.slice(bc).some((x) => x.to === HANDOVER && /cancelled by guest/.test(x.text)), 'a guest cancelling gets a cancellation confirmation, and the venue is told');
  await pool.query("update reservation_settings set notify_changes=false where id=1");
  const CH4 = '2348012345504'; await inbound(CH4, 'ch4'); const ch4Tok = await tokenOf(CH4);
  const q4 = await call('POST', `/api/reserve/${ch4Tok}`, form({ date: day(50), time: '12:00', guests: 2, name: 'Quiet Change' }));
  const bq = sent.length;
  await call('POST', `/api/my/${ch4Tok}/change`, { ref: q4.json.ref, guests: 3 }); await call('POST', `/api/my/${ch4Tok}/cancel`, { ref: q4.json.ref }); await settle();
  ok(!sent.slice(bq).some((x) => x.to === HANDOVER) && sent.slice(bq).filter((x) => x.to === CH4).length === 2, 'with notify_changes off the venue hears nothing, but the guest still gets their change and cancel confirmations');
  const sc = sent.length; const CH5 = '2348012345505'; await inbound(CH5, 'ch5');
  const q5 = await call('POST', `/api/reserve/${await tokenOf(CH5)}`, form({ date: day(51), time: '13:00', guests: 2, name: 'Staff Cancel' }));
  const cookie0 = (await fetch(base + '/dashboard/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=pw' })).headers.get('set-cookie').split(';')[0];
  await call('POST', `/api/reservations/${q5.json.ref}/cancel`, { refund: 'none' }, cookie0); await settle();
  ok(sent.slice(sc).some((x) => x.to === CH5 && /had to cancel/.test(x.text)), 'a cancellation by STAFF is still told to the guest');
  await pool.query("update reservation_settings set notify_changes=true where id=1");
  await pool.query("update reservation_settings set payments_enabled=true where id=1");
  await pool.query("update reservation_settings set max_guests_per_slot=0, open_24_7=false where id=1");
  console.log('\n7l. twoRes handover numbers');
  const HANDOVER2 = '2348039990000';
  await pool.query("update reservation_settings set handover_number_2='0803 999 0000', payments_enabled=false, open_24_7=true, change_cutoff_hours=3 where id=1");
  await inbound(HANDOVER2, 'h2open', 'hi'); // the second number has messaged the bot, so its WhatsApp window is open
  const T2 = '2348012345601'; await inbound(T2, 't21'); const t2Tok = await tokenOf(T2);
  const hbt = sent.length;
  const twoRes = await call('POST', `/api/reserve/${t2Tok}`, form({ date: day(52), time: '19:00', guests: 3, name: 'Two Numbers' })); await settle();
  const bothNums = sent.slice(hbt).filter((x) => /Two Numbers/.test(x.text || '') && /New table reservation/.test(x.text || ''));
  ok(twoRes.json.ok && bothNums.some((x) => x.to === HANDOVER) && bothNums.some((x) => x.to === HANDOVER2), 'a completed reservation is sent to BOTH handover numbers');
  ok(bothNums.length === 2, 'each number gets it exactly once');
  const hb2 = sent.length; await inbound(HANDOVER2, 'h2a', 'okay');
  ok(!sent.slice(hb2).some((x) => x.to === HANDOVER2 && x.interactive), 'the second handover number never gets the guest welcome either');
  const hb3 = sent.length; await call('POST', `/api/my/${t2Tok}/change`, { ref: twoRes.json.ref, guests: 4 }); await settle();
  ok(sent.slice(hb3).filter((x) => /changed by the guest/.test(x.text || '')).map((x) => x.to).sort().join() === [HANDOVER, HANDOVER2].sort().join(), 'other notices (changes, cancellations, questions) reach bothNums numbers too');
  await pool.query("update reservation_settings set handover_number_2='0803 111 2222' where id=1");
  const hb4 = sent.length; await call('POST', `/api/reserve/${t2Tok}`, form({ date: day(53), time: '19:00', guests: 2, name: 'Same Number' })); await settle();
  ok(sent.slice(hb4).filter((x) => /Same Number/.test(x.text || '') && /New table reservation/.test(x.text || '')).length === 1, 'the same number entered twice only receives one copy');
  await pool.query("update reservation_settings set handover_number_2=null where id=1");
  const hb5 = sent.length; await call('POST', `/api/reserve/${t2Tok}`, form({ date: day(54), time: '19:00', guests: 2, name: 'Only One' })); await settle();
  ok(sent.slice(hb5).filter((x) => /Only One/.test(x.text || '') && /New table reservation/.test(x.text || '')).map((x) => x.to).join() === HANDOVER, 'with no second number, only the first receives it');
  await pool.query("update reservation_settings set payments_enabled=true, open_24_7=false where id=1");

  console.log('\n7m. safety timer: the confirmation still arrives if the guest never taps Done');
  await pool.query("update reservation_settings set payments_enabled=false, open_24_7=true where id=1");
  const SF = '2348012345701'; await inbound(SF, 'sf1'); const sfTok = await tokenOf(SF);
  const sfRes = await flowCall({ action: 'data_exchange', screen: 'RESERVE', flow_token: 'bali-' + sfTok, version: '3.0', data: { name: 'Never Taps', phone: '0803 777 1111', date: day(33), time: '21:00', guests: '2' } });
  ok(sfRes.json.screen === 'DONE', 'booking made inside the form (payments off)');
  const bsf = sent.length; ok((await app.confirmations.sendDue()) === 0 && !sent.slice(bsf).some((x) => x.to === SF), 'not due yet: nothing sent');
  await pool.query("update reservations set confirm_due_at = now() - interval '1 second' where guest_name = 'Never Taps'");
  const dueN = await app.confirmations.sendDue(); await settle();
  ok(dueN === 1 && sent.slice(bsf).filter((x) => x.to === SF && /Your table at Bali is confirmed/.test(x.text || '')).length === 1, 'after 2 minutes the confirmation is sent anyway, once');
  ok((await app.confirmations.sendDue()) === 0, 'and never again');
  await pool.query("update reservation_settings set payments_enabled=true, open_24_7=false where id=1");

  console.log('\n7n. Meta hiccups never leave a guest without a reply');
  await pool.query("update reservation_settings set flow_id='FLOWX' where id=1");
  const HI = '2348012345801'; const bh = sent.length; graphTransient = 2;
  await inbound(HI, 'hi1', 'hi'); await settle();
  const afterRetry = sent.slice(bh).filter((x) => x.to === HI);
  ok(afterRetry.length === 1 && afterRetry[0].interactive?.type === 'flow', 'two temporary Meta errors in a row: the welcome form message is still delivered (retries)');
  const HJ = '2348012345802'; const bj = sent.length; graphFlowDown = true;
  await inbound(HJ, 'hj1', 'hello'); await settle();
  const fb = sent.slice(bj).filter((x) => x.to === HJ);
  ok(fb.length === 1 && !fb[0].interactive && /Reserve your table here:\nhttps:\/\/app\.test\/reserve\//.test(fb[0].text) && /Questions\? Chat with us:\nhttps:\/\/app\.test\/c\//.test(fb[0].text), 'if the form message cannot be delivered at all, the guest still gets a reply with the reservation and chat links');
  graphFlowDown = false;
  await pool.query("update reservation_settings set flow_id=null where id=1");

  console.log('\n7o. payments through Monnify');
  const savedPk = env.PAYSTACK_SECRET_KEY; delete env.PAYSTACK_SECRET_KEY;
  Object.assign(env, { MONNIFY_API_KEY: 'MK_TEST_X', MONNIFY_SECRET_KEY: 'SECRETY', MONNIFY_CONTRACT_CODE: '1234567', MONNIFY_BASE_URL: 'https://sandbox.monnify.com' });
  await pool.query("update reservation_settings set payments_enabled=true, open_24_7=true, reminder_hours=0 where id=1");
  const MN = '2348012345901'; await inbound(MN, 'mn1'); const mnTok = await tokenOf(MN);
  const mnRes = await call('POST', `/api/reserve/${mnTok}`, form({ date: day(35), time: '19:00', guests: 2, name: 'Mona Nify' }));
  ok(mnRes.json.ok && mnRes.json.status === 'pending_payment' && /^https:\/\/sandbox\.sdk\.monnify\.com\/checkout\/MNFY%7C90%7CBALI-/.test(mnRes.json.payUrl) && !mnRes.json.payUrl.includes('|') && mnRes.json.amountKobo === 2050000, "Monnify checkout link for N20,500, with the pipe characters percent-encoded so WhatsApp's button accepts it");
  const mnLogin = monnifyCalls.find((c) => c.path === '/api/v1/auth/login'); const mnInit = monnifyCalls.filter((c) => c.path.endsWith('init-transaction')).at(-1);
  ok(mnLogin.headers.Authorization === 'Basic ' + Buffer.from('MK_TEST_X:SECRETY').toString('base64'), 'logs in with the API key and secret (Basic auth)');
  ok(mnInit.headers.Authorization === 'Bearer mtok' && mnInit.body.amount === 20500 && mnInit.body.contractCode === '1234567' && mnInit.body.currencyCode === 'NGN' && mnInit.body.customerName === 'Mona Nify' && /^BALI-/.test(mnInit.body.paymentReference) && /\/reserve\/.+\/done\?ref=/.test(mnInit.body.redirectUrl), 'mnInit request: amount in naira (20500), contract code, guest name, our reference, return link');
  ok(/Waiting for your payment/.test((await call('GET', `/reserve/${mnTok}/done?ref=${mnRes.json.ref}`)).text), 'unpaid: the return page waits');
  const mnRef = (await pool.query('select paystack_ref from reservations where ref=$1', [mnRes.json.ref])).rows[0].paystack_ref; paid.add(mnRef);
  const hm0 = sent.length;
  await call('POST', '/webhook/monnify', { eventType: 'SUCCESSFUL_TRANSACTION', eventData: { paymentReference: mnRef, paymentStatus: 'PAID', amountPaid: 20500 } }); await settle();
  ok((await pool.query('select status, paid_amount_kobo from reservations where ref=$1', [mnRes.json.ref])).rows[0].status === 'confirmed', 'the Monnify webhook (re-verified) confirms the reservation');
  ok(sent.slice(hm0).some((x) => x.to === HANDOVER && /Mona Nify/.test(x.text || '')), 'details handed over after the Monnify payment');
  const hm1 = sent.length; await call('POST', '/webhook/monnify', { eventType: 'SUCCESSFUL_TRANSACTION', eventData: { paymentReference: 'NOPE', paymentStatus: 'PAID' } }); await call('POST', '/webhook/monnify', { eventType: 'FAILED_TRANSACTION', eventData: { paymentReference: mnRef, paymentStatus: 'FAILED' } }); await settle();
  ok(sent.length === hm1, 'unknown references and failed-payment events do nothing');
  const mnCan = await call('POST', `/api/my/${mnTok}/cancel`, { ref: mnRes.json.ref });
  ok(mnCan.json.ok && monnifyRefunds.length === 1 && monnifyRefunds[0].refundAmount === 20000 && monnifyRefunds[0].transactionReference === 'MNFY|' + mnRef && monnifyRefunds[0].contractCode === '1234567', 'cancelling 24h+ ahead refunds N20,000 through Monnify (not the service fee)');
  const stg = (await fetch(base + '/dashboard/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=pw' })).headers.get('set-cookie').split(';')[0];
  const stJ = (await call('GET', '/api/settings', null, stg)).json;
  ok(stJ.paymentsConfigured === true && stJ.paymentProvider === 'Monnify', 'the dashboard reports Monnify as connected');
  delete env.MONNIFY_API_KEY; env.PAYSTACK_SECRET_KEY = savedPk;
  ok((await call('GET', '/api/settings', null, stg)).json.paymentProvider === 'Paystack', 'with only Paystack keys, Paystack is used');
  env.PAYMENT_PROVIDER = 'monnify'; ok((await call('GET', '/api/settings', null, stg)).json.paymentProvider === 'Paystack', 'a provider that is not configured is never chosen'); delete env.PAYMENT_PROVIDER;
  delete env.MONNIFY_SECRET_KEY; delete env.MONNIFY_CONTRACT_CODE; delete env.MONNIFY_BASE_URL;
  await pool.query("update reservation_settings set payments_enabled=true, open_24_7=false, reminder_hours=6 where id=1");

  console.log('\n7p. a slow payment provider never leaves the form spinning');
  await pool.query("update reservation_settings set payments_enabled=true, open_24_7=true where id=1");
  const SLW = '2348012345951'; await inbound(SLW, 'slw1'); const slwTok = await tokenOf(SLW);
  payHang = true; const slwStart = Date.now();
  const slw = await flowCall({ action: 'data_exchange', screen: 'RESERVE', flow_token: 'bali-' + slwTok, version: '3.0', data: { step: 'reserve', name: 'Slow Pay', phone: '0803 555 1212', date: day(38), time: '20:00', guests: '2' } });
  const slwMs = Date.now() - slwStart; payHang = false;
  ok(slw.json.screen === 'RESERVE' && /took too long/.test(slw.json.data.error) && slwMs < 1200, 'a payment provider that takes too long: the form answers within the time limit with a clear message (' + slwMs + 'ms)');
  ok(slw.json.data.name_init === 'Slow Pay' && slw.json.data.phone_init === '0803 555 1212' && slw.json.data.date_init === day(38) && slw.json.data.time_init === '20:00' && slw.json.data.guests_init === '2', 'and their entries are kept so they only tap Continue again');
  await new Promise((r) => setTimeout(r, 1700));
  const slw2 = await flowCall({ action: 'data_exchange', screen: 'RESERVE', flow_token: 'bali-' + slwTok, version: '3.0', data: { step: 'reserve', name: 'Slow Pay', phone: '0803 555 1212', date: day(38), time: '20:00', guests: '2' } });
  ok(slw2.json.screen === 'PAY', 'tapping Continue again goes straight through to payment once the provider is back');
  ok((await pool.query("select count(*)::int n from reservations where guest_name='Slow Pay' and status='pending_payment'")).rows[0].n === 1, 'and only one table hold is left (the earlier attempt was replaced)');
  await pool.query("update reservation_settings set payments_enabled=true, open_24_7=false where id=1");

  console.log('\n7q. after paying, back to the WhatsApp chat');
  await pool.query("update reservation_settings set payments_enabled=true, open_24_7=true where id=1");
  const BK = '2348012345961'; await inbound(BK, 'bk1'); const bkTok = await tokenOf(BK);
  const bkSent = sent.length;
  const bkRes = await flowCall({ action: 'data_exchange', screen: 'RESERVE', flow_token: 'bali-' + bkTok, version: '3.0', data: { step: 'reserve', name: 'Back Chat', phone: '0803 666 1212', date: day(36), time: '20:00', guests: '2' } });
  const bkRef = bkRes.json.data.ref; const bkPay = (await pool.query('select paystack_ref from reservations where ref=$1', [bkRef])).rows[0].paystack_ref; paid.add(bkPay);
  const bkPage = (await call('GET', `/reserve/${bkTok}/done?ref=${bkRef}`)).text;
  ok(/Payment received/.test(bkPage) && /Close this page to go back to WhatsApp, then tap <b>I have paid<\/b>/.test(bkPage) && /window\.close\(\)/.test(bkPage) && !/location\.href="https:\/\/wa\.me/.test(bkPage) && !/Your table is confirmed/.test(bkPage), 'paid inside the form: the return page closes itself (WhatsApp built-in browser) so the guest is back on the form screen to tap I have paid; no jump to a different chat');
  ok(sent.slice(bkSent).filter((x) => x.to === BK).length === 0, 'and no WhatsApp message was sent to the guest during payment');
  ok(!/Place your order/.test(bkPage), 'and does not send them off to other pages');
  await pool.query("update reservation_settings set payments_enabled=true, open_24_7=false where id=1");

  console.log('\n7r. confirmed only when the payment webhook says so');
  await pool.query("update reservation_settings set confirm_via_webhook=true, payments_enabled=true, open_24_7=true where id=1");
  const WH = '2348012345971'; await inbound(WH, 'wh1'); const whTok = await tokenOf(WH);
  const whRes = await flowCall({ action: 'data_exchange', screen: 'RESERVE', flow_token: 'bali-' + whTok, version: '3.0', data: { step: 'reserve', name: 'Web Hook', phone: '0803 444 1212', date: day(37), time: '20:00', guests: '2' } });
  const whRef = whRes.json.data.ref; const whPay = (await pool.query('select paystack_ref from reservations where ref=$1', [whRef])).rows[0].paystack_ref; paid.add(whPay); // the money has arrived at the provider
  const hw0 = sent.length;
  const pg1 = (await call('GET', `/reserve/${whTok}/done?ref=${whRef}`)).text;
  ok(/Waiting for your payment/.test(pg1) && !/Your table is confirmed/.test(pg1), 'return page: paid but the webhook has not arrived: it still says waiting, never confirmed');
  const chk1 = await flowCall({ action: 'data_exchange', screen: 'PAY', flow_token: 'bali-' + whTok, version: '3.0', data: { step: 'check', ref: whRef } });
  ok(chk1.json.screen === 'PAY' && chk1.json.data.has_note && /waiting for your payment to be confirmed/.test(chk1.json.data.note), 'the I-have-paid button: still the payment screen, with a waiting note');
  ok((await pool.query('select status from reservations where ref=$1', [whRef])).rows[0].status === 'pending_payment' && !sent.slice(hw0).some((x) => x.to === HANDOVER || /confirmed/.test(x.text || '')), 'nothing is confirmed, handed over or messaged yet');
  await call('POST', '/webhook/paystack', { event: 'charge.success', data: { reference: whPay } }); await settle();
  ok((await pool.query('select status from reservations where ref=$1', [whRef])).rows[0].status === 'confirmed', 'the webhook confirms it');
  ok(sent.slice(hw0).some((x) => x.to === HANDOVER && /Web Hook/.test(x.text || '')), 'and only then is it handed over');
  const chk2 = await flowCall({ action: 'data_exchange', screen: 'PAY', flow_token: 'bali-' + whTok, version: '3.0', data: { step: 'check', ref: whRef } });
  ok(chk2.json.screen === 'DONE', 'after the webhook, the I-have-paid button moves on to the confirmed screen');
  ok(/Payment received/.test((await call('GET', `/reserve/${whTok}/done?ref=${whRef}`)).text), 'and the return page now says payment received');
  const WH2 = '2348012345972'; await inbound(WH2, 'wh2'); const wh2Tok = await tokenOf(WH2);
  const wh2 = await flowCall({ action: 'data_exchange', screen: 'RESERVE', flow_token: 'bali-' + wh2Tok, version: '3.0', data: { step: 'reserve', name: 'Never Paid', phone: '0803 444 1313', date: day(37), time: '21:00', guests: '2' } });
  await call('POST', '/webhook/paystack', { event: 'charge.success', data: { reference: (await pool.query('select paystack_ref from reservations where ref=$1', [wh2.json.data.ref])).rows[0].paystack_ref } }); await settle();
  ok((await pool.query('select status from reservations where ref=$1', [wh2.json.data.ref])).rows[0].status === 'pending_payment', 'a webhook for a payment that never actually happened confirms nothing (it is re-checked with the provider)');
  await pool.query("update reservation_settings set confirm_via_webhook=false, payments_enabled=true, open_24_7=false where id=1");

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
  ok(kl.unanswered.length >= 1 && kl.unanswered.some((u) => /pets/.test(u.question)), 'unanswered list visible');
  await call('POST', `/api/kb/unanswered/${kl.unanswered[0].id}/answer`, { question: 'Do you allow pets?', answer: 'Yes on the terrace.' }, cookie);
  ok((await call('GET', '/api/kb', null, cookie)).json.unanswered.length === kl.unanswered.length - 1, 'answering clears it from the unanswered list');
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

  const refs = (await pool.query("select ref from reservations where source = 'form' order by created_at")).rows.map((x) => x.ref).filter((x) => !x.startsWith('RM-'));
  const refsOk = refs.length > 5 && refs.every((x) => /^R-\d{3,}$/.test(x)) && refs[1] === 'R-002' && new Set(refs).size === refs.length;
  ok(refsOk, 'numbers run R-001, R-002, ... with no repeats' + (refsOk ? '' : ' (got ' + refs.join(',') + ')'));
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  server.close(); await pool.end(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

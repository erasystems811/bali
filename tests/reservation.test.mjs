import { makeDb, run } from './reservation-harness.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL:', m); } else console.log('  ok:', m); };
const db = makeDb();
const sent = [];
const G = '2348011110001', G2 = '2348011110002', STAFF = '2349099990001';
db.t.contacts.push({ id: 'c-staff', phone_number: STAFF, role: 'pm', name: 'Joseph' });
db.t.reservation_log.push({ phone_number: STAFF, direction: 'inbound', message_text: 'hi', created_at: new Date().toISOString() });
const say = async (from, text, role = 'customer') => {
  const r = await run(db, sent, { from_number: from, text, role });
  console.log(`  [${role}] ${text}\n     -> ${r.replies.filter((x) => x.to === from).map((x) => x.text).join(' || ')}`);
  return r;
};
const txt = (r, to) => r.replies.find((x) => x.to === to)?.text || '';
function localHour(iso) { return new Date(new Date(iso).getTime() + 3600000).getUTCHours(); }
function localDow(iso) { return new Date(new Date(iso).getTime() + 3600000).getUTCDay(); }

console.log('\n1. hello then step by step');
await say(G, 'hi');
await say(G, 'tomorrow');
await say(G, '7pm');
await say(G, '4');
let r = await say(G, 'Ada');
ok(db.t.reservations.length === 1 && db.t.reservations[0].guests === 4, 'reservation created with 4 guests');
ok(/R-\d{4}/.test(txt(r, G)), 'guest got a ref');
ok(sent.some((x) => x.to === STAFF && /New reservation/.test(x.text || '')), 'staff notified');
const ref = db.t.reservations[0].ref;

console.log('\n2. all in one message');
await say(G2, 'Can I get a table for 3 on friday at 8pm? Name is Tunde');
const r2 = db.t.reservations.find((x) => x.phone_number === G2);
ok(!!r2 && r2.guests === 3 && r2.guest_name === 'Tunde', 'one-message booking worked (3 guests, Tunde)');

console.log('\n3. capacity: slot max 10 guests');
const G3 = '2348011110003';
await say(G3, 'table for 6 tomorrow 7pm, name Bola');
ok(db.t.reservations.some((x) => x.phone_number === G3), 'fills slot exactly to 10');
const G4 = '2348011110004';
const rf = await say(G4, 'table for 2 tomorrow 7pm, name Kemi');
ok(!db.t.reservations.some((x) => x.phone_number === G4), 'slot full, not booked');
ok(/fully booked/.test(txt(rf, G4)), 'told it is full with alternatives');
await say(G4, '8pm');
ok(db.t.reservations.some((x) => x.phone_number === G4), 'accepted alternative time');

console.log('\n4. validation');
const G5 = '2348011110005';
await say(G5, 'table for 2 tomorrow at 3am name Zed');
ok(!db.t.reservations.some((x) => x.phone_number === G5), '3am rejected (outside hours)');
await say(G5, 'yesterday');
ok(!db.t.reservations.some((x) => x.phone_number === G5), 'past date not booked');
await say('2348011110006', 'table for 20 people tomorrow 7pm');
ok(!db.t.reservations.some((x) => x.phone_number === '2348011110006'), 'big party not auto booked');
ok(sent.some((x) => x.to === STAFF && /Large party/.test(x.text || '')), 'staff told about big party');

console.log('\n5. status, change, cancel (guest 1)');
await say(G, 'do I have a booking?');
await say(G, 'can I change it to 8pm');
ok(localHour(db.t.reservations.find((x) => x.ref === ref).starts_at) === 20, 'time changed to 8pm local');
await say(G, 'cancel my reservation');
ok(db.t.reservations.find((x) => x.ref === ref).status === 'confirmed', 'not cancelled until confirmed');
await say(G, 'yes');
ok(db.t.reservations.find((x) => x.ref === ref).status === 'cancelled', 'cancelled after YES');

console.log('\n6. info question');
await say(G, 'do you have parking?');
await say(G, 'what is the dress code?');
ok(sent.some((x) => x.to === STAFF && /Guest question/.test(x.text || '')), 'unknown question escalated to staff');

console.log('\n7. staff commands');
await say(STAFF, 'tomorrow', 'pm');
await say(STAFF, 'move ' + r2.ref + ' to sat 7pm', 'pm');
ok(localDow(db.t.reservations.find((x) => x.ref === r2.ref).starts_at) === 6, 'staff moved to Saturday');
ok(sent.some((x) => x.to === G2 && /moved/.test(x.text || '')), 'guest told about move');
await say(STAFF, 'cancel ' + r2.ref + ' sorry we are closed for a private event', 'pm');
ok(db.t.reservations.find((x) => x.ref === r2.ref).status === 'cancelled', 'staff cancelled');
const before = sent.length;
await say(STAFF, 'hello can you tell the guests we open late', 'pm');
ok(!sent.slice(before).some((x) => x.to !== STAFF), 'staff free text is NEVER relayed to guests');

console.log('\n8. media');
const rm = await run(db, sent, { from_number: G, text: null, media_type: 'audio', role: 'customer' });
ok(/type/.test(rm.replies[0]?.text || ''), 'voice note gets a type-it-out reply');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);

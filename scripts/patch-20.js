const fs = require('fs');
const root = require('path').join(__dirname, '..');
const P = (f) => require('path').join(root, f);
function edit(file, pairs) {
  let s = fs.readFileSync(P(file), 'utf8');
  for (const [a, b] of pairs) { if (!s.includes(a)) throw new Error(file + ' anchor: ' + a.slice(0, 90)); s = s.replace(a, () => b); }
  fs.writeFileSync(P(file), s);
}

fs.writeFileSync(P('supabase/reservations-v10.sql'), `-- v10 (2026-11-23): guests can change their own reservation until this many hours before arrival (0 = any time). Idempotent.
alter table reservation_settings add column if not exists change_cutoff_hours int not null default 3;
`);

edit('app/lib/core.js', [["  reminder_hours: 6,", "  change_cutoff_hours: 3, // guests can change their reservation until this many hours before arrival (0 = any time)\n  reminder_hours: 6,"]]);

edit('app/lib/resv.js', [
  // confirmation message tells them how to change/cancel
  ["    const msg = `Your table at ${S.venue_name} is confirmed ✅", "    const short = await sessionShort(r.phone_number);\n    const manage = `\\n\\nNeed to change or cancel? Manage your reservation here: ${base()}/m/${short}`;\n    const msg = `Your table at ${S.venue_name} is confirmed ✅"],
  ["you can do that through this link: ${link}` : ''}`;", "you can do that through this link: ${link}` : ''}${manage}`;"],
  // the change itself
  ["  async function forGuest(phone) {", `  // A guest changes their own reservation (date, time, guests). Their payment stays with the booking.
  async function change(ref, sessionPhone, input) {
    const S = await loadSettings(ctx); const T = makeTime(S, nowFn);
    const { rows } = await pool.query('select * from reservations where ref=$1 and phone_number=$2', [String(ref || ''), sessionPhone]);
    const r = rows[0];
    if (!r) return { ok: false, errors: { _: 'We could not find that reservation.' } };
    if (r.status !== 'confirmed') return { ok: false, errors: { _: r.status === 'pending_payment' ? 'Please finish your payment first, or cancel and start again.' : 'This reservation can no longer be changed.' } };
    const hrs = (new Date(r.starts_at).getTime() - nowFn()) / 3600000;
    if (S.change_cutoff_hours > 0 && hrs < S.change_cutoff_hours) return { ok: false, errors: { _: \`Changes close \${S.change_cutoff_hours} hours before your arrival. Please contact the venue.\` } };
    const cur = T.utcToLocalParts(r.starts_at);
    const { errors, clean } = validate(S, T, {
      name: r.guest_name, phone: r.contact_phone || r.phone_number,
      date: input.date || cur.date, time: input.time || cur.time, guests: input.guests === undefined || input.guests === '' ? r.guests : input.guests,
    });
    if (Object.keys(errors).length) return { ok: false, errors };
    if (clean.date === cur.date && clean.time === cur.time && clean.guests === r.guests) return { ok: false, errors: { _: 'Nothing has changed yet.' } };
    const client = await pool.connect();
    let upd;
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [\`bali-slot-\${clean.date}\`]);
      if (over(S, (await guestsBooked(S, T, clean.date, clean.time, r.ref, client)) + clean.guests)) {
        await client.query('rollback');
        return { ok: false, errors: { time: 'That time is fully booked. Please choose another.' } };
      }
      upd = (await client.query(
        'update reservations set starts_at=$2, guests=$3, reminder_sent_at=null, reminder_tries=0, updated_at=now() where ref=$1 returning *',
        [r.ref, T.localToUtcISO(clean.date, clean.time), clean.guests])).rows[0];
      await client.query('commit');
    } catch (e) { try { await client.query('rollback'); } catch (_) {} throw e; } finally { client.release(); }
    await notifyHandover(S, \`Reservation \${r.ref} was changed by the guest ✏️\\nName: \${r.guest_name}\\nPhone: \${r.contact_phone || r.phone_number}\\nWas: \${describe(r, T)}\\nNow: \${describe(upd, T)}\`, 'a changed reservation');
    try { await wa.send(r.phone_number, \`Done, your reservation \${r.ref} is updated ✅\\n\\n\${describe(upd, T)}\\n\\nSee you then.\`, 'your reservation'); } catch (e) {}
    return { ok: true, ref: r.ref, text: describe(upd, T) };
  }

  async function forGuest(phone) {`],
  ["  return { sessionShort, validate,", "  return { change, sessionShort, validate,"],
]);

edit('app/server.js', [
  ["  app.post('/api/my/:token/cancel',", `  // Guest changes date / time / guests on their own reservation
  app.post('/api/my/:token/change', wrap(async (req, res) => {
    if (limited(\`chg:\${req.ip}\`, 20, 60000)) return res.status(429).json({ ok: false, errors: { _: 'Too many attempts, please wait a minute.' } });
    const s = await sessionFor(req.params.token);
    if (!s) return res.status(404).json({ ok: false, errors: { _: 'This link is not valid.' } });
    const out = await resv.change(req.body?.ref, s.phone_number, req.body || {});
    res.status(out.ok ? 200 : 422).json(out);
  }));
  // short manage link used in the confirmation message
  app.get('/m/:code', wrap(async (req, res) => {
    const { rows } = await pool.query('select token from web_sessions where short_code=$1', [String(req.params.code).slice(0, 20)]);
    if (!rows[0]) return res.status(404).send(pages.notFound());
    res.redirect(\`/my/\${rows[0].token}\`);
  }));
  app.post('/api/my/:token/cancel',`],
  ["list: list.map((r) => ({ ...r, text: resv.describe(r, T), hoursAway: (new Date(r.starts_at).getTime() - Date.now()) / 3600000 })) ,", "list: list.map((r) => { const lp = T.utcToLocalParts(r.starts_at); return { ...r, text: resv.describe(r, T), ldate: lp.date, ltime: lp.time, hoursAway: (new Date(r.starts_at).getTime() - Date.now()) / 3600000 }; }),"],
  ["payments_enabled: 'bool', open_24_7: 'bool', reminder_hours: 'int',", "payments_enabled: 'bool', open_24_7: 'bool', reminder_hours: 'int', change_cutoff_hours: 'int',"],
]);

edit('app/public/dashboard.js', [["field('reminder_hours', 'Send a reminder before arrival (hours, 0 = off)', 'number', 'Guests get the booking details and a CHAT WITH US button'),", "field('reminder_hours', 'Send a reminder before arrival (hours, 0 = off)', 'number', 'Guests get the booking details and a CHAT WITH US button'), field('change_cutoff_hours', 'Guests can change a reservation until (hours before arrival, 0 = any time)', 'number', 'They change the date, time or guests from their reservation page'),"]]);

// manage page: Change button + form
edit('app/views/pages.js', [
  ["      <button class=\"btn danger small\" data-ref=\"${esc(r.ref)}\" data-note=\"${esc(refundNote)}\">Cancel reservation</button></div>`;", "      <div style=\"display:flex;gap:10px;flex-wrap:wrap\">${r.status === 'confirmed' ? `<button class=\"btn small\" data-change=\"${esc(r.ref)}\" data-date=\"${esc(r.ldate)}\" data-time=\"${esc(r.ltime)}\" data-guests=\"${r.guests}\">Change</button>` : ''}<button class=\"btn danger small\" data-ref=\"${esc(r.ref)}\" data-note=\"${esc(refundNote)}\">Cancel reservation</button></div></div>`;"],
  ["  <div class=\"modal\" id=\"m\">", `  <div class="modal" id="cm"><div class="sheet"><h1 style="font-size:20px">Change your reservation</h1><p class="note" id="cmref"></p>
   <div class="field"><label for="cd">Date</label><input id="cd" type="date" min="\${esc(T.todayStr())}" max="\${esc(T.addDaysISO(T.todayStr(), S.max_days_ahead))}"></div>
   <div class="field"><label for="ct">Arrival time</label><input id="ct" type="time"></div>
   <div class="field"><label for="cg">Number of guests</label><input id="cg" type="number" inputmode="numeric" min="1"></div>
   <p class="note">Your payment stays with the new booking. Changes close \${S.change_cutoff_hours > 0 ? S.change_cutoff_hours + ' hours' : 'at arrival'} before you arrive.</p>
   <div class="err" id="cerr" style="margin-bottom:10px"></div>
   <button class="btn" id="csave">Save changes</button><button class="btn ghost" id="cno" style="margin-top:10px">Close</button></div></div>
  <div class="modal" id="m">`],
  ["body:JSON.stringify({ref:cur})});location.reload()};</script>", `body:JSON.stringify({ref:cur})});location.reload()};
  let chg=null;const cm=document.getElementById('cm');
  document.querySelectorAll('[data-change]').forEach(b=>b.onclick=()=>{chg=b.dataset.change;document.getElementById('cmref').textContent='Reservation '+chg;document.getElementById('cd').value=b.dataset.date;document.getElementById('ct').value=b.dataset.time;document.getElementById('cg').value=b.dataset.guests;document.getElementById('cerr').textContent='';cm.classList.add('open')});
  document.getElementById('cno').onclick=()=>cm.classList.remove('open');
  document.getElementById('csave').onclick=async()=>{const s=document.getElementById('csave');const er=document.getElementById('cerr');er.textContent='';s.disabled=true;s.textContent='Saving…';
   try{const r=await fetch('/api/my/${esc(token)}/change',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ref:chg,date:document.getElementById('cd').value,time:document.getElementById('ct').value,guests:+document.getElementById('cg').value})});const j=await r.json();
    if(j.ok){location.reload();return}er.textContent=Object.values(j.errors||{})[0]||'Something went wrong.'}catch(e){er.textContent='Network problem. Please try again.'}
   s.disabled=false;s.textContent='Save changes'};</script>`],
]);

// ---- tests
let t = fs.readFileSync(P('app/test/app.test.js'), 'utf8');
const lines = t.split('\n');
const idx = lines.findIndex((l) => l === "  console.log('\\n8. dashboard');");
if (idx < 0) throw new Error('marker line');
lines.splice(idx, 0, ...`  console.log('\\n7k. guests change their own reservation');
  await pool.query("update reservation_settings set max_guests_per_slot=0, max_guests_per_booking=0, change_cutoff_hours=3, open_24_7=true, reminder_hours=6 where id=1");
  const CH = '2348012345501'; await inbound(CH, 'ch1'); const chTok = await tokenOf(CH);
  const chBook = await call('POST', \`/api/reserve/\${chTok}\`, form({ date: day(40), time: '19:00', guests: 2, name: 'Chidi Change' }));
  const chRef = chBook.json.ref; await pool.query("update reservations set status='confirmed', paid_amount_kobo=2050000, paystack_ref='PS-CH' where ref=$1", [chRef]);
  ok(/Need to change or cancel\\? Manage your reservation here: https:\\/\\/app\\.test\\/m\\/[a-f0-9]{12}/.test(sent.filter((x) => x.to === CH).at(-1).text || ''), 'the confirmation message says how to change or cancel, with a short link');
  const mCode = sent.filter((x) => x.to === CH).at(-1).text.match(/\\/m\\/([a-f0-9]{12})/)[1];
  const mRes = await fetch(\`\${base}/m/\${mCode}\`, { redirect: 'manual' });
  ok(mRes.status === 302 && mRes.headers.get('location') === \`/my/\${chTok}\`, 'the short manage link opens their reservation page');
  const myPage = (await call('GET', \`/my/\${chTok}\`)).text;
  ok(/data-change="/.test(myPage) && myPage.includes('Change your reservation') && myPage.includes('id="csave"'), 'the reservation page has a Change button and form');
  const hc = sent.length;
  const chOk = await call('POST', \`/api/my/\${chTok}/change\`, { ref: chRef, date: day(41), time: '21:30', guests: 5 }); await settle();
  const after = (await pool.query('select * from reservations where ref=$1', [chRef])).rows[0];
  ok(chOk.json.ok && after.guests === 5 && after.paid_amount_kobo === 2050000 && after.status === 'confirmed' && new Date(after.starts_at).getTime() > Date.now() + 40.5 * 86400000, 'date, time and guests updated, payment and status kept');
  ok(sent.slice(hc).some((x) => x.to === HANDOVER && /changed by the guest/.test(x.text) && /Was: /.test(x.text) && /Now: /.test(x.text) && /Chidi Change/.test(x.text)), 'the venue is told what changed (was / now)');
  ok(sent.slice(hc).some((x) => x.to === CH && /updated/.test(x.text)), 'the guest gets a WhatsApp confirmation');
  ok((await call('POST', \`/api/my/\${chTok}/change\`, { ref: chRef, date: day(41), time: '21:30', guests: 5 })).json.errors._ === 'Nothing has changed yet.', 'saving with no changes is refused');
  ok((await call('POST', \`/api/my/\${chTok}/change\`, { ref: chRef, date: '2020-01-01', time: '21:30', guests: 5 })).json.errors.date, 'a past date is refused');
  ok((await call('POST', \`/api/my/\${chTok}/change\`, { ref: chRef, guests: 0 })).json.errors.guests, 'bad guest count refused');
  ok((await call('POST', \`/api/my/\${tok}/change\`, { ref: chRef, guests: 9 })).status === 422 && (await pool.query('select guests from reservations where ref=$1', [chRef])).rows[0].guests === 5, "another guest's link cannot change this reservation");
  await pool.query("update reservations set reminder_sent_at = now() where ref=$1", [chRef]);
  await call('POST', \`/api/my/\${chTok}/change\`, { ref: chRef, guests: 6 });
  ok((await pool.query('select reminder_sent_at from reservations where ref=$1', [chRef])).rows[0].reminder_sent_at === null, 'a changed booking gets its reminder scheduled again');
  await pool.query("update reservations set starts_at = now() + interval '2 hours' where ref=$1", [chRef]);
  ok(/Changes close 3 hours/.test((await call('POST', \`/api/my/\${chTok}/change\`, { ref: chRef, guests: 7 })).json.errors._), 'inside the cut-off the guest is asked to contact the venue');
  await pool.query("update reservation_settings set change_cutoff_hours=0 where id=1");
  ok((await call('POST', \`/api/my/\${chTok}/change\`, { ref: chRef, guests: 7 })).json.ok, 'cut-off 0 means changes are allowed any time before it starts');
  await pool.query("update reservation_settings set change_cutoff_hours=3, max_guests_per_slot=10 where id=1");
  const CH2 = '2348012345502'; await inbound(CH2, 'ch2'); const ch2Tok = await tokenOf(CH2);
  await call('POST', \`/api/reserve/\${ch2Tok}\`, form({ date: day(45), time: '18:00', guests: 8, name: 'Slot Holder' }));
  const ch3 = '2348012345503'; await inbound(ch3, 'ch3'); const ch3Tok = await tokenOf(ch3);
  const mv = await call('POST', \`/api/reserve/\${ch3Tok}\`, form({ date: day(46), time: '18:00', guests: 4, name: 'Mover' }));
  await pool.query("update reservations set status='confirmed' where ref=$1", [mv.json.ref]);
  const full = await call('POST', \`/api/my/\${ch3Tok}/change\`, { ref: mv.json.ref, date: day(45) });
  ok(!full.json.ok && /fully booked/.test(full.json.errors.time), 'with a slot cap, a change into a full time is refused');
  await pool.query("update reservation_settings set max_guests_per_slot=0, open_24_7=false where id=1");
`.split('\n'));
fs.writeFileSync(P('app/test/app.test.js'), lines.join('\n'));
console.log('patched');

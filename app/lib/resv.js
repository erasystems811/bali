// Reservation rules: validation, capacity, holds, payment, handover, cancel/refund.
const { loadSettings, makeTime, naira, guestWord, normalizePhone, randHex } = require('./core');

function createResv(ctx, wa, ps) {
  const { pool, env } = ctx;
  const nowFn = () => (ctx.now ? ctx.now() : Date.now());
  const base = () => (env.APP_BASE_URL || '').replace(/\/$/, '');

  // capacity is optional: 0 (the default) means no limit
  const over = (S, n) => S.max_guests_per_slot > 0 && n > S.max_guests_per_slot;

  const describe = (r, T) => {
    const p = T.utcToLocalParts(r.starts_at);
    return `${T.fmtDateFull(p.date)} at ${T.fmtTime(p.time)} for ${guestWord(r.guests)}`;
  };

  // ---------- validation ----------
  function validate(S, T, f) {
    const errors = {};
    const name = String(f.name || '').trim();
    if (name.length < 2 || name.length > 60) errors.name = 'Please enter your full name.';
    const phone = normalizePhone(f.phone);
    if (!phone) errors.phone = 'Please enter a valid phone number.';
    const date = String(f.date || '');
    const today = T.todayStr();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) errors.date = 'Please choose a date.';
    else if (date < today) errors.date = 'That date has already passed.';
    else if (date > T.addDaysISO(today, S.max_days_ahead)) errors.date = `We take bookings up to ${S.max_days_ahead} days ahead.`;
    else if ((S.closed_weekdays || []).includes(T.dowOf(date))) errors.date = `We are closed on that day. Please pick another.`;
    const time = String(f.time || '');
    if (!/^\d{2}:\d{2}$/.test(time)) errors.time = 'Please type your arrival time with AM or PM, like 7:30 PM, or in 24 hour time, like 19:30.';
    else {
      const m = T.toMin(time);
      if (m < T.toMin(S.open_time) || m > T.lastSeatingMin()) errors.time = `Arrival time must be between ${T.fmtTime(S.open_time)} and ${T.fmtTime(T.fromMin(T.lastSeatingMin()))}.`;
      else if (!errors.date && new Date(T.localToUtcISO(date, time)).getTime() < nowFn() + S.min_notice_minutes * 60000) errors.time = 'That time is too soon. Please choose a later time.';
    }
    const guests = Number(f.guests);
    if (!Number.isInteger(guests) || guests < 1) errors.guests = 'Please enter the number of guests.';
    else if (S.max_guests_per_booking > 0 && guests > S.max_guests_per_booking) errors.guests = `For more than ${S.max_guests_per_booking} guests please contact the venue directly.`;
    else if (guests > 2000) errors.guests = 'Please enter a realistic number of guests.';
    return { errors, clean: { name, phone, date, time, guests } };
  }

  // ---------- capacity ----------
  const slotStartMin = (S, T, hhmm) => T.toMin(S.open_time) + Math.floor((T.toMin(hhmm) - T.toMin(S.open_time)) / S.slot_minutes) * S.slot_minutes;
  async function guestsBooked(S, T, date, hhmm, excludeRef, client) {
    const s = slotStartMin(S, T, hhmm);
    const from = T.localToUtcISO(date, T.fromMin(s));
    const to = T.localToUtcISO(date, T.fromMin(s + S.slot_minutes));
    const q = (client || pool).query.bind(client || pool);
    const { rows } = await q(
      `select coalesce(sum(guests),0)::int as n from reservations
        where starts_at >= $1 and starts_at < $2 and ($3::text is null or ref <> $3)
          and (status = 'confirmed' or (status = 'pending_payment' and hold_expires_at > now()))`,
      [from, to, excludeRef || null]);
    return rows[0].n;
  }
  async function freeTimes(date, guests) {
    const S = await loadSettings(ctx); const T = makeTime(S, nowFn);
    const out = [];
    const isToday = date === T.todayStr();
    const nowMin = T.nowLocal().getUTCHours() * 60 + T.nowLocal().getUTCMinutes() + S.min_notice_minutes;
    for (let m = T.toMin(S.open_time); m <= T.lastSeatingMin(); m += S.slot_minutes) {
      if (isToday && m < nowMin) continue;
      if (!over(S, (await guestsBooked(S, T, date, T.fromMin(m))) + (guests || 1))) out.push(T.fromMin(m));
    }
    return out;
  }

  // ---------- create ----------
  // R-001, R-002, ... (a database sequence, so two bookings at the same moment can never share a number)
  async function newRef(client) {
    for (let i = 0; i < 8; i++) {
      const n = (await client.query("select nextval('reservation_ref_seq') as n")).rows[0].n;
      const ref = `R-${String(n).padStart(3, '0')}`;
      const { rows } = await client.query('select 1 from reservations where ref=$1', [ref]);
      if (!rows[0]) return ref;
    }
    throw new Error('could not allocate a reservation ref');
  }

  // form: {name, phone, date, time, guests}; sessionPhone = the guest's WhatsApp number (from the form link token)
  async function createFromForm(form, sessionPhone, opts = {}) {
    const S = await loadSettings(ctx); const T = makeTime(S, nowFn);
    const { errors, clean } = validate(S, T, form);
    if (Object.keys(errors).length) return { ok: false, errors };
    const needPay = S.payments_enabled;
    if (needPay && !ps.configured) return { ok: false, errors: { _: 'Online payment is not available right now. Please try again later or contact the venue.' }, code: 'payments_unavailable' };

    const client = await pool.connect();
    let r;
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`bali-slot-${clean.date}`]);
      if (over(S, (await guestsBooked(S, T, clean.date, clean.time, null, client)) + clean.guests)) {
        await client.query('rollback');
        const alts = await freeTimes(clean.date, clean.guests);
        return { ok: false, errors: { time: alts.length ? `That time is fully booked. Free times: ${alts.slice(0, 6).map(T.fmtTime).join(', ')}.` : 'That day is fully booked. Please choose another day.' }, alternatives: alts };
      }
      await client.query("update reservations set status='expired', updated_at=now() where phone_number=$1 and status='pending_payment'", [sessionPhone]);
      const ref = await newRef(client);
      const holdAt = needPay ? new Date(nowFn() + S.hold_minutes * 60000).toISOString() : null;
      const ins = await client.query(
        `insert into reservations (ref, phone_number, contact_phone, guest_name, guests, starts_at, status, hold_expires_at, source)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [ref, sessionPhone, clean.phone, clean.name, clean.guests, T.localToUtcISO(clean.date, clean.time), needPay ? 'pending_payment' : 'confirmed', holdAt, opts.source || 'form']);
      r = ins.rows[0];
      await client.query('commit');
    } catch (e) { try { await client.query('rollback'); } catch (_) {} throw e; } finally { client.release(); }

    if (!needPay) { await complete(r, S, T, { paid: false }); return { ok: true, ref: r.ref, status: 'confirmed' }; }

    const total = S.reservation_fee_kobo + S.service_fee_kobo;
    const token = await sessionToken(sessionPhone);
    const reference = `BALI-${r.ref}-${Date.now().toString(36)}`;
    let url;
    try {
      url = await ps.init({ reference, amountKobo: total, phone: sessionPhone, callbackUrl: `${base()}/reserve/${token}/done?ref=${r.ref}`, metadata: { reservation_ref: r.ref, phone: sessionPhone } });
    } catch (e) {
      await pool.query("update reservations set status='expired' where ref=$1", [r.ref]);
      await notifyHandover(S, `Could not start a Paystack payment for ${r.ref}. Please check the Paystack key.`, 'a payment problem');
      return { ok: false, errors: { _: 'Payment could not be started. The venue has been told. Please try again shortly.' }, code: 'paystack_failed' };
    }
    await pool.query('update reservations set paystack_ref=$1, paystack_url=$2 where ref=$3', [reference, url, r.ref]);
    return { ok: true, ref: r.ref, status: 'pending_payment', payUrl: url, amountKobo: total };
  }

  async function sessionToken(phone) {
    const { rows } = await pool.query('select token from web_sessions where phone_number=$1', [phone]);
    if (rows[0]) return rows[0].token;
    const token = randHex(16);
    await pool.query('insert into web_sessions (token, phone_number, short_code) values ($1,$2,$3) on conflict (phone_number) do nothing', [token, phone, randHex(6)]);
    return (await pool.query('select token from web_sessions where phone_number=$1', [phone])).rows[0].token;
  }

  // ---------- completion + handover ----------
  // every configured handover number (up to two) gets the message; true if at least one was sent
  function handoverNumbers(S) {
    return [...new Set([S.handover_number, S.handover_number_2].map((n) => normalizePhone(n)).filter(Boolean))];
  }
  async function notifyHandover(S, text, label) {
    let any = false;
    for (const to of handoverNumbers(S)) {
      try { await wa.send(to, text, label || 'a new reservation'); any = true; } catch (e) { /* the other number may still work */ }
    }
    return any;
  }
  function handoverText(r, S, T) {
    const p = T.utcToLocalParts(r.starts_at);
    return [
      `New table reservation ${r.ref} ✅`,
      `Name: ${r.guest_name}`,
      `Phone: ${r.contact_phone || r.phone_number}`,
      `Date: ${T.fmtDateFull(p.date)}`,
      `Arrival: ${T.fmtTime(p.time)}`,
      `Guests: ${r.guests}`,
      r.paid_amount_kobo ? `Paid: ${naira(r.paid_amount_kobo)}` : 'Payment: none taken',
    ].join('\n');
  }
  async function complete(r, S, T, { paid }) {
    const ok = await notifyHandover(S, handoverText(r, S, T), 'a new reservation');
    await pool.query('update reservations set handed_over_at = case when $2 then now() else handed_over_at end, updated_at = now() where ref=$1', [r.ref, ok]);
    // A booking made inside the WhatsApp form: wait until the guest taps Done (their "response sent" bubble then shows FIRST, and our
    // confirmation arrives after it). A 2 minute safety timer sends it anyway if they never tap Done.
    if (r.source === 'flow') {
      await pool.query("update reservations set confirm_msg_status = 'pending', confirm_due_at = now() + interval '2 minutes' where ref = $1", [r.ref]);
      return;
    }
    await sendGuestConfirmation(r, S, T);
  }

  async function sendGuestConfirmation(r, S, T) {
    const paid = !!r.paid_amount_kobo;
    const link = S.order_link ? `${S.order_link}${S.order_link.includes('?') ? '&' : '?'}ref=${r.ref}` : '';
    const credit = paid ? ` Your ${naira(S.reservation_fee_kobo)} is credited to your order on the day.` : '';
    const short = await sessionShort(r.phone_number);
    const manageUrl = `${base()}/m/${short}`;
    const body = `Your table at ${S.venue_name} is confirmed ✅\n\nRef: ${r.ref}\nName: ${r.guest_name}\n${describe(r, T)}.${credit}${link ? `\n\nIf you would like to place an order ahead for that day, you can do that through this link: ${link}` : ''}\n\nTo change or cancel your reservation, you can manage it using the button below.`;
    // One message with a real tap button (TAP TO MANAGE). Outside the 24h window only plain text is possible, so the link goes in the text.
    try {
      if (await wa.withinWindow(r.phone_number, false)) await wa.sendCta(r.phone_number, { body, button: 'TAP TO MANAGE', url: manageUrl });
      else await wa.send(r.phone_number, `${body}\n\nNeed to change or cancel? Manage your reservation here: ${manageUrl}`, 'your reservation');
    } catch (e) {}
  }

  // the guest finished the form (nfm_reply) or the safety timer fired: send the held confirmation, once
  async function sendPendingConfirmation(ref, phone) {
    const claim = await pool.query("update reservations set confirm_msg_status = 'sent' where ref = $1 and ($2::text is null or phone_number = $2) and confirm_msg_status = 'pending' returning *", [ref, phone || null]);
    if (!claim.rows[0]) return false;
    const S = await loadSettings(ctx); const T = makeTime(S, nowFn);
    await sendGuestConfirmation(claim.rows[0], S, T);
    return true;
  }
  async function sendDueConfirmations() {
    const { rows } = await pool.query("select ref from reservations where confirm_msg_status = 'pending' and confirm_due_at <= now() order by confirm_due_at limit 50");
    let n = 0;
    for (const x of rows) { try { if (await sendPendingConfirmation(x.ref, null)) n += 1; } catch (e) { console.error('confirmation failed', x.ref, e.message); } }
    return n;
  }

  async function confirmPayment(refOrRow) {
    const S = await loadSettings(ctx); const T = makeTime(S, nowFn);
    const r = typeof refOrRow === 'string' ? (await pool.query('select * from reservations where ref=$1', [refOrRow])).rows[0] : refOrRow;
    if (!r) return { status: 'unknown' };
    if (r.status === 'confirmed') return { status: 'confirmed', ref: r.ref };
    if (!r.paystack_ref) return { status: 'pending' };
    const v = await ps.verify(r.paystack_ref);
    if (!v || v.status !== 'success') return { status: 'pending', ref: r.ref };
    const need = S.reservation_fee_kobo + S.service_fee_kobo;
    if (v.amount < need) { await notifyHandover(S, `Payment problem on ${r.ref}: Paystack shows ${naira(v.amount)}, expected ${naira(need)}. Guest ${r.phone_number}.`, 'a payment problem'); return { status: 'short' }; }
    const holdLost = r.status !== 'pending_payment' || (r.hold_expires_at && new Date(r.hold_expires_at).getTime() < nowFn());
    if (holdLost) {
      const p = T.utcToLocalParts(r.starts_at);
      const taken = await guestsBooked(S, T, p.date, p.time, r.ref);
      if (over(S, taken + r.guests)) {
        await pool.query("update reservations set status='expired', paid_amount_kobo=$2, paid_at=now() where ref=$1", [r.ref, v.amount]);
        const ok = await ps.refund(r.paystack_ref, v.amount);
        await pool.query('update reservations set refund_amount_kobo=$2, refund_status=$3 where ref=$1', [r.ref, ok ? v.amount : null, ok ? 'refunded' : 'failed']);
        try { await wa.send(r.phone_number, `Sorry, your payment came in after your table hold ended and that time is now full. ${ok ? 'We have refunded the full ' + naira(v.amount) + '.' : 'The team will refund you shortly.'} Please make a new reservation.`, 'your reservation'); } catch (e) {}
        if (!ok) await notifyHandover(S, `Late payment on ${r.ref}, no room left, automatic refund FAILED. Please refund ${naira(v.amount)} to ${r.phone_number} in Paystack.`, 'a refund needed');
        return { status: 'late_refunded' };
      }
    }
    const upd = await pool.query(
      "update reservations set status='confirmed', paid_amount_kobo=$2, paid_at=now(), hold_expires_at=null, updated_at=now() where ref=$1 and status <> 'confirmed' returning *",
      [r.ref, v.amount]);
    if (!upd.rows[0]) return { status: 'confirmed', ref: r.ref }; // someone else (webhook vs page return) already completed it
    await complete(upd.rows[0], S, T, { paid: true });
    return { status: 'confirmed', ref: r.ref };
  }

  // ---------- cancel / refund ----------
  // refundMode: 'auto' (guest rule: reservation fee back if >= refund_hours before), 'full' (everything paid), 'none'
  async function cancel(ref, by, refundMode) {
    const S = await loadSettings(ctx); const T = makeTime(S, nowFn);
    const { rows } = await pool.query('select * from reservations where ref=$1', [ref]);
    const r = rows[0];
    if (!r) return { ok: false, error: 'not found' };
    if (!['confirmed', 'pending_payment'].includes(r.status)) return { ok: false, error: `already ${r.status}` };
    const hrs = (new Date(r.starts_at).getTime() - nowFn()) / 3600000;
    let refund = 0;
    if (r.paid_amount_kobo) {
      if (refundMode === 'full') refund = r.paid_amount_kobo;
      else if (refundMode === 'auto' && hrs >= S.refund_hours) refund = Math.min(S.reservation_fee_kobo, r.paid_amount_kobo);
    }
    await pool.query("update reservations set status='cancelled', cancelled_by=$2, updated_at=now() where ref=$1", [ref, by]);
    let refunded = false;
    if (refund) {
      refunded = await ps.refund(r.paystack_ref, refund);
      await pool.query('update reservations set refund_amount_kobo=$2, refund_status=$3 where ref=$1', [ref, refunded ? refund : null, refunded ? 'refunded' : 'failed']);
      if (!refunded) await notifyHandover(S, `Automatic refund FAILED for ${ref}. Please refund ${naira(refund)} to ${r.phone_number} in Paystack.`, 'a refund needed');
    }
    const tail = refund
      ? (refunded ? ` We have refunded ${naira(refund)}; it can take a few days to show.${refund < r.paid_amount_kobo ? ' The service fee is not refundable.' : ''}` : ' The team will process your refund shortly.')
      : (r.paid_amount_kobo ? ` As it is less than ${S.refund_hours} hours to your booking, the payment is not refunded.` : '');
    // The guest always gets a message about a cancellation (their own, or one made by the venue).
    { const who = by === 'staff' ? `Sorry, we had to cancel your reservation ${r.ref} for ${describe(r, T)}.` : `Your reservation ${r.ref} for ${describe(r, T)} is cancelled.`;
      try { await wa.send(r.phone_number, `${who}${tail}`, 'your reservation'); } catch (e) {} }
    if (by === 'guest' && S.notify_changes) await notifyHandover(S, `Reservation cancelled by guest: ${r.ref} ${r.guest_name} ${describe(r, T)}${refund ? ' (refunded ' + naira(refund) + ')' : ''}`, 'a cancelled reservation');
    return { ok: true, refund, refunded };
  }

  async function sendWithManage(phone, body) {
    const manageUrl = `${base()}/m/${await sessionShort(phone)}`;
    if (await wa.withinWindow(phone, false)) return wa.sendCta(phone, { body, button: 'TAP TO MANAGE', url: manageUrl });
    return wa.send(phone, `${body}\n\nNeed to change or cancel? Manage your reservation here: ${manageUrl}`, 'your reservation');
  }

  // A guest changes their own reservation (date, time, guests). Their payment stays with the booking.
  async function change(ref, sessionPhone, input) {
    const S = await loadSettings(ctx); const T = makeTime(S, nowFn);
    const { rows } = await pool.query('select * from reservations where ref=$1 and phone_number=$2', [String(ref || ''), sessionPhone]);
    const r = rows[0];
    if (!r) return { ok: false, errors: { _: 'We could not find that reservation.' } };
    if (r.status !== 'confirmed') return { ok: false, errors: { _: r.status === 'pending_payment' ? 'Please finish your payment first, or cancel and start again.' : 'This reservation can no longer be changed.' } };
    const hrs = (new Date(r.starts_at).getTime() - nowFn()) / 3600000;
    if (S.change_cutoff_hours > 0 && hrs < S.change_cutoff_hours) return { ok: false, errors: { _: `Changes close ${S.change_cutoff_hours} hours before your arrival. Please contact the venue.` } };
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
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`bali-slot-${clean.date}`]);
      if (over(S, (await guestsBooked(S, T, clean.date, clean.time, r.ref, client)) + clean.guests)) {
        await client.query('rollback');
        return { ok: false, errors: { time: 'That time is fully booked. Please choose another.' } };
      }
      upd = (await client.query(
        'update reservations set starts_at=$2, guests=$3, reminder_sent_at=null, reminder_tries=0, updated_at=now() where ref=$1 returning *',
        [r.ref, T.localToUtcISO(clean.date, clean.time), clean.guests])).rows[0];
      await client.query('commit');
    } catch (e) { try { await client.query('rollback'); } catch (_) {} throw e; } finally { client.release(); }
    if (S.notify_changes) await notifyHandover(S, `Reservation ${r.ref} was changed by the guest ✏️\nName: ${r.guest_name}\nPhone: ${r.contact_phone || r.phone_number}\nWas: ${describe(r, T)}\nNow: ${describe(upd, T)}`, 'a changed reservation');
    try { await sendWithManage(r.phone_number, `Your reservation ${r.ref} is updated ✅\n\nName: ${r.guest_name}\n${describe(upd, T)}\n\nTo change or cancel it again, you can manage it using the button below.`); } catch (e) {}
    return { ok: true, ref: r.ref, text: describe(upd, T) };
  }

  async function forGuest(phone) {
    const { rows } = await pool.query(
      "select * from reservations where phone_number=$1 and status in ('confirmed','pending_payment') and starts_at >= now() - interval '1 day' order by starts_at asc", [phone]);
    return rows.filter((r) => r.status === 'confirmed' || (r.hold_expires_at && new Date(r.hold_expires_at).getTime() > nowFn()));
  }

  // short, shareable-looking link code for the enquiry chat (/c/<code> redirects to /ask/<token>)
  async function sessionShort(phone) {
    await sessionToken(phone);
    const cur = (await pool.query('select short_code from web_sessions where phone_number=$1', [phone])).rows[0];
    if (cur && cur.short_code) return cur.short_code;
    await pool.query('update web_sessions set short_code=$2 where phone_number=$1 and short_code is null', [phone, randHex(6)]);
    return (await pool.query('select short_code from web_sessions where phone_number=$1', [phone])).rows[0].short_code;
  }

  return { sendPendingConfirmation, sendDueConfirmations, handoverNumbers, change, sessionShort, validate, createFromForm, confirmPayment, cancel, freeTimes, forGuest, sessionToken, describe, notifyHandover, guestsBooked };
}
module.exports = { createResv };

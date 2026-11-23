// Reminder before every reservation (default 6 hours): details + a CHAT WITH US button that opens the enquiry chat.
// Inside the guest's 24h window it is one rich message. Outside it WhatsApp only allows an approved template, so we use
// the "bali_reservation_reminder" template (URL button -> /ask/<token>); if that is not approved yet we fall back to the
// generic ping + queued text (released when the guest replies "okay"), which carries the chat link in the text.
const { loadSettings, makeTime } = require('./core');

function createReminders(ctx, wa, resv) {
  const { pool, env } = ctx;
  const base = () => (env.APP_BASE_URL || '').replace(/\/$/, '');
  const TEMPLATE = env.REMINDER_TEMPLATE || 'bali_reservation_reminder';

  async function sendOne(r, S, T) {
    const token = await resv.sessionToken(r.phone_number);
    const url = `${base()}/ask/${token}`;
    const first = String(r.guest_name || 'there').split(' ')[0];
    // "by 7:30 PM today" / "by 7:30 PM tomorrow" / "by 7:30 PM on Friday 5 Dec"
    const p = T.utcToLocalParts(r.starts_at);
    const [hh, mm] = p.time.split(':').map(Number);
    const clock = `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'}`;
    const when = `${clock} ${p.date === T.todayStr() ? 'today' : p.date === T.addDaysISO(T.todayStr(), 1) ? 'tomorrow' : 'on ' + T.fmtDateFull(p.date)}`;
    const details = `Table for ${r.guests === 1 ? '1 guest' : r.guests + ' guests'}, Ref ${r.ref}`;
    const body = `Hey ${first}, just a reminder that by ${when} you'll be spending time with us at ${S.venue_name}. We are excited and we can't wait to see you!\n\n${details}\n\nFor further enquiries, you can tap the button below to chat with us.`;
    if (await wa.withinWindow(r.phone_number, false)) {
      await wa.sendCta(r.phone_number, { body, button: 'CHAT WITH US', url });
      return 'cta';
    }
    try {
      await wa.sendTemplateMessage(r.phone_number, TEMPLATE, 'en_US', [
        { type: 'body', parameters: [{ type: 'text', text: first }, { type: 'text', text: when }, { type: 'text', text: details }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: token }] },
      ], body);
      return 'template';
    } catch (e) {
      await wa.send(r.phone_number, body.replace('you can tap the button below to chat with us.', `you can chat with us here: ${url}`), 'a reservation reminder');
      return 'fallback';
    }
  }

  async function tick() {
    const S = await loadSettings(ctx);
    if (!S.reminder_hours || S.reminder_hours < 1) return 0;
    const T = makeTime(S);
    // due: inside the reminder window, not started yet, and booked EARLIER than the reminder moment (a booking made with less
    // notice than that has nothing to remind about)
    const { rows } = await pool.query(
      `select * from reservations
        where status = 'confirmed' and reminder_sent_at is null and reminder_tries < 3
          and starts_at > now() and starts_at - ($1 || ' hours')::interval <= now()
          and created_at < starts_at - ($1 || ' hours')::interval
        order by starts_at limit 50`, [S.reminder_hours]);
    let sent = 0;
    for (const r of rows) {
      const claim = await pool.query('update reservations set reminder_sent_at = now(), reminder_tries = reminder_tries + 1 where ref = $1 and reminder_sent_at is null returning ref', [r.ref]);
      if (!claim.rows[0]) continue; // another tick got it
      try { await sendOne(r, S, T); sent += 1; } catch (e) {
        console.error('reminder failed', r.ref, e.message);
        await pool.query('update reservations set reminder_sent_at = null where ref = $1', [r.ref]); // retry next minute (max 3 tries)
      }
    }
    return sent;
  }
  return { tick, sendOne };
}
module.exports = { createReminders };

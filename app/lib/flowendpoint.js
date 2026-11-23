// The server side of Bali's WhatsApp form: availability, the payment screen and confirmation, all INSIDE the form.
const { loadSettings, makeTime, naira, normalizePhone } = require('./core');
const flow = require('./flow');

function createFlowEndpoint(ctx, resv) {
  const { pool, env } = ctx;
  const base = () => (env.APP_BASE_URL || '').replace(/\/$/, '');

  const formScreen = (S, over = {}) => ({ screen: 'RESERVE', data: { ...flow.flowData(S, {}), has_error: false, error: ' ', ...over } });

  // keep what the guest already typed when we send them back to fix something
  function keep(form) {
    return { name_init: String(form.name || ''), phone_init: String(form.phone || ''), date_init: String(form.date || ''), time_init: String(form.time || '19:00'), guests_init: String(form.guests || '') };
  }

  async function sessionFor(flowToken) {
    const token = String(flowToken || '').replace(/^bali-/, '');
    if (!token) return null;
    const { rows } = await pool.query('select * from web_sessions where token=$1', [token]);
    return rows[0] || null;
  }

  function payScreen(S, T, r, url, note) {
    const total = S.reservation_fee_kobo + S.service_fee_kobo;
    return {
      screen: 'PAY',
      data: {
        summary: `${r.guest_name}\n${resv.describe(r, T)}\nRef ${r.ref}`,
        detail: `Pay ${naira(total)} to confirm your table. ${naira(S.reservation_fee_kobo)} of it is credited to your food and drinks order on the day.`,
        amount_label: `Pay ${naira(total)}`,
        pay_url: url, ref: r.ref,
        has_note: !!note, note: note || ' ',
        has_fee_note: true, fee_note: `The total includes a ${naira(S.service_fee_kobo)} service charge.`,
      },
    };
  }
  function startOver(session, note) {
    return {
      screen: 'PAY',
      data: {
        summary: 'This reservation is no longer held.', detail: 'Tap the button to start a new reservation.',
        amount_label: 'Start again', pay_url: `${base()}/go/${session.token}/reserve`, ref: 'none', has_note: true, note: note || 'Your reservation is no longer held.', has_fee_note: false, fee_note: ' ',
      },
    };
  }
  function doneScreen(S, T, r) {
    return {
      screen: 'DONE',
      data: {
        summary: `${r.guest_name}\n${resv.describe(r, T)}\nRef ${r.ref}`,
        credit: `${r.paid_amount_kobo ? `Your ${naira(S.reservation_fee_kobo)} is credited to your order on the day. ` : ''}Your confirmation and the link to order ahead are in this chat.`,
        ref: r.ref,
      },
    };
  }

  async function handle(req) {
    const { action, screen, data, flow_token: flowToken } = req;
    if (action === 'ping') return { data: { status: 'active' } };
    if (data && data.error) return { data: { acknowledged: true } };      // the form reported a client side error
    const S = await loadSettings(ctx); const T = makeTime(S);
    const session = await sessionFor(flowToken);
    if (!session) return formScreen(S, { has_error: true, error: 'This form has expired. Please send us a message on WhatsApp to get a fresh one.' });
    if (action === 'INIT' || action === 'BACK') return formScreen(S, {});

    if (action !== 'data_exchange') return formScreen(S, {});
    // WhatsApp drops a payload key literally named "action", so the form sends "step"; if neither arrives (as in the real traffic
    // before this fix) the request is recognised by its content so it can never fall through to a blank form
    const step = (data && (data.step || data.action)) || (data && data.name !== undefined ? 'reserve' : data && data.ref ? 'check' : undefined);

    if (step === 'reserve') {
      // the form sends hour + minute from two pick lists; a typed `time` is still accepted (older form versions)
      // the form sends the picked time as HH:MM; hour + minute (a short-lived older version) is still understood
      const picked = data.time || (data.hour !== undefined && data.hour !== '' ? `${String(data.hour).padStart(2, '0')}:${String(data.minute || '0').padStart(2, '0')}` : '');
      const form = { name: data.name, phone: data.phone, date: flow.normalizeDate(data.date, S), time: flow.normalizeTime(picked), guests: data.guests };
      const out = await resv.createFromForm(form, session.phone_number, { source: 'flow' });
      if (!out.ok) {
        const msg = Object.values(out.errors || {})[0] || 'Something went wrong with that booking.';
        return formScreen(S, { ...keep(form), has_error: true, error: msg });
      }
      const { rows } = await pool.query('select * from reservations where ref=$1', [out.ref]);
      const r = rows[0];
      if (out.status === 'pending_payment') return payScreen(S, T, r, out.payUrl);
      return doneScreen(S, T, r);
    }

    if (step === 'check') {
      const { rows } = await pool.query('select * from reservations where ref=$1 and phone_number=$2', [String(data.ref || ''), session.phone_number]);
      let r = rows[0];
      if (!r) return startOver(session, 'I could not find that reservation.');
      if (r.status === 'pending_payment') { await resv.confirmPayment(r); r = (await pool.query('select * from reservations where ref=$1', [r.ref])).rows[0]; }
      if (r.status === 'confirmed') return doneScreen(S, T, r);
      if (r.status === 'pending_payment') return payScreen(S, T, r, r.paystack_url, 'We have not received your payment yet. Finish paying, then tap the button again.');
      return startOver(session, 'That reservation is no longer held.');
    }
    return formScreen(S, {});
  }

  return { handle };
}
module.exports = { createFlowEndpoint };

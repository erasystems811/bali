// The server side of Bali's WhatsApp form: availability, the payment screen and confirmation, all INSIDE the form.
//
// How the form is allowed to answer (learned the hard way):
//  - Moving FORWARD to another screen is always fine (RESERVE -> PAY -> WAIT -> DONE).
//  - To REFUSE a step and keep the guest where they are (bad time, not paid yet ...) the answer is { screen: <current>, data: { error_message } }.
//    WhatsApp then shows the message and leaves the screen exactly as it is, so nothing the guest typed is cleared. Answering with the same
//    screen and fresh data instead leaves the form spinning forever.
const { loadSettings, makeTime, naira } = require('./core');
const flow = require('./flow');

function createFlowEndpoint(ctx, resv) {
  const { pool } = ctx;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const formScreen = (S, over = {}) => ({ screen: 'RESERVE', data: { ...flow.flowData(S, {}), has_error: false, error: ' ', ...over } });
  // stay on the current screen and show a message
  const stay = (screen, message) => ({ screen: screen || 'RESERVE', data: { error_message: message } });

  async function sessionFor(flowToken) {
    const token = String(flowToken || '').replace(/^bali-/, '');
    if (!token) return null;
    const { rows } = await pool.query('select * from web_sessions where token=$1', [token]);
    return rows[0] || null;
  }

  function payScreen(S, T, r, url) {
    const total = S.reservation_fee_kobo + S.service_fee_kobo;
    return {
      screen: 'PAY',
      data: {
        summary: `${r.guest_name}\n${resv.describe(r, T)}\nRef ${r.ref}`,
        detail: `Pay ${naira(total)} to confirm your table. ${naira(S.reservation_fee_kobo)} of it is credited to your food and drinks order on the day.`,
        amount_label: `Pay ${naira(total)}`,
        pay_url: url, ref: r.ref,
        has_note: false, note: ' ',
        has_fee_note: true, fee_note: `The total includes a ${naira(S.service_fee_kobo)} service charge.`,
      },
    };
  }
  // "confirming your payment": shown when the guest taps I have paid and the payment is not confirmed yet
  function waitScreen(r, message, showPayLink) {
    return { screen: 'WAIT', data: { message, has_pay_link: !!showPayLink, pay_url: r.paystack_url || 'https://wa.me', ref: r.ref } };
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

  async function freshReservation(ref, phone) {
    const { rows } = await pool.query('select * from reservations where ref=$1 and phone_number=$2', [String(ref || ''), phone]);
    return rows[0] || null;
  }

  async function handle(req) {
    const { action, screen, data, flow_token: flowToken } = req;
    if (action === 'ping') return { data: { status: 'active' } };
    if (data && data.error) return { data: { acknowledged: true } };      // the form reported a client side error
    const S = await loadSettings(ctx); const T = makeTime(S);
    const session = await sessionFor(flowToken);
    if (!session) {
      if (action === 'data_exchange') return stay(screen, 'This form has expired. Please send us a message on WhatsApp to get a fresh one.');
      return formScreen(S, { has_error: true, error: 'This form has expired. Please send us a message on WhatsApp to get a fresh one.' });
    }
    if (action === 'INIT' || action === 'BACK') return formScreen(S, {});

    if (action !== 'data_exchange') return formScreen(S, {});
    // WhatsApp drops a payload key literally named "action", so the form sends "step"; if neither arrives the request is recognised by
    // its content so it can never fall through to a blank form
    const step = (data && (data.step || data.action)) || (data && data.name !== undefined ? 'reserve' : data && data.ref ? 'check' : undefined);

    if (step === 'reserve') {
      // the form sends the picked time as HH:MM; hour + minute (a short-lived older version) is still understood
      const picked = data.time || (data.hour !== undefined && data.hour !== '' ? `${String(data.hour).padStart(2, '0')}:${String(data.minute || '0').padStart(2, '0')}` : '');
      const form = { name: data.name, phone: data.phone, date: flow.normalizeDate(data.date, S), time: flow.normalizeTime(picked), guests: data.guests };
      const out = await resv.createFromForm(form, session.phone_number, { source: 'flow' });
      if (!out.ok) return stay('RESERVE', Object.values(out.errors || {})[0] || 'Something went wrong with that booking.'); // the form keeps what they typed
      const r = await freshReservation(out.ref, session.phone_number);
      if (out.status === 'pending_payment') return payScreen(S, T, r, out.payUrl);
      return doneScreen(S, T, r);
    }

    if (step === 'check') {
      let r = await freshReservation(data.ref, session.phone_number);
      if (!r) return stay(screen || 'PAY', 'We could not find that reservation. Please close the form and start again.');
      if (r.status === 'pending_payment') {
        await resv.confirmPayment(r); // (in webhook-only mode this just reports "pending")
        // Give the payment webhook a few seconds to arrive. WhatsApp shows its own loading spinner while we wait, then the guest moves on
        // without having to tap again. Kept well inside WhatsApp's ~10 second limit.
        const pollMs = ctx.flowPollMs !== undefined ? ctx.flowPollMs : Math.max(0, (ctx.flowTimeoutMs || 8000) - 2500);
        const every = ctx.flowPollEveryMs || 600;
        const started = Date.now();
        for (;;) {
          r = (await freshReservation(r.ref, session.phone_number)) || r;
          if (r.status !== 'pending_payment' || Date.now() - started >= pollMs) break;
          await sleep(every);
        }
      }
      if (r.status === 'confirmed') return doneScreen(S, T, r);
      if (r.status !== 'pending_payment') return stay(screen || 'PAY', 'That reservation is no longer held. Please close the form and start again.');
      const paid = await resv.providerPaid(r);
      if (screen === 'WAIT') return stay('WAIT', paid ? 'Still confirming your payment. Please tap Check again in a few seconds.' : 'We have not received your payment yet. Open the payment page below, pay, then tap Check again.');
      return waitScreen(r, paid
        ? 'We have received your payment and are confirming your table. This only takes a moment. Tap Check again.'
        : 'We have not received your payment yet. If you have not paid, open the payment page below. Once you have paid, tap Check again.', !paid);
    }
    return formScreen(S, {});
  }

  return { handle };
}
module.exports = { createFlowEndpoint };

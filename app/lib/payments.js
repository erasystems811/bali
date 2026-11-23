// One payments interface for the rest of the app. Monnify is used when its credentials are set (this is Bali's provider);
// Paystack is the fallback. PAYMENT_PROVIDER=paystack|monnify forces one. Chosen at call time, so switching only needs new env values.
const { createPaystack } = require('./paystack');
const { createMonnify } = require('./monnify');

function createPayments(ctx) {
  const paystack = createPaystack(ctx);
  const monnify = createMonnify(ctx);
  function pick() {
    const want = String(ctx.env.PAYMENT_PROVIDER || '').toLowerCase();
    if (want === 'paystack' && paystack.configured) return paystack;
    if (want === 'monnify' && monnify.configured) return monnify;
    if (monnify.configured) return monnify;
    if (paystack.configured) return paystack;
    return monnify; // nothing configured: reported as not configured
  }
  return {
    get name() { return pick().name; },
    get configured() { return pick().configured; },
    init: (a) => pick().init(a),
    verify: (r) => pick().verify(r),
    refund: (r, amt) => pick().refund(r, amt),
  };
}
module.exports = { createPayments };

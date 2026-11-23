// Monnify checkout (https://developers.monnify.com). Amounts to Monnify are in NAIRA (we keep kobo internally).
// Flow: login (Basic apiKey:secretKey) -> init-transaction (returns a hosted checkout URL) -> the guest pays there and is sent back to
// redirectUrl -> we verify by OUR payment reference (never trusting a redirect or webhook alone) -> refunds via initiate-refund.
function createMonnify(ctx) {
  const env = () => ctx.env;
  const base = () => (env().MONNIFY_BASE_URL || 'https://api.monnify.com').replace(/\/$/, '');
  let cache = { token: null, exp: 0 };

  async function token() {
    if (cache.token && Date.now() < cache.exp) return cache.token;
    const basic = Buffer.from(`${env().MONNIFY_API_KEY}:${env().MONNIFY_SECRET_KEY}`).toString('base64');
    const res = await ctx.http('POST', `${base()}/api/v1/auth/login`, { headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' }, body: {}, timeoutMs: 7000 });
    const t = res && res.responseBody && res.responseBody.accessToken;
    if (!t) throw new Error('Monnify login failed');
    cache = { token: t, exp: Date.now() + Math.max(60, Number(res.responseBody.expiresIn || 300) - 60) * 1000 };
    return t;
  }
  async function call(method, path, body) {
    return ctx.http(method, `${base()}${path}`, { headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body, timeoutMs: 7000 });
  }

  const api = {
    name: 'Monnify',
    get configured() { return !!(env().MONNIFY_API_KEY && env().MONNIFY_SECRET_KEY && env().MONNIFY_CONTRACT_CODE); },
    async init({ reference, amountKobo, phone, callbackUrl, metadata, customerName }) {
      const res = await call('POST', '/api/v1/merchant/transactions/init-transaction', {
        amount: amountKobo / 100,
        customerName: customerName || 'Bali guest',
        customerEmail: `${phone}@guest.erasystems.com.ng`,
        paymentReference: reference,
        paymentDescription: `Bali table reservation ${(metadata && metadata.reservation_ref) || ''}`.trim(),
        currencyCode: 'NGN',
        contractCode: env().MONNIFY_CONTRACT_CODE,
        redirectUrl: callbackUrl,
        paymentMethods: ['CARD', 'ACCOUNT_TRANSFER'],
      });
      const url = res && res.responseBody && res.responseBody.checkoutUrl;
      if (!url) throw new Error('Monnify did not return a checkout link');
      return url;
    },
    // normalised: { status: 'success' | 'pending' | ..., amount: kobo, transactionReference }
    async verify(reference) {
      try {
        const res = await call('GET', `/api/v2/merchant/transactions/query?paymentReference=${encodeURIComponent(reference)}`);
        const b = (res && res.responseBody) || {};
        return { status: b.paymentStatus === 'PAID' ? 'success' : String(b.paymentStatus || 'pending').toLowerCase(), amount: Math.round(Number(b.amountPaid || 0) * 100), transactionReference: b.transactionReference };
      } catch (e) { return null; }
    },
    async refund(reference, amountKobo) {
      try {
        const v = await api.verify(reference);
        if (!v || !v.transactionReference) return false;
        await call('POST', '/api/v1/refunds/initiate-refund', {
          transactionReference: v.transactionReference,
          refundReference: `RF-${reference}-${Date.now().toString(36)}`,
          refundAmount: amountKobo / 100,
          refundReason: 'Bali reservation refund',
          customerNote: 'Bali reservation refund',
          contractCode: env().MONNIFY_CONTRACT_CODE,
        });
        return true;
      } catch (e) { return false; }
    },
  };
  return api;
}
module.exports = { createMonnify };

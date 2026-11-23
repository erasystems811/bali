function createPaystack(ctx) {
  const key = ctx.env.PAYSTACK_SECRET_KEY;
  const call = (method, path, body) => {
    if (!key) throw new Error('PAYSTACK_SECRET_KEY not set');
    return ctx.http(method, `https://api.paystack.co${path}`, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body });
  };
  return {
    configured: !!key,
    async init({ reference, amountKobo, phone, callbackUrl, metadata }) {
      const res = await call('POST', '/transaction/initialize', {
        email: `${phone}@guest.erasystems.com.ng`, amount: amountKobo, reference, currency: 'NGN', callback_url: callbackUrl, metadata,
      });
      return res.data.authorization_url;
    },
    async verify(reference) { try { return (await call('GET', `/transaction/verify/${encodeURIComponent(reference)}`)).data; } catch (e) { return null; } },
    async refund(reference, amountKobo) { try { await call('POST', '/refund', { transaction: reference, amount: amountKobo }); return true; } catch (e) { return false; } },
  };
}
module.exports = { createPaystack };

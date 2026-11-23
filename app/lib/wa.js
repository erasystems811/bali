// WhatsApp Cloud API sending. Free text only inside the 24h window; outside it a template pings the person
// and the real text is queued until they reply "okay" (same mechanism Bali always used).
// ctx.http(method, url, {headers, body}) is injected so tests never touch the network.
function createWa(ctx) {
  const { pool, env } = ctx;
  const SANDBOX = !env.META_ACCESS_TOKEN;
  const graph = (body) => ctx.http('POST', `https://graph.facebook.com/v20.0/${env.META_PHONE_NUMBER_ID}/messages`, {
    headers: { Authorization: `Bearer ${env.META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: { messaging_product: 'whatsapp', ...body },
  }).then((r) => r?.messages?.[0]?.id || null);

  async function log(phone, direction, text) {
    try { await pool.query('insert into reservation_log (phone_number, direction, message_text) values ($1,$2,$3)', [phone, direction, text]); } catch (e) {}
  }
  async function withinWindow(to, justMessaged) {
    if (justMessaged) return true;
    const { rows } = await pool.query("select created_at from reservation_log where phone_number=$1 and direction='inbound' order by created_at desc limit 1", [to]);
    if (!rows[0]) return false;
    return (Date.now() - new Date(rows[0].created_at).getTime()) / 3600000 < 23;
  }
  async function template(to, label) {
    return graph({
      to, type: 'template',
      template: { name: 'bali_update', language: { code: 'en_US' }, components: [{ type: 'body', parameters: [{ type: 'text', text: String(label || 'an update').replace(/\s+/g, ' ').slice(0, 200) }] }] },
    });
  }
  // opts.reply = true when we are answering a message that just arrived (window is certainly open)
  async function send(to, text, label, opts = {}) {
    await log(to, 'outbound', text);
    if (SANDBOX) { ctx.sandbox?.push({ to, text, kind: 'text' }); return null; }
    if (!(await withinWindow(to, opts.reply))) {
      await template(to, label || 'a reservation update');
      await pool.query('insert into queued_messages (phone_number, message_text) values ($1,$2)', [to, text]);
      return null;
    }
    try { return await graph({ to, type: 'text', text: { body: text } }); } catch (err) {
      const s = JSON.stringify(err?.body || err?.message || '');
      if (s.includes('131047')) {
        await template(to, label || 'a reservation update');
        await pool.query('insert into queued_messages (phone_number, message_text) values ($1,$2)', [to, text]);
        return null;
      }
      throw err;
    }
  }
  // One card: optional header picture, body text, ONE tap button (WhatsApp allows a single URL button per message).
  async function sendCta(to, { image, body, button, url }) {
    await log(to, 'outbound', `${body} [${button} -> ${url}]`);
    if (SANDBOX) { ctx.sandbox?.push({ to, text: body, kind: 'cta', button, url }); return null; }
    const interactive = { type: 'cta_url', body: { text: body }, action: { name: 'cta_url', parameters: { display_text: button, url } } };
    if (image) interactive.header = { type: 'image', image: { link: image } };
    return graph({ to, type: 'interactive', interactive });
  }
  // release anything queued for a person who has just messaged us (they replied "okay" etc.)
  async function flushQueue(phone) {
    const { rows } = await pool.query('select id, message_text from queued_messages where phone_number=$1 order by created_at asc', [phone]);
    for (const r of rows) {
      try { if (!SANDBOX) await graph({ to: phone, type: 'text', text: { body: r.message_text } }); else ctx.sandbox?.push({ to: phone, text: r.message_text, kind: 'text' }); } catch (e) {}
      await pool.query('delete from queued_messages where id=$1', [r.id]);
    }
    return rows.length;
  }
  return { send, sendCta, flushQueue, log };
}
module.exports = { createWa };

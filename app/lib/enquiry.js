// Enquiries: the bot ALWAYS answers from the knowledge_base table (the venue edits it on the dashboard).
// Deterministic matching first; an optional LLM pass (if a working OpenAI key exists) may rephrase WITHIN the KB only.
const STOP = new Set(('a an the is are was were be do does did can could would will you your yours i me my we our us it its to of for on in at by with and or if so as that this there any have has had what which who how when where why please pls hi hello hey').split(' '));
const SYN = { cost: 'price fee pay payment', price: 'cost fee pay payment', fee: 'cost price', hours: 'open close opening closing time', open: 'hours opening', close: 'hours closing', opening: 'open hours', closing: 'close hours', refund: 'cancel money back', cancel: 'refund cancellation', parking: 'park car', menu: 'food drinks eat', location: 'address where directions', address: 'location directions', dress: 'code wear attire' };

function tokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w)).map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
}
function expand(ts) { const out = new Set(ts); for (const t of ts) if (SYN[t]) SYN[t].split(' ').forEach((x) => out.add(x)); return out; }

function bestMatch(question, entries) {
  const q = tokens(question);
  if (!q.length) return null;
  const qExp = expand(q);
  let best = null;
  for (const e of entries) {
    const eq = new Set(tokens(e.question));
    const ek = new Set(tokens(e.keywords));
    const ea = expand([...eq, ...ek]);
    let hits = 0;
    for (const t of q) { if (eq.has(t)) hits += 1.5; else if (ek.has(t)) hits += 1.2; else if (ea.has(t)) hits += 0.6; }
    for (const t of qExp) if (!q.includes(t) && (eq.has(t) || ek.has(t))) hits += 0.15;
    const precision = hits / (q.length * 1.5);
    const score = hits >= 1.2 ? precision + Math.min(hits, 6) / 12 : 0;
    if (!best || score > best.score) best = { entry: e, score, hits };
  }
  return best && best.hits >= 1.2 && best.score >= 0.45 ? best : null;
}

function createEnquiry(ctx, resv) {
  const { pool, env } = ctx;
  const base = () => (env.APP_BASE_URL || '').replace(/\/$/, '');

  async function llmAnswer(question, entries) {
    if (!env.OPENAI_API_KEY) return null;
    try {
      const res = await ctx.http('POST', 'https://api.openai.com/v1/chat/completions', {
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: {
          model: 'gpt-4o-mini', temperature: 0, response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: `Answer a guest's question using ONLY this knowledge base: ${JSON.stringify(entries.map((e) => ({ q: e.question, a: e.answer })))}. Reply ONLY JSON {"found":true|false,"answer":"short friendly plain text, no hyphens or asterisks"}. If the knowledge base does not clearly answer it, found must be false. Never invent facts.` },
            { role: 'user', content: question },
          ],
        },
      });
      const j = JSON.parse(res.choices[0].message.content);
      return j.found && j.answer ? String(j.answer).trim() : null;
    } catch (e) { return null; }
  }

  // returns {text, action?:{label,url}, chips?:[...]}
  async function reply(phone, text) {
    const t = String(text || '').trim();
    const token = await resv.sessionToken(phone);
    const form = `${base()}/reserve/${token}`;
    const manage = `${base()}/my/${token}`;
    if (!t) return { text: 'Please type your question.' };

    const { rows: kb } = await pool.query('select id, question, answer, keywords from knowledge_base order by sort_order, last_updated');
    const wantsPolicy = /\b(refund|policy|money back)\b/i.test(t);
    if (!wantsPolicy && /\b(cancel|reschedule|change|move|modify|amend|my (booking|reservation|table))\b/i.test(t)) {
      return { text: 'You can see, change or cancel your reservation here.', action: { label: 'My reservation', url: manage } };
    }
    const m = bestMatch(t, kb);
    if (m) return { text: m.entry.answer };
    const viaLlm = await llmAnswer(t, kb);
    if (viaLlm) return { text: viaLlm };
    if (/\b(book|reserve|reservation|table|seat)\b/i.test(t)) {
      return { text: 'You can book a table with this short form.', action: { label: 'Reserve a table', url: form } };
    }
    // not in the knowledge base: remember it for the venue and tell the handover number
    await pool.query('insert into kb_unanswered (phone_number, question) values ($1,$2)', [phone, t.slice(0, 500)]);
    try {
      const { loadSettings } = require('./core');
      const S = await loadSettings(ctx);
      await resv.notifyHandover(S, `Guest question I could not answer (${phone}): "${t.slice(0, 300)}". Add the answer on the dashboard Knowledge base tab so I can answer it next time.`, 'a guest question');
    } catch (e) {}
    return { text: 'Good question. I do not have that answer yet, so I have passed it to the team and they will get back to you.' };
  }

  async function chips() {
    const { rows } = await pool.query('select question from knowledge_base order by sort_order, last_updated limit 6');
    return rows.map((r) => r.question);
  }
  return { reply, chips };
}
module.exports = { createEnquiry, bestMatch, tokens };

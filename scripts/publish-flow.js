// Creates (or updates) and publishes Bali's WhatsApp form on Meta, then prints the Flow ID.
// usage: node scripts/publish-flow.js            (reads META_ACCESS_TOKEN from ../.env)
//        node scripts/publish-flow.js <flowId>   (updates the existing flow's JSON, then publishes)
const fs = require('fs');
const path = require('path');
const { flowJson, logoBase64 } = require('../app/lib/flow');

const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const TOKEN = env.META_ACCESS_TOKEN;
const WABA = '1031983186085860';
const G = 'https://graph.facebook.com/v21.0';
const json = JSON.stringify(flowJson(logoBase64()));

async function call(method, url, body, isForm) {
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${TOKEN}`, ...(isForm ? {} : { 'Content-Type': 'application/json' }) }, body: isForm ? body : body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, j };
}

(async () => {
  let id = process.argv[2];
  if (!id) {
    const c = await call('POST', `${G}/${WABA}/flows`, { name: 'Bali reservation ' + new Date().toISOString().slice(0, 19).replace('T', ' '), categories: ['APPOINTMENT_BOOKING'], endpoint_uri: process.env.FLOW_ENDPOINT || 'https://bali.erasystems.com.ng/flow/endpoint' });
    if (!c.ok) { console.error('create failed', JSON.stringify(c.j)); process.exit(1); }
    id = c.j.id; console.log('created flow', id);
  }
  const fd = new FormData();
  fd.append('file', new Blob([json], { type: 'application/json' }), 'flow.json');
  fd.append('name', 'flow.json'); fd.append('asset_type', 'FLOW_JSON');
  const up = await call('POST', `${G}/${id}/assets`, fd, true);
  console.log('upload', up.ok, JSON.stringify(up.j.validation_errors || []).slice(0, 1500));
  if (!up.ok || (up.j.validation_errors || []).length) { console.error('Flow JSON has errors, not publishing.'); console.error(JSON.stringify(up.j).slice(0, 2000)); process.exit(1); }
  const pub = await call('POST', `${G}/${id}/publish`);
  console.log('publish', pub.ok, JSON.stringify(pub.j).slice(0, 600));
  const info = await call('GET', `${G}/${id}?fields=id,name,status,validation_errors`);
  console.log(JSON.stringify(info.j));
  console.log('FLOW_ID=' + id);
})();

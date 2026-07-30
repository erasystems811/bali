// Sandbox test webpage -- POST /sandbox-persona
// Creates a new fake persona (any role the database currently allows -- see
// sandbox-roles-code.js) with a made-up phone number, so testing never needs
// a real number for anyone. Body: { name, role }.
const helpers = this.helpers;
const env = { SUPABASE_URL: $env.SUPABASE_URL, SUPABASE_KEY: $env.SUPABASE_SERVICE_KEY };
const sbHeaders = { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}` };

// Snapshot every sandbox table before this action so it can be undone on its
// own via /sandbox-undo, one action at a time, instead of the all-or-nothing
// /sandbox-reset. See sandbox-undo-code.js for how a snapshot gets restored.
const SNAPSHOT_TABLES = ['contacts', 'bookings', 'conversations', 'pending_questions', 'invoices', 'contracts', 'knowledge_base', 'sandbox_outbound'];
async function takeSnapshot(label) {
  const tables_json = {};
  for (const table of SNAPSHOT_TABLES) {
    tables_json[table] = await helpers.httpRequest({
      method: 'GET',
      url: `${env.SUPABASE_URL}/rest/v1/${table}?select=*`,
      headers: sbHeaders,
      json: true,
      timeout: 15000,
    });
  }
  await helpers.httpRequest({
    method: 'POST',
    url: `${env.SUPABASE_URL}/rest/v1/sandbox_snapshots`,
    headers: { ...sbHeaders, 'Content-Type': 'application/json' },
    body: { label, tables_json },
    json: true,
    timeout: 15000,
  });
}

const input = $input.first().json.body || {};

const name = (input.name || '').trim();
const role = (input.role || '').trim();
if (!name || !role) {
  return [{ json: { error: 'name and role are both required' } }];
}

await takeSnapshot(`Create persona "${name}" (${role})`);

// 234000 is the existing convention in this codebase for obviously-fake test
// numbers (never a real, dialable number) -- see docs/setup.md's note on
// synthetic 234000000xxxx contacts used throughout live testing.
const fakeNumber = `234000${String(Math.floor(Math.random() * 900000) + 100000)}`;

const created = await helpers.httpRequest({
  method: 'POST',
  url: `${env.SUPABASE_URL}/rest/v1/contacts`,
  headers: {
    apikey: env.SUPABASE_KEY,
    Authorization: `Bearer ${env.SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  },
  body: { name, role, phone_number: fakeNumber },
  json: true,
  timeout: 15000,
});

return [{ json: { persona: created?.[0] || created } }];

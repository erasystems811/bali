// Sandbox test webpage -- POST /sandbox-undo
// Pops the most recent snapshot (taken automatically before every mutating
// sandbox action -- see takeSnapshot() in sandbox-send-code.js and
// sandbox-persona-create-code.js) and restores every sandbox table to
// exactly how it looked right before that one action. Repeatable -- each
// call undoes one more step back, unlike /sandbox-reset which wipes
// everything to empty in one go.
const helpers = this.helpers;
const env = { SUPABASE_URL: $env.SUPABASE_URL, SUPABASE_KEY: $env.SUPABASE_SERVICE_KEY };
const headers = { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}`, 'Content-Type': 'application/json' };

// Parent-first, safe for re-inserting. Deletes run in the reverse order
// (children before parents), same convention as sandbox-reset-code.js.
const TABLE_ORDER = ['contacts', 'bookings', 'conversations', 'pending_questions', 'invoices', 'contracts', 'sandbox_outbound'];

const snapshots = await helpers.httpRequest({
  method: 'GET',
  url: `${env.SUPABASE_URL}/rest/v1/sandbox_snapshots?order=id.desc&limit=1&select=*`,
  headers,
  json: true,
  timeout: 15000,
});
const snapshot = snapshots[0];
if (!snapshot) {
  return [{ json: { ok: false, message: 'Nothing to undo.' } }];
}

for (const table of [...TABLE_ORDER].reverse()) {
  await helpers.httpRequest({
    method: 'DELETE',
    url: `${env.SUPABASE_URL}/rest/v1/${table}?id=not.is.null`,
    headers,
    timeout: 15000,
  });
}
for (const table of TABLE_ORDER) {
  const rows = snapshot.tables_json[table] || [];
  if (rows.length === 0) continue;
  await helpers.httpRequest({
    method: 'POST',
    url: `${env.SUPABASE_URL}/rest/v1/${table}`,
    headers,
    body: rows,
    json: true,
    timeout: 15000,
  });
}

await helpers.httpRequest({
  method: 'DELETE',
  url: `${env.SUPABASE_URL}/rest/v1/sandbox_snapshots?id=eq.${snapshot.id}`,
  headers,
  timeout: 15000,
});

const remaining = await helpers.httpRequest({
  method: 'GET',
  url: `${env.SUPABASE_URL}/rest/v1/sandbox_snapshots?select=id`,
  headers,
  json: true,
  timeout: 15000,
});

return [{ json: { ok: true, undone: snapshot.label, remaining: remaining.length } }];

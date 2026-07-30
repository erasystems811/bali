// Sandbox test webpage -- POST /sandbox-reset
// Wipes every sandbox-only table back to empty, so a scenario can be re-run
// from a clean slate as many times as needed. Deletes in FK-safe order
// (children before parents). Never touches the real app's data -- this Code
// node's SUPABASE_URL always points at the sandbox database, never the live
// one (see n8n's docker-compose sandbox-n8n service definition).
const helpers = this.helpers;
const env = { SUPABASE_URL: $env.SUPABASE_URL, SUPABASE_KEY: $env.SUPABASE_SERVICE_KEY };
const headers = { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}`, 'Content-Type': 'application/json' };

async function wipe(table) {
  return helpers.httpRequest({
    method: 'DELETE',
    url: `${env.SUPABASE_URL}/rest/v1/${table}?id=not.is.null`,
    headers,
    timeout: 15000,
  });
}

for (const table of ['conversations', 'pending_questions', 'invoices', 'contracts', 'sandbox_outbound', 'bookings', 'contacts', 'sandbox_snapshots']) {
  await wipe(table);
}

return [{ json: { ok: true, reset_at: new Date().toISOString() } }];

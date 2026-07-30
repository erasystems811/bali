// Sandbox test webpage -- GET /sandbox-undo-count
// How many undo steps are currently available, for the webpage to show next
// to the Undo button (and disable it at zero) without guessing client-side.
const helpers = this.helpers;
const env = { SUPABASE_URL: $env.SUPABASE_URL, SUPABASE_KEY: $env.SUPABASE_SERVICE_KEY };

const rows = await helpers.httpRequest({
  method: 'GET',
  url: `${env.SUPABASE_URL}/rest/v1/sandbox_snapshots?select=id`,
  headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}` },
  json: true,
  timeout: 15000,
});

return [{ json: { count: rows.length } }];

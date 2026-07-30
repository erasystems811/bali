// Sandbox test webpage -- GET /sandbox-personas
// Lists every fake persona currently in the sandbox database, so the test
// page always reflects exactly who exists right now -- add one, it shows up
// here on the next poll, no page rebuild needed.
const helpers = this.helpers;
const env = { SUPABASE_URL: $env.SUPABASE_URL, SUPABASE_KEY: $env.SUPABASE_SERVICE_KEY };

const contacts = await helpers.httpRequest({
  method: 'GET',
  url: `${env.SUPABASE_URL}/rest/v1/contacts?select=id,name,phone_number,role&order=created_at.asc`,
  headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}` },
  json: true,
  timeout: 15000,
});

return [{ json: { personas: contacts || [] } }];

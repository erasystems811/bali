// Sandbox test webpage -- GET /sandbox-roles
// Returns the *actual* list of contact roles the database currently allows
// (parsed live from the contacts.role CHECK constraint via the
// contact_role_options() RPC -- see supabase/schema.sql), not a hardcoded
// list here. If schema.sql ever grows the allowed-roles list, this follows
// automatically the next time it's applied -- the sandbox's "add a persona"
// picker is never out of date with what the real app actually accepts.
const helpers = this.helpers;
const env = { SUPABASE_URL: $env.SUPABASE_URL, SUPABASE_KEY: $env.SUPABASE_SERVICE_KEY };

const roles = await helpers.httpRequest({
  method: 'POST',
  url: `${env.SUPABASE_URL}/rest/v1/rpc/contact_role_options`,
  headers: {
    apikey: env.SUPABASE_KEY,
    Authorization: `Bearer ${env.SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  },
  body: {},
  json: true,
  timeout: 15000,
});

return [{ json: { roles: roles || [] } }];

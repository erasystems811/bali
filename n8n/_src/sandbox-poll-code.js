// Sandbox test webpage -- GET /sandbox-poll?since=<ISO timestamp>
// Returns everything the bot would have sent out over real WhatsApp since
// the given time (captured in sandbox_outbound by the SANDBOX guards added
// to every sendWhatsApp*/uploadWhatsAppMedia function -- see the comment atop
// each _src file's SANDBOX const). The page polls this and routes each
// message into the matching persona's chat window by phone number.
const helpers = this.helpers;
const env = { SUPABASE_URL: $env.SUPABASE_URL, SUPABASE_KEY: $env.SUPABASE_SERVICE_KEY };
const since = $input.first().json.query?.since || '1970-01-01T00:00:00Z';

const rows = await helpers.httpRequest({
  method: 'GET',
  url: `${env.SUPABASE_URL}/rest/v1/sandbox_outbound?created_at=gt.${encodeURIComponent(since)}&order=created_at.asc&select=*`,
  headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}` },
  json: true,
  timeout: 15000,
});

return [{ json: { messages: rows || [], polled_at: new Date().toISOString() } }];

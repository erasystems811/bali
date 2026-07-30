// Sandbox test webpage -- POST /sandbox-send
// Takes a message typed "as" a given persona and feeds it into the exact
// same inbound router (01-inbound-router.json) the real app uses -- built as
// a Meta-Cloud-API-shaped payload, same as what Nexa forwards for real
// traffic, so every bit of real routing/role logic gets exercised for real,
// not reimplemented here. Body: { phone_number, text }.
const helpers = this.helpers;
const env = { N8N_BASE_URL: $env.N8N_BASE_URL, FORWARD_SECRET: $env.BALI_FORWARD_SECRET };
const input = $input.first().json.body || {};

const phoneNumber = (input.phone_number || '').trim();
const text = (input.text || '').trim();
if (!phoneNumber || !text) {
  return [{ json: { error: 'phone_number and text are both required' } }];
}

const messageId = `sandbox-wamid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

await helpers.httpRequest({
  method: 'POST',
  url: `${env.N8N_BASE_URL}/webhook/whatsapp-inbound`,
  headers: { 'Content-Type': 'application/json', 'x-bali-forward-secret': env.FORWARD_SECRET },
  body: {
    entry: [{
      changes: [{
        value: {
          messages: [{
            from: phoneNumber,
            id: messageId,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: text },
          }],
        },
      }],
    }],
  },
  json: true,
  timeout: 15000,
});

return [{ json: { ok: true, whatsapp_message_id: messageId } }];

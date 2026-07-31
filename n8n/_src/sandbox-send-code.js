// Sandbox test webpage -- POST /sandbox-send
// Takes a message typed "as" a given persona and feeds it into the exact
// same inbound router (01-inbound-router.json) the real app uses -- built as
// a Meta-Cloud-API-shaped payload, same as what Nexa forwards for real
// traffic, so every bit of real routing/role logic gets exercised for real,
// not reimplemented here. Body: { phone_number, text, reply_to_message_id,
// media_type, filename }.
// reply_to_message_id is optional -- the id of a prior sandbox_outbound row
// the sender picked "reply" on in the webpage, standing in for a real
// WhatsApp swipe-reply. Passed through as messages[0].context.id, exactly
// where 01-inbound-router.json's Parse Inbound Message node reads a real
// swipe-reply's quoted message id from (message.context?.id).
// media_type is optional -- 'image' or 'document', for simulating a receipt/
// proof-of-payment upload (e.g. Stage 3's payment-confirmation flow, which
// only checks that an image/document arrived, never its actual content --
// see the media_id?.id check in 01-inbound-router.json's Parse Inbound
// Message node). No real file storage involved: the id is synthetic and
// nothing downstream ever fetches it, matching how the real bot never looks
// at the receipt image either, just asks the PM to confirm receipt.
const helpers = this.helpers;
const env = {
  N8N_BASE_URL: $env.N8N_BASE_URL,
  FORWARD_SECRET: $env.BALI_FORWARD_SECRET,
  SUPABASE_URL: $env.SUPABASE_URL,
  SUPABASE_KEY: $env.SUPABASE_SERVICE_KEY,
};
const sbHeaders = { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}` };

// Snapshot every sandbox table before this action so it can be undone on its
// own via /sandbox-undo, one action at a time, instead of the all-or-nothing
// /sandbox-reset. One "send" can cascade through several tables (booking
// fields, conversations, pending_questions, invoices...) via the real
// pipeline below -- taking the snapshot right before dispatching it captures
// state as of "before this one action", however much it goes on to touch.
// See sandbox-undo-code.js for how a snapshot gets restored.
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

const phoneNumber = (input.phone_number || '').trim();
const text = (input.text || '').trim();
const replyToMessageId = (input.reply_to_message_id || '').trim();
const mediaType = (input.media_type || '').trim();
if (mediaType && mediaType !== 'image' && mediaType !== 'document') {
  return [{ json: { error: 'media_type must be "image" or "document" if given' } }];
}
if (!phoneNumber || (!text && !mediaType)) {
  return [{ json: { error: 'phone_number and (text or media_type) are required' } }];
}

const filename = (input.filename || '').trim() || (mediaType === 'image' ? 'receipt.jpg' : 'document.pdf');
await takeSnapshot(mediaType ? `Send [${mediaType}] ${filename}` : `Send "${text}"`);

const messageId = `sandbox-wamid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const mediaId = `sandbox-media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
            type: mediaType || 'text',
            ...(mediaType
              ? { [mediaType]: { id: mediaId, filename: mediaType === 'document' ? filename : undefined } }
              : { text: { body: text } }),
            ...(replyToMessageId ? { context: { id: replyToMessageId } } : {}),
          }],
        },
      }],
    }],
  },
  json: true,
  timeout: 15000,
});

return [{ json: { ok: true, whatsapp_message_id: messageId, media_id: mediaType ? mediaId : undefined } }];

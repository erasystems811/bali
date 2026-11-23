// WhatsApp Flows endpoint encryption: RSA-OAEP(SHA-256) wraps a per-request AES-128 key; bodies are AES-128-GCM.
// The response is encrypted with the same key and the IV with every byte flipped.
const crypto = require('crypto');

function decryptRequest(body, privatePem) {
  const { encrypted_aes_key: k, encrypted_flow_data: d, initial_vector: v } = body || {};
  if (!k || !d || !v) throw new Error('missing encrypted fields');
  const aesKey = crypto.privateDecrypt({ key: privatePem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(k, 'base64'));
  const iv = Buffer.from(v, 'base64');
  const data = Buffer.from(d, 'base64');
  const TAG = 16;
  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, iv);
  decipher.setAuthTag(data.subarray(-TAG));
  const plain = Buffer.concat([decipher.update(data.subarray(0, -TAG)), decipher.final()]).toString('utf8');
  return { decrypted: JSON.parse(plain), aesKey, iv };
}

function encryptResponse(response, aesKey, iv) {
  const flipped = Buffer.from(Array.from(iv).map((b) => ~b & 0xff));
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flipped);
  return Buffer.concat([cipher.update(JSON.stringify(response), 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

module.exports = { decryptRequest, encryptResponse };

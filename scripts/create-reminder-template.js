// Creates the WhatsApp message template used for the reminder when the guest is outside the 24h window.
// The button URL base is fixed inside the template: if the app moves to a new domain, create a new version
// (bump the name, e.g. bali_reservation_reminder_2, and set REMINDER_TEMPLATE) with the new base.
// usage: node scripts/create-reminder-template.js [name] [baseUrl]
const fs = require('fs');
const path = require('path');
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const name = process.argv[2] || 'bali_reservation_reminder';
const base = (process.argv[3] || 'https://bali.erasystems.com.ng').replace(/\/$/, '');

const body = {
  name, language: 'en_US', category: 'UTILITY',
  components: [
    {
      type: 'BODY',
      text: "Hey {{1}}, just a reminder that by {{2}} you'll be spending time with us at Bali. We are excited and we can't wait to see you!\n\n{{3}}\n\nFor further enquiries, you can tap the button below to chat with us.",
      example: { body_text: [['Ada', '7:30 PM today', 'Table for 4 guests, Ref R-1234']] },
    },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'CHAT WITH US', url: `${base}/ask/{{1}}`, example: [`${base}/ask/abc123def456`] }] },
  ],
};

(async () => {
  const r = await fetch('https://graph.facebook.com/v21.0/1031983186085860/message_templates', { method: 'POST', headers: { Authorization: 'Bearer ' + env.META_ACCESS_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  console.log('create', r.status, JSON.stringify(await r.json()).slice(0, 400));
  const g = await fetch(`https://graph.facebook.com/v21.0/1031983186085860/message_templates?name=${name}&fields=name,status,category,rejected_reason`, { headers: { Authorization: 'Bearer ' + env.META_ACCESS_TOKEN } });
  console.log('status', JSON.stringify((await g.json()).data));
})();

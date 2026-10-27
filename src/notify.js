// Notification hub. Every alert is stored in-app; WhatsApp / email go through adapters.
// Default adapters only log to the console – plug in WhatsApp Business API (Meta Cloud API,
// Interakt, Wati…) and SMTP by setting the env vars below and filling in send().
const { q, insert } = require('./db');
const { now } = require('./util');

const adapters = {
  whatsapp: {
    enabled: !!process.env.WHATSAPP_TOKEN,
    async send(to, text) {
      // Example: Meta Cloud API
      // await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {...})
      console.log(`[whatsapp → ${to}] ${text}`);
    },
  },
  email: {
    enabled: !!process.env.SMTP_URL,
    async send(to, subject, text) { console.log(`[email → ${to}] ${subject}: ${text}`); },
  },
};

// notify({ userId | role, title, body, link, dedupe, channels:['app','whatsapp'] })
function notify({ userId = null, role = null, title, body = '', link = null, dedupe = null, channels = ['app'] }) {
  const targets = userId ? [userId] : q.all('SELECT id FROM users WHERE active=1 AND role=?', role).map((u) => u.id);
  if (role === 'manager') {
    targets.push(...q.all("SELECT id FROM users WHERE active=1 AND role IN ('sales_manager','owner')").map((u) => u.id));
  }
  let created = 0;
  for (const uid of [...new Set(targets)]) {
    const key = dedupe ? `${dedupe}:u${uid}` : null;
    if (key && q.get('SELECT 1 FROM notifications WHERE dedupe_key=?', key)) continue;
    insert('notifications', { user_id: uid, role, channel: 'app', title, body, link, dedupe_key: key, created_at: now() });
    created++;
    const u = q.get('SELECT phone, email FROM users WHERE id=?', uid);
    if (channels.includes('whatsapp') && u?.phone) adapters.whatsapp.send(u.phone, `${title} – ${body}`).catch(() => {});
    if (channels.includes('email') && u?.email) adapters.email.send(u.email, title, body).catch(() => {});
  }
  return created;
}

// Outbound message to a parent / teacher (welcome, invoice, reminders, payout statement).
function sendExternal(channel, to, text) {
  if (!to) return;
  return adapters[channel]?.send(to, text, text).catch(() => {});
}

module.exports = { notify, sendExternal, adapters };

// Field encryption at rest (AES-256-GCM) for bank details, KYC document refs/ID numbers and 2FA secrets,
// plus TOTP two-factor codes (RFC 6238, works with Google Authenticator / Microsoft Authenticator).
const crypto = require('crypto');

const PREFIX = 'enc:v1:';
let KEY = null;
function key() {
  if (KEY) return KEY;
  const raw = process.env.ENCRYPTION_KEY || '';
  if (/^[0-9a-f]{64}$/i.test(raw)) KEY = Buffer.from(raw, 'hex');
  else if (raw && Buffer.from(raw, 'base64').length === 32) KEY = Buffer.from(raw, 'base64');
  else KEY = crypto.createHash('sha256').update(`jeta-dev-only:${raw}`).digest(); // dev/demo fallback
  return KEY;
}
const hasRealKey = () => { const raw = process.env.ENCRYPTION_KEY || ''; return /^[0-9a-f]{64}$/i.test(raw) || (raw && Buffer.from(raw, 'base64').length === 32); };

function enc(v) {
  if (v === null || v === undefined || v === '' || String(v).startsWith(PREFIX)) return v;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(v), 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function dec(v) {
  if (!v || !String(v).startsWith(PREFIX)) return v;
  try {
    const b = Buffer.from(String(v).slice(PREFIX.length), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return '[cannot decrypt – check ENCRYPTION_KEY]'; }
}

// Encrypt any values still stored in plain text (runs on every start; cheap when nothing to do).
const FIELDS = { teachers: ['bank_details'], kyc: ['id_number', 'id_file', 'enrollment_file'], users: ['totp_secret'] };
function encryptExisting(q) {
  let n = 0;
  for (const [table, cols] of Object.entries(FIELDS)) {
    for (const col of cols) {
      for (const r of q.all(`SELECT id, ${col} v FROM ${table} WHERE ${col} IS NOT NULL AND ${col} <> '' AND ${col} NOT LIKE '${PREFIX}%'`)) {
        q.run(`UPDATE ${table} SET ${col}=? WHERE id=?`, enc(r.v), r.id); n++;
      }
    }
  }
  return n;
}

// ---------- TOTP ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0; let val = 0; let out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  let bits = 0; let val = 0; const out = [];
  for (const ch of String(s).replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
const newSecret = () => base32(crypto.randomBytes(20));
function totp(secret, step = Math.floor(Date.now() / 30000)) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1000000)).padStart(6, '0');
}
function verifyTotp(secret, code) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const step = Math.floor(Date.now() / 30000);
  return [-1, 0, 1].some((d) => crypto.timingSafeEqual(Buffer.from(totp(secret, step + d)), Buffer.from(c)));
}
const otpauth = (secret, account, issuer = 'Jeta Edu CRM') =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

module.exports = { enc, dec, hasRealKey, encryptExisting, newSecret, totp, verifyTotp, otpauth };

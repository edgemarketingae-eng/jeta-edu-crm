const path = require('path');
const express = require('express');
const config = require('./src/config');
const { db, q } = require('./src/db');
const automation = require('./src/automation');

const PROD = process.env.NODE_ENV === 'production';
// Demo data is opt-in on production servers and opt-out everywhere else.
const SEED_DEMO = process.env.SEED_DEMO ? process.env.SEED_DEMO === 'true' : !PROD;

db(); // open + migrate

// Encryption at rest: a real key is required on production servers.
const secure = require('./src/secure');
if (PROD && !secure.hasRealKey() && !SEED_DEMO) {
  console.error('Set ENCRYPTION_KEY (64 hex characters – generate with: openssl rand -hex 32). It encrypts bank details, KYC and 2FA secrets.');
  process.exit(1);
}

// First boot: create the Owner account (or demo data).
if (!q.get('SELECT 1 FROM users LIMIT 1')) {
  if (SEED_DEMO) {
    require('./src/context').run({ noAudit: true }, () => require('./src/seed').seed());
    q.run("INSERT OR REPLACE INTO settings(key,value) VALUES('demo','1')");
    console.log('Seeded demo data. Login: owner@jeta.edu / jeta1234');
  } else {
    const email = process.env.OWNER_EMAIL;
    const password = process.env.OWNER_PASSWORD;
    if (!email || !password || password.length < 10) {
      console.error('First start needs OWNER_EMAIL and OWNER_PASSWORD (10+ characters) to create the Owner account.');
      process.exit(1);
    }
    const { hashPassword } = require('./src/auth');
    q.run('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)', process.env.OWNER_NAME || 'Owner', email.toLowerCase(), hashPassword(password), 'owner');
    console.log(`Created Owner account ${email}. Sign in and add your team under Users & roles.`);
  }
}

{ const n = secure.encryptExisting(q); if (n) console.log(`Encrypted ${n} sensitive field(s) at rest.`); }

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);

// Request context: lets the audit log know who made each change.
const { als } = require('./src/context');
app.use((req, res, next) => als.run({ userId: null }, next));

// Baseline security headers (Nginx may add HSTS on top).
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});

// Sign-in brute-force guard: 10 failed attempts per IP + email in 15 minutes.
const attempts = new Map();
app.use('/api/login', (req, res, next) => {
  if (req.method !== 'POST') return next();
  const key = `${req.ip}|${String(req.body?.email || '').toLowerCase()}`;
  const nowMs = Date.now();
  const rec = attempts.get(key);
  if (rec && rec.until > nowMs && rec.n >= 10) return res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' });
  res.on('finish', () => {
    if (res.statusCode === 401) {
      const r = attempts.get(key);
      attempts.set(key, r && r.until > nowMs ? { n: r.n + 1, until: r.until } : { n: 1, until: nowMs + 15 * 60000 });
    } else if (res.statusCode === 200) attempts.delete(key);
  });
  next();
});
app.use(express.json({ limit: '5mb' }));

app.get('/api/app-info', (req, res) => res.json({ demo: !!q.get("SELECT 1 FROM settings WHERE key='demo'") }));
app.use('/api', require('./src/routes'));
app.get('/health', (req, res) => { q.get('SELECT 1'); res.json({ ok: true }); });
app.get('/t/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'teacher.html')));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: PROD ? '1h' : 0 }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const timer = process.env.AUTOMATION !== 'off' ? automation.start(60000) : null;
const server = app.listen(config.port, process.env.HOST || '0.0.0.0', () => console.log(`Jeta Edu CRM on http://localhost:${config.port}`));

// Graceful shutdown so the database is closed cleanly on restarts and deploys.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    clearInterval(timer);
    server.close(() => { try { db().close(); } catch { /* already closed */ } process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

const crypto = require('crypto');
const { q, insert } = require('./db');
const { now, addDays, fail } = require('./util');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

// Two-factor login (blueprint 19): required for Owner, Admin and Accounts.
const TWOFA_ROLES = ['owner', 'admin', 'accounts'];
function twofaRequired(u) {
  if (!TWOFA_ROLES.includes(u.role)) return false;
  const setting = require('./services/settings').get('security').require2fa;
  if (setting === true || setting === false) return setting;
  const demo = !!q.get("SELECT 1 FROM settings WHERE key='demo'");
  return process.env.NODE_ENV === 'production' && !demo;
}
const tickets = new Map(); // short-lived "password OK, waiting for code" tickets

function issueSession(u, restricted = false) {
  const token = crypto.randomBytes(32).toString('hex');
  insert('sessions', { token, user_id: u.id, expires_at: addDays(now(), 14), restricted: restricted ? 1 : 0 });
  require('./db').writeAudit('login', 'users', u.id, null, restricted ? 'signed in – 2FA setup pending' : 'signed in');
  return { token, user: publicUser(u), needs2faSetup: restricted };
}

function login(email, password) {
  const u = q.get('SELECT * FROM users WHERE lower(email)=lower(?) AND active=1', email || '');
  if (!u || !verifyPassword(password || '', u.password_hash)) fail(401, 'Invalid email or password');
  if (u.totp_enabled) {
    const ticket = crypto.randomBytes(24).toString('hex');
    tickets.set(ticket, { userId: u.id, exp: Date.now() + 5 * 60000, tries: 0 });
    return { twofa: true, ticket };
  }
  return issueSession(u, twofaRequired(u));
}

function login2fa(ticket, code) {
  const t = tickets.get(String(ticket || ''));
  if (!t || t.exp < Date.now()) { tickets.delete(ticket); fail(401, 'Sign-in expired – enter your password again'); }
  const u = q.get('SELECT * FROM users WHERE id=? AND active=1', t.userId);
  const { verifyTotp, dec } = require('./secure');
  if (!u || !verifyTotp(dec(u.totp_secret), code)) {
    t.tries += 1;
    if (t.tries >= 5) tickets.delete(ticket);
    fail(401, 'That code is not right – use the current 6-digit code from your authenticator app');
  }
  tickets.delete(ticket);
  return issueSession(u, false);
}

function setup2fa(user) {
  const { newSecret, otpauth, enc } = require('./secure');
  const secret = newSecret();
  q.run('UPDATE users SET totp_secret=?, totp_enabled=0 WHERE id=?', enc(secret), user.id);
  return { secret, otpauth: otpauth(secret, user.email) };
}
function enable2fa(user, code) {
  const u = q.get('SELECT * FROM users WHERE id=?', user.id);
  const { verifyTotp, dec } = require('./secure');
  if (!u.totp_secret) fail(400, 'Start setup first');
  if (!verifyTotp(dec(u.totp_secret), code)) fail(400, 'That code is not right – check the time on your phone and try the newest code');
  q.run('UPDATE users SET totp_enabled=1 WHERE id=?', user.id);
  q.run('UPDATE sessions SET restricted=0 WHERE user_id=?', user.id);
  require('./db').writeAudit('2fa_enabled', 'users', user.id);
  return { ok: true };
}
function reset2fa(userId) {
  q.run('UPDATE users SET totp_secret=NULL, totp_enabled=0 WHERE id=?', userId);
  q.run('DELETE FROM sessions WHERE user_id=?', userId);
  require('./db').writeAudit('2fa_reset', 'users', userId);
  return { ok: true };
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, market: u.market, active: u.active, phone: u.phone, totp_enabled: !!u.totp_enabled };
}

function authenticate(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  const s = q.get(
    'SELECT u.*, s.restricted session_restricted FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>? AND u.active=1',
    token, now(),
  );
  if (!s) return res.status(401).json({ error: 'Session expired' });
  // Until a required 2FA is set up, only the setup endpoints work.
  if (s.session_restricted && !['/me', '/2fa/setup', '/2fa/enable', '/logout', '/meta'].includes(req.path)) {
    return res.status(403).json({ error: 'Set up two-factor sign-in first', code: '2FA_SETUP' });
  }
  req.user = s;
  req.token = token;
  const store = require('./context').als.getStore();
  if (store) store.userId = s.id;
  next();
}

// Permission matrix (blueprint section 2)
const PERMS = {
  'leads.view_all':      ['owner', 'sales_manager', 'admin'],
  'leads.edit':          ['owner', 'sales_manager', 'sales_exec'],
  'leads.reassign':      ['owner', 'sales_manager'],
  'kyc.verify':          ['owner', 'admin'],
  'students.edit':       ['owner', 'admin'],
  'students.view':       ['owner', 'admin', 'sales_manager', 'sales_exec', 'accounts'],
  'retention.edit':      ['owner', 'sales_manager', 'sales_exec'],
  'teachers.view':       ['owner', 'admin', 'accounts'],
  'teachers.edit':       ['owner', 'admin'],
  'attendance.edit':     ['owner', 'admin'],
  'payments.edit':       ['owner', 'accounts', 'sales_manager', 'sales_exec'],
  'payments.approve':    ['owner', 'accounts'],
  'refunds.approve':     ['owner', 'sales_manager'],
  'expenses.edit':       ['owner', 'accounts'],
  'payouts.view':        ['owner', 'admin', 'accounts'],
  'payouts.adjust':      ['owner', 'admin'],
  'payouts.approve':     ['owner', 'accounts'],
  'payouts.unlock':      ['owner'],
  'users.manage':        ['owner'],
  'dashboard.team':      ['owner', 'sales_manager', 'admin', 'accounts'],
  'reports.finance':     ['owner', 'accounts'],
  'game.view':           ['owner', 'sales_manager', 'sales_exec'],
  'audit.view':          ['owner', 'sales_manager'],
  'exports':             ['owner', 'sales_manager'],
  'settings.manage':     ['owner'],
  'review.view':         ['owner', 'sales_manager', 'admin', 'accounts'],
  'game.settings':       ['owner', 'sales_manager'],
};
const can = (user, perm) => !!PERMS[perm]?.includes(user.role);
const requirePerm = (perm) => (req, res, next) =>
  can(req.user, perm) ? next() : res.status(403).json({ error: `Your role (${req.user.role}) cannot do this` });

module.exports = { hashPassword, verifyPassword, login, login2fa, setup2fa, enable2fa, reset2fa, twofaRequired, authenticate, can, requirePerm, publicUser, PERMS };

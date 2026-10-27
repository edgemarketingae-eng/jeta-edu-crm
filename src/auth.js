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

function login(email, password) {
  const u = q.get('SELECT * FROM users WHERE lower(email)=lower(?) AND active=1', email || '');
  if (!u || !verifyPassword(password || '', u.password_hash)) fail(401, 'Invalid email or password');
  const token = crypto.randomBytes(32).toString('hex');
  insert('sessions', { token, user_id: u.id, expires_at: addDays(now(), 14) });
  return { token, user: publicUser(u) };
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, market: u.market, active: u.active, phone: u.phone };
}

function authenticate(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  const s = q.get(
    'SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>? AND u.active=1',
    token, now(),
  );
  if (!s) return res.status(401).json({ error: 'Session expired' });
  req.user = s;
  req.token = token;
  next();
}

// Permission matrix (blueprint section 2)
const PERMS = {
  'leads.view_all':      ['owner', 'sales_manager', 'admin'],
  'leads.edit':          ['owner', 'sales_manager', 'sales_exec'],
  'leads.reassign':      ['owner', 'sales_manager'],
  'leads.delete':        ['owner'],
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
};
const can = (user, perm) => !!PERMS[perm]?.includes(user.role);
const requirePerm = (perm) => (req, res, next) =>
  can(req.user, perm) ? next() : res.status(403).json({ error: `Your role (${req.user.role}) cannot do this` });

module.exports = { hashPassword, verifyPassword, login, authenticate, can, requirePerm, publicUser, PERMS };

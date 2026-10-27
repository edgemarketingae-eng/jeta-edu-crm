// Owner-editable settings stored in the database (company details, VAT, assignment, payout cycle, targets).
const config = require('../config');
const { q, writeAudit } = require('../db');

const DEFAULTS = {
  company: {
    name: process.env.BRAND_NAME || 'Jeta Edu', legal_name: '', address: '', trn: '', phone: '', email: '', website: '',
    logo_url: '/icon-512.png', vat_enabled: false, vat_rate: 5, invoice_prefix: 'JETA',
    footer: 'Thank you for choosing Jeta Edu. Fees once paid are subject to our refund policy.',
  },
  assignment: { mode: 'round_robin' },           // round_robin | least_open
  payouts: { cycle: 'monthly' },                 // monthly | fortnightly
  escalation: { hours48Action: config.escalation.hours48Action },
  compliance: { ...config.compliance },
  security: { require2fa: null },                // null = on in production, off for demo data
};

function get(key) {
  const row = q.get('SELECT value FROM settings WHERE key=?', key);
  return { ...DEFAULTS[key], ...(row ? JSON.parse(row.value) : {}) };
}
function set(key, value) {
  if (!DEFAULTS[key]) throw Object.assign(new Error('Unknown setting'), { status: 400 });
  const before = get(key);
  const next = { ...before };
  for (const k of Object.keys(DEFAULTS[key])) {
    if (value[k] === undefined) continue;
    const def = DEFAULTS[key][k];
    next[k] = typeof def === 'number' ? Number(value[k]) : typeof def === 'boolean' ? value[k] === true || value[k] === 1 || value[k] === '1' || value[k] === 'true' : value[k];
  }
  q.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(next));
  const changes = {};
  for (const k of Object.keys(next)) if (JSON.stringify(before[k]) !== JSON.stringify(next[k])) changes[k] = [before[k], next[k]];
  if (Object.keys(changes).length) writeAudit('update', 'settings', null, changes, key);
  return next;
}
const all = () => Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, get(k)]));

module.exports = { get, set, all, DEFAULTS };

const { q, insert } = require('./db');

const now = () => new Date().toISOString();
const addMinutes = (iso, m) => new Date(new Date(iso).getTime() + m * 60000).toISOString();
const addDays = (iso, d) => addMinutes(iso, d * 1440);
const daysBetween = (a, b) => (new Date(b) - new Date(a)) / 86400000;
const monthOf = (iso) => iso.slice(0, 7);

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

// Phone as the unique key: digits only, international form for UAE (971) and India (91).
function normalizePhone(p, country) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('05')) d = `971${d.slice(1)}`;          // UAE 05x xxx xxxx
  else if (d.length === 9 && d.startsWith('5')) d = `971${d}`;               // UAE 5x xxx xxxx
  else if (d.length === 10 && /^[6-9]/.test(d) && country !== 'UAE') d = `91${d}`; // India mobile
  else if (d.length === 11 && d.startsWith('0') && /^0[6-9]/.test(d)) d = `91${d.slice(1)}`;
  return d;
}

function log(entity, entityId, type, body, { userId = null, outcome = null, meta = null, extra = {} } = {}) {
  const id = insert('activities', {
    entity, entity_id: entityId, type, body, outcome,
    meta: meta ? JSON.stringify(meta) : null, user_id: userId, created_at: now(), ...extra,
  });
  // "Last action" shown on every list row (blueprint 2 – responsibility rule)
  if (entity === 'lead' && userId) q.run('UPDATE leads SET last_action_at=? WHERE id=?', now(), entityId);
  return id;
}

function task(t) {
  return insert('tasks', { status: 'Open', priority: 'Normal', created_at: now(), ...t });
}

function nextCode(table, prefix) {
  const r = q.get(`SELECT COALESCE(MAX(id),0)+1 AS n FROM ${table}`);
  return `${prefix}-${String(r.n).padStart(5, '0')}`;
}

module.exports = { normalizePhone, now, addMinutes, addDays, daysBetween, monthOf, HttpError, fail, log, task, nextCode };

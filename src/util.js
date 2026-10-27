const { q, insert } = require('./db');

const now = () => new Date().toISOString();
const addMinutes = (iso, m) => new Date(new Date(iso).getTime() + m * 60000).toISOString();
const addDays = (iso, d) => addMinutes(iso, d * 1440);
const daysBetween = (a, b) => (new Date(b) - new Date(a)) / 86400000;
const monthOf = (iso) => iso.slice(0, 7);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

function log(entity, entityId, type, body, { userId = null, outcome = null, meta = null } = {}) {
  return insert('activities', {
    entity, entity_id: entityId, type, body, outcome,
    meta: meta ? JSON.stringify(meta) : null, user_id: userId, created_at: now(),
  });
}

function task(t) {
  return insert('tasks', { status: 'Open', priority: 'Normal', created_at: now(), ...t });
}

function nextCode(table, prefix) {
  const r = q.get(`SELECT COALESCE(MAX(id),0)+1 AS n FROM ${table}`);
  return `${prefix}-${String(r.n).padStart(5, '0')}`;
}

module.exports = { now, addMinutes, addDays, daysBetween, monthOf, HttpError, fail, log, task, nextCode };

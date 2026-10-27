// Accountability plumbing: versioned note edits with approval, archive-not-delete, audit viewer.
const { q, insert, update, writeAudit } = require('../db');
const { now, fail, log } = require('../util');
const { notify } = require('../notify');

const EDITABLE = ['note', 'call', 'whatsapp', 'demo', 'email', 'walkin'];
const MANAGERS = ['owner', 'sales_manager'];

function applyEdit(a, { body, meta, outcome }, editor, reason) {
  insert('activity_versions', { activity_id: a.id, body: a.body, meta: a.meta, outcome: a.outcome, edited_by: editor.id, reason: reason || null, created_at: now() });
  const patch = { edited_at: now(), version: (a.version || 1) + 1 };
  if (body !== undefined) patch.body = body;
  if (meta !== undefined) patch.meta = typeof meta === 'string' ? meta : JSON.stringify(meta);
  if (outcome !== undefined) patch.outcome = outcome;
  update('activities', a.id, patch);
}

// Author can edit within 24 hours. After that – or for someone else's entry – a manager must approve.
function editActivity(id, body, user) {
  const a = q.get('SELECT * FROM activities WHERE id=?', id) || fail(404, 'Entry not found');
  if (!EDITABLE.includes(a.type)) fail(400, 'System entries cannot be edited');
  if (body.body === undefined || !String(body.body).trim()) fail(400, 'Text is required');
  const ageH = (Date.now() - new Date(a.created_at)) / 3600000;
  const isAuthor = a.user_id === user.id;
  if (isAuthor && ageH <= 24) { applyEdit(a, { body: body.body }, user, body.reason); return { applied: true }; }
  if (MANAGERS.includes(user.role)) {
    if (!body.reason) fail(400, 'A reason is required to edit this entry');
    applyEdit(a, { body: body.body }, user, body.reason);
    return { applied: true };
  }
  if (!isAuthor && user.role !== 'admin') fail(403, 'You can only edit your own entries');
  if (!body.reason) fail(400, 'Give a reason – edits after 24 hours need manager approval');
  const rid = insert('edit_requests', { activity_id: a.id, requested_by: user.id, new_body: body.body, reason: body.reason, created_at: now() });
  notify({ role: 'manager', title: 'Note edit needs approval', body: `${user.name}: ${body.reason}`, link: '#/review?tab=edits', dedupe: `edit:${rid}` });
  return { applied: false, pending: true, request_id: rid };
}

function editRequests(status = 'Pending') {
  return q.all(`SELECT r.*, a.body old_body, a.entity, a.entity_id, a.type, a.created_at entry_at, u.name requested_by_name
    FROM edit_requests r JOIN activities a ON a.id=r.activity_id LEFT JOIN users u ON u.id=r.requested_by
    WHERE r.status=? ORDER BY r.created_at DESC LIMIT 200`, status);
}

function decideEdit(requestId, approve, user) {
  const r = q.get('SELECT * FROM edit_requests WHERE id=?', requestId) || fail(404, 'Request not found');
  if (r.status !== 'Pending') fail(400, `Request already ${r.status.toLowerCase()}`);
  if (approve) {
    const a = q.get('SELECT * FROM activities WHERE id=?', r.activity_id);
    applyEdit(a, { body: r.new_body }, { id: r.requested_by }, `${r.reason} (approved by ${user.name})`);
  }
  q.run('UPDATE edit_requests SET status=?, decided_by=?, decided_at=? WHERE id=?', approve ? 'Approved' : 'Rejected', user.id, now(), r.id);
  writeAudit(approve ? 'edit_approved' : 'edit_rejected', 'activities', r.activity_id, null, r.reason);
  notify({ userId: r.requested_by, title: `Edit ${approve ? 'approved' : 'rejected'}`, body: r.reason, link: '#/dashboard' });
  return { ok: true };
}

const versions = (activityId) => q.all(`SELECT v.*, u.name edited_by_name FROM activity_versions v LEFT JOIN users u ON u.id=v.edited_by
  WHERE v.activity_id=? ORDER BY v.id DESC`, activityId);

// Nothing is hard-deleted: leads are archived (hidden from lists, history kept).
function archiveLead(id, reason, user) {
  const l = q.get('SELECT * FROM leads WHERE id=?', id) || fail(404, 'Lead not found');
  if (l.student_id) fail(400, 'Converted leads cannot be archived');
  if (!reason) fail(400, 'A reason is required');
  update('leads', id, { archived: 1, next_follow_up_at: null, updated_at: now() });
  q.run("UPDATE follow_ups SET status='Closed' WHERE lead_id=? AND status='Open'", id);
  log('lead', id, 'system', `Archived: ${reason}`, { userId: user.id });
  writeAudit('archive', 'leads', id, null, reason);
  return { ok: true };
}
function restoreLead(id, user) {
  update('leads', id, { archived: 0, updated_at: now() });
  log('lead', id, 'system', 'Restored from archive', { userId: user.id });
  return { ok: true };
}

function auditList({ entity, entity_id, user_id, action, from, to, limit = 200 }) {
  const w = []; const p = [];
  if (entity) { w.push('a.entity=?'); p.push(entity); }
  if (entity_id) { w.push('a.entity_id=?'); p.push(Number(entity_id)); }
  if (user_id) { w.push('a.user_id=?'); p.push(Number(user_id)); }
  if (action) { w.push('a.action=?'); p.push(action); }
  if (from) { w.push('a.created_at>=?'); p.push(new Date(from).toISOString()); }
  if (to) { w.push('a.created_at<?'); p.push(new Date(new Date(to).getTime() + 86400000).toISOString()); }
  return q.all(`SELECT a.*, u.name user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
    ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT ?`, ...p, Math.min(Number(limit) || 200, 1000))
    .map((r) => ({ ...r, changes: r.changes ? JSON.parse(r.changes) : null }));
}

module.exports = { editActivity, editRequests, decideEdit, versions, archiveLead, restoreLead, auditList, applyEdit };

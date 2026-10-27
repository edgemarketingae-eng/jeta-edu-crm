const express = require('express');
const config = require('./config');
const { q, insert, update } = require('./db');
const { now, addDays, fail, log, task } = require('./util');
const auth = require('./auth');
const leads = require('./services/leads');
const students = require('./services/students');
const finance = require('./services/finance');
const reports = require('./services/reports');
const automation = require('./automation');
const game = require('./services/game');
const history = require('./services/history');
const phone = require('./services/phone');
const attendance = require('./services/attendance');
const google = require('./integrations/google');

const r = express.Router();
const P = auth.requirePerm;
const sendErr = (res, e) => {
  const status = e.status || 500;
  if (status === 500) console.error(e);
  if (!res.headersSent) res.status(status).json({ error: status === 500 ? 'Something went wrong – check the server log' : e.message, ...(e.extra || {}) });
};
const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out && typeof out.then === 'function') out.then((v) => { if (v !== undefined && !res.headersSent) res.json(v); }, (e) => sendErr(res, e));
    else if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) { sendErr(res, e); }
};
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

// ---------- Public ----------
r.post('/login', wrap((req) => auth.login(req.body.email, req.body.password)));
r.post('/login/2fa', wrap((req) => auth.login2fa(req.body.ticket, req.body.code)));

// Lead capture webhook for website forms / Meta lead ads / Google Ads (set WEBHOOK_KEY).
r.post('/webhooks/lead', wrap((req) => {
  if (!process.env.WEBHOOK_KEY || req.query.key !== process.env.WEBHOOK_KEY) fail(401, 'Bad webhook key');
  const b = req.body || {};
  const data = {
    source: config.leadSources.includes(b.source) ? b.source : 'Website Form',
    parent_name: b.parent_name || b.full_name || b.name, phone: b.phone || b.phone_number, email: b.email,
    child_name: b.child_name, grade: b.grade, board: b.board, subjects: b.subjects, city: b.city,
    country: b.country, campaign: b.campaign || b.campaign_name, ad_set: b.ad_set || b.adset_name, utm: b.utm,
  };
  const dupe = leads.findDuplicate(data.phone, data.country === 'India' ? 'India' : 'UAE');
  if (dupe) { leads.reEnquiry(dupe, data); return { ok: true, duplicate: true, id: dupe.id, code: dupe.code }; }
  const lead = leads.createLead(data, null);
  return { ok: true, id: lead.id, code: lead.code };
}));

// ---------- Phone tracker (device-authenticated) & telephony ----------
r.post('/device/pair', wrap((req) => phone.pairDevice(req.body || {})));
r.get('/device/numbers', phone.deviceAuth, wrap((req) => phone.numberHashes(req.user)));
r.post('/device/events', phone.deviceAuth, wrap((req) => phone.ingest(req.user, req.body?.events, { deviceId: req.device.id })));
// Teacher post-class portal (token link, no login, no parent contact details).
r.get('/t/:token', wrap((req) => attendance.teacherPortal(req.params.token)));
r.post('/t/:token/classes/:id/confirm', wrap((req) => attendance.teacherConfirm(req.params.token, Number(req.params.id), req.body || {})));

r.post('/webhooks/telephony', wrap((req) => {
  if (!process.env.TELEPHONY_KEY || req.query.key !== process.env.TELEPHONY_KEY) fail(401, 'Bad telephony key');
  return phone.telephony(req.body || {});
}));

r.use(auth.authenticate);

r.post('/logout', wrap((req) => { q.run('DELETE FROM sessions WHERE token=?', req.token); return { ok: true }; }));
r.get('/me', wrap((req) => ({ user: auth.publicUser(req.user), perms: Object.keys(auth.PERMS).filter((p) => auth.can(req.user, p)),
  needs2faSetup: !!req.user.session_restricted, twofaRequired: auth.twofaRequired(req.user) })));
r.post('/2fa/setup', wrap((req) => auth.setup2fa(req.user)));
r.post('/2fa/enable', wrap((req) => auth.enable2fa(req.user, req.body.code)));
r.post('/users/:id/reset-2fa', P('users.manage'), wrap((req) => auth.reset2fa(Number(req.params.id))));
r.get('/meta', wrap(() => ({
  leadSources: config.leadSources, leadStages: config.leadStages, lostReasons: config.lostReasons, churnReasons: config.churnReasons,
  studentStages: config.studentStages, retentionStages: config.retentionStages, boards: config.boards, packages: config.packages,
  callOutcomes: Object.keys(config.callOutcomes), attendanceStatuses: Object.keys(config.attendancePolicy),
  attendancePolicy: config.attendancePolicy, roles: config.roles, exchangeRate: config.exchangeRate, maxBatchSize: config.maxBatchSize,
  objections: config.interaction.objections, sentiments: config.interaction.sentiments, minNoteChars: config.interaction.minConnectedNoteChars, google: google.enabled(),
  users: q.all('SELECT id, name, role, market, active FROM users ORDER BY name'),
  teachers: q.all("SELECT id, name, country, currency, subjects FROM teachers WHERE status='Active' ORDER BY name"),
})));

// ---------- Users (Owner) ----------
r.get('/users', P('users.manage'), wrap(() => q.all('SELECT id,name,email,role,market,active,phone,totp_enabled,created_at FROM users ORDER BY role,name')));
r.post('/users', P('users.manage'), wrap((req) => {
  const b = req.body;
  if (!b.name || !b.email || !b.password || !config.roles[b.role]) fail(400, 'Name, email, password and a valid role are required');
  const id = insert('users', { name: b.name, email: b.email.toLowerCase(), password_hash: auth.hashPassword(b.password), role: b.role, market: b.market || null, phone: b.phone || null, created_at: now() });
  return q.get('SELECT id,name,email,role,market,active FROM users WHERE id=?', id);
}));
r.patch('/users/:id', P('users.manage'), wrap((req) => {
  const b = req.body;
  const patch = pick(b, ['name', 'role', 'market', 'active', 'phone']);
  if (b.password) patch.password_hash = auth.hashPassword(b.password);
  update('users', Number(req.params.id), patch);
  return q.get('SELECT id,name,email,role,market,active FROM users WHERE id=?', req.params.id);
}));

// ---------- Leads ----------
function leadScope(req) {
  return auth.can(req.user, 'leads.view_all') ? { sql: '', p: [] } : { sql: ' AND l.owner_id=?', p: [req.user.id] };
}
function loadLead(req) {
  const l = leads.getLead(Number(req.params.id));
  if (!auth.can(req.user, 'leads.view_all') && l.owner_id !== req.user.id) fail(403, 'Not your lead');
  return l;
}

r.get('/leads', wrap((req) => {
  const s = leadScope(req);
  const w = []; const p = [];
  const { view, stage, source, owner, country, score, search } = req.query;
  const t = now();
  const dayEnd = addDays(t.slice(0, 10) + 'T00:00:00.000Z', 1);
  const open = "l.stage NOT IN ('Converted','Lost')";
  if (view === 'archived') { if (!auth.can(req.user, 'leads.reassign')) fail(403, 'Managers only'); w.push('l.archived=1'); } else w.push('l.archived=0');
  if (view === 'escalated') w.push(open, 'l.escalated=1');
  if (view === 'today') { w.push(open, 'l.next_follow_up_at >= ? AND l.next_follow_up_at < ?'); p.push(t.slice(0, 10) + 'T00:00:00.000Z', dayEnd); }
  if (view === 'overdue') { w.push(open, 'l.next_follow_up_at < ?'); p.push(t); }
  if (view === 'upcoming') { w.push(open, 'l.next_follow_up_at >= ? AND l.next_follow_up_at < ?'); p.push(t, addDays(t, 7)); }
  if (view === 'untouched') { w.push(open, "COALESCE(l.last_contacted_at, l.created_at) < ?"); p.push(addDays(t, -2)); }
  if (view === 'expiring') { w.push("l.stage NOT IN ('Converted','Lost','Nurture')", 'l.assigned_at <= ?'); p.push(addDays(t, -config.reassignment.warnDay)); }
  if (view === 'nurture') w.push("l.stage='Nurture'");
  if (view === 'open') w.push("l.stage NOT IN ('Converted','Lost','Nurture')");
  if (view === 'flagged') w.push('l.flagged=1');
  if (stage) { w.push('l.stage=?'); p.push(stage); }
  if (source) { w.push('l.source=?'); p.push(source); }
  if (owner) { w.push('l.owner_id=?'); p.push(Number(owner)); }
  if (country) { w.push('l.country=?'); p.push(country); }
  if (score) { w.push('l.score=?'); p.push(score); }
  if (search) { w.push('(l.parent_name LIKE ? OR l.child_name LIKE ? OR l.phone LIKE ? OR l.code LIKE ? OR l.email LIKE ?)'); p.push(...Array(5).fill(`%${search}%`)); }
  const where = w.length ? ` AND ${w.join(' AND ')}` : '';
  return q.all(`SELECT l.*, u.name owner_name FROM leads l LEFT JOIN users u ON u.id=l.owner_id
    WHERE 1=1 ${s.sql}${where} ORDER BY CASE WHEN l.next_follow_up_at IS NULL THEN 1 ELSE 0 END, l.next_follow_up_at, l.created_at DESC LIMIT 500`, ...s.p, ...p);
}));

r.get('/leads/counts', wrap((req) => {
  const s = leadScope(req);
  const t = now();
  const d0 = t.slice(0, 10) + 'T00:00:00.000Z';
  const open = "stage NOT IN ('Converted','Lost') AND archived=0";
  const c = (extra, ...p) => q.get(`SELECT COUNT(*) n FROM leads l WHERE ${open} ${s.sql} AND ${extra}`, ...s.p, ...p).n;
  return {
    today: c('next_follow_up_at >= ? AND next_follow_up_at < ?', d0, addDays(d0, 1)),
    overdue: c('next_follow_up_at < ?', t),
    upcoming: c('next_follow_up_at >= ? AND next_follow_up_at < ?', t, addDays(t, 7)),
    untouched: c('COALESCE(last_contacted_at, created_at) < ?', addDays(t, -2)),
    expiring: c("stage<>'Nurture' AND assigned_at <= ?", addDays(t, -config.reassignment.warnDay)),
    escalated: c('escalated=1'),
    missingNotes: q.get(`SELECT COUNT(*) n FROM activities a JOIN leads l ON l.id=a.entity_id WHERE a.entity='lead' AND a.needs_note=1 ${s.sql}`, ...s.p).n,
  };
}));

r.post('/leads', P('leads.edit'), wrap((req) => leads.createLead(req.body, req.user)));

r.get('/leads/:id', wrap((req) => {
  const l = loadLead(req);
  return {
    lead: { ...l, owner_name: q.get('SELECT name FROM users WHERE id=?', l.owner_id)?.name, notes_template: JSON.parse(l.notes_template || '{}') },
    activities: q.all(`SELECT a.*, u.name user_name FROM activities a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.entity='lead' AND a.entity_id=? ORDER BY a.created_at DESC, a.id DESC`, l.id),
    tasks: q.all("SELECT * FROM tasks WHERE entity='lead' AND entity_id=? ORDER BY status, due_at", l.id),
    followUps: q.all('SELECT * FROM follow_ups WHERE lead_id=? ORDER BY id DESC LIMIT 20', l.id),
    duplicates: q.all("SELECT id, code, parent_name, stage, archived, merged_into FROM leads WHERE phone_norm=? AND id<>?", l.phone_norm || '-', l.id),
    kyc: leads.getKyc(l.id),
    checklist: leads.conversionChecklist(l),
  };
}));

r.patch('/leads/:id', P('leads.edit'), wrap((req) => {
  const l = loadLead(req);
  if (l.stage === 'Converted') fail(400, 'Converted leads are locked');
  const patch = pick(req.body, ['parent_name', 'phone', 'is_whatsapp', 'email', 'city', 'child_name', 'grade', 'board', 'subjects',
    'score', 'campaign', 'ad_set', 'utm', 'referral_by', 'source']);
  if (req.body.country) { patch.country = req.body.country === 'India' ? 'India' : 'UAE'; patch.currency = config.currencyByCountry[patch.country]; }
  if (patch.phone || patch.country) {
    const country = patch.country || l.country;
    const dupe = leads.findDuplicate(patch.phone || l.phone, country, l.id);
    if (dupe) fail(409, `That number already belongs to ${dupe.code} (${dupe.parent_name}), owned by ${dupe.owner_name || 'nobody'}.`, { duplicate: dupe });
    patch.phone_norm = require('./util').normalizePhone(patch.phone || l.phone, country);
  }
  if (req.body.flagged === 0 || req.body.flagged === false) { patch.flagged = 0; patch.flag_reason = null; }
  patch.updated_at = now();
  update('leads', l.id, patch);
  log('lead', l.id, 'system', `Fields updated: ${Object.keys(patch).filter((k) => k !== 'updated_at').join(', ')}`, { userId: req.user.id });
  return leads.getLead(l.id);
}));

// Nothing is hard-deleted (blueprint 1.5 / 16.5): leads are archived with a reason.
r.post('/leads/:id/archive', P('leads.reassign'), wrap((req) => history.archiveLead(Number(req.params.id), req.body.reason, req.user)));
r.post('/leads/:id/restore', P('leads.reassign'), wrap((req) => history.restoreLead(Number(req.params.id), req.user)));
r.post('/leads/:id/merge', P('leads.reassign'), wrap((req) => leads.mergeLeads(Number(req.params.id), Number(req.body.into_id), req.user)));
r.post('/leads/:id/exempt', P('leads.reassign'), wrap((req) => leads.exemptLead(Number(req.params.id), req.body, req.user)));
r.post('/leads/import', P('leads.edit'), wrap((req) => leads.importLeads(req.body.rows, req.user, {
  default_source: config.leadSources.includes(req.body.default_source) ? req.body.default_source : 'Other',
  owner_id: auth.can(req.user, 'leads.reassign') ? req.body.owner_id : undefined,
})));
r.post('/leads/:id/interaction', P('leads.edit'), wrap((req) => { loadLead(req); return leads.logInteraction(Number(req.params.id), req.body, req.user); }));

r.post('/leads/:id/stage', P('leads.edit'), wrap((req) => { loadLead(req); return leads.changeStage(Number(req.params.id), req.body, req.user); }));
r.post('/leads/:id/call', P('leads.edit'), wrap((req) => { loadLead(req); return leads.logCall(Number(req.params.id), req.body, req.user); }));
r.post('/leads/:id/whatsapp', P('leads.edit'), wrap((req) => { loadLead(req); leads.logWhatsApp(Number(req.params.id), req.body, req.user); return { ok: true }; }));
r.post('/leads/:id/note', P('leads.edit'), wrap((req) => { loadLead(req); leads.addNote(Number(req.params.id), req.body.text, req.user); return { ok: true }; }));
r.put('/leads/:id/call-notes', P('leads.edit'), wrap((req) => { loadLead(req); leads.saveCallNotes(Number(req.params.id), req.body, req.user); return { ok: true }; }));
r.post('/leads/:id/follow-up', P('leads.edit'), wrap((req) => { loadLead(req); leads.setFollowUp(Number(req.params.id), req.body.at, req.body.type, req.user); return leads.getLead(Number(req.params.id)); }));
r.post('/leads/:id/reassign', P('leads.reassign'), wrap((req) => leads.reassign(Number(req.params.id), Number(req.body.owner_id), req.body.reason, req.user)));
r.put('/leads/:id/kyc', wrap((req) => {
  loadLead(req);
  if (!auth.can(req.user, 'leads.edit') && !auth.can(req.user, 'kyc.verify')) fail(403, 'Not allowed');
  return leads.saveKyc(Number(req.params.id), req.body, req.user);
}));
r.post('/leads/:id/kyc/verify', P('kyc.verify'), wrap((req) => leads.verifyKyc(Number(req.params.id), req.body, req.user)));
r.post('/leads/:id/convert', P('leads.edit'), wrap((req) => { loadLead(req); return leads.convert(Number(req.params.id), req.body, req.user); }));

// ---------- Conversation history: edits are versioned (blueprint 5.2 / 16.5) ----------
r.patch('/activities/:id', wrap((req) => history.editActivity(Number(req.params.id), req.body, req.user)));
r.get('/activities/:id/versions', wrap((req) => history.versions(Number(req.params.id))));
r.get('/edit-requests', P('leads.reassign'), wrap((req) => history.editRequests(req.query.status || 'Pending')));
r.post('/edit-requests/:id/:decision', P('leads.reassign'), wrap((req) => history.decideEdit(Number(req.params.id), req.params.decision === 'approve', req.user)));
r.get('/audit', P('audit.view'), wrap((req) => history.auditList(req.query)));

// ---------- Phone tracker devices (CRM side) ----------
r.get('/devices', wrap((req) => phone.devices(req.user, auth.can(req.user, 'leads.reassign') && req.query.all === '1')));
r.post('/devices/pairing', P('game.view'), wrap((req) => phone.createPairing(req.user, req.body.name)));
r.post('/devices/:id/revoke', wrap((req) => phone.revoke(Number(req.params.id), req.user, auth.can(req.user, 'leads.reassign'))));
r.get('/call-metrics', P('game.view'), wrap((req) => {
  const [a, b] = reports.range(req.query.period || 'week', req.query.from, req.query.to);
  const uid = req.user.role === 'sales_exec' ? req.user.id : req.query.rep ? Number(req.query.rep) : null;
  return { range: { from: a, to: b }, ...phone.callMetrics({ from: a, to: b, userId: uid, tz: req.user.market === 'India' ? 'Asia/Kolkata' : 'Asia/Dubai' }) };
}));

// ---------- Students ----------
function studentScope(req) {
  return req.user.role === 'sales_exec' ? { sql: ' AND s.retention_owner_id=?', p: [req.user.id] } : { sql: '', p: [] };
}
function loadStudent(req) {
  const s = students.getStudent(Number(req.params.id));
  if (req.user.role === 'sales_exec' && s.retention_owner_id !== req.user.id) fail(403, 'Not your student');
  return s;
}

r.get('/students', P('students.view'), wrap((req) => {
  const sc = studentScope(req);
  const w = []; const p = [];
  const { stage, retention, teacher, country, search, view } = req.query;
  if (stage) { w.push('s.stage=?'); p.push(stage); }
  if (retention) { w.push('s.retention_stage=?'); p.push(retention); }
  if (teacher) { w.push('s.teacher_id=?'); p.push(Number(teacher)); }
  if (country) { w.push('s.country=?'); p.push(country); }
  if (view === 'renewal') w.push("(s.stage='Hours Low' OR s.retention_stage IN ('Hours Low','Renewal Discussion','Payment Pending'))");
  if (view === 'unassigned') w.push("s.stage='Awaiting Teacher'");
  if (search) { w.push('(s.child_name LIKE ? OR s.parent_name LIKE ? OR s.code LIKE ?)'); p.push(...Array(3).fill(`%${search}%`)); }
  const where = w.length ? ` AND ${w.join(' AND ')}` : '';
  return q.all(`SELECT s.*, t.name teacher_name, u.name retention_owner_name, ao.name admin_owner_name, ROUND(s.total_hours - s.hours_used, 2) hours_remaining,
      (SELECT MAX(created_at) FROM activities a WHERE a.entity='student' AND a.entity_id=s.id AND a.user_id IS NOT NULL) last_action_at
    FROM students s LEFT JOIN teachers t ON t.id=s.teacher_id LEFT JOIN users u ON u.id=s.retention_owner_id LEFT JOIN users ao ON ao.id=s.admin_owner_id
    WHERE 1=1 ${sc.sql}${where} ORDER BY s.updated_at DESC LIMIT 500`, ...sc.p, ...p);
}));

r.get('/students/:id', P('students.view'), wrap((req) => {
  const s = loadStudent(req);
  const kyc = s.lead_id ? leads.getKyc(s.lead_id) : null;
  return {
    student: { ...s, hours_remaining: students.remaining(s), retention_owner_name: q.get('SELECT name FROM users WHERE id=?', s.retention_owner_id)?.name,
      admin_owner_name: q.get('SELECT name FROM users WHERE id=?', s.admin_owner_id)?.name },
    teacher: s.teacher_id ? q.get('SELECT id,name,country,currency,subjects,phone FROM teachers WHERE id=?', s.teacher_id) : null,
    classes: q.all('SELECT c.*, t.name teacher_name FROM classes c JOIN teachers t ON t.id=c.teacher_id WHERE c.student_id=? ORDER BY c.scheduled_at DESC', s.id),
    packages: q.all('SELECT * FROM packages WHERE student_id=? ORDER BY created_at DESC', s.id),
    payments: q.all('SELECT * FROM payments WHERE student_id=? ORDER BY created_at DESC', s.id),
    activities: q.all(`SELECT a.*, u.name user_name FROM activities a LEFT JOIN users u ON u.id=a.user_id
      WHERE (a.entity='student' AND a.entity_id=?) OR (a.entity='lead' AND a.entity_id=?) ORDER BY a.created_at DESC, a.id DESC`, s.id, s.lead_id || 0),
    tasks: q.all("SELECT * FROM tasks WHERE entity='student' AND entity_id=? ORDER BY status, due_at", s.id),
    kyc, blockers: students.activationBlockers(s),
  };
}));

r.patch('/students/:id', P('students.edit'), wrap((req) => {
  const s = loadStudent(req);
  update('students', s.id, { ...pick(req.body, ['child_name', 'grade', 'board', 'subjects', 'parent_name', 'email', 'city', 'timezone', 'meet_link']), updated_at: now() });
  if (req.body.meet_link) q.run("UPDATE classes SET meet_link=? WHERE student_id=? AND status='Scheduled'", req.body.meet_link, s.id);
  return students.getStudent(s.id);
}));
r.get('/students/:id/eligible-teachers', P('students.edit'), wrap((req) => students.eligibleTeachers(Number(req.params.id))));
r.post('/students/:id/assign-teacher', P('students.edit'), wrap((req) => students.assignTeacher(Number(req.params.id), req.body, req.user)));
r.post('/students/:id/schedule', P('students.edit'), wrap(async (req) => {
  const sid = Number(req.params.id);
  const out = students.schedule(sid, req.body, req.user);
  const s = students.getStudent(sid);
  // Jeta owns the Meet link: create a recurring Calendar event under the Jeta account when Google is set up.
  if (out.created && !s.meet_link && google.enabled()) {
    try {
      const first = q.get("SELECT * FROM classes WHERE student_id=? AND status='Scheduled' ORDER BY scheduled_at LIMIT 1", sid);
      const t = q.get('SELECT * FROM teachers WHERE id=?', s.teacher_id);
      const g = await google.createRecurringMeet({ title: `${s.child_name} · ${s.subjects} – Jeta Edu`, startIso: first.scheduled_at, durationHours: first.duration_hours,
        days: s.schedule_days.split(','), count: out.created, timezone: s.timezone, attendees: [t.email, s.email] });
      if (g?.meetLink) {
        update('students', sid, { meet_link: g.meetLink });
        q.run("UPDATE classes SET meet_link=? WHERE student_id=? AND status='Scheduled' AND meet_link IS NULL", g.meetLink, sid);
        out.meet_link = g.meetLink;
      }
    } catch (e) { out.meet_error = e.message; }
  }
  return out;
}));
r.post('/students/:id/classes', P('attendance.edit'), wrap((req) => students.addClass(Number(req.params.id), req.body, req.user)));
r.post('/students/:id/stage', P('students.edit'), wrap((req) => students.setStudentStage(Number(req.params.id), req.body.stage, req.user, req.body)));
r.post('/students/:id/retention-stage', P('retention.edit'), wrap((req) => { loadStudent(req); return students.setRetentionStage(Number(req.params.id), req.body, req.user); }));
r.post('/students/:id/retention-log', P('retention.edit'), wrap((req) => { loadStudent(req); return students.logRetention(Number(req.params.id), req.body, req.user); }));
r.post('/students/:id/renew', P('retention.edit'), wrap((req) => { loadStudent(req); return students.renew(Number(req.params.id), req.body, req.user); }));
r.post('/students/:id/note', wrap((req) => { loadStudent(req); if (!req.body.text) fail(400, 'Note is empty'); log('student', Number(req.params.id), 'note', req.body.text, { userId: req.user.id }); return { ok: true }; }));

// ---------- Classes / attendance ----------
r.get('/classes', P('students.view'), wrap((req) => {
  const w = []; const p = [];
  const { from, to, teacher, status, filter, student } = req.query;
  if (from) { w.push('c.scheduled_at >= ?'); p.push(new Date(from).toISOString()); }
  if (to) { w.push('c.scheduled_at < ?'); p.push(addDays(new Date(to).toISOString(), 1)); }
  if (teacher) { w.push('c.teacher_id=?'); p.push(Number(teacher)); }
  if (student) { w.push('c.student_id=?'); p.push(Number(student)); }
  if (status) { w.push('c.status=?'); p.push(status); }
  if (filter === 'unmarked') { w.push("c.status='Scheduled' AND c.scheduled_at < ?"); p.push(now()); }
  if (req.user.role === 'sales_exec') { w.push('s.retention_owner_id=?'); p.push(req.user.id); }
  const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
  return q.all(`SELECT c.*, s.child_name, s.code student_code, t.name teacher_name FROM classes c
    JOIN students s ON s.id=c.student_id JOIN teachers t ON t.id=c.teacher_id ${where} ORDER BY c.scheduled_at LIMIT 1000`, ...p);
}));
r.post('/classes/:id/attendance', P('attendance.edit'), wrap((req) => students.markAttendance(Number(req.params.id), req.body, req.user)));
r.get('/classes/review', P('attendance.edit'), wrap(() => attendance.reviewList()));
r.post('/classes/:id/review', P('attendance.edit'), wrap((req) => attendance.resolve(Number(req.params.id), req.body, req.user)));
r.post('/classes/meet-attendance', P('attendance.edit'), wrap((req) => attendance.importMeet(req.body.records, req.user)));
r.get('/classes/:id/ics', P('students.view'), (req, res) => {
  const c = q.get('SELECT * FROM classes WHERE id=?', req.params.id);
  if (!c) return res.status(404).send('Not found');
  res.type('text/calendar').attachment(`class-${c.id}.ics`).send(attendance.ics([c]));
});
r.get('/students/:id/schedule.ics', P('students.view'), (req, res) => {
  const rows = q.all("SELECT * FROM classes WHERE student_id=? AND status='Scheduled' AND scheduled_at>? ORDER BY scheduled_at", req.params.id, now());
  res.type('text/calendar').attachment(`schedule-${req.params.id}.ics`).send(attendance.ics(rows));
});
r.get('/teachers/:id/portal-link', P('teachers.edit'), wrap((req) => ({ path: `/t/${attendance.portalToken(Number(req.params.id))}` })));
r.post('/teachers/:id/portal-link/rotate', P('teachers.edit'), wrap((req) => {
  q.run('UPDATE teachers SET portal_token=NULL WHERE id=?', Number(req.params.id));
  return { path: `/t/${attendance.portalToken(Number(req.params.id))}` };
}));

// ---------- Teachers (parent contacts never exposed here: anti-poaching) ----------
r.get('/teachers/:id/rates', P('teachers.view'), wrap((req) => q.all('SELECT * FROM teacher_rates WHERE teacher_id=? ORDER BY id', Number(req.params.id))));
r.put('/teachers/:id/rates', P('teachers.edit'), wrap((req) => {
  const tid = Number(req.params.id);
  const rules = (Array.isArray(req.body.rates) ? req.body.rates : []).filter((x) => Number(x.rate) > 0);
  q.tx(() => {
    for (const old of q.all('SELECT id FROM teacher_rates WHERE teacher_id=?', tid)) {
      require('./db').writeAudit('delete', 'teacher_rates', old.id, null, 'replaced');
      q.run('DELETE FROM teacher_rates WHERE id=?', old.id);
    }
    for (const x of rules) insert('teacher_rates', { teacher_id: tid, subject: x.subject || null, grade: x.grade || null, batch_type: x.batch_type || null, rate: Number(x.rate) });
  });
  return q.all('SELECT * FROM teacher_rates WHERE teacher_id=? ORDER BY id', tid);
}));

r.get('/teachers', P('teachers.view'), wrap((req) => {
  const month = now().slice(0, 7);
  const [a, b] = finance.monthRange(month);
  return q.all(`SELECT t.*,
      (SELECT COUNT(*) FROM students s WHERE s.teacher_id=t.id AND s.stage NOT IN ('Completed','Churned')) active_students,
      (SELECT COALESCE(SUM(teacher_paid_hours),0) FROM classes c WHERE c.teacher_id=t.id AND c.scheduled_at>=? AND c.scheduled_at<?) month_hours
    FROM teachers t ORDER BY t.status, t.name`, a, b)
    .map((t) => (auth.can(req.user, 'payouts.view') ? { ...t, bank_details: require('./secure').dec(t.bank_details), portal_token: undefined }
      : { ...t, bank_details: undefined, rate_per_hour: undefined, portal_token: undefined }));
}));
r.post('/teachers', P('teachers.edit'), wrap((req) => {
  const b = req.body;
  if (!b.name || !['UAE', 'India'].includes(b.country)) fail(400, 'Name and country (UAE/India) are required');
  if (b.bank_details) b.bank_details = require('./secure').enc(b.bank_details);
  const id = insert('teachers', { ...pick(b, ['name', 'subjects', 'grades', 'boards', 'availability', 'bank_details', 'phone', 'email', 'status']),
    country: b.country, currency: config.currencyByCountry[b.country], rate_per_hour: Number(b.rate_per_hour) || 0,
    demo_rate: b.demo_rate ? Number(b.demo_rate) : null, created_at: now() });
  return { ...q.get('SELECT * FROM teachers WHERE id=?', id), bank_details: undefined, portal_token: undefined };
}));
r.patch('/teachers/:id', P('teachers.edit'), wrap((req) => {
  const b = req.body;
  const patch = pick(b, ['name', 'subjects', 'grades', 'boards', 'availability', 'bank_details', 'phone', 'email', 'status']);
  if (patch.bank_details) patch.bank_details = require('./secure').enc(patch.bank_details);
  if (b.rate_per_hour !== undefined) patch.rate_per_hour = Number(b.rate_per_hour);
  if (b.demo_rate !== undefined) patch.demo_rate = b.demo_rate === '' ? null : Number(b.demo_rate);
  if (b.country) { patch.country = b.country; patch.currency = config.currencyByCountry[b.country]; }
  update('teachers', Number(req.params.id), patch);
  return { ...q.get('SELECT * FROM teachers WHERE id=?', req.params.id), bank_details: undefined, portal_token: undefined };
}));

// ---------- Payments, invoices, expenses ----------
r.get('/payments', P('payments.edit'), wrap((req) => {
  const w = []; const p = [];
  if (req.query.status) { w.push('p.status=?'); p.push(req.query.status); }
  if (req.query.due) { w.push("p.status='Pending' AND p.due_date<=?"); p.push(addDays(now(), Number(req.query.due) || 0).slice(0, 10)); }
  if (req.query.verify) w.push("p.status IN ('Paid','Partial') AND p.verified_at IS NULL");
  if (req.user.role === 'sales_exec') { w.push('s.retention_owner_id=?'); p.push(req.user.id); }
  const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
  return q.all(`SELECT p.*, s.child_name, s.parent_name, s.code student_code, pk.kind package_kind, pk.hours package_hours, u.name collected_by_name
    FROM payments p LEFT JOIN students s ON s.id=p.student_id LEFT JOIN packages pk ON pk.id=p.package_id LEFT JOIN users u ON u.id=p.collected_by
    ${where} ORDER BY p.created_at DESC LIMIT 1000`, ...p);
}));
r.post('/payments', P('payments.edit'), wrap((req) => {
  const b = req.body;
  const s = students.getStudent(Number(b.student_id));
  if (!(Number(b.amount) > 0)) fail(400, 'Amount required');
  const paid = !!(b.method && b.reference);
  return finance.recordPayment({ student_id: s.id, package_id: b.package_id, amount: Number(b.amount), currency: s.currency,
    method: b.method, reference: b.reference, due_date: b.due_date, instalment_no: Number(b.instalment_no) || 1,
    status: paid ? 'Paid' : 'Pending' }, req.user);
}));
r.post('/payments/:id/pay', P('payments.edit'), wrap((req) => finance.markPaid(Number(req.params.id), req.body, req.user)));
r.post('/payments/:id/verify', P('payments.approve'), wrap((req) => finance.verifyPayment(Number(req.params.id), req.user)));
r.post('/payments/:id/refund/:action', wrap((req) => finance.refund(Number(req.params.id), req.params.action, req.body, req.user)));
r.get('/payments/:id/invoice', P('payments.edit'), (req, res) => {
  const p = q.get(`SELECT p.*, s.child_name, s.parent_name, s.email, s.phone, s.city, pk.hours, pk.subjects, pk.price, pk.kind
    FROM payments p LEFT JOIN students s ON s.id=p.student_id LEFT JOIN packages pk ON pk.id=p.package_id WHERE p.id=?`, req.params.id);
  if (!p) return res.status(404).send('Not found');
  res.type('html').send(require('./documents').invoice(p, `${req.protocol}://${req.get('host')}`));
});

r.get('/expenses', P('expenses.edit'), wrap((req) => q.all('SELECT * FROM expenses WHERE (? IS NULL OR month=?) ORDER BY month DESC, id DESC', req.query.month || null, req.query.month || null)));
r.post('/expenses', P('expenses.edit'), wrap((req) => q.get('SELECT * FROM expenses WHERE id=?', finance.addExpense(req.body))));

// ---------- Payouts ----------
const curPeriod = () => finance.periodNow(require('./services/settings').get('payouts').cycle);
r.get('/payouts', P('payouts.view'), wrap((req) => {
  const month = req.query.month || curPeriod();
  return q.all(`SELECT p.*, t.name teacher_name, t.country FROM payouts p JOIN teachers t ON t.id=p.teacher_id
    WHERE p.month=? ORDER BY t.country, t.name`, month).map((p) => ({ ...p, lines: JSON.parse(p.lines || '[]') }));
}));
r.get('/payouts/live', P('payouts.view'), wrap((req) => {
  const month = req.query.month || curPeriod();
  return q.all("SELECT * FROM teachers WHERE status='Active'").map((t) => ({ teacher_id: t.id, name: t.name, currency: t.currency, ...finance.buildPayout(t, month) }));
}));
r.post('/payouts/generate', P('payouts.adjust'), wrap((req) => finance.generatePayouts(req.body.month || curPeriod())));
r.post('/payouts/:id/adjust', P('payouts.adjust'), wrap((req) => finance.adjustPayout(Number(req.params.id), req.body, req.user)));
r.post('/payouts/:id/approve', P('payouts.approve'), wrap((req) => finance.approvePayout(Number(req.params.id), req.user)));
r.post('/payouts/:id/pay', P('payouts.approve'), wrap((req) => finance.payPayout(Number(req.params.id), req.body, req.user)));
r.post('/payouts/:id/unlock', P('payouts.unlock'), wrap((req) => finance.unlockPayout(Number(req.params.id), req.user)));
r.get('/payouts/reconcile', P('payouts.view'), wrap((req) => finance.reconcile(req.query.month || curPeriod())));
r.get('/payouts/:id/statement', P('payouts.view'), (req, res) => {
  const p = q.get('SELECT p.*, t.name teacher_name, t.country, t.bank_details FROM payouts p JOIN teachers t ON t.id=p.teacher_id WHERE p.id=?', req.params.id);
  if (!p) return res.status(404).send('Not found');
  res.type('html').send(require('./documents').statement({ ...p, lines: JSON.parse(p.lines || '[]') }));
});

// ---------- Tasks & notifications ----------
r.get('/tasks', wrap((req) => {
  const mine = req.query.scope !== 'all' || !auth.can(req.user, 'dashboard.team');
  const status = req.query.status || 'Open';
  return q.all(`SELECT * FROM tasks WHERE status=? ${mine ? 'AND (assignee_id=? OR assignee_role=?)' : ''} ORDER BY due_at LIMIT 500`,
    status, ...(mine ? [req.user.id, req.user.role] : []));
}));
r.post('/tasks', wrap((req) => {
  const b = req.body;
  if (!b.title) fail(400, 'Title required');
  const id = task({ title: b.title, type: b.type || 'call', entity: b.entity, entity_id: b.entity_id, assignee_id: b.assignee_id || req.user.id,
    due_at: b.due_at ? new Date(b.due_at).toISOString() : now(), priority: b.priority || 'Normal' });
  return q.get('SELECT * FROM tasks WHERE id=?', id);
}));
r.post('/tasks/:id/done', wrap((req) => { q.run("UPDATE tasks SET status='Done', done_at=? WHERE id=?", now(), req.params.id); return { ok: true }; }));

r.get('/notifications', wrap((req) => ({
  unread: q.get('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0', req.user.id).n,
  items: q.all('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50', req.user.id),
})));
r.post('/notifications/read', wrap((req) => { q.run('UPDATE notifications SET read=1 WHERE user_id=?', req.user.id); return { ok: true }; }));

// ---------- Dashboards & reports ----------
r.get('/dashboard', wrap((req) => reports.dashboard({ ...req.query, user: req.user })));
r.get('/reports/finance', P('reports.finance'), wrap((req) => reports.financeReport(req.query.month || now().slice(0, 7))));
r.get('/reports/team', P('dashboard.team'), wrap(() => q.all("SELECT id, name, market FROM users WHERE role IN ('sales_exec','sales_manager') AND active=1").map((u) => {
  const t = now();
  return {
    ...u,
    openLeads: q.get("SELECT COUNT(*) n FROM leads WHERE owner_id=? AND stage NOT IN ('Converted','Lost','Nurture')", u.id).n,
    overdue: leads.overdueCount(u.id),
    blocked: leads.overdueCount(u.id) > config.followUp.overdueBlockLimit,
    callsToday: q.get("SELECT COUNT(*) n FROM activities WHERE user_id=? AND type='call' AND created_at>=?", u.id, t.slice(0, 10)).n,
    convertedMonth: q.get("SELECT COUNT(*) n FROM packages WHERE sold_by=? AND kind='New' AND created_at>=?", u.id, t.slice(0, 7)).n,
  };
})));

// ---------- Sales leaderboard & gamification ----------
r.get('/game/leaderboard', P('game.view'), wrap((req) => game.leaderboard({ period: req.query.period, market: req.query.market || undefined })));
r.get('/game/me', P('game.view'), wrap((req) => game.me(req.user)));
r.get('/game/team-goal', P('game.view'), wrap(() => game.teamGoal()));
r.get('/game/feed', P('game.view'), wrap((req) => game.feed(req.user, Math.min(Number(req.query.limit) || 30, 50))));
r.post('/game/kudos', P('game.view'), wrap((req) => game.giveKudos(req.user, req.body)));
r.get('/game/settings', P('game.view'), wrap(() => game.settings()));
r.put('/game/settings', P('game.settings'), wrap((req) => game.saveSettings(req.body)));
r.get('/game/rules', P('game.view'), wrap(() => ({ points: config.game.points, maxCallsPerLeadPerDay: config.game.maxCallsPerLeadPerDay, badges: game.BADGES.map(([id, name, desc]) => ({ id, name, desc })) })));

// ---------- Accountability: scorecards, weekly review, coaching, escalations ----------
const acc = require('./services/accountability');
r.get('/scorecard', wrap((req) => {
  const uid = req.query.user && auth.can(req.user, 'review.view') && ['owner', 'sales_manager'].includes(req.user.role) ? Number(req.query.user) : req.user.id;
  return acc.scorecard(uid, req.query.period || 'week');
}));
r.get('/scorecards/team', P('audit.view'), wrap((req) => acc.teamScorecards(req.query.period || 'week')));
r.get('/review', P('audit.view'), wrap(() => acc.weeklyReview()));
r.post('/coaching/:id/held', P('audit.view'), wrap((req) => acc.logCoaching(Number(req.params.id), req.body.notes, req.user)));
r.post('/escalations/:id/resolve', P('leads.reassign'), wrap((req) => acc.resolveEscalation(Number(req.params.id), req.body.note, req.user)));

// ---------- Settings (company, invoice, VAT, assignment, payout cycle, targets) ----------
const settingsSvc = require('./services/settings');
r.get('/settings', wrap((req) => {
  const all = settingsSvc.all();
  return auth.can(req.user, 'settings.manage') ? all : { company: { name: all.company.name, vat_enabled: all.company.vat_enabled }, payouts: all.payouts, compliance: all.compliance };
}));
r.put('/settings/:key', wrap((req) => {
  const key = req.params.key;
  const allowed = auth.can(req.user, 'settings.manage') || (req.user.role === 'sales_manager' && key === 'assignment');
  if (!allowed) fail(403, 'Only the Owner can change settings');
  return settingsSvc.set(key, req.body || {});
}));

// CSV exports
r.get('/export/:what.csv', P('exports'), (req, res) => {
  const sql = {
    leads: 'SELECT code, created_at, source, campaign, parent_name, phone, email, city, child_name, grade, board, subjects, country, stage, score, lost_reason, attempt_count, reassignment_count FROM leads',
    students: 'SELECT code, child_name, parent_name, grade, board, subjects, country, stage, retention_stage, total_hours, hours_used FROM students',
    payments: 'SELECT invoice_no, student_id, amount, currency, method, reference, instalment_no, due_date, paid_at, status FROM payments',
    classes: 'SELECT id, student_id, teacher_id, subject, scheduled_at, duration_hours, status, topic, hours_deducted, teacher_paid_hours FROM classes',
  }[req.params.what];
  if (!sql) return res.status(404).send('Unknown export');
  const rows = q.all(sql);
  require('./db').writeAudit('export', req.params.what, null, null, `${rows.length} rows exported`);
  const cols = rows[0] ? Object.keys(rows[0]) : [];
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  res.type('text/csv').attachment(`${req.params.what}.csv`).send([cols.join(','), ...rows.map((r0) => cols.map((c) => esc(r0[c])).join(','))].join('\n'));
});

r.post('/automation/run', P('users.manage'), wrap(() => automation.runAll()));

module.exports = r;

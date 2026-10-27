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

const r = express.Router();
const P = auth.requirePerm;
const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    res.status(status).json({ error: e.message });
  }
};
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

// ---------- Public ----------
r.post('/login', wrap((req) => auth.login(req.body.email, req.body.password)));

// Lead capture webhook for website forms / Meta lead ads / Google Ads (set WEBHOOK_KEY).
r.post('/webhooks/lead', wrap((req) => {
  if (!process.env.WEBHOOK_KEY || req.query.key !== process.env.WEBHOOK_KEY) fail(401, 'Bad webhook key');
  const b = req.body || {};
  const lead = leads.createLead({
    source: config.leadSources.includes(b.source) ? b.source : 'Website Form',
    parent_name: b.parent_name || b.full_name || b.name, phone: b.phone || b.phone_number, email: b.email,
    child_name: b.child_name, grade: b.grade, board: b.board, subjects: b.subjects, city: b.city,
    country: b.country, campaign: b.campaign || b.campaign_name, ad_set: b.ad_set || b.adset_name, utm: b.utm,
  }, null);
  return { ok: true, id: lead.id, code: lead.code };
}));

r.use(auth.authenticate);

r.post('/logout', wrap((req) => { q.run('DELETE FROM sessions WHERE token=?', req.token); return { ok: true }; }));
r.get('/me', wrap((req) => ({ user: auth.publicUser(req.user), perms: Object.keys(auth.PERMS).filter((p) => auth.can(req.user, p)) })));
r.get('/meta', wrap(() => ({
  leadSources: config.leadSources, leadStages: config.leadStages, lostReasons: config.lostReasons, churnReasons: config.churnReasons,
  studentStages: config.studentStages, retentionStages: config.retentionStages, boards: config.boards, packages: config.packages,
  callOutcomes: Object.keys(config.callOutcomes), attendanceStatuses: Object.keys(config.attendancePolicy),
  attendancePolicy: config.attendancePolicy, roles: config.roles, exchangeRate: config.exchangeRate, maxBatchSize: config.maxBatchSize,
  users: q.all('SELECT id, name, role, market, active FROM users ORDER BY name'),
  teachers: q.all("SELECT id, name, country, currency, subjects FROM teachers WHERE status='Active' ORDER BY name"),
})));

// ---------- Users (Owner) ----------
r.get('/users', P('users.manage'), wrap(() => q.all('SELECT id,name,email,role,market,active,phone,created_at FROM users ORDER BY role,name')));
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
  const open = "stage NOT IN ('Converted','Lost')";
  const c = (extra, ...p) => q.get(`SELECT COUNT(*) n FROM leads l WHERE ${open} ${s.sql} AND ${extra}`, ...s.p, ...p).n;
  return {
    today: c('next_follow_up_at >= ? AND next_follow_up_at < ?', d0, addDays(d0, 1)),
    overdue: c('next_follow_up_at < ?', t),
    upcoming: c('next_follow_up_at >= ? AND next_follow_up_at < ?', t, addDays(t, 7)),
    untouched: c('COALESCE(last_contacted_at, created_at) < ?', addDays(t, -2)),
    expiring: c("stage<>'Nurture' AND assigned_at <= ?", addDays(t, -config.reassignment.warnDay)),
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
  if (req.body.flagged === 0 || req.body.flagged === false) { patch.flagged = 0; patch.flag_reason = null; }
  patch.updated_at = now();
  update('leads', l.id, patch);
  log('lead', l.id, 'system', `Fields updated: ${Object.keys(patch).filter((k) => k !== 'updated_at').join(', ')}`, { userId: req.user.id });
  return leads.getLead(l.id);
}));

r.delete('/leads/:id', P('leads.delete'), wrap((req) => {
  const l = loadLead(req);
  if (l.student_id) fail(400, 'Converted leads cannot be deleted');
  q.run('DELETE FROM leads WHERE id=?', l.id);
  return { ok: true };
}));

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
  return q.all(`SELECT s.*, t.name teacher_name, u.name retention_owner_name, ROUND(s.total_hours - s.hours_used, 2) hours_remaining
    FROM students s LEFT JOIN teachers t ON t.id=s.teacher_id LEFT JOIN users u ON u.id=s.retention_owner_id
    WHERE 1=1 ${sc.sql}${where} ORDER BY s.updated_at DESC LIMIT 500`, ...sc.p, ...p);
}));

r.get('/students/:id', P('students.view'), wrap((req) => {
  const s = loadStudent(req);
  const kyc = s.lead_id ? leads.getKyc(s.lead_id) : null;
  return {
    student: { ...s, hours_remaining: students.remaining(s), retention_owner_name: q.get('SELECT name FROM users WHERE id=?', s.retention_owner_id)?.name },
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
  update('students', s.id, { ...pick(req.body, ['child_name', 'grade', 'board', 'subjects', 'parent_name', 'email', 'city', 'timezone']), updated_at: now() });
  return students.getStudent(s.id);
}));
r.get('/students/:id/eligible-teachers', P('students.edit'), wrap((req) => students.eligibleTeachers(Number(req.params.id))));
r.post('/students/:id/assign-teacher', P('students.edit'), wrap((req) => students.assignTeacher(Number(req.params.id), req.body, req.user)));
r.post('/students/:id/schedule', P('students.edit'), wrap((req) => students.schedule(Number(req.params.id), req.body, req.user)));
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

// ---------- Teachers (parent contacts never exposed here: anti-poaching) ----------
r.get('/teachers', P('teachers.view'), wrap((req) => {
  const month = now().slice(0, 7);
  const [a, b] = finance.monthRange(month);
  return q.all(`SELECT t.*,
      (SELECT COUNT(*) FROM students s WHERE s.teacher_id=t.id AND s.stage NOT IN ('Completed','Churned')) active_students,
      (SELECT COALESCE(SUM(teacher_paid_hours),0) FROM classes c WHERE c.teacher_id=t.id AND c.scheduled_at>=? AND c.scheduled_at<?) month_hours
    FROM teachers t ORDER BY t.status, t.name`, a, b)
    .map((t) => (auth.can(req.user, 'payouts.view') ? t : { ...t, bank_details: undefined, rate_per_hour: undefined }));
}));
r.post('/teachers', P('teachers.edit'), wrap((req) => {
  const b = req.body;
  if (!b.name || !['UAE', 'India'].includes(b.country)) fail(400, 'Name and country (UAE/India) are required');
  const id = insert('teachers', { ...pick(b, ['name', 'subjects', 'grades', 'boards', 'availability', 'bank_details', 'phone', 'email', 'status']),
    country: b.country, currency: config.currencyByCountry[b.country], rate_per_hour: Number(b.rate_per_hour) || 0,
    demo_rate: b.demo_rate ? Number(b.demo_rate) : null, created_at: now() });
  return q.get('SELECT * FROM teachers WHERE id=?', id);
}));
r.patch('/teachers/:id', P('teachers.edit'), wrap((req) => {
  const b = req.body;
  const patch = pick(b, ['name', 'subjects', 'grades', 'boards', 'availability', 'bank_details', 'phone', 'email', 'status']);
  if (b.rate_per_hour !== undefined) patch.rate_per_hour = Number(b.rate_per_hour);
  if (b.demo_rate !== undefined) patch.demo_rate = b.demo_rate === '' ? null : Number(b.demo_rate);
  if (b.country) { patch.country = b.country; patch.currency = config.currencyByCountry[b.country]; }
  update('teachers', Number(req.params.id), patch);
  return q.get('SELECT * FROM teachers WHERE id=?', req.params.id);
}));

// ---------- Payments, invoices, expenses ----------
r.get('/payments', P('payments.edit'), wrap((req) => {
  const w = []; const p = [];
  if (req.query.status) { w.push('p.status=?'); p.push(req.query.status); }
  if (req.query.due) { w.push("p.status='Pending' AND p.due_date<=?"); p.push(addDays(now(), Number(req.query.due) || 0).slice(0, 10)); }
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
r.post('/payments/:id/refund/:action', wrap((req) => finance.refund(Number(req.params.id), req.params.action, req.body, req.user)));
r.get('/payments/:id/invoice', P('payments.edit'), (req, res) => {
  const p = q.get(`SELECT p.*, s.child_name, s.parent_name, s.email, s.phone, s.city, pk.hours, pk.subjects, pk.price, pk.kind
    FROM payments p LEFT JOIN students s ON s.id=p.student_id LEFT JOIN packages pk ON pk.id=p.package_id WHERE p.id=?`, req.params.id);
  if (!p) return res.status(404).send('Not found');
  res.type('html').send(require('./documents').invoice(p));
});

r.get('/expenses', P('expenses.edit'), wrap((req) => q.all('SELECT * FROM expenses WHERE (? IS NULL OR month=?) ORDER BY month DESC, id DESC', req.query.month || null, req.query.month || null)));
r.post('/expenses', P('expenses.edit'), wrap((req) => q.get('SELECT * FROM expenses WHERE id=?', finance.addExpense(req.body))));

// ---------- Payouts ----------
r.get('/payouts', P('payouts.view'), wrap((req) => {
  const month = req.query.month || now().slice(0, 7);
  return q.all(`SELECT p.*, t.name teacher_name, t.country FROM payouts p JOIN teachers t ON t.id=p.teacher_id
    WHERE p.month=? ORDER BY t.country, t.name`, month).map((p) => ({ ...p, lines: JSON.parse(p.lines || '[]') }));
}));
r.get('/payouts/live', P('payouts.view'), wrap((req) => {
  const month = req.query.month || now().slice(0, 7);
  return q.all("SELECT * FROM teachers WHERE status='Active'").map((t) => ({ teacher_id: t.id, name: t.name, currency: t.currency, ...finance.buildPayout(t, month) }));
}));
r.post('/payouts/generate', P('payouts.adjust'), wrap((req) => finance.generatePayouts(req.body.month || now().slice(0, 7))));
r.post('/payouts/:id/adjust', P('payouts.adjust'), wrap((req) => finance.adjustPayout(Number(req.params.id), req.body, req.user)));
r.post('/payouts/:id/approve', P('payouts.approve'), wrap((req) => finance.approvePayout(Number(req.params.id), req.user)));
r.post('/payouts/:id/pay', P('payouts.approve'), wrap((req) => finance.payPayout(Number(req.params.id), req.body, req.user)));
r.post('/payouts/:id/unlock', P('payouts.unlock'), wrap((req) => finance.unlockPayout(Number(req.params.id), req.user)));
r.get('/payouts/reconcile', P('payouts.view'), wrap((req) => finance.reconcile(req.query.month || now().slice(0, 7))));
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

// CSV exports
r.get('/export/:what.csv', P('dashboard.team'), (req, res) => {
  const sql = {
    leads: 'SELECT code, created_at, source, campaign, parent_name, phone, email, city, child_name, grade, board, subjects, country, stage, score, lost_reason, attempt_count, reassignment_count FROM leads',
    students: 'SELECT code, child_name, parent_name, grade, board, subjects, country, stage, retention_stage, total_hours, hours_used FROM students',
    payments: 'SELECT invoice_no, student_id, amount, currency, method, reference, instalment_no, due_date, paid_at, status FROM payments',
    classes: 'SELECT id, student_id, teacher_id, subject, scheduled_at, duration_hours, status, topic, hours_deducted, teacher_paid_hours FROM classes',
  }[req.params.what];
  if (!sql) return res.status(404).send('Unknown export');
  const rows = q.all(sql);
  const cols = rows[0] ? Object.keys(rows[0]) : [];
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  res.type('text/csv').attachment(`${req.params.what}.csv`).send([cols.join(','), ...rows.map((r0) => cols.map((c) => esc(r0[c])).join(','))].join('\n'));
});

r.post('/automation/run', P('users.manage'), wrap(() => automation.runAll()));

module.exports = r;

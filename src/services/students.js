// Student module (Admin-owned): teacher assignment, scheduling, attendance, hours tracking,
// plus the Sales-owned retention pipeline.
const config = require('../config');
const { q, insert, update } = require('../db');
const { now, addMinutes, addDays, daysBetween, monthOf, fail, log, task } = require('../util');
const { notify, sendExternal } = require('../notify');

const getStudent = (id) => q.get('SELECT * FROM students WHERE id=?', id) || fail(404, 'Student not found');
const remaining = (s) => Math.max(0, +(s.total_hours - s.hours_used).toFixed(2));
const csv = (v) => String(v || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

function setStage(s, stage, user, why = '') {
  if (s.stage === stage) return;
  update('students', s.id, { stage, updated_at: now() });
  log('student', s.id, 'stage', `${s.stage} → ${stage}${why ? ` (${why})` : ''}`, { userId: user?.id });
  s.stage = stage;
}

// Teachers filtered by subject, board, grade, country, status and batch capacity.
function eligibleTeachers(studentId) {
  const s = getStudent(studentId);
  const subj = csv(s.subjects);
  return q.all("SELECT * FROM teachers WHERE status='Active' ORDER BY name").map((t) => {
    const load = q.get(`SELECT COUNT(*) n FROM students WHERE teacher_id=? AND stage NOT IN ('Completed','Churned')`, t.id).n;
    const matchSubject = !subj.length || subj.some((x) => csv(t.subjects).includes(x));
    const matchBoard = !s.board || !t.boards || csv(t.boards).includes(String(s.board).toLowerCase());
    const matchGrade = !s.grade || !t.grades || csv(t.grades).includes(String(s.grade).toLowerCase());
    const matchCountry = !s.country || t.country === s.country;
    return { ...t, bank_details: undefined, active_students: load, match: matchSubject && matchBoard && matchGrade,
      matchSubject, matchBoard, matchGrade, matchCountry };
  }).sort((a, b) => (b.match - a.match) || (b.matchCountry - a.matchCountry) || (a.active_students - b.active_students));
}

function assignTeacher(studentId, body, user) {
  const s = getStudent(studentId);
  const t = q.get("SELECT * FROM teachers WHERE id=? AND status='Active'", body.teacher_id) || fail(400, 'Choose an active teacher');
  const batchType = body.batch_type === 'Batch' ? 'Batch' : '1:1';
  let batchName = null;
  if (batchType === 'Batch') {
    batchName = body.batch_name || fail(400, 'Batch name is required for batch classes');
    const size = q.get(`SELECT COUNT(*) n FROM students WHERE teacher_id=? AND batch_name=? AND id<>? AND stage NOT IN ('Completed','Churned')`, t.id, batchName, s.id).n;
    if (size >= config.maxBatchSize) fail(400, `Batch "${batchName}" is full (max ${config.maxBatchSize})`);
  }
  update('students', s.id, { teacher_id: t.id, batch_type: batchType, batch_name: batchName,
    start_date: body.start_date || now().slice(0, 10), updated_at: now() });
  log('student', s.id, 'system', `Teacher assigned: ${t.name} (${batchType}${batchName ? ` – ${batchName}` : ''})`, { userId: user.id });
  q.run("UPDATE tasks SET status='Done', done_at=? WHERE entity='student' AND entity_id=? AND type='assign_teacher' AND status='Open'", now(), s.id);
  if (['Awaiting Teacher', 'Teacher Assigned'].includes(s.stage)) setStage(s, 'Teacher Assigned', user);
  if (s.retention_owner_id) notify({ userId: s.retention_owner_id, title: 'Teacher assigned', body: `${s.child_name} → ${t.name}`, link: `#/students/${s.id}` });
  return getStudent(s.id);
}

function hasClash(teacherId, startIso, hours, ignoreId = 0) {
  const start = new Date(startIso).getTime();
  const end = start + hours * 3600000;
  const rows = q.all(`SELECT id, scheduled_at, duration_hours, student_id FROM classes
    WHERE teacher_id=? AND id<>? AND status IN ('Scheduled','Completed') AND scheduled_at BETWEEN ? AND ?`,
  teacherId, ignoreId, new Date(start - 86400000).toISOString(), new Date(end + 86400000).toISOString());
  return rows.find((c) => {
    const cs = new Date(c.scheduled_at).getTime();
    const ce = cs + c.duration_hours * 3600000;
    return cs < end && start < ce;
  });
}

// Build recurring class slots. days: ['Mon','Wed'], time 'HH:MM' local to timezone offset.
const TZ_OFFSET = { 'Asia/Dubai': 4 * 60, 'Asia/Kolkata': 5.5 * 60 };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function schedule(studentId, body, user) {
  const s = getStudent(studentId);
  if (!s.teacher_id) fail(400, 'Assign a teacher first');
  const days = (Array.isArray(body.days) ? body.days : csv(body.days)).map((d) => d.slice(0, 3).toLowerCase());
  if (!days.length || !/^\d{2}:\d{2}$/.test(body.time || '')) fail(400, 'Pick days and a time (HH:MM)');
  const tz = body.timezone || s.timezone || 'Asia/Dubai';
  const offset = TZ_OFFSET[tz] ?? 240;
  const duration = Number(body.duration_hours) || 1;
  const weeks = Math.min(Number(body.weeks) || 4, 12);
  const [hh, mm] = body.time.split(':').map(Number);
  const start = new Date(body.start_date || s.start_date || now().slice(0, 10));

  // Never schedule beyond remaining hours.
  let budget = remaining(s) - q.get("SELECT COALESCE(SUM(duration_hours),0) h FROM classes WHERE student_id=? AND status='Scheduled'", s.id).h;
  const created = [];
  const clashes = [];
  for (let i = 0; i < weeks * 7 && budget >= duration; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + i));
    if (!days.includes(DOW[d.getUTCDay()].toLowerCase())) continue;
    const at = new Date(d.getTime() + (hh * 60 + mm - offset) * 60000).toISOString();
    if (at < now()) continue;
    const clash = hasClash(s.teacher_id, at, duration);
    if (clash) { clashes.push(at); continue; }
    created.push(insert('classes', { student_id: s.id, teacher_id: s.teacher_id, subject: body.subject || s.subjects,
      scheduled_at: at, duration_hours: duration, status: 'Scheduled', created_at: now() }));
    budget -= duration;
  }
  update('students', s.id, { schedule_days: days.join(','), schedule_time: body.time, timezone: tz, updated_at: now() });
  log('student', s.id, 'system', `Schedule set: ${days.join(', ')} at ${body.time} (${tz}), ${created.length} classes created${clashes.length ? `, ${clashes.length} skipped (teacher clash)` : ''}`, { userId: user.id });
  if (['Teacher Assigned', 'Awaiting Teacher'].includes(s.stage) && created.length) setStage(s, 'Scheduled', user);
  const t = q.get('SELECT * FROM teachers WHERE id=?', s.teacher_id);
  sendExternal('whatsapp', s.phone, `Classes for ${s.child_name} with ${t.name}: ${days.join(', ')} at ${body.time} (${tz}).`);
  sendExternal('whatsapp', t.phone, `New schedule: ${s.child_name}, ${days.join(', ')} at ${body.time} (${tz}).`);
  return { created: created.length, clashes };
}

function addClass(studentId, body, user) {
  const s = getStudent(studentId);
  const teacherId = Number(body.teacher_id) || s.teacher_id || fail(400, 'Assign a teacher first');
  if (!body.scheduled_at) fail(400, 'Date & time required');
  const at = new Date(body.scheduled_at).toISOString();
  const hrs = Number(body.duration_hours) || 1;
  if (hasClash(teacherId, at, hrs)) fail(409, 'Duplicate class: teacher already has a class at that time');
  const id = insert('classes', { student_id: s.id, teacher_id: teacherId, subject: body.subject || s.subjects, scheduled_at: at,
    duration_hours: hrs, status: 'Scheduled', is_demo: body.is_demo ? 1 : 0, created_at: now() });
  log('student', s.id, 'class', `Class added for ${at}${body.is_demo ? ' (demo)' : ''}`, { userId: user.id });
  return q.get('SELECT * FROM classes WHERE id=?', id);
}

function payoutLocked(teacherId, iso) {
  return !!q.get('SELECT 1 FROM payouts WHERE teacher_id=? AND month=? AND locked=1', teacherId, monthOf(iso));
}

// Section 10.4 – attendance drives hours and teacher pay.
function markAttendance(classId, body, user) {
  const c = q.get('SELECT * FROM classes WHERE id=?', classId) || fail(404, 'Class not found');
  const policy = config.attendancePolicy[body.status] || fail(400, 'Invalid attendance status');
  if (payoutLocked(c.teacher_id, c.scheduled_at) && user.role !== 'owner') fail(423, 'Payout month is locked – Owner approval needed');
  if (body.status === 'Rescheduled' && !body.reschedule_to) fail(400, 'Reschedule needs a new date & time');
  if (['Rescheduled', 'Student Absent (notice given)', 'Teacher Absent'].includes(body.status) && !body.remarks && !body.reschedule_reason) fail(400, 'Reason is required');
  const s = getStudent(c.student_id);

  return q.tx(() => {
    // Reverse previous effect if re-marking
    if (c.hours_deducted) update('students', s.id, { hours_used: Math.max(0, s.hours_used - c.hours_deducted) });
    const fresh = getStudent(s.id);
    const deduct = policy.deductHours ? c.duration_hours : 0;
    const pay = policy.payTeacher ? c.duration_hours : 0;
    update('classes', c.id, { status: body.status, topic: body.topic, remarks: body.remarks,
      reschedule_reason: body.reschedule_reason, hours_deducted: deduct, teacher_paid_hours: pay, marked_by: user.id, marked_at: now() });
    if (deduct) update('students', s.id, { hours_used: +(fresh.hours_used + deduct).toFixed(2), updated_at: now() });
    log('student', s.id, 'class', `${c.scheduled_at.slice(0, 16).replace('T', ' ')} – ${body.status}${body.topic ? `: ${body.topic}` : ''}`, {
      userId: user.id, meta: { class_id: c.id, deducted: deduct, teacher_paid: pay } });

    if (body.status === 'Rescheduled' || (!policy.deductHours && body.reschedule_to)) {
      const at = new Date(body.reschedule_to).toISOString();
      if (hasClash(c.teacher_id, at, c.duration_hours, c.id)) fail(409, 'Teacher already has a class at the new time');
      insert('classes', { student_id: c.student_id, teacher_id: c.teacher_id, subject: c.subject, scheduled_at: at,
        duration_hours: c.duration_hours, status: 'Scheduled', is_demo: c.is_demo, reschedule_reason: body.reschedule_reason || body.remarks, created_at: now() });
      log('student', s.id, 'class', `Rescheduled to ${at} – ${body.reschedule_reason || body.remarks}`, { userId: user.id });
    }
    if (body.status === 'Completed') tryActivate(s.id, user);
    checkHours(s.id);
    return q.get('SELECT * FROM classes WHERE id=?', c.id);
  });
}

// Gate: Active only when KYC verified AND a payment received.
function activationBlockers(s) {
  const kyc = s.lead_id ? q.get('SELECT status FROM kyc WHERE lead_id=?', s.lead_id) : null;
  const paid = q.get("SELECT COUNT(*) n FROM payments WHERE student_id=? AND status IN ('Paid','Partial')", s.id).n;
  const blockers = [];
  if (kyc?.status !== 'Verified') blockers.push('KYC not verified');
  if (!paid) blockers.push('No payment received');
  if (!s.teacher_id) blockers.push('No teacher assigned');
  return blockers;
}

function tryActivate(studentId, user) {
  const s = getStudent(studentId);
  if (!['Scheduled', 'Teacher Assigned', 'Renewed'].includes(s.stage)) return false;
  const b = activationBlockers(s);
  if (b.length) return false;
  const anyClass = q.get("SELECT 1 FROM classes WHERE student_id=? AND status='Completed'", s.id);
  if (!anyClass && s.stage !== 'Renewed') return false;
  setStage(s, 'Active', user, 'KYC verified + paid + first class');
  return true;
}

function setStudentStage(studentId, stage, user, body = {}) {
  const s = getStudent(studentId);
  if (!config.studentStages.includes(stage)) fail(400, 'Unknown stage');
  if (stage === 'Active') {
    const b = activationBlockers(s);
    if (b.length) fail(400, `Cannot activate: ${b.join(', ')}`);
  }
  if (stage === 'Churned') return churn(studentId, body.reason, user);
  setStage(s, stage, user, body.reason);
  return getStudent(studentId);
}

// Section 10.5 – 25% / 10% (or 2h) / 0 alerts to Admin and Sales.
function checkHours(studentId) {
  const s = getStudent(studentId);
  if (!s.total_hours || ['Churned', 'Completed'].includes(s.stage)) return;
  const left = remaining(s);
  const pct = left / s.total_hours;
  let level = 0;
  if (left <= 0) level = 3;
  else if (pct <= config.hoursAlerts.urgentPct || left <= config.hoursAlerts.urgentHours) level = 2;
  else if (pct <= config.hoursAlerts.lowPct) level = 1;
  if (level <= s.hours_alert_level) return;
  update('students', s.id, { hours_alert_level: level });
  const link = `#/students/${s.id}`;
  const label = ['', 'Renewal conversation due (25% hours left)', `URGENT: only ${left} hrs left`, '0 hours – classes on hold, renewal needed'][level];
  notify({ role: 'admin', title: label, body: s.child_name, link, dedupe: `hrs${level}:${s.id}:${s.total_hours}` });
  if (s.retention_owner_id) notify({ userId: s.retention_owner_id, title: label, body: `${s.child_name} – ${s.parent_name}`, link, channels: ['app', 'whatsapp'], dedupe: `hrs${level}r:${s.id}:${s.total_hours}` });
  if (level >= 1 && !['Hours Low'].includes(s.stage)) {
    if (['Active', 'Scheduled', 'Renewed'].includes(s.stage)) setStage(s, 'Hours Low', null, `${left} hrs left`);
    if (!s.retention_stage || ['Renewed', 'Churned'].includes(s.retention_stage)) {
      update('students', s.id, { retention_stage: 'Hours Low' });
    }
    task({ entity: 'student', entity_id: s.id, title: `Renewal call – ${s.parent_name} (${left} hrs left)`, type: 'retention',
      assignee_id: s.retention_owner_id, due_at: addDays(now(), level >= 2 ? 0 : 2), priority: level >= 2 ? 'High' : 'Normal' });
  }
  if (level === 3) {
    q.run("UPDATE classes SET status='Cancelled', remarks='On hold – 0 hours' WHERE student_id=? AND status='Scheduled'", s.id);
    log('student', s.id, 'system', 'Hours exhausted – future classes put on hold');
  }
}

// ---------- Retention ----------
function setRetentionStage(studentId, body, user) {
  const s = getStudent(studentId);
  const stage = body.stage;
  if (!config.retentionStages.includes(stage)) fail(400, 'Unknown retention stage');
  if (stage === 'Churned') return churn(studentId, body.reason, user);
  if (stage === 'Renewed') fail(400, 'Use Renew to record the new package');
  update('students', s.id, { retention_stage: stage, updated_at: now() });
  log('student', s.id, 'stage', `Retention: ${s.retention_stage || '—'} → ${stage}`, { userId: user.id });
  return getStudent(s.id);
}

function logRetention(studentId, body, user) {
  const s = getStudent(studentId);
  if (!body.outcome) fail(400, 'Outcome is required');
  log('student', s.id, body.channel === 'whatsapp' ? 'whatsapp' : 'call', body.notes || '', {
    userId: user.id, outcome: body.outcome, meta: { feedback: body.feedback, issue: body.issue } });
  if (body.issue) {
    task({ entity: 'student', entity_id: s.id, title: `Ticket: ${body.issue} – ${s.child_name}`, type: 'ticket',
      assignee_role: 'admin', due_at: addDays(now(), 1), priority: 'High' });
    notify({ role: 'admin', title: `Retention issue: ${body.issue}`, body: `${s.child_name}: ${body.notes || ''}`, link: `#/students/${s.id}` });
  }
  if (body.follow_up_at) task({ entity: 'student', entity_id: s.id, title: `Retention follow-up – ${s.parent_name}`,
    type: 'retention', assignee_id: s.retention_owner_id || user.id, due_at: new Date(body.follow_up_at).toISOString() });
  q.run("UPDATE tasks SET status='Done', done_at=? WHERE entity='student' AND entity_id=? AND type IN ('checkin') AND status='Open' AND due_at<=?", now(), s.id, now());
  return getStudent(s.id);
}

function renew(studentId, body, user) {
  const s = getStudent(studentId);
  const hours = Number(body.hours);
  const price = Number(body.price);
  if (!(hours > 0 && price > 0)) fail(400, 'Package hours and price are required');
  const finance = require('./finance');
  return q.tx(() => {
    const pkg = insert('packages', { student_id: s.id, subjects: body.subjects || s.subjects, hours, price, currency: s.currency,
      kind: 'Renewal', sold_by: s.retention_owner_id || user.id, source: 'Renewal', created_at: now() });
    if (body.payment && Number(body.payment.amount) > 0) {
      finance.recordPayment({ student_id: s.id, package_id: pkg, amount: Number(body.payment.amount), currency: s.currency,
        method: body.payment.method, reference: body.payment.reference, paid_at: now(),
        status: Number(body.payment.amount) >= price ? 'Paid' : 'Partial' }, user);
    } else {
      finance.recordPayment({ student_id: s.id, package_id: pkg, amount: price, currency: s.currency,
        due_date: body.due_date || now().slice(0, 10), status: 'Pending' }, user);
    }
    const left = remaining(s);
    update('students', s.id, { total_hours: +(s.hours_used + left + hours).toFixed(2), hours_alert_level: 0,
      retention_stage: body.payment ? 'Renewed' : 'Payment Pending', subjects: body.subjects || s.subjects, updated_at: now() });
    log('student', s.id, 'payment', `Renewal: ${hours} hrs for ${s.currency} ${price}`, { userId: user.id });
    setStage(getStudent(s.id), body.payment ? 'Active' : 'Renewed', user, 'renewal');
    q.run("UPDATE tasks SET status='Done', done_at=? WHERE entity='student' AND entity_id=? AND type='retention' AND status='Open'", now(), s.id);
    return getStudent(s.id);
  });
}

function churn(studentId, reason, user) {
  const s = getStudent(studentId);
  if (!config.churnReasons.includes(reason)) fail(400, 'Churn reason is mandatory');
  update('students', s.id, { stage: 'Churned', retention_stage: 'Churned', churn_reason: reason, updated_at: now() });
  q.run("UPDATE classes SET status='Cancelled', remarks='Student churned' WHERE student_id=? AND status='Scheduled'", s.id);
  log('student', s.id, 'stage', `${s.stage} → Churned (${reason})`, { userId: user?.id });
  return getStudent(s.id);
}

// ---------- Scheduled checks ----------
function runStudentRules() {
  const t = now();
  let n = 0;
  // Class reminders 24h and 1h before
  for (const c of q.all(`SELECT c.*, s.phone sphone, s.child_name, t.phone tphone, t.name tname FROM classes c
      JOIN students s ON s.id=c.student_id JOIN teachers t ON t.id=c.teacher_id
      WHERE c.status='Scheduled' AND c.scheduled_at > ? AND c.scheduled_at <= ?`, t, addMinutes(t, 24 * 60 + 5))) {
    const mins = (new Date(c.scheduled_at) - new Date(t)) / 60000;
    for (const [win, label] of [[24 * 60, '24h'], [60, '1h']]) {
      const key = `cls${label}:${c.id}`;
      if (mins <= win && !q.get('SELECT 1 FROM settings WHERE key=?', key)) {
        q.run('INSERT INTO settings(key,value) VALUES(?,?)', key, t);
        sendExternal('whatsapp', c.sphone, `Reminder: ${c.child_name}'s class with ${c.tname} in ${label}.`);
        sendExternal('whatsapp', c.tphone, `Reminder: class with ${c.child_name} in ${label}.`);
        n++;
      }
    }
  }
  // Unmarked attendance older than 48h
  const cutoff = addMinutes(t, -config.sla.unmarkedAttendanceHours * 60);
  const unmarked = q.get("SELECT COUNT(*) n FROM classes WHERE status='Scheduled' AND scheduled_at < ?", cutoff).n;
  if (unmarked) n += notify({ role: 'admin', title: `${unmarked} classes with unmarked attendance (>48h)`, body: 'Mark attendance to keep hours and payouts correct', link: '#/classes?filter=unmarked', dedupe: `unmarked:${t.slice(0, 10)}` });
  // Teacher-assignment SLA
  for (const s of q.all("SELECT * FROM students WHERE stage='Awaiting Teacher'")) {
    if (daysBetween(s.joined_at, t) * 24 > config.sla.assignTeacherHours) {
      n += notify({ role: 'admin', title: 'Teacher assignment overdue (24h SLA)', body: s.child_name, link: `#/students/${s.id}`, dedupe: `assign:${s.id}` });
      n += notify({ role: 'owner', title: 'Teacher assignment overdue', body: s.child_name, link: `#/students/${s.id}`, dedupe: `assignO:${s.id}` });
    }
  }
  return n;
}

module.exports = {
  getStudent, remaining, eligibleTeachers, assignTeacher, schedule, addClass, markAttendance, hasClash,
  activationBlockers, tryActivate, setStudentStage, checkHours, setRetentionStage, logRetention, renew, churn, runStudentRules,
};

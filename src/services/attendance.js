// Attendance without manual typing (blueprint 11.4):
//  1) Jeta-owned Meet links on every class (Google Calendar integration, or a link the admin pastes).
//  2) Meet attendance (Reports API or CSV import) marks the class with the 80% rule.
//  3) Fallback / confirmation: teacher's one-tap post-class form (no parent contact details shown).
//  4) Admin works only a "Needs review" list: mismatches > 10 min, unmarked > 48 h, duplicates, random 10% audits.
const crypto = require('crypto');
const config = require('../config');
const { q, update } = require('../db');
const { now, addMinutes, fail, log } = require('../util');
const { notify, sendExternal } = require('../notify');
const google = require('../integrations/google');

const SYSTEM = { id: null, role: 'system', name: 'Attendance automation' };
const getClass = (id) => q.get('SELECT * FROM classes WHERE id=?', id) || fail(404, 'Class not found');

function portalToken(teacherId) {
  const t = q.get('SELECT portal_token FROM teachers WHERE id=?', teacherId);
  if (t?.portal_token) return t.portal_token;
  const token = crypto.randomBytes(24).toString('base64url');
  q.run('UPDATE teachers SET portal_token=? WHERE id=?', token, teacherId);
  return token;
}
const portalUrl = (teacherId) => `${process.env.PUBLIC_URL || ''}/t/${portalToken(teacherId)}`;

function flag(c, reason) {
  q.run('UPDATE classes SET review_flag=?, review_flagged_at=COALESCE(review_flagged_at, ?), review_resolved_at=NULL WHERE id=?', reason, now(), c.id);
}

// ---------- teacher portal (public, token-based) ----------
function teacherByToken(token) {
  const t = q.get("SELECT id, name, country, currency FROM teachers WHERE portal_token=? AND status='Active'", String(token || ''));
  if (!t) fail(404, 'This link is not valid any more – ask Jeta admin for a new one');
  return t;
}

function teacherPortal(token) {
  const t = teacherByToken(token);
  const from = addMinutes(now(), -7 * 1440);
  const to = addMinutes(now(), 2 * 1440);
  // Child first name, grade and subject only – never the parent's phone or email (anti-poaching).
  const classes = q.all(`SELECT c.id, c.scheduled_at, c.duration_hours, c.subject, c.status, c.meet_link, c.teacher_confirmed_at, c.topic, c.is_demo,
      s.child_name, s.grade, s.board, s.timezone FROM classes c JOIN students s ON s.id=c.student_id
    WHERE c.teacher_id=? AND c.scheduled_at>=? AND c.scheduled_at<? AND c.status NOT IN ('Cancelled','Rescheduled') ORDER BY c.scheduled_at`, t.id, from, to)
    .map((c) => ({ ...c, child_name: String(c.child_name || '').split(' ')[0], needs_confirmation: !c.teacher_confirmed_at && new Date(c.scheduled_at) < new Date() }));
  return { teacher: { name: t.name }, classes };
}

function teacherConfirm(token, classId, body) {
  const t = teacherByToken(token);
  const c = getClass(classId);
  if (c.teacher_id !== t.id) fail(403, 'This class is not yours');
  if (new Date(c.scheduled_at) > new Date()) fail(400, 'You can confirm a class after it starts');
  if (c.teacher_confirmed_at) fail(400, 'Already confirmed – contact admin to change it');
  const held = body.held !== false && body.held !== 'no';
  const attended = body.student_attended !== false && body.student_attended !== 'no';
  let mins = null;
  if (held) {
    if (!body.start_time || !body.end_time) fail(400, 'Start and end time are required');
    const day = c.scheduled_at.slice(0, 10);
    const tzOff = { 'Asia/Kolkata': 330, 'Asia/Dubai': 240 }[q.get('SELECT timezone FROM students WHERE id=?', c.student_id)?.timezone] ?? 240;
    const toIso = (hm) => { const [h, m] = String(hm).split(':').map(Number); return new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), h, m) - tzOff * 60000); };
    mins = Math.round((toIso(body.end_time) - toIso(body.start_time)) / 60000);
    if (!(mins > 0 && mins <= 300)) fail(400, 'Check the start and end time');
    if (!body.topic) fail(400, 'Topic covered is required');
  }
  q.run('UPDATE classes SET teacher_confirmed_at=?, teacher_reported_hours=?, topic=COALESCE(?, topic), proof_link=? WHERE id=?',
    now(), mins !== null ? +(mins / 60).toFixed(2) : 0, body.topic || null, body.proof_link || null, c.id);
  log('student', c.student_id, 'class', `Teacher ${t.name} confirmed class ${c.scheduled_at.slice(0, 16).replace('T', ' ')}: ${held ? `${mins} min, ${attended ? 'student attended' : 'student absent'}${body.topic ? ` – ${body.topic}` : ''}` : 'NOT held'}`);
  evaluate(getClass(c.id), { teacherForm: { held, attended, minutes: mins } });
  return { ok: true };
}

// ---------- marking rules ----------
// Uses Meet minutes when available; otherwise the teacher's form.
function evaluate(c, { teacherForm } = {}) {
  if (c.status !== 'Scheduled') return; // already marked – changes go through admin review
  const students = require('./students');
  const slot = c.duration_hours * 60;
  const M = config.meet;
  const hasMeet = c.teacher_minutes !== null && c.teacher_minutes !== undefined;
  const form = teacherForm || (c.teacher_confirmed_at ? { held: c.teacher_reported_hours > 0, attended: true, minutes: Math.round((c.teacher_reported_hours || 0) * 60) } : null);

  if (hasMeet) {
    const teacherOk = c.teacher_minutes >= slot * M.presentPct;
    const studentOk = (c.student_minutes || 0) >= slot * M.presentPct;
    if (!teacherOk) {
      students.markAttendance(c.id, { status: 'Teacher Absent', remarks: `Meet: teacher ${Math.round(c.teacher_minutes)} of ${slot} min` }, SYSTEM);
      flag(c, 'Teacher absent (Meet) – reschedule the class');
      return;
    }
    if (!studentOk) { flag(c, `Student attended ${Math.round(c.student_minutes || 0)} of ${slot} min – apply the no-show policy`); return; }
    students.markAttendance(c.id, { status: 'Completed', topic: c.topic, remarks: `Meet: teacher ${Math.round(c.teacher_minutes)}m, student ${Math.round(c.student_minutes)}m` }, SYSTEM);
    q.run("UPDATE classes SET attendance_source='meet' WHERE id=?", c.id);
    if (form?.minutes && Math.abs(form.minutes - c.teacher_minutes) > M.mismatchMinutes) flag(c, `Teacher reported ${form.minutes} min, Meet shows ${Math.round(c.teacher_minutes)} min`);
    return;
  }
  if (!form) return;
  if (!form.held) {
    students.markAttendance(c.id, { status: 'Teacher Absent', remarks: 'Teacher reported the class was not held' }, SYSTEM);
    flag(c, 'Teacher reported not held – reschedule the class');
    return;
  }
  if (!form.attended) { flag(c, 'Teacher reported student absent – apply the no-show policy'); return; }
  students.markAttendance(c.id, { status: 'Completed', topic: c.topic, remarks: `Teacher form: ${form.minutes} min` }, SYSTEM);
  q.run("UPDATE classes SET attendance_source='teacher_form' WHERE id=?", c.id);
  const fresh = getClass(c.id);
  if (Math.abs(form.minutes - slot) > M.mismatchMinutes) flag(fresh, `Reported ${form.minutes} min for a ${slot}-min slot`);
  else if (!fresh.proof_link) flag(fresh, 'No proof link on the teacher form');
  else if (Math.random() < M.auditPct) { q.run('UPDATE classes SET audit_pick=1 WHERE id=?', c.id); flag(fresh, 'Random 10% audit – check the proof'); }
}

// Meet attendance rows: [{ class_id, email, minutes }] or [{ meet_code|meet_link, date, email, minutes }].
function importMeet(records, user) {
  if (!Array.isArray(records) || !records.length) fail(400, 'No attendance rows');
  const byClass = {};
  const unmatched = [];
  for (const r of records) {
    let cid = Number(r.class_id) || null;
    if (!cid) {
      const code = google.meetingCodeFrom(r.meet_link || `meet.google.com/${r.meet_code || ''}`);
      if (code && r.date) {
        const day = new Date(r.date).toISOString().slice(0, 10);
        cid = q.get("SELECT c.id FROM classes c WHERE replace(lower(c.meet_link),'-','') LIKE ? AND substr(c.scheduled_at,1,10)=? ORDER BY c.scheduled_at LIMIT 1",
          `%${code.replace(/-/g, '').toLowerCase()}%`, day)?.id;
      }
    }
    if (!cid) { unmatched.push(r); continue; }
    (byClass[cid] ||= []).push({ email: String(r.email || r.participant || '').toLowerCase(), minutes: parseMinutes(r.minutes ?? r.duration) });
  }
  let marked = 0;
  for (const [cid, rows] of Object.entries(byClass)) {
    if (applyParticipants(Number(cid), rows)) marked++;
  }
  log('system', 0, 'system', `Meet attendance imported by ${user?.name || 'system'}: ${Object.keys(byClass).length} classes`, { userId: user?.id });
  return { classes: Object.keys(byClass).length, marked, unmatched: unmatched.length };
}
const parseMinutes = (v) => {
  if (typeof v === 'number') return v;
  const s = String(v || '').trim();
  if (/^\d+:\d{2}(:\d{2})?$/.test(s)) { const p = s.split(':').map(Number); return p.length === 3 ? p[0] * 60 + p[1] + p[2] / 60 : p[0] + p[1] / 60; }
  const m = s.match(/(\d+)\s*h/); const mm = s.match(/(\d+)\s*m/);
  if (m || mm) return (m ? +m[1] * 60 : 0) + (mm ? +mm[1] : 0);
  return Number(s) || 0;
};

function applyParticipants(classId, rows) {
  const c = getClass(classId);
  const teacher = q.get('SELECT email FROM teachers WHERE id=?', c.teacher_id);
  const tEmail = String(teacher?.email || '').toLowerCase();
  let tMin = 0; let sMin = 0;
  for (const r of rows) {
    if (tEmail && r.email === tEmail) tMin += r.minutes; else sMin = Math.max(sMin, r.minutes);
  }
  if (!tEmail) { flag(c, 'Teacher has no email on file – cannot match Meet attendance'); return false; }
  q.run("UPDATE classes SET teacher_minutes=?, student_minutes=?, attendance_source='meet' WHERE id=?", tMin, sMin, c.id);
  evaluate(getClass(c.id));
  return true;
}

// Automation: pull Meet attendance for classes that ended recently (only when Google is configured).
async function pullMeet() {
  if (!google.enabled()) return 0;
  const cutoff = addMinutes(now(), -config.meet.pullAfterMinutes);
  const rows = q.all(`SELECT * FROM classes WHERE status='Scheduled' AND meet_link IS NOT NULL AND teacher_minutes IS NULL
    AND scheduled_at < ? AND scheduled_at > ?`, cutoff, addMinutes(now(), -3 * 1440));
  let n = 0;
  for (const c of rows) {
    const end = new Date(new Date(c.scheduled_at).getTime() + c.duration_hours * 3600000);
    if (end.toISOString() > cutoff) continue;
    const code = google.meetingCodeFrom(c.meet_link);
    if (!code) continue;
    try {
      const parts = await google.meetAttendance({ meetingCode: code, from: addMinutes(c.scheduled_at, -30), to: addMinutes(end.toISOString(), 60) });
      if (parts && parts.length) { applyParticipants(c.id, parts); n++; }
    } catch (e) { console.error('[meet]', e.message); }
  }
  return n;
}

// ---------- Needs review ----------
function reviewList() {
  const t = now();
  const flagged = q.all(`SELECT c.*, s.child_name, t.name teacher_name FROM classes c JOIN students s ON s.id=c.student_id JOIN teachers t ON t.id=c.teacher_id
    WHERE c.review_flag IS NOT NULL AND c.review_resolved_at IS NULL ORDER BY c.scheduled_at DESC LIMIT 300`);
  const unmarked = q.all(`SELECT c.*, s.child_name, t.name teacher_name FROM classes c JOIN students s ON s.id=c.student_id JOIN teachers t ON t.id=c.teacher_id
    WHERE c.status='Scheduled' AND c.scheduled_at < ? AND c.review_flag IS NULL ORDER BY c.scheduled_at LIMIT 300`, addMinutes(t, -config.sla.unmarkedAttendanceHours * 60))
    .map((c) => ({ ...c, review_flag: 'Unmarked for 48+ hours' }));
  const dupes = q.all(`SELECT a.*, s.child_name, t.name teacher_name FROM classes a JOIN classes b ON a.teacher_id=b.teacher_id AND a.id<b.id
      AND a.status IN ('Scheduled','Completed') AND b.status IN ('Scheduled','Completed')
      AND a.scheduled_at < strftime('%Y-%m-%dT%H:%M:%fZ', b.scheduled_at, '+' || CAST(b.duration_hours*60 AS INTEGER) || ' minutes')
      AND b.scheduled_at < strftime('%Y-%m-%dT%H:%M:%fZ', a.scheduled_at, '+' || CAST(a.duration_hours*60 AS INTEGER) || ' minutes')
    JOIN students s ON s.id=a.student_id JOIN teachers t ON t.id=a.teacher_id WHERE a.scheduled_at > ? LIMIT 100`, addMinutes(t, -30 * 1440))
    .map((c) => ({ ...c, review_flag: 'Possible duplicate class (teacher overlap)' }));
  return [...flagged, ...dupes, ...unmarked];
}

function resolve(classId, body, user) {
  const c = getClass(classId);
  if (body.status && body.status !== c.status) {
    require('./students').markAttendance(c.id, { status: body.status, topic: body.topic || c.topic, remarks: body.remarks || `Reviewed by ${user.name}`,
      reschedule_to: body.reschedule_to, reschedule_reason: body.reschedule_reason || body.remarks }, user);
  }
  q.run('UPDATE classes SET review_resolved_at=?, review_resolved_by=? WHERE id=?', now(), user.id, c.id);
  log('student', c.student_id, 'class', `Attendance review: ${c.review_flag || 'checked'} → ${body.status || c.status}${body.remarks ? ` (${body.remarks})` : ''}`, { userId: user.id });
  return getClass(c.id);
}

// ---------- calendar file (fallback invites without Google) ----------
function ics(classes, title) {
  const fmt = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Jeta Edu//CRM//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const c of classes) {
    const end = new Date(new Date(c.scheduled_at).getTime() + c.duration_hours * 3600000).toISOString();
    lines.push('BEGIN:VEVENT', `UID:class-${c.id}@jeta-crm`, `DTSTAMP:${fmt(now())}`, `DTSTART:${fmt(c.scheduled_at)}`, `DTEND:${fmt(end)}`,
      `SUMMARY:${(title || `${c.subject || 'Class'} – Jeta Edu`).replace(/[,;]/g, ' ')}`, c.meet_link ? `LOCATION:${c.meet_link}` : 'LOCATION:Online',
      c.meet_link ? `DESCRIPTION:Join: ${c.meet_link}` : 'DESCRIPTION:Jeta Edu class',
      'BEGIN:VALARM', 'TRIGGER:-PT60M', 'ACTION:DISPLAY', 'DESCRIPTION:Class in 1 hour', 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

module.exports = { portalToken, portalUrl, teacherPortal, teacherConfirm, evaluate, importMeet, applyParticipants, pullMeet, reviewList, resolve, ics, parseMinutes };

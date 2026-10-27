// Tests for the "Complete CRM System Blueprint" additions: accountability, duplicates, tracker, Meet, invoices, security.
const test = require('node:test');
const assert = require('node:assert');
const { open, setDb, q, insert } = require('../src/db');

setDb(open(':memory:'));
require('../src/context').run({ noAudit: true }, () => require('../src/seed').seed());

const L = require('../src/services/leads');
const S = require('../src/services/students');
const F = require('../src/services/finance');
const H = require('../src/services/history');
const PH = require('../src/services/phone');
const AT = require('../src/services/attendance');
const ACC = require('../src/services/accountability');
const settings = require('../src/services/settings');
const auth = require('../src/auth');
const secure = require('../src/secure');
const { addDays, addMinutes, now, normalizePhone } = require('../src/util');

const owner = q.get("SELECT * FROM users WHERE role='owner'");
const admin = q.get("SELECT * FROM users WHERE role='admin'");
const manager = q.get("SELECT * FROM users WHERE role='sales_manager'");
const throwsMsg = (fn, re) => assert.throws(fn, (e) => re.test(e.message));
let n = 0;
const phone = () => `+97155${String(1000000 + (n++) * 37).padStart(7, '0')}`;
const mk = (over = {}) => L.createLead({ source: 'Meta Ads', parent_name: 'Parent', phone: phone(), country: 'UAE', child_name: 'Kid', subjects: 'Maths', ...over }, owner);

test('phone is the unique key: same number in another format is refused and reported', () => {
  const l = mk({ phone: '+971 55 900 1122' });
  assert.equal(normalizePhone('055 900 1122', 'UAE'), '971559001122');
  assert.throws(() => mk({ phone: '00971559001122' }), (e) => e.status === 409 && e.extra.duplicate.id === l.id);
  const r = L.importLeads([{ parent_name: 'A', phone: '0559001122' }, { parent_name: 'B', phone: '+971559998877' }, { parent_name: 'C', phone: '+971559998877' }, { name: '', phone: '' }], owner, { default_source: 'Website Form' });
  assert.equal(r.created, 1);
  assert.equal(r.duplicates.length, 2); // existing lead + repeat inside the file
  assert.equal(r.errors.length, 1);
});

test('merge moves history and archives the other lead; nothing is deleted', () => {
  const a = mk(); const b = mk();
  L.addNote(a.id, 'Note on A', owner);
  const kept = L.mergeLeads(a.id, b.id, manager);
  assert.equal(kept.id, b.id);
  assert.equal(L.getLead(a.id).archived, 1);
  assert.equal(L.getLead(a.id).merged_into, b.id);
  assert.ok(q.get("SELECT 1 FROM activities WHERE entity='lead' AND entity_id=? AND body='Note on A'", b.id));
  H.archiveLead(kept.id, 'Test archive', manager);
  assert.ok(q.get('SELECT 1 FROM leads WHERE id=?', kept.id), 'archived lead still exists');
});

test('connected call needs a 2-line note; a stage change is audited with old and new values', () => {
  const l = mk();
  const rep = q.get('SELECT * FROM users WHERE id=?', l.owner_id);
  throwsMsg(() => L.logCall(l.id, { outcome: 'Connected - Interested', notes: 'ok', follow_up_at: addDays(now(), 1) }, rep), /2 lines/);
  require('../src/context').run({ userId: rep.id }, () => L.logCall(l.id, { outcome: 'Connected - Interested', notes: 'Line one\nLine two', sentiment: 'Positive', objections: ['Price'], follow_up_at: addDays(now(), 1) }, rep));
  const a = q.get("SELECT * FROM activities WHERE entity='lead' AND entity_id=? AND type='call' ORDER BY id DESC", l.id);
  assert.deepEqual(JSON.parse(a.meta).objections, ['Price']);
  const audit = q.get("SELECT * FROM audit_log WHERE entity='leads' AND entity_id=? AND action='update' ORDER BY id DESC", l.id);
  assert.ok(audit && JSON.parse(audit.changes).stage, 'stage change recorded');
  assert.equal(audit.user_id, rep.id);
});

test('note edits: author within 24h applies with a version; older edits need manager approval', () => {
  const l = mk();
  const rep = q.get('SELECT * FROM users WHERE id=?', l.owner_id);
  L.addNote(l.id, 'First version', rep);
  const a = q.get("SELECT * FROM activities WHERE entity='lead' AND entity_id=? AND type='note' ORDER BY id DESC", l.id);
  assert.equal(H.editActivity(a.id, { body: 'Second version' }, rep).applied, true);
  assert.equal(H.versions(a.id)[0].body, 'First version');
  q.run('UPDATE activities SET created_at=? WHERE id=?', addDays(now(), -2), a.id);
  throwsMsg(() => H.editActivity(a.id, { body: 'Third' }, rep), /reason/);
  const r = H.editActivity(a.id, { body: 'Third', reason: 'typo' }, rep);
  assert.equal(r.pending, true);
  assert.equal(q.get('SELECT body FROM activities WHERE id=?', a.id).body, 'Second version');
  H.decideEdit(r.request_id, true, manager);
  assert.equal(q.get('SELECT body FROM activities WHERE id=?', a.id).body, 'Third');
  assert.equal(H.versions(a.id).length, 2);
});

test('phone tracker: personal calls ignored, duplicates skipped, connected call waits for notes and is completed once', () => {
  const l = mk();
  const rep = q.get('SELECT * FROM users WHERE id=?', l.owner_id);
  const code = PH.createPairing(rep).code;
  const dev = PH.pairDevice({ code });
  assert.ok(PH.numberHashes(rep).hashes.includes(PH.sha(l.phone_norm)));
  const ev = { event_id: 'x1', number: l.phone, direction: 'outgoing', started_at: now(), duration_sec: 95 };
  const r = PH.ingest(rep, [ev, { ...ev }, { event_id: 'x2', number: '+971500000001', direction: 'outgoing', started_at: now(), duration_sec: 30 }], { deviceId: dev.device_id });
  assert.deepEqual([r.stored, r.duplicates, r.ignored], [1, 1, 1]);
  const pending = q.get("SELECT * FROM activities WHERE entity='lead' AND entity_id=? AND needs_note=1", l.id);
  assert.ok(pending);
  const before = q.get("SELECT COUNT(*) n FROM activities WHERE entity='lead' AND entity_id=? AND type='call'", l.id).n;
  L.logCall(l.id, { activity_id: pending.id, outcome: 'Connected - Interested', notes: 'Talked about maths\nDemo on Friday', follow_up_at: addDays(now(), 1) }, rep);
  assert.equal(q.get("SELECT COUNT(*) n FROM activities WHERE entity='lead' AND entity_id=? AND type='call'", l.id).n, before);
  assert.equal(q.get('SELECT needs_note FROM activities WHERE id=?', pending.id).needs_note, 0);
  const missed = PH.ingest(rep, [{ event_id: 'x3', number: l.phone, direction: 'missed', started_at: now(), duration_sec: 0 }], { deviceId: dev.device_id });
  assert.equal(missed.stored, 1);
  assert.ok(q.get("SELECT 1 FROM tasks WHERE entity='lead' AND entity_id=? AND title LIKE '%missed call%'", l.id));
});

test('Meet attendance: 80% rule marks Completed; teacher absent is not paid and flagged', () => {
  const st = q.get('SELECT * FROM students WHERE teacher_id IS NOT NULL LIMIT 1');
  const t = q.get('SELECT * FROM teachers WHERE id=?', st.teacher_id);
  const c1 = S.addClass(st.id, { scheduled_at: addDays(now(), -20 - Math.random()), duration_hours: 1 }, admin);
  const c2 = S.addClass(st.id, { scheduled_at: addDays(now(), -22 - Math.random()), duration_hours: 1 }, admin);
  AT.importMeet([{ class_id: c1.id, email: t.email, minutes: 58 }, { class_id: c1.id, email: 'kid@example.com', minutes: '0:55:00' },
    { class_id: c2.id, email: t.email, minutes: 10 }, { class_id: c2.id, email: 'kid@example.com', minutes: 59 }], admin);
  assert.equal(q.get('SELECT status FROM classes WHERE id=?', c1.id).status, 'Completed');
  const two = q.get('SELECT * FROM classes WHERE id=?', c2.id);
  assert.equal(two.status, 'Teacher Absent');
  assert.equal(two.teacher_paid_hours, 0);
  assert.ok(two.review_flag);
  assert.ok(AT.reviewList().some((x) => x.id === c2.id));
});

test('teacher form never exposes parent contacts and flags time mismatches', () => {
  const st = q.get('SELECT * FROM students WHERE teacher_id IS NOT NULL LIMIT 1');
  const c = S.addClass(st.id, { scheduled_at: addDays(now(), -25 - Math.random()), duration_hours: 1 }, admin);
  const token = AT.portalToken(st.teacher_id);
  const portal = JSON.stringify(AT.teacherPortal(token));
  assert.ok(!portal.includes(st.phone) && !portal.includes(st.parent_name));
  AT.teacherConfirm(token, c.id, { held: 'yes', student_attended: 'yes', start_time: '10:00', end_time: '10:30', topic: 'Fractions', proof_link: 'https://x' });
  const after = q.get('SELECT * FROM classes WHERE id=?', c.id);
  assert.equal(after.status, 'Completed');
  assert.match(after.review_flag, /30 min/);
});

test('invoices: JETA-year-0001 numbering and VAT shown inside the price', () => {
  assert.match(F.nextInvoiceNo(), new RegExp(`^JETA-${new Date().getUTCFullYear()}-\\d{4}$`));
  settings.set('company', { vat_enabled: true, vat_rate: 5 });
  assert.equal(F.vatOf(1050), 50);
  settings.set('company', { vat_enabled: false });
});

test('teacher rates by subject / grade / batch, and fortnightly payout periods', () => {
  const t = q.get('SELECT * FROM teachers LIMIT 1');
  const rules = [{ subject: 'Maths', grade: null, batch_type: null, rate: 70 }, { subject: 'Maths', grade: '12', batch_type: '1:1', rate: 90 }];
  assert.equal(F.rateFor(t, { subject: 'Maths', grade: '12', batch_type: '1:1' }, rules), 90);
  assert.equal(F.rateFor(t, { subject: 'Maths', grade: '9' }, rules), 70);
  assert.equal(F.rateFor(t, { subject: 'English' }, rules), t.rate_per_hour);
  const [a, b] = F.monthRange('2026-10-H1');
  assert.equal(a.slice(0, 10), '2026-10-01'); assert.equal(b.slice(0, 10), '2026-10-16');
  assert.deepEqual(F.periodsOf('2026-10-20T10:00:00.000Z'), ['2026-10', '2026-10-H2']);
});

test('security: 2FA login, encrypted bank details, scorecards for every role', () => {
  const acc = q.get("SELECT * FROM users WHERE role='accounts'");
  const { secret } = auth.setup2fa(acc);
  auth.enable2fa(acc, secure.totp(secret));
  const step1 = auth.login(acc.email, 'jeta1234');
  assert.equal(step1.twofa, true);
  throwsMsg(() => auth.login2fa(step1.ticket, '000000'), /not right/);
  assert.ok(auth.login2fa(step1.ticket, secure.totp(secret)).token);
  secure.encryptExisting(q);
  const raw = q.get('SELECT bank_details FROM teachers LIMIT 1').bank_details;
  assert.ok(raw.startsWith('enc:v1:'));
  assert.equal(secure.dec(raw), 'Bank: ****1234');
  for (const r of ['sales_exec', 'admin', 'accounts', 'sales_manager']) {
    const u = q.get('SELECT id FROM users WHERE role=? LIMIT 1', r);
    assert.ok(ACC.scorecard(u.id, 'week').metrics.length >= 4);
  }
  assert.ok(ACC.weeklyReview().overdue);
});

test('48h overdue follow-up escalates once and is resolved by the next interaction', () => {
  const l = mk();
  const rep = q.get('SELECT * FROM users WHERE id=?', l.owner_id);
  L.setFollowUp(l.id, addMinutes(now(), -49 * 60), 'call', rep);
  L.runFollowUpReminders();
  assert.equal(L.getLead(l.id).escalated, 1);
  assert.ok(q.get("SELECT 1 FROM escalations WHERE entity='lead' AND entity_id=? AND status='Open'", l.id));
  L.logCall(l.id, { outcome: 'Not answered' }, rep);
  assert.equal(L.getLead(l.id).escalated, 0);
  assert.ok(q.get("SELECT 1 FROM escalations WHERE entity='lead' AND entity_id=? AND status='Resolved'", l.id));
});

// Business-rule tests against an in-memory database.  Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { open, setDb, q, update } = require('../src/db');

setDb(open(':memory:'));
require('../src/seed').seed();

const L = require('../src/services/leads');
const S = require('../src/services/students');
const F = require('../src/services/finance');
const { addDays, now } = require('../src/util');

const owner = q.get("SELECT * FROM users WHERE role='owner'");
const admin = q.get("SELECT * FROM users WHERE role='admin'");
const accounts = q.get("SELECT * FROM users WHERE role='accounts'");
const lead = (over = {}) => L.createLead({ source: 'Meta Ads', parent_name: 'T', phone: `+97150${Math.random().toString().slice(2, 9)}`, country: 'UAE', child_name: 'C', subjects: 'Maths', ...over }, owner);
const throwsMsg = (fn, re) => assert.throws(fn, (e) => re.test(e.message));

test('lead source is mandatory and new leads round-robin within the market', () => {
  throwsMsg(() => L.createLead({ parent_name: 'x', phone: '1' }, owner), /source is mandatory/);
  const a = lead(); const b = lead();
  const ownerA = q.get('SELECT * FROM users WHERE id=?', a.owner_id);
  assert.equal(ownerA.market, 'UAE');
  assert.notEqual(a.owner_id, b.owner_id);
  assert.equal(lead({ country: 'India' }).currency, 'INR');
});

test('stage change requires a follow-up; Lost requires a reason; Converted only via convert', () => {
  const l = lead();
  throwsMsg(() => L.changeStage(l.id, { stage: 'Qualified' }, owner), /follow-up/);
  throwsMsg(() => L.changeStage(l.id, { stage: 'Lost' }, owner), /Lost reason/);
  throwsMsg(() => L.changeStage(l.id, { stage: 'Converted' }, owner), /Convert/);
  assert.equal(L.changeStage(l.id, { stage: 'Qualified', follow_up_at: addDays(now(), 1) }, owner).stage, 'Qualified');
});

test('not-connected cadence: retries, WhatsApp task, Nurture after 6 failed attempts', () => {
  const l = lead();
  let r = L.logCall(l.id, { outcome: 'Not answered' }, owner);
  assert.equal(r.stage, 'Attempted');
  assert.ok(q.get("SELECT 1 FROM tasks WHERE entity='lead' AND entity_id=? AND type='whatsapp'", l.id));
  for (let i = 0; i < 5; i++) r = L.logCall(l.id, { outcome: 'Busy / Switched off' }, owner);
  assert.equal(r.stage, 'Nurture');
  assert.equal(r.attempt_count, 6);
});

test('30-day rule warns on day 25, reassigns on day 30, Nurture after 2 reassignments', () => {
  const l = lead();
  L.logCall(l.id, { outcome: 'Connected - Interested', follow_up_at: addDays(now(), 1) }, owner);
  update('leads', l.id, { assigned_at: addDays(now(), -26) });
  L.runLeadRules();
  assert.equal(L.getLead(l.id).expiry_warned, 1);
  update('leads', l.id, { assigned_at: addDays(now(), -31) });
  L.runLeadRules();
  const moved = L.getLead(l.id);
  assert.notEqual(moved.owner_id, l.owner_id);
  assert.equal(moved.reassignment_count, 1);
  update('leads', l.id, { assigned_at: addDays(now(), -31), reassignment_count: 2 });
  L.runLeadRules();
  assert.equal(L.getLead(l.id).stage, 'Nurture');
});

test('Payment Pending leads are exempt from auto-reassignment', () => {
  const l = lead();
  L.changeStage(l.id, { stage: 'Payment Pending', follow_up_at: addDays(now(), 1), follow_up_type: 'payment' }, owner);
  update('leads', l.id, { assigned_at: addDays(now(), -40) });
  L.runLeadRules();
  assert.equal(L.getLead(l.id).owner_id, l.owner_id);
});

function convertedStudent(hours = 5) {
  const l = lead();
  L.saveKyc(l.id, { parent_full_name: 'T', relationship: 'Mother', id_type: 'Passport', id_number: '1', id_file: 'f', child_full_name: 'C',
    child_dob: '2012-01-01', school_name: 'S', enrollment_file: 'e', consent_terms: 1, consent_recording: 1, consent_data: 1, submit: true }, owner);
  throwsMsg(() => L.convert(l.id, { subjects: 'Maths', hours, price: 100, payment: { method: 'Card', reference: 'r', amount: 100 } }, owner), /kyc/);
  L.verifyKyc(l.id, { approve: true }, admin);
  return L.convert(l.id, { subjects: 'Maths', hours, price: 100, payment: { method: 'Card', reference: 'r', amount: 100 } }, owner).student_id;
}

test('conversion creates student, invoice and a 24h assign-teacher task', () => {
  const sid = convertedStudent();
  assert.equal(S.getStudent(sid).stage, 'Awaiting Teacher');
  assert.ok(q.get("SELECT 1 FROM tasks WHERE entity='student' AND entity_id=? AND type='assign_teacher'", sid));
  assert.equal(q.get('SELECT status FROM payments WHERE student_id=?', sid).status, 'Paid');
});

test('attendance policy drives hours, pay and alerts; payouts lock after paid', () => {
  const sid = convertedStudent(5);
  const teacher = q.get("SELECT * FROM teachers WHERE country='UAE' AND subjects LIKE '%Maths%'");
  S.assignTeacher(sid, { teacher_id: teacher.id }, admin);
  const mk = (h) => S.addClass(sid, { scheduled_at: addDays(now(), -h), duration_hours: 1 }, admin).id;
  S.markAttendance(mk(1.1), { status: 'Completed' }, admin);
  S.markAttendance(mk(1.2), { status: 'Student Absent (no notice)' }, admin);
  S.markAttendance(mk(1.3), { status: 'Teacher Absent', remarks: 'sick' }, admin);
  let s = S.getStudent(sid);
  assert.equal(s.hours_used, 2);
  assert.equal(s.stage, 'Active');
  S.markAttendance(mk(1.4), { status: 'Completed' }, admin);
  s = S.getStudent(sid);
  assert.equal(s.stage, 'Hours Low'); // 1 of 5 left
  assert.ok(q.get("SELECT 1 FROM tasks WHERE entity='student' AND entity_id=? AND type='retention'", sid));

  const month = now().slice(0, 7);
  const p = F.generatePayouts(month).find((x) => x.teacher_id === teacher.id);
  assert.equal(p.currency, 'AED');
  assert.ok(F.reconcile(month).every((r) => !r.mismatch));
  F.approvePayout(p.id, accounts);
  F.payPayout(p.id, { mode: 'UPI', reference: 'U1' }, accounts);
  throwsMsg(() => S.markAttendance(mk(1.5), { status: 'Completed' }, admin), /locked/);
});

test('duplicate class for the same teacher and time is blocked', () => {
  const sid = convertedStudent(15);
  const teacher = q.get("SELECT * FROM teachers WHERE country='UAE' LIMIT 1");
  S.assignTeacher(sid, { teacher_id: teacher.id }, admin);
  const at = addDays(now(), 40);
  S.addClass(sid, { scheduled_at: at }, admin);
  throwsMsg(() => S.addClass(sid, { scheduled_at: at }, admin), /Duplicate/);
});

test('refunds need manager approval before accounts can process', () => {
  const sid = convertedStudent();
  const pay = q.get('SELECT * FROM payments WHERE student_id=?', sid);
  F.refund(pay.id, 'request', { reason: 'Moving' }, owner);
  throwsMsg(() => F.refund(pay.id, 'approve', {}, accounts), /Only/);
  F.refund(pay.id, 'approve', {}, owner);
  assert.equal(F.refund(pay.id, 'process', {}, accounts).status, 'Refunded');
});

// ---------- gamification ----------
const game = require('../src/services/game');

test('leaderboard: conversions outweigh calls, call spam on one lead is capped', () => {
  const { insert } = require('../src/db');
  const mk = (n) => q.get('SELECT * FROM users WHERE id=?', insert('users', { name: n, email: `${n}@t.test`, password_hash: 'x', role: 'sales_exec', market: 'UAE' }));
  const [a, b] = [mk('fresh-a'), mk('fresh-b')];
  const start = new Date(Date.now() - 1000).toISOString();
  const end = new Date(Date.now() + 3600000).toISOString();
  const l = lead();
  for (let i = 0; i < 10; i++) L.logCall(l.id, { outcome: 'Not answered' }, a); // only 3 should count
  const before = game.score(start, end).find((r) => r.user_id === a.id);
  assert.equal(before.breakdown.calls, 3);
  assert.equal(before.calls, 10);
  const sid = convertedStudent();
  q.run('UPDATE packages SET sold_by=? WHERE student_id=?', b.id, sid);
  const rowB = game.score(start, end).find((r) => r.user_id === b.id);
  assert.ok(rowB.breakdown.conversions >= 50);
  assert.ok(rowB.points > before.points);
});

test('kudos: not to yourself, once per win, worth points to the receiver', () => {
  const pkg = q.get("SELECT * FROM packages WHERE kind='New' LIMIT 1");
  const seller = q.get('SELECT * FROM users WHERE id=?', pkg.sold_by);
  const other = q.get('SELECT * FROM users WHERE id=?', require('../src/db').insert('users', { name: 'giver', email: 'giver@t.test', password_hash: 'x', role: 'sales_exec', market: 'India' }));
  throwsMsg(() => game.giveKudos(seller, { kind: 'conversion', ref_id: pkg.id }), /yourself/);
  game.giveKudos(other, { kind: 'conversion', ref_id: pkg.id });
  throwsMsg(() => game.giveKudos(other, { kind: 'conversion', ref_id: pkg.id }), /already/);
});

test('me(): rank, gap to the next rep and badges are reported', () => {
  const rep = q.get("SELECT * FROM users WHERE role='sales_exec' LIMIT 1");
  const m = game.me(rep);
  assert.ok(m.onBoard && m.rank >= 1);
  if (m.rank > 1) assert.ok(m.next.gap > 0);
  assert.equal(m.badges.length, game.BADGES.length);
  const saved = game.saveSettings({ dailyCallTarget: 10 });
  assert.equal(saved.dailyCallTarget, 10);
});

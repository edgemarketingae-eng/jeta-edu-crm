// Accounts & bookkeeping + teacher payouts (sections 12 & 13).
const config = require('../config');
const { q, insert, update } = require('../db');
const { now, addDays, monthOf, fail, log, nextCode } = require('../util');
const { notify, sendExternal } = require('../notify');

const toAED = (amount, currency) => (currency === 'INR' ? amount / config.exchangeRate.INR_PER_AED : amount);

// Invoice numbers per year: JETA-2026-0001 (prefix from Settings → Company).
function nextInvoiceNo() {
  const prefix = require('./settings').get('company').invoice_prefix || 'JETA';
  const year = new Date().getUTCFullYear();
  const like = `${prefix}-${year}-%`;
  const last = q.get('SELECT invoice_no FROM payments WHERE invoice_no LIKE ? ORDER BY id DESC LIMIT 1', like)?.invoice_no;
  const n = last ? Number(last.split('-').pop()) + 1 : 1;
  return `${prefix}-${year}-${String(n).padStart(4, '0')}`;
}
// Prices are VAT-inclusive; when VAT is on the invoice shows the VAT part separately.
function vatOf(amount) {
  const c = require('./settings').get('company');
  if (!c.vat_enabled) return 0;
  const r = Number(c.vat_rate) / 100;
  return +(amount - amount / (1 + r)).toFixed(2);
}

function recordPayment(p, user) {
  const paid = ['Paid', 'Partial'].includes(p.status);
  const id = insert('payments', {
    vat_amount: vatOf(Number(p.amount)),
    verified_at: paid && user && ['accounts', 'owner'].includes(user.role) ? now() : null,
    verified_by: paid && user && ['accounts', 'owner'].includes(user.role) ? user.id : null,
    invoice_no: nextInvoiceNo(), student_id: p.student_id || null, lead_id: p.lead_id || null,
    package_id: p.package_id || null, amount: Number(p.amount), currency: p.currency,
    method: p.method || null, reference: p.reference || null, instalment_no: p.instalment_no || 1,
    due_date: p.due_date || null, paid_at: ['Paid', 'Partial'].includes(p.status) ? (p.paid_at || now()) : null,
    status: p.status || 'Pending', collected_by: ['Paid', 'Partial'].includes(p.status) ? user?.id : null, created_at: now(),
  });
  const pay = q.get('SELECT * FROM payments WHERE id=?', id);
  if (pay.student_id) log('student', pay.student_id, 'payment', `${pay.invoice_no}: ${pay.currency} ${pay.amount} – ${pay.status}${pay.due_date ? ` (due ${pay.due_date})` : ''}`, { userId: user?.id });
  if (['Paid', 'Partial'].includes(pay.status)) sendInvoice(pay);
  if (paid && !pay.verified_at) notify({ role: 'accounts', title: 'Payment to verify', body: `${pay.invoice_no} ${pay.currency} ${pay.amount} (${pay.method || ''} ${pay.reference || ''})`, link: '#/accounts?tab=verify', dedupe: `ver:${pay.id}` });
  return q.get('SELECT * FROM payments WHERE id=?', id);
}

// Accounts confirms the money actually arrived (blueprint 2: "Verify payments").
function verifyPayment(paymentId, user) {
  const p = q.get('SELECT * FROM payments WHERE id=?', paymentId) || fail(404, 'Payment not found');
  if (!['Paid', 'Partial'].includes(p.status)) fail(400, 'Only received payments can be verified');
  if (p.verified_at) fail(400, 'Already verified');
  update('payments', p.id, { verified_at: now(), verified_by: user.id });
  if (p.student_id) log('student', p.student_id, 'payment', `${p.invoice_no} verified by Accounts`, { userId: user.id });
  return q.get('SELECT * FROM payments WHERE id=?', p.id);
}

function sendInvoice(pay) {
  const s = pay.student_id ? q.get('SELECT * FROM students WHERE id=?', pay.student_id) : null;
  if (!s) return;
  const brand = require('./settings').get('company').name;
  const text = `${brand} ${pay.status === 'Pending' ? 'Invoice' : 'Receipt'} ${pay.invoice_no}: ${pay.currency} ${pay.amount.toFixed(2)} for ${s.child_name}. Thank you!`;
  sendExternal('whatsapp', s.phone, text);
  sendExternal('email', s.email, text);
  q.run('UPDATE payments SET invoice_sent_at=COALESCE(invoice_sent_at, ?) WHERE id=?', now(), pay.id);
}

function markPaid(paymentId, body, user) {
  const p = q.get('SELECT * FROM payments WHERE id=?', paymentId) || fail(404, 'Payment not found');
  if (!['Pending', 'Partial'].includes(p.status)) fail(400, `Payment is ${p.status}`);
  if (!body.method || !body.reference) fail(400, 'Method and reference are required');
  const amount = body.amount ? Number(body.amount) : p.amount;
  const acc = ['accounts', 'owner'].includes(user.role);
  update('payments', p.id, { status: amount >= p.amount ? 'Paid' : 'Partial', method: body.method, reference: body.reference,
    paid_at: body.paid_at || now(), collected_by: user.id, ...(acc ? { verified_at: now(), verified_by: user.id } : {}) });
  const fresh = q.get('SELECT * FROM payments WHERE id=?', p.id);
  if (p.student_id) {
    log('student', p.student_id, 'payment', `${p.invoice_no} paid via ${body.method} (${body.reference})`, { userId: user.id });
    const s = q.get('SELECT * FROM students WHERE id=?', p.student_id);
    if (s.retention_stage === 'Payment Pending') {
      update('students', s.id, { retention_stage: 'Renewed' });
      log('student', s.id, 'stage', 'Retention: Payment Pending → Renewed', { userId: user.id });
    }
    require('./students').tryActivate(p.student_id, user);
  }
  sendInvoice(fresh);
  return fresh;
}

// Refund workflow: request → manager approval → accounts → record.
function refund(paymentId, action, body, user) {
  const p = q.get('SELECT * FROM payments WHERE id=?', paymentId) || fail(404, 'Payment not found');
  const steps = {
    request: { from: ['Paid', 'Partial'], to: 'Refund Requested', roles: null },
    approve: { from: ['Refund Requested'], to: 'Refund Approved', roles: ['owner', 'sales_manager'] },
    reject:  { from: ['Refund Requested'], to: 'Paid', roles: ['owner', 'sales_manager'] },
    process: { from: ['Refund Approved'], to: 'Refunded', roles: ['owner', 'accounts'] },
  };
  const s = steps[action] || fail(400, 'Unknown refund action');
  if (!s.from.includes(p.status)) fail(400, `Cannot ${action} a payment that is ${p.status}`);
  if (s.roles && !s.roles.includes(user.role)) fail(403, `Only ${s.roles.join('/')} can ${action} refunds`);
  if (action === 'request' && !body.reason) fail(400, 'Refund reason is required');
  update('payments', p.id, { status: s.to, refund_reason: body.reason || p.refund_reason });
  if (p.student_id) log('student', p.student_id, 'payment', `${p.invoice_no}: refund ${action} → ${s.to}${body.reason ? ` (${body.reason})` : ''}`, { userId: user.id });
  if (action === 'request') notify({ role: 'manager', title: 'Refund approval needed', body: `${p.invoice_no} ${p.currency} ${p.amount}`, link: '#/accounts' });
  if (action === 'approve') notify({ role: 'accounts', title: 'Refund approved – process payment', body: p.invoice_no, link: '#/accounts' });
  return q.get('SELECT * FROM payments WHERE id=?', p.id);
}

function addExpense(body) {
  if (!body.category || !(Number(body.amount) > 0) || !body.month) fail(400, 'Category, amount and month are required');
  return insert('expenses', { category: body.category, source: body.source || null, amount: Number(body.amount),
    currency: body.currency === 'INR' ? 'INR' : 'AED', month: body.month, note: body.note || null, created_at: now() });
}

// ---------- Teacher payouts ----------
// Payout periods: 'YYYY-MM' (monthly) or 'YYYY-MM-H1' (1st–15th) / 'YYYY-MM-H2' (16th–end) for fortnightly.
function monthRange(period) {
  const [y, m, half] = String(period).split('-');
  const Y = Number(y); const M = Number(m);
  if (half === 'H1') return [new Date(Date.UTC(Y, M - 1, 1)).toISOString(), new Date(Date.UTC(Y, M - 1, 16)).toISOString()];
  if (half === 'H2') return [new Date(Date.UTC(Y, M - 1, 16)).toISOString(), new Date(Date.UTC(Y, M, 1)).toISOString()];
  return [new Date(Date.UTC(Y, M - 1, 1)).toISOString(), new Date(Date.UTC(Y, M, 1)).toISOString()];
}
const validPeriod = (p) => /^\d{4}-\d{2}(-H[12])?$/.test(p || '');
// Periods a class date belongs to (used for month locks).
const periodsOf = (iso) => { const mo = iso.slice(0, 7); return [mo, `${mo}-${Number(iso.slice(8, 10)) <= 15 ? 'H1' : 'H2'}`]; };
function periodNow(cycle) {
  const d = new Date().toISOString();
  return cycle === 'fortnightly' ? periodsOf(d)[1] : d.slice(0, 7);
}

// Rate per hour for one class: most specific teacher rate rule (subject / grade / batch type), else the base rate.
function rateFor(teacher, c, rules) {
  if (c.is_demo && teacher.demo_rate) return teacher.demo_rate;
  const subj = String(c.subject || '').split(',')[0].trim().toLowerCase();
  let best = null; let score = -1;
  for (const r of rules) {
    if (r.subject && r.subject.toLowerCase() !== subj) continue;
    if (r.grade && String(r.grade) !== String(c.grade || '')) continue;
    if (r.batch_type && r.batch_type !== (c.batch_type || '1:1')) continue;
    const sc = (r.subject ? 1 : 0) + (r.grade ? 1 : 0) + (r.batch_type ? 1 : 0);
    if (sc > score) { best = r; score = sc; }
  }
  return best ? best.rate : teacher.rate_per_hour;
}

function buildPayout(teacher, month) {
  const [from, to] = monthRange(month);
  const rows = q.all(`SELECT c.*, s.child_name, s.grade, s.batch_type FROM classes c JOIN students s ON s.id=c.student_id
    WHERE c.teacher_id=? AND c.teacher_paid_hours>0 AND c.scheduled_at>=? AND c.scheduled_at<?`, teacher.id, from, to);
  const rules = q.all('SELECT * FROM teacher_rates WHERE teacher_id=?', teacher.id);
  const lines = {};
  let hours = 0; let gross = 0;
  for (const c of rows) {
    const rate = rateFor(teacher, c, rules);
    const key = `${c.student_id}|${c.subject}|${rate}`;
    lines[key] ||= { student: c.child_name, student_id: c.student_id, subject: c.subject, hours: 0, rate, gross: 0, demo: !!c.is_demo };
    lines[key].hours += c.teacher_paid_hours;
    lines[key].gross += c.teacher_paid_hours * rate;
    hours += c.teacher_paid_hours;
    gross += c.teacher_paid_hours * rate;
  }
  return { hours: +hours.toFixed(2), gross: +gross.toFixed(2), lines: Object.values(lines) };
}

function generatePayouts(month) {
  if (!validPeriod(month)) fail(400, 'Period must be YYYY-MM, or YYYY-MM-H1 / YYYY-MM-H2 for fortnightly');
  const out = [];
  for (const t of q.all('SELECT * FROM teachers')) {
    const b = buildPayout(t, month);
    const existing = q.get('SELECT * FROM payouts WHERE teacher_id=? AND month=?', t.id, month);
    if (existing && existing.status !== 'Pending') { out.push(existing); continue; } // approved/paid stay frozen
    if (!b.hours && !existing) continue;
    const data = { currency: t.currency, hours: b.hours, gross: b.gross, lines: JSON.stringify(b.lines),
      net: +(b.gross + (existing?.adjustments || 0)).toFixed(2) };
    if (existing) update('payouts', existing.id, data);
    else insert('payouts', { teacher_id: t.id, month, status: 'Pending', adjustments: 0, created_at: now(), ...data });
    out.push(q.get('SELECT * FROM payouts WHERE teacher_id=? AND month=?', t.id, month));
  }
  return out;
}

function getPayout(id) { return q.get('SELECT * FROM payouts WHERE id=?', id) || fail(404, 'Payout not found'); }

function adjustPayout(id, body, user) {
  const p = getPayout(id);
  if (p.locked && user.role !== 'owner') fail(423, 'Month is locked – Owner approval needed');
  if (p.status !== 'Pending' && user.role !== 'owner') fail(400, 'Only pending payouts can be adjusted');
  const adj = Number(body.adjustments) || 0;
  update('payouts', id, { adjustments: adj, adjustment_note: body.note || null, net: +(p.gross + adj).toFixed(2) });
  log('payout', id, 'system', `Adjustment ${adj >= 0 ? '+' : ''}${adj} ${p.currency}: ${body.note || ''}`, { userId: user.id });
  return getPayout(id);
}

function approvePayout(id, user) {
  const p = getPayout(id);
  if (p.status !== 'Pending') fail(400, `Payout is already ${p.status}`);
  update('payouts', id, { status: 'Approved', approved_by: user.id });
  log('payout', id, 'system', 'Approved', { userId: user.id });
  return getPayout(id);
}

function payPayout(id, body, user) {
  const p = getPayout(id);
  if (p.status !== 'Approved') fail(400, 'Approve the payout before paying');
  if (!body.reference || !['Bank transfer', 'UPI', 'Cash'].includes(body.mode)) fail(400, 'Payment mode and reference are required');
  update('payouts', id, { status: 'Paid', paid_at: body.paid_at || now(), pay_reference: body.reference, pay_mode: body.mode, locked: 1 });
  log('payout', id, 'system', `Paid via ${body.mode} (${body.reference}) – month locked`, { userId: user.id });
  const t = q.get('SELECT * FROM teachers WHERE id=?', p.teacher_id);
  const statement = `Jeta Edu payout ${p.month}: ${p.hours} hrs, gross ${p.currency} ${p.gross}, adj ${p.adjustments}, net ${p.currency} ${p.net}. Ref ${body.reference}.`;
  sendExternal('whatsapp', t.phone, statement);
  sendExternal('email', t.email, statement);
  return getPayout(id);
}

function unlockPayout(id, user) {
  const p = getPayout(id);
  update('payouts', id, { locked: 0, status: 'Pending' });
  log('payout', id, 'system', `Unlocked by Owner (was ${p.status})`, { userId: user.id });
  return getPayout(id);
}

// Payout hours must equal qualifying attendance hours.
function reconcile(month) {
  const [from, to] = monthRange(month);
  return q.all(`SELECT t.id teacher_id, t.name, t.currency,
      COALESCE((SELECT SUM(teacher_paid_hours) FROM classes c WHERE c.teacher_id=t.id AND c.scheduled_at>=? AND c.scheduled_at<?),0) attendance_hours,
      COALESCE((SELECT hours FROM payouts p WHERE p.teacher_id=t.id AND p.month=?),0) payout_hours
    FROM teachers t`, from, to, month)
    .map((r) => ({ ...r, mismatch: Math.abs(r.attendance_hours - r.payout_hours) > 0.001 }))
    .filter((r) => r.attendance_hours || r.payout_hours);
}

function runFinanceRules() {
  const today = now().slice(0, 10);
  const soon = addDays(now(), config.instalmentReminderDaysBefore).slice(0, 10);
  let n = 0;
  for (const p of q.all(`SELECT p.*, s.phone, s.parent_name, s.child_name, s.retention_owner_id FROM payments p
      LEFT JOIN students s ON s.id=p.student_id WHERE p.status='Pending' AND p.due_date IS NOT NULL AND p.due_date<=?`, soon)) {
    const phase = p.due_date > today ? 'soon' : p.due_date === today ? 'today' : 'overdue';
    const key = `inst:${p.id}:${phase}:${phase === 'overdue' ? today : ''}`;
    const title = { soon: 'Instalment due in 3 days', today: 'Instalment due today', overdue: 'Instalment OVERDUE' }[phase];
    const created = notify({ role: 'accounts', title, body: `${p.invoice_no} ${p.currency} ${p.amount} – ${p.parent_name || ''}`, link: '#/accounts', dedupe: key });
    if (created) {
      n += created;
      if (p.retention_owner_id) notify({ userId: p.retention_owner_id, title, body: `${p.parent_name}: ${p.currency} ${p.amount}`, link: `#/students/${p.student_id}`, dedupe: `${key}:rep` });
      sendExternal('whatsapp', p.phone, `Hi ${p.parent_name}, a gentle reminder: instalment ${p.invoice_no} of ${p.currency} ${p.amount} is ${phase === 'overdue' ? 'overdue' : `due ${p.due_date}`}.`);
    }
  }
  return n;
}

module.exports = {
  nextInvoiceNo, vatOf, verifyPayment, rateFor, validPeriod, periodsOf, periodNow,
  toAED, recordPayment, markPaid, refund, addExpense, generatePayouts, buildPayout, adjustPayout,
  approvePayout, payPayout, unlockPayout, reconcile, runFinanceRules, monthRange, getPayout,
};

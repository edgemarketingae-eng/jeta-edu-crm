// Accountability system (blueprint 16): personal scorecards, coaching triggers, daily 8 pm summary, weekly review.
const config = require('../config');
const { q, insert } = require('../db');
const { now, addDays, addMinutes, fail, task } = require('../util');
const { notify, sendExternal } = require('../notify');
const settings = require('./settings');
const { toAED } = require('./finance');
const { range } = require('./reports');

const pct = (num, den) => (den ? Math.round((num / den) * 100) : null);
const metric = (key, label, value, { unit = 'count', target = null, higherIsBetter = true } = {}) => ({
  key, label, value, unit, target,
  ok: target === null || value === null ? null : higherIsBetter ? value >= target : value <= target,
});

// ---------- per-role scorecards ----------
function salesCard(uid, a, b) {
  const t = now();
  const T = settings.get('compliance');
  const calls = q.all("SELECT outcome, body, needs_note FROM activities WHERE entity='lead' AND type='call' AND user_id=? AND created_at>=? AND created_at<?", uid, a, b);
  const connected = calls.filter((c) => String(c.outcome).startsWith('Connected'));
  const noted = connected.filter((c) => !c.needs_note && String(c.body || '').trim().length > 0).length;
  const due = q.all("SELECT status, on_time FROM follow_ups WHERE owner_id=? AND due_at>=? AND due_at<? AND due_at<? AND status IN ('Done','Open')", uid, a, b, t);
  const onTime = due.filter((f) => f.status === 'Done' && f.on_time).length;
  const assigned = q.all('SELECT assigned_at, first_call_at FROM leads WHERE owner_id=? AND assigned_at>=? AND assigned_at<?', uid, a, b);
  const sla = assigned.filter((l) => l.first_call_at && (new Date(l.first_call_at) - new Date(l.assigned_at)) / 60000 <= config.sla.firstCallMinutes).length;
  const demos = q.get("SELECT COUNT(*) n FROM activities WHERE entity='lead' AND type='stage' AND user_id=? AND body LIKE '%→ Demo Scheduled%' AND created_at>=? AND created_at<?", uid, a, b).n;
  const pk = q.all('SELECT kind, price, currency FROM packages WHERE sold_by=? AND created_at>=? AND created_at<?', uid, a, b);
  const esc = q.get("SELECT COUNT(*) n FROM escalations WHERE owner_id=? AND created_at>=? AND created_at<?", uid, a, b).n;
  return [
    metric('dials', 'Dials', calls.length),
    metric('connected', 'Connected calls', connected.length),
    metric('notesPct', 'Notes completed', pct(noted, connected.length), { unit: '%', target: T.notesPct }),
    metric('onTimePct', 'Follow-ups on time', pct(onTime, due.length), { unit: '%', target: T.onTimeFollowUpPct }),
    metric('slaPct', 'First-call SLA', pct(sla, assigned.length), { unit: '%', target: T.firstCallSlaPct }),
    metric('demos', 'Demos booked', demos),
    metric('conversions', 'Conversions', pk.filter((p) => p.kind !== 'Renewal').length),
    metric('revenue', 'Revenue', Math.round(pk.reduce((s, p) => s + toAED(p.price, p.currency), 0)), { unit: 'AED' }),
    metric('renewals', 'Renewals', pk.filter((p) => p.kind === 'Renewal').length),
    metric('escalations', 'Escalated (overdue 48h)', esc, { target: 0, higherIsBetter: false }),
    metric('missingNotes', 'Calls missing notes now', q.get('SELECT COUNT(*) n FROM activities WHERE needs_note=1 AND user_id=?', uid).n, { target: 0, higherIsBetter: false }),
  ];
}

function adminCard(uid, a, b) {
  const T = settings.get('compliance');
  const joined = q.all('SELECT id, joined_at FROM students WHERE joined_at>=? AND joined_at<?', a, b);
  let in24 = 0; let assignedN = 0;
  for (const s of joined) {
    const ev = q.get("SELECT created_at FROM activities WHERE entity='student' AND entity_id=? AND body LIKE 'Teacher assigned:%' ORDER BY id LIMIT 1", s.id);
    if (ev) { assignedN++; if ((new Date(ev.created_at) - new Date(s.joined_at)) / 3600000 <= 24) in24++; }
  }
  const flagged = q.all('SELECT review_flagged_at, review_resolved_at FROM classes WHERE review_flagged_at>=? AND review_flagged_at<?', a, b);
  const cleared = flagged.filter((c) => c.review_resolved_at && (new Date(c.review_resolved_at) - new Date(c.review_flagged_at)) / 3600000 <= 24).length;
  const kyc = q.all('SELECT submitted_at, verified_at FROM kyc WHERE submitted_at>=? AND submitted_at<?', a, b);
  const kyc24 = kyc.filter((k) => k.verified_at && (new Date(k.verified_at) - new Date(k.submitted_at)) / 3600000 <= 24).length;
  const resched = q.get("SELECT COUNT(*) n FROM activities WHERE entity='student' AND type='class' AND body LIKE 'Rescheduled to%' AND created_at>=? AND created_at<?", a, b).n;
  const open = require('./attendance').reviewList().length;
  return [
    metric('assign24', 'Teacher assigned within 24 hrs', pct(in24, joined.length), { unit: '%', target: T.teacherAssign24hPct }),
    metric('cleared24', 'Attendance exceptions cleared within 24 hrs', pct(cleared, flagged.length), { unit: '%', target: T.exceptionsCleared24hPct }),
    metric('kyc24', 'KYC verified within 24 hrs', pct(kyc24, kyc.length), { unit: '%', target: T.kycVerified24hPct }),
    metric('reschedules', 'Schedule changes logged', resched),
    metric('unassigned', 'Students awaiting teacher now', q.get("SELECT COUNT(*) n FROM students WHERE stage='Awaiting Teacher'").n, { target: 0, higherIsBetter: false }),
    metric('reviewOpen', 'Needs-review items open now', open, { target: 0, higherIsBetter: false }),
    metric('assigned', 'Teachers assigned', assignedN),
  ];
}

function accountsCard(uid, a, b) {
  const T = settings.get('compliance');
  const paid = q.all("SELECT paid_at, invoice_sent_at, verified_at FROM payments WHERE status IN ('Paid','Partial','Refund Requested','Refund Approved','Refunded') AND paid_at>=? AND paid_at<?", a, b);
  const inv24 = paid.filter((p) => p.invoice_sent_at && (new Date(p.invoice_sent_at) - new Date(p.paid_at)) / 3600000 <= 24).length;
  const ver24 = paid.filter((p) => p.verified_at && (new Date(p.verified_at) - new Date(p.paid_at)) / 3600000 <= 24).length;
  const finance = require('./finance');
  const payouts = q.all("SELECT month, status, paid_at FROM payouts WHERE status<>'Pending' OR 1=1").filter((p) => {
    const end = finance.monthRange(p.month)[1];
    return end >= a && end < b;
  });
  const due = (p) => addDays(finance.monthRange(p.month)[1], T.payoutDueDays);
  const onTime = payouts.filter((p) => p.status === 'Paid' && p.paid_at <= due(p)).length;
  const period = finance.periodNow(settings.get('payouts').cycle);
  return [
    metric('invoices24', 'Invoices issued within 24 hrs', pct(inv24, paid.length), { unit: '%', target: T.invoices24hPct }),
    metric('verified24', 'Payments verified within 24 hrs', pct(ver24, paid.length), { unit: '%', target: T.invoices24hPct }),
    metric('payoutsOnTime', 'Payouts paid on time', pct(onTime, payouts.length), { unit: '%', target: T.payoutsOnTimePct }),
    metric('mismatches', 'Reconciliation mismatches open', finance.reconcile(period).filter((r) => r.mismatch).length, { target: 0, higherIsBetter: false }),
    metric('toVerify', 'Payments waiting for verification', q.get("SELECT COUNT(*) n FROM payments WHERE status IN ('Paid','Partial') AND verified_at IS NULL").n, { target: 0, higherIsBetter: false }),
    metric('overdueInstalments', 'Instalments overdue', q.get("SELECT COUNT(*) n FROM payments WHERE status='Pending' AND due_date < ?", now().slice(0, 10)).n),
  ];
}

function managerCard(uid, a, b) {
  const esc = q.all('SELECT status, created_at FROM escalations WHERE created_at>=? AND created_at<?', a, b);
  const nurture = q.all("SELECT id FROM leads WHERE stage='Nurture' AND archived=0 AND updated_at>=? AND updated_at<?", a, b);
  const managers = q.all("SELECT id FROM users WHERE role IN ('owner','sales_manager')").map((u) => u.id);
  const reviewed = nurture.filter((l) => q.get(`SELECT 1 FROM activities WHERE entity='lead' AND entity_id=? AND user_id IN (${managers.map(() => '?').join(',') || 'NULL'}) AND created_at>=?`, l.id, ...managers, a)).length;
  const coach = q.all('SELECT status FROM coaching WHERE created_at>=? AND created_at<?', a, b);
  const edits = q.all('SELECT status FROM edit_requests WHERE created_at>=? AND created_at<?', a, b);
  return [
    metric('escCleared', 'Overdue items cleared', pct(esc.filter((e) => e.status === 'Resolved').length, esc.length), { unit: '%', target: 100 }),
    metric('reassignReviewed', 'Nurture / reassigned leads reviewed', pct(reviewed, nurture.length), { unit: '%', target: 100 }),
    metric('coachingHeld', 'Coaching sessions held', coach.filter((c) => c.status === 'Held').length),
    metric('coachingDue', 'Coaching sessions due', q.get("SELECT COUNT(*) n FROM coaching WHERE status='Due'").n, { target: 0, higherIsBetter: false }),
    metric('editsPending', 'Note edits waiting for you', q.get("SELECT COUNT(*) n FROM edit_requests WHERE status='Pending'").n, { target: 0, higherIsBetter: false }),
    metric('teamOverdue', 'Team follow-ups overdue now', q.get("SELECT COUNT(*) n FROM leads WHERE archived=0 AND stage NOT IN ('Converted','Lost') AND next_follow_up_at < ?", now()).n, { target: 0, higherIsBetter: false }),
  ];
}

const CARDS = { sales_exec: salesCard, admin: adminCard, accounts: accountsCard, sales_manager: managerCard, owner: managerCard };

function scorecard(userId, period = 'week') {
  const u = q.get('SELECT id, name, role, market FROM users WHERE id=?', userId) || fail(404, 'User not found');
  const [a, b] = range(period);
  const fn = CARDS[u.role];
  return { user: u, period, from: a, to: b, metrics: fn ? fn(u.id, a, b) : [] };
}

function teamScorecards(period = 'week') {
  return q.all("SELECT id FROM users WHERE active=1 AND role IN ('sales_exec','admin','accounts','sales_manager') ORDER BY role, name")
    .map((u) => scorecard(u.id, period));
}

// ---------- coaching trigger: below target two weeks running ----------
function weekBounds(weeksAgo) {
  const d = new Date();
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
  const start = new Date(monday.getTime() - weeksAgo * 7 * 86400000);
  return [start.toISOString(), new Date(start.getTime() + 7 * 86400000).toISOString()];
}
function runCoaching() {
  const T = settings.get('compliance');
  let created = 0;
  for (const u of q.all("SELECT * FROM users WHERE active=1 AND role='sales_exec'")) {
    const weeks = [1, 2].map((w) => { const [a, b] = weekBounds(w); return salesCard(u.id, a, b); });
    const below = (card, key, target) => { const m = card.find((x) => x.key === key); return m.value !== null && m.value < target; };
    const notes = weeks.every((c) => below(c, 'notesPct', T.notesPct));
    const ontime = weeks.every((c) => below(c, 'onTimePct', T.onTimeFollowUpPct));
    if (!notes && !ontime) continue;
    if (q.get("SELECT 1 FROM coaching WHERE user_id=? AND status='Due'", u.id)) continue;
    const reason = [notes && `notes under ${T.notesPct}%`, ontime && `on-time follow-ups under ${T.onTimeFollowUpPct}%`].filter(Boolean).join(' and ') + ' for two weeks';
    insert('coaching', { user_id: u.id, reason, status: 'Due', due_at: addDays(now(), 3), created_at: now() });
    task({ title: `Coaching session with ${u.name}: ${reason}`, type: 'coaching', assignee_role: 'sales_manager', due_at: addDays(now(), 3), priority: 'High' });
    notify({ role: 'manager', title: `Coaching due: ${u.name}`, body: reason, link: '#/review' });
    created++;
  }
  return created;
}
function logCoaching(id, notes, user) {
  const c = q.get('SELECT * FROM coaching WHERE id=?', id) || fail(404, 'Not found');
  if (!notes) fail(400, 'Add what was discussed and agreed');
  q.run("UPDATE coaching SET status='Held', held_at=?, manager_id=?, notes=? WHERE id=?", now(), user.id, notes, id);
  q.run("UPDATE tasks SET status='Done', done_at=? WHERE type='coaching' AND status='Open' AND title LIKE ?", now(), `%${q.get('SELECT name FROM users WHERE id=?', c.user_id).name}%`);
  require('../db').writeAudit('coaching_held', 'users', c.user_id, null, notes);
  return { ok: true };
}

// ---------- end-of-day summary at 8 pm local ----------
const TZ = { UAE: 240, India: 330 };
function runDailySummary() {
  const hour = config.summaryHourLocal;
  let sent = 0;
  for (const [market, off] of Object.entries(TZ)) {
    const local = new Date(Date.now() + off * 60000);
    if (local.getUTCHours() !== hour) continue;
    const day = local.toISOString().slice(0, 10);
    const dayStart = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) - off * 60000).toISOString();
    const dayEnd = addDays(dayStart, 1);
    const team = [];
    for (const u of q.all("SELECT * FROM users WHERE active=1 AND role='sales_exec' AND market=?", market)) {
      const key = `summary:${u.id}:${day}`;
      if (q.get('SELECT 1 FROM settings WHERE key=?', key)) continue;
      q.run('INSERT INTO settings(key,value) VALUES(?,?)', key, now());
      const card = salesCard(u.id, dayStart, dayEnd);
      const v = Object.fromEntries(card.map((m) => [m.key, m.value]));
      const doneFu = q.get("SELECT COUNT(*) n FROM follow_ups WHERE owner_id=? AND status='Done' AND done_at>=? AND done_at<?", u.id, dayStart, dayEnd).n;
      const pending = q.get("SELECT COUNT(*) n FROM leads WHERE owner_id=? AND archived=0 AND stage NOT IN ('Converted','Lost') AND next_follow_up_at < ?", u.id, dayEnd).n;
      const body = `Done: ${v.dials} calls (${v.connected} connected), ${doneFu} follow-ups, ${v.demos} demos, ${v.conversions} conversions. Pending: ${pending} follow-ups. Missing notes: ${v.missingNotes}.`;
      notify({ userId: u.id, title: 'Your day', body, link: '#/scorecard', channels: ['app', 'whatsapp', 'email'] });
      team.push(`${u.name}: ${v.dials} calls, notes ${v.notesPct ?? '–'}%, on-time ${v.onTimePct ?? '–'}%, pending ${pending}, missing notes ${v.missingNotes}`);
      sent++;
    }
    if (team.length) notify({ role: 'manager', title: `Team compliance – ${market} ${day}`, body: team.join(' | '), link: '#/review', channels: ['app', 'email'], dedupe: `teamsum:${market}:${day}` });
  }
  return sent;
}

// ---------- weekly review (30-minute meeting on CRM data only) ----------
function weeklyReview() {
  const [a, b] = range('week');
  const [pa, pb] = weekBounds(1);
  const t = now();
  const T = settings.get('compliance');
  const stage = q.all("SELECT stage, COUNT(*) n FROM leads WHERE archived=0 GROUP BY stage");
  const overdue = q.all(`SELECT l.id, l.code, l.parent_name, l.next_follow_up_at, l.next_follow_up_type, l.escalated, u.name owner_name FROM leads l LEFT JOIN users u ON u.id=l.owner_id
    WHERE l.archived=0 AND l.stage NOT IN ('Converted','Lost') AND l.next_follow_up_at < ? ORDER BY l.next_follow_up_at LIMIT 50`, t);
  const lost = q.all("SELECT lost_reason, COUNT(*) n FROM leads WHERE stage='Lost' AND updated_at>=? GROUP BY lost_reason ORDER BY n DESC", pa);
  const renewalsDue = q.get("SELECT COUNT(*) n FROM students WHERE stage='Hours Low' OR retention_stage IN ('Hours Low','Renewal Discussion','Payment Pending')").n;
  const renewalsDone = q.get("SELECT COUNT(*) n FROM packages WHERE kind='Renewal' AND created_at>=?", pa).n;
  const tickets = q.all("SELECT t.*, s.child_name FROM tasks t LEFT JOIN students s ON t.entity='student' AND s.id=t.entity_id WHERE t.type='ticket' AND t.status='Open' ORDER BY t.due_at LIMIT 30");
  const finance = require('./finance');
  const mismatches = finance.reconcile(finance.periodNow(settings.get('payouts').cycle)).filter((r) => r.mismatch);
  const compliance = teamScorecards('week').map((c) => ({ user: c.user, below: c.metrics.filter((m) => m.ok === false) })).filter((c) => c.below.length);
  const coaching = q.all("SELECT c.*, u.name user_name FROM coaching c JOIN users u ON u.id=c.user_id WHERE c.status='Due' OR c.held_at>=? ORDER BY c.status, c.created_at DESC", pa);
  // Formal review triggers (blueprint 16.6): repeated breaches over the last two weeks.
  const since = addDays(t, -14);
  const triggers = [];
  for (const u of q.all("SELECT id, name FROM users WHERE active=1 AND role='sales_exec'")) {
    const esc = q.get('SELECT COUNT(*) n FROM escalations WHERE owner_id=? AND created_at>=?', u.id, since).n;
    const missing = q.get("SELECT COUNT(*) n FROM activities WHERE needs_note=1 AND user_id=? AND note_due_at < ?", u.id, addMinutes(t, -24 * 60)).n;
    const hoarded = q.get("SELECT COUNT(*) n FROM leads WHERE owner_id=? AND archived=0 AND stage NOT IN ('Converted','Lost','Nurture') AND next_follow_up_at < ?", u.id, addDays(t, -3)).n;
    const edits = q.get("SELECT COUNT(*) n FROM edit_requests WHERE requested_by=? AND status='Rejected' AND created_at>=?", u.id, since).n;
    const reasons = [esc >= 3 && `${esc} escalations (overdue 48h)`, missing >= 5 && `${missing} calls without notes for a day+`,
      hoarded >= config.followUp.overdueBlockLimit && `${hoarded} leads overdue 3+ days (hoarding)`, edits >= 2 && `${edits} rejected history edits`].filter(Boolean);
    if (reasons.length) triggers.push({ user: u, reasons });
  }
  const actions = q.all(`SELECT t.*, u.name assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.type='review' AND (t.status='Open' OR t.done_at>=?) ORDER BY t.status DESC, t.due_at`, pa);
  return {
    week: { from: a, to: b }, targets: T,
    pipeline: { byStage: Object.fromEntries(stage.map((r) => [r.stage, r.n])), newThisWeek: q.get('SELECT COUNT(*) n FROM leads WHERE created_at>=?', a).n,
      convertedThisWeek: q.get("SELECT COUNT(*) n FROM packages WHERE kind='New' AND created_at>=?", a).n },
    overdue, lost, renewals: { due: renewalsDue, doneLastWeek: renewalsDone }, tickets, mismatches,
    compliance, coaching, triggers, actions,
    escalationsOpen: q.all(`SELECT e.*, l.parent_name, l.code, u.name owner_name FROM escalations e LEFT JOIN leads l ON e.entity='lead' AND l.id=e.entity_id
      LEFT JOIN users u ON u.id=e.owner_id WHERE e.status='Open' ORDER BY e.created_at LIMIT 50`),
  };
}

function resolveEscalation(id, note, user) {
  const e = q.get('SELECT * FROM escalations WHERE id=?', id) || fail(404, 'Not found');
  q.run("UPDATE escalations SET status='Resolved', resolved_at=?, resolved_by=? WHERE id=?", now(), user.id, id);
  if (e.entity === 'lead') {
    q.run('UPDATE leads SET escalated=0 WHERE id=?', e.entity_id);
    require('../util').log('lead', e.entity_id, 'system', `Escalation resolved by ${user.name}${note ? `: ${note}` : ''}`, { userId: user.id });
  }
  return { ok: true };
}

module.exports = { scorecard, teamScorecards, runCoaching, logCoaching, runDailySummary, weeklyReview, resolveEscalation, weekBounds };

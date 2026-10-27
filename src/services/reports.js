// Dashboards & reports (section 14) – all computed live from the operational tables.
const config = require('../config');
const { q } = require('../db');
const { now, addDays } = require('../util');
const { toAED } = require('./finance');

function range(period, from, to) {
  const d = new Date();
  const startOfDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (period === 'today') return [startOfDay.toISOString(), addDays(startOfDay.toISOString(), 1)];
  if (period === 'week') return [addDays(startOfDay.toISOString(), -((startOfDay.getUTCDay() + 6) % 7)), addDays(startOfDay.toISOString(), 1)];
  if (period === 'custom' && from && to) return [new Date(from).toISOString(), addDays(new Date(to).toISOString(), 1)];
  return [new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(), addDays(startOfDay.toISOString(), 1)];
}

function money(rows) {
  const t = { AED: 0, INR: 0 };
  for (const r of rows) t[r.currency] = (t[r.currency] || 0) + r.amount;
  return { AED: +t.AED.toFixed(2), INR: +t.INR.toFixed(2), combinedAED: +(t.AED + toAED(t.INR, 'INR')).toFixed(2) };
}

function dashboard({ period = 'month', from, to, rep, country, source, user }) {
  const [a, b] = range(period, from, to);
  const scopeRep = user.role === 'sales_exec' ? user.id : rep ? Number(rep) : null;
  const lf = []; const lp = [];
  if (scopeRep) { lf.push('l.owner_id=?'); lp.push(scopeRep); }
  if (country) { lf.push('l.country=?'); lp.push(country); }
  if (source) { lf.push('l.source=?'); lp.push(source); }
  const lw = lf.length ? ` AND ${lf.join(' AND ')}` : '';

  // Sales activity
  const acts = q.all(`SELECT a.type, a.outcome, a.meta, a.body, a.needs_note FROM activities a JOIN leads l ON l.id=a.entity_id
    WHERE a.entity='lead' AND a.type IN ('call','whatsapp') AND a.created_at>=? AND a.created_at<? ${lw}${scopeRep ? ' AND a.user_id=?' : ''}`,
  a, b, ...lp, ...(scopeRep ? [scopeRep] : []));
  const calls = acts.filter((x) => x.type === 'call');
  const connected = calls.filter((x) => String(x.outcome).startsWith('Connected')).length;
  const noted = calls.filter((x) => String(x.outcome).startsWith('Connected') && !x.needs_note && String(x.body || '').trim()).length;
  const talk = calls.reduce((s, x) => s + (JSON.parse(x.meta || '{}').duration_min || 0), 0);
  const assigned = q.all(`SELECT assigned_at, first_call_at FROM leads l WHERE assigned_at>=? AND assigned_at<? ${lw}`, a, b, ...lp);
  const withinSla = assigned.filter((l) => l.first_call_at && (new Date(l.first_call_at) - new Date(l.assigned_at)) / 60000 <= config.sla.firstCallMinutes).length;
  const t = now();
  const openFU = q.get(`SELECT
      SUM(CASE WHEN next_follow_up_at < ? THEN 1 ELSE 0 END) overdue,
      SUM(CASE WHEN next_follow_up_at >= ? AND next_follow_up_at < ? THEN 1 ELSE 0 END) due_today
    FROM leads l WHERE archived=0 AND stage NOT IN ('Converted','Lost') AND next_follow_up_at IS NOT NULL ${lw}`,
  t, t, addDays(t.slice(0, 10) + 'T00:00:00.000Z', 1), ...lp);

  // Pipeline
  const newLeads = q.all(`SELECT source, stage, lost_reason FROM leads l WHERE archived=0 AND created_at>=? AND created_at<? ${lw}`, a, b, ...lp);
  const by = (arr, k) => arr.reduce((m, r) => { m[r[k] || '—'] = (m[r[k] || '—'] || 0) + 1; return m; }, {});
  const stageNow = q.all(`SELECT stage, COUNT(*) n FROM leads l WHERE archived=0 ${lw} GROUP BY stage`, ...lp);
  const demoReached = newLeads.filter((l) => ['Demo Scheduled', 'Demo Done', 'Negotiation', 'Payment Pending', 'Converted'].includes(l.stage)).length;
  const converted = newLeads.filter((l) => l.stage === 'Converted').length;
  const expiring = q.get(`SELECT COUNT(*) n FROM leads l WHERE stage NOT IN ('Converted','Lost','Nurture') AND assigned_at <= ? AND assigned_at > ? ${lw}`,
    addDays(t, -config.reassignment.warnDay), addDays(t, -config.reassignment.expireDay), ...lp).n;
  const reassigned = q.get(`SELECT COUNT(*) n FROM activities a JOIN leads l ON l.id=a.entity_id WHERE a.entity='lead' AND a.type='reassign' AND a.created_at>=? AND a.created_at<? ${lw}`, a, b, ...lp).n;

  // Revenue
  const payWhere = `p.status IN ('Paid','Partial') AND p.paid_at>=? AND p.paid_at<?`;
  const repJoin = `LEFT JOIN packages pk ON pk.id=p.package_id LEFT JOIN students s ON s.id=p.student_id LEFT JOIN leads l ON l.id=s.lead_id`;
  const pays = q.all(`SELECT p.amount, p.currency, pk.kind, pk.sold_by, l.source, l.country FROM payments p ${repJoin}
    WHERE ${payWhere} ${scopeRep ? 'AND pk.sold_by=?' : ''} ${country ? 'AND s.country=?' : ''} ${source ? 'AND l.source=?' : ''}`,
  a, b, ...(scopeRep ? [scopeRep] : []), ...(country ? [country] : []), ...(source ? [source] : []));
  const outstanding = q.all("SELECT amount, currency FROM payments WHERE status IN ('Pending')");
  const pkgs = q.all(`SELECT price, currency FROM packages WHERE created_at>=? AND created_at<? ${scopeRep ? 'AND sold_by=?' : ''}`, a, b, ...(scopeRep ? [scopeRep] : []));
  const byRep = {};
  for (const p of pays) {
    const name = q.get('SELECT name FROM users WHERE id=?', p.sold_by)?.name || '—';
    byRep[name] = (byRep[name] || 0) + toAED(p.amount, p.currency);
  }
  const bySource = {};
  for (const p of pays) bySource[p.source || 'Renewal'] = (bySource[p.source || 'Renewal'] || 0) + toAED(p.amount, p.currency);
  const last30 = q.all("SELECT amount, currency FROM payments WHERE status IN ('Paid','Partial') AND paid_at>=?", addDays(t, -30));

  // Retention
  const due = q.get("SELECT COUNT(*) n FROM students WHERE stage='Hours Low' OR retention_stage IN ('Hours Low','Renewal Discussion','Payment Pending')").n;
  const renewals = q.get("SELECT COUNT(*) n FROM packages WHERE kind='Renewal' AND created_at>=? AND created_at<?", a, b).n;
  const churned = q.all("SELECT churn_reason FROM students WHERE stage='Churned' AND updated_at>=? AND updated_at<?", a, b);
  const renewalRate = renewals + churned.length ? renewals / (renewals + churned.length) : null;

  // Academics
  const stu = q.all('SELECT stage FROM students');
  const cls = q.all('SELECT status, duration_hours, hours_deducted FROM classes WHERE scheduled_at>=? AND scheduled_at<? AND scheduled_at<?', a, b, t);
  const held = cls.filter((c) => c.status === 'Completed').length;
  const marked = cls.filter((c) => c.status !== 'Scheduled').length;
  const studentAbs = cls.filter((c) => c.status.startsWith('Student Absent')).length;

  // Payouts
  const month = a.slice(0, 7);
  const payouts = q.all('SELECT net, currency, status FROM payouts WHERE month=?', month);
  const payoutTotal = money(payouts.map((p) => ({ amount: p.net, currency: p.currency })));
  const revenue = money(pays);

  return {
    range: { from: a, to: b, period },
    sales: {
      dials: calls.length, connected, notAnswered: calls.filter((x) => x.outcome === 'Not answered').length,
      whatsappSent: acts.filter((x) => x.type === 'whatsapp').length,
      whatsappReplied: acts.filter((x) => x.type === 'whatsapp' && x.outcome === 'Replied').length,
      notesPct: connected ? Math.round((noted / connected) * 100) : null,
      talkMinutes: talk, slaPct: assigned.length ? Math.round((withinSla / assigned.length) * 100) : null,
      followUpsOverdue: openFU.overdue || 0, followUpsDueToday: openFU.due_today || 0,
      followUpsDone: calls.length + acts.filter((x) => x.type === 'whatsapp').length,
    },
    pipeline: {
      newLeads: newLeads.length, bySource: by(newLeads, 'source'), byStage: Object.fromEntries(stageNow.map((r) => [r.stage, r.n])),
      leadToDemo: newLeads.length ? Math.round((demoReached / newLeads.length) * 100) : 0,
      leadToPaid: newLeads.length ? Math.round((converted / newLeads.length) * 100) : 0,
      demoToPaid: demoReached ? Math.round((converted / demoReached) * 100) : 0,
      expiringIn5Days: expiring, reassigned, lostByReason: by(newLeads.filter((l) => l.stage === 'Lost'), 'lost_reason'),
    },
    revenue: {
      total: revenue,
      new: money(pays.filter((p) => p.kind !== 'Renewal')), renewal: money(pays.filter((p) => p.kind === 'Renewal')),
      outstanding: money(outstanding), byRepAED: byRep, bySourceAED: bySource,
      mrrAED: money(last30).combinedAED,
      avgDealAED: pkgs.length ? +(pkgs.reduce((s, p) => s + toAED(p.price, p.currency), 0) / pkgs.length).toFixed(2) : 0,
    },
    retention: { dueForRenewal: due, renewals, renewalRate: renewalRate === null ? null : Math.round(renewalRate * 100), churned: churned.length, churnReasons: by(churned, 'churn_reason') },
    academics: {
      active: stu.filter((s) => s.stage === 'Active').length,
      unassigned: stu.filter((s) => s.stage === 'Awaiting Teacher').length,
      byStage: by(stu, 'stage'), classesHeld: held,
      attendancePct: marked ? Math.round(((marked - studentAbs - cls.filter((c) => c.status === 'Teacher Absent').length) / marked) * 100) : null,
      teacherAbsences: cls.filter((c) => c.status === 'Teacher Absent').length,
      hoursConsumed: +cls.reduce((s, c) => s + c.hours_deducted, 0).toFixed(2),
      unmarked: q.get("SELECT COUNT(*) n FROM classes WHERE status='Scheduled' AND scheduled_at<?", t).n,
    },
    payouts: {
      month, payable: payoutTotal,
      paid: money(payouts.filter((p) => p.status === 'Paid').map((p) => ({ amount: p.net, currency: p.currency }))),
      pending: money(payouts.filter((p) => p.status !== 'Paid').map((p) => ({ amount: p.net, currency: p.currency }))),
      pctOfRevenue: revenue.combinedAED ? Math.round((payoutTotal.combinedAED / revenue.combinedAED) * 100) : null,
    },
    exchangeRate: config.exchangeRate,
  };
}

// Section 12 monthly finance report incl. CAC and net margin.
function financeReport(month) {
  const [a, b] = require('./finance').monthRange(month);
  const pays = q.all(`SELECT p.*, pk.kind, pk.sold_by, l.source, s.country FROM payments p
    LEFT JOIN packages pk ON pk.id=p.package_id LEFT JOIN students s ON s.id=p.student_id LEFT JOIN leads l ON l.id=s.lead_id
    WHERE p.status IN ('Paid','Partial') AND p.paid_at>=? AND p.paid_at<?`, a, b);
  const group = (k) => {
    const m = {};
    for (const p of pays) { const key = p[k] || '—'; m[key] ||= []; m[key].push(p); }
    return Object.fromEntries(Object.entries(m).map(([key, rows]) => [key, money(rows)]));
  };
  const repNames = Object.fromEntries(q.all('SELECT id, name FROM users').map((u) => [u.id, u.name]));
  const byRep = Object.fromEntries(Object.entries(group('sold_by')).map(([k, v]) => [repNames[k] || '—', v]));
  const expenses = q.all('SELECT * FROM expenses WHERE month=?', month);
  const payouts = q.all('SELECT net amount, currency FROM payouts WHERE month=?', month);
  const refunds = q.all("SELECT amount, currency FROM payments WHERE status='Refunded' AND created_at>=? AND created_at<?", a, b);
  const revenue = money(pays);
  const adSpend = expenses.filter((e) => e.category === 'Ad Spend');
  const converted = q.all("SELECT source, COUNT(*) n FROM packages WHERE kind='New' AND created_at>=? AND created_at<? GROUP BY source", a, b);
  const cac = {};
  for (const e of adSpend) {
    const n = converted.find((c) => c.source === e.source)?.n || 0;
    cac[e.source || 'Unattributed'] = { spendAED: +toAED(e.amount, e.currency).toFixed(2), conversions: n, cacAED: n ? +(toAED(e.amount, e.currency) / n).toFixed(2) : null };
  }
  const exp = money(expenses);
  const pay = money(payouts);
  const ref = money(refunds);
  return {
    month, revenue, newRevenue: money(pays.filter((p) => p.kind !== 'Renewal')), renewalRevenue: money(pays.filter((p) => p.kind === 'Renewal')),
    byMarket: group('country'), bySource: group('source'), byRep, byPackageKind: group('kind'),
    outstanding: money(q.all("SELECT amount, currency FROM payments WHERE status='Pending'")),
    refunds: ref, payouts: pay, expenses: exp, cac,
    netMarginAED: +(revenue.combinedAED - ref.combinedAED - pay.combinedAED - exp.combinedAED).toFixed(2),
  };
}

module.exports = { dashboard, financeReport, range, money };

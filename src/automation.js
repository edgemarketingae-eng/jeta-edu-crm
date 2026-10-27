// Workflow rules / scheduled actions (section 15). Runs every minute; each rule is idempotent.
const leads = require('./services/leads');
const students = require('./services/students');
const finance = require('./services/finance');
const { q } = require('./db');
const { now } = require('./util');

function runAll() {
  const result = {
    leadRules: leads.runLeadRules(),
    followUps: leads.runFollowUpReminders(),
    students: students.runStudentRules(),
    finance: finance.runFinanceRules(),
  };
  require('./services/attendance').pullMeet().catch((e) => console.error('[meet]', e.message));
  const acc = require('./services/accountability');
  result.dailySummary = acc.runDailySummary();
  // Coaching check once a week (Monday, UTC).
  const wk = `coaching-check:${acc.weekBounds(0)[0].slice(0, 10)}`;
  if (new Date().getUTCDay() === 1 && !q.get('SELECT 1 FROM settings WHERE key=?', wk)) {
    q.run('INSERT INTO settings(key,value) VALUES(?,?)', wk, now());
    result.coaching = acc.runCoaching();
  }
  // Month-end: draft last month's payouts on the 1st (Admin reviews, Accounts approves).
  const d = new Date();
  const cycle = require('./services/settings').get('payouts').cycle;
  let prev = null;
  if (d.getUTCDate() === 1) {
    const pm = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    prev = cycle === 'fortnightly' ? `${pm}-H2` : pm;
  } else if (d.getUTCDate() === 16 && cycle === 'fortnightly') prev = `${d.toISOString().slice(0, 7)}-H1`;
  if (prev) {
    const key = `payouts-generated:${prev}`;
    if (!q.get('SELECT 1 FROM settings WHERE key=?', key)) {
      finance.generatePayouts(prev);
      q.run('INSERT INTO settings(key,value) VALUES(?,?)', key, now());
      require('./notify').notify({ role: 'admin', title: `Payout statements drafted for ${prev}`, body: 'Review adjustments, then send to Accounts', link: '#/payouts' });
      result.payouts = prev;
    }
  }
  return result;
}

function start(intervalMs = 60000) {
  const tick = () => { try { runAll(); } catch (e) { console.error('[automation]', e.message); } };
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runAll, start };

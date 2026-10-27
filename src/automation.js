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
  // Month-end: draft last month's payouts on the 1st (Admin reviews, Accounts approves).
  const d = new Date();
  if (d.getUTCDate() === 1) {
    const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
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

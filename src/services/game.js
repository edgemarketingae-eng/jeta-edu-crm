// Sales gamification: points, leaderboard, streaks, badges, team goal, wins feed and kudos.
// Everything is computed from work already logged in the CRM – nothing to enter twice.
const config = require('../config');
const { q, insert } = require('../db');
const { now, addDays, fail } = require('../util');
const { toAED } = require('./finance');
const { range } = require('./reports');

const G = config.game;
const P = G.points;

function settings() {
  const row = q.get("SELECT value FROM settings WHERE key='game'");
  return { ...G.defaults, ...(row ? JSON.parse(row.value) : {}) };
}
function saveSettings(body) {
  const cur = settings();
  const next = {
    dailyCallTarget: Math.max(1, Number(body.dailyCallTarget ?? cur.dailyCallTarget)),
    monthlyConversionGoal: Math.max(1, Number(body.monthlyConversionGoal ?? cur.monthlyConversionGoal)),
    monthlyRevenueGoalAED: Math.max(1, Number(body.monthlyRevenueGoalAED ?? cur.monthlyRevenueGoalAED)),
  };
  q.run("INSERT INTO settings(key,value) VALUES('game',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(next));
  return next;
}

const salesReps = () => q.all("SELECT id, name, market, role FROM users WHERE active=1 AND role IN ('sales_exec','sales_manager') ORDER BY name");

// Points for every rep in [from, to).
function score(from, to) {
  const reps = salesReps();
  const s = Object.fromEntries(reps.map((u) => [u.id, {
    user_id: u.id, name: u.name, market: u.market, role: u.role, points: 0,
    calls: 0, connected: 0, waReplies: 0, fastFirstCalls: 0, demos: 0, conversions: 0, renewals: 0, revenueAED: 0, kudos: 0,
    breakdown: { calls: 0, connected: 0, whatsapp: 0, speed: 0, demos: 0, conversions: 0, renewals: 0, kudos: 0 },
  }]));
  const add = (uid, key, pts, bucket) => { const r = s[uid]; if (!r) return; r.points += pts; r.breakdown[bucket] += pts; if (key) r[key] += 1; };

  // Calls – capped per lead per day so one lead can't be dialled for points.
  const seen = {};
  for (const c of q.all(`SELECT user_id, entity_id, substr(created_at,1,10) day, outcome FROM activities
      WHERE entity='lead' AND type='call' AND created_at>=? AND created_at<? ORDER BY created_at`, from, to)) {
    const k = `${c.user_id}:${c.entity_id}:${c.day}`;
    seen[k] = (seen[k] || 0) + 1;
    if (!s[c.user_id]) continue;
    s[c.user_id].calls += 1;
    if (seen[k] > G.maxCallsPerLeadPerDay) continue;
    add(c.user_id, null, P.call, 'calls');
    if (String(c.outcome).startsWith('Connected')) add(c.user_id, 'connected', P.connected, 'connected');
  }
  for (const w of q.all(`SELECT user_id FROM activities WHERE entity='lead' AND type='whatsapp' AND outcome='Replied' AND created_at>=? AND created_at<?`, from, to)) {
    add(w.user_id, 'waReplies', P.whatsappReply, 'whatsapp');
  }
  for (const l of q.all('SELECT owner_id, assigned_at, first_call_at FROM leads WHERE first_call_at>=? AND first_call_at<? AND assigned_at IS NOT NULL', from, to)) {
    if ((new Date(l.first_call_at) - new Date(l.assigned_at)) / 60000 <= config.sla.firstCallMinutes) add(l.owner_id, 'fastFirstCalls', P.fastFirstCall, 'speed');
  }
  for (const d of q.all(`SELECT user_id FROM activities WHERE entity='lead' AND type='stage' AND body LIKE '%→ Demo Scheduled%' AND created_at>=? AND created_at<?`, from, to)) {
    add(d.user_id, 'demos', P.demo, 'demos');
  }
  for (const p of q.all('SELECT sold_by, kind, price, currency FROM packages WHERE created_at>=? AND created_at<?', from, to)) {
    const aed = toAED(p.price, p.currency);
    if (!s[p.sold_by]) continue;
    s[p.sold_by].revenueAED += aed;
    if (p.kind === 'Renewal') add(p.sold_by, 'renewals', P.renewal + Math.floor(aed / 200) * P.renewalPer200AED, 'renewals');
    else add(p.sold_by, 'conversions', P.conversion + Math.floor(aed / 100) * P.conversionPer100AED, 'conversions');
  }
  for (const k of q.all('SELECT to_user FROM kudos WHERE created_at>=? AND created_at<?', from, to)) add(k.to_user, 'kudos', P.kudosReceived, 'kudos');

  return Object.values(s)
    .filter((r) => r.role === 'sales_exec' || r.points > 0) // managers appear only when they sell
    .map((r) => ({ ...r, revenueAED: Math.round(r.revenueAED), connectRate: r.calls ? Math.round((r.connected / r.calls) * 100) : null }));
}

function ranked(rows) {
  const sorted = [...rows].sort((a, b) => b.points - a.points || b.conversions - a.conversions || a.name.localeCompare(b.name));
  let last = null; let rank = 0;
  return sorted.map((r, i) => { if (r.points !== last) { rank = i + 1; last = r.points; } return { ...r, rank }; });
}

function leaderboard({ period = 'month', market } = {}) {
  const [a, b] = range(period);
  const len = new Date(b) - new Date(a);
  const prevA = new Date(new Date(a) - len).toISOString();
  const filter = (rows) => (market ? rows.filter((r) => r.market === market) : rows);
  const cur = ranked(filter(score(a, b)));
  const prev = ranked(filter(score(prevA, a)));
  const prevBy = Object.fromEntries(prev.map((r) => [r.user_id, r]));
  const rows = cur.map((r) => {
    const p = prevBy[r.user_id];
    const hadPrev = p && p.points > 0;
    return { ...r, prevRank: hadPrev ? p.rank : null, movement: hadPrev ? p.rank - r.rank : 0, prevPoints: p?.points ?? 0,
      streak: streak(r.user_id), badges: badges(r.user_id).filter((x) => x.earned).map((x) => x.id) };
  });
  const improved = rows.filter((r) => r.points - r.prevPoints > 0).sort((x, y) => (y.points - y.prevPoints) - (x.points - x.prevPoints))[0];
  return { period, from: a, to: b, rows, mostImproved: improved ? { user_id: improved.user_id, name: improved.name, gain: improved.points - improved.prevPoints } : null };
}

// Consecutive working days hitting the daily call target. Today counts once it is hit;
// until then the streak shows yesterday's run (it isn't "broken" mid-day).
function streak(userId) {
  const target = settings().dailyCallTarget;
  const u = q.get('SELECT market FROM users WHERE id=?', userId);
  const off = G.weekend[u?.market] || G.weekend.UAE;
  const byDay = Object.fromEntries(q.all(`SELECT substr(created_at,1,10) d, COUNT(*) n FROM activities
    WHERE user_id=? AND entity='lead' AND type='call' AND created_at>=? GROUP BY d`, userId, addDays(now(), -90)).map((r) => [r.d, r.n]));
  let n = 0;
  for (let i = 0; i < 90; i++) {
    const day = addDays(now(), -i).slice(0, 10);
    if (off.includes(new Date(`${day}T12:00:00Z`).getUTCDay())) continue;
    const hit = (byDay[day] || 0) >= target;
    if (i === 0 && !hit) continue;
    if (!hit) break;
    n++;
  }
  return n;
}

const BADGES = [
  ['first_win', 'First win', 'Convert your first student'],
  ['speedster', 'Speedster', 'Call 10 new leads within 5 minutes of assignment'],
  ['closer', 'Closer', '5 conversions in a month'],
  ['hat_trick', 'Hat-trick', '3 conversions in one day'],
  ['on_fire', 'On fire', '5-day call streak'],
  ['renewal_hero', 'Renewal hero', '3 renewals in a month'],
  ['connector', 'Connector', '60%+ connect rate on 30+ calls this week'],
  ['inbox_zero', 'Inbox zero', 'No overdue follow-ups with 5+ open leads'],
  ['team_player', 'Team player', 'Give 5 kudos in a month'],
];

function badges(userId) {
  const t = now();
  const [m0] = range('month');
  const [w0] = range('week');
  const conv = q.get("SELECT COUNT(*) n FROM packages WHERE sold_by=? AND kind='New'", userId).n;
  const convMonth = q.get("SELECT COUNT(*) n FROM packages WHERE sold_by=? AND kind='New' AND created_at>=?", userId, m0).n;
  const bestDay = q.get("SELECT COALESCE(MAX(n),0) n FROM (SELECT COUNT(*) n FROM packages WHERE sold_by=? AND kind='New' GROUP BY substr(created_at,1,10))", userId).n;
  const renewMonth = q.get("SELECT COUNT(*) n FROM packages WHERE sold_by=? AND kind='Renewal' AND created_at>=?", userId, m0).n;
  const fast = q.all('SELECT assigned_at, first_call_at FROM leads WHERE owner_id=? AND first_call_at IS NOT NULL AND assigned_at IS NOT NULL', userId)
    .filter((l) => (new Date(l.first_call_at) - new Date(l.assigned_at)) / 60000 <= 5).length;
  const wk = q.get(`SELECT COUNT(*) calls, SUM(CASE WHEN outcome LIKE 'Connected%' THEN 1 ELSE 0 END) conn FROM activities
    WHERE user_id=? AND entity='lead' AND type='call' AND created_at>=?`, userId, w0);
  const open = q.get("SELECT COUNT(*) n FROM leads WHERE owner_id=? AND stage NOT IN ('Converted','Lost','Nurture')", userId).n;
  const overdue = q.get("SELECT COUNT(*) n FROM leads WHERE owner_id=? AND stage NOT IN ('Converted','Lost') AND next_follow_up_at < ?", userId, t).n;
  const given = q.get('SELECT COUNT(*) n FROM kudos WHERE from_user=? AND created_at>=?', userId, m0).n;
  const st = streak(userId);
  const prog = {
    first_win: [conv, 1], speedster: [fast, 10], closer: [convMonth, 5], hat_trick: [bestDay, 3], on_fire: [st, 5],
    renewal_hero: [renewMonth, 3], connector: [wk.calls >= 30 ? Math.round(((wk.conn || 0) / wk.calls) * 100) : 0, 60],
    inbox_zero: [open >= 5 && overdue === 0 ? 1 : 0, 1], team_player: [given, 5],
  };
  return BADGES.map(([id, name, desc]) => {
    const [have, need] = prog[id];
    return { id, name, desc, earned: have >= need, progress: Math.min(have, need), need };
  });
}

function teamGoal() {
  const g = settings();
  const [m0, m1] = range('month');
  const conversions = q.get("SELECT COUNT(*) n FROM packages WHERE kind='New' AND created_at>=? AND created_at<?", m0, m1).n;
  const revenueAED = Math.round(q.all("SELECT amount, currency FROM payments WHERE status IN ('Paid','Partial') AND paid_at>=? AND paid_at<?", m0, m1)
    .reduce((s, p) => s + toAED(p.amount, p.currency), 0));
  const d = new Date();
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return { month: m0.slice(0, 7), conversions, conversionGoal: g.monthlyConversionGoal, revenueAED, revenueGoalAED: g.monthlyRevenueGoalAED,
    monthPct: Math.round((d.getUTCDate() / daysInMonth) * 100) };
}

// Personal card: rank, points, gap to the next person up, streak, today's progress, badges.
function me(user) {
  const board = leaderboard({ period: 'month' });
  const mine = board.rows.find((r) => r.user_id === user.id);
  const above = mine ? board.rows.filter((r) => r.points > mine.points).sort((a, b) => a.points - b.points)[0] : null;
  const week = leaderboard({ period: 'week' }).rows.find((r) => r.user_id === user.id);
  const [d0] = range('today');
  const callsToday = q.get("SELECT COUNT(*) n FROM activities WHERE user_id=? AND entity='lead' AND type='call' AND created_at>=?", user.id, d0).n;
  // Personal best: best month of the last six.
  let best = 0;
  for (let i = 1; i <= 6; i++) {
    const d = new Date();
    const a = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString();
    const b = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i + 1, 1)).toISOString();
    best = Math.max(best, score(a, b).find((r) => r.user_id === user.id)?.points || 0);
  }
  return {
    onBoard: !!mine, rank: mine?.rank ?? null, of: board.rows.length, points: mine?.points ?? 0, breakdown: mine?.breakdown,
    weekRank: week?.rank ?? null, movement: mine?.movement ?? 0,
    next: above ? { name: above.name, rank: above.rank, gap: above.points - mine.points + 1 } : null,
    streak: streak(user.id), callsToday, dailyCallTarget: settings().dailyCallTarget,
    personalBest: best, badges: badges(user.id),
  };
}

// Recent wins (conversions, renewals, demos) with kudos.
function feed(user, limit = 30) {
  const since = addDays(now(), -14);
  const wins = [
    ...q.all(`SELECT 'conversion' kind, p.id ref_id, p.sold_by user_id, p.created_at at, s.child_name, p.hours, p.price, p.currency, p.kind pkind
      FROM packages p JOIN students s ON s.id=p.student_id WHERE p.created_at>=?`, since).map((w) => ({ ...w, kind: w.pkind === 'Renewal' ? 'renewal' : 'conversion' })),
    ...q.all(`SELECT 'demo' kind, a.id ref_id, a.user_id, a.created_at at, l.child_name, l.parent_name FROM activities a JOIN leads l ON l.id=a.entity_id
      WHERE a.entity='lead' AND a.type='stage' AND a.body LIKE '%→ Demo Scheduled%' AND a.created_at>=?`, since),
  ].filter((w) => w.user_id).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit);
  const names = Object.fromEntries(q.all('SELECT id, name FROM users').map((u) => [u.id, u.name]));
  return wins.map((w) => {
    const k = q.all('SELECT from_user FROM kudos WHERE kind=? AND ref_id=?', w.kind, w.ref_id);
    return { ...w, name: names[w.user_id], kudos: k.length, gave: k.some((x) => x.from_user === user.id), mine: w.user_id === user.id,
      points: w.kind === 'demo' ? P.demo : w.kind === 'renewal' ? P.renewal + Math.floor(toAED(w.price, w.currency) / 200) : P.conversion + Math.floor(toAED(w.price, w.currency) / 100) };
  });
}

function giveKudos(user, { kind, ref_id }) {
  let to;
  if (kind === 'demo') to = q.get("SELECT user_id FROM activities WHERE id=? AND type='stage'", ref_id)?.user_id;
  else if (['conversion', 'renewal'].includes(kind)) to = q.get('SELECT sold_by FROM packages WHERE id=?', ref_id)?.sold_by;
  if (!to) fail(404, 'Win not found');
  if (to === user.id) fail(400, "You can't give kudos to yourself");
  if (q.get('SELECT 1 FROM kudos WHERE from_user=? AND kind=? AND ref_id=?', user.id, kind, ref_id)) fail(400, 'Kudos already given');
  insert('kudos', { from_user: user.id, to_user: to, kind, ref_id: Number(ref_id), created_at: now() });
  require('../notify').notify({ userId: to, title: `${user.name} gave you kudos`, body: `For your ${kind}`, link: '#/leaderboard' });
  return { ok: true };
}

module.exports = { settings, saveSettings, score, leaderboard, streak, badges, teamGoal, me, feed, giveKudos, BADGES };

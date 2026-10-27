// Phone metrics tracker (blueprint 6): Android app on company phones, or a cloud telephony provider.
// Privacy: the CRM only ever receives calls to/from numbers that already exist in the CRM.
// The app downloads SHA-256 hashes of the rep's lead numbers and filters personal calls on the device.
const crypto = require('crypto');
const config = require('../config');
const { q, insert, update } = require('../db');
const { now, addMinutes, fail, log, task, normalizePhone } = require('../util');
const { notify } = require('../notify');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function createPairing(user, name) {
  const code = String(crypto.randomInt(100000, 999999));
  const id = insert('devices', { user_id: user.id, name: name || 'Android phone', pair_code: code, pair_expires: addMinutes(now(), 10), created_at: now() });
  return { device_id: id, code, expires_at: addMinutes(now(), 10) };
}

function pairDevice({ code, device_name, platform }) {
  const d = q.get('SELECT * FROM devices WHERE pair_code=? AND pair_expires>? AND revoked=0 AND token_hash IS NULL', String(code || ''), now());
  if (!d) fail(400, 'Pairing code is wrong or expired – create a new one in the CRM');
  const token = crypto.randomBytes(32).toString('hex');
  update('devices', d.id, { token_hash: sha(token), pair_code: null, pair_expires: null, paired_at: now(), last_seen: now(),
    name: device_name || d.name, platform: platform || 'android' });
  const u = q.get('SELECT id, name, market FROM users WHERE id=?', d.user_id);
  return { token, device_id: d.id, user: u, connected_seconds: config.tracker.connectedSeconds };
}

// Express middleware for device-authenticated routes.
function deviceAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = req.headers['x-device-token'] || (h.startsWith('Device ') ? h.slice(7) : null);
  if (!token) return res.status(401).json({ error: 'Device token missing' });
  const d = q.get('SELECT * FROM devices WHERE token_hash=? AND revoked=0', sha(token));
  if (!d) return res.status(401).json({ error: 'Device not paired or revoked' });
  const u = q.get('SELECT * FROM users WHERE id=? AND active=1', d.user_id);
  if (!u) return res.status(401).json({ error: 'User inactive' });
  q.run('UPDATE devices SET last_seen=? WHERE id=?', now(), d.id);
  req.device = d; req.user = u;
  const store = require('../context').als.getStore(); if (store) store.userId = u.id;
  next();
}

// Hashes of every number this rep may call: own open leads + students they own for retention.
function numberHashes(user) {
  const leads = q.all("SELECT phone_norm FROM leads WHERE owner_id=? AND archived=0 AND phone_norm IS NOT NULL", user.id).map((r) => r.phone_norm);
  const students = q.all('SELECT phone, country FROM students WHERE retention_owner_id=?', user.id).map((r) => normalizePhone(r.phone, r.country));
  return { default_country: user.market || 'UAE', hashes: [...new Set([...leads, ...students].filter(Boolean))].map(sha) };
}

function matchNumber(norm, userId) {
  const own = q.get('SELECT * FROM leads WHERE phone_norm=? AND archived=0 AND owner_id=? LIMIT 1', norm, userId);
  if (own) return { lead: own };
  const anyLead = q.get('SELECT * FROM leads WHERE phone_norm=? AND archived=0 LIMIT 1', norm);
  if (anyLead) return { lead: anyLead };
  const st = q.all('SELECT * FROM students WHERE retention_owner_id=? OR ?=0', userId, 0).find((s) => normalizePhone(s.phone, s.country) === norm);
  return st ? { student: st } : {};
}

// events: [{ event_id, number, direction: outgoing|incoming|missed, started_at, duration_sec, sim }]
function ingest(user, events, { deviceId = 0, source = 'tracker', recording = {} } = {}) {
  if (!Array.isArray(events)) fail(400, 'events must be an array');
  const out = { received: events.length, stored: 0, duplicates: 0, ignored: 0 };
  const L = require('./leads');
  for (const e of events.slice(0, 500)) {
    if (!e || !e.event_id || !e.number || !e.started_at) { out.ignored++; continue; }
    if (q.get('SELECT 1 FROM phone_events WHERE source=? AND device_id=? AND event_id=?', source, deviceId, String(e.event_id))) { out.duplicates++; continue; }
    const norm = normalizePhone(e.number, user.market);
    const m = matchNumber(norm, user.id);
    if (!m.lead && !m.student) { out.ignored++; continue; } // not a CRM number: never stored
    const dir = ['outgoing', 'incoming', 'missed'].includes(e.direction) ? e.direction : 'outgoing';
    const dur = Math.max(0, Math.round(Number(e.duration_sec) || 0));
    const started = new Date(e.started_at).toISOString();
    const connected = dir !== 'missed' && dur >= config.tracker.connectedSeconds;
    const meta = { duration_sec: dur, duration_min: Math.round(dur / 6) / 10, sim: e.sim || null, tracked: true, recording_url: e.recording_url || recording[e.event_id] || null };
    let activityId = null;

    if (m.lead) {
      const lead = m.lead;
      if (dir === 'missed') {
        activityId = log('lead', lead.id, 'system', `Missed call from parent at ${started.slice(11, 16)} UTC`, { userId: user.id, extra: { direction: 'inbound', source } });
        task({ entity: 'lead', entity_id: lead.id, title: `Call back ${lead.parent_name} (missed call)`, type: 'call', assignee_id: lead.owner_id || user.id, due_at: addMinutes(now(), 15), priority: 'High' });
        notify({ userId: lead.owner_id || user.id, title: 'Missed call from a lead', body: `${lead.parent_name} called – call back`, link: `#/leads/${lead.id}`, channels: ['app', 'whatsapp'] });
      } else if (connected) {
        // Pre-created entry; the rep adds outcome + notes within 10 minutes (blueprint 5.2).
        const due = addMinutes(new Date(Math.max(Date.now(), new Date(started).getTime() + dur * 1000)).toISOString(), config.interaction.noteDueMinutes);
        activityId = log('lead', lead.id, 'call', '', { userId: user.id, outcome: 'Connected', meta,
          extra: { direction: dir === 'incoming' ? 'inbound' : 'outbound', source, needs_note: 1, note_due_at: due } });
        const patch = { last_contacted_at: started, updated_at: now(), attempt_count: 0 };
        if (!lead.first_call_at && dir === 'outgoing') patch.first_call_at = started;
        if (['New', 'Attempted'].includes(lead.stage)) patch.stage = 'Contacted';
        update('leads', lead.id, patch);
        if (patch.stage) log('lead', lead.id, 'stage', `${lead.stage} → Contacted (tracked call)`, { userId: user.id });
        notify({ userId: user.id, title: 'Add notes for your call', body: `${lead.parent_name} · ${Math.round(dur / 60)} min – within 10 minutes`, link: `#/leads/${lead.id}?complete=${activityId}`, dedupe: `trk:${activityId}` });
      } else if (dir === 'outgoing') {
        // Not answered: runs the normal not-connected automation (WhatsApp task + retry schedule).
        if (!lead.first_call_at) update('leads', lead.id, { first_call_at: started });
        L.logCall(lead.id, { outcome: 'Not answered', source, notes: `Tracked call, ${dur}s` }, user);
        activityId = q.get("SELECT id FROM activities WHERE entity='lead' AND entity_id=? AND type='call' ORDER BY id DESC LIMIT 1", lead.id)?.id;
        if (activityId) q.run('UPDATE activities SET meta=?, source=? WHERE id=?', JSON.stringify(meta), source, activityId);
      } else {
        activityId = log('lead', lead.id, 'call', `Short incoming call (${dur}s)`, { userId: user.id, outcome: 'Not answered', meta, extra: { direction: 'inbound', source } });
      }
    } else {
      activityId = log('student', m.student.id, dir === 'missed' ? 'system' : 'call',
        dir === 'missed' ? 'Missed call from parent' : `${dir === 'incoming' ? 'Incoming' : 'Outgoing'} call · ${Math.round(dur / 60)} min`,
        { userId: user.id, outcome: connected ? 'Connected' : dir === 'missed' ? null : 'Not answered', meta, extra: { direction: dir === 'incoming' || dir === 'missed' ? 'inbound' : 'outbound', source } });
    }
    insert('phone_events', { device_id: deviceId, user_id: user.id, event_id: String(e.event_id), number_norm: norm, direction: dir,
      started_at: started, duration_sec: dur, sim: e.sim || null, lead_id: m.lead?.id || null, student_id: m.student?.id || null,
      activity_id: activityId, source, recording_url: meta.recording_url, created_at: now() });
    out.stored++;
  }
  return out;
}

// Cloud telephony provider webhook (alternative to the app): one call per request or { calls: [...] }.
function telephony(body) {
  const calls = Array.isArray(body.calls) ? body.calls : [body];
  const res = { stored: 0, ignored: 0, unknownAgents: 0 };
  for (const c of calls) {
    const u = q.get('SELECT * FROM users WHERE active=1 AND (lower(email)=lower(?) OR phone=?)', c.agent_email || '', c.agent_phone || '');
    if (!u) { res.unknownAgents++; continue; }
    const r = ingest(u, [{ event_id: c.event_id || c.call_id, number: c.number || c.customer_number, direction: c.direction, started_at: c.started_at || c.start_time,
      duration_sec: c.duration_sec ?? c.duration, recording_url: c.recording_url }], { source: 'telephony' });
    res.stored += r.stored; res.ignored += r.ignored;
  }
  return res;
}

function devices(user, all) {
  return q.all(`SELECT d.id, d.name, d.platform, d.paired_at, d.last_seen, d.revoked, d.created_at, d.pair_expires, d.pair_code IS NOT NULL pending, u.name user_name, d.user_id,
      (SELECT COUNT(*) FROM phone_events p WHERE p.device_id=d.id) events
    FROM devices d JOIN users u ON u.id=d.user_id WHERE ${all ? '1=1' : 'd.user_id=?'} AND (d.token_hash IS NOT NULL OR d.pair_expires > ?) ORDER BY d.id DESC`,
  ...(all ? [] : [user.id]), now());
}
function revoke(id, user, isManager) {
  const d = q.get('SELECT * FROM devices WHERE id=?', id) || fail(404, 'Device not found');
  if (!isManager && d.user_id !== user.id) fail(403, 'Not your device');
  update('devices', id, { revoked: 1 });
  return { ok: true };
}

// Call analytics (blueprint 6.5) – manual and tracked calls together; tracker-only metrics where noted.
function callMetrics({ from, to, userId, tz = 'Asia/Dubai' }) {
  const offset = { 'Asia/Dubai': 240, 'Asia/Kolkata': 330 }[tz] ?? 240;
  const calls = q.all(`SELECT a.user_id, a.entity_id, a.outcome, a.meta, a.created_at, a.needs_note, a.source FROM activities a
    WHERE a.entity='lead' AND a.type='call' AND a.created_at>=? AND a.created_at<? ${userId ? 'AND a.user_id=?' : ''} ORDER BY a.created_at`,
  from, to, ...(userId ? [userId] : []));
  const isConn = (c) => String(c.outcome).startsWith('Connected');
  const dur = (c) => { const m = JSON.parse(c.meta || '{}'); return m.duration_sec ? m.duration_sec / 60 : (m.duration_min || 0); };
  const connected = calls.filter(isConn);
  const talk = connected.reduce((s, c) => s + dur(c), 0);
  const byHour = {};
  for (const c of calls) {
    const h = new Date(new Date(c.created_at).getTime() + offset * 60000).getUTCHours();
    byHour[h] ||= { calls: 0, connected: 0 };
    byHour[h].calls++; if (isConn(c)) byHour[h].connected++;
  }
  const hours = Object.entries(byHour).filter(([, v]) => v.calls >= 3).map(([h, v]) => ({ hour: Number(h), rate: Math.round((v.connected / v.calls) * 100), calls: v.calls }))
    .sort((a, b) => b.rate - a.rate);
  // First call of the day and idle gaps (per rep per day, working hours)
  const days = {};
  for (const c of calls) { const k = `${c.user_id}|${c.created_at.slice(0, 10)}`; (days[k] ||= []).push(new Date(c.created_at).getTime()); }
  const firsts = []; const gaps = [];
  for (const ts of Object.values(days)) {
    ts.sort((a, b) => a - b);
    firsts.push(((new Date(ts[0]).getUTCHours() * 60 + new Date(ts[0]).getUTCMinutes() + offset) % 1440));
    let maxGap = 0;
    for (let i = 1; i < ts.length; i++) maxGap = Math.max(maxGap, (ts[i] - ts[i - 1]) / 60000);
    if (ts.length > 1) gaps.push(maxGap);
  }
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const fmtMin = (m) => (m === null ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`);
  const missed = q.get(`SELECT COUNT(*) n FROM phone_events WHERE direction='missed' AND started_at>=? AND started_at<? ${userId ? 'AND user_id=?' : ''}`, from, to, ...(userId ? [userId] : [])).n;
  const tracked = calls.filter((c) => c.source === 'tracker' || c.source === 'telephony').length;
  // Calls per lead before conversion (leads converted in range)
  const conv = q.all(`SELECT l.id, l.updated_at FROM leads l WHERE l.stage='Converted' AND l.updated_at>=? AND l.updated_at<? ${userId ? 'AND l.owner_id=?' : ''}`, from, to, ...(userId ? [userId] : []));
  const cpl = conv.map((l) => q.get("SELECT COUNT(*) n FROM activities WHERE entity='lead' AND entity_id=? AND type='call'", l.id).n);
  return {
    dials: calls.length, connected: connected.length, notAnswered: calls.length - connected.length, missedIncoming: missed,
    uniqueLeads: new Set(calls.map((c) => c.entity_id)).size, talkMinutes: Math.round(talk), avgCallMinutes: connected.length ? +(talk / connected.length).toFixed(1) : null,
    missingNotes: q.get(`SELECT COUNT(*) n FROM activities WHERE needs_note=1 ${userId ? 'AND user_id=?' : ''}`, ...(userId ? [userId] : [])).n,
    firstCallAvg: fmtMin(avg(firsts)), maxIdleGapAvgMin: gaps.length ? Math.round(avg(gaps)) : null,
    bestHours: hours.slice(0, 3).map((h) => ({ ...h, label: `${String(h.hour).padStart(2, '0')}:00–${String((h.hour + 1) % 24).padStart(2, '0')}:00` })),
    callsPerConversion: cpl.length ? +(avg(cpl)).toFixed(1) : null, trackedShare: calls.length ? Math.round((tracked / calls.length) * 100) : 0,
  };
}

module.exports = { createPairing, pairDevice, deviceAuth, numberHashes, ingest, telephony, devices, revoke, callMetrics, sha };

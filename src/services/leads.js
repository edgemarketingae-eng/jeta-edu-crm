// Lead module: auto-assignment, call/WhatsApp logging, follow-up engine, stage gating (Blueprint),
// 30-day reassignment, KYC and conversion.
const config = require('../config');
const { q, insert, update } = require('../db');
const { now, addMinutes, addDays, daysBetween, fail, log, task, nextCode, normalizePhone } = require('../util');
const { writeAudit } = require('../db');
const { notify, sendExternal } = require('../notify');

const getLead = (id) => q.get('SELECT * FROM leads WHERE id=?', id) || fail(404, 'Lead not found');

function overdueCount(userId) {
  return q.get(
    `SELECT COUNT(*) n FROM leads WHERE owner_id=? AND archived=0 AND next_follow_up_at < ? AND stage NOT IN ('Converted','Lost')`,
    userId, now(),
  ).n;
}
const openCount = (userId) => q.get("SELECT COUNT(*) n FROM leads WHERE owner_id=? AND archived=0 AND stage NOT IN ('Converted','Lost','Nurture')", userId).n;

function assignmentMode() {
  const r = q.get("SELECT value FROM settings WHERE key='assignment'");
  return (r && JSON.parse(r.value).mode) || 'round_robin';
}

// Round-robin (or least-open-leads) among active sales staff in the lead's market.
// Reps over the overdue limit are skipped until they clear their list.
function pickRep(market, exclude = []) {
  const mode = assignmentMode();
  const pool = (m) => q.all(
    `SELECT * FROM users WHERE active=1 AND role='sales_exec' ${m ? 'AND market=?' : ''}
     ORDER BY COALESCE(last_assigned_at,'') ASC, id ASC`, ...(m ? [m] : []),
  ).filter((u) => !exclude.includes(u.id) && overdueCount(u.id) <= config.followUp.overdueBlockLimit)
    .map((u) => ({ ...u, open: mode === 'least_open' ? openCount(u.id) : 0 }))
    .sort((a, b) => a.open - b.open); // stable: keeps round-robin order on ties
  return pool(market)[0] || pool(null)[0] || null;
}

// ---------- follow-up records (for on-time % on scorecards) ----------
// Called whenever a lead's next follow-up changes. byInteraction = the rep actually contacted the lead.
function trackFollowUp(leadId, { at, type, byInteraction }) {
  const t = now();
  const open = q.get("SELECT * FROM follow_ups WHERE lead_id=? AND status='Open' ORDER BY id DESC LIMIT 1", leadId);
  if (open) {
    if (byInteraction) {
      q.run("UPDATE follow_ups SET status='Done', done_at=?, on_time=? WHERE id=?", t, t <= addMinutes(open.due_at, 60) ? 1 : 0, open.id);
      q.run("UPDATE escalations SET status='Resolved', resolved_at=? WHERE entity='lead' AND entity_id=? AND status='Open'", t, leadId);
    }
    else if (!at || at !== open.due_at) q.run("UPDATE follow_ups SET status=? WHERE id=?", at ? 'Rescheduled' : 'Closed', open.id);
    else return; // unchanged
  }
  if (at) {
    const l = q.get('SELECT owner_id FROM leads WHERE id=?', leadId);
    insert('follow_ups', { lead_id: leadId, owner_id: l?.owner_id, due_at: at, type: type || 'call', set_at: t });
  }
}

// ---------- duplicates ----------
function findDuplicate(phone, country, excludeId = 0) {
  const n = normalizePhone(phone, country);
  if (!n) return null;
  return q.get(`SELECT l.id, l.code, l.parent_name, l.stage, l.owner_id, u.name owner_name FROM leads l LEFT JOIN users u ON u.id=l.owner_id
    WHERE l.phone_norm=? AND l.archived=0 AND l.id<>? ORDER BY l.id LIMIT 1`, n, excludeId);
}

function assign(lead, rep, { reason, byUserId = null } = {}) {
  const t = now();
  update('leads', lead.id, {
    owner_id: rep.id, assigned_at: t, expiry_warned: 0, sla_breached: 0, updated_at: t,
    reassignment_count: lead.owner_id ? lead.reassignment_count + 1 : lead.reassignment_count,
  });
  update('users', rep.id, { last_assigned_at: t });
  q.run("UPDATE follow_ups SET owner_id=? WHERE lead_id=? AND status='Open'", rep.id, lead.id);
  if (lead.owner_id) {
    const from = q.get('SELECT name FROM users WHERE id=?', lead.owner_id)?.name || '—';
    log('lead', lead.id, 'reassign', `Reassigned from ${from} to ${rep.name} – reason: ${reason}`, { userId: byUserId });
  } else {
    log('lead', lead.id, 'system', `Assigned to ${rep.name} (${reason})`, { userId: byUserId });
  }
  notify({
    userId: rep.id, title: `New lead: ${lead.parent_name}`,
    body: `Call within ${config.sla.firstCallMinutes} min. ${lead.phone}`, link: `#/leads/${lead.id}`,
    channels: ['app', 'whatsapp', 'email'],
  });
}

function createLead(data, user) {
  if (!data.source || !config.leadSources.includes(data.source)) fail(400, 'Lead source is mandatory');
  if (!data.parent_name || !data.phone) fail(400, 'Parent name and phone are required');
  if (data.source === 'Referral' && !data.referral_by) fail(400, 'Referral leads need the referrer name');
  const country = data.country === 'India' ? 'India' : 'UAE';
  const phoneNorm = normalizePhone(data.phone, country);
  if (phoneNorm.length < 8) fail(400, 'Enter a valid phone number with country code');
  const dupe = findDuplicate(data.phone, country);
  if (dupe) {
    fail(409, `This number already belongs to lead ${dupe.code} (${dupe.parent_name}), owned by ${dupe.owner_name || 'nobody yet'}.`, { duplicate: dupe });
  }
  const id = insert('leads', {
    phone_norm: phoneNorm,
    code: nextCode('leads', 'LD'),
    source: data.source, campaign: data.campaign, ad_set: data.ad_set, utm: data.utm, referral_by: data.referral_by,
    parent_name: data.parent_name, phone: data.phone, is_whatsapp: data.is_whatsapp ?? 1,
    email: data.email, city: data.city, child_name: data.child_name, grade: data.grade,
    board: data.board, subjects: data.subjects, country, currency: config.currencyByCountry[country],
    score: data.score || 'Warm', stage: 'New', created_at: now(), updated_at: now(),
  });
  log('lead', id, 'system', `Lead created from ${data.source}${data.campaign ? ` / ${data.campaign}` : ''}`, { userId: user?.id });

  const lead = getLead(id);
  const ownerId = data.owner_id && user && ['owner', 'sales_manager'].includes(user.role) ? Number(data.owner_id) : null;
  const rep = ownerId ? q.get('SELECT * FROM users WHERE id=?', ownerId) : pickRep(country);
  if (rep) assign(lead, rep, { reason: ownerId ? 'manual' : `${assignmentMode() === 'least_open' ? 'least open leads' : 'round-robin'} ${country}`, byUserId: user?.id });
  else notify({ role: 'manager', title: 'Unassigned lead', body: `${lead.parent_name}: no eligible rep`, link: `#/leads/${id}` });
  return getLead(id);
}

function requireFollowUp(at, type) {
  if (!at) fail(400, 'Next follow-up date & time is required');
  if (Number.isNaN(Date.parse(at))) fail(400, 'Invalid follow-up date');
  if (!['call', 'whatsapp', 'demo', 'payment'].includes(type || 'call')) fail(400, 'Invalid follow-up type');
}

function setFollowUp(leadId, at, type, user) {
  requireFollowUp(at, type);
  const iso = new Date(at).toISOString();
  update('leads', leadId, { next_follow_up_at: iso, next_follow_up_type: type || 'call', updated_at: now(), escalated: 0 });
  trackFollowUp(leadId, { at: iso, type });
  log('lead', leadId, 'system', `Follow-up set: ${type || 'call'} at ${iso}`, { userId: user?.id });
}

// Blueprint gating for stage changes.
function changeStage(leadId, body, user) {
  const lead = getLead(leadId);
  const stage = body.stage;
  if (!config.leadStages.includes(stage)) fail(400, 'Unknown stage');
  if (stage === lead.stage) return lead;
  if (stage === 'Converted') fail(400, 'Use Convert – the conversion checklist must be completed');
  if (lead.stage === 'Converted') fail(400, 'Converted leads are locked');
  const patch = { stage, updated_at: now() };
  if (stage === 'Lost') {
    if (!config.lostReasons.includes(body.lost_reason)) fail(400, 'Lost reason is mandatory');
    patch.lost_reason = body.lost_reason;
    patch.next_follow_up_at = null;
  } else {
    requireFollowUp(body.follow_up_at, body.follow_up_type);
    patch.next_follow_up_at = new Date(body.follow_up_at).toISOString();
    patch.next_follow_up_type = body.follow_up_type || 'call';
  }
  if (stage === 'Demo Scheduled') {
    if (!body.demo_at) fail(400, 'Demo date & time is required');
    patch.demo_at = new Date(body.demo_at).toISOString();
  }
  patch.escalated = 0;
  update('leads', leadId, patch);
  trackFollowUp(leadId, { at: patch.next_follow_up_at, type: patch.next_follow_up_type });
  log('lead', leadId, 'stage', `${lead.stage} → ${stage}${patch.lost_reason ? ` (${patch.lost_reason})` : ''}`, { userId: user.id });
  return getLead(leadId);
}

// Section 4: mandatory call outcome with automatic actions.
function logCall(leadId, body, user) {
  const lead = getLead(leadId);
  const rule = config.callOutcomes[body.outcome];
  if (!rule) fail(400, 'Call outcome is mandatory');
  const t = now();
  const patch = { last_contacted_at: t, updated_at: t };
  if (!lead.first_call_at) patch.first_call_at = t;

  if (rule.requiresFollowUp) requireFollowUp(body.follow_up_at, body.follow_up_type);
  if (rule.requiresLostReason) {
    const to = body.move_to === 'Nurture' ? 'Nurture' : 'Lost';
    if (to === 'Lost' && !config.lostReasons.includes(body.lost_reason)) fail(400, 'Lost reason is required');
    if (to === 'Nurture' && !body.follow_up_at) fail(400, 'Nurture needs a revisit date');
  }
  // Blueprint 5.2: a connected call cannot be closed without a proper note.
  const notes = String(body.notes || '').trim();
  if (!rule.failed && !noteLongEnough(notes)) {
    fail(400, `Write what was said – at least 2 lines or ${config.interaction.minConnectedNoteChars} characters for a connected call`);
  }
  const meta = {
    duration_min: Number(body.duration_min) || 0,
    objections: normList(body.objections, config.interaction.objections),
    sentiment: config.interaction.sentiments.includes(body.sentiment) ? body.sentiment : null,
    next_step: body.next_step || null,
  };
  const direction = body.direction === 'inbound' ? 'inbound' : 'outbound';
  // Completing a call the phone tracker already recorded: fill in that entry instead of adding a second call.
  const tracked = body.activity_id
    ? q.get("SELECT * FROM activities WHERE id=? AND entity='lead' AND entity_id=? AND type='call' AND needs_note=1", body.activity_id, leadId)
    : null;
  if (tracked) {
    const tmeta = JSON.parse(tracked.meta || '{}');
    q.run('UPDATE activities SET body=?, outcome=?, meta=?, needs_note=0, user_id=COALESCE(user_id, ?) WHERE id=?',
      notes, body.outcome, JSON.stringify({ ...tmeta, ...meta, duration_min: tmeta.duration_min || meta.duration_min }), user.id, tracked.id);
    q.run('UPDATE leads SET last_action_at=? WHERE id=?', t, leadId);
  } else {
    log('lead', leadId, 'call', notes, { userId: user.id, outcome: body.outcome, meta, extra: { direction, source: body.source || 'manual' } });
  }

  if (rule.failed) {
    const attempts = lead.attempt_count + 1;
    patch.attempt_count = attempts;
    const first = lead.first_call_at || t;
    if (rule.flag) {
      patch.flagged = 1; patch.flag_reason = 'Wrong number';
      notify({ role: 'manager', title: 'Wrong number flagged', body: `${lead.parent_name} (${lead.code})`, link: `#/leads/${leadId}`, dedupe: `wrong:${leadId}` });
    } else if (attempts >= config.maxFailedAttempts) {
      patch.stage = 'Nurture';
      patch.next_follow_up_at = addDays(t, 14);
      patch.next_follow_up_type = 'call';
      log('lead', leadId, 'stage', `${lead.stage} → Nurture (${attempts} failed attempts)`);
      notify({ role: 'manager', title: 'Lead moved to Nurture', body: `${lead.parent_name}: ${attempts} failed attempts`, link: `#/leads/${leadId}` });
    } else {
      const nextCall = attempts + 1;
      let next = addMinutes(t, rule.retryMinutes || 120);
      const day = config.cadenceDays[nextCall];
      if (day !== undefined) {
        const target = addMinutes(addDays(first, day), config.slotShiftHours * 60 * (nextCall % 2 ? 1 : -1));
        if (target > next) next = target;
      }
      patch.next_follow_up_at = next;
      patch.next_follow_up_type = 'call';
      if (['New', 'Attempted'].includes(lead.stage) && rule.stage) patch.stage = rule.stage;
      if (config.whatsappAfterAttempts.includes(attempts) && lead.is_whatsapp) {
        task({ entity: 'lead', entity_id: leadId, title: `Send WhatsApp intro + brochure to ${lead.parent_name}`,
          type: 'whatsapp', assignee_id: lead.owner_id, due_at: addMinutes(t, 10), priority: 'High' });
      }
    }
  } else {
    patch.attempt_count = 0;
    if (['New', 'Attempted'].includes(lead.stage)) patch.stage = 'Contacted';
    if (body.outcome === 'Connected - Interested') {
      const target = body.stage && ['Contacted', 'Qualified'].includes(body.stage) ? body.stage : 'Contacted';
      if (['New', 'Attempted', 'Nurture', 'Contacted'].includes(lead.stage)) patch.stage = target;
    }
    if (rule.requiresLostReason) {
      patch.stage = body.move_to === 'Nurture' ? 'Nurture' : 'Lost';
      patch.lost_reason = patch.stage === 'Lost' ? body.lost_reason : null;
      patch.next_follow_up_at = patch.stage === 'Nurture' ? new Date(body.follow_up_at).toISOString() : null;
    } else {
      patch.next_follow_up_at = new Date(body.follow_up_at).toISOString();
      patch.next_follow_up_type = body.follow_up_type || 'call';
    }
  }
  if (patch.stage && patch.stage !== lead.stage && !(rule.failed && patch.stage === 'Nurture')) {
    log('lead', leadId, 'stage', `${lead.stage} → ${patch.stage}`, { userId: user.id });
  }
  patch.escalated = 0;
  update('leads', leadId, patch);
  trackFollowUp(leadId, { at: patch.next_follow_up_at || null, type: patch.next_follow_up_type, byInteraction: true });
  // Close open call tasks on this lead
  q.run("UPDATE tasks SET status='Done', done_at=? WHERE entity='lead' AND entity_id=? AND type='call' AND status='Open'", t, leadId);
  return getLead(leadId);
}

function noteLongEnough(text) {
  const lines = String(text || '').split(/\n/).map((x) => x.trim()).filter(Boolean);
  return lines.length >= 2 || String(text || '').trim().length >= config.interaction.minConnectedNoteChars;
}
const normList = (v, allowed) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter((x) => allowed.includes(x));

function logWhatsApp(leadId, body, user) {
  const lead = getLead(leadId);
  log('lead', leadId, 'whatsapp', body.message || '', {
    userId: user.id, outcome: body.replied ? 'Replied' : 'Sent',
    meta: { template: body.template || 'manual', replied: !!body.replied, attachment: body.attachment || null,
      sentiment: config.interaction.sentiments.includes(body.sentiment) ? body.sentiment : null,
      objections: normList(body.objections, config.interaction.objections) },
    extra: { direction: body.direction === 'inbound' ? 'inbound' : 'outbound' },
  });
  update('leads', leadId, { last_contacted_at: now(), updated_at: now() });
  q.run("UPDATE tasks SET status='Done', done_at=? WHERE entity='lead' AND entity_id=? AND type='whatsapp' AND status='Open'", now(), leadId);
  if (body.follow_up_at) {
    requireFollowUp(body.follow_up_at, body.follow_up_type);
    const iso = new Date(body.follow_up_at).toISOString();
    update('leads', leadId, { next_follow_up_at: iso, next_follow_up_type: body.follow_up_type || 'call', escalated: 0 });
    trackFollowUp(leadId, { at: iso, type: body.follow_up_type, byInteraction: true });
  } else if (lead.next_follow_up_at && body.replied) {
    trackFollowUp(leadId, { at: lead.next_follow_up_at, byInteraction: true });
    insert('follow_ups', { lead_id: leadId, owner_id: lead.owner_id, due_at: lead.next_follow_up_at, type: lead.next_follow_up_type, set_at: now() });
  }
}

// Demo, email and walk-in interactions (blueprint 5.2). Next step is always required.
function logInteraction(leadId, body, user) {
  const lead = getLead(leadId);
  const type = body.type;
  if (!['demo', 'email', 'walkin'].includes(type)) fail(400, 'Use Log call or Log WhatsApp for those');
  const summary = String(body.summary || '').trim();
  if (!noteLongEnough(summary)) fail(400, `Write what happened – at least 2 lines or ${config.interaction.minConnectedNoteChars} characters`);
  requireFollowUp(body.follow_up_at, body.follow_up_type);
  const outcome = { demo: body.demo_outcome || 'Demo done', email: 'Email', walkin: 'Walk-in' }[type];
  log('lead', leadId, type, summary, {
    userId: user.id, outcome,
    meta: { objections: normList(body.objections, config.interaction.objections), sentiment: config.interaction.sentiments.includes(body.sentiment) ? body.sentiment : null, next_step: body.next_step || null },
    extra: { direction: body.direction === 'inbound' ? 'inbound' : 'outbound' },
  });
  const iso = new Date(body.follow_up_at).toISOString();
  const patch = { last_contacted_at: now(), next_follow_up_at: iso, next_follow_up_type: body.follow_up_type || 'call', updated_at: now(), escalated: 0 };
  if (type === 'demo' && outcome === 'Demo done' && ['New', 'Attempted', 'Contacted', 'Qualified', 'Demo Scheduled'].includes(lead.stage)) {
    patch.stage = 'Demo Done';
    log('lead', leadId, 'stage', `${lead.stage} → Demo Done`, { userId: user.id });
  }
  if (['New', 'Attempted'].includes(lead.stage) && !patch.stage) patch.stage = 'Contacted';
  update('leads', leadId, patch);
  trackFollowUp(leadId, { at: iso, type: body.follow_up_type, byInteraction: true });
  return getLead(leadId);
}

// Manager override of the 30-day rule (blueprint 8).
function exemptLead(leadId, { days, reason }, user) {
  getLead(leadId);
  if (!reason) fail(400, 'A reason is required');
  const until = addDays(now(), Math.min(Math.max(Number(days) || 7, 1), 60));
  update('leads', leadId, { exempt_until: until, exempt_reason: reason });
  log('lead', leadId, 'system', `Exempted from auto-reassignment until ${until.slice(0, 10)}: ${reason}`, { userId: user.id });
  return getLead(leadId);
}

// ---------- bulk import (CSV rows parsed client-side) ----------
function importLeads(rows, user, { default_source, owner_id } = {}) {
  if (!Array.isArray(rows) || !rows.length) fail(400, 'No rows to import');
  if (rows.length > 2000) fail(400, 'Import up to 2,000 rows at a time');
  const report = { created: 0, duplicates: [], errors: [], ids: [] };
  const seen = new Map();
  rows.forEach((raw, i) => {
    const r = Object.fromEntries(Object.entries(raw || {}).map(([k, v]) => [String(k).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'), typeof v === 'string' ? v.trim() : v]));
    const data = {
      source: config.leadSources.find((x) => x.toLowerCase() === String(r.source || '').toLowerCase()) || default_source,
      parent_name: r.parent_name || r.name || r.full_name, phone: r.phone || r.phone_number || r.mobile, email: r.email,
      city: r.city || r.emirate, child_name: r.child_name || r.student_name, grade: r.grade, board: r.board, subjects: r.subjects || r.subject,
      country: /india|^in$/i.test(r.country || '') ? 'India' : r.country ? 'UAE' : undefined,
      campaign: r.campaign || r.campaign_name, ad_set: r.ad_set || r.adset_name, referral_by: r.referral_by || r.referred_by,
      score: ['Hot', 'Warm', 'Cold'].includes(r.score) ? r.score : undefined, owner_id,
    };
    if (!data.country) data.country = String(data.phone || '').replace(/\D/g, '').startsWith('91') ? 'India' : 'UAE';
    const norm = normalizePhone(data.phone, data.country);
    const row = i + 2; // +1 header, +1 for 1-based
    if (norm && seen.has(norm)) { report.duplicates.push({ row, phone: data.phone, existing: `row ${seen.get(norm)} of this file` }); return; }
    try {
      const l = require('../context').run({}, () => createLead(data, user));
      seen.set(norm, row);
      report.created++; report.ids.push(l.id);
    } catch (e) {
      if (e.extra?.duplicate) report.duplicates.push({ row, phone: data.phone, existing: `${e.extra.duplicate.code} – ${e.extra.duplicate.owner_name || 'unassigned'}`, lead_id: e.extra.duplicate.id });
      else report.errors.push({ row, error: e.message });
    }
  });
  writeAudit('import', 'leads', null, null, `Imported ${report.created}, skipped ${report.duplicates.length} duplicates, ${report.errors.length} errors`);
  return report;
}

// ---------- merge (manager) ----------
function mergeLeads(sourceId, targetId, user) {
  if (sourceId === targetId) fail(400, 'Pick a different lead');
  const src = getLead(sourceId); const dst = getLead(targetId);
  if (src.student_id) fail(400, 'A converted lead cannot be merged away – merge the other lead into it');
  return q.tx(() => {
    q.run("UPDATE activities SET entity_id=? WHERE entity='lead' AND entity_id=?", dst.id, src.id);
    q.run("UPDATE tasks SET entity_id=? WHERE entity='lead' AND entity_id=?", dst.id, src.id);
    q.run("UPDATE follow_ups SET status='Closed' WHERE lead_id=? AND status='Open'", src.id);
    q.run('UPDATE follow_ups SET lead_id=? WHERE lead_id=?', dst.id, src.id);
    q.run('UPDATE phone_events SET lead_id=? WHERE lead_id=?', dst.id, src.id);
    if (!q.get('SELECT 1 FROM kyc WHERE lead_id=?', dst.id)) q.run('UPDATE kyc SET lead_id=? WHERE lead_id=?', dst.id, src.id);
    const fill = {};
    for (const f of ['email', 'city', 'child_name', 'grade', 'board', 'subjects', 'campaign', 'ad_set', 'utm', 'referral_by']) if (!dst[f] && src[f]) fill[f] = src[f];
    if ((!dst.notes_template || dst.notes_template === '{}') && src.notes_template) fill.notes_template = src.notes_template;
    if (Object.keys(fill).length) update('leads', dst.id, fill);
    update('leads', src.id, { archived: 1, merged_into: dst.id, next_follow_up_at: null, updated_at: now() });
    log('lead', dst.id, 'system', `Merged ${src.code} (${src.parent_name}) into this lead – full history moved`, { userId: user.id });
    writeAudit('merge', 'leads', src.id, null, `Merged into ${dst.code}`);
    return getLead(dst.id);
  });
}

// Webhook re-enquiry on an existing number: log it and tell the owner instead of creating a duplicate.
function reEnquiry(dupe, data) {
  log('lead', dupe.id, 'system', `Re-enquiry via ${data.source || 'webhook'}${data.campaign ? ` / ${data.campaign}` : ''}`);
  if (dupe.owner_id) notify({ userId: dupe.owner_id, title: `Re-enquiry: ${dupe.parent_name}`, body: 'The parent enquired again – call them now', link: `#/leads/${dupe.id}`, channels: ['app', 'whatsapp'] });
  return getLead(dupe.id);
}

function addNote(leadId, text, user) {
  getLead(leadId);
  if (!text) fail(400, 'Note is empty');
  log('lead', leadId, 'note', text, { userId: user.id });
}

function saveCallNotes(leadId, answers, user) {
  getLead(leadId);
  update('leads', leadId, { notes_template: JSON.stringify(answers || {}), updated_at: now() });
  log('lead', leadId, 'note', 'Call notes updated', { userId: user.id, meta: answers });
}

function reassign(leadId, toUserId, reason, user) {
  const lead = getLead(leadId);
  const rep = q.get("SELECT * FROM users WHERE id=? AND active=1 AND role IN ('sales_exec','sales_manager')", toUserId);
  if (!rep) fail(400, 'Choose an active sales user');
  assign(lead, rep, { reason: reason || 'manual by manager', byUserId: user.id });
  return getLead(leadId);
}

// ---------- KYC ----------
const KYC_FIELDS = ['parent_full_name', 'relationship', 'id_type', 'id_number', 'id_file', 'whatsapp', 'address',
  'child_full_name', 'child_dob', 'school_name', 'occupation', 'consent_terms', 'consent_recording', 'consent_data', 'enrollment_file'];

const SECURE_KYC = ['id_number', 'id_file', 'enrollment_file'];
function getKyc(leadId) {
  const k = q.get('SELECT * FROM kyc WHERE lead_id=?', leadId);
  if (!k) return { lead_id: leadId, status: 'Pending' };
  const { dec } = require('../secure');
  for (const f of SECURE_KYC) k[f] = dec(k[f]);
  return k;
}

function saveKyc(leadId, body, user) {
  getLead(leadId);
  const existing = q.get('SELECT * FROM kyc WHERE lead_id=?', leadId);
  if (existing?.status === 'Verified' && !['owner', 'admin'].includes(user.role)) fail(403, 'KYC is verified and locked');
  const data = {};
  for (const f of KYC_FIELDS) if (body[f] !== undefined) data[f] = body[f];
  data.updated_at = now();
  if (body.submit) {
    const merged = { ...getKyc(leadId), ...data };
    const missing = ['parent_full_name', 'relationship', 'id_type', 'id_number', 'id_file', 'child_full_name',
      'child_dob', 'school_name', 'enrollment_file'].filter((f) => !merged[f]);
    if (missing.length) fail(400, `KYC incomplete: ${missing.join(', ')}`);
    if (!merged.consent_terms || !merged.consent_recording || !merged.consent_data) fail(400, 'All three consents are required');
    data.status = 'Submitted';
    data.submitted_at = now();
  }
  const { enc } = require('../secure');
  for (const f of SECURE_KYC) if (data[f]) data[f] = enc(data[f]);
  if (existing) update('kyc', existing.id, data);
  else insert('kyc', { lead_id: leadId, status: 'Pending', ...data });
  log('lead', leadId, 'kyc', body.submit ? 'KYC submitted for verification' : 'KYC details updated', { userId: user.id });
  if (body.submit) notify({ role: 'admin', title: 'KYC to verify', body: `Lead ${leadId}`, link: `#/leads/${leadId}`, dedupe: `kyc:${leadId}:${now().slice(0, 16)}` });
  return getKyc(leadId);
}

function verifyKyc(leadId, { approve, reason }, user) {
  const k = q.get('SELECT * FROM kyc WHERE lead_id=?', leadId);
  if (!k || k.status !== 'Submitted') fail(400, 'KYC must be submitted first');
  update('kyc', k.id, approve
    ? { status: 'Verified', verified_by: user.id, verified_at: now(), reject_reason: null }
    : { status: 'Rejected', reject_reason: reason || 'Not specified' });
  log('lead', leadId, 'kyc', approve ? 'KYC verified' : `KYC rejected: ${reason}`, { userId: user.id });
  const lead = getLead(leadId);
  if (lead.owner_id) notify({ userId: lead.owner_id, title: `KYC ${approve ? 'verified' : 'rejected'}`, body: lead.parent_name, link: `#/leads/${leadId}` });
  // If the lead is already a student waiting on KYC, try to activate.
  if (approve && lead.student_id) require('./students').tryActivate(lead.student_id, user);
  return getKyc(leadId);
}

// ---------- Conversion (section 9) ----------
function conversionChecklist(lead, body = {}) {
  const kyc = getKyc(lead.id);
  const pay = body.payment || {};
  const plan = body.instalments || [];
  return {
    package: !!(body.subjects && Number(body.hours) > 0 && Number(body.price) > 0),
    payment: !!(pay.method && pay.reference && Number(pay.amount) > 0) || (plan.length > 0 && !!body.instalment_approved),
    kyc: kyc.status === 'Verified',
    amount: Number(body.price) > 0,
  };
}

function convert(leadId, body, user) {
  const lead = getLead(leadId);
  if (lead.stage === 'Converted') fail(400, 'Already converted');
  if (['Lost'].includes(lead.stage)) fail(400, 'Reopen the lead before converting');
  if (body.instalment_approved && !['owner', 'sales_manager'].includes(user.role)) fail(403, 'Only a manager can approve an instalment plan');
  const check = conversionChecklist(lead, body);
  const missing = Object.entries(check).filter(([, ok]) => !ok).map(([k]) => k);
  if (missing.length) fail(400, `Conversion checklist incomplete: ${missing.join(', ')}`);

  const t = now();
  return q.tx(() => {
    const studentId = insert('students', {
      code: nextCode('students', 'ST'), lead_id: lead.id,
      parent_name: lead.parent_name, phone: lead.phone, email: lead.email, city: lead.city,
      child_name: lead.child_name || 'Student', grade: lead.grade, board: lead.board, subjects: body.subjects,
      country: lead.country, currency: lead.currency, stage: 'Awaiting Teacher',
      retention_owner_id: lead.owner_id, total_hours: Number(body.hours), hours_used: 0,
      admin_owner_id: q.get("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1")?.id || null,
      timezone: lead.country === 'India' ? 'Asia/Kolkata' : 'Asia/Dubai', joined_at: t, updated_at: t,
    });
    const packageId = insert('packages', {
      student_id: studentId, subjects: body.subjects, hours: Number(body.hours), price: Number(body.price),
      currency: lead.currency, kind: 'New', sold_by: lead.owner_id || user.id, source: lead.source, created_at: t,
    });
    const finance = require('./finance');
    if (body.payment && Number(body.payment.amount) > 0) {
      finance.recordPayment({
        student_id: studentId, lead_id: lead.id, package_id: packageId, amount: Number(body.payment.amount),
        currency: lead.currency, method: body.payment.method, reference: body.payment.reference,
        paid_at: body.payment.paid_at || t, status: Number(body.payment.amount) >= Number(body.price) ? 'Paid' : 'Partial',
        instalment_no: 1,
      }, user);
    }
    (body.instalments || []).forEach((ins, i) => finance.recordPayment({
      student_id: studentId, lead_id: lead.id, package_id: packageId, amount: Number(ins.amount), currency: lead.currency,
      due_date: ins.due_date, status: 'Pending', instalment_no: (body.payment ? 2 : 1) + i,
    }, user));

    update('leads', lead.id, { stage: 'Converted', student_id: studentId, next_follow_up_at: null, updated_at: t });
    trackFollowUp(lead.id, { at: null, byInteraction: true });
    log('lead', lead.id, 'stage', `${lead.stage} → Converted (${body.hours} hrs, ${lead.currency} ${body.price})`, { userId: user.id });
    log('student', studentId, 'system', `Student created from lead ${lead.code}`, { userId: user.id });

    task({ entity: 'student', entity_id: studentId, title: `Assign teacher – ${lead.child_name || lead.parent_name}`,
      type: 'assign_teacher', assignee_role: 'admin', due_at: addMinutes(t, config.sla.assignTeacherHours * 60), priority: 'High' });
    notify({ role: 'admin', title: 'New student – assign teacher', body: `${lead.child_name} (${body.subjects}) within ${config.sla.assignTeacherHours}h`, link: `#/students/${studentId}` });
    for (const d of config.checkInDays) {
      task({ entity: 'student', entity_id: studentId, title: `Day ${d} satisfaction check-in – ${lead.parent_name}`,
        type: 'checkin', assignee_id: lead.owner_id, due_at: addDays(t, d) });
    }
    sendExternal('whatsapp', lead.phone, `Welcome to Jeta Edu, ${lead.parent_name}! ${lead.child_name || 'Your child'} is enrolled for ${body.subjects}. Our team will share the teacher and schedule shortly.`);
    return { student_id: studentId, package_id: packageId };
  });
}

// ---------- Scheduled checks (called by automation) ----------
function runLeadRules() {
  const t = now();
  const out = { sla: 0, warned: 0, reassigned: 0, nurtured: 0 };
  // First-call SLA
  for (const l of q.all(`SELECT * FROM leads WHERE first_call_at IS NULL AND owner_id IS NOT NULL AND sla_breached=0 AND stage='New' AND archived=0`)) {
    if (daysBetween(l.assigned_at, t) * 1440 > config.sla.firstCallMinutes) {
      update('leads', l.id, { sla_breached: 1 });
      log('lead', l.id, 'system', `First-call SLA breached (${config.sla.firstCallMinutes} min)`);
      notify({ role: 'manager', title: 'First-call SLA breached', body: `${l.parent_name} (${l.code})`, link: `#/leads/${l.id}`, dedupe: `sla:${l.id}` });
      out.sla++;
    }
  }
  // 30-day rule
  const open = q.all(`SELECT * FROM leads WHERE owner_id IS NOT NULL AND assigned_at IS NOT NULL AND archived=0 AND stage NOT IN ('Converted','Lost','Nurture')`);
  for (const l of open) {
    const age = daysBetween(l.assigned_at, t);
    const exempt = l.stage === 'Payment Pending' || (l.exempt_until && l.exempt_until > t) ||
      (l.stage === 'Demo Scheduled' && l.demo_at && daysBetween(t, l.demo_at) >= 0 && daysBetween(t, l.demo_at) <= config.reassignment.demoExemptDays);
    if (age >= config.reassignment.expireDay && !exempt) {
      if (l.reassignment_count >= config.reassignment.maxReassignments) {
        update('leads', l.id, { stage: 'Nurture', updated_at: t, next_follow_up_at: addDays(t, 7) });
        log('lead', l.id, 'stage', `${l.stage} → Nurture (reassigned ${l.reassignment_count}× – manager review)`);
        notify({ role: 'manager', title: 'Lead in Nurture pool for review', body: l.parent_name, link: `#/leads/${l.id}`, dedupe: `nurture:${l.id}` });
        out.nurtured++;
      } else {
        const rep = pickRep(l.country, [l.owner_id]);
        if (rep) { assign(l, rep, { reason: '30-day rule' }); out.reassigned++; }
      }
    } else if (age >= config.reassignment.warnDay && !l.expiry_warned && !exempt) {
      update('leads', l.id, { expiry_warned: 1 });
      const msg = { title: 'Lead expires in 5 days', body: `${l.parent_name} (${l.code})`, link: `#/leads/${l.id}` };
      notify({ userId: l.owner_id, ...msg });
      notify({ role: 'manager', ...msg, dedupe: `exp:${l.id}:${l.assigned_at}` });
      out.warned++;
    }
  }
  return out;
}

function runFollowUpReminders() {
  const t = now();
  const fu = config.followUp;
  const rows = q.all(`SELECT * FROM leads WHERE next_follow_up_at IS NOT NULL AND owner_id IS NOT NULL AND archived=0 AND stage NOT IN ('Converted','Lost')`);
  let n = 0;
  for (const l of rows) {
    const mins = (new Date(l.next_follow_up_at) - new Date(t)) / 60000; // positive = upcoming
    const k = `${l.id}:${l.next_follow_up_at}`;
    const link = `#/leads/${l.id}`;
    const what = `${l.next_follow_up_type || 'call'} ${l.parent_name}`;
    if (mins <= fu.remindBeforeMinutes && mins > 0) n += notify({ userId: l.owner_id, title: `Follow-up in ${Math.ceil(mins)} min`, body: what, link, dedupe: `fu30:${k}` });
    if (mins <= 0 && mins > -fu.ownerEscalateAfterMinutes) n += notify({ userId: l.owner_id, title: 'Follow-up due now', body: what, link, dedupe: `fu0:${k}`, channels: ['app', 'whatsapp'] });
    if (mins <= -fu.ownerEscalateAfterMinutes) n += notify({ userId: l.owner_id, title: 'Follow-up overdue (+1h)', body: what, link, dedupe: `fu60:${k}` });
    if (mins <= -fu.managerEscalateAfterMinutes) n += notify({ role: 'manager', title: 'Follow-up overdue 24h+ (red)', body: `${what} – ${ownerName(l.owner_id)}`, link, dedupe: `fu24:${k}` });
    // +48h: manager takes over or the lead is reassigned; counted on the owner's scorecard (blueprint 16.4).
    if (mins <= -48 * 60 && !l.escalated) {
      update('leads', l.id, { escalated: 1 });
      q.run('INSERT OR IGNORE INTO escalations (entity, entity_id, owner_id, level, reason, created_at) VALUES (?,?,?,?,?,?)',
        'lead', l.id, l.owner_id, '48h', `Follow-up ${l.next_follow_up_type || 'call'} overdue 48h`, l.next_follow_up_at);
      const action48 = require('./settings').get('escalation').hours48Action;
      if (action48 === 'reassign') {
        const rep = pickRep(l.country, [l.owner_id]);
        if (rep) assign(l, rep, { reason: 'follow-up overdue 48h' });
      }
      log('lead', l.id, 'system', `Escalated: follow-up overdue 48h${action48 === 'reassign' ? ' – reassigned' : ' – manager to take over'}`);
      n += notify({ role: 'manager', title: 'Escalated: overdue 48h', body: `${l.parent_name} – ${ownerName(l.owner_id)}. Take over or reassign.`, link, dedupe: `fu48:${k}` });
    }
  }
  // Connected calls from the phone tracker still waiting for a note.
  const ic = config.interaction;
  for (const a of q.all(`SELECT a.*, l.parent_name, l.owner_id FROM activities a JOIN leads l ON l.id=a.entity_id
      WHERE a.entity='lead' AND a.needs_note=1 AND a.note_due_at < ?`, t)) {
    const late = (new Date(t) - new Date(a.note_due_at)) / 60000;
    const uid = a.user_id || a.owner_id;
    n += notify({ userId: uid, title: 'Add notes for your call', body: `${a.parent_name}: connected call has no notes`, link: `#/leads/${a.entity_id}`, dedupe: `note:${a.id}` });
    if (late >= ic.managerAfterMinutes) n += notify({ role: 'manager', title: 'Call without notes', body: `${ownerName(uid)} – ${a.parent_name}`, link: `#/leads/${a.entity_id}`, dedupe: `noteM:${a.id}` });
  }
  return n;
}
const ownerName = (id) => q.get('SELECT name FROM users WHERE id=?', id)?.name || 'unassigned';

module.exports = {
  getLead, pickRep, createLead, findDuplicate, trackFollowUp, logInteraction, exemptLead, importLeads, mergeLeads, reEnquiry, noteLongEnough, assignmentMode, setFollowUp, changeStage, logCall, logWhatsApp, addNote, saveCallNotes,
  reassign, getKyc, saveKyc, verifyKyc, conversionChecklist, convert, runLeadRules, runFollowUpReminders, overdueCount,
};

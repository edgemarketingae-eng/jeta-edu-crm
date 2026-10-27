const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,               -- owner | sales_manager | sales_exec | admin | accounts
  market TEXT,                      -- UAE | India (sales round-robin pool)
  active INTEGER NOT NULL DEFAULT 1,
  phone TEXT,
  last_assigned_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source TEXT NOT NULL,
  campaign TEXT, ad_set TEXT, utm TEXT, referral_by TEXT,
  parent_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  is_whatsapp INTEGER NOT NULL DEFAULT 1,
  email TEXT, city TEXT,
  child_name TEXT, grade TEXT, board TEXT, subjects TEXT,
  country TEXT NOT NULL DEFAULT 'UAE',
  currency TEXT NOT NULL DEFAULT 'AED',
  owner_id INTEGER REFERENCES users(id),
  stage TEXT NOT NULL DEFAULT 'New',
  score TEXT DEFAULT 'Warm',
  next_follow_up_at TEXT, next_follow_up_type TEXT,
  last_contacted_at TEXT, first_call_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  assigned_at TEXT,
  reassignment_count INTEGER NOT NULL DEFAULT 0,
  lost_reason TEXT,
  demo_at TEXT,
  flagged INTEGER NOT NULL DEFAULT 0,
  flag_reason TEXT,
  notes_template TEXT,              -- JSON answers to the preset call questions
  expiry_warned INTEGER NOT NULL DEFAULT 0,
  sla_breached INTEGER NOT NULL DEFAULT 0,
  student_id INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads(owner_id);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_follow ON leads(next_follow_up_at);

-- Timeline: every call, WhatsApp, note, stage change, reassignment, system event
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,             -- lead | student | teacher | payment | payout
  entity_id INTEGER NOT NULL,
  type TEXT NOT NULL,               -- call | whatsapp | note | stage | reassign | system | kyc | payment | class
  outcome TEXT,
  body TEXT,
  meta TEXT,                        -- JSON
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_act_entity ON activities(entity, entity_id);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT, entity_id INTEGER,
  title TEXT NOT NULL,
  type TEXT,                        -- call | whatsapp | demo | payment | assign_teacher | retention | checkin | ticket
  assignee_id INTEGER REFERENCES users(id),
  assignee_role TEXT,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'Open',  -- Open | Done | Cancelled
  priority TEXT DEFAULT 'Normal',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  done_at TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  role TEXT,
  channel TEXT NOT NULL DEFAULT 'app',  -- app | whatsapp | email
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  dedupe_key TEXT UNIQUE,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS kyc (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
  parent_full_name TEXT, relationship TEXT,
  id_type TEXT, id_number TEXT, id_file TEXT,
  whatsapp TEXT, address TEXT,
  child_full_name TEXT, child_dob TEXT, school_name TEXT,
  occupation TEXT,
  consent_terms INTEGER DEFAULT 0, consent_recording INTEGER DEFAULT 0, consent_data INTEGER DEFAULT 0,
  enrollment_file TEXT,
  status TEXT NOT NULL DEFAULT 'Pending', -- Pending | Submitted | Verified | Rejected
  verified_by INTEGER REFERENCES users(id),
  verified_at TEXT, reject_reason TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  country TEXT NOT NULL,            -- UAE | India
  currency TEXT NOT NULL,           -- AED | INR (never mixed)
  subjects TEXT, grades TEXT, boards TEXT,
  availability TEXT,
  rate_per_hour REAL NOT NULL DEFAULT 0,
  demo_rate REAL,
  bank_details TEXT,
  phone TEXT, email TEXT,
  status TEXT NOT NULL DEFAULT 'Active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  lead_id INTEGER REFERENCES leads(id),
  parent_name TEXT, phone TEXT, email TEXT, city TEXT,
  child_name TEXT NOT NULL, grade TEXT, board TEXT, subjects TEXT,
  country TEXT, currency TEXT,
  stage TEXT NOT NULL DEFAULT 'Awaiting Teacher',
  retention_owner_id INTEGER REFERENCES users(id),
  retention_stage TEXT,
  teacher_id INTEGER REFERENCES teachers(id),
  batch_type TEXT,                  -- 1:1 | Batch
  batch_name TEXT,
  start_date TEXT,
  schedule_days TEXT, schedule_time TEXT, timezone TEXT,
  total_hours REAL NOT NULL DEFAULT 0,
  hours_used REAL NOT NULL DEFAULT 0,
  hours_alert_level INTEGER NOT NULL DEFAULT 0, -- 0 none, 1 low, 2 urgent, 3 zero
  churn_reason TEXT,
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subjects TEXT,
  hours REAL NOT NULL,
  price REAL NOT NULL,
  currency TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'New',  -- New | Renewal
  sold_by INTEGER REFERENCES users(id),
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no TEXT UNIQUE,
  student_id INTEGER REFERENCES students(id),
  lead_id INTEGER REFERENCES leads(id),
  package_id INTEGER REFERENCES packages(id),
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  method TEXT, reference TEXT,
  instalment_no INTEGER DEFAULT 1,
  due_date TEXT,
  paid_at TEXT,
  status TEXT NOT NULL DEFAULT 'Pending', -- Paid | Partial | Pending | Refunded | Refund Requested | Refund Approved
  collected_by INTEGER REFERENCES users(id),
  refund_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,           -- Ad Spend | Tools | Salaries | Other
  source TEXT,                      -- for ad spend: lead source (CAC)
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  month TEXT NOT NULL,              -- YYYY-MM
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  subject TEXT,
  scheduled_at TEXT NOT NULL,
  duration_hours REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'Scheduled',
  topic TEXT, remarks TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  reschedule_reason TEXT,
  hours_deducted REAL NOT NULL DEFAULT 0,
  teacher_paid_hours REAL NOT NULL DEFAULT 0,
  marked_by INTEGER REFERENCES users(id),
  marked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_classes_teacher ON classes(teacher_id, scheduled_at);

CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  month TEXT NOT NULL,              -- YYYY-MM
  currency TEXT NOT NULL,
  hours REAL NOT NULL DEFAULT 0,
  gross REAL NOT NULL DEFAULT 0,
  adjustments REAL NOT NULL DEFAULT 0,
  adjustment_note TEXT,
  net REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Pending', -- Pending | Approved | Paid
  approved_by INTEGER REFERENCES users(id),
  paid_at TEXT, pay_reference TEXT, pay_mode TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  lines TEXT,                       -- JSON breakdown by student/subject
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(teacher_id, month)
);

CREATE TABLE IF NOT EXISTS kudos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user INTEGER NOT NULL REFERENCES users(id),
  to_user INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,               -- conversion | renewal | demo | badge
  ref_id INTEGER NOT NULL,          -- package id / activity id
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(from_user, kind, ref_id)
);

-- Audit trail: who changed what, when, old -> new. Never shown to or editable by staff.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,             -- create | update | archive | merge | login | export | ...
  entity TEXT NOT NULL,
  entity_id INTEGER,
  changes TEXT,                     -- JSON {field: [old, new]}
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);

CREATE TABLE IF NOT EXISTS activity_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL REFERENCES activities(id),
  body TEXT, meta TEXT, outcome TEXT,
  edited_by INTEGER, reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS edit_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL REFERENCES activities(id),
  requested_by INTEGER NOT NULL,
  new_body TEXT, new_meta TEXT, reason TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',   -- Pending | Approved | Rejected
  decided_by INTEGER, decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Every follow-up ever set, so on-time % can be measured.
CREATE TABLE IF NOT EXISTS follow_ups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  owner_id INTEGER,
  due_at TEXT NOT NULL,
  type TEXT,
  set_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open',      -- Open | Done | Rescheduled | Closed
  done_at TEXT,
  on_time INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fu_lead ON follow_ups(lead_id, status);

-- Phone tracker (Android app) and cloud telephony
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT,
  platform TEXT DEFAULT 'android',
  token_hash TEXT UNIQUE,
  pair_code TEXT, pair_expires TEXT,
  paired_at TEXT, last_seen TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS phone_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER,
  user_id INTEGER,
  event_id TEXT NOT NULL,
  number_norm TEXT,
  direction TEXT,                    -- outgoing | incoming | missed
  started_at TEXT, duration_sec INTEGER DEFAULT 0, sim TEXT,
  lead_id INTEGER, student_id INTEGER, activity_id INTEGER,
  source TEXT DEFAULT 'tracker',     -- tracker | telephony
  recording_url TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(source, device_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_pe_user ON phone_events(user_id, started_at);

CREATE TABLE IF NOT EXISTS teacher_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  subject TEXT, grade TEXT, batch_type TEXT,
  rate REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL, entity_id INTEGER NOT NULL,
  owner_id INTEGER,
  level TEXT NOT NULL,               -- 48h | repeat
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'Open',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT, resolved_by INTEGER,
  UNIQUE(entity, entity_id, level, created_at)
);

CREATE TABLE IF NOT EXISTS coaching (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'Due',  -- Due | Held
  due_at TEXT,
  manager_id INTEGER, notes TEXT, held_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

// Columns added after v1. Each is applied once, so existing databases upgrade in place.
const COLUMNS = {
  users: { totp_secret: 'TEXT', totp_enabled: 'INTEGER NOT NULL DEFAULT 0', team: 'TEXT' },
  leads: { phone_norm: 'TEXT', archived: 'INTEGER NOT NULL DEFAULT 0', merged_into: 'INTEGER', last_action_at: 'TEXT', escalated: 'INTEGER NOT NULL DEFAULT 0', exempt_until: 'TEXT', exempt_reason: 'TEXT' },
  activities: { direction: 'TEXT', source: "TEXT DEFAULT 'manual'", needs_note: 'INTEGER NOT NULL DEFAULT 0', note_due_at: 'TEXT', edited_at: 'TEXT', version: 'INTEGER NOT NULL DEFAULT 1' },
  students: { admin_owner_id: 'INTEGER', meet_link: 'TEXT' },
  classes: { meet_link: 'TEXT', teacher_minutes: 'REAL', student_minutes: 'REAL', teacher_confirmed_at: 'TEXT', teacher_reported_hours: 'REAL',
    proof_link: 'TEXT', review_flag: 'TEXT', review_resolved_at: 'TEXT', review_resolved_by: 'INTEGER', audit_pick: 'INTEGER NOT NULL DEFAULT 0', attendance_source: 'TEXT', review_flagged_at: 'TEXT' },
  teachers: { portal_token: 'TEXT' },
  payments: { verified_at: 'TEXT', verified_by: 'INTEGER', invoice_sent_at: 'TEXT', vat_amount: 'REAL NOT NULL DEFAULT 0' },
  kyc: { submitted_at: 'TEXT' },
  sessions: { restricted: 'INTEGER NOT NULL DEFAULT 0' },
};

function migrate(d) {
  for (const [table, cols] of Object.entries(COLUMNS)) {
    const have = new Set(d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [col, type] of Object.entries(cols)) if (!have.has(col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  d.exec('CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone_norm)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_act_user ON activities(user_id, created_at)');
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_teacher_token ON teachers(portal_token)');
}

function open(file = config.dbPath) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

let instance;
function db() {
  if (!instance) instance = open();
  return instance;
}
function setDb(d) { instance = d; }

let txDepth = 0;
// Small helpers so route code stays readable.
const q = {
  all: (sql, ...p) => db().prepare(sql).all(...p),
  get: (sql, ...p) => db().prepare(sql).get(...p),
  run: (sql, ...p) => db().prepare(sql).run(...p),
  // Re-entrant: nested q.tx calls join the outer transaction.
  tx(fn) {
    if (txDepth > 0) { txDepth++; try { return fn(); } finally { txDepth--; } }
    db().exec('BEGIN'); txDepth = 1;
    try { const r = fn(); db().exec('COMMIT'); return r; }
    catch (e) { db().exec('ROLLBACK'); throw e; }
    finally { txDepth = 0; }
  },
};

// Insert from an object, returns new id.
// Which tables are audited automatically, and for which actions.
const AUDIT = {
  leads: { create: true, update: true }, students: { create: true, update: true }, kyc: { create: true, update: true },
  payments: { create: true, update: true }, payouts: { create: true, update: true }, teachers: { create: true, update: true },
  users: { create: true, update: true }, packages: { create: true, update: true }, expenses: { create: true, update: true },
  classes: { create: false, update: true }, activities: { create: false, update: true }, teacher_rates: { create: true, update: true },
};
const NOISE = new Set(['updated_at', 'last_assigned_at', 'last_seen', 'last_action_at', 'expiry_warned', 'hours_alert_level']);
const SECRET = new Set(['password_hash', 'totp_secret', 'bank_details', 'id_number', 'id_file', 'enrollment_file']);

function writeAudit(action, entity, entityId, changes, note) {
  const c = require('./context').ctx();
  if (c.noAudit) return;
  db().prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, changes, note, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(c.userId ?? null, action, entity, entityId ?? null, changes ? JSON.stringify(changes) : null, note || null, new Date().toISOString());
}

// Insert from an object, returns new id.
function insert(table, obj) {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  const r = q.run(sql, ...keys.map((k) => norm(obj[k])));
  const id = Number(r.lastInsertRowid);
  if (AUDIT[table]?.create) {
    const changes = {};
    for (const k of keys) if (!NOISE.has(k) && obj[k] !== null && obj[k] !== '') changes[k] = [null, SECRET.has(k) ? '[set]' : norm(obj[k])];
    writeAudit('create', table, id, changes);
  }
  return id;
}
function update(table, id, obj) {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  if (!keys.length) return;
  const before = AUDIT[table]?.update ? q.get(`SELECT * FROM ${table} WHERE id=?`, id) : null;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  q.run(sql, ...keys.map((k) => norm(obj[k])), id);
  if (before) {
    const changes = {};
    for (const k of keys) {
      if (NOISE.has(k)) continue;
      const nv = norm(obj[k]);
      if (String(before[k] ?? '') !== String(nv ?? '')) changes[k] = SECRET.has(k) ? ['[hidden]', '[changed]'] : [before[k] ?? null, nv ?? null];
    }
    if (Object.keys(changes).length) writeAudit('update', table, id, changes);
  }
}
function norm(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

module.exports = { open, db, setDb, q, insert, update, writeAudit, migrate };

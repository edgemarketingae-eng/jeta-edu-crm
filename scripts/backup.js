// Consistent online backup of the SQLite database (safe while the app is running).
//   node scripts/backup.js            -> ./backups/jeta-crm-YYYY-MM-DD_HHMM.db
//   BACKUP_DIR=/var/backups/jeta KEEP=30 node scripts/backup.js
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../src/config');

const dir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const keep = Number(process.env.KEEP || 30);
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '');
const out = path.join(dir, `jeta-crm-${stamp}.db`);

const db = new DatabaseSync(config.dbPath);
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();
console.log(`Backup written: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);

const old = fs.readdirSync(dir).filter((f) => /^jeta-crm-.*\.db$/.test(f)).sort().reverse().slice(keep);
for (const f of old) fs.unlinkSync(path.join(dir, f));
if (old.length) console.log(`Removed ${old.length} old backup(s), keeping ${keep}.`);

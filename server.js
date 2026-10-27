const path = require('path');
const express = require('express');
const config = require('./src/config');
const { db, q } = require('./src/db');
const automation = require('./src/automation');

db(); // open + migrate

// First boot: create the Owner account (and optional demo data).
if (!q.get('SELECT 1 FROM users LIMIT 1')) {
  if (process.env.SEED_DEMO !== 'false') {
    require('./src/seed').seed();
    console.log('Seeded demo data. Login: owner@jeta.edu / jeta1234');
  } else {
    const { hashPassword } = require('./src/auth');
    q.run('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)', 'Owner',
      process.env.OWNER_EMAIL || 'owner@jeta.edu', hashPassword(process.env.OWNER_PASSWORD || 'change-me-now'), 'owner');
    console.log('Created owner account from OWNER_EMAIL / OWNER_PASSWORD');
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));
app.use('/api', require('./src/routes'));
app.get('/health', (req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (process.env.AUTOMATION !== 'off') automation.start(60000);
app.listen(config.port, () => console.log(`Jeta Edu CRM on http://localhost:${config.port}`));

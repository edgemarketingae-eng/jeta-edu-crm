// Create or reset an Owner account from the command line (e.g. a lost password).
//   node scripts/create-owner.js owner@yourdomain.com 'StrongPassword123' "Your Name"
const { db, q } = require('../src/db');
const { hashPassword } = require('../src/auth');

const [email, password, name = 'Owner'] = process.argv.slice(2);
if (!email || !password || password.length < 10) {
  console.error('Usage: node scripts/create-owner.js <email> <password 10+ chars> [name]');
  process.exit(1);
}
db();
const existing = q.get('SELECT id FROM users WHERE lower(email)=lower(?)', email);
if (existing) {
  q.run("UPDATE users SET password_hash=?, role='owner', active=1 WHERE id=?", hashPassword(password), existing.id);
  console.log(`Reset password and Owner role for ${email}`);
} else {
  q.run("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,'owner')", name, email.toLowerCase(), hashPassword(password));
  console.log(`Created Owner ${email}`);
}

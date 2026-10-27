# Jeta Edu CRM – Server Deployment Guide

This is the handover for deploying the CRM on your own server. It covers two ways to run it (Docker, or Node + PM2), HTTPS with Nginx, backups, updates and the go-live checklist.

**Repository:** https://github.com/edgemarketingae-eng/jeta-edu-crm

---

## 1. What you are deploying

| | |
|---|---|
| Runtime | Node.js **22.13 or newer** (uses the built-in `node:sqlite`) |
| Framework | Express 4. The only npm dependency is `express`. |
| Database | SQLite, one file (default `data/jeta-crm.db`) |
| Front end | Static files in `public/`, no build step |
| Process | One process. It serves the UI and API and runs the automation scheduler every minute. |
| Port | `3000` (set with `PORT`) |
| Health check | `GET /health` returns `{"ok":true}` |

**Run exactly one instance.** The scheduler (follow-up reminders, the 30-day reassignment, SLA alerts, payout drafts) runs inside the app, and SQLite is a single file. Don't use PM2 cluster mode or multiple replicas.

### Server size
- 1 vCPU, 1 GB RAM and 10 GB disk is enough for a team of 20–50 staff and tens of thousands of leads.
- Ubuntu 22.04 or 24.04 LTS (or any Linux with Docker).
- Open ports 80 and 443 only. The app listens on localhost behind Nginx.

### Folder layout
```
server.js              entry point (security headers, login guard, startup)
src/config.js          ALL business rules: SLAs, cadence, 30-day rule, attendance policy, points
src/db.js              schema (auto-created and migrated on start)
src/routes.js          REST API (/api/...)
src/auth.js            login, sessions, role permission matrix
src/services/          leads, students, finance, reports, game (leaderboard)
src/automation.js      scheduled rules (every minute)
src/notify.js          in-app / WhatsApp / email notification adapters
src/secure.js          AES-256-GCM field encryption + TOTP two-factor codes
src/context.js         per-request user context (feeds the audit log)
src/integrations/google.js  Google Calendar (Jeta-owned Meet links) + Meet attendance (Reports API)
src/services/          leads, students, finance, reports, game, history (audit/versions),
                       phone (tracker), attendance (Meet/teacher form), accountability, settings
public/teacher.html    teacher post-class page (token link, no login, no parent contacts)
android/               Jeta Call Tracker – Android app source (build in Android Studio)
public/                web app (index.html, app.js, styles.css, icons, manifest)
scripts/backup.js      online database backup
scripts/create-owner.js  create or reset an Owner login
deploy/                nginx.conf, ecosystem.config.js (PM2), jeta-crm.service (systemd), backup.cron
Dockerfile, docker-compose.yml, .env.example
test/                  business-rule tests (npm test)
```

---

## 2. Configuration (`.env`)

Copy `.env.example` to `.env` and fill it in:

| Variable | Required | Notes |
|---|---|---|
| `OWNER_EMAIL`, `OWNER_PASSWORD` | **First start** | Creates the Owner account. Password must be 10+ characters. Ignored once users exist. |
| `OWNER_NAME` | no | Display name of the Owner |
| `SEED_DEMO` | no | Keep `false` in production. `true` loads demo data with publicly known passwords. |
| `NODE_ENV` | yes | `production` (set already by Docker, PM2 and systemd files) |
| `PORT` / `HOST` | no | Default `3000` / `0.0.0.0`. PM2/systemd bind to `127.0.0.1`. |
| `DB_PATH` | no | Database file. Must be on persistent disk. |
| `BACKUP_DIR` | no | Where `npm run backup` writes |
| `TRUST_PROXY` | yes behind Nginx | `true` so real client IPs are used for the login guard |
| `WEBHOOK_KEY` | optional | Enables the lead-capture webhook. Generate with `openssl rand -hex 24`. |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `SMTP_URL` | optional | See section 8 |
| `ENCRYPTION_KEY` | **yes (production)** | 64 hex characters (`openssl rand -hex 32`). Encrypts bank details, KYC document refs and ID numbers, and 2FA secrets. **Back it up**; without it that data can't be read. The app refuses to start in production without it. |
| `PUBLIC_URL` | yes | e.g. `https://crm.jetaedu.com`. Used in the class-confirmation links sent to teachers. |
| `TELEPHONY_KEY` | optional | Enables the cloud-telephony webhook (section 8) |
| `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_IMPERSONATE`, `GOOGLE_ADMIN_IMPERSONATE`, `GOOGLE_CALENDAR_ID` | optional | Jeta-owned Meet links and automatic Meet attendance (section 8) |
| `INR_PER_AED` | no | Rate for combined AED/INR reports (default 22.7) |
| `BRAND_NAME` | no | Name on invoices and payout statements |

> On a production server, the app **refuses to start** on an empty database unless `OWNER_EMAIL` and `OWNER_PASSWORD` are set. This prevents an accidental launch with demo accounts.

---

## 3A. Deploy with Docker (recommended)

```bash
# On the server (Ubuntu): install Docker
curl -fsSL https://get.docker.com | sh

# Get the code
sudo mkdir -p /opt && cd /opt
sudo git clone https://github.com/edgemarketingae-eng/jeta-edu-crm.git jeta-crm
cd jeta-crm

# Configure
sudo cp .env.example .env
sudo nano .env            # set OWNER_EMAIL, OWNER_PASSWORD, WEBHOOK_KEY …

# Start
sudo docker compose up -d --build
sudo docker compose logs -f      # expect "Created Owner account …" then "Jeta Edu CRM on …"
curl http://127.0.0.1:3000/health
```

The database and backups are stored on the host in `/opt/jeta-crm/data/`. Only Nginx on the same server can reach port 3000, because it's bound to 127.0.0.1.

Continue with **section 4 (Nginx + HTTPS)**.

---

## 3B. Deploy with Node.js + PM2 (no Docker)

```bash
# Node 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v                      # must be v22.13 or newer

# App user, folders, code
sudo useradd -r -m -s /bin/bash jeta
sudo mkdir -p /opt/jeta-crm /var/lib/jeta-crm /var/backups/jeta-crm
sudo chown -R jeta:jeta /opt/jeta-crm /var/lib/jeta-crm /var/backups/jeta-crm
sudo -u jeta git clone https://github.com/edgemarketingae-eng/jeta-edu-crm.git /opt/jeta-crm
cd /opt/jeta-crm
sudo -u jeta npm ci --omit=dev
sudo -u jeta cp .env.example .env && sudo -u jeta nano .env

# PM2
sudo npm install -g pm2
sudo -u jeta bash -c 'set -a; source .env; set +a; pm2 start deploy/ecosystem.config.js && pm2 save'
sudo env PATH=$PATH pm2 startup systemd -u jeta --hp /home/jeta     # start on reboot
curl http://127.0.0.1:3000/health
```

**Alternative without PM2:** copy `deploy/jeta-crm.service` to `/etc/systemd/system/`, then run `sudo systemctl daemon-reload && sudo systemctl enable --now jeta-crm`. View logs with `journalctl -u jeta-crm -f`.

---

## 4. Nginx + HTTPS

Point a DNS **A record** (for example `crm.yourdomain.com`) at the server IP first.

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo cp /opt/jeta-crm/deploy/nginx.conf /etc/nginx/sites-available/jeta-crm
sudo sed -i 's/crm.yourdomain.com/YOUR.DOMAIN/' /etc/nginx/sites-available/jeta-crm
sudo ln -s /etc/nginx/sites-available/jeta-crm /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d YOUR.DOMAIN          # free HTTPS, auto-renews
sudo ufw allow 'Nginx Full' && sudo ufw allow OpenSSH && sudo ufw enable
```

Open `https://YOUR.DOMAIN` and sign in with the Owner account.

HTTPS matters here: logins, parent KYC and payment references travel through this app, and "Add to Home Screen" on phones requires HTTPS.

---

## 5. Backups (do this before go-live)

`scripts/backup.js` makes a consistent copy while the app is running, using SQLite `VACUUM INTO`. It keeps the last 30 copies.

```bash
# Docker
sudo docker exec jeta-crm node --no-warnings scripts/backup.js      # -> /opt/jeta-crm/data/backups/

# PM2 / systemd
cd /opt/jeta-crm && sudo -u jeta npm run backup                     # -> /var/backups/jeta-crm/
```

Schedule it nightly. The lines are in `deploy/backup.cron`; for a PM2 install, run `sudo crontab -u jeta deploy/backup.cron`.

**Keep a copy off the server as well**, for example with `rclone` to Google Drive, S3 or Backblaze, or your hosting provider's snapshots.

**Restore:**
1. Stop the app.
2. Replace the database file with a backup copy, renaming it to `jeta-crm.db`.
3. Delete any `-wal` and `-shm` files next to it.
4. Start the app.

---

## 6. Updating to a new version

```bash
cd /opt/jeta-crm
npm run backup            # or the docker exec line above
git pull

# Docker
sudo docker compose up -d --build
# PM2
sudo -u jeta npm ci --omit=dev && sudo -u jeta pm2 restart jeta-crm
```

The schema migrates itself on start (`CREATE TABLE IF NOT EXISTS`). When a future version changes an existing table, its release notes will include the migration step.

---

## 7. Go-live checklist

- [ ] `SEED_DEMO=false`, and the login page shows **no** demo hint.
- [ ] `ENCRYPTION_KEY` set **and backed up** outside the server, for example in a password manager.
- [ ] Owner, Admin and Accounts have turned on two-step sign-in. It is required automatically on production, and each of them is asked to set it up at first sign-in. A lost phone is fixed with Users & roles → Reset 2FA.
- [ ] **Settings → Company & invoices** filled in: legal name, address, TRN, logo, and VAT on or off.
- [ ] **Settings → Scorecard targets** agreed with staff in writing.
- [ ] Teachers have their Google email on their profile, which is needed to match Meet attendance.
- [ ] Owner account created from `.env`. You can remove `OWNER_PASSWORD` from `.env` afterwards.
- [ ] HTTPS works, and port 3000 is not reachable from outside (`curl http://SERVER_IP:3000` should fail).
- [ ] Nightly backup runs, and one restore has been tested.
- [ ] Team added under **Users & roles**, each sales executive with their **market** (UAE / India) so round-robin works.
- [ ] Teachers added with country, subjects, grades, boards and rate per hour.
- [ ] Manager has set **Leaderboard → Set targets** (daily calls, monthly goals).
- [ ] Business rules reviewed in `src/config.js`: SLA minutes, call cadence, 25/30-day rule, attendance policy, hours alerts, points. Restart after editing.
- [ ] Server timezone noted. Times are stored in UTC and shown in each user's browser timezone.
- [ ] Optional: `WEBHOOK_KEY` set and forms connected (section 8).

### Useful commands
| Task | Command |
|---|---|
| Logs (Docker) | `docker compose logs -f` |
| Logs (PM2) | `pm2 logs jeta-crm` |
| Restart | `docker compose restart` / `pm2 restart jeta-crm` |
| Reset a lost Owner password | `node --no-warnings scripts/create-owner.js you@domain.com 'NewPassword123'` (Docker: prefix with `docker exec jeta-crm`) |
| Run tests | `npm install && npm test` |

---

## 8. Integrations

### Lead capture webhook (website form, Meta lead ads, Google Ads)
```
POST https://YOUR.DOMAIN/api/webhooks/lead?key=WEBHOOK_KEY
Content-Type: application/json

{ "source": "Meta Ads", "parent_name": "…", "phone": "+9715…", "email": "…",
  "child_name": "…", "grade": "8", "board": "CBSE", "subjects": "Maths",
  "country": "UAE", "campaign": "Oct Exam Prep", "ad_set": "Dubai parents" }
```
- `source` must be one of the sources in `src/config.js → leadSources`. Anything else becomes "Website Form".
- New leads are assigned by round-robin within the market immediately, and the rep is notified.
- For Meta and Google forms, connect them through Zapier or Make using a "Webhook POST" step, or call the endpoint from your own website backend.

### WhatsApp and email
Every alert is stored in-app. WhatsApp and email go through the adapters in `src/notify.js`, which currently just print to the log. To go live:
1. Fill in `adapters.whatsapp.send(to, text)` with your provider: Meta WhatsApp Cloud API, Interakt, Wati, Gupshup, etc. Note that the Cloud API requires approved message templates for messages that start a conversation.
2. Fill in `adapters.email.send(to, subject, text)` with SMTP (for example nodemailer) or a provider API.
3. Set the env vars and restart.

Messages already wired in:
- New-lead alert to the rep
- Welcome message to the parent
- Invoice and receipt
- Class reminders 24 hours and 1 hour before
- Instalment reminders
- Teacher payout statement
- Kudos and leaderboard notifications (in-app)

---

### Google Workspace: Jeta-owned Meet links and attendance (blueprint 11.4)
1. In Google Cloud, create a project and enable the **Google Calendar API** and the **Admin SDK API**.
2. Create a **service account**, download its JSON key and enable **domain-wide delegation** for it.
3. In the Workspace Admin console, go to **Security → API controls → Domain-wide delegation** and add the service account's client ID with these scopes:
   `https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/admin.reports.audit.readonly`
4. Set `GOOGLE_SERVICE_ACCOUNT_JSON` (a path or the JSON itself) and `GOOGLE_IMPERSONATE`, the Jeta account that owns the class calendar. Set `GOOGLE_ADMIN_IMPERSONATE` to a Workspace admin for the Reports API.
5. Restart the app. Settings → Integrations should show Google as connected.

What happens after setup:
- Scheduling a student creates **one recurring Calendar event with a Meet link** under the Jeta account and invites the teacher and parent. Guests can't see each other, which protects parent contacts.
- About 30 minutes after each class, the CRM pulls Meet participation from the Reports API and applies the rules: a class is Completed when the teacher and at least one student each attended 80% or more of the slot. If the teacher was absent, the class isn't paid and is flagged for a reschedule.
- Meet attendance data depends on your Workspace edition, so confirm access first. `src/integrations/google.js` follows Google's REST documentation but **has not been run against a live Workspace**, so test it on one class before relying on it.

**Without Google set up**, Admin pastes a Meet link that the Jeta account created on the student's schedule. Attendance then comes from:
- the **teacher's post-class form**, which teachers open from the link the CRM sends on WhatsApp;
- **Classes → Import Meet attendance**, which takes a CSV;
- a 10% random audit;
- the **Needs review** list.

### Phone tracker (blueprint 6)
- **Android app:** build `android/` in Android Studio (see `android/README.md`), sign it and install it privately or through an MDM. Reps pair a phone under **Phone tracker → Create pairing code**.
  - The app sends only calls with CRM numbers. Matching happens on the phone using hashes.
  - Connected calls arrive as entries that need notes within 10 minutes. Unanswered calls trigger the normal retry cadence, and missed incoming calls create call-back tasks.
  - **The app source hasn't been compiled here.** Build it and test it on one phone first.
- **Cloud telephony (needed for iPhones):** point the provider's call webhook at `POST /api/webhooks/telephony?key=TELEPHONY_KEY`. The body format is in `android/README.md`. Calls are matched to the rep by their email.
- Get written staff consent and check the UAE and India data-protection rules before launch (blueprint 6.4).

## 9. Blueprint decisions – defaults chosen

These are the decisions from section 21 of the blueprint. Each one is a setting, so you can change it later.

| Decision | Default in the CRM | Where to change |
|---|---|---|
| Android tracker or cloud telephony | Both supported | Phone tracker page, `TELEPHONY_KEY` |
| Google Workspace Meet reports | Used when configured. Otherwise the teacher form, Meet CSV import and audits | Env vars above |
| No-show / teacher-absence policy | Student no-show without notice: hours deducted, teacher paid. With notice, or teacher absent: no deduction, no pay, reschedule | `src/config.js` → `attendancePolicy` |
| Scorecard targets and consequences | Notes 90%, on-time follow-ups 85%, first-call SLA 90%. Coaching after 2 weeks below target | Settings → Scorecard targets |
| Payout cycle and rates | Monthly. Rates per teacher, with optional rules by subject, grade or batch | Settings → Teacher payouts; Teachers → Edit |
| Invoice company details and VAT | VAT off. Prices are VAT-inclusive when it's on. Numbering JETA-YYYY-0001 | Settings → Company & invoices |
| Zoho vs custom | Custom CRM (this codebase) | – |
| +48h escalation | Flag red and the manager takes over (or auto-reassign) | Settings → Escalation |
| Lead assignment | Round-robin by market (or least open leads) | Settings → Lead assignment |

## 10. Security notes

- Passwords are hashed with scrypt. Sessions are random 256-bit bearer tokens that last 14 days.
- Two-step sign-in (TOTP, works with Google or Microsoft Authenticator) is required for Owner, Admin and Accounts on production.
- Bank details, KYC ID numbers and document links, and 2FA secrets are encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`). Existing plain values are encrypted on the next start.
- **Audit log:** every create, edit, stage change, reassignment, merge, archive, payment, payout, export and sign-in records who, what, when, and the old and new values. Managers and the Owner can read it under Weekly review → Audit log. Nothing is hard-deleted: leads are archived with a reason, and note edits keep every version.
- CSV exports are limited to the Owner and the Sales Manager, and every export is logged.
- Every API route checks the role permission matrix in `src/auth.js`, the server-side version of the blueprint's roles table.
- Sign-in is locked for 15 minutes after 10 failed attempts per IP and email.
- Security headers are set: `nosniff`, `SAMEORIGIN`, a referrer policy and a permissions policy. Add HSTS in Nginx once HTTPS is active.
- Anti-poaching: teacher records and payout statements never include parent contact details.
- KYC fields hold document *links*. Store the actual ID scans in access-controlled storage, such as a private Google Drive or S3 bucket, and paste the link.

## 11. Scaling later

SQLite with a single instance comfortably handles this workload. If you later need several app servers, move to PostgreSQL. The SQL is standard and lives in `src/db.js` and `src/services/`. At that point, move the scheduler in `src/automation.js` into its own worker so it runs only once.

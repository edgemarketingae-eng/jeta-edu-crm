# Jeta Edu CRM

A Zoho CRM–style system for running a tuition business across the UAE and India: leads, call and WhatsApp logging, the follow-up engine, KYC, conversion, students, teachers, scheduling, attendance, hours tracking, retention, accounts and teacher payouts. It's one record that flows through three modules: **Leads → Students → Payouts**.

```
Lead → Contacted → Qualified → Demo → Negotiation → Converted (Student)
     → Teacher Assigned → Active → Hours Low → Renewed / Churned
```

Built with Node.js, Express, built-in SQLite (`node:sqlite`) and a plain-JavaScript single-page UI. It needs no build step and has one runtime dependency.

## Run it

```bash
npm install
npm start            # http://localhost:3000
```

The first boot seeds demo data. All demo passwords are `jeta1234`.

| Role | Login |
|---|---|
| Owner | owner@jeta.edu |
| Sales Manager | manager@jeta.edu |
| Sales Executive (UAE) | aisha@jeta.edu, rahul@jeta.edu |
| Sales Executive (India) | priya@jeta.edu, arjun@jeta.edu |
| Admin / Ops | admin@jeta.edu |
| Accounts | accounts@jeta.edu |

`npm run seed` wipes and reseeds. `npm test` runs the business-rule tests.

For a clean production start, set `SEED_DEMO=false`, `OWNER_EMAIL` and `OWNER_PASSWORD`, then add your team under **Users & roles**.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `DB_PATH` | `./data/jeta-crm.db` | SQLite file (put it on a persistent disk) |
| `SEED_DEMO` | `true` | Seed demo data on first boot |
| `OWNER_EMAIL` / `OWNER_PASSWORD` | – | First owner account when `SEED_DEMO=false` |
| `INR_PER_AED` | 22.7 | Rate for combined AED/INR totals |
| `WEBHOOK_KEY` | – | Enables the lead-capture webhook |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` | – | WhatsApp Business API (see `src/notify.js`) |
| `SMTP_URL` | – | Email sending |
| `AUTOMATION` | on | Set `off` to stop the scheduled rules |
| `BRAND_NAME` | Jeta Edu | Name on invoices and statements |

## How the blueprint maps to the code

All tunable numbers (SLAs, cadence, 25/30-day rule, attendance policy, hours alerts) live in `src/config.js`.

| Blueprint section | Where |
|---|---|
| 2. Roles & permissions | `src/auth.js` (`PERMS` matrix), enforced on every API route |
| 3. Lead module, sources, stages, round-robin by market | `src/services/leads.js` → `createLead`, `pickRep` |
| 4. Call outcomes and not-connected cadence | `logCall`: 6 tries over 7 days, then Nurture and a manager alert |
| 5. Follow-up engine | Every open stage requires a next follow-up. Reminders fire 30 min before, at time, +1h (owner) and +24h (manager). Reps over 10 overdue stop receiving leads |
| 6. 30-day reassignment | `runLeadRules`: warns on day 25, reassigns on day 30 (excluding the previous owner), Payment Pending and near demos are exempt, Nurture after 2 reassignments |
| 7. KYC | KYC tab: submit (completeness and consents checked), then Admin verifies or rejects |
| 8. Preset call questions | **Call notes** tab on every lead |
| 9. Conversion checklist and handoff | `convert`: KYC + package + payment (or manager-approved instalments). Creates the student, invoice, 24h admin task, Day 7/30 check-ins and a welcome WhatsApp |
| 10. Students, teacher match, scheduling, attendance, hours | `src/services/students.js`. Teacher matching, max batch of 5, clash detection, attendance policy table, 25% / 10% / 0-hour alerts |
| 11. Retention | Retention stages, logged calls, issue tickets to Admin, renewal adds hours, churn reason required |
| 12. Accounts | `src/services/finance.js` plus **Accounts**: payments, instalment reminders, refund chain (request → manager → accounts), expenses, monthly report with CAC and net margin |
| 13. Teacher payouts | Built from qualifying attendance, per-currency, adjustments → Accounts approve → paid and month locked (Owner can unlock), reconciliation check, printable statement |
| 14. Dashboards | `src/services/reports.js`, filterable by period, rep, market and source |
| 15. Automation | `src/automation.js` runs every minute; on the 1st it drafts last month's payouts |

Anti-poaching: teacher records and payout statements never carry parent contact details.

## Lead capture webhook

Point website forms, Meta lead ads (via Zapier/Make) or Google Ads at:

```
POST /api/webhooks/lead?key=YOUR_WEBHOOK_KEY
{ "source": "Meta Ads", "parent_name": "…", "phone": "+9715…", "email": "…",
  "child_name": "…", "grade": "8", "subjects": "Maths", "country": "UAE",
  "campaign": "Oct Exam Prep", "ad_set": "Dubai parents" }
```

New leads are assigned by round-robin instantly and the rep is notified.

## WhatsApp and email

`src/notify.js` routes every alert in-app and through WhatsApp and email adapters. Out of the box the adapters log to the console. Fill in `send()` with your provider (Meta Cloud API, Interakt, Wati, SMTP) to go live. Messages already wired in: lead assignment, welcome, invoice and receipt, class reminders 24h and 1h before, instalment reminders, and payout statements.

## Deploy (Render)

`render.yaml` deploys a web service with a 1 GB persistent disk for the SQLite file. On Render, choose **New → Blueprint** and select this repo. SQLite suits a single instance. If you outgrow it, the SQL is portable to Postgres.

## API

All routes live under `/api` and need `Authorization: Bearer <token>` from `POST /api/login`. See `src/routes.js` for the full list: leads, students, classes, teachers, payments, expenses, payouts, tasks, notifications, dashboard, reports and CSV exports.

// Google Workspace integration (blueprint 11.4): Jeta-owned Meet links via Google Calendar, and
// Meet attendance from the Admin SDK Reports API.
//
// Needs a Google Cloud service account with domain-wide delegation, enabled for these scopes:
//   https://www.googleapis.com/auth/calendar.events
//   https://www.googleapis.com/auth/admin.reports.audit.readonly
// and env vars:
//   GOOGLE_SERVICE_ACCOUNT_JSON  – the key file contents (JSON) or a path to it
//   GOOGLE_IMPERSONATE           – Jeta Workspace user that owns the calendar, e.g. classes@jetaedu.com
//   GOOGLE_ADMIN_IMPERSONATE     – a Workspace admin for the Reports API (defaults to GOOGLE_IMPERSONATE)
//   GOOGLE_CALENDAR_ID           – defaults to "primary"
// Meet attendance in the Reports API depends on your Workspace edition – confirm access before relying on it.
// Without these settings everything here is skipped and the CRM falls back to the teacher form + Meet CSV import.
// NOTE: written against Google's documented REST APIs but not exercised against a live Workspace from here.
const crypto = require('crypto');
const fs = require('fs');

let cachedKey = null;
const tokens = {};

function key() {
  if (cachedKey !== null) return cachedKey;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) { cachedKey = false; return false; }
  try { cachedKey = JSON.parse(raw.trim().startsWith('{') ? raw : fs.readFileSync(raw, 'utf8')); } catch { cachedKey = false; }
  return cachedKey;
}
const enabled = () => !!key() && !!process.env.GOOGLE_IMPERSONATE;
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

async function token(scope, subject) {
  const k = key();
  const cacheKey = `${scope}|${subject}`;
  if (tokens[cacheKey] && tokens[cacheKey].exp > Date.now() + 60000) return tokens[cacheKey].token;
  const nowS = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: k.client_email, sub: subject, scope, aud: 'https://oauth2.googleapis.com/token', iat: nowS, exp: nowS + 3600 })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(k.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Google auth failed: ${j.error_description || j.error}`);
  tokens[cacheKey] = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

const DAY = { sun: 'SU', mon: 'MO', tue: 'TU', wed: 'WE', thu: 'TH', fri: 'FR', sat: 'SA' };

// Creates one recurring Calendar event (one Meet link) owned by the Jeta account; teacher (and parent) invited.
async function createRecurringMeet({ title, startIso, durationHours, days, count, timezone, attendees }) {
  if (!enabled()) return null;
  const t = await token('https://www.googleapis.com/auth/calendar.events', process.env.GOOGLE_IMPERSONATE);
  const cal = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || 'primary');
  const end = new Date(new Date(startIso).getTime() + durationHours * 3600000).toISOString();
  const body = {
    summary: title,
    start: { dateTime: startIso, timeZone: timezone }, end: { dateTime: end, timeZone: timezone },
    recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${days.map((d) => DAY[d]).filter(Boolean).join(',')};COUNT=${count}`],
    attendees: attendees.filter(Boolean).map((email) => ({ email })),
    guestsCanSeeOtherGuests: false, // anti-poaching: teacher does not see the parent's email
    conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 1440 }, { method: 'popup', minutes: 60 }] },
  };
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${cal}/events?conferenceDataVersion=1&sendUpdates=all`, {
    method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Calendar error: ${j.error?.message || res.status}`);
  return { eventId: j.id, meetLink: j.hangoutLink || j.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri };
}

// Participants and minutes for one meeting code between two times (Reports API "call_ended" events).
async function meetAttendance({ meetingCode, from, to }) {
  if (!enabled()) return null;
  const subject = process.env.GOOGLE_ADMIN_IMPERSONATE || process.env.GOOGLE_IMPERSONATE;
  const t = await token('https://www.googleapis.com/auth/admin.reports.audit.readonly', subject);
  const code = meetingCode.replace(/-/g, '').toLowerCase();
  const params = new URLSearchParams({ eventName: 'call_ended', startTime: from, endTime: to, filters: `meeting_code==${code.toUpperCase()}`, maxResults: '1000' });
  const res = await fetch(`https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications/meet?${params}`, { headers: { Authorization: `Bearer ${t}` } });
  const j = await res.json();
  if (!res.ok) throw new Error(`Reports API error: ${j.error?.message || res.status}`);
  const minutes = {};
  for (const item of j.items || []) {
    for (const ev of item.events || []) {
      const p = Object.fromEntries((ev.parameters || []).map((x) => [x.name, x.value ?? x.intValue ?? x.boolValue]));
      const who = String(p.identifier || item.actor?.email || p.display_name || 'unknown').toLowerCase();
      minutes[who] = (minutes[who] || 0) + Number(p.duration_seconds || 0) / 60;
    }
  }
  return Object.entries(minutes).map(([email, m]) => ({ email, minutes: Math.round(m) }));
}

const meetingCodeFrom = (link) => (String(link || '').match(/meet\.google\.com\/([a-z]{3}-?[a-z]{4}-?[a-z]{3})/i) || [])[1] || null;

module.exports = { enabled, createRecurringMeet, meetAttendance, meetingCodeFrom };

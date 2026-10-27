# Jeta Call Tracker (Android)

Optional companion app for **company-owned Android phones** (blueprint section 6). It reads the call log and sends the CRM only calls with parents and students that already exist in the CRM. Dials and talk time are then measured, not self-reported.

> This project is source code. It was written for Android Studio, but **it has not been compiled or tested on a device yet**. Your developer should build it and test it on one phone before rolling it out.

## How it works
1. In the CRM, the rep opens **My phone tracker** and taps **Create pairing code**, which gives a 6-digit code valid for 10 minutes.
2. On the phone, install the APK, open it, accept the notice, and enter the CRM address and the code.
3. Every 15 minutes (or on **Sync now**), the app:
   - downloads SHA-256 hashes of the rep's CRM numbers (`GET /api/device/numbers`);
   - reads new call-log entries, normalises each number the same way the CRM does (`Phone.kt` and `src/util.js`), and keeps only the ones whose hash matches;
   - uploads those calls (`POST /api/device/events`) with an event ID, direction, start time, duration and SIM.
4. The CRM handles each type of call:
   - **Connected calls** (20 seconds or longer): it pre-creates the call entry and asks the rep to add notes within 10 minutes.
   - **Unanswered calls:** it runs the not-connected cadence (WhatsApp task and retry schedule).
   - **Missed incoming calls:** it creates a high-priority call-back task.
5. Calls queue up when the phone is offline. The sync point only moves forward after a successful upload, so calls aren't lost. Re-sending a call is ignored, because each event ID is unique per device.

## Build
- Android Studio Koala or newer, JDK 17. Open the `android/` folder and let Gradle sync.
- Use **Build › Generate Signed Bundle / APK › APK** and sign it with your company keystore.
- Distribute it **privately**, by direct install or through an MDM such as Android Enterprise or Intune. Google Play restricts call-log permissions to default dialler apps.

## Permissions
`READ_CALL_LOG` and `READ_PHONE_STATE` (both asked for at runtime), plus `INTERNET` and `RECEIVE_BOOT_COMPLETED`. The app does **not** record calls and cannot read WhatsApp.

## Privacy and consent (blueprint 6.4)
- Use it on company phones and work numbers only, with written staff consent in the employment agreement.
- The app shows its notice before pairing and lists the last 50 records it sent.
- Personal calls are filtered out on the phone and never leave it.
- Confirm the UAE and India data-protection requirements with a lawyer before launch.

## Instead of the app: cloud telephony
If your provider (for example an approved VoIP or telephony platform) can send call webhooks, point it at:
```
POST https://YOUR.DOMAIN/api/webhooks/telephony?key=TELEPHONY_KEY
{ "agent_email": "aisha@jetaedu.com", "number": "+9715…", "direction": "outgoing",
  "started_at": "2026-10-27T10:00:00Z", "duration_sec": 140, "call_id": "abc123", "recording_url": "https://…" }
```
It goes through the same matching, notes and metrics as the app, and recordings appear on the call entry. This also works for iPhones, because iOS doesn't allow apps to read the call log.

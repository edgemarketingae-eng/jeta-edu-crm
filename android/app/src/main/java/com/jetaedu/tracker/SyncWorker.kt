package com.jetaedu.tracker

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CallLog
import androidx.work.*
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.TimeUnit

/**
 * Reads new call-log entries, keeps only numbers that exist in the CRM (hash match on the phone),
 * and uploads them. If the upload fails, lastCallMs is not advanced, so calls stay queued (offline-safe).
 */
class SyncWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {

    override fun doWork(): Result {
        val store = Store(applicationContext)
        if (store.token.isEmpty() || !store.consented) return Result.success()
        if (applicationContext.checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) return Result.success()
        return try {
            val n = syncNow(applicationContext)
            store.lastSync = iso(System.currentTimeMillis()) + " · $n sent"
            Result.success()
        } catch (e: ApiException) {
            store.lastSync = "failed: ${e.message}"
            if (e.status == 401) Result.failure() else Result.retry()
        } catch (e: Exception) {
            store.lastSync = "waiting for network"
            Result.retry()
        }
    }

    companion object {
        private const val NAME = "jeta-call-sync"

        fun schedule(ctx: Context) {
            val req = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, req)
        }

        fun runOnce(ctx: Context) {
            WorkManager.getInstance(ctx).enqueue(
                OneTimeWorkRequestBuilder<SyncWorker>()
                    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
            )
        }

        fun iso(ms: Long): String {
            val f = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
            f.timeZone = TimeZone.getTimeZone("UTC")
            return f.format(Date(ms))
        }

        /** Returns number of calls uploaded. */
        fun syncNow(ctx: Context): Int {
            val store = Store(ctx)
            val api = Api(store.server, store.token)
            val nums = api.numbers()
            val country = nums.optString("default_country", "UAE")
            val hashes = HashSet<String>()
            val arr = nums.getJSONArray("hashes")
            for (i in 0 until arr.length()) hashes.add(arr.getString(i))

            val since = if (store.lastCallMs > 0) store.lastCallMs else System.currentTimeMillis() - 24 * 3600 * 1000L
            val cols = arrayOf(CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION, CallLog.Calls.PHONE_ACCOUNT_ID)
            val events = JSONArray()
            var newest = since
            ctx.contentResolver.query(CallLog.Calls.CONTENT_URI, cols, "${CallLog.Calls.DATE} > ?", arrayOf(since.toString()), "${CallLog.Calls.DATE} ASC")?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getLong(0)
                    val number = c.getString(1) ?: ""
                    val type = c.getInt(2)
                    val date = c.getLong(3)
                    val duration = c.getLong(4)
                    val sim = c.getString(5)
                    newest = maxOf(newest, date)
                    val norm = Phone.normalize(number, country)
                    if (norm.isEmpty() || !hashes.contains(Phone.sha256(norm))) continue   // personal call: stays on the phone
                    val direction = when (type) {
                        CallLog.Calls.OUTGOING_TYPE -> "outgoing"
                        CallLog.Calls.INCOMING_TYPE -> "incoming"
                        else -> "missed" // MISSED, REJECTED, BLOCKED, VOICEMAIL
                    }
                    events.put(JSONObject()
                        .put("event_id", "$id-$date")
                        .put("number", number)
                        .put("direction", direction)
                        .put("started_at", iso(date))
                        .put("duration_sec", duration)
                        .put("sim", sim ?: ""))
                }
            }
            var sent = 0
            var i = 0
            while (i < events.length()) {
                val batch = JSONArray()
                for (j in i until minOf(i + 200, events.length())) batch.put(events.get(j))
                api.events(batch)
                val shown = (0 until batch.length()).map { k ->
                    val e = batch.getJSONObject(k)
                    JSONObject().put("when", e.getString("started_at")).put("dir", e.getString("direction")).put("sec", e.getLong("duration_sec")).put("number", e.getString("number"))
                }
                store.addSent(shown)
                sent += batch.length()
                i += 200
            }
            store.lastCallMs = newest   // only after every batch succeeded
            return sent
        }
    }
}

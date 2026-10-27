package com.jetaedu.tracker

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Small wrapper around SharedPreferences. */
class Store(ctx: Context) {
    private val p = ctx.getSharedPreferences("jeta_tracker", Context.MODE_PRIVATE)

    var server: String
        get() = p.getString("server", "") ?: ""
        set(v) = p.edit().putString("server", v.trimEnd('/')).apply()
    var token: String
        get() = p.getString("token", "") ?: ""
        set(v) = p.edit().putString("token", v).apply()
    var userName: String
        get() = p.getString("user", "") ?: ""
        set(v) = p.edit().putString("user", v).apply()
    /** Call-log timestamp (ms) of the newest call already processed. Calls after it are queued. */
    var lastCallMs: Long
        get() = p.getLong("last_call_ms", 0L)
        set(v) = p.edit().putLong("last_call_ms", v).apply()
    var lastSync: String
        get() = p.getString("last_sync", "never") ?: "never"
        set(v) = p.edit().putString("last_sync", v).apply()
    var consented: Boolean
        get() = p.getBoolean("consent", false)
        set(v) = p.edit().putBoolean("consent", v).apply()

    /** Last 50 records sent to the CRM, shown in the app (staff can see what is recorded). */
    fun addSent(items: List<JSONObject>) {
        val arr = JSONArray(p.getString("sent", "[]"))
        items.forEach { arr.put(it) }
        val keep = JSONArray()
        val start = maxOf(0, arr.length() - 50)
        for (i in start until arr.length()) keep.put(arr.get(i))
        p.edit().putString("sent", keep.toString()).apply()
    }
    fun sent(): JSONArray = JSONArray(p.getString("sent", "[]"))

    fun clear() = p.edit().clear().apply()
}

package com.jetaedu.tracker

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.*
import kotlin.concurrent.thread

/** One screen: consent + pairing, then status, "Sync now" and the list of what was sent. */
class MainActivity : Activity() {
    private lateinit var store: Store
    private val green = Color.parseColor("#1F5C4E")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store(this)
        render()
    }

    override fun onResume() { super.onResume(); render() }

    private fun render() {
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48, 64, 48, 48) }
        root.addView(text("Jeta Call Tracker", 24f, bold = true))
        root.addView(text(getString(R.string.notice), 14f).also { it.setPadding(0, 24, 0, 24) })
        if (store.token.isEmpty()) pairForm(root) else status(root)
        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun pairForm(root: LinearLayout) {
        val consent = CheckBox(this).apply { text = "I have read this and agree (company phone)"; isChecked = store.consented }
        val server = EditText(this).apply { hint = "CRM address, e.g. https://crm.jetaedu.com"; setText(store.server.ifEmpty { "https://" }); inputType = InputType.TYPE_TEXT_VARIATION_URI }
        val code = EditText(this).apply { hint = "6-digit pairing code from the CRM"; inputType = InputType.TYPE_CLASS_NUMBER }
        val btn = button("Pair this phone") {
            if (!consent.isChecked) return@button toast("Tick the consent box first")
            if (!hasPerms()) return@button requestPerms()
            store.consented = true
            store.server = server.text.toString().trim()
            thread {
                try {
                    val r = Api(store.server).pair(code.text.toString().trim(), "${Build.MANUFACTURER} ${Build.MODEL}")
                    store.token = r.getString("token")
                    store.userName = r.getJSONObject("user").optString("name")
                    store.lastCallMs = System.currentTimeMillis() - 60 * 60 * 1000L // start with the last hour
                    SyncWorker.schedule(this); SyncWorker.runOnce(this)
                    runOnUiThread { toast("Paired"); render() }
                } catch (e: Exception) { runOnUiThread { toast(e.message ?: "Pairing failed") } }
            }
        }
        listOf(consent, label("CRM address"), server, label("Pairing code (CRM → My phone tracker)"), code, btn).forEach { root.addView(it) }
    }

    private fun status(root: LinearLayout) {
        root.addView(text("Paired to ${store.userName}", 16f, bold = true))
        root.addView(text("Server: ${store.server}", 13f))
        root.addView(text("Last sync: ${store.lastSync}", 13f))
        if (!hasPerms()) root.addView(button("Allow call-log access") { requestPerms() })
        root.addView(button("Sync now") { SyncWorker.runOnce(this); toast("Syncing…") })
        root.addView(text("Sent to the CRM (latest 50)", 15f, bold = true).also { it.setPadding(0, 32, 0, 8) })
        val sent = store.sent()
        if (sent.length() == 0) root.addView(text("Nothing yet. Only calls with CRM parents appear here.", 13f))
        for (i in sent.length() - 1 downTo 0) {
            val e = sent.getJSONObject(i)
            root.addView(text("${e.optString("when").replace('T', ' ').take(16)}  ${e.optString("dir")}  ${e.optLong("sec")}s  ${e.optString("number")}", 13f))
        }
        root.addView(button("Unpair this phone") { store.clear(); render() }.also { it.setBackgroundColor(Color.LTGRAY); it.setTextColor(Color.BLACK) })
    }

    private fun hasPerms() = checkSelfPermission(Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED
    private fun requestPerms() = requestPermissions(arrayOf(Manifest.permission.READ_CALL_LOG, Manifest.permission.READ_PHONE_STATE), 7)

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        render()
    }

    private fun text(s: String, size: Float, bold: Boolean = false) = TextView(this).apply {
        text = s; textSize = size; setTextColor(Color.parseColor("#1D2926")); if (bold) typeface = Typeface.DEFAULT_BOLD; setPadding(0, 6, 0, 6)
    }
    private fun label(s: String) = text(s, 12f).also { it.setPadding(0, 24, 0, 0) }
    private fun button(s: String, onClick: (View) -> Unit) = Button(this).apply {
        text = s; setBackgroundColor(green); setTextColor(Color.WHITE); isAllCaps = false; gravity = Gravity.CENTER
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = 24 }
        setOnClickListener(onClick)
    }
    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()
}

package com.jetaedu.tracker

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Minimal HTTPS client for the CRM device API. */
class Api(private val server: String, private val token: String = "") {

    fun pair(code: String, deviceName: String): JSONObject =
        request("POST", "/api/device/pair", JSONObject().put("code", code).put("device_name", deviceName).put("platform", "android"))

    fun numbers(): JSONObject = request("GET", "/api/device/numbers", null)

    fun events(events: JSONArray): JSONObject =
        request("POST", "/api/device/events", JSONObject().put("events", events))

    private fun request(method: String, path: String, body: JSONObject?): JSONObject {
        val c = URL(server + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 15000
        c.readTimeout = 30000
        c.setRequestProperty("Content-Type", "application/json")
        if (token.isNotEmpty()) c.setRequestProperty("X-Device-Token", token)
        if (body != null) {
            c.doOutput = true
            c.outputStream.use { it.write(body.toString().toByteArray()) }
        }
        val code = c.responseCode
        val text = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: "{}"
        c.disconnect()
        val json = try { JSONObject(text) } catch (e: Exception) { JSONObject().put("error", text) }
        if (code !in 200..299) throw ApiException(code, json.optString("error", "HTTP $code"))
        return json
    }
}

class ApiException(val status: Int, message: String) : Exception(message)

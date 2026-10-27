package com.jetaedu.tracker

import java.security.MessageDigest

/** Must match normalizePhone() in the CRM (src/util.js) so hashes line up. */
object Phone {
    fun normalize(raw: String?, country: String?): String {
        var d = (raw ?: "").filter { it.isDigit() }
        if (d.startsWith("00")) d = d.substring(2)
        d = when {
            d.length == 10 && d.startsWith("05") -> "971" + d.substring(1)
            d.length == 9 && d.startsWith("5") -> "971$d"
            d.length == 10 && d[0] in '6'..'9' && country != "UAE" -> "91$d"
            d.length == 11 && d.startsWith("0") && d[1] in '6'..'9' -> "91" + d.substring(1)
            else -> d
        }
        return d
    }

    fun sha256(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
}

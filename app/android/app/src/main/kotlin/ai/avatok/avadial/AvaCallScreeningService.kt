package ai.avatok.avadial

import android.telecom.Call
import android.telecom.CallScreeningService
import org.json.JSONObject
import java.security.MessageDigest

/**
 * Spam screening (spike §3, §5). Granted via ROLE_CALL_SCREENING — does NOT need
 * the full dialer role.
 *
 * HARD LATENCY BUDGET: the OS holds the call while [onScreenCall] runs, and this
 * service may run with the Flutter engine DEAD, so it decides purely from a local
 * file — NEVER a network call. It reads the snapshot Flutter maintains at
 * `<filesDir>/avadial/spam_snapshot.json` (written atomically by the Dart side),
 * hashes the incoming number the same way Dart does (SHA-256 of the E.164 string,
 * lowercase hex), and does an exact-match lookup.
 *
 * Phase 2b policy is LABEL, not auto-reject: even a hit is ALLOWED through (so we
 * never manufacture a false-positive missed call); the red/green/blue paint happens
 * in the InCallService UI. Hard auto-reject is a later, config-gated step. Missing /
 * corrupt snapshot → fail-OPEN (allow).
 */
class AvaCallScreeningService : CallScreeningService() {

    override fun onScreenCall(callDetails: Call.Details) {
        val response = CallResponse.Builder()
        var bucket = "unknown"
        try {
            val raw = callDetails.handle?.schemeSpecificPart // the tel: number
            if (!raw.isNullOrEmpty()) {
                val score = lookup(raw)
                if (score != null) {
                    val warn = warnThreshold
                    bucket = if (score >= warn) "red" else "reported"
                }
            }
        } catch (_: Throwable) {
            // fail-open: any error → allow the call untouched
        }
        // Phase 2b: allow every call (label-only). Do not disallow/reject here.
        // (setSilenceCall is API 33+ and defaults false, so we don't set it.)
        response.setDisallowCall(false)
        response.setRejectCall(false)
        respondToCall(callDetails, response.build())

        // Best-effort telemetry hop to Dart when the engine is alive.
        AvaDialPlugin.emit("onScreeningVerdict", mapOf("bucket" to bucket))
    }

    // ── Local snapshot ────────────────────────────────────────────────────────
    private var warnThreshold: Int = 70

    /** Returns the stored spam score for [rawNumber], or null if not present. */
    private fun lookup(rawNumber: String): Int? {
        val file = AvaDialPlugin.snapshotFile(applicationContext)
        if (!file.exists() || file.length() == 0L) return null
        val json = try {
            JSONObject(file.readText())
        } catch (_: Throwable) {
            return null
        }
        warnThreshold = json.optInt("warn_threshold", 70)
        val scores = json.optJSONObject("scores") ?: return null
        val hash = sha256Hex(rawNumber)
        return if (scores.has(hash)) scores.optInt(hash, 0) else null
    }

    private fun sha256Hex(s: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        val bytes = md.digest(s.toByteArray(Charsets.UTF_8))
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            if (v < 0x10) sb.append('0')
            sb.append(Integer.toHexString(v))
        }
        return sb.toString()
    }
}

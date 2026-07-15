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

    companion object {
        // [AVADIAL-HARDEN-3] The screening verdict (score/bucket) computed here never
        // reached PstnCallScreen — AvaInCallService.onCallAdded fires moments later
        // for the SAME incoming number but has no way to see what this service just
        // decided. Stash it in a tiny shared, capped, self-expiring map so
        // AvaInCallService (and MainActivity's cold-start intent extras) can look it
        // up by number. Capacity ~8 + a 2-minute TTL keeps this from ever growing
        // unbounded — a call is answered/declined/expires long before either limit
        // matters in practice.
        private const val MAX_ENTRIES = 8
        private const val TTL_MS = 2 * 60 * 1000L

        data class Verdict(val score: Int?, val bucket: String, val atMs: Long)

        // LinkedHashMap preserves insertion order, which is all we need to evict the
        // oldest entry once we're over MAX_ENTRIES.
        private val recentVerdicts = LinkedHashMap<String, Verdict>()

        /** Record the verdict for [rawNumber] (the tel: scheme-specific part) so
         *  [AvaInCallService] can pick it up for the same incoming call. */
        @Synchronized
        fun stashVerdict(rawNumber: String, score: Int?, bucket: String) {
            pruneLocked()
            recentVerdicts.remove(rawNumber) // re-insert at the end (freshest)
            recentVerdicts[rawNumber] = Verdict(score, bucket, System.currentTimeMillis())
            while (recentVerdicts.size > MAX_ENTRIES) {
                val oldest = recentVerdicts.keys.firstOrNull() ?: break
                recentVerdicts.remove(oldest)
            }
        }

        /** Look up (and consume-in-place, i.e. leave for any other reader) the
         *  stashed verdict for [rawNumber]. Null if never screened, expired, or the
         *  number format didn't match exactly. */
        @Synchronized
        fun takeVerdict(rawNumber: String): Verdict? {
            pruneLocked()
            return recentVerdicts[rawNumber]
        }

        private fun pruneLocked() {
            val cutoff = System.currentTimeMillis() - TTL_MS
            val it = recentVerdicts.entries.iterator()
            while (it.hasNext()) {
                if (it.next().value.atMs < cutoff) it.remove()
            }
        }

        /**
         * [AVADIAL-NATIVE-INCALL-1] The CONFIGURED warn threshold from the snapshot
         * Dart maintains — the same `warn_threshold` this service screens against.
         *
         * WHY: IncomingCallActivity used to hardcode `WARN_THRESHOLD = 70` and never
         * read the snapshot, so the screening service and the UI could disagree, and
         * tuning the threshold server-side changed the scoring but NOT the red paint
         * the user actually sees. Now both read the same number.
         *
         * Falls back to [AvaCallTheme.WARN_THRESHOLD_FALLBACK] when the snapshot is
         * missing/corrupt (same fail-open posture as [lookup]).
         */
        fun warnThresholdOf(context: android.content.Context): Int = try {
            val f = AvaDialPlugin.snapshotFile(context)
            if (!f.exists() || f.length() == 0L) AvaCallTheme.WARN_THRESHOLD_FALLBACK
            else JSONObject(f.readText())
                .optInt("warn_threshold", AvaCallTheme.WARN_THRESHOLD_FALLBACK)
        } catch (_: Throwable) {
            AvaCallTheme.WARN_THRESHOLD_FALLBACK
        }
    }

    override fun onScreenCall(callDetails: Call.Details) {
        val response = CallResponse.Builder()
        var bucket = "unknown"
        var score: Int? = null
        val raw = callDetails.handle?.schemeSpecificPart // the tel: number
        try {
            if (!raw.isNullOrEmpty()) {
                score = lookup(raw)
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

        if (!raw.isNullOrEmpty()) stashVerdict(raw, score, bucket)

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

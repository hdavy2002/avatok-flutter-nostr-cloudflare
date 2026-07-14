package ai.avatok.avadial

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.CallLog
import android.telephony.TelephonyManager
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * [AVA-MISSEDCALL-1] Detects a MISSED incoming call and raises the Truecaller-style
 * [AvaMissedCallOverlay]. Registered for `android.intent.action.PHONE_STATE` — a
 * protected broadcast the OS delivers to a manifest receiver holding READ_PHONE_STATE,
 * and one of the few implicit broadcasts still allowed to a manifest receiver on
 * Android 8+.
 *
 * Missed = we saw RINGING and then went IDLE WITHOUT ever passing through OFFHOOK (an
 * OFFHOOK means the call was answered — or it was an outgoing call, which starts at
 * OFFHOOK and so is ignored). State is tracked in the companion because the OS spins up
 * a fresh receiver instance per broadcast.
 *
 * The number comes from EXTRA_INCOMING_NUMBER when the OS provides it (it does while we
 * hold READ_CALL_LOG); otherwise we read the most recent MISSED row from the call log.
 * Caller name + AvaTOK status come purely from the on-device directory snapshot Dart
 * maintains ([AvaDialPlugin.avatokDirFile]) — NEVER a network call on this path. A late
 * backend confirm (the "cache then backend" flow) rides the `onMissedCall` event to Dart,
 * which re-paints via [AvaMissedCallOverlay.update].
 *
 * Fully DARK until Dart writes `{enabled:true}` into the missed-call config file, which it
 * only does when the `missedCallOverlay` flag is on AND the user granted "appear on top".
 */
class AvaMissedCallReceiver : BroadcastReceiver() {

    companion object {
        @Volatile private var sawRinging = false
        @Volatile private var wasOffhook = false
        @Volatile private var incomingNumber: String? = null
        @Volatile private var ringStartMs = 0L
        @Volatile private var lastState: String? = null
    }

    override fun onReceive(context: Context?, intent: Intent?) {
        val ctx = context?.applicationContext ?: return
        if (intent?.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return

        val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE) ?: return
        if (state == lastState) return // de-dupe duplicate broadcasts
        lastState = state

        when (state) {
            TelephonyManager.EXTRA_STATE_RINGING -> {
                sawRinging = true
                wasOffhook = false
                ringStartMs = System.currentTimeMillis()
                // Best-effort — only present when we hold READ_CALL_LOG.
                intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)
                    ?.takeIf { it.isNotBlank() }?.let { incomingNumber = it }
            }

            TelephonyManager.EXTRA_STATE_OFFHOOK -> {
                wasOffhook = true
            }

            TelephonyManager.EXTRA_STATE_IDLE -> {
                val missed = sawRinging && !wasOffhook
                val ringSecs = if (ringStartMs > 0) {
                    ((System.currentTimeMillis() - ringStartMs) / 1000L).toInt().coerceIn(0, 600)
                } else 0
                val number = incomingNumber
                // Reset before any heavy work so a re-entrant broadcast can't double-fire.
                sawRinging = false
                wasOffhook = false
                incomingNumber = null
                ringStartMs = 0L
                if (missed) handleMissed(ctx, number, ringSecs)
            }
        }
    }

    private fun handleMissed(ctx: Context, ringNumber: String?, ringSecs: Int) {
        if (!isEnabled(ctx)) return
        if (!AvaMissedCallOverlay.canDraw(ctx)) return

        // The OS often withholds the ring number; fall back to the newest MISSED row.
        val number = ringNumber ?: latestMissedNumber(ctx)
        if (number.isNullOrBlank()) return

        val entry = lookupDirectory(ctx, number)
        val info = AvaMissedCallOverlay.Info(
            number = number,
            name = entry?.optString("name")?.takeIf { it.isNotBlank() },
            ringSecs = ringSecs,
            isAvatok = entry?.optBoolean("ava", false) ?: false,
            avatokNumber = entry?.optString("avatok_number")?.takeIf { it.isNotBlank() },
        )
        AvaMissedCallOverlay.show(ctx, info)

        // Best-effort telemetry + live backend confirm hop (engine may be dead — no-op).
        // No raw number crosses to Dart telemetry; the confirm carries the number so Dart
        // can re-check membership and call AvaMissedCallOverlay.update.
        AvaDialPlugin.emit(
            "onMissedCall",
            mapOf(
                "number" to number,
                "ring_secs" to ringSecs,
                "is_avatok_cached" to info.isAvatok,
            ),
        )

        // Live confirm even when the app is DEAD: the on-device cache only knew what the
        // last sync saw, so if it said "not on AvaTOK" (or had no entry) do a tiny
        // device-token lookup on a background thread and re-paint the badge bright on a
        // hit. When the Flutter engine happens to be alive, MissedCallService does the
        // same over Clerk auth — either path lands on AvaMissedCallOverlay.update.
        if (!info.isAvatok) confirmViaBackend(ctx, number)
    }

    /** Read the native config `{enabled, token, base}` Dart writes. */
    private fun readConfig(ctx: Context): JSONObject? {
        val f = AvaDialPlugin.missedCallConfigFile(ctx)
        if (!f.exists() || f.length() == 0L) return null
        return try {
            JSONObject(f.readText())
        } catch (_: Throwable) {
            null
        }
    }

    /** Is the feature switched on? Dart writes `{enabled:true}` only when the flag +
     *  overlay permission are both satisfied. Missing/false → DARK. */
    private fun isEnabled(ctx: Context): Boolean = readConfig(ctx)?.optBoolean("enabled", false) ?: false

    /**
     * Background-thread membership confirm via the device-token lane
     * (/api/missedcall/lookup). Uses the long-lived HMAC token Dart minted + stored in the
     * config, so it authenticates with NO Clerk JWT (unavailable cold-start). Best-effort:
     * any error (offline, expired token, 401) leaves the cached grey badge untouched.
     */
    private fun confirmViaBackend(ctx: Context, number: String) {
        val cfg = readConfig(ctx) ?: return
        val token = cfg.optString("token", "")
        val base = cfg.optString("base", "")
        if (token.isEmpty() || base.isEmpty()) return
        Thread {
            var conn: HttpURLConnection? = null
            try {
                val url = URL("https://$base/api/missedcall/lookup")
                conn = (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 4000
                    readTimeout = 5000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                }
                val body = JSONObject()
                    .put("token", token)
                    .put("numbers", JSONArray().put(number))
                    .toString()
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                if (conn.responseCode != 200) return@Thread
                val text = conn.inputStream.bufferedReader().use { it.readText() }
                val matched = JSONObject(text).optJSONArray("matched") ?: return@Thread
                if (matched.length() == 0) return@Thread
                val first = matched.optJSONObject(0)
                val name = first?.optString("name")?.takeIf { it.isNotBlank() }
                // Re-paint the still-showing card bright (update no-ops if it's gone).
                AvaMissedCallOverlay.update(number, true, name)
            } catch (_: Throwable) {
                // best-effort — offline / expired token / provider hiccup
            } finally {
                try { conn?.disconnect() } catch (_: Throwable) {}
            }
        }.start()
    }

    /** Newest MISSED_TYPE call-log number (READ_CALL_LOG). Null if unreadable. */
    private fun latestMissedNumber(ctx: Context): String? {
        return try {
            ctx.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.TYPE),
                "${CallLog.Calls.TYPE} = ?",
                arrayOf(CallLog.Calls.MISSED_TYPE.toString()),
                "${CallLog.Calls.DATE} DESC",
            )?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        } catch (_: Throwable) {
            null // no READ_CALL_LOG grant or provider hiccup
        }
    }

    /**
     * Look the caller up in the on-device directory snapshot. Keyed by
     * `sha256(last-10-digits)` so a contact stored as "+1 (555) 010-2020" and a call-log
     * number "5550102020" collide to the same key regardless of formatting — the same
     * scheme Dart uses when it writes the snapshot.
     */
    private fun lookupDirectory(ctx: Context, number: String): JSONObject? {
        val file = AvaDialPlugin.avatokDirFile(ctx)
        if (!file.exists() || file.length() == 0L) return null
        val entries = try {
            JSONObject(file.readText()).optJSONObject("entries") ?: return null
        } catch (_: Throwable) {
            return null
        }
        val key = sha256Hex(last10(number))
        return if (entries.has(key)) entries.optJSONObject(key) else null
    }

    private fun last10(number: String): String {
        val digits = number.filter { it.isDigit() }
        return if (digits.length > 10) digits.substring(digits.length - 10) else digits
    }

    private fun sha256Hex(s: String): String {
        val bytes = MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            if (v < 0x10) sb.append('0')
            sb.append(Integer.toHexString(v))
        }
        return sb.toString()
    }
}

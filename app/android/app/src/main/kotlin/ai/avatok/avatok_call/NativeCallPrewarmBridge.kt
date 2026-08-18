package ai.avatok.avatok_call

import android.content.Context
import androidx.annotation.Keep
import org.json.JSONObject

/** Default-off, media-free state boundary for silent incoming-call prewarm. */
@Keep
object NativeCallPrewarmBridge {
    const val PHASE_PREWARMING = "PREWARMING"
    const val PHASE_READY = "READY"
    const val PHASE_RINGING = "RINGING"
    const val PHASE_ACCEPTED = "ACCEPTED"
    const val PHASE_DECLINED = "DECLINED"
    const val PHASE_TERMINATED = "TERMINATED"
    private const val PREFS = "avatok_call_prewarm_v1"
    private const val STATE = "state"
    private const val ENABLED = "enabled"
    private const val DEFAULT_TTL_MS = 60_000L
    private const val MAX_TTL_MS = 120_000L

    /** Call identity is exact at every state boundary; ordering is server-owned. */
    @JvmStatic
    fun generationMatches(current: String, incoming: String): Boolean {
        return current.isNotEmpty() && current == incoming
    }

    @JvmStatic
    fun sequenceIsNewer(previous: Long, incoming: Long): Boolean = incoming > 0 && incoming > previous

    @JvmStatic
    @Synchronized
    fun setEnabled(context: Context, enabled: Boolean) {
        val edit = prefs(context).edit().putBoolean(ENABLED, enabled)
        if (!enabled) edit.remove(STATE)
        edit.commit()
    }

    @JvmStatic
    fun isEnabled(context: Context): Boolean = prefs(context).getBoolean(ENABLED, false)

    /** Start once per invite. Returns false for disabled, expired, or stale FCM. */
    @JvmStatic
    @Synchronized
    fun start(context: Context, callId: String, nonce: String, generation: String, expiresAtMs: Long = 0L): Boolean {
        if (!isEnabled(context) || callId.isBlank() || nonce.isBlank() || generation.isBlank()) return false
        val now = System.currentTimeMillis()
        if (expiresAtMs > 0 && expiresAtMs <= now) return false
        val old = read(context)
        if (old != null && !expired(old, now)) {
            if (old.callId == callId) {
                return old.nonce == nonce && generationMatches(old.generation, generation)
            }
        }
        val expiry = if (expiresAtMs > now) {
            minOf(expiresAtMs, now + MAX_TTL_MS)
        } else {
            now + DEFAULT_TTL_MS
        }
        write(context, Record(callId, nonce, generation, PHASE_PREWARMING, now, expiry))
        return true
    }

    /** Exact identity check for stale native intents; it never changes phase. */
    @JvmStatic
    @Synchronized
    fun isCurrent(context: Context, callId: String, nonce: String, generation: String): Boolean {
        if (!isEnabled(context) || callId.isBlank() || nonce.isBlank() || generation.isBlank()) return false
        val now = System.currentTimeMillis()
        val r = read(context) ?: return false
        return !expired(r, now) &&
            r.phase == PHASE_RINGING &&
            r.callId == callId && r.nonce == nonce && generationMatches(r.generation, generation)
    }

    @JvmStatic
    @Synchronized
    fun ready(context: Context, callId: String, nonce: String, generation: String): Boolean =
        mutate(context, callId, nonce, generation) { r ->
            if (r.phase != PHASE_PREWARMING) null else r.copy(phase = PHASE_READY, readyAtMs = System.currentTimeMillis())
        }

    /** Failed prewarm is recorded but never blocks the normal ring fallback. */
    @JvmStatic
    @Synchronized
    fun failed(context: Context, callId: String, nonce: String, generation: String, reason: String): Boolean =
        mutate(context, callId, nonce, generation) { r ->
            if (r.phase != PHASE_PREWARMING) null else r.copy(fallback = true, reason = reason.take(120))
        }

    /** Only a strictly newer server transition may start the real ring. */
    @JvmStatic
    @Synchronized
    fun ringing(
        context: Context,
        callId: String,
        nonce: String,
        generation: String,
        serverSequence: Long,
        expiresAtMs: Long = 0L,
    ): Boolean {
        if (!isEnabled(context) || callId.isBlank() || nonce.isBlank() || generation.isBlank() || serverSequence <= 0L) return false
        val now = System.currentTimeMillis()
        if (expiresAtMs > 0L && expiresAtMs <= now) return false
        val old = read(context)
        if (old == null || expired(old, now)) {
            val expiry = if (expiresAtMs > now) minOf(expiresAtMs, now + MAX_TTL_MS) else now + DEFAULT_TTL_MS
            write(context, Record(callId, nonce, generation, PHASE_RINGING, now, expiry, ringAtMs = now, serverSequence = serverSequence))
            return true
        }
        if (old.callId != callId || old.nonce != nonce || !generationMatches(old.generation, generation)) {
            // A genuine redial must be able to supersede a missed ring, while
            // a late FCM from the older invite must not replace the newer one.
            // Capability expiry is server-issued and monotonic across those
            // overlapping invites; missing/older evidence fails closed.
            if (expiresAtMs <= old.expiresAtMs) return false
            val expiry = minOf(expiresAtMs, now + MAX_TTL_MS)
            write(context, Record(callId, nonce, generation, PHASE_RINGING, now, expiry, ringAtMs = now, serverSequence = serverSequence))
            return true
        }
        if (old.phase != PHASE_PREWARMING && old.phase != PHASE_READY) return false
        if (!sequenceIsNewer(old.serverSequence, serverSequence)) return false
        write(context, old.copy(phase = PHASE_RINGING, serverSequence = serverSequence, ringAtMs = old.ringAtMs ?: now))
        return true
    }

    /** First local/remote terminal signal wins; duplicate signals are harmless. */
    @JvmStatic
    @Synchronized
    fun terminal(context: Context, callId: String, nonce: String, generation: String, reason: String, winner: String = ""): Boolean =
        mutate(context, callId, nonce, generation) { r ->
            if (r.phase == PHASE_TERMINATED) null else {
                val outcome = when (reason.lowercase()) {
                    "server_accepted", "server_accept", "accepted_by_server" -> PHASE_ACCEPTED
                    "server_declined", "server_decline", "declined_by_server" -> PHASE_DECLINED
                    else -> PHASE_TERMINATED
                }
                // A local action is only intent. A server-labelled outcome is
                // the sole path that can finalize ACCEPTED/DECLINED.
                r.copy(
                    phase = outcome,
                    pendingAction = "",
                    terminalAtMs = System.currentTimeMillis(),
                    reason = reason.take(120),
                    winner = winner.take(120),
                )
            }
        }

    @JvmStatic
    @Synchronized
    fun action(context: Context, callId: String, nonce: String, generation: String, action: String, winner: String = ""): Boolean =
        mutate(context, callId, nonce, generation) { r ->
            if (r.phase != PHASE_RINGING || r.pendingAction.isNotEmpty()) null else when (action.lowercase()) {
                "accept", "accepted" -> r.copy(pendingAction = "accept", pendingAtMs = System.currentTimeMillis(), winner = winner.take(120))
                "decline", "declined", "reject", "rejected" -> r.copy(pendingAction = "decline", pendingAtMs = System.currentTimeMillis())
                else -> null
            }
        }

    @JvmStatic
    @Synchronized
    fun cancel(context: Context, callId: String, nonce: String? = null, generation: String? = null): Boolean {
        val r = read(context) ?: return false
        if (r.callId != callId || (nonce != null && nonce != r.nonce) || (generation != null && generation != r.generation)) return false
        if (r.phase == PHASE_ACCEPTED || r.phase == PHASE_DECLINED || r.phase == PHASE_TERMINATED || r.pendingAction.isNotEmpty()) return false
        prefs(context).edit().remove(STATE).commit()
        return true
    }

    @JvmStatic
    fun snapshot(context: Context): Map<String, Any?> {
        if (!isEnabled(context)) {
            prefs(context).edit().remove(STATE).apply()
            return mapOf("phase" to "IDLE")
        }
        val r = read(context) ?: return mapOf("phase" to "IDLE")
        if (expired(r, System.currentTimeMillis())) {
            prefs(context).edit().remove(STATE).apply()
            return mapOf("phase" to "IDLE", "expired" to true, "callId" to r.callId)
        }
        return r.toMap()
    }

    private fun mutate(context: Context, callId: String, nonce: String, generation: String, f: (Record) -> Record?): Boolean {
        if (!isEnabled(context)) return false
        val r = read(context) ?: return false
        if (expired(r, System.currentTimeMillis()) || r.callId != callId || r.nonce != nonce || r.generation != generation) return false
        val next = f(r) ?: return false
        write(context, next)
        return true
    }
    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun expired(r: Record, now: Long) = r.expiresAtMs > 0 && now >= r.expiresAtMs
    private fun read(context: Context): Record? = try { prefs(context).getString(STATE, null)?.let { Record.from(JSONObject(it)) } } catch (_: Throwable) { null }
    private fun write(context: Context, r: Record) { prefs(context).edit().putString(STATE, r.json().toString()).commit() }

    private data class Record(
        val callId: String, val nonce: String, val generation: String, val phase: String,
        val createdAtMs: Long, val expiresAtMs: Long, val readyAtMs: Long? = null,
        val ringAtMs: Long? = null, val terminalAtMs: Long? = null, val serverSequence: Long = 0,
        val fallback: Boolean = false, val reason: String = "", val winner: String = "",
        val pendingAction: String = "", val pendingAtMs: Long? = null,
    ) {
        fun json() = JSONObject().apply {
            put("callId", callId); put("nonce", nonce); put("generation", generation); put("phase", phase)
            put("createdAtMs", createdAtMs); put("expiresAtMs", expiresAtMs); put("readyAtMs", readyAtMs ?: JSONObject.NULL)
            put("ringAtMs", ringAtMs ?: JSONObject.NULL); put("terminalAtMs", terminalAtMs ?: JSONObject.NULL)
            put("serverSequence", serverSequence); put("fallback", fallback); put("reason", reason); put("winner", winner)
            put("pendingAction", pendingAction); put("pendingAtMs", pendingAtMs ?: JSONObject.NULL)
        }
        fun toMap() = mapOf<String, Any?>("callId" to callId, "nonce" to nonce, "generation" to generation, "phase" to phase,
            "createdAtMs" to createdAtMs, "expiresAtMs" to expiresAtMs, "readyAtMs" to readyAtMs, "ringAtMs" to ringAtMs,
            "terminalAtMs" to terminalAtMs, "serverSequence" to serverSequence, "fallback" to fallback, "reason" to reason, "winner" to winner,
            "pendingAction" to pendingAction, "pendingAtMs" to pendingAtMs)
        companion object {
            fun from(o: JSONObject) = Record(o.optString("callId"), o.optString("nonce"), o.optString("generation"), o.optString("phase"),
                o.optLong("createdAtMs"), o.optLong("expiresAtMs"), o.longOrNull("readyAtMs"), o.longOrNull("ringAtMs"), o.longOrNull("terminalAtMs"),
                o.optLong("serverSequence"), o.optBoolean("fallback"), o.optString("reason"), o.optString("winner"),
                o.optString("pendingAction"), o.longOrNull("pendingAtMs"))
            private fun JSONObject.longOrNull(k: String): Long? = if (isNull(k)) null else optLong(k).takeIf { it > 0 }
        }
    }
}

package ai.avatok.avadial

import android.content.Context
import android.os.Build
import android.telephony.TelephonyManager
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * [AVADIAL-CALL-INTEL-1] Everything we know about ONE call, accumulated natively
 * from ring to hangup, then flushed once at the end.
 *
 * WHY A UUID: the call id used everywhere else is
 * `System.identityHashCode(call).toString()` — a MEMORY ADDRESS hash. It is fine as
 * an in-process map key (which is all it was ever built for) but it can collide, it
 * is not stable across processes, and it is meaningless once the call is over. As
 * the primary key of a call-intelligence database it is unusable. Every record now
 * carries a real [uuid]; the identityHashCode id stays as the local map key so none
 * of the existing Telecom plumbing has to change.
 *
 * PRIVACY: this object holds the RAW E.164 number on purpose. It is written only to
 * app-private storage and uploaded only to the AvaTOK Worker over TLS, which HMACs
 * it before anything reaches PostHog. Raw numbers must NEVER be handed to
 * [AvaDialPlugin.track] — that queue goes straight to PostHog. See
 * CallTelemetryBuffer's header and Specs/PROPOSAL-NATIVE-INCALL-AND-CALL-INTELLIGENCE.md §5.
 */
internal class CallRecord(
    val uuid: String = UUID.randomUUID().toString(),
    val localId: String,
    val number: String?,
    val direction: String,
) {
    var contactName: String? = null
    var contactExists: Boolean = false
    var spamScore: Int? = null
    var spamBucket: String? = null

    // Telephony context, captured once at ring time.
    var simSlot: Int? = null
    var carrier: String? = null
    var countryCode: String? = null
    var networkType: String? = null

    // Timings (elapsed wall clock, ms).
    val startedAt: Long = System.currentTimeMillis()
    var answerTappedAt: Long? = null
    var activeAt: Long? = null
    var endedAt: Long? = null

    /** Terminal disposition: answered | missed | rejected | blocked | busy | failed. */
    var finalState: String? = null

    // [AVADIAL-INCALL-DIAG-1] FIX 6 — honest diagnostics. These replace the old
    // "start_activity: true" lie (that only proved an API was CALLED, not that a
    // screen ever rendered) with the outcome truth from the uiReady handshake
    // (Fix 4), keyed per phase since the ring screen and the in-call screen are
    // two separate, independently-failable launches. Null means "never resolved
    // either way" (e.g. the watchdog for that phase never armed); the watchdog
    // stamps an explicit `false` if it fires without an ack.
    var uiSurfacedRing: Boolean? = null
    var uiSurfacedIncall: Boolean? = null
    /** "notification_activity_pi" | "ring_screen" | "flutter" — first writer wins. */
    var answerSource: String? = null
    /** Did the service's ongoing CallStyle notification (Fix 2) actually post? */
    var ongoingNotifPosted: Boolean? = null

    /** User actions taken during this call, in order. */
    private val actions = ArrayList<Pair<String, Long>>()

    fun addAction(action: String) {
        synchronized(actions) { actions.add(action to System.currentTimeMillis()) }
    }

    /** Ring start → answered or ended. Null once we're past ringing with no answer time. */
    fun ringDurationMs(): Long? {
        val end = activeAt ?: endedAt ?: return null
        return (end - startedAt).coerceAtLeast(0L)
    }

    /** Active → ended. Null for a call that never connected. */
    fun talkDurationMs(): Long? {
        val a = activeAt ?: return null
        val e = endedAt ?: return null
        return (e - a).coerceAtLeast(0L)
    }

    fun totalDurationMs(): Long? = endedAt?.let { (it - startedAt).coerceAtLeast(0L) }

    /**
     * THE number this whole rearchitecture exists to measure: user taps Answer →
     * Telecom reports STATE_ACTIVE. Null when the call was never answered here (e.g.
     * answered from the notification or a bluetooth headset, where there is no tap).
     */
    fun answerDelayMs(): Long? {
        val t = answerTappedAt ?: return null
        val a = activeAt ?: return null
        return (a - t).coerceAtLeast(0L)
    }

    /** Capture SIM/carrier/network once. Best-effort — all of it is permission-gated. */
    fun captureTelephony(ctx: Context) {
        try {
            val tm = ctx.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager ?: return
            carrier = tm.networkOperatorName?.takeIf { it.isNotBlank() }
            countryCode = tm.networkCountryIso?.takeIf { it.isNotBlank() }?.uppercase()
            networkType = networkTypeName(tm)
            simSlot = simSlotOf(ctx)
        } catch (_: Throwable) { /* READ_PHONE_STATE not granted — best-effort */ }
    }

    @Suppress("MissingPermission")
    private fun networkTypeName(tm: TelephonyManager): String? = try {
        // dataNetworkType is API 24 and minSdk IS 24, so there is no older branch to
        // write — a VERSION check here would be dead code. It needs READ_PHONE_STATE;
        // the try/catch is the real guard (null is a perfectly good answer).
        val t = tm.dataNetworkType
        when (t) {
            TelephonyManager.NETWORK_TYPE_NR -> "5g"
            TelephonyManager.NETWORK_TYPE_LTE -> "4g"
            TelephonyManager.NETWORK_TYPE_HSPAP,
            TelephonyManager.NETWORK_TYPE_HSPA,
            TelephonyManager.NETWORK_TYPE_UMTS -> "3g"
            TelephonyManager.NETWORK_TYPE_EDGE,
            TelephonyManager.NETWORK_TYPE_GPRS -> "2g"
            TelephonyManager.NETWORK_TYPE_UNKNOWN -> null
            else -> "other"
        }
    } catch (_: Throwable) { null }

    /**
     * Best-effort SIM slot. Requires READ_PHONE_STATE; on single-SIM devices this is
     * always 0. Not worth a permission prompt on its own — null is fine.
     */
    @Suppress("MissingPermission")
    private fun simSlotOf(ctx: Context): Int? = try {
        val sm = ctx.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE)
            as? android.telephony.SubscriptionManager
        sm?.activeSubscriptionInfoList?.firstOrNull()?.simSlotIndex
    } catch (_: Throwable) { null }

    /** The device block — stamped on every event so PostHog AI can segment on it. */
    private fun deviceJson(ctx: Context): JSONObject = JSONObject().apply {
        put("device_model", "${Build.MANUFACTURER} ${Build.MODEL}")
        put("android_version", Build.VERSION.RELEASE)
        put("android_sdk", Build.VERSION.SDK_INT)
        put("app_version", appVersion(ctx))
        put("language", java.util.Locale.getDefault().language)
        put("country", java.util.Locale.getDefault().country)
        put("timezone", java.util.TimeZone.getDefault().id)
    }

    private fun appVersion(ctx: Context): String? = try {
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName
    } catch (_: Throwable) { null }

    /**
     * The summary row — the one the intelligence model actually eats. Emitted once,
     * at hangup, with the raw number for the Worker to HMAC.
     */
    fun toCompletedJson(ctx: Context): JSONObject = JSONObject().apply {
        put("event", "call_completed")
        put("call_uuid", uuid)
        put("number_e164", number)          // raw — Worker HMACs it, never reaches PostHog
        put("direction", direction)
        put("ts", startedAt)
        put("end_time", endedAt)
        put("final_state", finalState)

        put("ring_duration_ms", ringDurationMs())
        put("talk_duration_ms", talkDurationMs())
        put("total_duration_ms", totalDurationMs())
        put("answer_delay_ms", answerDelayMs())

        put("contact_exists", contactExists)
        // contact_name is DELIBERATELY omitted — see the proposal §5. It is a third
        // party's PII, collected from someone else's device, about a person who never
        // consented. Ship contact_exists; add the name only with a disclosure.
        put("spam_score", spamScore)
        put("spam_bucket", spamBucket)

        put("sim_slot", simSlot)
        put("carrier", carrier)
        put("country_code", countryCode)
        put("network_type", networkType)

        // [AVADIAL-INCALL-DIAG-1] FIX 6 — outcome truth, not intention. Every
        // call_completed row (identity-tagged by the caller in onCallRemoved)
        // now carries whether a screen actually surfaced, not just whether we
        // asked Android to show one.
        put("ui_surfaced_ring", uiSurfacedRing)
        put("ui_surfaced_incall", uiSurfacedIncall)
        put("answer_source", answerSource)
        put("ongoing_notif_posted", ongoingNotifPosted)

        put("actions", JSONArray().apply {
            synchronized(actions) {
                actions.forEach { (a, t) -> put(JSONObject().put("action", a).put("ts", t)) }
            }
        })
        put("device", deviceJson(ctx))
    }
}

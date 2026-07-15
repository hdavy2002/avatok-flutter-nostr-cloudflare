package ai.avatok.avadial

import android.Manifest
import android.app.PendingIntent
import android.app.role.RoleManager
import android.content.BroadcastReceiver
import android.content.ContentProviderOperation
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.BlockedNumberContract
import android.provider.CallLog
import android.provider.ContactsContract
import android.provider.Settings
import android.content.ContentValues
import android.provider.Telephony
import android.telecom.TelecomManager
import android.telephony.SmsManager
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicLong

/**
 * AvaDial native bridge (Specs/SPIKE-2026-07-12-avadial-telecom.md).
 *
 * Owns the single `avatok/avadial` MethodChannel used by the Flutter AvaDial
 * feature. Responsibilities:
 *   - request/inspect the ROLE_DIALER + ROLE_CALL_SCREENING roles (needs an
 *     Activity → this plugin is [ActivityAware] and forwards onActivityResult);
 *   - LIVE device reads: contacts + call log (no persistence here — the Dart side
 *     owns the device-data boundary, plan §4.7);
 *   - relay in-call actions to [AvaInCallService];
 *   - expose the screening-snapshot file path so Dart can write the local spam
 *     snapshot the [AvaCallScreeningService] reads (handshake in the spike §5).
 *
 * Everything ships DARK behind the Flutter `avaDialer` flag — none of these
 * methods are invoked until the flag is on.
 */
class AvaDialPlugin : FlutterPlugin, ActivityAware, MethodChannel.MethodCallHandler,
    PluginRegistry.ActivityResultListener {

    companion object {
        const val CHANNEL = "avatok/avadial"
        const val SNAPSHOT_DIR = "avadial"
        const val SNAPSHOT_FILE = "spam_snapshot.json"
        // Runtime CALL_PHONE request code for TelecomManager.placeCall.
        const val REQ_CALL_PHONE = 42120

        // [AVADIAL-NATIVE-INCALL-1] Who the signed-in user is, written by Dart and
        // read natively. Native has no Clerk and no IdentityStore, but every call
        // event must carry the user's email so telemetry is retrievable per-tester
        // later. Same on-disk handshake as spam_snapshot.json / avatok_directory.json
        // — the pattern AvaMissedCallOverlay already uses with no engine attached.
        const val IDENTITY_FILE = "identity.json"

        // [AVADIAL-NATIVE-INCALL-1] Native mirror of the `nativeInCallUi` kill switch.
        // The flag itself lives in the Worker's DEFAULTS/KV and is read by Dart's
        // RemoteConfig — but the native call screens run with NO engine, so they
        // cannot read RemoteConfig. Dart mirrors the resolved value to disk on every
        // config refresh; native reads this file. Absent/unreadable => OFF (the old
        // Flutter in-call path), which is the safe default.
        const val NATIVE_UI_FILE = "native_ui.json"

        // Single live instance so the InCallService / CallScreeningService can push
        // events up to Flutter when the engine is attached (best-effort).
        @Volatile
        private var instance: AvaDialPlugin? = null

        private val main = Handler(Looper.getMainLooper())

        // Cold-start / background incoming-call launch (route extra
        // "avadial/incoming"). Stored so Dart can DRAIN it on startup via
        // getPendingIncoming even when the launch beat the channel handler being
        // installed; also emitted for the warm/relaunch case.
        @Volatile
        private var pendingCallId: String? = null
        @Volatile
        private var pendingNumber: String? = null
        // [AVADIAL-HARDEN-2] Whether the pending incoming launch was already answered
        // (notification "answer" action fired before Flutter/MainActivity came up) —
        // drained/emitted alongside pendingCallId/pendingNumber so the shell opens
        // InCallScreen instead of the ringing PstnCallScreen for this launch.
        @Volatile
        private var pendingAnswered: Boolean = false
        // [AVADIAL-HARDEN-3] Screening verdict for the pending incoming launch (see
        // AvaCallScreeningService.stashVerdict / AvaInCallService.launchIncoming) —
        // carried through both the cold-start drain (getPendingIncoming) and the
        // already-running event (onLaunchIncoming) so PstnCallScreen can paint red.
        @Volatile
        private var pendingSpamScore: Int? = null
        @Volatile
        private var pendingSpamBucket: String? = null

        // Cold-start / background SMS-compose launch (ACTION_SENDTO on sms:/smsto:/
        // mms:/mmsto:, route extra "avadial/compose"). Stored so Dart can DRAIN it on
        // startup via getPendingCompose even when the launch beat the channel handler
        // being installed; also emitted for the already-running case.
        @Volatile
        private var pendingComposeNumber: String? = null

        // Sent/delivered PendingIntent actions (AVA-SMS). Suffixed with a per-send ref
        // so a dynamically-registered receiver can map the result back to the Dart
        // send request over the channel.
        const val ACTION_SMS_SENT = "ai.avatok.avadial.SMS_SENT"
        const val ACTION_SMS_DELIVERED = "ai.avatok.avadial.SMS_DELIVERED"

        /** Post an event to Dart on the main thread. No-op if the engine is gone. */
        fun emit(method: String, args: Map<String, Any?>) {
            val plugin = instance ?: return
            main.post { plugin.channel?.invokeMethod(method, args) }
        }

        /**
         * True when a Flutter engine is attached, i.e. [emit] will actually deliver.
         * Telemetry tags cold (engine-dead) events with this so we can tell a real
         * "no inbound SMS" from "the event was recorded but never drained".
         */
        fun engineAlive(): Boolean = instance?.channel != null

        // ── [AVADIAL-SMS-TELEMETRY-1] Native telemetry spine ─────────────────────
        // WHY THIS EXISTS: the SMS/OTP surfaces are the ONLY AvaDial paths that
        // routinely run with NO Flutter engine. SMS_DELIVER cold-starts the process
        // into a bare BroadcastReceiver; the OTP overlay and the "Copy code" action
        // both complete without ever opening the app. `emit()` silently drops on a
        // dead engine, so an Analytics.capture() reached only from Dart's _onNative
        // would systematically under-count exactly the background cases we most need
        // to see (an inbound text that never arrives is invisible by construction).
        //
        // So: native records into a bounded in-memory queue AND emits live. Dart
        // captures on the live `onTelemetry` event when it's up, and drains the queue
        // on wire-up for everything that happened while it was down. `seq` is a
        // process-monotonic id — Dart dedupes on it, because a live-emitted entry is
        // ALSO still sitting in the queue and would otherwise double-count.
        //
        // Bounded at TELEMETRY_CAP (oldest dropped): this is best-effort diagnostics,
        // never a durable log. The queue dies with the process — if the user never
        // opens the app, the entries are lost, and that is an accepted trade.
        //
        // PRIVACY (hard rule, matches the rest of avadial): NO raw phone number and
        // NO message body ever enters a props map. Numbers go through
        // [hashE164Native]; bodies and OTP codes contribute LENGTHS ONLY, never text.
        private const val TELEMETRY_CAP = 50
        private val telemetrySeq = AtomicLong(0)
        private val pendingTelemetry = ConcurrentLinkedQueue<Map<String, Any?>>()

        /**
         * Record one native telemetry event. Safe from any thread and from a receiver
         * with no engine attached. [event] is the PostHog event name (snake_case,
         * `avadial_`-prefixed); [props] must already be PII-free.
         */
        fun track(event: String, props: Map<String, Any?> = emptyMap()) {
            val entry = mapOf(
                "seq" to telemetrySeq.incrementAndGet(),
                "event" to event,
                "ts" to System.currentTimeMillis(),
                "props" to props,
            )
            pendingTelemetry.offer(entry)
            while (pendingTelemetry.size > TELEMETRY_CAP) pendingTelemetry.poll()
            emit("onTelemetry", entry)
        }

        /**
         * SHA-256 hex of [s] exactly as given — same ALGORITHM as Dart's
         * `AvaDialChannel.hashE164` (lowercase hex of UTF-8 bytes), so a number
         * identifies itself in PostHog without ever being sent.
         *
         * CAUTION — the algorithm matches but the INPUT does not, so these hashes do
         * NOT join with Dart's. Dart hashes a normalised E.164 string
         * (`+919876543210`); the SMS surfaces hash the raw provider/PDU address,
         * which is whatever the carrier sent — often national format (`9876543210`)
         * and sometimes not a number at all (alphanumeric sender IDs like
         * `VM-HDFCBK`). The same person therefore hashes differently here than in the
         * call-screening snapshot or the community spam pool. SMS-origin hashes join
         * with EACH OTHER (`sender_hash` ↔ `dest_hash` are both raw provider format),
         * which is all the SMS funnels need. Do not attempt a cross-surface join on
         * these without normalising to E.164 first.
         */
        fun hashE164Native(s: String?): String? {
            if (s.isNullOrEmpty()) return null
            return try {
                val md = MessageDigest.getInstance("SHA-256")
                md.digest(s.toByteArray(Charsets.UTF_8))
                    .joinToString("") { "%02x".format(it.toInt() and 0xff) }
            } catch (_: Throwable) {
                null
            }
        }

        /**
         * Called by MainActivity when it is (re)launched with the AvaDial incoming
         * route extra. Records the pending call for a cold-start drain AND emits
         * `onLaunchIncoming` for the already-running case.
         */
        fun notifyIncomingLaunch(
            callId: String?,
            number: String?,
            answered: Boolean = false,
            spamScore: Int? = null,
            spamBucket: String? = null,
        ) {
            if (callId.isNullOrEmpty()) return
            pendingCallId = callId
            pendingNumber = number
            pendingAnswered = answered
            pendingSpamScore = spamScore
            pendingSpamBucket = spamBucket
            emit(
                "onLaunchIncoming",
                mapOf(
                    "call_id" to callId, "number" to number, "answered" to answered,
                    "spam_score" to spamScore, "spam_bucket" to spamBucket,
                ),
            )
        }

        /**
         * [AVADIAL-STUCK-1] Clear a pending incoming launch when its call dies before
         * Dart drained it. Without this, a missed call left `pendingCallId` set forever:
         * the NEXT app open drained the stale launch and pushed a ghost ringing
         * PstnCallScreen for a call that ended minutes earlier (owner bug 2026-07-14 —
         * "the incoming screen was sitting inside AvaDial after the missed call").
         * Called from AvaInCallService.onCallRemoved.
         */
        fun clearPendingIncoming(callId: String) {
            if (pendingCallId != callId) return
            pendingCallId = null
            pendingNumber = null
            pendingAnswered = false
            pendingSpamScore = null
            pendingSpamBucket = null
        }

        /**
         * Called by MainActivity when it is (re)launched with the AvaDial SMS-compose
         * route extra (ACTION_SENDTO on an sms:/mms: URI). Records the pending compose
         * for a cold-start drain AND emits `onLaunchCompose` for the already-running
         * case. [number] is the recipient parsed from the sms:/smsto: URI (may be null
         * for a blank compose). All DARK behind the Flutter `avaSms` flag.
         */
        fun notifyComposeLaunch(number: String?) {
            pendingComposeNumber = number ?: ""
            emit("onLaunchCompose", mapOf("number" to number))
            // [AVADIAL-SMS-TELEMETRY-1] Proves the ACTION_SENDTO leg — component (4)
            // of the default-SMS gate — actually resolves to us on this device. If
            // this event never appears in the wild, the alias is not being routed and
            // the SMS role is silently unobtainable. `cold` = the launch beat Dart's
            // channel handler, so this compose will arrive via getPendingCompose
            // rather than the live event.
            track("avadial_sms_compose_launched", mapOf(
                "has_number" to !number.isNullOrEmpty(),
                "cold" to (instance == null),
            ))
        }

        /**
         * One-shot SMS send for the RESPOND_VIA_MESSAGE quick-reply flow
         * ([AvaSmsSendService]). Best-effort, no PendingIntent status reporting — the
         * platform's call UI owns the UX here, we just make sure the reply goes out and
         * is mirrored into the provider. Only meaningful while we hold ROLE_SMS.
         */
        fun sendQuickReply(context: Context, dest: String, text: String) {
            try {
                val sms = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    context.getSystemService(SmsManager::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    SmsManager.getDefault()
                }
                val parts = sms.divideMessage(text)
                if (parts.size == 1) {
                    sms.sendTextMessage(dest, null, text, null, null)
                } else {
                    sms.sendMultipartTextMessage(dest, null, parts, null, null)
                }
                val values = android.content.ContentValues().apply {
                    put(Telephony.Sms.ADDRESS, dest)
                    put(Telephony.Sms.BODY, text)
                    put(Telephony.Sms.DATE, System.currentTimeMillis())
                    put(Telephony.Sms.READ, 1)
                    put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_SENT)
                }
                context.contentResolver.insert(Telephony.Sms.Sent.CONTENT_URI, values)
            } catch (_: Throwable) { /* best-effort */ }
        }

        /** Absolute path of the screening snapshot file (spike §5). */
        fun snapshotFile(context: Context): File {
            val dir = File(context.filesDir, SNAPSHOT_DIR)
            if (!dir.exists()) dir.mkdirs()
            return File(dir, SNAPSHOT_FILE)
        }

        // ── [AVA-MISSEDCALL-1] Missed-call overlay snapshot + config ────────────────
        const val MISSEDCALL_CONFIG_FILE = "missedcall_config.json"
        const val AVATOK_DIR_FILE = "avatok_directory.json"

        /** `{enabled:bool}` gate the [AvaMissedCallReceiver] reads before firing. */
        fun missedCallConfigFile(context: Context): File {
            val dir = File(context.filesDir, SNAPSHOT_DIR)
            if (!dir.exists()) dir.mkdirs()
            return File(dir, MISSEDCALL_CONFIG_FILE)
        }

        /** On-device AvaTOK directory the overlay reads for caller name + AvaTOK status.
         *  Keyed by sha256(last-10-digits) → {name, ava, avatar_url, avatok_number}. */
        fun avatokDirFile(context: Context): File {
            val dir = File(context.filesDir, SNAPSHOT_DIR)
            if (!dir.exists()) dir.mkdirs()
            return File(dir, AVATOK_DIR_FILE)
        }

        // ── [AVADIAL-NATIVE-INCALL-1] Identity + native-UI gate ────────────────────

        /** `{distinct_id, email, phone_e164, name, account_id}` — written by Dart. */
        fun identityFile(context: Context): File {
            val dir = File(context.filesDir, SNAPSHOT_DIR)
            if (!dir.exists()) dir.mkdirs()
            return File(dir, IDENTITY_FILE)
        }

        /** `{native_in_call:bool}` — Dart's mirror of the RemoteConfig kill switch. */
        fun nativeUiFile(context: Context): File {
            val dir = File(context.filesDir, SNAPSHOT_DIR)
            if (!dir.exists()) dir.mkdirs()
            return File(dir, NATIVE_UI_FILE)
        }

        /**
         * Is the native in-call screen enabled? Read fresh from disk every time — this
         * is on the answer path and must reflect a config flip without a restart.
         *
         * Fail-CLOSED: any doubt (no file, corrupt JSON, IO error) returns false and we
         * keep the existing Flutter in-call path. The whole point of the flag is that
         * the new screen can be turned off instantly if it misbehaves in prod; a
         * missing file must never mean "on".
         */
        fun nativeInCallEnabled(context: Context): Boolean = try {
            val f = nativeUiFile(context)
            if (!f.exists() || f.length() == 0L) false
            else JSONObject(f.readText()).optBoolean("native_in_call", false)
        } catch (_: Throwable) {
            false
        }

        /**
         * The signed-in user, for stamping call-intelligence events natively. Empty map
         * when nobody is signed in or the snapshot has never been written.
         *
         * The email is what makes a future PostHog pull possible: with many testers on
         * many devices it is the ONLY way to tell whose phone a call problem is on.
         */
        fun identityOf(context: Context): Map<String, Any?> = try {
            val f = identityFile(context)
            if (!f.exists() || f.length() == 0L) emptyMap()
            else {
                val o = JSONObject(f.readText())
                mapOf(
                    "distinct_id" to o.optString("distinct_id").takeIf { it.isNotEmpty() },
                    "email" to o.optString("email").takeIf { it.isNotEmpty() },
                    "user_phone_e164" to o.optString("phone_e164").takeIf { it.isNotEmpty() },
                    "user_name" to o.optString("name").takeIf { it.isNotEmpty() },
                    "account_id" to o.optString("account_id").takeIf { it.isNotEmpty() },
                )
            }
        } catch (_: Throwable) {
            emptyMap()
        }

        // Cold-start / background "open this caller in AvaTOK" launch (overlay
        // View-profile / AvaTOK action). Stored so Dart can DRAIN it on startup via
        // getPendingOpenDial even when the launch beat the channel handler; also emitted
        // for the already-running case.
        @Volatile private var pendingOpenNumber: String? = null
        @Volatile private var pendingOpenAvatok: String? = null

        fun notifyOpenDial(number: String?, avatokNumber: String?) {
            pendingOpenNumber = number
            pendingOpenAvatok = avatokNumber
            emit("onLaunchOpenDial", mapOf("number" to number, "avatok_number" to avatokNumber))
        }
    }

    private var channel: MethodChannel? = null
    private var appContext: Context? = null
    private var activityBinding: ActivityPluginBinding? = null
    private var smsResultReceiver: BroadcastReceiver? = null

    /**
     * [AVADIAL-SMS-ROLE-1] Wall-clock at which the ROLE_SMS system prompt was
     * launched, or 0 when none is in flight. Read once in onActivityResult to derive
     * `elapsed_ms` — the instant-denial detector. Plain field, not @Volatile: both
     * the write (requestRole) and the read (onActivityResult) are main-thread only.
     */
    private var smsRoleRequestedAt: Long = 0L

    // ── FlutterPlugin ──────────────────────────────────────────────────────────
    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        appContext = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL).also {
            it.setMethodCallHandler(this)
        }
        instance = this
        registerSmsResultReceiver(binding.applicationContext)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
        smsResultReceiver?.let {
            try { binding.applicationContext.unregisterReceiver(it) } catch (_: Throwable) {}
        }
        smsResultReceiver = null
        if (instance === this) instance = null
    }

    /**
     * Register the dynamic receiver that catches the SMS sent/delivered PendingIntent
     * broadcasts fired by [smsSend] and forwards `onSmsSendStatus {ref, phase, ok}` to
     * Dart. The delivery-state chips in the composer read these events. Best-effort:
     * a send whose engine is dead simply never reports (the SMS still went out).
     */
    private fun registerSmsResultReceiver(ctx: Context) {
        if (smsResultReceiver != null) return
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, intent: Intent?) {
                val phase = when (intent?.action) {
                    ACTION_SMS_SENT -> "sent"
                    ACTION_SMS_DELIVERED -> "delivered"
                    else -> return
                }
                val ref = intent.getStringExtra("ref") ?: return
                // For "sent" the result code lives in getResultCode(); for "delivered"
                // a non-null resultCode is likewise success (Activity.RESULT_OK == -1).
                val ok = resultCode == android.app.Activity.RESULT_OK
                // [AVADIAL-HARDEN-3] The message was inserted as MESSAGE_TYPE_OUTBOX
                // (pending) by smsSend BEFORE dispatch — now that the radio has
                // actually replied, move that same row to SENT on success or FAILED on
                // failure so a failed send never permanently shows as "sent". Only the
                // "sent" phase (radio-dispatch result) resolves the row; "delivered" is
                // a carrier-level receipt for an already-sent message and doesn't
                // change the row's send/fail status.
                if (phase == "sent") {
                    val rowId = intent.getLongExtra("row_id", -1L)
                    if (rowId >= 0L) finalizeSmsRow(ctx, rowId, ok)
                }
                emit("onSmsSendStatus", mapOf("ref" to ref, "phase" to phase, "ok" to ok))
                // [AVADIAL-SMS-TELEMETRY-1] The carrier's verdict. This fires long
                // after the user left the composer (delivery receipts can land minutes
                // later, engine dead), which is precisely why it goes through track()
                // and not a Dart-side capture. `phase=sent` is the radio accepting the
                // message; `phase=delivered` is the handset receipt — a send can be
                // sent=true, delivered=false forever and that is a normal carrier
                // outcome, not a failure. `result_code` is the raw SmsManager RESULT_*
                // int on failure (1=GENERIC, 2=RADIO_OFF, 3=NULL_PDU, 4=NO_SERVICE),
                // which is the only thing that tells us WHY a send died.
                track("avadial_sms_send_status", mapOf(
                    "phase" to phase,
                    "ok" to ok,
                    "result_code" to resultCode,
                ))
            }
        }
        val filter = IntentFilter().apply {
            addAction(ACTION_SMS_SENT)
            addAction(ACTION_SMS_DELIVERED)
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ctx.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                ctx.registerReceiver(receiver, filter)
            }
            smsResultReceiver = receiver
        } catch (_: Throwable) { /* best-effort — send still works without status */ }
    }

    /** [AVADIAL-HARDEN-3] Move the OUTBOX row [rowId] (inserted by [smsSend] before
     *  dispatch) to SENT or FAILED once the radio actually replies. Best-effort: the
     *  provider write only succeeds while we hold ROLE_SMS (default SMS app). */
    private fun finalizeSmsRow(ctx: Context, rowId: Long, ok: Boolean) {
        try {
            val values = ContentValues().apply {
                put(
                    Telephony.Sms.TYPE,
                    if (ok) Telephony.Sms.MESSAGE_TYPE_SENT else Telephony.Sms.MESSAGE_TYPE_FAILED,
                )
            }
            ctx.contentResolver.update(
                Telephony.Sms.CONTENT_URI, values,
                "${Telephony.Sms._ID} = ?", arrayOf(rowId.toString()),
            )
        } catch (_: Throwable) { /* not default SMS app → provider write denied */ }
    }

    // ── ActivityAware (role requests need an Activity) ───────────────────────────
    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activityBinding = binding
        binding.addActivityResultListener(this)
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) =
        onAttachedToActivity(binding)

    override fun onDetachedFromActivityForConfigChanges() = onDetachedFromActivity()

    override fun onDetachedFromActivity() {
        activityBinding?.removeActivityResultListener(this)
        activityBinding = null
    }

    // ── Method dispatch ──────────────────────────────────────────────────────────
    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val ctx = appContext
        if (ctx == null) {
            result.error("no_context", "Plugin not attached", null); return
        }
        try {
            when (call.method) {
                // ---- roles ----
                "requestDialerRole" -> requestRole(RoleManager.ROLE_DIALER, result)
                "requestScreeningRole" -> requestRole(RoleManager.ROLE_CALL_SCREENING, result)
                "requestSmsRole" -> requestRole(RoleManager.ROLE_SMS, result)
                "isDialerRoleHeld" ->
                    result.success(AvaDialRoleHelper.isRoleHeld(ctx, RoleManager.ROLE_DIALER))
                "isScreeningRoleHeld" ->
                    result.success(AvaDialRoleHelper.isRoleHeld(ctx, RoleManager.ROLE_CALL_SCREENING))
                "isSmsRoleHeld" ->
                    result.success(AvaDialRoleHelper.isRoleHeld(ctx, RoleManager.ROLE_SMS))
                "canBlockNumbers" -> result.success(canBlockNumbers(ctx))
                "openDefaultAppsSettings" -> { openDefaultAppsSettings(ctx); result.success(null) }

                // ---- rival detection (setup sheet: name the current holders + deep-link) ----
                "defaultDialerLabel" -> result.success(defaultHandlerLabel(ctx, "dialer"))
                "defaultSmsLabel" -> result.success(defaultHandlerLabel(ctx, "sms"))
                "detectRivalCallerApps" -> result.success(detectRivalCallerApps(ctx))
                "openAppDetails" -> { openAppDetails(ctx, call.argument<String>("package")); result.success(null) }

                // ---- SMS (default-SMS-app layer, AVA-SMS) ----
                "smsSend" -> result.success(
                    smsSend(
                        ctx,
                        call.argument<String>("dest"),
                        call.argument<String>("body"),
                        call.argument<String>("ref"),
                    )
                )
                "smsQueryThreads" -> result.success(smsQueryThreads(ctx, call.argument<Int>("limit") ?: 200))
                "smsQueryMessages" -> result.success(
                    smsQueryMessages(ctx, call.argument<String>("address"), call.argument<Int>("limit") ?: 500)
                )
                // [AVA-SMS-BADGE-1] unread counters for the AvaDialer / Messages badges
                "smsUnreadCounts" -> result.success(smsUnreadCounts(ctx))
                "smsMarkRead" -> result.success(smsMarkRead(ctx, call.argument<String>("address")))
                "getPendingCompose" -> {
                    val out: Map<String, Any?>? = pendingComposeNumber?.let { mapOf("number" to it) }
                    pendingComposeNumber = null
                    result.success(out)
                }

                // ---- [AVADIAL-SMS-TELEMETRY-1] ----
                // Drain everything native recorded while Dart was down. Dart dedupes
                // on `seq`, so draining entries it already captured live is harmless.
                "drainTelemetry" -> {
                    // poll() in a loop, NOT copy-then-clear: a track() landing from a
                    // receiver thread between the copy and the clear would be wiped
                    // uncaptured. poll() is atomic per entry, so a concurrent offer
                    // either makes this drain or stays queued for the next one.
                    val out = ArrayList<Map<String, Any?>>()
                    while (true) out.add(pendingTelemetry.poll() ?: break)
                    result.success(out)
                }
                "smsRoleDiagnostics" -> result.success(smsRoleDiagnostics(ctx))

                // ---- live device reads (no persistence) ----
                "readContacts" -> result.success(readContacts(ctx))
                "readCallLog" -> result.success(readCallLog(ctx, (call.argument<Int>("limit")) ?: 500))

                // ---- device contact WRITES (WRITE_CONTACTS) ----
                "writeContact" -> result.success(writeContact(ctx, call))
                "writeContactsBatch" -> result.success(writeContactsBatch(ctx, call))
                "updateContact" -> result.success(updateContact(ctx, call))
                "deleteContact" -> result.success(deleteContact(ctx, call.argument<String>("id")))

                // ---- screening snapshot handshake ----
                "snapshotPath" -> result.success(snapshotFile(ctx).absolutePath)

                // ---- [AVADIAL-NATIVE-INCALL-1] identity + native-UI gate ----
                // Dart owns Clerk/IdentityStore; native owns the call. This is the
                // handshake between them, over disk, so the native screens work with
                // no engine attached.
                "writeIdentity" -> {
                    val obj = JSONObject()
                        .put("v", 1)
                        .put("updated", System.currentTimeMillis())
                    call.argument<String>("distinct_id")?.let { obj.put("distinct_id", it) }
                    call.argument<String>("email")?.let { obj.put("email", it) }
                    call.argument<String>("phone_e164")?.let { obj.put("phone_e164", it) }
                    call.argument<String>("name")?.let { obj.put("name", it) }
                    call.argument<String>("account_id")?.let { obj.put("account_id", it) }
                    writeFileAtomic(identityFile(ctx), obj.toString())
                    result.success(true)
                }
                "clearIdentity" -> {
                    try { identityFile(ctx).delete() } catch (_: Throwable) { }
                    result.success(true)
                }
                "setNativeInCallEnabled" -> {
                    val obj = JSONObject()
                        .put("native_in_call", call.argument<Boolean>("enabled") == true)
                        .put("updated", System.currentTimeMillis())
                    writeFileAtomic(nativeUiFile(ctx), obj.toString())
                    result.success(true)
                }
                "nativeInCallEnabled" -> result.success(nativeInCallEnabled(ctx))

                // ---- [AVADIAL-CALL-INTEL-1] durable call-intelligence buffer ----
                // Read and clear are SEPARATE on purpose: Dart uploads to the Worker
                // first and only clears on a 2xx, so a failed upload retries on the
                // next drain instead of binning the data. At-least-once — the Worker
                // dedupes on call_uuid.
                "readCallTelemetry" -> result.success(CallTelemetryBuffer.readAll(ctx))
                "clearCallTelemetry" -> { CallTelemetryBuffer.clear(ctx); result.success(true) }
                "callTelemetryPending" -> result.success(CallTelemetryBuffer.pendingCount(ctx))

                // ---- [AVA-MISSEDCALL-1] missed-call overlay ----
                "canDrawOverlay" -> result.success(AvaMissedCallOverlay.canDraw(ctx))
                "requestOverlayPermission" -> { requestOverlayPermission(ctx); result.success(null) }
                "setMissedCallEnabled" -> {
                    val obj = JSONObject().put("enabled", call.argument<Boolean>("enabled") == true)
                    // Device token + host for the receiver's cold-start membership lookup.
                    // Preserve any previously-stored token if Dart couldn't mint a fresh one.
                    val token = call.argument<String>("token")
                    val base = call.argument<String>("base")
                    val prev = try {
                        val f = missedCallConfigFile(ctx)
                        if (f.exists() && f.length() > 0L) JSONObject(f.readText()) else null
                    } catch (_: Throwable) { null }
                    (token ?: prev?.optString("token")?.takeIf { it.isNotEmpty() })
                        ?.let { obj.put("token", it) }
                    (base ?: prev?.optString("base")?.takeIf { it.isNotEmpty() })
                        ?.let { obj.put("base", it) }
                    writeFileAtomic(missedCallConfigFile(ctx), obj.toString())
                    result.success(true)
                }
                "writeAvatokDirectory" -> {
                    val jsonStr = call.argument<String>("json") ?: "{}"
                    writeFileAtomic(avatokDirFile(ctx), jsonStr)
                    result.success(true)
                }
                "missedCallResolved" -> {
                    AvaMissedCallOverlay.update(
                        call.argument<String>("number"),
                        call.argument<Boolean>("avatok") == true,
                        call.argument<String>("name"),
                    )
                    result.success(null)
                }
                "showMissedCallPreview" -> {
                    AvaMissedCallOverlay.show(
                        ctx,
                        AvaMissedCallOverlay.Info(
                            number = call.argument<String>("number"),
                            name = call.argument<String>("name"),
                            ringSecs = call.argument<Int>("ring_secs") ?: 0,
                            isAvatok = call.argument<Boolean>("is_avatok") == true,
                            avatokNumber = call.argument<String>("avatok_number"),
                        ),
                    )
                    result.success(null)
                }
                "getPendingOpenDial" -> {
                    val out: Map<String, Any?>? = pendingOpenNumber?.let {
                        mapOf("number" to it, "avatok_number" to pendingOpenAvatok)
                    }
                    pendingOpenNumber = null
                    pendingOpenAvatok = null
                    result.success(out)
                }

                // ---- cold-start incoming-call drain (route extra "avadial/incoming") ----
                "getPendingIncoming" -> {
                    // [AVADIAL-STUCK-1] Validate the pending call is still LIVE in the
                    // InCallService before handing it to Dart. A launch recorded while
                    // the app was backgrounded, whose call ended before Dart booted,
                    // must never open a ghost ringing screen.
                    val out: Map<String, Any?>? = pendingCallId
                        ?.takeIf { AvaInCallService.stateOf(it) != null }
                        ?.let {
                            mapOf(
                                "call_id" to it, "number" to pendingNumber, "answered" to pendingAnswered,
                                "spam_score" to pendingSpamScore, "spam_bucket" to pendingSpamBucket,
                            )
                        }
                    pendingCallId = null
                    pendingNumber = null
                    pendingAnswered = false
                    pendingSpamScore = null
                    pendingSpamBucket = null
                    result.success(out)
                }

                // ---- system block-list write-through (default dialer only) ----
                "systemBlock" -> result.success(systemBlock(ctx, call.argument<String>("number")))
                "systemUnblock" -> result.success(systemUnblock(ctx, call.argument<String>("number")))

                // ---- [AVADIAL-NATIVE-RING-1] drain Block/Report actions taken on the
                // native IncomingCallActivity while Dart was dead, so the in-app
                // BlockList stays in sync. Returns [{number, action, ts}] and clears.
                "drainPendingCallActions" -> {
                    val out = try {
                        val f = File(File(ctx.filesDir, "avadial"), "pending_call_actions.json")
                        if (f.exists() && f.length() > 0L) {
                            val arr = org.json.JSONArray(f.readText())
                            f.delete()
                            (0 until arr.length()).map { i ->
                                val o = arr.getJSONObject(i)
                                mapOf(
                                    "number" to o.optString("number"),
                                    "action" to o.optString("action"),
                                    "ts" to o.optLong("ts"),
                                )
                            }
                        } else emptyList()
                    } catch (_: Throwable) { emptyList() }
                    result.success(out)
                }

                // ---- [AVADIAL-STUCK-1] live call-state probe (PstnCallScreen guard) ----
                "callState" ->
                    result.success(call.argument<String>("id")?.let { AvaInCallService.stateOf(it) })

                // ---- [AVADIAL-POPUP-1] Android 14+ full-screen-intent grant ----
                "canUseFullScreenIntent" -> {
                    val ok = if (Build.VERSION.SDK_INT >= 34) {
                        try {
                            (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager)
                                .canUseFullScreenIntent()
                        } catch (_: Throwable) { true }
                    } else true
                    result.success(ok)
                }
                "requestFullScreenIntent" -> {
                    if (Build.VERSION.SDK_INT >= 34) {
                        try {
                            val intent = Intent(
                                Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                                Uri.parse("package:" + ctx.packageName),
                            )
                            val act = activityBinding?.activity
                            if (act != null) act.startActivity(intent)
                            else { intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); ctx.startActivity(intent) }
                        } catch (_: Throwable) { /* settings page unavailable — best-effort */ }
                    }
                    result.success(null)
                }

                // ---- in-call actions (delegate to InCallService) ----
                "answer", "reject", "disconnect" ->
                    result.success(AvaInCallService.action(call.argument<String>("id"), call.method, null))
                "setMuted" ->
                    result.success(AvaInCallService.action(null, "setMuted", call.argument<Boolean>("on")))
                "setSpeaker" ->
                    result.success(AvaInCallService.action(null, "setSpeaker", call.argument<Boolean>("on")))
                "dtmf" ->
                    result.success(AvaInCallService.action(call.argument<String>("id"), "dtmf", call.argument<String>("digit")))

                // ---- outgoing PSTN call (default dialer) ----
                "placeCall" -> result.success(placeCall(ctx, call.argument<String>("number")))

                else -> result.notImplemented()
            }
        } catch (e: Throwable) {
            result.error("avadial_error", e.message, null)
        }
    }

    private fun requestRole(roleName: String, result: MethodChannel.Result) {
        val activity = activityBinding?.activity
        if (activity == null) {
            result.error("no_activity", "Role request needs a foreground Activity", null); return
        }
        val ok = AvaDialRoleHelper.requestRole(activity, roleName)
        // [AVADIAL-SMS-ROLE-1] Stamp the request so onActivityResult can measure how
        // long the system role UI actually stayed up. A verdict that returns in
        // milliseconds was never shown to a human — see the instant-denial note there.
        if (roleName == RoleManager.ROLE_SMS) {
            smsRoleRequestedAt = if (ok) System.currentTimeMillis() else 0L
            // Snapshot qualification at request time, so a denial is attributable
            // immediately rather than needing a second round-trip to explain itself.
            if (ok) track("avadial_sms_role_requested", smsRoleDiagnostics(activity))
        }
        // `ok == false` means already-held or unavailable — resolve immediately;
        // otherwise the real verdict arrives via onActivityResult below.
        if (!ok) result.success(AvaDialRoleHelper.isRoleHeld(activity, roleName))
        else result.success(null) // pending — Dart awaits the onRoleResult event
    }

    // ── onActivityResult (role verdict) ──────────────────────────────────────────
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?): Boolean {
        val role = when (requestCode) {
            AvaDialRoleHelper.REQ_DIALER -> RoleManager.ROLE_DIALER
            AvaDialRoleHelper.REQ_SCREENING -> RoleManager.ROLE_CALL_SCREENING
            AvaDialRoleHelper.REQ_SMS -> RoleManager.ROLE_SMS
            else -> return false
        }
        val granted = resultCode == android.app.Activity.RESULT_OK
        emit("onRoleResult", mapOf("role" to role, "granted" to granted))
        if (role == RoleManager.ROLE_SMS) {
            // [AVADIAL-SMS-ROLE-1] THE event this whole investigation exists to
            // produce. On the broken build the verdict came back denied in a few ms
            // with no dialog ever drawn, because the role controller rejected us for
            // not qualifying. From the outside that is identical to a user tapping
            // "Don't allow" — which is why the app misread it as a permissions/
            // restricted-settings problem and shipped copy telling the owner to open
            // menus his device does not have.
            //
            // `elapsed_ms` + `qualified` together make the two cases separable for
            // good: qualified=false is ALWAYS our bug (no prompt can help), and a
            // sub-second elapsed_ms on a denial means no human was involved. Watch
            // `qualified=false` — it should be zero across the whole fleet, and any
            // non-zero rate is a shipped manifest regression.
            val startedAt = smsRoleRequestedAt
            smsRoleRequestedAt = 0L
            val elapsed = if (startedAt > 0L) System.currentTimeMillis() - startedAt else -1L
            val ctx = appContext
            val diag = if (ctx != null) smsRoleDiagnostics(ctx) else emptyMap()
            track("avadial_sms_role_result", diag + mapOf(
                "granted" to granted,
                "elapsed_ms" to elapsed,
                // Long vs Int range: compare explicitly rather than `in 0..1500`,
                // which would be an IntRange and not accept a Long.
                "instant_denial" to (!granted && elapsed >= 0L && elapsed <= 1500L),
            ))
        }
        return true
    }

    // ── Providers ────────────────────────────────────────────────────────────────
    private fun readContacts(ctx: Context): List<Map<String, Any?>> {
        val out = ArrayList<Map<String, Any?>>()
        val proj = arrayOf(
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME_PRIMARY,
            ContactsContract.CommonDataKinds.Phone.NUMBER,
            ContactsContract.CommonDataKinds.Phone.PHOTO_URI,
            ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
        )
        ctx.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI, proj, null, null,
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME_PRIMARY + " ASC"
        )?.use { c ->
            val iName = c.getColumnIndex(proj[0])
            val iNum = c.getColumnIndex(proj[1])
            val iPhoto = c.getColumnIndex(proj[2])
            val iId = c.getColumnIndex(proj[3])
            while (c.moveToNext()) {
                out.add(
                    mapOf(
                        "name" to (if (iName >= 0) c.getString(iName) else null),
                        "number" to (if (iNum >= 0) c.getString(iNum) else null),
                        "photo" to (if (iPhoto >= 0) c.getString(iPhoto) else null),
                        "id" to (if (iId >= 0) c.getString(iId) else null),
                    )
                )
            }
        }
        return out
    }

    // ── Device contact writes (WRITE_CONTACTS) ───────────────────────────────────
    // These write to the phone's REAL address book (owner request 2026-07-13:
    // contacts must be added/edited/deleted for real, not just inside AvaTOK). All
    // best-effort: on any provider failure we return null/false and Dart falls back
    // to the AVA-side override so the user never loses their edit.

    /** Insert a brand-new contact. Returns the aggregated CONTACT_ID as a string, or null. */
    private fun writeContact(ctx: Context, call: MethodCall): String? {
        val name = call.argument<String>("name")?.trim().orEmpty()
        val number = call.argument<String>("number")?.trim().orEmpty()
        val personalEmail = call.argument<String>("personalEmail")?.trim().orEmpty()
        val businessEmail = call.argument<String>("businessEmail")?.trim().orEmpty()
        val linkedin = call.argument<String>("linkedin")?.trim().orEmpty()
        val note = call.argument<String>("note")?.trim().orEmpty()
        // [AVADIAL-HARDEN-3] Single formatted postal address (StructuredPostal),
        // following exactly the note/linkedin single-value pattern.
        val address = call.argument<String>("address")?.trim().orEmpty()

        val ops = ArrayList<ContentProviderOperation>()
        // Raw contact under the local ("device") account — no Google sync account.
        ops.add(
            ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
                .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null)
                .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null)
                .build()
        )
        if (name.isNotEmpty()) {
            ops.add(dataInsert(0)
                .withValue(ContactsContract.Data.MIMETYPE,
                    ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
                .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, name)
                .build())
        }
        if (number.isNotEmpty()) {
            ops.add(dataInsert(0)
                .withValue(ContactsContract.Data.MIMETYPE,
                    ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
                .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, number)
                .withValue(ContactsContract.CommonDataKinds.Phone.TYPE,
                    ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE)
                .build())
        }
        if (personalEmail.isNotEmpty()) ops.add(emailOp(0, personalEmail,
            ContactsContract.CommonDataKinds.Email.TYPE_HOME))
        if (businessEmail.isNotEmpty()) ops.add(emailOp(0, businessEmail,
            ContactsContract.CommonDataKinds.Email.TYPE_WORK))
        if (linkedin.isNotEmpty()) ops.add(websiteOp(0, linkedin))
        if (note.isNotEmpty()) ops.add(noteOp(0, note))
        if (address.isNotEmpty()) ops.add(postalOp(0, address))

        val results = ctx.contentResolver.applyBatch(ContactsContract.AUTHORITY, ops)
        val rawUri = results.firstOrNull()?.uri ?: return null
        val rawContactId = ContentUris.parseId(rawUri)
        return contactIdForRaw(ctx, rawContactId)?.toString()
    }

    /**
     * BULK insert of many device contacts in as few provider transactions as
     * possible — the fast path for contact-book RESTORE (owner request 2026-07-14).
     *
     * Writing N contacts by calling [writeContact] N times means N platform-channel
     * round-trips AND N separate `applyBatch` transactions, which is what made a
     * 4.5k-contact restore hang. Here we pack many contacts into one
     * `ContentProviderOperation` list (each contact's data rows back-reference its
     * OWN RawContacts insert via the running op index) and flush in sub-batches that
     * stay well under the provider's ~500-op-per-apply ceiling. If a sub-batch
     * throws (one bad row can fail the whole transaction), we fall back to writing
     * that sub-batch one contact at a time so a single bad contact can't sink the
     * rest. Returns the number of contacts successfully written.
     */
    private fun writeContactsBatch(ctx: Context, call: MethodCall): Int {
        @Suppress("UNCHECKED_CAST")
        val rows = (call.argument<List<Any?>>("contacts") ?: return 0)
            .filterIsInstance<Map<String, Any?>>()
        if (rows.isEmpty()) return 0

        // Keep each transaction well under the ContentProvider batch ceiling (~500).
        // A contact is up to 6 ops (raw + name + phone + 2 emails + site + note),
        // so ~60 contacts ≈ 360 ops leaves comfortable headroom.
        val chunk = 60
        var written = 0
        var i = 0
        while (i < rows.size) {
            val slice = rows.subList(i, minOf(i + chunk, rows.size))
            written += applyContactsSlice(ctx, slice)
            i += chunk
        }
        return written
    }

    /** Build + apply one transaction for a slice of contacts; per-contact fallback on failure. */
    private fun applyContactsSlice(ctx: Context, slice: List<Map<String, Any?>>): Int {
        val ops = ArrayList<ContentProviderOperation>()
        for (c in slice) {
            val ref = ops.size // index of THIS contact's RawContacts insert
            ops.add(
                ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
                    .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null)
                    .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null)
                    .build()
            )
            appendContactDataOps(ops, ref, c)
        }
        return try {
            val results = ctx.contentResolver.applyBatch(ContactsContract.AUTHORITY, ops)
            // Count the RawContacts inserts that came back with a uri.
            results.count { it.uri != null }.coerceAtMost(slice.size)
        } catch (e: Exception) {
            // One malformed contact fails the whole transaction — retry per contact
            // so the rest still land.
            var ok = 0
            for (c in slice) {
                try {
                    val one = ArrayList<ContentProviderOperation>()
                    one.add(
                        ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
                            .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null)
                            .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null)
                            .build()
                    )
                    appendContactDataOps(one, 0, c)
                    val r = ctx.contentResolver.applyBatch(ContactsContract.AUTHORITY, one)
                    if (r.firstOrNull()?.uri != null) ok++
                } catch (_: Exception) { /* skip this contact, keep going */ }
            }
            ok
        }
    }

    /** Append the managed data rows for one contact, back-referencing raw op [ref]. */
    private fun appendContactDataOps(ops: ArrayList<ContentProviderOperation>, ref: Int, c: Map<String, Any?>) {
        val name = (c["name"] as? String)?.trim().orEmpty()
        val number = (c["number"] as? String)?.trim().orEmpty()
        val personalEmail = (c["personalEmail"] as? String)?.trim().orEmpty()
        val businessEmail = (c["businessEmail"] as? String)?.trim().orEmpty()
        val linkedin = (c["linkedin"] as? String)?.trim().orEmpty()
        val note = (c["note"] as? String)?.trim().orEmpty()
        val address = (c["address"] as? String)?.trim().orEmpty()
        if (name.isNotEmpty()) ops.add(dataInsert(ref)
            .withValue(ContactsContract.Data.MIMETYPE,
                ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
            .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, name)
            .build())
        if (number.isNotEmpty()) ops.add(dataInsert(ref)
            .withValue(ContactsContract.Data.MIMETYPE,
                ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
            .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, number)
            .withValue(ContactsContract.CommonDataKinds.Phone.TYPE,
                ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE)
            .build())
        if (personalEmail.isNotEmpty()) ops.add(emailOp(ref, personalEmail,
            ContactsContract.CommonDataKinds.Email.TYPE_HOME))
        if (businessEmail.isNotEmpty()) ops.add(emailOp(ref, businessEmail,
            ContactsContract.CommonDataKinds.Email.TYPE_WORK))
        if (linkedin.isNotEmpty()) ops.add(websiteOp(ref, linkedin))
        if (note.isNotEmpty()) ops.add(noteOp(ref, note))
        if (address.isNotEmpty()) ops.add(postalOp(ref, address))
    }

    /**
     * [AVADIAL-HARDEN-2] Find the FIRST Data row id for (rawId, mimetype[, extra
     * selection]), ordered by Data._ID ASC. Used by [updateContact] to update a
     * single existing row in place instead of bulk-deleting every row of that
     * mimetype (which used to wipe extra phone numbers/emails/websites/notes on
     * Google-synced contacts that have more rows than AvaTOK's edit screen knows
     * about).
     */
    private fun firstDataRowId(
        ctx: Context,
        rawId: Long,
        mimetype: String,
        extraSelection: String? = null,
        extraArgs: Array<String> = emptyArray(),
    ): Long? {
        var selection = "${ContactsContract.Data.RAW_CONTACT_ID}=? AND ${ContactsContract.Data.MIMETYPE}=?"
        val args = arrayOf(rawId.toString(), mimetype, *extraArgs)
        if (extraSelection != null) selection += " AND $extraSelection"
        ctx.contentResolver.query(
            ContactsContract.Data.CONTENT_URI,
            arrayOf(ContactsContract.Data._ID),
            selection, args,
            "${ContactsContract.Data._ID} ASC",
        )?.use { c -> if (c.moveToFirst()) return c.getLong(0) }
        return null
    }

    /** Update the managed fields of an existing contact (by aggregated CONTACT_ID).
     *
     * [AVADIAL-HARDEN-2] Rewritten to update-in-place instead of bulk-deleting all
     * Data rows of the 5 managed mimetypes and re-inserting single rows — that used
     * to silently wipe extra phone numbers/emails/websites/notes on Google-synced
     * contacts. Now, for each field: if a value is present we update the FIRST
     * matching row (or insert one if none exists) and leave every other row of that
     * mimetype untouched; if a value is empty we do NOTHING BY DEFAULT (clearing a
     * field via the edit screen used to be a no-op — we never know if a blank means
     * "clear this" or "the edit screen didn't load this field").
     *
     * [AVADIAL-HARDEN-3] [clearFields] makes clearing intentional: the Dart side now
     * tracks which managed fields had a non-empty INITIAL value and are blank at
     * save time, and sends just those keys. For a field named in [clearFields]
     * (name/number/personalEmail/businessEmail/linkedin/note/address) whose value is
     * empty, we delete ONLY the single first matching Data row — the exact same row
     * the update-in-place path above would have targeted (reusing [firstDataRowId],
     * including the Email TYPE selection) — never a bulk mimetype delete. A field
     * present in [clearFields] with a non-empty value is ignored; the value wins.
     */
    private fun updateContact(ctx: Context, call: MethodCall): Boolean {
        val id = call.argument<String>("id")?.toLongOrNull() ?: return false
        val rawId = rawContactIdForContact(ctx, id) ?: return false
        val name = call.argument<String>("name")?.trim().orEmpty()
        val number = call.argument<String>("number")?.trim().orEmpty()
        val personalEmail = call.argument<String>("personalEmail")?.trim().orEmpty()
        val businessEmail = call.argument<String>("businessEmail")?.trim().orEmpty()
        val linkedin = call.argument<String>("linkedin")?.trim().orEmpty()
        val note = call.argument<String>("note")?.trim().orEmpty()
        // [AVADIAL-HARDEN-3] Single formatted postal address (StructuredPostal).
        val address = call.argument<String>("address")?.trim().orEmpty()
        @Suppress("UNCHECKED_CAST")
        val clearFields = (call.argument<List<Any?>>("clearFields") ?: emptyList<Any?>())
            .filterIsInstance<String>()
            .toSet()

        val ops = ArrayList<ContentProviderOperation>()

        /** Delete the single first Data row for [mimetype] (+ optional TYPE
         *  selection), if one exists. Used for the [clearFields] path only — never
         *  a bulk mimetype delete. */
        fun deleteFirstRow(
            mimetype: String,
            extraSelection: String? = null,
            extraArgs: Array<String> = emptyArray(),
        ) {
            val rowId = firstDataRowId(ctx, rawId, mimetype, extraSelection, extraArgs) ?: return
            ops.add(
                ContentProviderOperation.newDelete(ContactsContract.Data.CONTENT_URI)
                    .withSelection("${ContactsContract.Data._ID}=?", arrayOf(rowId.toString()))
                    .build()
            )
        }

        if (name.isNotEmpty()) {
            val rowId = firstDataRowId(ctx, rawId,
                ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
            ops.add(
                if (rowId != null) {
                    ContentProviderOperation.newUpdate(ContactsContract.Data.CONTENT_URI)
                        .withSelection("${ContactsContract.Data._ID}=?", arrayOf(rowId.toString()))
                        .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, name)
                        .build()
                } else {
                    dataInsertRaw(rawId)
                        .withValue(ContactsContract.Data.MIMETYPE,
                            ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
                        .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, name)
                        .build()
                }
            )
        } else if ("name" in clearFields) {
            deleteFirstRow(ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
        }

        if (number.isNotEmpty()) {
            // First phone row only — never touch any other phone row, and never
            // change its TYPE on update (only set on insert of a brand-new row).
            val rowId = firstDataRowId(ctx, rawId,
                ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
            ops.add(
                if (rowId != null) {
                    ContentProviderOperation.newUpdate(ContactsContract.Data.CONTENT_URI)
                        .withSelection("${ContactsContract.Data._ID}=?", arrayOf(rowId.toString()))
                        .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, number)
                        .build()
                } else {
                    dataInsertRaw(rawId)
                        .withValue(ContactsContract.Data.MIMETYPE,
                            ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
                        .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, number)
                        .withValue(ContactsContract.CommonDataKinds.Phone.TYPE,
                            ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE)
                        .build()
                }
            )
        } else if ("number" in clearFields) {
            deleteFirstRow(ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
        }

        if (personalEmail.isNotEmpty()) {
            ops.add(updateOrInsertEmail(ctx, rawId, personalEmail,
                ContactsContract.CommonDataKinds.Email.TYPE_HOME))
        } else if ("personalEmail" in clearFields) {
            deleteFirstRow(
                ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE,
                extraSelection = "${ContactsContract.CommonDataKinds.Email.TYPE}=?",
                extraArgs = arrayOf(ContactsContract.CommonDataKinds.Email.TYPE_HOME.toString()),
            )
        }
        if (businessEmail.isNotEmpty()) {
            ops.add(updateOrInsertEmail(ctx, rawId, businessEmail,
                ContactsContract.CommonDataKinds.Email.TYPE_WORK))
        } else if ("businessEmail" in clearFields) {
            deleteFirstRow(
                ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE,
                extraSelection = "${ContactsContract.CommonDataKinds.Email.TYPE}=?",
                extraArgs = arrayOf(ContactsContract.CommonDataKinds.Email.TYPE_WORK.toString()),
            )
        }

        if (linkedin.isNotEmpty()) {
            val rowId = firstDataRowId(ctx, rawId,
                ContactsContract.CommonDataKinds.Website.CONTENT_ITEM_TYPE)
            ops.add(
                if (rowId != null) {
                    ContentProviderOperation.newUpdate(ContactsContract.Data.CONTENT_URI)
                        .withSelection("${ContactsContract.Data._ID}=?", arrayOf(rowId.toString()))
                        .withValue(ContactsContract.CommonDataKinds.Website.URL, linkedin)
                        .build()
                } else {
                    websiteOpRaw(rawId, linkedin)
                }
            )
        } else if ("linkedin" in clearFields) {
            deleteFirstRow(ContactsContract.CommonDataKinds.Website.CONTENT_ITEM_TYPE)
        }

        if (note.isNotEmpty()) {
            val rowId = firstDataRowId(ctx, rawId,
                ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE)
            ops.add(
                if (rowId != null) {
                    ContentProviderOperation.newUpdate(ContactsContract.Data.CONTENT_URI)
                        .withSelection("${ContactsContract.Data._ID}=?", arrayOf(rowId.toString()))
                        .withValue(ContactsContract.CommonDataKinds.Note.NOTE, note)
                        .build()
                } else {
                    noteOpRaw(rawId, note)
                }
            )
        } else if ("note" in clearFields) {
            deleteFirstRow(ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE)
        }

        if (address.isNotEmpty()) {
            val rowId = firstDataRowId(ctx, rawId,
                ContactsContract.CommonDataKinds.StructuredPostal.CONTENT_ITEM_TYPE)
            ops.add(
                if (rowId != null) {
                    ContentProviderOperation.newUpdate(ContactsContract.Data.CONTENT_URI)
                        .withSelection("${ContactsContract.Data._ID}=?", arrayOf(rowId.toString()))
                        .withValue(ContactsContract.CommonDataKinds.StructuredPostal.FORMATTED_ADDRESS, address)
                        .build()
                } else {
                    postalOpRaw(rawId, address)
                }
            )
        } else if ("address" in clearFields) {
            deleteFirstRow(ContactsContract.CommonDataKinds.StructuredPostal.CONTENT_ITEM_TYPE)
        }

        if (ops.isEmpty()) return true // nothing to change — not a failure
        val results = ctx.contentResolver.applyBatch(ContactsContract.AUTHORITY, ops)
        return results.isNotEmpty()
    }

    /** Update the FIRST Data row for [type] (Email.TYPE=HOME/WORK) if one exists,
     *  else insert a new one. Only touches the row matching this specific TYPE, so
     *  the personal-email update never clobbers the business-email row (and vice
     *  versa) or any other email rows the contact might have. */
    private fun updateOrInsertEmail(ctx: Context, rawId: Long, address: String, type: Int): ContentProviderOperation {
        val rowId = firstDataRowId(
            ctx, rawId,
            ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE,
            extraSelection = "${ContactsContract.CommonDataKinds.Email.TYPE}=?",
            extraArgs = arrayOf(type.toString()),
        )
        return if (rowId != null) {
            ContentProviderOperation.newUpdate(ContactsContract.Data.CONTENT_URI)
                .withSelection("${ContactsContract.Data._ID}=?", arrayOf(rowId.toString()))
                .withValue(ContactsContract.CommonDataKinds.Email.ADDRESS, address)
                .build()
        } else {
            emailOpRaw(rawId, address, type)
        }
    }

    /** Delete a contact (and its raw rows) by aggregated CONTACT_ID. */
    private fun deleteContact(ctx: Context, id: String?): Boolean {
        val cid = id?.toLongOrNull() ?: return false
        val uri = ContentUris.withAppendedId(ContactsContract.Contacts.CONTENT_URI, cid)
        return ctx.contentResolver.delete(uri, null, null) > 0
    }

    // Back-reference insert (row 0 of the batch is the new RawContacts insert).
    private fun dataInsert(rawContactRef: Int) =
        ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
            .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, rawContactRef)

    private fun dataInsertRaw(rawId: Long) =
        ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
            .withValue(ContactsContract.Data.RAW_CONTACT_ID, rawId)

    private fun emailOp(ref: Int, address: String, type: Int) = dataInsert(ref)
        .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE)
        .withValue(ContactsContract.CommonDataKinds.Email.ADDRESS, address)
        .withValue(ContactsContract.CommonDataKinds.Email.TYPE, type)
        .build()

    private fun emailOpRaw(rawId: Long, address: String, type: Int) = dataInsertRaw(rawId)
        .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE)
        .withValue(ContactsContract.CommonDataKinds.Email.ADDRESS, address)
        .withValue(ContactsContract.CommonDataKinds.Email.TYPE, type)
        .build()

    private fun websiteOp(ref: Int, url: String) = dataInsert(ref)
        .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Website.CONTENT_ITEM_TYPE)
        .withValue(ContactsContract.CommonDataKinds.Website.URL, url)
        .build()

    private fun websiteOpRaw(rawId: Long, url: String) = dataInsertRaw(rawId)
        .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Website.CONTENT_ITEM_TYPE)
        .withValue(ContactsContract.CommonDataKinds.Website.URL, url)
        .build()

    private fun noteOp(ref: Int, text: String) = dataInsert(ref)
        .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE)
        .withValue(ContactsContract.CommonDataKinds.Note.NOTE, text)
        .build()

    private fun noteOpRaw(rawId: Long, text: String) = dataInsertRaw(rawId)
        .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE)
        .withValue(ContactsContract.CommonDataKinds.Note.NOTE, text)
        .build()

    // [AVADIAL-HARDEN-3] Single formatted postal address (StructuredPostal),
    // mirroring the note/linkedin single-value field pattern above.
    private fun postalOp(ref: Int, address: String) = dataInsert(ref)
        .withValue(ContactsContract.Data.MIMETYPE,
            ContactsContract.CommonDataKinds.StructuredPostal.CONTENT_ITEM_TYPE)
        .withValue(ContactsContract.CommonDataKinds.StructuredPostal.FORMATTED_ADDRESS, address)
        .build()

    private fun postalOpRaw(rawId: Long, address: String) = dataInsertRaw(rawId)
        .withValue(ContactsContract.Data.MIMETYPE,
            ContactsContract.CommonDataKinds.StructuredPostal.CONTENT_ITEM_TYPE)
        .withValue(ContactsContract.CommonDataKinds.StructuredPostal.FORMATTED_ADDRESS, address)
        .build()

    private fun contactIdForRaw(ctx: Context, rawId: Long): Long? {
        ctx.contentResolver.query(
            ContentUris.withAppendedId(ContactsContract.RawContacts.CONTENT_URI, rawId),
            arrayOf(ContactsContract.RawContacts.CONTACT_ID), null, null, null
        )?.use { c -> if (c.moveToFirst()) return c.getLong(0) }
        return null
    }

    private fun rawContactIdForContact(ctx: Context, contactId: Long): Long? {
        ctx.contentResolver.query(
            ContactsContract.RawContacts.CONTENT_URI,
            arrayOf(ContactsContract.RawContacts._ID),
            "${ContactsContract.RawContacts.CONTACT_ID}=?",
            arrayOf(contactId.toString()), null
        )?.use { c -> if (c.moveToFirst()) return c.getLong(0) }
        return null
    }

    private fun readCallLog(ctx: Context, limit: Int): List<Map<String, Any?>> {
        val out = ArrayList<Map<String, Any?>>()
        val proj = arrayOf(
            CallLog.Calls.NUMBER,
            CallLog.Calls.TYPE,
            CallLog.Calls.DATE,
            CallLog.Calls.DURATION,
            CallLog.Calls.CACHED_NAME,
        )
        ctx.contentResolver.query(
            CallLog.Calls.CONTENT_URI, proj, null, null,
            CallLog.Calls.DATE + " DESC"
        )?.use { c ->
            val iNum = c.getColumnIndex(proj[0])
            val iType = c.getColumnIndex(proj[1])
            val iDate = c.getColumnIndex(proj[2])
            val iDur = c.getColumnIndex(proj[3])
            val iName = c.getColumnIndex(proj[4])
            var n = 0
            while (c.moveToNext() && n < limit) {
                out.add(
                    mapOf(
                        "number" to (if (iNum >= 0) c.getString(iNum) else null),
                        "type" to (if (iType >= 0) c.getInt(iType) else 0),
                        "date" to (if (iDate >= 0) c.getLong(iDate) else 0L),
                        "duration" to (if (iDur >= 0) c.getLong(iDur) else 0L),
                        "name" to (if (iName >= 0) c.getString(iName) else null),
                    )
                )
                n++
            }
        }
        return out
    }

    /**
     * Deep-link to the OS "Default apps" screen (Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)
     * so the user can pick AvaTOK — or hand a role back to another app (Truecaller / stock)
     * — at the OS level. We can only LAUNCH this screen; we can never force or release a role
     * programmatically. Prefers the foreground Activity; falls back to a NEW_TASK launch from
     * the app context, and finally to this app's details page if the default-apps screen is
     * unavailable on the device.
     */
    private fun openDefaultAppsSettings(ctx: Context) {
        val activity = activityBinding?.activity
        val primary = Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)
        try {
            if (activity != null) {
                activity.startActivity(primary)
            } else {
                primary.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ctx.startActivity(primary)
            }
        } catch (_: Throwable) {
            // Fallback: this app's details page (still lets the user reach "Set as default").
            try {
                val fallback = Intent(
                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.fromParts("package", ctx.packageName, null),
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ctx.startActivity(fallback)
            } catch (_: Throwable) { /* nothing else we can do */ }
        }
    }

    private fun canBlockNumbers(ctx: Context): Boolean = try {
        BlockedNumberContract.canCurrentUserBlockNumbers(ctx)
    } catch (_: Throwable) {
        false
    }

    // ── Rival detection (setup sheet) ─────────────────────────────────────────
    // Android forbids one app from disabling / blocking / silencing another, so
    // "take over" means: (1) CLAIM the dialer/SMS/caller-ID roles (the OS evicts
    // the previous holder for us), and (2) for a rival's overlay we can't suppress,
    // NAME it and deep-link STRAIGHT to its settings. These helpers power that.

    /** Known third-party caller-ID / dialer apps that draw their OWN incoming-call
     *  or after-call overlay via SYSTEM_ALERT_WINDOW — which Android does NOT let us
     *  suppress. Declared in <queries> so they stay visible on Android 11+. */
    private val knownRivalPackages = listOf(
        "com.truecaller",          // Truecaller
        "mobi.drupe.app",          // Drupe
        "com.callapp.contacts",    // CallApp
        "com.eyecon.global",       // Eyecon
        "com.hiya.star",           // Hiya
        "gogolook.callgogolook2",  // Whoscall
    )

    /** Human-readable label of the app currently holding the default dialer / SMS
     *  slot, or null when it is US (or none / unresolvable). Lets the setup sheet
     *  say "Currently: Truecaller" instead of a generic line. */
    private fun defaultHandlerLabel(ctx: Context, which: String): String? = try {
        val pkg = when (which) {
            "dialer" -> (ctx.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager)?.defaultDialerPackage
            "sms" -> Telephony.Sms.getDefaultSmsPackage(ctx)
            else -> null
        }
        when {
            pkg.isNullOrEmpty() -> null
            pkg == ctx.packageName -> null // already us
            else -> labelFor(ctx, pkg) ?: pkg
        }
    } catch (_: Throwable) {
        null
    }

    /** Installed rival caller-ID/dialer apps → [{package,label}] so the sheet can
     *  name them and deep-link to each one's settings. */
    private fun detectRivalCallerApps(ctx: Context): List<Map<String, String>> {
        val out = ArrayList<Map<String, String>>()
        val self = ctx.packageName
        for (pkg in knownRivalPackages) {
            if (pkg == self) continue
            try {
                ctx.packageManager.getApplicationInfo(pkg, 0) // throws if not installed / not visible
                out.add(mapOf("package" to pkg, "label" to (labelFor(ctx, pkg) ?: pkg)))
            } catch (_: Throwable) { /* not installed */ }
        }
        return out
    }

    private fun labelFor(ctx: Context, pkg: String): String? = try {
        val pm = ctx.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (_: Throwable) {
        null
    }

    /** Deep-link to a SPECIFIC app's system "App info" page, where the user can
     *  revoke its "appear on top" permission or disable it. We can only OPEN this
     *  screen — Android never lets one app disable/revoke another. */
    private fun openAppDetails(ctx: Context, pkg: String?) {
        // [AVA-SMS-FIX-1] null/empty → OUR OWN App info page (the screen with
        // ⋮ → "Allow restricted settings", needed to unlock ROLE_SMS on
        // Android 15+ sideloaded installs). Using ctx.packageName keeps this
        // correct across the prod / ".staging" applicationId suffixes.
        val target = if (pkg.isNullOrEmpty()) ctx.packageName else pkg
        try {
            val intent = Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", target, null),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            (activityBinding?.activity ?: ctx).startActivity(intent)
        } catch (_: Throwable) { /* best-effort */ }
    }

    /**
     * Place an outgoing PSTN call via [TelecomManager.placeCall] (never a fabricated
     * connection — the platform's emergency routing stays in force, spike §1). Returns
     * true when the call was dispatched. When CALL_PHONE is not yet granted we kick off
     * the runtime request (needs the Activity) and return false so the Dart side can
     * fall back to an ACTION_DIAL intent for this attempt; the next tap (post-grant)
     * places the call directly.
     */
    // ── [AVA-MISSEDCALL-1] helpers ──────────────────────────────────────────────
    /** Open the system "Display over other apps" settings page for AvaTOK. */
    private fun requestOverlayPermission(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        try {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + ctx.packageName),
            )
            val act = activityBinding?.activity
            if (act != null) {
                act.startActivity(intent)
            } else {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ctx.startActivity(intent)
            }
        } catch (_: Throwable) { /* settings page unavailable — best-effort */ }
    }

    /** Write [content] to [file] atomically (temp + rename), mirroring how Dart writes
     *  the screening snapshot — a half-written directory must never be read. */
    private fun writeFileAtomic(file: File, content: String) {
        try {
            val tmp = File(file.parentFile, file.name + ".tmp")
            tmp.writeText(content, Charsets.UTF_8)
            if (!tmp.renameTo(file)) {
                file.writeText(content, Charsets.UTF_8)
                tmp.delete()
            }
        } catch (_: Throwable) { /* best-effort */ }
    }

    private fun placeCall(ctx: Context, number: String?): Boolean {
        if (number.isNullOrEmpty()) return false
        val granted = ctx.checkSelfPermission(Manifest.permission.CALL_PHONE) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) {
            activityBinding?.activity?.requestPermissions(arrayOf(Manifest.permission.CALL_PHONE), REQ_CALL_PHONE)
            return false
        }
        return try {
            val tm = ctx.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager ?: return false
            val uri = Uri.fromParts("tel", number, null)
            tm.placeCall(uri, Bundle())
            true
        } catch (_: SecurityException) {
            false
        } catch (_: Throwable) {
            false
        }
    }

    private fun systemBlock(ctx: Context, number: String?): Boolean {
        if (number.isNullOrEmpty() || !canBlockNumbers(ctx)) return false
        return try {
            val values = android.content.ContentValues()
            values.put(BlockedNumberContract.BlockedNumbers.COLUMN_ORIGINAL_NUMBER, number)
            ctx.contentResolver.insert(BlockedNumberContract.BlockedNumbers.CONTENT_URI, values) != null
        } catch (_: Throwable) {
            false
        }
    }

    private fun systemUnblock(ctx: Context, number: String?): Boolean {
        if (number.isNullOrEmpty() || !canBlockNumbers(ctx)) return false
        return try {
            val where = BlockedNumberContract.BlockedNumbers.COLUMN_ORIGINAL_NUMBER + " = ?"
            ctx.contentResolver.delete(
                BlockedNumberContract.BlockedNumbers.CONTENT_URI, where, arrayOf(number)
            ) > 0
        } catch (_: Throwable) {
            false
        }
    }

    // ── SMS (default-SMS-app layer, AVA-SMS) ─────────────────────────────────────
    /**
     * Send an SMS via [SmsManager], splitting long bodies into multipart. Registers a
     * sent + delivered PendingIntent per part keyed by [ref]; the dynamic receiver
     * forwards status to Dart as `onSmsSendStatus {ref, phase, ok}`. Returns true
     * when the send was dispatched (NOT when delivered — that arrives on the channel).
     *
     * [AVADIAL-HARDEN-3] The provider write used to insert straight into
     * Telephony.Sms.Sent right after handing the message to the radio — BEFORE the
     * sent-result PendingIntent fired — so a message that the radio later reported
     * as failed still permanently showed as "sent" in the thread. Now we insert the
     * row as MESSAGE_TYPE_OUTBOX (pending) first, hand its row id to the sent
     * PendingIntent via a "row_id" extra, and [finalizeSmsRow] (called from the
     * registered receiver once the radio actually replies) moves that same row to
     * SENT on success or FAILED on failure. A multipart message is still ONE row —
     * every part's sent-intent carries the same row id, so whichever part's result
     * lands first settles it (a genuine partial failure is rare enough that we
     * don't special-case per-part status here).
     *
     * Device-data boundary: message bodies live ONLY in the OS SMS provider; our
     * scoped store keeps spam labels/metadata, never the text.
     */
    /**
     * [AVADIAL-SMS-ROLE-1] Default-SMS-app QUALIFICATION probe — the regression guard
     * for the bug that shipped on 2026-07-12 and was found on 2026-07-14.
     *
     * THE BUG THIS EXISTS TO CATCH: the manifest declared AvaSmsSendService with
     * `SEND_RESPOND_VIA_MESSAGE_SERVICE`. No such permission exists (the real one is
     * `SEND_RESPOND_VIA_MESSAGE`). AOSP `SmsApplication.getApplicationCollectionInternal()`
     * skips any RESPOND_VIA_MESSAGE service whose `serviceInfo.permission` is not that
     * EXACT string, which drops the whole package from the default-SMS candidate set:
     * AvaTOK vanished from Settings → Default apps → SMS app and every ROLE_SMS request
     * returned RESULT_CANCELED with no prompt at all. An invented permission name is
     * not a build error, trips no lint, and logs nothing — so it was invisible from the
     * inside. The user-visible symptom was indistinguishable from a permission problem,
     * and the app's own error copy blamed restricted settings, sending the owner to
     * menus that did not exist on his device.
     *
     * WHAT THIS DOES: re-runs the SAME four resolution queries AOSP runs, against our
     * own package, and reports each leg independently. Any `false` here means the role
     * is unobtainable NO MATTER what the user taps — the app does not qualify, so there
     * is nothing to grant. `qualified` is the AND of all four: it is the single boolean
     * that separates "we are not eligible" (our bug) from "the user declined" (their
     * choice) — the exact distinction we could not make on 2026-07-14.
     *
     * Cheap (four PackageManager queries, no I/O), non-throwing, and PII-free.
     */
    private fun smsRoleDiagnostics(ctx: Context): Map<String, Any?> {
        val pm = ctx.packageManager
        val pkg = ctx.packageName

        // These are STRING LITERALS on purpose, not Manifest.permission.* constants:
        // BROADCAST_SMS and BROADCAST_WAP_PUSH are signature-level and @hide, so they
        // are not exposed on the public android.Manifest.permission class and would
        // not compile. The literals below must stay byte-identical to the
        // `android:permission` values in AndroidManifest.xml — that string equality
        // IS the check (AOSP compares the same way).
        val permBroadcastSms = "android.permission.BROADCAST_SMS"
        val permBroadcastWapPush = "android.permission.BROADCAST_WAP_PUSH"
        val permRespondViaMessage = "android.permission.SEND_RESPOND_VIA_MESSAGE"
        val actionRespondViaMessage = "android.intent.action.RESPOND_VIA_MESSAGE"

        // (1) SMS_DELIVER receiver guarded by BROADCAST_SMS.
        val smsDeliverOk = try {
            pm.queryBroadcastReceivers(Intent(Telephony.Sms.Intents.SMS_DELIVER_ACTION), 0)
                .any {
                    it.activityInfo?.packageName == pkg &&
                        it.activityInfo?.permission == permBroadcastSms
                }
        } catch (_: Throwable) { false }

        // (2) WAP_PUSH_DELIVER receiver for the MMS mime type, guarded by
        //     BROADCAST_WAP_PUSH. setDataAndType(null, …) mirrors AOSP's own query.
        val wapPushOk = try {
            val i = Intent(Telephony.Sms.Intents.WAP_PUSH_DELIVER_ACTION)
                .setDataAndType(null, "application/vnd.wap.mms-message")
            pm.queryBroadcastReceivers(i, 0).any {
                it.activityInfo?.packageName == pkg &&
                    it.activityInfo?.permission == permBroadcastWapPush
            }
        } catch (_: Throwable) { false }

        // (3) RESPOND_VIA_MESSAGE service guarded by SEND_RESPOND_VIA_MESSAGE.
        //     THIS is the leg that was false on the broken build.
        val respondViaOk = try {
            val i = Intent(actionRespondViaMessage, Uri.fromParts("smsto", "", null))
            pm.queryIntentServices(i, 0).any {
                it.serviceInfo?.packageName == pkg &&
                    it.serviceInfo?.permission == permRespondViaMessage
            }
        } catch (_: Throwable) { false }

        // (4) ACTION_SENDTO activity on smsto:.
        val sendToOk = try {
            pm.queryIntentActivities(
                Intent(Intent.ACTION_SENDTO, Uri.fromParts("smsto", "", null)), 0
            ).any { it.activityInfo?.packageName == pkg }
        } catch (_: Throwable) { false }

        val defaultPkg = try { Telephony.Sms.getDefaultSmsPackage(ctx) } catch (_: Throwable) { null }
        val roleHeld = AvaDialRoleHelper.isRoleHeld(ctx, RoleManager.ROLE_SMS)

        return mapOf(
            "sms_deliver_ok" to smsDeliverOk,
            "wap_push_ok" to wapPushOk,
            "respond_via_ok" to respondViaOk,
            "sendto_ok" to sendToOk,
            "qualified" to (smsDeliverOk && wapPushOk && respondViaOk && sendToOk),
            "role_held" to roleHeld,
            "is_default_sms" to (defaultPkg == pkg),
            // Whether ANOTHER app holds the slot — distinguishes "nobody is default"
            // from "Messages/Truecaller has it". Never the rival's package name here;
            // defaultSmsLabel() already covers the user-facing case.
            "has_other_default" to (defaultPkg != null && defaultPkg != pkg),
            "sdk" to Build.VERSION.SDK_INT,
        )
    }

    private fun smsSend(ctx: Context, dest: String?, body: String?, ref: String?): Boolean {
        if (dest.isNullOrEmpty() || body == null) return false
        val r = ref ?: System.currentTimeMillis().toString()
        return try {
            // Insert the OUTBOX/pending row BEFORE dispatch (only meaningful while we
            // hold ROLE_SMS — provider write is a no-op/denied otherwise, matching the
            // previous best-effort behaviour).
            var rowId = -1L
            try {
                val values = ContentValues().apply {
                    put(Telephony.Sms.ADDRESS, dest)
                    put(Telephony.Sms.BODY, body)
                    put(Telephony.Sms.DATE, System.currentTimeMillis())
                    put(Telephony.Sms.READ, 1)
                    put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_OUTBOX)
                }
                val uri = ctx.contentResolver.insert(Telephony.Sms.CONTENT_URI, values)
                rowId = uri?.let { ContentUris.parseId(it) } ?: -1L
            } catch (_: Throwable) { /* not default SMS app → provider write denied */ }

            val sms = smsManager(ctx)
            val parts = sms.divideMessage(body)
            // [AVADIAL-SMS-TELEMETRY-1] Dispatch breadcrumb. `row_inserted` is the
            // ground truth for "are we ACTUALLY the default SMS app" — the provider
            // write above is denied for every non-default app, so a send with
            // ok=true + row_inserted=false means the radio took the message but the
            // OS does not consider us default. That pair is unfakeable and catches
            // role loss (user switched back to Messages) that isRoleHeld may still
            // report stale. `parts` > 1 means the body was split — multipart sends
            // fan out one sent/delivered status PER PART, so downstream event counts
            // will exceed send counts and that is expected, not a bug.
            track("avadial_sms_send_dispatch", mapOf(
                "dest_hash" to hashE164Native(dest),
                "body_len" to body.length,
                "parts" to parts.size,
                "row_inserted" to (rowId >= 0L),
            ))
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            val sentIntents = ArrayList<PendingIntent>(parts.size)
            val deliveredIntents = ArrayList<PendingIntent>(parts.size)
            for (i in parts.indices) {
                val sentPi = PendingIntent.getBroadcast(
                    ctx, r.hashCode() + i,
                    Intent(ACTION_SMS_SENT).setPackage(ctx.packageName)
                        .putExtra("ref", r)
                        .putExtra("row_id", rowId),
                    flags
                )
                val delPi = PendingIntent.getBroadcast(
                    ctx, (r.hashCode() + i) xor 0x7fffffff,
                    Intent(ACTION_SMS_DELIVERED).setPackage(ctx.packageName).putExtra("ref", r), flags
                )
                sentIntents.add(sentPi)
                deliveredIntents.add(delPi)
            }
            if (parts.size == 1) {
                sms.sendTextMessage(dest, null, body, sentIntents[0], deliveredIntents[0])
            } else {
                sms.sendMultipartTextMessage(dest, null, parts, sentIntents, deliveredIntents)
            }
            true
        } catch (t: Throwable) {
            // [AVADIAL-SMS-TELEMETRY-1] A throw here means the message never reached
            // the radio at all — no sent/delivered status will EVER follow, so without
            // this event the send is simply invisible. Class name only: exception
            // messages from SmsManager can echo the destination number back.
            track("avadial_sms_send_failed", mapOf(
                "dest_hash" to hashE164Native(dest),
                "body_len" to body.length,
                "reason" to (t::class.java.simpleName ?: "unknown"),
            ))
            false
        }
    }

    private fun smsManager(ctx: Context): SmsManager =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ctx.getSystemService(SmsManager::class.java)
        } else {
            @Suppress("DEPRECATION")
            SmsManager.getDefault()
        }

    /**
     * LIVE read of SMS conversation threads from the OS provider
     * (content://mms-sms/conversations). Returns one row per thread with the latest
     * snippet — bodies are read live, never persisted here (device-data boundary).
     */
    private fun smsQueryThreads(ctx: Context, limit: Int): List<Map<String, Any?>> {
        val out = ArrayList<Map<String, Any?>>()
        val proj = arrayOf(
            Telephony.Sms.THREAD_ID,
            Telephony.Sms.ADDRESS,
            Telephony.Sms.BODY,
            Telephony.Sms.DATE,
            Telephony.Sms.READ,
        )
        // Group by thread via a DISTINCT-ish query: order newest first and keep the
        // first row seen per thread (the latest message in that conversation).
        ctx.contentResolver.query(
            Telephony.Sms.CONTENT_URI, proj, null, null, Telephony.Sms.DATE + " DESC"
        )?.use { c ->
            val iThread = c.getColumnIndex(proj[0])
            val iAddr = c.getColumnIndex(proj[1])
            val iBody = c.getColumnIndex(proj[2])
            val iDate = c.getColumnIndex(proj[3])
            val iRead = c.getColumnIndex(proj[4])
            val seen = HashSet<Long>()
            while (c.moveToNext() && out.size < limit) {
                val thread = if (iThread >= 0) c.getLong(iThread) else -1L
                if (thread >= 0 && !seen.add(thread)) continue
                out.add(
                    mapOf(
                        "thread_id" to thread,
                        "address" to (if (iAddr >= 0) c.getString(iAddr) else null),
                        "snippet" to (if (iBody >= 0) c.getString(iBody) else null),
                        "date" to (if (iDate >= 0) c.getLong(iDate) else 0L),
                        "read" to (if (iRead >= 0) c.getInt(iRead) == 1 else true),
                    )
                )
            }
        }
        return out
    }

    /**
     * [AVA-SMS-BADGE-1] Per-address UNREAD counts from the SMS inbox (read = 0).
     * Drives the red count on the AvaDialer app icon and the orange counts on the
     * Messages tab / thread rows. Returns [{address, count}]; live read, nothing
     * persisted.
     */
    private fun smsUnreadCounts(ctx: Context): List<Map<String, Any?>> {
        val counts = LinkedHashMap<String, Int>()
        try {
            ctx.contentResolver.query(
                Telephony.Sms.Inbox.CONTENT_URI,
                arrayOf(Telephony.Sms.ADDRESS),
                Telephony.Sms.READ + " = 0", null, null
            )?.use { c ->
                val iAddr = c.getColumnIndex(Telephony.Sms.ADDRESS)
                while (c.moveToNext()) {
                    val addr = (if (iAddr >= 0) c.getString(iAddr) else null) ?: continue
                    counts[addr] = (counts[addr] ?: 0) + 1
                }
            }
        } catch (_: Throwable) { /* no READ_SMS yet → empty */ }
        return counts.map { (addr, n) -> mapOf<String, Any?>("address" to addr, "count" to n) }
    }

    /**
     * [AVA-SMS-BADGE-1] Mark every unread message from [address] as read — called
     * when the user opens that thread, which is what walks the badge counters
     * down. The provider write only succeeds while we hold ROLE_SMS (default SMS
     * app); otherwise this is a safe no-op. Returns rows updated.
     */
    private fun smsMarkRead(ctx: Context, address: String?): Int {
        if (address.isNullOrEmpty()) return 0
        return try {
            val v = ContentValues().apply { put(Telephony.Sms.READ, 1) }
            ctx.contentResolver.update(
                Telephony.Sms.CONTENT_URI, v,
                Telephony.Sms.ADDRESS + " = ? AND " + Telephony.Sms.READ + " = 0",
                arrayOf(address),
            )
        } catch (_: Throwable) {
            0
        }
    }

    /**
     * LIVE read of the messages in one thread, matched by [address]. Ordered oldest →
     * newest for a chat transcript. `type` maps Telephony.Sms.TYPE
     * (1=inbox/received, 2=sent).
     */
    private fun smsQueryMessages(ctx: Context, address: String?, limit: Int): List<Map<String, Any?>> {
        if (address.isNullOrEmpty()) return emptyList()
        val out = ArrayList<Map<String, Any?>>()
        val proj = arrayOf(
            Telephony.Sms._ID,
            Telephony.Sms.ADDRESS,
            Telephony.Sms.BODY,
            Telephony.Sms.DATE,
            Telephony.Sms.TYPE,
            Telephony.Sms.READ,
        )
        ctx.contentResolver.query(
            Telephony.Sms.CONTENT_URI, proj,
            Telephony.Sms.ADDRESS + " = ?", arrayOf(address),
            Telephony.Sms.DATE + " ASC"
        )?.use { c ->
            val iId = c.getColumnIndex(proj[0])
            val iAddr = c.getColumnIndex(proj[1])
            val iBody = c.getColumnIndex(proj[2])
            val iDate = c.getColumnIndex(proj[3])
            val iType = c.getColumnIndex(proj[4])
            val iRead = c.getColumnIndex(proj[5])
            var n = 0
            while (c.moveToNext() && n < limit) {
                out.add(
                    mapOf(
                        "id" to (if (iId >= 0) c.getLong(iId) else 0L),
                        "address" to (if (iAddr >= 0) c.getString(iAddr) else null),
                        "body" to (if (iBody >= 0) c.getString(iBody) else null),
                        "date" to (if (iDate >= 0) c.getLong(iDate) else 0L),
                        "type" to (if (iType >= 0) c.getInt(iType) else 0),
                        "read" to (if (iRead >= 0) c.getInt(iRead) == 1 else true),
                    )
                )
                n++
            }
        }
        return out
    }
}

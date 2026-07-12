package ai.avatok.avadial

import android.Manifest
import android.app.PendingIntent
import android.app.role.RoleManager
import android.content.BroadcastReceiver
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
import android.provider.Telephony
import android.telecom.TelecomManager
import android.telephony.SmsManager
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry
import java.io.File

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
         * Called by MainActivity when it is (re)launched with the AvaDial incoming
         * route extra. Records the pending call for a cold-start drain AND emits
         * `onLaunchIncoming` for the already-running case.
         */
        fun notifyIncomingLaunch(callId: String?, number: String?) {
            if (callId.isNullOrEmpty()) return
            pendingCallId = callId
            pendingNumber = number
            emit("onLaunchIncoming", mapOf("call_id" to callId, "number" to number))
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
    }

    private var channel: MethodChannel? = null
    private var appContext: Context? = null
    private var activityBinding: ActivityPluginBinding? = null
    private var smsResultReceiver: BroadcastReceiver? = null

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
                emit("onSmsSendStatus", mapOf("ref" to ref, "phase" to phase, "ok" to ok))
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
                "getPendingCompose" -> {
                    val out: Map<String, Any?>? = pendingComposeNumber?.let { mapOf("number" to it) }
                    pendingComposeNumber = null
                    result.success(out)
                }

                // ---- live device reads (no persistence) ----
                "readContacts" -> result.success(readContacts(ctx))
                "readCallLog" -> result.success(readCallLog(ctx, (call.argument<Int>("limit")) ?: 500))

                // ---- screening snapshot handshake ----
                "snapshotPath" -> result.success(snapshotFile(ctx).absolutePath)

                // ---- cold-start incoming-call drain (route extra "avadial/incoming") ----
                "getPendingIncoming" -> {
                    val out: Map<String, Any?>? = pendingCallId?.let {
                        mapOf("call_id" to it, "number" to pendingNumber)
                    }
                    pendingCallId = null
                    pendingNumber = null
                    result.success(out)
                }

                // ---- system block-list write-through (default dialer only) ----
                "systemBlock" -> result.success(systemBlock(ctx, call.argument<String>("number")))
                "systemUnblock" -> result.success(systemUnblock(ctx, call.argument<String>("number")))

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

    private fun canBlockNumbers(ctx: Context): Boolean = try {
        BlockedNumberContract.canCurrentUserBlockNumbers(ctx)
    } catch (_: Throwable) {
        false
    }

    /**
     * Place an outgoing PSTN call via [TelecomManager.placeCall] (never a fabricated
     * connection — the platform's emergency routing stays in force, spike §1). Returns
     * true when the call was dispatched. When CALL_PHONE is not yet granted we kick off
     * the runtime request (needs the Activity) and return false so the Dart side can
     * fall back to an ACTION_DIAL intent for this attempt; the next tap (post-grant)
     * places the call directly.
     */
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
     * forwards status to Dart as `onSmsSendStatus {ref, phase, ok}`. The default SMS
     * app writes the outgoing message into the SMS provider (content://sms) itself, so
     * we insert it into Telephony.Sms.Sent after handing it to the radio. Returns true
     * when the send was dispatched (NOT when delivered — that arrives on the channel).
     *
     * Device-data boundary: message bodies live ONLY in the OS SMS provider; our
     * scoped store keeps spam labels/metadata, never the text.
     */
    private fun smsSend(ctx: Context, dest: String?, body: String?, ref: String?): Boolean {
        if (dest.isNullOrEmpty() || body == null) return false
        val r = ref ?: System.currentTimeMillis().toString()
        return try {
            val sms = smsManager(ctx)
            val parts = sms.divideMessage(body)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            val sentIntents = ArrayList<PendingIntent>(parts.size)
            val deliveredIntents = ArrayList<PendingIntent>(parts.size)
            for (i in parts.indices) {
                val sentPi = PendingIntent.getBroadcast(
                    ctx, r.hashCode() + i,
                    Intent(ACTION_SMS_SENT).setPackage(ctx.packageName).putExtra("ref", r), flags
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
            // Mirror the sent message into the OS SMS provider so the thread reads back
            // consistently (only meaningful while we hold ROLE_SMS).
            try {
                val values = android.content.ContentValues().apply {
                    put(Telephony.Sms.ADDRESS, dest)
                    put(Telephony.Sms.BODY, body)
                    put(Telephony.Sms.DATE, System.currentTimeMillis())
                    put(Telephony.Sms.READ, 1)
                    put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_SENT)
                }
                ctx.contentResolver.insert(Telephony.Sms.Sent.CONTENT_URI, values)
            } catch (_: Throwable) { /* not default SMS app → provider write denied */ }
            true
        } catch (_: Throwable) {
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

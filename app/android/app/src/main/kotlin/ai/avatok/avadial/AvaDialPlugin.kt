package ai.avatok.avadial

import android.app.role.RoleManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.provider.BlockedNumberContract
import android.provider.CallLog
import android.provider.ContactsContract
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

        // Single live instance so the InCallService / CallScreeningService can push
        // events up to Flutter when the engine is attached (best-effort).
        @Volatile
        private var instance: AvaDialPlugin? = null

        private val main = Handler(Looper.getMainLooper())

        /** Post an event to Dart on the main thread. No-op if the engine is gone. */
        fun emit(method: String, args: Map<String, Any?>) {
            val plugin = instance ?: return
            main.post { plugin.channel?.invokeMethod(method, args) }
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

    // ── FlutterPlugin ──────────────────────────────────────────────────────────
    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        appContext = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL).also {
            it.setMethodCallHandler(this)
        }
        instance = this
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
        if (instance === this) instance = null
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
                "isDialerRoleHeld" ->
                    result.success(AvaDialRoleHelper.isRoleHeld(ctx, RoleManager.ROLE_DIALER))
                "isScreeningRoleHeld" ->
                    result.success(AvaDialRoleHelper.isRoleHeld(ctx, RoleManager.ROLE_CALL_SCREENING))
                "canBlockNumbers" -> result.success(canBlockNumbers(ctx))

                // ---- live device reads (no persistence) ----
                "readContacts" -> result.success(readContacts(ctx))
                "readCallLog" -> result.success(readCallLog(ctx, (call.argument<Int>("limit")) ?: 500))

                // ---- screening snapshot handshake ----
                "snapshotPath" -> result.success(snapshotFile(ctx).absolutePath)

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
}

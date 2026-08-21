package ai.avatok.avatok_call

import android.content.Intent
import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.hiennv.flutter_callkit_incoming.CallkitConstants
import com.hiennv.flutter_callkit_incoming.FlutterCallkitIncomingPlugin
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.util.UUID
import org.json.JSONObject

// FlutterFragmentActivity (not FlutterActivity) is REQUIRED by flutter_stripe so
// the native PaymentSheet can attach its own fragments to the host activity.
class MainActivity : FlutterFragmentActivity() {
    // Lets Dart toggle the OS secure-screen flag while sensitive content (e.g. a
    // profile-photo viewer) is on screen — blocks screenshots + screen recording
    // and hides the window in the app switcher.
    private val secureChannel = "avatok/secure_screen"
    private val incomingTapChannelName = "avatok/incoming_call_tap"
    private val processExitChannelName = "avatok/process_exit"
    private var incomingTapChannel: MethodChannel? = null

    // [CALL-ACCEPT-FRAME-1] Native "Connecting…" continuity overlay + tap→
    // first-frame telemetry. See Specs/PLAN-CALL-INSTANT-PICKUP-2026-08-16.md §P3.
    private var connectingOverlay: android.view.View? = null
    private var flutterUiDisplayed = false
    private val overlayHandler = Handler(Looper.getMainLooper())
    private var overlayFailsafe: Runnable? = null

    // [CALL-NATIVE-ANSWER-1] Interactive native ring screen (caller name +
    // Accept/Decline), shown only while `callNativeAnswerV1` is on AND Flutter
    // has not yet painted. Instance-scoped like connectingOverlay above — both
    // surfaces are mutually exclusive (see maybeShowNativeAnswerSurface) so at
    // most one of the two fields is ever non-null.
    private var nativeRingScreen: View? = null
    private var nativeRingFailsafe: Runnable? = null
    private var nativeRingPayload: Map<String, Any?>? = null
    private var nativeRingShownAtElapsedMs: Long = 0L

    companion object {
        private var pendingIncomingTap: Map<String, Any?>? = null

        // [CALL-ACCEPT-FRAME-1] elapsedRealtime() at the moment a native ACCEPT
        // launch/relaunch was detected. Companion (not instance) purely to match
        // the existing pendingIncomingTap pattern above; there is at most one
        // MainActivity instance alive at a time. Volatile: read/written from the
        // main thread only in practice, but this mirrors AvaVoiceAudioPlugin's
        // activeInstance convention for cross-file statics.
        @Volatile
        private var acceptTapAtElapsedMs: Long = 0L

        // [CALL-NATIVE-ANSWER-1] A tap on the native ring screen's Accept/Decline
        // button. Same "companion holds it until Dart drains it" shape as
        // pendingIncomingTap above — a tap can land before Dart has registered
        // its handler (the whole point of this feature is that Flutter is still
        // cold-starting), so it must survive until getPendingRingAction runs.
        @Volatile
        private var pendingNativeRingAction: Map<String, Any?>? = null

        // [CALL-NATIVE-ANSWER-1] Disk mirror of the `callNativeAnswerV1` remote
        // flag. Native has no engine on a cold notification tap and so cannot
        // read Dart's RemoteConfig — this file is how it learns the flag, same
        // pattern as AvaDialPlugin.NATIVE_UI_FILE / nativeInCallEnabled().
        // Written by RemoteConfig.refresh() via the "setCallNativeAnswerV1"
        // channel method below.
        private const val NATIVE_ANSWER_DIR = "callnative"
        private const val NATIVE_ANSWER_FLAG_FILE = "answer_flags.json"

        private fun nativeAnswerFlagFile(context: android.content.Context): File {
            val dir = File(context.filesDir, NATIVE_ANSWER_DIR)
            if (!dir.exists()) dir.mkdirs()
            return File(dir, NATIVE_ANSWER_FLAG_FILE)
        }

        /// Fail-CLOSED, matching [RemoteConfig.callNativeAnswerV1]'s own OFF
        /// default: any doubt (no file, corrupt JSON, IO error) => false, and the
        /// caller falls back to today's passive "Connecting…" overlay.
        private fun isCallNativeAnswerV1Enabled(context: android.content.Context): Boolean = try {
            val f = nativeAnswerFlagFile(context)
            if (!f.exists() || f.length() == 0L) false
            else JSONObject(f.readText()).optBoolean("call_native_answer_v1", false)
        } catch (_: Throwable) {
            false
        }

        private fun writeNativeAnswerFlag(context: android.content.Context, enabled: Boolean) {
            try {
                val obj = JSONObject()
                    .put("call_native_answer_v1", enabled)
                    .put("updated", System.currentTimeMillis())
                val file = nativeAnswerFlagFile(context)
                val tmp = File(file.parentFile, file.name + ".tmp")
                tmp.writeText(obj.toString(), Charsets.UTF_8)
                if (!tmp.renameTo(file)) {
                    file.writeText(obj.toString(), Charsets.UTF_8)
                    tmp.delete()
                }
            } catch (_: Throwable) { /* best-effort — a write failure just keeps the flag OFF */ }
        }

        // ─────────────────────────────────────────────────────────────────
        // [CALL-NATIVE-ANSWER-2 2026-08-18] Durable Accept/Decline.
        // ─────────────────────────────────────────────────────────────────
        //
        // `pendingNativeRingAction` above (the in-memory static) is a fast
        // path only, and P1: if Android kills the process between the tap
        // and Dart's `getPendingRingAction` drain, that static is gone and
        // the user's Accept/Decline is LOST — they tapped and nothing
        // happens. This mirrors `NATIVE_ANSWER_FLAG_FILE` above (same
        // `callnative` dir, same tmp-file-then-rename atomic write) but for
        // the TAPPED ACTION itself, not the flag. DISK is the source of
        // truth; memory is kept purely so the common case (process alive)
        // never pays a disk read.
        private const val NATIVE_ANSWER_ACTION_FILE = "pending_ring_action.json"

        /// How long a persisted tap stays deliverable. Matches a ring
        /// window with headroom — an accept recovered minutes after the
        /// user tapped (e.g. the process was killed and only relaunched
        /// much later by an unrelated tap) must NOT silently join a call
        /// the user has long since forgotten about.
        private const val NATIVE_ANSWER_ACTION_TTL_MS = 60_000L

        private fun pendingRingActionFile(context: android.content.Context): File {
            val dir = File(context.filesDir, NATIVE_ANSWER_DIR)
            if (!dir.exists()) dir.mkdirs()
            return File(dir, NATIVE_ANSWER_ACTION_FILE)
        }

        /// Atomically persists a full action map (already carrying
        /// `nonce`/`timestampMs`/`expiryMs` — see [recordNativeRingAction])
        /// to disk. Best-effort: a write failure only costs the
        /// process-death-survival path; the in-memory fast path still has
        /// the tap for a live process.
        private fun persistPendingRingAction(context: android.content.Context, action: Map<String, Any?>) {
            try {
                val obj = JSONObject()
                for ((k, v) in action) {
                    when (v) {
                        null -> obj.put(k, JSONObject.NULL)
                        else -> obj.put(k, v)
                    }
                }
                val file = pendingRingActionFile(context)
                val tmp = File(file.parentFile, file.name + ".tmp")
                tmp.writeText(obj.toString(), Charsets.UTF_8)
                if (!tmp.renameTo(file)) {
                    file.writeText(obj.toString(), Charsets.UTF_8)
                    tmp.delete()
                }
            } catch (_: Throwable) { /* best-effort — worst case falls back to memory-only */ }
        }

        /// Reads AND DELETES the persisted action in one call — the whole
        /// point is that a replayed/duplicate drain (Dart re-invoking
        /// `getPendingRingAction`, a hot restart, etc.) must return nothing
        /// the second time. Returns null when absent, empty, or corrupt (a
        /// corrupt entry is discarded, never redelivered, same as an
        /// expired one).
        private fun consumePersistedRingAction(context: android.content.Context): Map<String, Any?>? {
            val file = pendingRingActionFile(context)
            return try {
                if (!file.exists() || file.length() == 0L) return null
                val text = file.readText(Charsets.UTF_8)
                file.delete()
                val obj = JSONObject(text)
                val map = HashMap<String, Any?>()
                val keys = obj.keys()
                while (keys.hasNext()) {
                    val k = keys.next()
                    val v = obj.get(k)
                    map[k] = if (v === JSONObject.NULL) null else v
                }
                map
            } catch (_: Throwable) {
                try { file.delete() } catch (_: Throwable) {}
                null
            }
        }

        /// Drops the disk copy without necessarily consuming/returning it —
        /// used by the `clearPending` channel method ([CALL-STALE-TAP-1]'s
        /// staleness hazard applies to the persisted copy exactly as it did
        /// to the in-memory one). `callId == null` clears unconditionally.
        private fun clearPersistedRingActionIfMatches(context: android.content.Context, callId: String?) {
            try {
                val file = pendingRingActionFile(context)
                if (!file.exists()) return
                if (callId == null) {
                    file.delete()
                    return
                }
                val obj = JSONObject(file.readText(Charsets.UTF_8))
                if (obj.optString("callId") == callId) file.delete()
            } catch (_: Throwable) { /* best-effort */ }
        }

        /// The ONE drain entry point for `getPendingRingAction`, called from
        /// [MainActivity] instance methods below. IDEMPOTENT: memory is
        /// cleared and the disk file deleted in this same call, so a second
        /// call immediately after returns null. Adds three read-time fields
        /// on top of whatever was persisted:
        ///  - `ageMs`: now - timestampMs
        ///  - `expired`: age past the entry's own expiryMs — Dart must NOT
        ///    route an expired entry into accept/decline, only log
        ///    `call_native_answer_expired`.
        ///  - `restoredFromDisk`: true when the in-memory fast path was
        ///    empty and this came from disk (i.e. the process died between
        ///    the tap and this drain) — Dart logs
        ///    `call_native_answer_restored` for exactly this case.
        private fun drainPendingRingAction(context: android.content.Context): Map<String, Any?>? {
            val memory = pendingNativeRingAction
            pendingNativeRingAction = null
            val restoredFromDisk = memory == null
            val raw = memory ?: consumePersistedRingAction(context)
            // Whether we returned the memory copy or the disk copy, the disk
            // file for this same tap (if any) must not survive this drain —
            // otherwise a LATER cold read (this process dies with nothing
            // pending in memory, then something else drains again) could
            // resurrect an already-delivered tap.
            if (!restoredFromDisk) deletePendingRingActionFile(context)
            if (raw == null) return null

            val timestampMs = (raw["timestampMs"] as? Number)?.toLong() ?: 0L
            val expiryMs = (raw["expiryMs"] as? Number)?.toLong() ?: NATIVE_ANSWER_ACTION_TTL_MS
            val ageMs = if (timestampMs > 0L) {
                (System.currentTimeMillis() - timestampMs).coerceAtLeast(0L)
            } else 0L
            val expiresAtMs = (raw["expiresAtMs"] as? Number)?.toLong() ?: 0L
            val expired = if (expiresAtMs > 0L) {
                System.currentTimeMillis() >= expiresAtMs
            } else timestampMs > 0L && ageMs >= expiryMs

            val out = HashMap<String, Any?>(raw)
            out["ageMs"] = ageMs
            out["expired"] = expired
            out["restoredFromDisk"] = restoredFromDisk
            return out
        }

        private fun deletePendingRingActionFile(context: android.content.Context) {
            try { pendingRingActionFile(context).delete() } catch (_: Throwable) {}
        }
    }

    /// [CALL-ACCEPT-FRAME-1] True when this launch/relaunch's Intent is
    /// flutter_callkit_incoming's native ACCEPT relay.
    ///
    /// TransparentActivity.onCreate (plugin source, locked to 2.5.8 by
    /// scripts/patch_callkit_native_decline.py) does two things when the user
    /// taps Accept — the API 34+ CallStyle "Answer" swipe, the pre-34 custom
    /// notification's accept button, and the heads-up notification action all
    /// go through the SAME getAcceptPendingIntent, so this is not a guess about
    /// one surface: (1) broadcasts CallkitConstants.ACTION_CALL_ACCEPT to
    /// CallkitIncomingBroadcastReceiver (fires CallkitNotificationService +
    /// the EventChannel Dart already listens to via push_service.dart's
    /// Event.actionCallAccept, IF an engine is alive to receive it), and
    /// (2) calls AppUtils.getAppIntent(context, action = ACTION_CALL_ACCEPT,
    /// data = ...), which clones the launcher intent for MainActivity and sets
    /// that action + the same EXTRA_CALLKIT_CALL_DATA bundle used elsewhere in
    /// this file. That second intent is what reaches onCreate/onNewIntent here,
    /// cold or warm, so checking `intent.action` is a durable native-side signal
    /// rather than a heuristic — no flutter_callkit_incoming upgrade can change
    /// it without the decline-guard patch script above already failing loudly.
    ///
    /// [CALL-ACCEPT-FRAME-2 2026-08-17] ...and that reasoning, while correct
    /// about ACTION_CALL_ACCEPT, described a lane this app does not normally
    /// use — which is why `call_accept_first_frame_ms` never fired ONCE in
    /// production and the continuity overlay never appeared. THIS repo patches
    /// `getActivityPendingIntent` so the ring's full-screen-intent and body tap
    /// launch MainActivity with `avatok.incoming_call_tap` (handled at the
    /// `onNewIntent`/route site further down this file) and the user then taps
    /// Accept inside the Flutter branded screen — so the blank screen the owner
    /// reported spans the incoming_call_tap launch, NOT an ACTION_CALL_ACCEPT
    /// one. Both actions mean the same thing for continuity purposes: "the user
    /// is trying to get into a call and is about to stare at whatever we draw",
    /// so both arm the overlay and the tap→first-frame measurement.
    private fun isNativeAcceptLaunch(intent: Intent?): Boolean =
        intent?.action == CallkitConstants.ACTION_CALL_ACCEPT ||
            intent?.action == INCOMING_TAP_ACTION ||
            intent?.action == STREAM_ACCEPT_ACTION

    /// [CALL-ACCEPT-FRAME-2] The action this repo's own CallKit patch uses for
    /// FSI / notification-body taps. Kept as one constant because the string is
    /// asserted in three places (here, the route handler below, and
    /// scripts/patch_callkit_native_decline.py's generated intent).
    private val INCOMING_TAP_ACTION = "avatok.incoming_call_tap"
    private val STREAM_ACCEPT_ACTION = "io.getstream.video.android.action.ACCEPT_CALL"

    /// The bridge has a fail-closed stub in normal builds, so the main activity
    /// can forward this before Flutter starts without linking Stream SDK types.
    private fun forwardStreamNotificationIntent(intent: Intent?) {
        val handledByStream = try {
            val bridge = Class.forName("ai.avatok.streamcall.StreamCallBridgePlugin")
            bridge.getMethod(
                "handleIntent",
                android.content.Context::class.java,
                Intent::class.java,
            ).invoke(null, applicationContext, intent) == true
        } catch (_: Throwable) {
            // Normal Cloudflare build or malformed provider intent: fail closed.
            false
        }
        if (handledByStream && intent?.action == STREAM_ACCEPT_ACTION) {
            val cid = intent.getStringExtra("io.getstream.video.android.intent-extra.call_cid")
            val callId = cid?.substringAfter(':', "").orEmpty()
            if (callId.isNotEmpty()) {
                // Native media is already accepting/joining. This durable action
                // tells the existing Dart call controller to reconcile AvaTOK's
                // server state and open the unchanged in-call UI; the bridge's
                // joined-call latch makes its later join command idempotent.
                recordNativeRingAction(mapOf(
                    "action" to "accept",
                    "callId" to callId,
                    "from" to "",
                    "fromName" to "AvaTOK",
                    "kind" to "audio",
                    "provider" to "stream",
                    "streamNativeAccepted" to true,
                ))
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // [CALL-ACCEPT-FRAME-1] Capture t0 before super.onCreate() inflates
        // anything, so the span includes engine attach + first frame, not just
        // whatever we do here. A fresh instance is always "cold" — a warm accept
        // (engine/activity already up) can only ever reach onNewIntent below,
        // never a fresh onCreate.
        val launchedAtElapsedMs = SystemClock.elapsedRealtime()
        forwardStreamNotificationIntent(intent)
        if (isNativeAcceptLaunch(intent)) {
            acceptTapAtElapsedMs = launchedAtElapsedMs
        }
        super.onCreate(savedInstanceState)
        // Added AFTER super.onCreate() so the FlutterFragment's view (added by
        // the fragment transaction super.onCreate() commits) is already a child
        // of android.R.id.content — our overlay is added last, i.e. on top.
        maybeShowNativeAnswerSurface(intent, launchedAtElapsedMs)
    }

    /// [CALL-NATIVE-ANSWER-1] The ONE place that decides which of the two
    /// native continuity surfaces (if either) to show for a launch/relaunch
    /// that isNativeAcceptLaunch() already flagged as "the user is trying to
    /// get into a call". Called from both onCreate and onNewIntent so the
    /// two entry points can never diverge.
    ///
    /// FLAG OFF, or an `ACTION_CALL_ACCEPT` launch, or an unparsable payload:
    /// falls back to exactly today's behaviour (the passive "Connecting…"
    /// overlay, gated on acceptTapAtElapsedMs having just been armed by the
    /// caller) — byte-for-byte, so this function is a strict superset of the
    /// old inline `if (acceptTapAtElapsedMs != 0L && !flutterUiDisplayed)
    /// showConnectingOverlay()` checks it replaces.
    private fun maybeShowNativeAnswerSurface(intent: Intent?, launchedAtElapsedMs: Long) {
        if (flutterUiDisplayed) return
        // Stream already starts accept+media natively before Flutter boots.
        // Showing AvaTOK's legacy "Connecting…" overlay here would cover the
        // real call UI and recreate the exact waiting state this pilot removes.
        if (intent?.action == STREAM_ACCEPT_ACTION) return
        if (intent?.action == INCOMING_TAP_ACTION && isCallNativeAnswerV1Enabled(this)) {
            val payload = parseIncomingTapExtra(intent)
            if (payload != null) {
                nativeRingShownAtElapsedMs = launchedAtElapsedMs
                showNativeRingScreen(payload)
                return
            }
        }
        if (acceptTapAtElapsedMs != 0L) {
            showConnectingOverlay()
        }
    }

    /// [CALL-ACCEPT-FRAME-1] Full-screen native continuity surface: solid dark
    /// background + centered "Connecting…" / "AvaTOK" labels, added as the
    /// TOPMOST child of the activity's content view. Plain View with no click
    /// listener and not focusable — it does not consume touches (they fall
    /// through to whatever is beneath) or steal key focus, so it cannot block
    /// the back button from dismissing the activity underneath it.
    private fun showConnectingOverlay() {
        if (connectingOverlay != null) return
        val root = window.decorView.findViewById<ViewGroup>(android.R.id.content) ?: return

        val label = TextView(this).apply {
            text = "Connecting…"
            setTextColor(0xFFE8EDEF.toInt())
            textSize = 26f
            gravity = Gravity.CENTER
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        }
        val brand = TextView(this).apply {
            text = "AvaTOK"
            setTextColor(0x99E8EDEF.toInt())
            textSize = 14f
            gravity = Gravity.CENTER
        }
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            addView(
                label,
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
                )
            )
            addView(
                brand,
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = (8 * resources.displayMetrics.density).toInt() }
            )
        }
        val overlay = FrameLayout(this).apply {
            setBackgroundColor(0xFF0E1113.toInt())
            isClickable = false
            isFocusable = false
            addView(
                column,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    Gravity.CENTER
                )
            )
        }
        root.addView(
            overlay,
            ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        )
        connectingOverlay = overlay

        // Failsafe: a wedged/crashed engine must never trap the user behind
        // this overlay. 6s is generously above the ~2s "cold" success bar in
        // the ship manifest.
        val failsafe = Runnable { removeConnectingOverlay() }
        overlayFailsafe = failsafe
        overlayHandler.postDelayed(failsafe, 6000L)
    }

    /// [CALL-ACCEPT-FRAME-1] 150ms fade-out, then detach. No-op if already
    /// removed (both onFlutterUiDisplayed and the failsafe timer call this).
    private fun removeConnectingOverlay() {
        val overlay = connectingOverlay ?: return
        connectingOverlay = null
        overlay.animate().alpha(0f).setDuration(150L).withEndAction {
            (overlay.parent as? ViewGroup)?.removeView(overlay)
        }.start()
    }

    /// [CALL-NATIVE-ANSWER-1] Parses MainActivity's own `avatok.incoming_call_tap`
    /// launch intent into the SAME shape [forwardNotificationTapIfPresent] has
    /// always sent to Dart. Factored out so [maybeShowNativeAnswerSurface] can
    /// read caller name/handle/kind BEFORE the Flutter engine exists to consume
    /// the payload — [forwardNotificationTapIfPresent] now calls this too
    /// (below) rather than re-parsing the same bundle a second way.
    private fun parseIncomingTapExtra(intent: Intent?): Map<String, Any?>? {
        if (intent?.action != INCOMING_TAP_ACTION) return null
        @Suppress("DEPRECATION", "UNCHECKED_CAST")
        val data = intent.getBundleExtra(FlutterCallkitIncomingPlugin.EXTRA_CALLKIT_CALL_DATA)
        val extra = data?.getSerializable(CallkitConstants.EXTRA_CALLKIT_EXTRA)
                as? Map<String, Any?> ?: emptyMap()
        return mapOf<String, Any?>(
            "callId" to (extra["callId"]
                ?: data?.getString(CallkitConstants.EXTRA_CALLKIT_ID).orEmpty()),
            "from" to (extra["from"]
                ?: data?.getString(CallkitConstants.EXTRA_CALLKIT_HANDLE).orEmpty()),
            "fromName" to (extra["fromName"]
                ?: data?.getString(CallkitConstants.EXTRA_CALLKIT_NAME_CALLER).orEmpty()),
            "kind" to (extra["kind"] ?: "audio"),
            "callerAvatarUrl" to (extra["callerAvatarUrl"]
                ?: data?.getString(CallkitConstants.EXTRA_CALLKIT_AVATAR).orEmpty()),
            "callerAvatarVersion" to (extra["callerAvatarVersion"] ?: ""),
            "roomToken" to (extra["roomToken"] ?: ""),
            // [CALL-PREWARM-NATIVE-1] These identity fields are copied through
            // the cold-start intent so a late FCM/CallKit action cannot mutate a
            // newer invite. Older payloads simply use empty values and retain
            // the existing cold path.
            "inviteNonce" to (extra["inviteNonce"] ?: extra["prewarmNonce"] ?: extra["nonce"] ?: "").toString(),
            "generation" to (extra["generation"] ?: extra["prewarmGeneration"] ?: "").toString(),
            "expiresAtMs" to (extra["expiresAtMs"] ?: extra["nativeActionExpiresAt"] ?: extra["tokenExpiresAt"] ?: 0L).toString(),
            "serverSequence" to (extra["serverSequence"] ?: extra["seq"] ?: "").toString(),
        )
    }

    /// [CALL-NATIVE-ANSWER-1] Full-screen interactive native ring surface:
    /// caller name/handle + Decline/Accept, painted synchronously in
    /// onCreate/onNewIntent — before the Flutter engine has attached, let
    /// alone rendered a frame. This is the fix for the measured 5.61s gap
    /// between the OS notification appearing (`call_incoming_shown`) and the
    /// Flutter branded screen finally routing (`call_branded_fsi_routed`):
    /// `_routeToBrandedIncoming` in push_service.dart polls
    /// `navigatorKey.currentState` every 250ms for up to 10s waiting for the
    /// engine to cold-start, and the user cannot press Accept during that wait.
    ///
    /// `isClickable = true` here (unlike the passive connectingOverlay) is
    /// deliberate: this surface is meant to intercept touches — that is its
    /// entire purpose — not let them fall through to whatever paints beneath.
    private fun showNativeRingScreen(payload: Map<String, Any?>) {
        if (nativeRingScreen != null) return
        if (connectingOverlay != null) return // mutually exclusive continuity surfaces
        val callId = (payload["callId"] as? String).orEmpty()
        // Validate identity and expiry before constructing/attaching any native
        // ring surface. The bridge record must already be RINGING; this method
        // is never allowed to create that transition from a local intent.
        if (isCallNativeAnswerV1Enabled(this) && NativeCallPrewarmBridge.isEnabled(this)) {
            val inviteNonce = (payload["inviteNonce"] as? String).orEmpty()
            val generation = (payload["generation"] as? String).orEmpty()
            val expiresAtMs = (payload["expiresAtMs"] as? Number)?.toLong()
                ?: payload["expiresAtMs"]?.toString()?.toLongOrNull() ?: 0L
            val serverSequence = (payload["serverSequence"] as? Number)?.toLong()
                ?: payload["serverSequence"]?.toString()?.toLongOrNull() ?: 0L
            if (expiresAtMs > 0L && expiresAtMs <= System.currentTimeMillis()) return
            if (inviteNonce.isNotEmpty() && generation.isNotEmpty() && serverSequence > 0L) {
                // This is the server-promoted ring edge carried by the intent;
                // it is not inferred from showing the UI.
                NativeCallPrewarmBridge.ringing(
                    this, callId, inviteNonce, generation, serverSequence, expiresAtMs,
                )
            }
            if (inviteNonce.isNotEmpty() && generation.isNotEmpty() &&
                !NativeCallPrewarmBridge.isCurrent(this, callId, inviteNonce, generation)) {
                android.util.Log.w("MainActivity", "dropping stale incoming-call intent callId=$callId")
                return
            }
        }
        val root = window.decorView.findViewById<ViewGroup>(android.R.id.content) ?: return

        nativeRingPayload = payload
        val callerName = (payload["fromName"] as? String).orEmpty()
        val callerHandle = (payload["from"] as? String).orEmpty()
        val isVideo = (payload["kind"] as? String) == "video"
        val density = resources.displayMetrics.density

        val nameView = TextView(this).apply {
            text = callerName.ifBlank { callerHandle.ifBlank { "AvaTOK" } }
            setTextColor(0xFFE8EDEF.toInt())
            textSize = 28f
            gravity = Gravity.CENTER
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        }
        val subtitleView = TextView(this).apply {
            text = if (isVideo) "AvaTOK video call" else "AvaTOK voice call"
            setTextColor(0x99E8EDEF.toInt())
            textSize = 14f
            gravity = Gravity.CENTER
        }
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            addView(
                nameView,
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
                )
            )
            addView(
                subtitleView,
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = (8 * density).toInt() }
            )
        }

        val buttonHeight = (72 * density).toInt()
        val declineButton = TextView(this).apply {
            text = "Decline"
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 16f
            gravity = Gravity.CENTER
            setBackgroundColor(0xFFE5484D.toInt())
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            isClickable = true
            isFocusable = true
            setOnClickListener { onNativeRingDecline() }
        }
        val acceptButton = TextView(this).apply {
            text = "Accept"
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 16f
            gravity = Gravity.CENTER
            setBackgroundColor(0xFF2FAE6B.toInt())
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            isClickable = true
            isFocusable = true
            setOnClickListener { onNativeRingAccept() }
        }
        val buttonRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            weightSum = 2f
            addView(
                declineButton,
                LinearLayout.LayoutParams(0, buttonHeight, 1f).apply {
                    marginEnd = (6 * density).toInt()
                }
            )
            addView(
                acceptButton,
                LinearLayout.LayoutParams(0, buttonHeight, 1f).apply {
                    marginStart = (6 * density).toInt()
                }
            )
        }

        val screen = FrameLayout(this).apply {
            setBackgroundColor(0xFF0E1113.toInt())
            isClickable = true
            isFocusable = true
            addView(
                column,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    Gravity.CENTER
                )
            )
            addView(
                buttonRow,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, buttonHeight, Gravity.BOTTOM
                ).apply {
                    leftMargin = (24 * density).toInt()
                    rightMargin = (24 * density).toInt()
                    bottomMargin = (48 * density).toInt()
                }
            )
        }
        root.addView(
            screen,
            ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        )
        nativeRingScreen = screen

        val msFromIntent = (SystemClock.elapsedRealtime() - nativeRingShownAtElapsedMs).coerceAtLeast(0L)
        ai.avatok.avavoiceaudio.AvaVoiceAudioPlugin.emitNativeRingShown(callId, msFromIntent)

        // [CALL-NATIVE-ANSWER-2 2026-08-18] NOT a 6s blind removal anymore —
        // that was a P1 defect: it tore down the ONLY interactive surface
        // the user has while Flutter is still cold-starting, leaving them
        // staring at nothing if the engine took longer than 6s to paint.
        // This is a LONG backstop only (45s, roughly a ring window) for a
        // truly wedged/crashed engine that will NEVER reach
        // onFlutterUiDisplayed; the two real removal paths are (a) confirmed
        // Flutter handoff — [onFlutterUiDisplayed] below calls
        // [removeNativeRingScreen] the moment the branded screen is
        // painted, however long that takes — and (b) a terminal call state
        // learned from Dart via the `clearNativeRingScreen` channel method
        // (e.g. the caller cancelled while this screen was still up).
        val failsafe = Runnable {
            android.util.Log.w(
                "MainActivity",
                "[CALL-NATIVE-ANSWER-2] native ring screen 45s failsafe fired " +
                    "for callId=$callId — Flutter never reached first frame and " +
                    "no terminal call state arrived; removing to avoid trapping the user"
            )
            removeNativeRingScreen()
        }
        nativeRingFailsafe = failsafe
        overlayHandler.postDelayed(failsafe, 45_000L)
    }

    /// [CALL-NATIVE-ANSWER-1] 150ms fade-out, then detach. No-op if already
    /// removed. Called on: Accept/Decline tap (immediately, after swapping to
    /// the passive overlay or handing off to Dart), Flutter's first frame
    /// (onFlutterUiDisplayed — the branded screen is up), a Dart-reported
    /// terminal call state ([CALL-NATIVE-ANSWER-2] `clearNativeRingScreen`),
    /// and the 45s failsafe above.
    private fun removeNativeRingScreen() {
        val screen = nativeRingScreen ?: return
        nativeRingScreen = null
        nativeRingFailsafe?.let { overlayHandler.removeCallbacks(it) }
        nativeRingFailsafe = null
        screen.animate().alpha(0f).setDuration(150L).withEndAction {
            (screen.parent as? ViewGroup)?.removeView(screen)
        }.start()
    }

    /// [CALL-NATIVE-ANSWER-1] Drop the [pendingIncomingTap] companion entry
    /// for [callId] the instant the user acts on the native ring screen.
    ///
    /// `pendingIncomingTap` was already populated (and one `incomingCallTapped`
    /// send already silently dropped, since no Dart handler exists yet) by
    /// [forwardNotificationTapIfPresent] running inside `configureFlutterEngine`
    /// — which `super.onCreate()` runs BEFORE [maybeShowNativeAnswerSurface]
    /// decides to show this screen at all. Left alone, that same payload would
    /// still be sitting there when `PushService._init()` finally calls
    /// `getPending()` (it runs post-first-frame — see `PushService.ready`) and
    /// would push a SECOND ring surface (`_routeToBrandedIncoming` ->
    /// `IncomingBusinessCallScreen`) on top of whatever the accept/decline
    /// action above already opened or tore down. Clearing synchronously here,
    /// on the main thread, is always ahead of that later drain — the whole
    /// point of the native screen is that Flutter has not booted yet.
    private fun dropPendingIncomingTap(callId: String) {
        if (callId.isEmpty()) return
        if ((pendingIncomingTap?.get("callId") as? String) == callId) {
            pendingIncomingTap = null
        }
    }

    /// [CALL-NATIVE-ANSWER-1] Accept tapped on the native ring screen. This
    /// function does NOT accept the call — it is a surface only. It (1) gives
    /// instant visual feedback by swapping straight to the existing passive
    /// "Connecting…" overlay, (2) arms the EXISTING [CALL-ACCEPT-FRAME-1]
    /// accept→first-frame measurement so this counts the same way a
    /// notification-surface accept would, and (3) hands the tap to Dart via
    /// the same pending/getPending shape [forwardNotificationTapIfPresent]
    /// already uses, so PushService.acceptRingingCall runs exactly once no
    /// matter which surface the user tapped.
    private fun onNativeRingAccept() {
        // Single-shot guard: a rapid double-tap (or a tap landing during the
        // 150ms fade-out, when the buttons are still technically attached)
        // must fire this exactly once, matching how every other ring surface
        // in this app treats accept/decline as one-time intents.
        val payload = nativeRingPayload ?: return
        nativeRingPayload = null
        val payloadExpiry = (payload["expiresAtMs"] as? Number)?.toLong()
            ?: payload["expiresAtMs"]?.toString()?.toLongOrNull() ?: 0L
        if (payloadExpiry > 0L && payloadExpiry <= System.currentTimeMillis()) {
            removeNativeRingScreen()
            return
        }
        val callId = (payload["callId"] as? String).orEmpty()
        val cold = !flutterUiDisplayed
        val msFromScreenShown =
            (SystemClock.elapsedRealtime() - nativeRingShownAtElapsedMs).coerceAtLeast(0L)
        removeNativeRingScreen()
        dropPendingIncomingTap(callId)
        acceptTapAtElapsedMs = SystemClock.elapsedRealtime()
        showConnectingOverlay()

        val action = mapOf<String, Any?>(
            "action" to "accept",
            "callId" to callId,
            "from" to (payload["from"] ?: ""),
            "fromName" to (payload["fromName"] ?: ""),
            "kind" to (payload["kind"] ?: "audio"),
            "msFromScreenShown" to msFromScreenShown,
            "cold" to cold,
            "inviteNonce" to (payload["inviteNonce"] ?: ""),
            "generation" to (payload["generation"] ?: ""),
            "expiresAtMs" to (payload["expiresAtMs"] ?: 0L),
        )
        if (isCallNativeAnswerV1Enabled(this) && NativeCallPrewarmBridge.isEnabled(this)) {
            NativeCallPrewarmBridge.action(
                this, callId, (payload["inviteNonce"] as? String).orEmpty(),
                (payload["generation"] as? String).orEmpty(), "accept",
            )
        }
        recordNativeRingAction(action)
    }

    /// [CALL-NATIVE-ANSWER-1] Decline tapped on the native ring screen. Native
    /// deliberately does NOT replicate [NativeCallDeclineBridge]'s token-scoped
    /// WorkManager decline path here — that machinery exists for a DIFFERENT
    /// case (the process already died before flutter_callkit_incoming's own
    /// decline hook could reach Dart) and duplicating it would be a second,
    /// divergent way to tell the server "declined". Instead this removes the
    /// screen and hands off to Dart exactly like accept above; Dart's existing
    /// `PushService.declineIncomingCall` is the ONE decline path.
    private fun onNativeRingDecline() {
        val payload = nativeRingPayload ?: return
        nativeRingPayload = null
        val payloadExpiry = (payload["expiresAtMs"] as? Number)?.toLong()
            ?: payload["expiresAtMs"]?.toString()?.toLongOrNull() ?: 0L
        if (payloadExpiry > 0L && payloadExpiry <= System.currentTimeMillis()) {
            removeNativeRingScreen()
            return
        }
        val callId = (payload["callId"] as? String).orEmpty()
        removeNativeRingScreen()
        dropPendingIncomingTap(callId)

        val action = mapOf<String, Any?>(
            "action" to "decline",
            "callId" to callId,
            "from" to (payload["from"] ?: ""),
            "fromName" to (payload["fromName"] ?: ""),
            "kind" to (payload["kind"] ?: "audio"),
            "inviteNonce" to (payload["inviteNonce"] ?: ""),
            "generation" to (payload["generation"] ?: ""),
            "expiresAtMs" to (payload["expiresAtMs"] ?: 0L),
        )
        if (isCallNativeAnswerV1Enabled(this) && NativeCallPrewarmBridge.isEnabled(this)) {
            NativeCallPrewarmBridge.action(
                this, callId, (payload["inviteNonce"] as? String).orEmpty(),
                (payload["generation"] as? String).orEmpty(), "decline",
            )
        }
        recordNativeRingAction(action)
    }

    /// [CALL-NATIVE-ANSWER-2] Records a tapped Accept/Decline BOTH in the
    /// fast in-memory companion (today's path — survives as long as this
    /// process does) AND atomically on disk (survives the process dying
    /// between this tap and Dart's `getPendingRingAction` drain — the P1
    /// defect this issue fixes). Disk is the source of truth; memory is
    /// purely a fast path for the overwhelmingly common case where the
    /// process never dies in that window. `nonce` lets Dart de-duplicate a
    /// re-drain even though native's own drain ([drainPendingRingAction])
    /// already only delivers this once.
    private fun recordNativeRingAction(action: Map<String, Any?>) {
        val nonce = UUID.randomUUID().toString()
        val timestampMs = System.currentTimeMillis()
        val inviteExpiryMs = (action["expiresAtMs"] as? Number)?.toLong()
            ?: action["expiresAtMs"]?.toString()?.toLongOrNull()
            ?: 0L
        // Never extend an explicit invite expiry. A missing expiry gets the
        // bounded local action TTL; an already-expired invite is not persisted.
        val actionExpiresAtMs = when {
            inviteExpiryMs > timestampMs ->
                minOf(inviteExpiryMs, timestampMs + NATIVE_ANSWER_ACTION_TTL_MS)
            inviteExpiryMs == 0L -> timestampMs + NATIVE_ANSWER_ACTION_TTL_MS
            else -> return
        }
        val ttlMs = actionExpiresAtMs - timestampMs
        val fullAction = action + mapOf(
            "nonce" to nonce,
            "timestampMs" to timestampMs,
            "expiryMs" to ttlMs,
            "expiresAtMs" to actionExpiresAtMs,
        )
        pendingNativeRingAction = fullAction
        persistPendingRingAction(this, fullAction)
        incomingTapChannel?.invokeMethod("nativeRingAction", fullAction)
    }

    /// [CALL-NATIVE-ANSWER-2] Dart-initiated removal for a native ring
    /// screen that is still up because Flutter hasn't painted yet, but the
    /// call it represents has already reached a terminal state (e.g. the
    /// caller cancelled). The engine/channel are alive by construction —
    /// `configureFlutterEngine` (where `getPendingRingAction`/this method
    /// are wired) always runs before [maybeShowNativeAnswerSurface] can show
    /// this screen (see `onCreate`'s ordering) — so this is reachable any
    /// time the screen is up, not just after first frame.
    private fun clearNativeRingScreen(callId: String?) {
        val currentId = (nativeRingPayload?.get("callId") as? String)
        if (callId == null || callId == currentId) {
            // Best-effort terminal cleanup for a caller-cancel/remote-answer
            // signal. Identity is read from the durable state, so a late clear
            // for an older call cannot remove a newer invite.
            if (callId != null && NativeCallPrewarmBridge.isEnabled(this)) {
                val state = NativeCallPrewarmBridge.snapshot(this)
                val stateId = state["callId"] as? String
                if (stateId == callId) {
                    NativeCallPrewarmBridge.terminal(
                        this, callId, state["nonce"] as? String ?: "",
                        state["generation"] as? String ?: "", "remote_terminal",
                    )
                }
            }
            nativeRingPayload = null
            removeNativeRingScreen()
        }
    }

    /// [CALL-ACCEPT-FRAME-1] One-shot: computes the accept→first-frame span and
    /// forwards it to Dart. `cold=true` from onFlutterUiDisplayed (the overlay
    /// path — the engine genuinely had to boot); `cold=false` from onNewIntent
    /// when the engine/activity were already up (see below) so first-frame has
    /// already fired for this activity instance and never will again.
    private fun reportAcceptToFirstFrame(cold: Boolean) {
        val startedAt = acceptTapAtElapsedMs
        if (startedAt == 0L) return
        acceptTapAtElapsedMs = 0L
        val ms = (SystemClock.elapsedRealtime() - startedAt).coerceAtLeast(0L)
        ai.avatok.avavoiceaudio.AvaVoiceAudioPlugin.emitAcceptToFirstFrame(ms, cold)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // [CALL-ACCEPT-FRAME-1] FlutterFragmentActivity has no onFlutterUiDisplayed
        // override point of its own — unlike plain FlutterActivity, it does NOT
        // implement FlutterActivityAndFragmentDelegate.Host; it delegates entirely
        // to an internal FlutterFragment, which owns that callback. The engine's
        // FlutterRenderer is the lower-level, stable source of the same signal and
        // is reachable from here regardless of which Activity base class is in use.
        // `addIsDisplayingFlutterUiListener` also fires immediately if the engine
        // is (surprisingly) already displaying UI by the time this registers, so a
        // late registration can never miss the moment.
        flutterEngine.renderer.addIsDisplayingFlutterUiListener(
            object : io.flutter.embedding.engine.renderer.FlutterUiDisplayListener {
                override fun onFlutterUiDisplayed() {
                    flutterUiDisplayed = true
                    overlayFailsafe?.let { overlayHandler.removeCallbacks(it) }
                    overlayFailsafe = null
                    removeConnectingOverlay()
                    // [CALL-NATIVE-ANSWER-1] The Flutter branded ring screen (or
                    // CallScreen, if the user already tapped Accept natively) is
                    // now up — the native ring screen's job is done.
                    removeNativeRingScreen()
                    reportAcceptToFirstFrame(cold = true)
                }

                override fun onFlutterUiNoLongerDisplayed() {}
            }
        )
        // AvaVision live-session native bridge (camera + on-device vision).
        flutterEngine.plugins.add(ai.avatok.avavision.AvaVisionPlugin())
        // Full-duplex voice-call audio engine with platform echo cancellation
        // (Gemini Live "AI Voice Agent" — true barge-in on speaker).
        flutterEngine.plugins.add(ai.avatok.avavoiceaudio.AvaVoiceAudioPlugin())
        flutterEngine.plugins.add(ai.avatok.calltranslation.CallTranslationAudioPlugin())
        // [CALL-TRANSLATE-BIND-1 2026-08-05] Hand the call-translation bridge the
        // flutter_webrtc plugin belonging to THIS engine.
        //
        // The bridge taps decoded incoming audio by reflecting into
        // flutter_webrtc's `playbackSamplesReadyCallbackAdapter`, and it used to
        // reach that field through `FlutterWebRTCPlugin.sharedSingleton` — a
        // public static assigned in the plugin's CONSTRUCTOR, so the most
        // recently constructed instance always wins, whether or not it is the one
        // running the call. On 2026-08-04 the probe returned `adapter_field_null`
        // on both a real device and the emulator (build 10507), and the translate
        // control never appeared.
        //
        // `plugins.get()` returns the instance registered on the engine we are
        // configuring right now, which is the one whose Dart isolate places calls.
        // That is a fact about this engine rather than a global race, so prefer it
        // and keep the static only as a fallback.
        //
        // Must run AFTER super.configureFlutterEngine — GeneratedPluginRegistrant
        // is what registers flutter_webrtc, and before it runs this returns null.
        ai.avatok.calltranslation.CallTranslationAudioPlugin.boundWebRtcPlugin =
            flutterEngine.plugins.get(io.getstream.webrtc.flutter.FlutterWebRTCPlugin::class.java)
                as? io.getstream.webrtc.flutter.FlutterWebRTCPlugin
        // [CALLREC-NATIVE-1] On-demand call recording. Taps the SAME AudioDeviceModule
        // — the near-end mic adapter as well as the decoded-playback one — so it needs
        // the same engine-scoped binding, and for the same reason: `sharedSingleton` is
        // assigned in the plugin's constructor and points at whichever instance was
        // built last, not the one running the call. DARK behind the Flutter
        // `callRecordingEnabled` flag; the plugin only registers its channels until
        // Dart calls `start`.
        flutterEngine.plugins.add(ai.avatok.callrecord.CallRecorderPlugin())
        ai.avatok.callrecord.CallRecorderPlugin.boundWebRtcPlugin =
            flutterEngine.plugins.get(io.getstream.webrtc.flutter.FlutterWebRTCPlugin::class.java)
                as? io.getstream.webrtc.flutter.FlutterWebRTCPlugin
        // AvaDial PSTN telecom bridge (default-dialer role, InCallService,
        // CallScreeningService, device contacts/call-log). DARK behind the Flutter
        // `avaDialer` flag — the plugin only ever registers a MethodChannel; nothing
        // fires until Dart requests a role. See
        // Specs/SPIKE-2026-07-12-avadial-telecom.md.
        flutterEngine.plugins.add(ai.avatok.avadial.AvaDialPlugin())

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, processExitChannelName)
            .setMethodCallHandler { call, result ->
                if (call.method != "consumePreviousExits") {
                    result.notImplemented()
                    return@setMethodCallHandler
                }
                if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R) {
                    result.success(emptyList<Map<String, Any?>>())
                    return@setMethodCallHandler
                }
                try {
                    val prefs = getSharedPreferences("avatok_process_exit", MODE_PRIVATE)
                    val lastReported = prefs.getLong("last_reported_timestamp", 0L)
                    val manager = getSystemService(ACTIVITY_SERVICE) as ActivityManager
                    val exits = manager.getHistoricalProcessExitReasons(packageName, 0, 8)
                        .filter { it.timestamp > lastReported }
                        .sortedBy { it.timestamp }
                    val payload = exits.map { info ->
                        mapOf<String, Any?>(
                            "reason" to processExitReasonName(info.reason),
                            "reason_code" to info.reason,
                            "status" to info.status,
                            "importance" to info.importance,
                            "pss_kb" to info.pss,
                            "rss_kb" to info.rss,
                            "timestamp_ms" to info.timestamp,
                            "description" to (info.description ?: ""),
                            "trace_available" to runCatching {
                                info.traceInputStream?.use { true } ?: false
                            }.getOrDefault(false),
                        )
                    }
                    exits.maxOfOrNull { it.timestamp }?.let {
                        prefs.edit().putLong("last_reported_timestamp", it).apply()
                    }
                    result.success(payload)
                } catch (error: Throwable) {
                    result.error("process_exit_read_failed", error.javaClass.simpleName, null)
                }
            }

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, secureChannel)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "protect" -> {
                        runOnUiThread { window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) }
                        result.success(true)
                    }
                    "unprotect" -> {
                        runOnUiThread { window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
                        result.success(true)
                    }
                    else -> result.notImplemented()
                }
            }

        incomingTapChannel = MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger, incomingTapChannelName
        ).also { channel ->
            channel.setMethodCallHandler { call, result ->
                when (call.method) {
                    "getPending" -> {
                        val pending = pendingIncomingTap
                        pendingIncomingTap = null
                        result.success(pending)
                    }
                    // [CALL-STALE-TAP-1 2026-08-03] Let Dart drop a pending tap
                    // once the call it refers to is over.
                    //
                    // `pendingIncomingTap` was only ever cleared by a successful
                    // drain. A tap that arrived while the engine was starting, or
                    // one belonging to a call that ended before Dart reached it,
                    // stayed in this companion object for the life of the process
                    // — and was then drained on a LATER launch, routing the user
                    // into a ring surface for a call that finished long ago.
                    // AvaDialPlugin already solved exactly this with
                    // clearPendingIncoming(); the P2P side had no equivalent.
                    "clearPending" -> {
                        val callId = call.argument<String>("callId")
                        val pendingId = pendingIncomingTap?.get("callId") as? String
                        // Clear unconditionally when no id is given, otherwise only
                        // on a match — a newer ring must not be erased by a late
                        // clear belonging to an older one.
                        if (callId == null || callId == pendingId) {
                            pendingIncomingTap = null
                        }
                        // [CALL-NATIVE-ANSWER-1/2] Same staleness hazard applies to
                        // a native ring-screen tap that hasn't been drained yet —
                        // both the fast in-memory copy AND its disk mirror.
                        val pendingActionId = pendingNativeRingAction?.get("callId") as? String
                        if (callId == null || callId == pendingActionId) {
                            pendingNativeRingAction = null
                        }
                        clearPersistedRingActionIfMatches(this@MainActivity, callId)
                        result.success(null)
                    }
                    // [CALL-NATIVE-ANSWER-1/2] Cold-start drain counterpart to
                    // "getPending" above, for a native ring-screen Accept/Decline
                    // tap that beat this handler being installed. Routes through
                    // [drainPendingRingAction], which is IDEMPOTENT (memory
                    // cleared + disk file deleted in one call — a replayed drain
                    // returns null) and DISK-BACKED (survives the process dying
                    // between the tap and this call, recovering via
                    // `restoredFromDisk`/`ageMs`/`expired` in the returned map).
                    "getPendingRingAction" -> {
                        result.success(drainPendingRingAction(this@MainActivity))
                    }
                    // [CALL-NATIVE-ANSWER-2] Dart learned the call reached a
                    // terminal state (e.g. caller cancelled) while the native
                    // ring screen was still up waiting for Flutter to paint —
                    // tear it down now rather than waiting on the 45s failsafe.
                    "clearNativeRingScreen" -> {
                        clearNativeRingScreen(call.argument<String>("callId"))
                        result.success(null)
                    }
                    // [CALL-NATIVE-ANSWER-1] RemoteConfig.refresh() mirrors the
                    // resolved `callNativeAnswerV1` flag here on every fetch —
                    // native cannot read RemoteConfig directly (no engine on a
                    // cold notification tap). Fail-closed default lives in
                    // isCallNativeAnswerV1Enabled(), not here.
                    "setCallNativeAnswerV1" -> {
                        writeNativeAnswerFlag(this@MainActivity, call.argument<Boolean>("enabled") == true)
                        result.success(true)
                    }
                    // [CALL-PREWARM-NATIVE-1] Native state/ordering bridge.
                    // All transport work remains in Dart; these calls only make
                    // the invite identity and terminal edges durable across a
                    // killed Flutter isolate. Missing flag = disabled.
                    "setCallPrewarmNativeV1" -> {
                        NativeCallPrewarmBridge.setEnabled(this@MainActivity, call.argument<Boolean>("enabled") == true)
                        result.success(true)
                    }
                    "prewarmStart" -> result.success(NativeCallPrewarmBridge.start(
                        this@MainActivity, call.argument<Any?>("callId")?.toString().orEmpty(),
                        call.argument<Any?>("nonce")?.toString().orEmpty(), call.argument<Any?>("generation")?.toString().orEmpty(),
                        call.argument<Any?>("expiresAtMs")?.toString()?.toLongOrNull() ?: 0L,
                    ))
                    "prewarmReady" -> result.success(NativeCallPrewarmBridge.ready(
                        this@MainActivity, call.argument<Any?>("callId")?.toString().orEmpty(),
                        call.argument<Any?>("nonce")?.toString().orEmpty(), call.argument<Any?>("generation")?.toString().orEmpty(),
                    ))
                    "prewarmFailed" -> result.success(NativeCallPrewarmBridge.failed(
                        this@MainActivity, call.argument<Any?>("callId")?.toString().orEmpty(),
                        call.argument<Any?>("nonce")?.toString().orEmpty(), call.argument<Any?>("generation")?.toString().orEmpty(),
                        call.argument<Any?>("reason")?.toString().orEmpty(),
                    ))
                    "prewarmRinging" -> result.success(NativeCallPrewarmBridge.ringing(
                        this@MainActivity, call.argument<Any?>("callId")?.toString().orEmpty(),
                        call.argument<Any?>("nonce")?.toString().orEmpty(), call.argument<Any?>("generation")?.toString().orEmpty(),
                        call.argument<Any?>("serverSequence")?.toString()?.toLongOrNull() ?: 0L,
                        call.argument<Any?>("expiresAtMs")?.toString()?.toLongOrNull() ?: 0L,
                    ))
                    "prewarmAction" -> result.success(NativeCallPrewarmBridge.action(
                        this@MainActivity, call.argument<Any?>("callId")?.toString().orEmpty(),
                        call.argument<Any?>("nonce")?.toString().orEmpty(), call.argument<Any?>("generation")?.toString().orEmpty(),
                        call.argument<Any?>("action")?.toString().orEmpty(), call.argument<Any?>("winnerDeviceId")?.toString().orEmpty(),
                    ))
                    "prewarmTerminal" -> result.success(NativeCallPrewarmBridge.terminal(
                        this@MainActivity, call.argument<Any?>("callId")?.toString().orEmpty(),
                        call.argument<Any?>("nonce")?.toString().orEmpty(), call.argument<Any?>("generation")?.toString().orEmpty(),
                        call.argument<Any?>("reason")?.toString().orEmpty(), call.argument<Any?>("winnerDeviceId")?.toString().orEmpty(),
                    ))
                    "prewarmCancel" -> result.success(NativeCallPrewarmBridge.cancel(
                        this@MainActivity, call.argument<Any?>("callId")?.toString().orEmpty(),
                        call.argument<Any?>("nonce")?.toString(), call.argument<Any?>("generation")?.toString(),
                    ))
                    "prewarmState" -> result.success(NativeCallPrewarmBridge.snapshot(this@MainActivity))
                    else -> result.notImplemented()
                }
            }
        }

        // CALL-BG-B3: if we were launched/foregrounded by the ongoing-call
        // notification tap, the engine is now attached (AvaVoiceAudioPlugin is
        // registered) — forward the pending intent's callId to Dart now. Handles the
        // "cold start from notification tap" case; onNewIntent (below) handles the
        // "app already running" case.
        forwardNotificationTapIfPresent(intent)
    }

    private fun processExitReasonName(reason: Int): String = when (reason) {
        ApplicationExitInfo.REASON_ANR -> "anr"
        ApplicationExitInfo.REASON_CRASH -> "java_crash"
        ApplicationExitInfo.REASON_CRASH_NATIVE -> "native_crash"
        ApplicationExitInfo.REASON_LOW_MEMORY -> "low_memory"
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "excessive_resource_usage"
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "initialization_failure"
        ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "permission_change"
        ApplicationExitInfo.REASON_SIGNALED -> "signaled"
        ApplicationExitInfo.REASON_USER_REQUESTED -> "user_requested"
        ApplicationExitInfo.REASON_USER_STOPPED -> "user_stopped"
        ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "dependency_died"
        ApplicationExitInfo.REASON_OTHER -> "other"
        ApplicationExitInfo.REASON_UNKNOWN -> "unknown"
        else -> "reason_$reason"
    }

    override fun onNewIntent(intent: Intent) {
        // [CALL-ACCEPT-FRAME-1] A native Accept can also redeliver here — the
        // engine/activity were already running (singleTop) when the user
        // accepted. If Flutter's first frame already happened in THIS activity
        // instance, onFlutterUiDisplayed will never fire again, so report
        // "warm" (cold=false) right away instead of waiting for a callback that
        // isn't coming. Otherwise (activity exists but hasn't painted yet — a
        // narrow window) fall back to the same overlay + onFlutterUiDisplayed
        // path onCreate uses.
        val launchedAtElapsedMs = SystemClock.elapsedRealtime()
        forwardStreamNotificationIntent(intent)
        if (isNativeAcceptLaunch(intent)) {
            acceptTapAtElapsedMs = launchedAtElapsedMs
            if (flutterUiDisplayed) {
                reportAcceptToFirstFrame(cold = false)
            } else {
                maybeShowNativeAnswerSurface(intent, launchedAtElapsedMs)
            }
        }
        super.onNewIntent(intent)
        // CALL-BG-B3: app already running (singleTop) — a fresh tap on the ongoing-call
        // notification delivers here instead of onCreate. Forward immediately since the
        // Flutter engine/plugin is already attached.
        setIntent(intent)
        forwardNotificationTapIfPresent(intent)
    }

    /// CALL-BG-B3: MainActivity is launched with extras {callId, from:"call_notification"}
    /// by CallForegroundService's content PendingIntent when the user taps the
    /// ongoing-call notification. Forward callId to Dart via
    /// AvaVoiceAudioPlugin.notifyNotificationTap so CallSession/CallScreen can route
    /// back to the active call instead of landing on the last-open route.
    private fun forwardNotificationTapIfPresent(intent: Intent?) {
        // [CALL-REL-R4-3] parseIncomingTapExtra carries the CallRoom join
        // credential (roomToken) through the cold-start tap too — a killed app
        // accepting from the lock screen has no Dart heap and may have no
        // completed secure-storage write either, so this notification bundle is
        // the one thing guaranteed to have survived.
        val payload = parseIncomingTapExtra(intent)
        if (payload != null) {
            pendingIncomingTap = payload
            incomingTapChannel?.invokeMethod("incomingCallTapped", payload)
        }
        val from = intent?.getStringExtra("from")
        val callId = intent?.getStringExtra("callId")
        if (from == "call_notification" && !callId.isNullOrEmpty()) {
            ai.avatok.avavoiceaudio.AvaVoiceAudioPlugin.notifyNotificationTap(callId)
        }

        // AvaDial full-screen incoming-call launch (AvaInCallService sets
        // route="avadial/incoming" + call_id/number on the PendingIntent). Forward
        // to the AvaDial plugin so the Flutter shell opens PstnCallScreen — handles
        // both cold start (drained via getPendingIncoming) and the app-already-running
        // case (onLaunchIncoming event). DARK unless the dialer role fired this.
        if (intent?.getStringExtra("route") == "avadial/incoming") {
            // [AVADIAL-HARDEN-2] "answered" (set by AvaCallActionReceiver's "answer"
            // notification action) tells Dart the call is already answered/active by
            // the time it boots, so the shell opens InCallScreen instead of the
            // (stuck) ringing PstnCallScreen.
            // [AVADIAL-HARDEN-3] spam_score/spam_bucket ride the same cold-start intent
            // extras (set by AvaInCallService.launchIncoming) so PstnCallScreen can
            // paint red even when Dart wasn't alive to receive onCallAdded.
            val hasSpamScore = intent.hasExtra("spam_score")
            ai.avatok.avadial.AvaDialPlugin.notifyIncomingLaunch(
                intent.getStringExtra("call_id"),
                intent.getStringExtra("number"),
                intent.getBooleanExtra("answered", false),
                if (hasSpamScore) intent.getIntExtra("spam_score", 0) else null,
                intent.getStringExtra("spam_bucket"),
            )
        }

        // AvaDial SMS compose launch. Two entry points, both DARK behind `avaSms`:
        //   1. The SMS notification tap sets route="avadial/compose" + number.
        //   2. An ACTION_SENDTO on sms:/smsto:/mms:/mmsto: (SmsComposeAlias) — parse
        //      the recipient from the intent data URI (scheme-specific part before '?').
        // [PLAY-SCOPE-1 2026-08-05] The "avadial/openDial" route is REMOVED — it only
        // ever fired from the missed-call overlay's "View profile" button, and that
        // overlay is gone.

        if (intent?.getStringExtra("route") == "avadial/compose") {
            ai.avatok.avadial.AvaDialPlugin.notifyComposeLaunch(intent.getStringExtra("number"))
        } else if (intent?.action == Intent.ACTION_SENDTO) {
            val scheme = intent.data?.scheme
            if (scheme == "sms" || scheme == "smsto" || scheme == "mms" || scheme == "mmsto") {
                val number = intent.data?.schemeSpecificPart?.substringBefore('?')?.trim()
                ai.avatok.avadial.AvaDialPlugin.notifyComposeLaunch(number)
            }
        }
    }
}

package ai.avatok.avatok_call

import android.content.Intent
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
import org.json.JSONObject

// FlutterFragmentActivity (not FlutterActivity) is REQUIRED by flutter_stripe so
// the native PaymentSheet can attach its own fragments to the host activity.
class MainActivity : FlutterFragmentActivity() {
    // Lets Dart toggle the OS secure-screen flag while sensitive content (e.g. a
    // profile-photo viewer) is on screen — blocks screenshots + screen recording
    // and hides the window in the app switcher.
    private val secureChannel = "avatok/secure_screen"
    private val incomingTapChannelName = "avatok/incoming_call_tap"
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
            intent?.action == INCOMING_TAP_ACTION

    /// [CALL-ACCEPT-FRAME-2] The action this repo's own CallKit patch uses for
    /// FSI / notification-body taps. Kept as one constant because the string is
    /// asserted in three places (here, the route handler below, and
    /// scripts/patch_callkit_native_decline.py's generated intent).
    private val INCOMING_TAP_ACTION = "avatok.incoming_call_tap"

    override fun onCreate(savedInstanceState: Bundle?) {
        // [CALL-ACCEPT-FRAME-1] Capture t0 before super.onCreate() inflates
        // anything, so the span includes engine attach + first frame, not just
        // whatever we do here. A fresh instance is always "cold" — a warm accept
        // (engine/activity already up) can only ever reach onNewIntent below,
        // never a fresh onCreate.
        val launchedAtElapsedMs = SystemClock.elapsedRealtime()
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

        val callId = (payload["callId"] as? String).orEmpty()
        val msFromIntent = (SystemClock.elapsedRealtime() - nativeRingShownAtElapsedMs).coerceAtLeast(0L)
        ai.avatok.avavoiceaudio.AvaVoiceAudioPlugin.emitNativeRingShown(callId, msFromIntent)

        // Same failsafe bound as the passive overlay — a wedged/crashed engine
        // must never trap the user behind an unresponsive screen, interactive
        // or not.
        val failsafe = Runnable { removeNativeRingScreen() }
        nativeRingFailsafe = failsafe
        overlayHandler.postDelayed(failsafe, 6000L)
    }

    /// [CALL-NATIVE-ANSWER-1] 150ms fade-out, then detach. No-op if already
    /// removed. Called on: Accept/Decline tap (immediately, after swapping to
    /// the passive overlay or handing off to Dart), Flutter's first frame
    /// (onFlutterUiDisplayed — the branded screen is up), and the 6s failsafe.
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
        )
        pendingNativeRingAction = action
        incomingTapChannel?.invokeMethod("nativeRingAction", action)
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
        val callId = (payload["callId"] as? String).orEmpty()
        removeNativeRingScreen()
        dropPendingIncomingTap(callId)

        val action = mapOf<String, Any?>(
            "action" to "decline",
            "callId" to callId,
            "from" to (payload["from"] ?: ""),
            "fromName" to (payload["fromName"] ?: ""),
            "kind" to (payload["kind"] ?: "audio"),
        )
        pendingNativeRingAction = action
        incomingTapChannel?.invokeMethod("nativeRingAction", action)
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
            flutterEngine.plugins.get(com.cloudwebrtc.webrtc.FlutterWebRTCPlugin::class.java)
                as? com.cloudwebrtc.webrtc.FlutterWebRTCPlugin
        // [CALLREC-NATIVE-1] On-demand call recording. Taps the SAME AudioDeviceModule
        // — the near-end mic adapter as well as the decoded-playback one — so it needs
        // the same engine-scoped binding, and for the same reason: `sharedSingleton` is
        // assigned in the plugin's constructor and points at whichever instance was
        // built last, not the one running the call. DARK behind the Flutter
        // `callRecordingEnabled` flag; the plugin only registers its channels until
        // Dart calls `start`.
        flutterEngine.plugins.add(ai.avatok.callrecord.CallRecorderPlugin())
        ai.avatok.callrecord.CallRecorderPlugin.boundWebRtcPlugin =
            flutterEngine.plugins.get(com.cloudwebrtc.webrtc.FlutterWebRTCPlugin::class.java)
                as? com.cloudwebrtc.webrtc.FlutterWebRTCPlugin
        // AvaDial PSTN telecom bridge (default-dialer role, InCallService,
        // CallScreeningService, device contacts/call-log). DARK behind the Flutter
        // `avaDialer` flag — the plugin only ever registers a MethodChannel; nothing
        // fires until Dart requests a role. See
        // Specs/SPIKE-2026-07-12-avadial-telecom.md.
        flutterEngine.plugins.add(ai.avatok.avadial.AvaDialPlugin())

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
                        // [CALL-NATIVE-ANSWER-1] Same staleness hazard applies to a
                        // native ring-screen tap that hasn't been drained yet.
                        val pendingActionId = pendingNativeRingAction?.get("callId") as? String
                        if (callId == null || callId == pendingActionId) {
                            pendingNativeRingAction = null
                        }
                        result.success(null)
                    }
                    // [CALL-NATIVE-ANSWER-1] Cold-start drain counterpart to
                    // "getPending" above, for a native ring-screen Accept/Decline
                    // tap that beat this handler being installed.
                    "getPendingRingAction" -> {
                        val pending = pendingNativeRingAction
                        pendingNativeRingAction = null
                        result.success(pending)
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

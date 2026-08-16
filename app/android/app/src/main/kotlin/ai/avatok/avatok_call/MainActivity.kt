package ai.avatok.avatok_call

import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
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
    private fun isNativeAcceptLaunch(intent: Intent?): Boolean =
        intent?.action == CallkitConstants.ACTION_CALL_ACCEPT

    override fun onCreate(savedInstanceState: Bundle?) {
        // [CALL-ACCEPT-FRAME-1] Capture t0 before super.onCreate() inflates
        // anything, so the span includes engine attach + first frame, not just
        // whatever we do here. A fresh instance is always "cold" — a warm accept
        // (engine/activity already up) can only ever reach onNewIntent below,
        // never a fresh onCreate.
        if (isNativeAcceptLaunch(intent)) {
            acceptTapAtElapsedMs = SystemClock.elapsedRealtime()
        }
        super.onCreate(savedInstanceState)
        // Added AFTER super.onCreate() so the FlutterFragment's view (added by
        // the fragment transaction super.onCreate() commits) is already a child
        // of android.R.id.content — our overlay is added last, i.e. on top.
        if (acceptTapAtElapsedMs != 0L && !flutterUiDisplayed) {
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
                        result.success(null)
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
        if (isNativeAcceptLaunch(intent)) {
            acceptTapAtElapsedMs = SystemClock.elapsedRealtime()
            if (flutterUiDisplayed) {
                reportAcceptToFirstFrame(cold = false)
            } else {
                showConnectingOverlay()
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
        if (intent?.action == "avatok.incoming_call_tap") {
            @Suppress("DEPRECATION", "UNCHECKED_CAST")
            val data = intent.getBundleExtra(FlutterCallkitIncomingPlugin.EXTRA_CALLKIT_CALL_DATA)
            val extra = data?.getSerializable(CallkitConstants.EXTRA_CALLKIT_EXTRA)
                    as? Map<String, Any?> ?: emptyMap()
            val payload = mapOf<String, Any?>(
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
                // [CALL-REL-R4-3] Carry the CallRoom join credential through the
                // cold-start tap. A killed app accepting from the lock screen has
                // no Dart heap and may have no completed secure-storage write
                // either; this notification bundle is the one thing guaranteed to
                // have survived, so it is the recovery path for the token the
                // signalling socket needs. Short-lived and call-scoped.
                "roomToken" to (extra["roomToken"] ?: ""),
            )
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

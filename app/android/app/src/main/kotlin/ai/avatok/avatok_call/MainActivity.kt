package ai.avatok.avatok_call

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
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

    companion object {
        private var pendingIncomingTap: Map<String, Any?>? = null
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
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
        // [AVA-MISSEDCALL-1] "Open in AvaTOK" from the missed-call overlay (View profile /
        // AvaTOK action). Route extra "avadial/openDial" + number/avatok_number → forward
        // so the shell opens the caller's contact / dialer. DARK unless the overlay fired it.
        if (intent?.getStringExtra("route") == "avadial/openDial") {
            ai.avatok.avadial.AvaDialPlugin.notifyOpenDial(
                intent.getStringExtra("number"),
                intent.getStringExtra("avatok_number"),
            )
        }

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

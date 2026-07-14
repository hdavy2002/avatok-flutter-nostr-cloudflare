package ai.avatok.avatok_call

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
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

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // AvaVision live-session native bridge (camera + on-device vision).
        flutterEngine.plugins.add(ai.avatok.avavision.AvaVisionPlugin())
        // Full-duplex voice-call audio engine with platform echo cancellation
        // (Gemini Live "AI Voice Agent" — true barge-in on speaker).
        flutterEngine.plugins.add(ai.avatok.avavoiceaudio.AvaVoiceAudioPlugin())
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
            ai.avatok.avadial.AvaDialPlugin.notifyIncomingLaunch(
                intent.getStringExtra("call_id"),
                intent.getStringExtra("number"),
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

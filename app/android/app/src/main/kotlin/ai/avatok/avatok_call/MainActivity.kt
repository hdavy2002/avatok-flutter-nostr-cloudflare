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
    }
}

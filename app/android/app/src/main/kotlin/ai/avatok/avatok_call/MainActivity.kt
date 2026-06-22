package ai.avatok.avatok_call

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
    }
}

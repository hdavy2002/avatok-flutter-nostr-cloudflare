package ai.avatok.avatok_call

import io.flutter.app.FlutterApplication

/** Restores the optional Stream client before a killed-app FCM ring arrives. */
class AvaTokApplication : FlutterApplication() {
    override fun onCreate() {
        super.onCreate()
        // Reflection keeps normal Cloudflare builds free of Stream SDK types.
        runCatching {
            val bridge = Class.forName("ai.avatok.streamcall.StreamCallBridgePlugin")
            bridge.getMethod("bootstrap", android.content.Context::class.java)
                .invoke(null, this)
        }
    }
}

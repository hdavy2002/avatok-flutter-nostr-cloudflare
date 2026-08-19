package ai.avatok.streamcall

import android.content.Context
import android.content.Intent
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * Fail-closed implementation packaged in every normal Cloudflare build.
 *
 * Automatic plugin registration makes the channels exist in both the main
 * Flutter engine and Firebase Messaging's headless engine, while this stub
 * guarantees that a stale server/config can never silently start Stream.
 */
class StreamCallBridgePlugin : FlutterPlugin,
    MethodChannel.MethodCallHandler,
    EventChannel.StreamHandler {
    private var methods: MethodChannel? = null
    private var events: EventChannel? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methods = MethodChannel(binding.binaryMessenger, "avatok/stream_call").also {
            it.setMethodCallHandler(this)
        }
        events = EventChannel(binding.binaryMessenger, "avatok/stream_call/events").also {
            it.setStreamHandler(this)
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methods?.setMethodCallHandler(null)
        events?.setStreamHandler(null)
        methods = null
        events = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        if (call.method == "disconnect") {
            result.success(null)
            return
        }
        result.error(
            "stream_sdk_not_compiled",
            "This build intentionally contains the Cloudflare call engine only.",
            null,
        )
    }

    override fun onListen(arguments: Any?, sink: EventChannel.EventSink?) = Unit
    override fun onCancel(arguments: Any?) = Unit

    companion object {
        /** Called reflectively by AvaTokApplication in every build. */
        @JvmStatic fun bootstrap(context: Context) = Unit
        /** Normal Cloudflare builds deliberately ignore Stream actions. */
        @JvmStatic fun handleIntent(context: Context, intent: Intent?): Boolean = false
    }
}

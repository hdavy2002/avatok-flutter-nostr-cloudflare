package ai.avatok.avavision

import android.content.Context
import android.view.View
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.StandardMessageCodec
import io.flutter.plugin.platform.PlatformView
import io.flutter.plugin.platform.PlatformViewFactory

/**
 * AvaVision native bridge — STUBBED 2026-06-22.
 *
 * The on-device vision engine (CameraX + MediaPipe Tasks-Vision + TFLite, plus
 * the MoveNet/MediaPipe analyzers and the CameraX PlatformView) was removed to
 * cut ~30–50 MB of native libs from the launch APK. Live vision is a post-launch
 * feature, and the on-device models were never bundled (download-on-demand), so
 * the engine was already inactive at runtime.
 *
 * This stub keeps the SAME channel + PlatformView names registered so
 * MainActivity (`flutterEngine.plugins.add(AvaVisionPlugin())`) and the Dart
 * session UI bind without error and degrade gracefully: a blank preview view, no
 * inference, no events. Restore the full implementation (git history pre-2026-06-22)
 * together with the gradle deps in app/build.gradle.kts when vision ships.
 */
class AvaVisionPlugin : FlutterPlugin, MethodChannel.MethodCallHandler,
    EventChannel.StreamHandler {

    companion object {
        const val METHOD_CHANNEL = "avatok/avavision_vision"
        const val EVENT_CHANNEL = "avatok/avavision_vision/events"
        const val VIEW_TYPE = "avatok/avavision_camera"
    }

    private var methodChannel: MethodChannel? = null
    private var eventChannel: EventChannel? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methodChannel = MethodChannel(binding.binaryMessenger, METHOD_CHANNEL).also {
            it.setMethodCallHandler(this)
        }
        eventChannel = EventChannel(binding.binaryMessenger, EVENT_CHANNEL).also {
            it.setStreamHandler(this)
        }
        // Register an empty PlatformView so any Dart `AndroidView` of this type
        // gets a valid (blank) surface instead of crashing.
        binding.platformViewRegistry.registerViewFactory(
            VIEW_TYPE,
            object : PlatformViewFactory(StandardMessageCodec.INSTANCE) {
                override fun create(ctx: Context, id: Int, args: Any?): PlatformView =
                    object : PlatformView {
                        private val v = View(ctx)
                        override fun getView(): View = v
                        override fun dispose() {}
                    }
            }
        )
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methodChannel?.setMethodCallHandler(null)
        eventChannel?.setStreamHandler(null)
        methodChannel = null
        eventChannel = null
    }

    // Vision engine not bundled in this build → answer calls without crashing.
    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "flip" -> result.success("front")
            "snapshot" -> result.success(null)
            "start", "stop", "setInference" -> result.success(null)
            else -> result.notImplemented()
        }
    }

    // No frames/landmarks are ever emitted in the stubbed build.
    override fun onListen(arguments: Any?, sink: EventChannel.EventSink?) { /* no-op */ }
    override fun onCancel(arguments: Any?) { /* no-op */ }
}

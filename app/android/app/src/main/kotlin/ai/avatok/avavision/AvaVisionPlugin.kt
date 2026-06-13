package ai.avatok.avavision

import android.content.Context
import androidx.lifecycle.LifecycleOwner
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.StandardMessageCodec

/**
 * AvaVision native bridge (Android).
 *
 * Interop choice (see Specs/avavision-build/glue/PHASE-3-GLUE.md): the camera and
 * the on-device model run ENTIRELY native behind a PlatformView, mirroring how
 * AvaLive runs WebRTC natively. Only normalized landmarks/boxes/mask + score
 * inputs (~30fps), a downscaled LOW-res JPEG (~1fps, for Gemini Live), and an
 * on-demand hi-res JPEG (the "Analyze my form" snapshot) cross the channel.
 *
 * Channels:
 *   MethodChannel  avatok/avavision_vision         — start/stop/flip/setInference/snapshot
 *   EventChannel   avatok/avavision_vision/events   — { type:"frame"|"live", ... }
 *   PlatformView   avatok/avavision_camera          — the CameraX preview surface
 *
 * REGISTRATION (Phase Z, glue note): this is an app-embedded plugin, so add it
 * to the engine in MainActivity.configureFlutterEngine:
 *     flutterEngine.plugins.add(ai.avatok.avavision.AvaVisionPlugin())
 */
class AvaVisionPlugin : FlutterPlugin, ActivityAware, MethodChannel.MethodCallHandler,
    EventChannel.StreamHandler {

    companion object {
        const val METHOD_CHANNEL = "avatok/avavision_vision"
        const val EVENT_CHANNEL = "avatok/avavision_vision/events"
        const val VIEW_TYPE = "avatok/avavision_camera"
    }

    private var appContext: Context? = null
    private var methodChannel: MethodChannel? = null
    private var eventChannel: EventChannel? = null
    private var eventSink: EventChannel.EventSink? = null
    private var lifecycleOwner: LifecycleOwner? = null

    /** The currently-attached camera view (one live session at a time). */
    private var cameraView: VisionCameraView? = null

    // ── FlutterPlugin ──────────────────────────────────────────────────────────
    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        appContext = binding.applicationContext
        methodChannel = MethodChannel(binding.binaryMessenger, METHOD_CHANNEL).also {
            it.setMethodCallHandler(this)
        }
        eventChannel = EventChannel(binding.binaryMessenger, EVENT_CHANNEL).also {
            it.setStreamHandler(this)
        }
        binding.platformViewRegistry.registerViewFactory(
            VIEW_TYPE,
            object : io.flutter.plugin.platform.PlatformViewFactory(StandardMessageCodec.INSTANCE) {
                override fun create(ctx: Context, id: Int, args: Any?): io.flutter.plugin.platform.PlatformView {
                    @Suppress("UNCHECKED_CAST")
                    val params = (args as? Map<String, Any?>) ?: emptyMap()
                    val view = VisionCameraView(ctx, lifecycleOwner) { event -> emit(event) }
                    view.configureFromParams(params)
                    cameraView = view
                    return view
                }
            }
        )
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methodChannel?.setMethodCallHandler(null)
        eventChannel?.setStreamHandler(null)
        cameraView?.dispose()
        cameraView = null
        appContext = null
    }

    // ── ActivityAware (we need a LifecycleOwner for CameraX) ─────────────────────
    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        lifecycleOwner = binding.activity as? LifecycleOwner
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        lifecycleOwner = binding.activity as? LifecycleOwner
    }

    override fun onDetachedFromActivityForConfigChanges() { lifecycleOwner = null }
    override fun onDetachedFromActivity() { lifecycleOwner = null }

    // ── MethodChannel ────────────────────────────────────────────────────────────
    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val view = cameraView
        when (call.method) {
            "start" -> {
                // The PlatformView starts the camera on creation; "start" (re)starts
                // the model with the requested capability/engine/overlay.
                @Suppress("UNCHECKED_CAST")
                val params = (call.arguments as? Map<String, Any?>) ?: emptyMap()
                view?.start(params)
                result.success(null)
            }
            "stop" -> { view?.stop(); result.success(null) }
            "setInference" -> {
                view?.setInference(call.argument<Boolean>("on") ?: true); result.success(null)
            }
            "flip" -> result.success(view?.flip() ?: "front")
            "snapshot" -> {
                if (view == null) { result.success(null); return }
                view.captureSnapshot { jpeg -> result.success(jpeg) }
            }
            else -> result.notImplemented()
        }
    }

    // ── EventChannel ──────────────────────────────────────────────────────────────
    override fun onListen(arguments: Any?, sink: EventChannel.EventSink?) { eventSink = sink }
    override fun onCancel(arguments: Any?) { eventSink = null }

    private fun emit(event: Map<String, Any?>) {
        // Always marshal back onto the platform thread before touching the sink.
        eventSink?.let { sink ->
            android.os.Handler(android.os.Looper.getMainLooper()).post { sink.success(event) }
        }
    }
}

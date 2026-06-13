package ai.avatok.avavision

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import android.view.View
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import io.flutter.plugin.platform.PlatformView
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The native camera surface + on-device model runner. CameraX feeds frames to an
 * ImageAnalysis use-case; the active [VisionAnalyzer] turns each frame into a
 * normalized [VisionResult] that is emitted on the EventChannel at ~30fps. A
 * separate ~1fps timer emits a downscaled LOW-res JPEG for the Gemini Live video
 * channel, and `captureSnapshot` grabs one hi-res JPEG on demand.
 */
@SuppressLint("ViewConstructor")
class VisionCameraView(
    private val context: Context,
    private val lifecycleOwner: LifecycleOwner?,
    private val emit: (Map<String, Any?>) -> Unit,
) : PlatformView {

    private val previewView = PreviewView(context).apply {
        scaleType = PreviewView.ScaleType.FILL_CENTER
        implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    }

    private val analysisExecutor = Executors.newSingleThreadExecutor()
    private var cameraProvider: ProcessCameraProvider? = null
    private var analyzer: VisionAnalyzer? = null
    private var capability = "pose"
    private var engine = "movenet"
    private var lensFacing = CameraSelector.LENS_FACING_FRONT
    private val inferenceOn = AtomicBoolean(true)

    // 1fps LOW-res Live throttle + latest frame for snapshots.
    @Volatile private var lastLiveMs = 0L
    @Volatile private var latestBitmap: Bitmap? = null
    private val liveIntervalMs = 1000L
    private val liveMaxDim = 384 // LOW res for Gemini Live

    init {
        configureProvider()
    }

    fun configureFromParams(params: Map<String, Any?>) {
        capability = params["capability"] as? String ?: capability
        engine = params["engine"] as? String ?: engine
        (params["lens_facing"] as? String)?.let {
            lensFacing = if (it == "back") CameraSelector.LENS_FACING_BACK else CameraSelector.LENS_FACING_FRONT
        }
    }

    private fun configureProvider() {
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            cameraProvider = future.get()
            bindUseCases()
        }, ContextCompat.getMainExecutor(context))
    }

    /** (Re)start the model for the given capability/engine and (re)bind camera. */
    fun start(params: Map<String, Any?>) {
        configureFromParams(params)
        analyzer?.close()
        analyzer = AnalyzerFactory.create(context, capability, engine)
        bindUseCases()
    }

    private fun bindUseCases() {
        val provider = cameraProvider ?: return
        val owner = lifecycleOwner ?: return
        provider.unbindAll()

        val preview = Preview.Builder().build().also {
            it.setSurfaceProvider(previewView.surfaceProvider)
        }
        val analysis = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
        analysis.setAnalyzer(analysisExecutor) { proxy -> onFrame(proxy) }

        val selector = CameraSelector.Builder().requireLensFacing(lensFacing).build()
        try {
            provider.bindToLifecycle(owner, selector, preview, analysis)
        } catch (t: Throwable) {
            android.util.Log.w(TAG, "bind failed: ${t.message}")
        }
    }

    private fun onFrame(proxy: ImageProxy) {
        try {
            val bmp = proxy.toUprightMirroredBitmap(lensFacing == CameraSelector.LENS_FACING_FRONT)
            latestBitmap = bmp

            if (inferenceOn.get()) {
                analyzer?.analyze(bmp, System.currentTimeMillis())?.let { emit(it.toEvent()) }
            }

            // ~1fps LOW-res JPEG for Gemini Live.
            val now = System.currentTimeMillis()
            if (now - lastLiveMs >= liveIntervalMs) {
                lastLiveMs = now
                val low = scaleMaxDim(bmp, liveMaxDim)
                val jpeg = low.toJpeg(60)
                emit(mapOf("type" to "live", "jpeg" to jpeg))
            }
        } catch (t: Throwable) {
            android.util.Log.w(TAG, "frame failed: ${t.message}")
        } finally {
            proxy.close()
        }
    }

    fun setInference(on: Boolean) { inferenceOn.set(on) }

    fun flip(): String {
        lensFacing = if (lensFacing == CameraSelector.LENS_FACING_FRONT)
            CameraSelector.LENS_FACING_BACK else CameraSelector.LENS_FACING_FRONT
        bindUseCases()
        return if (lensFacing == CameraSelector.LENS_FACING_FRONT) "front" else "back"
    }

    /** One HI-RES JPEG of the most recent frame for the "Analyze my form" snapshot. */
    fun captureSnapshot(onResult: (ByteArray?) -> Unit) {
        analysisExecutor.execute {
            val bmp = latestBitmap
            onResult(bmp?.toJpeg(90))
        }
    }

    fun stop() {
        cameraProvider?.unbindAll()
        analyzer?.close(); analyzer = null
    }

    override fun getView(): View = previewView

    override fun dispose() {
        stop()
        analysisExecutor.shutdown()
        latestBitmap = null
    }

    // ── helpers ──────────────────────────────────────────────────────────────
    private fun scaleMaxDim(src: Bitmap, maxDim: Int): Bitmap {
        val scale = maxDim.toFloat() / maxOf(src.width, src.height)
        if (scale >= 1f) return src
        return Bitmap.createScaledBitmap(src, (src.width * scale).toInt(), (src.height * scale).toInt(), true)
    }

    private fun Bitmap.toJpeg(quality: Int): ByteArray {
        val out = ByteArrayOutputStream()
        compress(Bitmap.CompressFormat.JPEG, quality, out)
        return out.toByteArray()
    }

    /** Convert an ImageProxy to an upright RGBA bitmap, mirrored for the front
     *  camera so normalized coords match the on-screen (mirrored) preview. */
    private fun ImageProxy.toUprightMirroredBitmap(mirror: Boolean): Bitmap {
        val bmp = toBitmapCompat()
        val m = Matrix()
        m.postRotate(imageInfo.rotationDegrees.toFloat())
        if (mirror) m.postScale(-1f, 1f)
        return Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
    }

    // CameraX 1.3+ provides ImageProxy.toBitmap(); guard for older artifacts.
    private fun ImageProxy.toBitmapCompat(): Bitmap = this.toBitmap()

    companion object { private const val TAG = "AvaVisionCamera" }
}

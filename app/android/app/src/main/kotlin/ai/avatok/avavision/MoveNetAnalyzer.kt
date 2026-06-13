package ai.avatok.avavision

import android.content.Context
import android.graphics.Bitmap
import org.tensorflow.lite.Interpreter
import org.tensorflow.lite.support.common.FileUtil
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * MoveNet (TFLite) — the DEFAULT pose engine on all platforms (master §6/§7).
 * Single-pose Lightning, 17 keypoints, free + on-device. Outputs [1,1,17,3]
 * (y, x, score) in 0..1 model space.
 *
 * Model asset (Phase Z applies the pubspec entry — see glue note):
 *   app/assets/models/movenet_singlepose_lightning.tflite
 */
class MoveNetAnalyzer(context: Context) : VisionAnalyzer {

    private val inputSize = 192 // Lightning
    private var interpreter: Interpreter? = null
    private val inputBuf: ByteBuffer =
        ByteBuffer.allocateDirect(inputSize * inputSize * 3 * 4).order(ByteOrder.nativeOrder())
    private val output = Array(1) { Array(1) { Array(17) { FloatArray(3) } } }

    init {
        try {
            val model = FileUtil.loadMappedFile(context, ASSET_PATH)
            interpreter = Interpreter(model, Interpreter.Options().apply { numThreads = 2 })
        } catch (t: Throwable) {
            android.util.Log.w(TAG, "MoveNet load failed: ${t.message}")
        }
    }

    override fun analyze(bitmap: Bitmap, timestampMs: Long): VisionResult? {
        val itp = interpreter ?: return null
        val scaled = Bitmap.createScaledBitmap(bitmap, inputSize, inputSize, true)
        fillInput(scaled)
        return try {
            itp.run(inputBuf, output)
            val kp = output[0][0]
            // MoveNet returns (y, x, score) — convert to [x, y, score].
            val pts = ArrayList<FloatArray>(17)
            for (i in 0 until 17) {
                val y = kp[i][0]; val x = kp[i][1]; val s = kp[i][2]
                pts.add(floatArrayOf(x, y, s))
            }
            VisionResult(
                points = listOf(pts),
                srcWidth = bitmap.width,
                srcHeight = bitmap.height,
            )
        } catch (t: Throwable) {
            android.util.Log.w(TAG, "MoveNet run failed: ${t.message}")
            null
        }
    }

    private fun fillInput(bmp: Bitmap) {
        inputBuf.rewind()
        val px = IntArray(inputSize * inputSize)
        bmp.getPixels(px, 0, inputSize, 0, 0, inputSize, inputSize)
        // MoveNet expects uint8 [0,255] as float (no normalization).
        for (p in px) {
            inputBuf.putFloat(((p shr 16) and 0xFF).toFloat())
            inputBuf.putFloat(((p shr 8) and 0xFF).toFloat())
            inputBuf.putFloat((p and 0xFF).toFloat())
        }
    }

    override fun close() { interpreter?.close(); interpreter = null }

    companion object {
        private const val TAG = "AvaVisionMoveNet"
        const val ASSET_PATH = "flutter_assets/assets/models/movenet_singlepose_lightning.tflite"
    }
}

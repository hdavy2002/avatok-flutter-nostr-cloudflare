package ai.avatok.avavision

import android.graphics.Bitmap

/**
 * A normalized result the native analyzers hand back per frame. Coordinates are
 * 0..1 in VIEW space, already mirrored for the front camera so the Dart painters
 * map straight through. Exactly one of points/boxes/mask is meaningful per
 * capability/overlay.
 */
data class VisionResult(
    /** Landmark instances: each inner list is one detected instance (e.g. a hand).
     *  Each point is [x, y, score]. Pose/face produce a single instance. */
    val points: List<List<FloatArray>> = emptyList(),
    /** Boxes as [x, y, w, h, score] plus an optional label string. */
    val boxes: List<DetectionBox> = emptyList(),
    /** Segmentation alpha grid (row-major, 0..255), with [maskW]x[maskH]. */
    val mask: ByteArray? = null,
    val maskW: Int = 0,
    val maskH: Int = 0,
    val scoreInputs: Map<String, Double> = emptyMap(),
    val srcWidth: Int = 0,
    val srcHeight: Int = 0,
) {
    fun toEvent(): Map<String, Any?> {
        val ptsOut: Any? = when {
            points.isEmpty() -> null
            points.size == 1 -> points[0].map { listOf(it[0], it[1], it.getOrElse(2) { 1f }) }
            else -> points.map { inst -> inst.map { listOf(it[0], it[1], it.getOrElse(2) { 1f }) } }
        }
        val boxesOut = boxes.map { b ->
            listOf(b.x, b.y, b.w, b.h, b.score, b.label)
        }
        return buildMap {
            put("type", "frame")
            if (ptsOut != null) put("points", ptsOut)
            if (boxesOut.isNotEmpty()) put("boxes", boxesOut)
            if (mask != null) { put("mask", mask); put("mask_w", maskW); put("mask_h", maskH) }
            if (scoreInputs.isNotEmpty()) put("score_inputs", scoreInputs)
            put("w", srcWidth); put("h", srcHeight)
        }
    }
}

data class DetectionBox(
    val x: Float, val y: Float, val w: Float, val h: Float,
    val score: Float, val label: String?,
)

/**
 * Common interface for an on-device vision engine. Implementations run fully
 * on-device and free (master §6/§7): MoveNet (TFLite) or MediaPipe Pose for pose;
 * MediaPipe Tasks for hand/gesture/face/object/segmentation.
 */
interface VisionAnalyzer {
    /** Analyze one RGBA bitmap (already oriented + mirrored). Returns null if the
     *  model isn't ready or there's no confident subject. */
    fun analyze(bitmap: Bitmap, timestampMs: Long): VisionResult?
    fun close()
}

/** Factory mapping the master §6 capability/engine strings to an analyzer. */
object AnalyzerFactory {
    fun create(context: android.content.Context, capability: String, engine: String): VisionAnalyzer? {
        return when (capability) {
            "pose" -> if (engine == "mediapipe_pose") MediaPipePoseAnalyzer(context)
                      else MoveNetAnalyzer(context)
            "gemini_only" -> null // no on-device model; overlay off
            else -> MediaPipeTasksAnalyzer(context, capability)
        }
    }
}

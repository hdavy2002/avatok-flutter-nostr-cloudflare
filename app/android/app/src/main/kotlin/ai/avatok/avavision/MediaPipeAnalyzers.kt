package ai.avatok.avavision

import android.content.Context
import android.graphics.Bitmap
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarker
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarkerResult
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarker
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarkerResult
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarker
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarkerResult
import com.google.mediapipe.tasks.vision.facedetector.FaceDetector
import com.google.mediapipe.tasks.vision.objectdetector.ObjectDetector
import com.google.mediapipe.tasks.vision.imagesegmenter.ImageSegmenter

/**
 * MediaPipe Pose (33 landmarks) — the engine_upgrade_android_web=mediapipe_pose
 * path for richer pose on Android/Web (master §6). Free + on-device.
 *
 * Model asset (glue note): app/assets/models/pose_landmarker_lite.task
 */
class MediaPipePoseAnalyzer(context: Context) : VisionAnalyzer {
    private var landmarker: PoseLandmarker? = null

    init {
        try {
            val base = BaseOptions.builder()
                .setModelAssetPath("flutter_assets/assets/models/pose_landmarker_lite.task")
                .build()
            val opts = PoseLandmarker.PoseLandmarkerOptions.builder()
                .setBaseOptions(base)
                .setRunningMode(RunningMode.IMAGE)
                .setNumPoses(1)
                .build()
            landmarker = PoseLandmarker.createFromOptions(context, opts)
        } catch (t: Throwable) {
            android.util.Log.w(TAG, "Pose landmarker load failed: ${t.message}")
        }
    }

    override fun analyze(bitmap: Bitmap, timestampMs: Long): VisionResult? {
        val lm = landmarker ?: return null
        return try {
            val res: PoseLandmarkerResult = lm.detect(BitmapImageBuilder(bitmap).build())
            if (res.landmarks().isEmpty()) return null
            val inst = res.landmarks()[0].map { floatArrayOf(it.x(), it.y(), it.visibility().orElse(1f)) }
            VisionResult(points = listOf(inst), srcWidth = bitmap.width, srcHeight = bitmap.height)
        } catch (t: Throwable) { null }
    }

    override fun close() { landmarker?.close(); landmarker = null }
    companion object { private const val TAG = "AvaVisionMpPose" }
}

/**
 * MediaPipe Tasks — covers hand / gesture / face_landmark / face_detect /
 * object / segmentation (master §6). One class dispatches on capability so the
 * camera view only holds a single analyzer. Image (per-frame) running mode keeps
 * the call site synchronous; we already throttle on the analysis executor.
 *
 * Model assets (glue note, under app/assets/models/):
 *   hand_landmarker.task, face_landmarker.task, blaze_face_short_range.tflite,
 *   efficientdet_lite0.tflite, selfie_segmenter.tflite
 */
class MediaPipeTasksAnalyzer(context: Context, private val capability: String) : VisionAnalyzer {

    private var hand: HandLandmarker? = null
    private var face: FaceLandmarker? = null
    private var faceDet: FaceDetector? = null
    private var objects: ObjectDetector? = null
    private var segmenter: ImageSegmenter? = null

    init {
        try {
            when (capability) {
                "hand", "gesture" -> {
                    val opts = HandLandmarker.HandLandmarkerOptions.builder()
                        .setBaseOptions(base(context, "hand_landmarker.task"))
                        .setRunningMode(RunningMode.IMAGE).setNumHands(2).build()
                    hand = HandLandmarker.createFromOptions(context, opts)
                }
                "face_landmark" -> {
                    val opts = FaceLandmarker.FaceLandmarkerOptions.builder()
                        .setBaseOptions(base(context, "face_landmarker.task"))
                        .setRunningMode(RunningMode.IMAGE).setNumFaces(1).build()
                    face = FaceLandmarker.createFromOptions(context, opts)
                }
                "face_detect" -> {
                    val opts = FaceDetector.FaceDetectorOptions.builder()
                        .setBaseOptions(base(context, "blaze_face_short_range.tflite"))
                        .setRunningMode(RunningMode.IMAGE).build()
                    faceDet = FaceDetector.createFromOptions(context, opts)
                }
                "object", "image_class" -> {
                    val opts = ObjectDetector.ObjectDetectorOptions.builder()
                        .setBaseOptions(base(context, "efficientdet_lite0.tflite"))
                        .setRunningMode(RunningMode.IMAGE).setMaxResults(5)
                        .setScoreThreshold(0.4f).build()
                    objects = ObjectDetector.createFromOptions(context, opts)
                }
                "segmentation", "holistic" -> {
                    val opts = ImageSegmenter.ImageSegmenterOptions.builder()
                        .setBaseOptions(base(context, "selfie_segmenter.tflite"))
                        .setRunningMode(RunningMode.IMAGE)
                        .setOutputCategoryMask(true).setOutputConfidenceMasks(false).build()
                    segmenter = ImageSegmenter.createFromOptions(context, opts)
                }
            }
        } catch (t: Throwable) {
            android.util.Log.w(TAG, "Tasks($capability) load failed: ${t.message}")
        }
    }

    private fun base(context: Context, asset: String) = BaseOptions.builder()
        .setModelAssetPath("flutter_assets/assets/models/$asset").build()

    override fun analyze(bitmap: Bitmap, timestampMs: Long): VisionResult? {
        return try {
            val img = BitmapImageBuilder(bitmap).build()
            when (capability) {
                "hand", "gesture" -> {
                    val r: HandLandmarkerResult = hand?.detect(img) ?: return null
                    if (r.landmarks().isEmpty()) return null
                    val insts = r.landmarks().map { hl -> hl.map { floatArrayOf(it.x(), it.y(), 1f) } }
                    VisionResult(points = insts, srcWidth = bitmap.width, srcHeight = bitmap.height)
                }
                "face_landmark" -> {
                    val r: FaceLandmarkerResult = face?.detect(img) ?: return null
                    if (r.faceLandmarks().isEmpty()) return null
                    val inst = r.faceLandmarks()[0].map { floatArrayOf(it.x(), it.y(), 1f) }
                    VisionResult(points = listOf(inst), srcWidth = bitmap.width, srcHeight = bitmap.height)
                }
                "face_detect" -> {
                    val r = faceDet?.detect(img) ?: return null
                    val boxes = r.detections().map { d ->
                        val b = d.boundingBox()
                        DetectionBox(
                            b.left / bitmap.width, b.top / bitmap.height,
                            b.width() / bitmap.width, b.height() / bitmap.height,
                            d.categories().firstOrNull()?.score() ?: 1f, "face",
                        )
                    }
                    VisionResult(boxes = boxes, srcWidth = bitmap.width, srcHeight = bitmap.height)
                }
                "object", "image_class" -> {
                    val r = objects?.detect(img) ?: return null
                    val boxes = r.detections().map { d ->
                        val b = d.boundingBox()
                        val cat = d.categories().firstOrNull()
                        DetectionBox(
                            b.left / bitmap.width, b.top / bitmap.height,
                            b.width() / bitmap.width, b.height() / bitmap.height,
                            cat?.score() ?: 1f, cat?.categoryName(),
                        )
                    }
                    VisionResult(boxes = boxes, srcWidth = bitmap.width, srcHeight = bitmap.height)
                }
                "segmentation", "holistic" -> {
                    val r = segmenter?.segment(img) ?: return null
                    val mask = r.categoryMask().orElse(null) ?: return null
                    val w = mask.width; val h = mask.height
                    // Downsample to a coarse grid (≤64×64) to keep the channel cheap.
                    val gw = minOf(64, w); val gh = minOf(64, h)
                    val grid = ByteArray(gw * gh)
                    val bb = com.google.mediapipe.framework.image.ByteBufferExtractor
                        .extract(mask)
                    for (gy in 0 until gh) for (gx in 0 until gw) {
                        val sx = gx * w / gw; val sy = gy * h / gh
                        val v = bb.get(sy * w + sx).toInt() and 0xFF
                        // category 0 == background for selfie segmenter → invert to subject alpha
                        grid[gy * gw + gx] = if (v != 0) 255.toByte() else 0
                    }
                    VisionResult(mask = grid, maskW = gw, maskH = gh,
                        srcWidth = bitmap.width, srcHeight = bitmap.height)
                }
                else -> null
            }
        } catch (t: Throwable) {
            android.util.Log.w(TAG, "Tasks($capability) run failed: ${t.message}")
            null
        }
    }

    override fun close() {
        hand?.close(); face?.close(); faceDet?.close(); objects?.close(); segmenter?.close()
        hand = null; face = null; faceDet = null; objects = null; segmenter = null
    }

    companion object { private const val TAG = "AvaVisionTasks" }
}

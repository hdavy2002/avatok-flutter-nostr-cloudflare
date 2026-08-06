package ai.avatok.callrecord

import android.media.AudioFormat
import android.os.Handler
import android.os.Looper
import android.os.StatFs
import android.os.SystemClock
import com.cloudwebrtc.webrtc.FlutterWebRTCPlugin
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.lang.reflect.Field
import org.webrtc.audio.JavaAudioDeviceModule

/**
 * [CALLREC-NATIVE-1] On-demand call recording — the Android native layer.
 *
 * Records BOTH legs of a live AvaTOK call by tapping flutter_webrtc's Android
 * AudioDeviceModule:
 *
 *  - near end (the user's own microphone) — `recordSamplesReadyCallbackAdapter`
 *    → [JavaAudioDeviceModule.SamplesReadyCallback.onWebRtcAudioRecordSamplesReady]
 *  - far end (decoded incoming audio)     — `playbackSamplesReadyCallbackAdapter`
 *    → [JavaAudioDeviceModule.PlaybackSamplesReadyCallback.onWebRtcAudioTrackSamplesReady]
 *
 * The ADM sits BELOW the transport, so this works identically on the Cloudflare SFU
 * path and on the sticky P2P fallback, and survives ICE restarts and relay migration.
 *
 * ## THE GOVERNING INVARIANT (spec §3.2)
 *
 * Recording is best-effort; the live conversation always wins. Both callbacks run on
 * WebRTC's real-time audio threads, inside the loop that feeds the encoder and the
 * speaker. They do exactly one thing: convert and copy PCM into a bounded ring
 * ([PcmRing]) and return. No allocation, no logging, no disk, no network, no locks
 * shared with the encoder, and no event emission. The ring DROPS OLDEST when full and
 * never applies backpressure.
 *
 * Degradation ladder, in order, never touching the call:
 *   1. drop frames (ring overflow / encoder refusal)
 *   2. finalize and close the recording early (too many drops, encoder or disk
 *      failure, device storage floor crossed)
 *   3. disable recording for the rest of this call and notify once
 *
 * ## Reflection
 *
 * The plugin is reached through the **engine-scoped binding** ([boundWebRtcPlugin],
 * set by `MainActivity.configureFlutterEngine`) and NOT through
 * `FlutterWebRTCPlugin.sharedSingleton`. The static is assigned in that plugin's
 * constructor, so the most recently constructed instance always owns it whether or
 * not it is the one running the call — that is the `adapter_field_null` failure fixed
 * by `[CALL-TRANSLATE-BIND-1]` on 2026-08-05. The static is kept only as a fallback.
 *
 * Both adapters are resolved and subscribed **purely reflectively**: the field is
 * read by name and `addCallback` / `removeCallback` are looked up by name and
 * parameter assignability, with no compile-time reference to the adapter classes.
 * The far-end adapter type (`PlaybackSamplesReadyCallbackAdapter`) is proven in
 * production by `CallTranslationAudioPlugin`; the near-end one is UNPROVEN in this
 * repo, so binding to its type by name would be an unverifiable compile-time
 * dependency. Every failure path here writes a distinct token and emits it — see
 * [nearFailure] / [farFailure] and the `probe` event. Never make this silent.
 *
 * R8: `app/tool/postcreate.py` must keep both adapter fields and this whole package,
 * or release builds record silence while debug builds work fine (spec §3.5).
 *
 * Channels: `avatok/call_record` (methods) + `avatok/call_record/events` (events).
 */
class CallRecorderPlugin :
    FlutterPlugin,
    MethodChannel.MethodCallHandler,
    EventChannel.StreamHandler,
    JavaAudioDeviceModule.SamplesReadyCallback,
    JavaAudioDeviceModule.PlaybackSamplesReadyCallback {

    companion object {
        const val METHOD_CHANNEL = "avatok/call_record"
        const val EVENT_CHANNEL = "avatok/call_record/events"

        /**
         * Fixed output rate. Every batch is resampled to this on the fly, because with
         * no segmentation there is no part boundary at which a rate change could be
         * absorbed (spec §3.3). 16 kHz is wideband voice and keeps a recording at
         * roughly 11 MB/hour mono, which is what the storage-pool arithmetic in §6.1
         * assumes.
         */
        const val OUT_RATE = 16000

        /** One AAC-LC frame. The mixer produces exactly this many samples at a time. */
        const val FRAME = 1024

        /** `Arrays.fill` on a ShortArray needs a Short — an Int literal will not compile. */
        private const val SILENCE: Short = 0

        private const val MONO_BITRATE = 24_000
        private const val STEREO_BITRATE = 40_000

        /** Ring depth per leg. Deep enough to ride out a stalled encoder, not a stalled call. */
        private const val RING_MS = 4_000

        /**
         * How far behind the wall clock the mixer runs. This is the jitter budget that
         * lets a leg arrive late without leaving a hole in the output.
         */
        private const val TARGET_LATENCY_MS = 250L

        private const val WORKER_TICK_MS = 20L
        private const val STATE_INTERVAL_MS = 1_000L
        private const val ALIGN_INTERVAL_MS = 5_000L

        /** Re-align only past this much error; below it the correction is noise. */
        private val REALIGN_THRESHOLD_SAMPLES = OUT_RATE * 60 / 1000             // 60 ms
        private val REALIGN_MAX_STEP_SAMPLES = OUT_RATE * 500 / 1000             // 500 ms

        /** Cumulative dropped audio past which the recording is closed early (ladder step 2). */
        private val DROP_ABORT_SAMPLES = OUT_RATE.toLong() * 5                   // 5 s

        /** Hard device-storage floor. Dart owns the soft floor (`callRecordingMinFreeMb`). */
        private val STORAGE_FLOOR_BYTES = 48L * 1024L * 1024L

        /** A leg that has produced nothing this long after start is reported once. */
        private const val LEG_SILENT_TIMEOUT_MS = 3_000L

        /**
         * [CALLREC-NATIVE-1] The flutter_webrtc plugin belonging to the engine we are
         * actually running in, set by `MainActivity.configureFlutterEngine` AFTER
         * `super.configureFlutterEngine` (GeneratedPluginRegistrant is what registers
         * flutter_webrtc; before it runs, `plugins.get` returns null).
         */
        @Volatile
        var boundWebRtcPlugin: FlutterWebRTCPlugin? = null
    }

    private val main = Handler(Looper.getMainLooper())
    private var methodChannel: MethodChannel? = null
    private var eventChannel: EventChannel? = null

    @Volatile
    private var eventSink: EventChannel.EventSink? = null

    // --- adapter binding ----------------------------------------------------
    private var nearAdapter: Any? = null
    private var farAdapter: Any? = null

    @Volatile
    private var nearFailure: String = "not_probed"

    @Volatile
    private var farFailure: String = "not_probed"

    @Volatile
    private var adapterSource: String = "none"

    // --- session state ------------------------------------------------------
    @Volatile
    private var recording = false

    @Volatile
    private var callId: String? = null

    @Volatile
    private var safeId: String? = null

    @Volatile
    private var outputDir: File? = null

    private var workFile: File? = null

    @Volatile
    private var stereo = false

    @Volatile
    private var startMs = 0L

    // The two legs are read on WebRTC's audio threads and written on the platform
    // thread — volatile is not optional here.
    @Volatile
    private var near: LegTap? = null

    @Volatile
    private var far: LegTap? = null

    @Volatile
    private var writer: AacAdtsWriter? = null

    private var worker: Thread? = null

    @Volatile
    private var workerRunning = false

    /** Set by the ladder when a session closes itself; a later `stop` returns it. */
    @Volatile
    private var selfFinalized: MutableMap<String, Any?>? = null

    /** Call ids that have burned their recording for the rest of the call (ladder step 3). */
    private val disabledCalls: MutableSet<String> =
        java.util.concurrent.ConcurrentHashMap.newKeySet()

    // ------------------------------------------------------------------------
    // Flutter plumbing
    // ------------------------------------------------------------------------

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methodChannel = MethodChannel(binding.binaryMessenger, METHOD_CHANNEL).also {
            it.setMethodCallHandler(this)
        }
        eventChannel = EventChannel(binding.binaryMessenger, EVENT_CHANNEL).also {
            it.setStreamHandler(this)
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        // A recording in flight is finalized, not thrown away — the bytes on disk are
        // already valid ADTS and the remux is cheap.
        if (recording) finishSession(remux = true, reason = "detached")
        methodChannel?.setMethodCallHandler(null)
        eventChannel?.setStreamHandler(null)
        methodChannel = null
        eventChannel = null
        eventSink = null
    }

    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
        eventSink = events
    }

    override fun onCancel(arguments: Any?) {
        eventSink = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "start" -> handleStart(call, result)
            "stop" -> handleStop(result)
            "cancel" -> handleCancel(result)
            "state" -> result.success(stateMap())
            "recoverOrphans" -> handleRecoverOrphans(call, result)
            else -> result.notImplemented()
        }
    }

    // ------------------------------------------------------------------------
    // start / stop / cancel
    // ------------------------------------------------------------------------

    private fun handleStart(call: MethodCall, result: MethodChannel.Result) {
        val id = call.argument<String>("callId")
        val dirPath = call.argument<String>("outputDir")
        val wantStereo = call.argument<Boolean>("stereo") ?: false
        if (id.isNullOrEmpty() || dirPath.isNullOrEmpty()) {
            result.success(fail("invalid_arguments"))
            return
        }
        if (recording) {
            result.success(fail(if (callId == id) "already_recording" else "busy_other_call"))
            return
        }
        if (disabledCalls.contains(id)) {
            // Ladder step 3: this call already burned its recording.
            result.success(fail("disabled_for_call"))
            return
        }

        val dir = File(dirPath)
        if (!dir.exists() && !dir.mkdirs()) {
            result.success(fail("output_dir_unavailable"))
            return
        }
        if (freeBytes(dir) < STORAGE_FLOOR_BYTES) {
            result.success(fail("insufficient_storage"))
            return
        }

        // Resolve BOTH adapters before committing to anything.
        val nearAd = resolveAdapter("recordSamplesReadyCallbackAdapter") { nearFailure = it }
        val farAd = resolveAdapter("playbackSamplesReadyCallbackAdapter") { farFailure = it }
        emitProbe()
        if (farAd == null) {
            result.success(fail("far_adapter_unavailable:$farFailure"))
            return
        }
        if (nearAd == null) {
            // Deliberately fatal. A "recording" holding only the other party's voice is
            // worse than no recording — it is misleading, and the near-end tap is the
            // unproven half of this feature (spec §3.1), so it must fail loudly.
            result.success(fail("near_adapter_unavailable:$nearFailure"))
            return
        }

        val sid = AdtsRemuxer.sanitize(id)
        val work = AdtsRemuxer.workFile(dir, sid)
        // A stale working file for the SAME id would be concatenated into this take.
        if (work.exists()) work.delete()
        AdtsRemuxer.finalFile(dir, sid).delete()

        val channels = if (wantStereo) 2 else 1
        val w = try {
            AacAdtsWriter(
                work, OUT_RATE, channels,
                if (wantStereo) STEREO_BITRATE else MONO_BITRATE,
            )
        } catch (t: Throwable) {
            work.delete()
            result.success(fail("encoder_init_failed:" + t.javaClass.simpleName))
            return
        }

        // Subscribe LAST, so nothing can arrive before the session is coherent.
        val nearOk = adapterCall(nearAd, "addCallback", this)
        val farOk = adapterCall(farAd, "addCallback", this)
        if (!nearOk || !farOk) {
            if (nearOk) adapterCall(nearAd, "removeCallback", this)
            if (farOk) adapterCall(farAd, "removeCallback", this)
            w.close()
            work.delete()
            result.success(
                fail("subscribe_failed:near=" + nearOk + ",far=" + farOk),
            )
            return
        }

        callId = id
        safeId = sid
        outputDir = dir
        workFile = work
        stereo = wantStereo
        writer = w
        nearAdapter = nearAd
        farAdapter = farAd
        near = LegTap("near", OUT_RATE, RING_MS)
        far = LegTap("far", OUT_RATE, RING_MS)
        selfFinalized = null
        startMs = SystemClock.elapsedRealtime()
        recording = true

        writeMeta(dir, sid, id)
        startWorker()

        emit(
            mapOf(
                "type" to "state",
                "recording" to true,
                "callId" to id,
                "durationMs" to 0,
                "bytes" to 0,
                "stereo" to wantStereo,
                "sampleRate" to OUT_RATE,
            ),
        )
        result.success(
            mapOf(
                "ok" to true,
                "path" to AdtsRemuxer.finalFile(dir, sid).absolutePath,
                "error" to null,
            ),
        )
    }

    private fun handleStop(result: MethodChannel.Result) {
        if (!recording) {
            val cached = selfFinalized
            if (cached != null) {
                selfFinalized = null
                result.success(cached)
            } else {
                result.success(
                    mapOf(
                        "ok" to false, "path" to null, "durationMs" to 0,
                        "bytes" to 0, "error" to "not_recording",
                    ),
                )
            }
            return
        }
        // Finalizing means joining the worker and remuxing — seconds of work on a long
        // recording. It never runs on the platform thread.
        Thread({
            val map = finishSession(remux = true, reason = "stop")
            main.post { result.success(map) }
        }, "avatok-callrec-final").apply { isDaemon = true }.start()
    }

    private fun handleCancel(result: MethodChannel.Result) {
        if (!recording) {
            selfFinalized = null
            result.success(mapOf("ok" to true))
            return
        }
        Thread({
            finishSession(remux = false, reason = "cancel")
            main.post { result.success(mapOf("ok" to true)) }
        }, "avatok-callrec-cancel").apply { isDaemon = true }.start()
    }

    private fun handleRecoverOrphans(call: MethodCall, result: MethodChannel.Result) {
        val dirPath = call.argument<String>("outputDir")
        if (dirPath.isNullOrEmpty()) {
            result.success(mapOf("recovered" to emptyList<Map<String, Any?>>()))
            return
        }
        val dir = File(dirPath)
        val active = if (recording) safeId else null
        Thread({
            val recovered = ArrayList<Map<String, Any?>>()
            try {
                for (work in AdtsRemuxer.orphans(dir, active)) {
                    val sid = AdtsRemuxer.safeIdOf(work)
                    val target = AdtsRemuxer.finalFile(dir, sid)
                    val out = AdtsRemuxer.remux(work, target)
                    val meta = readMeta(dir, sid)
                    AdtsRemuxer.metaFile(dir, sid).delete()
                    if (out != null) {
                        recovered.add(
                            mapOf(
                                "callId" to (meta ?: sid),
                                "path" to out.file.absolutePath,
                                "durationMs" to out.durationMs,
                                "bytes" to out.bytes,
                            ),
                        )
                    }
                }
            } catch (_: Throwable) {
                // Recovery is opportunistic; a bad file must not fail the whole sweep.
            }
            main.post { result.success(mapOf("recovered" to recovered)) }
        }, "avatok-callrec-recover").apply { isDaemon = true }.start()
    }

    // ------------------------------------------------------------------------
    // The two ADM callbacks. WebRTC real-time audio threads — copy and return.
    // ------------------------------------------------------------------------

    override fun onWebRtcAudioRecordSamplesReady(samples: JavaAudioDeviceModule.AudioSamples) {
        val leg = near ?: return
        if (!recording) return
        if (samples.audioFormat != AudioFormat.ENCODING_PCM_16BIT) {
            leg.rejectBatch()
            return
        }
        leg.onSamples(
            samples.data, samples.sampleRate, samples.channelCount,
            SystemClock.elapsedRealtime(),
        )
    }

    override fun onWebRtcAudioTrackSamplesReady(samples: JavaAudioDeviceModule.AudioSamples) {
        val leg = far ?: return
        if (!recording) return
        if (samples.audioFormat != AudioFormat.ENCODING_PCM_16BIT) {
            leg.rejectBatch()
            return
        }
        leg.onSamples(
            samples.data, samples.sampleRate, samples.channelCount,
            SystemClock.elapsedRealtime(),
        )
    }

    // ------------------------------------------------------------------------
    // Mixer / encoder worker
    // ------------------------------------------------------------------------

    private fun startWorker() {
        workerRunning = true
        worker = Thread(this::workerLoop, "avatok-callrec-mix").apply {
            isDaemon = true
            priority = Thread.NORM_PRIORITY + 1
            start()
        }
    }

    private fun workerLoop() {
        val channels = if (stereo) 2 else 1
        val nearBuf = ShortArray(FRAME)
        val farBuf = ShortArray(FRAME)
        val pcm = ByteArray(FRAME * channels * 2)
        var outSamples = 0L
        var lastState = 0L
        var lastAlign = SystemClock.elapsedRealtime()
        var legSilenceReported = false
        var encoderFailures = 0

        while (workerRunning) {
            val now = SystemClock.elapsedRealtime()
            val target = (now - startMs - TARGET_LATENCY_MS) * OUT_RATE / 1000L

            while (workerRunning && outSamples + FRAME <= target) {
                pullLeg(near, nearBuf, outSamples)
                pullLeg(far, farBuf, outSamples)
                mix(nearBuf, farBuf, pcm, channels)
                val w = writer
                if (w == null) break
                val ok = try {
                    w.encode(pcm, pcm.size)
                } catch (_: Throwable) {
                    false
                }
                if (!ok) encoderFailures++
                if (encoderFailures > 200) {
                    degradeAndFinish("encoder_failed")
                    return
                }
                outSamples += FRAME
            }

            if (now - lastState >= STATE_INTERVAL_MS) {
                lastState = now
                emit(stateMap().plus("type" to "state"))
                if (!legSilenceReported && now - startMs > LEG_SILENT_TIMEOUT_MS) {
                    legSilenceReported = true
                    reportSilentLegs()
                }
                if (droppedSamplesTotal() > DROP_ABORT_SAMPLES) {
                    // Ladder step 2: the recording is losing more audio than it is
                    // keeping. Close it cleanly rather than write minutes of holes.
                    degradeAndFinish("ring_overflow")
                    return
                }
                if (freeBytes(outputDir) < STORAGE_FLOOR_BYTES) {
                    degradeAndFinish("low_storage")
                    return
                }
            }

            if (now - lastAlign >= ALIGN_INTERVAL_MS) {
                lastAlign = now
                realign(now)
                reportRateChanges()
            }

            try {
                Thread.sleep(WORKER_TICK_MS)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            }
        }
    }

    /**
     * Places [leg] on the shared output timeline and fills exactly [FRAME] samples.
     *
     * A leg that has not reached [outStart] yet contributes silence (a gap); one whose
     * head is already in the past has that stale audio discarded. This is what keeps
     * the two legs aligned without either of them blocking the other.
     */
    private fun pullLeg(leg: LegTap?, dst: ShortArray, outStart: Long) {
        if (leg == null || !leg.started) {
            java.util.Arrays.fill(dst, 0, FRAME, SILENCE)
            return
        }
        var skew = leg.headTimeline(startMs) - outStart
        if (skew < 0L) {
            val skipped = leg.ring.skip(-skew)
            leg.staleSkipped += skipped
            skew = leg.headTimeline(startMs) - outStart
            if (skew < 0L) skew = 0L
        }
        var written = 0
        if (skew > 0L) {
            val zeros = if (skew > FRAME.toLong()) FRAME else skew.toInt()
            java.util.Arrays.fill(dst, 0, zeros, SILENCE)
            leg.gapSamples += zeros.toLong()
            written = zeros
        }
        if (written < FRAME) {
            val got = leg.ring.read(dst, written, FRAME - written)
            if (written + got < FRAME) {
                java.util.Arrays.fill(dst, written + got, FRAME, SILENCE)
                leg.gapSamples += (FRAME - written - got).toLong()
            }
        }
    }

    /**
     * Mono = sum and clamp. Stereo = near left, far right.
     *
     * **The near-end leg is NEVER attenuated** (spec §3.3). It is the user's own voice;
     * ducking it to hide speakerphone echo doubling is the worst possible failure of
     * this feature. If mono proves unusable on speaker, the answer is stereo, not gain.
     */
    private fun mix(nearBuf: ShortArray, farBuf: ShortArray, pcm: ByteArray, channels: Int) {
        var o = 0
        var i = 0
        if (channels == 2) {
            while (i < FRAME) {
                val l = nearBuf[i].toInt()
                val r = farBuf[i].toInt()
                pcm[o++] = (l and 0xFF).toByte()
                pcm[o++] = ((l shr 8) and 0xFF).toByte()
                pcm[o++] = (r and 0xFF).toByte()
                pcm[o++] = ((r shr 8) and 0xFF).toByte()
                i++
            }
        } else {
            while (i < FRAME) {
                var v = nearBuf[i].toInt() + farBuf[i].toInt()
                if (v > 32767) v = 32767 else if (v < -32768) v = -32768
                pcm[o++] = (v and 0xFF).toByte()
                pcm[o++] = ((v shr 8) and 0xFF).toByte()
                i++
            }
        }
    }

    /**
     * Periodic re-alignment. Each leg's newest sample should sit at "now" on the output
     * timeline; the difference is the leg's clock drift against the system clock. The
     * measured values are published so Phase 1 can gate on them (<40 ms over 30 min).
     */
    private fun realign(now: Long) {
        val n = near
        val f = far
        val nearDrift = legDrift(n, now)
        val farDrift = legDrift(f, now)
        applyCorrection(n, nearDrift)
        applyCorrection(f, farDrift)
        emit(
            mapOf(
                "type" to "drift",
                "callId" to callId,
                "nearDriftMs" to samplesToMs(nearDrift),
                "farDriftMs" to samplesToMs(farDrift),
                // The number that actually matters: how far the two legs have moved
                // relative to EACH OTHER. Absolute drift against the system clock is
                // harmless; relative drift is what smears the conversation.
                "legDeltaMs" to samplesToMs(nearDrift - farDrift),
                "nearCorrectedMs" to samplesToMs(n?.correctedSamples ?: 0L),
                "farCorrectedMs" to samplesToMs(f?.correctedSamples ?: 0L),
                "nearGapMs" to samplesToMs(n?.gapSamples ?: 0L),
                "farGapMs" to samplesToMs(f?.gapSamples ?: 0L),
                "nearDroppedMs" to samplesToMs(n?.ring?.droppedSamples ?: 0L),
                "farDroppedMs" to samplesToMs(f?.ring?.droppedSamples ?: 0L),
            ),
        )
    }

    /** Positive = this leg has produced more audio than wall clock says it should have. */
    private fun legDrift(leg: LegTap?, now: Long): Long {
        if (leg == null || !leg.started) return 0L
        val expected = (now - leg.anchorMs) * OUT_RATE / 1000L
        return leg.ring.writeIndex() + leg.adjustSamples - expected
    }

    private fun applyCorrection(leg: LegTap?, drift: Long) {
        if (leg == null || !leg.started) return
        if (drift > -REALIGN_THRESHOLD_SAMPLES && drift < REALIGN_THRESHOLD_SAMPLES) return
        var step = -drift
        if (step > REALIGN_MAX_STEP_SAMPLES) step = REALIGN_MAX_STEP_SAMPLES.toLong()
        if (step < -REALIGN_MAX_STEP_SAMPLES) step = (-REALIGN_MAX_STEP_SAMPLES).toLong()
        leg.adjustSamples += step
        leg.correctedSamples += if (step < 0) -step else step
    }

    private fun reportRateChanges() {
        reportRateChange(near)
        reportRateChange(far)
    }

    private fun reportRateChange(leg: LegTap?) {
        if (leg == null) return
        val seq = leg.rateChangeSeq
        if (seq == leg.reportedRateSeq) return
        leg.reportedRateSeq = seq
        emit(
            mapOf(
                "type" to "rateChange",
                "callId" to callId,
                "leg" to leg.name,
                "from" to leg.previousRate,
                "to" to leg.inputRate,
                "channels" to leg.inputChannels,
            ),
        )
    }

    /**
     * The near-end tap is unproven in this repo (spec §3.1). If it resolved but never
     * fires, that is exactly the failure Phase 1 exists to find — say so, loudly,
     * rather than shipping a one-sided recording that looks fine until it is played.
     */
    private fun reportSilentLegs() {
        val n = near
        val f = far
        if (n != null && !n.started) {
            emit(
                mapOf(
                    "type" to "error", "callId" to callId,
                    "code" to "near_no_samples",
                    "detail" to "record adapter bound but onWebRtcAudioRecordSamplesReady never fired",
                    "adapterSource" to adapterSource,
                ),
            )
        }
        if (f != null && !f.started) {
            emit(
                mapOf(
                    "type" to "error", "callId" to callId,
                    "code" to "far_no_samples",
                    "detail" to "playback adapter bound but onWebRtcAudioTrackSamplesReady never fired",
                    "adapterSource" to adapterSource,
                ),
            )
        }
    }

    private fun droppedSamplesTotal(): Long =
        (near?.ring?.droppedSamples ?: 0L) + (far?.ring?.droppedSamples ?: 0L)

    /** Ladder steps 2 + 3: close the recording, keep what was captured, burn the call. */
    private fun degradeAndFinish(reason: String) {
        val id = callId
        val map = finishSession(remux = true, reason = reason)
        if (id != null) disabledCalls.add(id)
        selfFinalized = map
        emit(
            mapOf(
                "type" to "degraded",
                "callId" to id,
                "reason" to reason,
                "path" to map["path"],
                "durationMs" to map["durationMs"],
                "bytes" to map["bytes"],
            ),
        )
    }

    // ------------------------------------------------------------------------
    // Finalization
    // ------------------------------------------------------------------------

    /**
     * Unsubscribes, stops the worker, closes the encoder and (when [remux]) rewrites
     * the ADTS stream into `.m4a`. Idempotent enough to be called from the worker
     * itself, from `stop`, and from engine detach.
     */
    @Synchronized
    private fun finishSession(remux: Boolean, reason: String): MutableMap<String, Any?> {
        val out = HashMap<String, Any?>()
        if (!recording) {
            out["ok"] = false
            out["path"] = null
            out["durationMs"] = 0
            out["bytes"] = 0
            out["error"] = "not_recording"
            return out
        }
        recording = false

        // Detach FIRST so no further PCM can arrive while we tear down.
        nearAdapter?.let { adapterCall(it, "removeCallback", this) }
        farAdapter?.let { adapterCall(it, "removeCallback", this) }
        nearAdapter = null
        farAdapter = null

        workerRunning = false
        val t = worker
        worker = null
        if (t != null && t !== Thread.currentThread()) {
            try { t.join(2_000L) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
        }

        val w = writer
        writer = null
        try { w?.close() } catch (_: Throwable) {}

        val dir = outputDir
        val sid = safeId
        val work = workFile
        val id = callId

        near = null
        far = null
        workFile = null

        var path: String? = null
        var durationMs = 0L
        var bytes = 0L
        var error: String? = null

        if (!remux) {
            work?.delete()
            if (dir != null && sid != null) {
                AdtsRemuxer.metaFile(dir, sid).delete()
                AdtsRemuxer.finalFile(dir, sid).delete()
            }
        } else if (dir != null && sid != null && work != null) {
            val target = AdtsRemuxer.finalFile(dir, sid)
            val res = try {
                AdtsRemuxer.remux(work, target)
            } catch (t2: Throwable) {
                error = "remux_failed:" + t2.javaClass.simpleName
                null
            }
            AdtsRemuxer.metaFile(dir, sid).delete()
            if (res != null) {
                path = res.file.absolutePath
                durationMs = res.durationMs
                bytes = res.bytes
            } else if (error == null) {
                error = "empty_recording"
            }
        }

        callId = null
        safeId = null
        outputDir = null

        out["ok"] = path != null
        out["path"] = path
        out["durationMs"] = durationMs
        out["bytes"] = bytes
        out["error"] = error

        emit(
            mapOf(
                "type" to "state",
                "recording" to false,
                "callId" to id,
                "durationMs" to durationMs,
                "bytes" to bytes,
                "reason" to reason,
                "path" to path,
                "error" to error,
            ),
        )
        return out
    }

    // ------------------------------------------------------------------------
    // Reflection into flutter_webrtc
    // ------------------------------------------------------------------------

    /**
     * Reads a public adapter field off `MethodCallHandlerImpl`. Every null exit writes
     * a distinct token through [onFailure] — the `[CALL-TRANSLATE-PROBE-OBS-1]` lesson:
     * a resolver with several silent null exits is undebuggable in the field.
     */
    private fun resolveAdapter(fieldName: String, onFailure: (String) -> Unit): Any? {
        try {
            var plugin = boundWebRtcPlugin
            adapterSource = if (plugin != null) "engine_bound" else "shared_singleton"
            if (plugin == null) {
                plugin = FlutterWebRTCPlugin.sharedSingleton
            } else if (FlutterWebRTCPlugin.sharedSingleton !== plugin) {
                adapterSource = "engine_bound_singleton_mismatch"
            }
            if (plugin == null) {
                onFailure("webrtc_plugin_null")
                return null
            }
            val handlerField: Field =
                FlutterWebRTCPlugin::class.java.getDeclaredField("methodCallHandler")
            handlerField.isAccessible = true
            val handler = handlerField.get(plugin)
            if (handler == null) {
                onFailure("method_call_handler_null")
                return null
            }
            val adapter = handler.javaClass.getField(fieldName).get(handler)
            if (adapter == null) {
                onFailure("adapter_field_null")
                return null
            }
            onFailure("none")
            return adapter
        } catch (e: Throwable) {
            // NoSuchFieldException here = the field was renamed by a flutter_webrtc bump
            // or stripped by R8 (see the keep rule in app/tool/postcreate.py).
            onFailure("exception:" + e.javaClass.simpleName)
            return null
        }
    }

    /**
     * Invokes `addCallback` / `removeCallback` by name and parameter assignability.
     *
     * Deliberately not a typed call: the far-end adapter type is known
     * (`PlaybackSamplesReadyCallbackAdapter`, used by `CallTranslationAudioPlugin`) but
     * the near-end adapter's type is NOT proven in this repo, and a wrong compile-time
     * class name is exactly the kind of mistake that would only surface 40–80 minutes
     * later in CI.
     */
    private fun adapterCall(adapter: Any, method: String, callback: Any): Boolean {
        return try {
            val m = adapter.javaClass.methods.firstOrNull {
                it.name == method &&
                    it.parameterTypes.size == 1 &&
                    it.parameterTypes[0].isInstance(callback)
            } ?: return false
            m.invoke(adapter, callback)
            true
        } catch (_: Throwable) {
            false
        }
    }

    private fun emitProbe() {
        emit(
            mapOf(
                "type" to "probe",
                "adapterSource" to adapterSource,
                "near" to nearFailure,
                "far" to farFailure,
            ),
        )
    }

    // ------------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------------

    private fun stateMap(): Map<String, Any?> {
        val w = writer
        return mapOf(
            "recording" to recording,
            "callId" to callId,
            "durationMs" to (w?.durationMs() ?: 0L).toInt(),
            "bytes" to (w?.bytesWritten ?: 0L).toInt(),
        )
    }

    private fun fail(error: String): Map<String, Any?> =
        mapOf("ok" to false, "path" to null, "error" to error)

    private fun samplesToMs(samples: Long): Long = samples * 1000L / OUT_RATE

    private fun freeBytes(dir: File?): Long {
        if (dir == null) return Long.MAX_VALUE
        return try {
            StatFs(dir.absolutePath).availableBytes
        } catch (_: Throwable) {
            Long.MAX_VALUE
        }
    }

    /**
     * A one-line sidecar holding the RAW call id, so orphan recovery after a crash can
     * report the id Dart knows rather than the file-system-sanitized form.
     */
    private fun writeMeta(dir: File, sid: String, rawCallId: String) {
        try {
            AdtsRemuxer.metaFile(dir, sid).writeText(rawCallId)
        } catch (_: Throwable) {
        }
    }

    private fun readMeta(dir: File, sid: String): String? = try {
        val f = AdtsRemuxer.metaFile(dir, sid)
        if (f.exists()) f.readText().trim().ifEmpty { null } else null
    } catch (_: Throwable) {
        null
    }

    private fun emit(payload: Map<String, Any?>) {
        val sink = eventSink ?: return
        main.post {
            try {
                sink.success(payload)
            } catch (_: Throwable) {
            }
        }
    }
}

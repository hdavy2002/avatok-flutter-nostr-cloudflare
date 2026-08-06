package ai.avatok.callrecord

import android.media.AudioFormat
import android.media.audiofx.AcousticEchoCanceler
import android.os.Build
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
         * absorbed (spec §3.3).
         *
         * **32 kHz, and do NOT drop it back to 16 kHz to hit a storage number.**
         * [CALLREC-NATIVE-1] chose 16 kHz to reach the "~11 MB/hour" figure in §6.1.
         * That reasoning was wrong: **an AAC file's size is set by its BITRATE, not by
         * its sample rate.** Halving the sample rate at a fixed bitrate buys zero bytes
         * — it only throws away the 4–16 kHz band and permanently bakes telephone-band
         * quality into an artifact a user may play back months later in a dispute.
         * Storage is controlled by [MONO_BITRATE] / [STEREO_BITRATE] below and nowhere
         * else.
         */
        const val OUT_RATE = 32000

        /** One AAC-LC frame. The mixer produces exactly this many samples at a time. */
        const val FRAME = 1024

        /** `Arrays.fill` on a ShortArray needs a Short — an Int literal will not compile. */
        private const val SILENCE: Short = 0

        /**
         * THE storage knob (see [OUT_RATE]). 32 kbps mono ≈ 14 MB/hour, so the 5 GB free
         * pool still holds roughly 360 hours and §6.1's "free in practice for nearly
         * everyone" conclusion is unchanged. Stereo carries two decorrelated voices, so
         * it gets 48 kbps rather than a naive double.
         */
        private const val MONO_BITRATE = 32_000
        private const val STEREO_BITRATE = 48_000

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

        /**
         * Hard device-storage floor — the last line of defence, checked at `start` AND
         * once a second during the session. Dart owns the SOFT, user-facing floor
         * (`callRecordingMinFreeMb`, default 500 MB) via the `freeBytes` method.
         *
         * **The two must not be able to contradict each other: this number has to stay
         * BELOW the Dart flag.** 48 MB ≪ 500 MB, so the soft check always trips first
         * and the user gets "your phone is low on storage" instead of a bare
         * `insufficient_storage` after tapping Record. If anyone ever lowers
         * `callRecordingMinFreeMb` below 48 MB the flag stops meaning anything, because
         * this floor rejects the start first — that is a deliberately safe direction to
         * fail in, but it is why the flag should not be set that low.
         */
        private val STORAGE_FLOOR_BYTES = 48L * 1024L * 1024L

        /** A leg that has produced nothing this long after start is reported once. */
        private const val LEG_SILENT_TIMEOUT_MS = 3_000L

        /**
         * [CALLREC-NATIVE-3] A leg that HAS started but has delivered nothing for this
         * long is reported as stalled.
         *
         * **2.5 s, and the number is not arbitrary.** Both ADM callbacks are
         * clock-driven: WebRTC hands over a 10 ms batch on a fixed cadence whether
         * anyone is speaking or not, and the far-end playback loop keeps running
         * through silence because it is feeding the speaker. So a gap is never "nobody
         * talked" — it means delivery itself stopped. 2.5 s is 250 consecutive missed
         * batches, far past any scheduling hiccup, and it clears the slowest legitimate
         * pause we know of (a Bluetooth SCO transition tearing down and rebuilding the
         * ADM, which is typically under a second and worth knowing about if it isn't).
         * It also sits below [RING_MS] = 4 s, so the stall is visible before the ring
         * could have quietly absorbed it.
         */
        private const val LEG_STALL_TIMEOUT_MS = 2_500L

        /**
         * How long ONE leg may stay stalled while the other keeps producing before the
         * degradation ladder closes the recording. See [checkLegLiveness] for why this
         * escalates at all and why it is this slow.
         */
        private const val LEG_STALL_ABORT_MS = 30_000L

        /** Stall reports emitted per leg per session; the counters keep counting past it. */
        private const val MAX_STALL_REPORTS = 5

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

    /**
     * [CALLREC-NATIVE-3] Admission gate covering the window between `start` being
     * accepted on the platform thread and [startSession] finishing on its own thread.
     * Guarded by [startLock] together with [recording], so a second `start` cannot
     * slip in while the encoder is still being acquired.
     */
    @Volatile
    private var starting = false

    private val startLock = Any()

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

    // --- [CALLHOLD-1] hold / splice ----------------------------------------
    //
    // When the user puts the CALL on hold, the RECORDING holds too, and the held
    // period is SPLICED OUT — absent from the file, not present as dead air. So a
    // recording is shorter than wall clock, and `durationMs` (which
    // [AacAdtsWriter.durationMs] derives from frames actually written, never from
    // a clock) is the RECORDED duration. That is the number Dart persists.
    //
    // The mechanism is a moving origin. Every timeline in the mixer is measured
    // from [recStartMs] = `startMs + pausedTotalMs` instead of `startMs`, so the
    // output clock simply does not advance while held. On resume each leg is
    // re-anchored ([LegTap.rebaseAfterPause]) so its own anchor post-dates the
    // pause and lands exactly on the current output position.
    //
    // Why not "keep recording silence": a hold is often minutes, and minutes of
    // silence is both bytes the user pays for and a file whose timeline no longer
    // matches the conversation. Why not "stop and start a new file": the encoder
    // would be finalized and reopened, producing two recordings for one call and
    // a second Inbox row.

    @Volatile
    private var paused = false

    /** elapsedRealtime at which the current pause began; 0 when not paused. */
    @Volatile
    private var pauseAtMs = 0L

    /** Wall-clock ms spliced out of this session so far (COMPLETED pauses only). */
    @Volatile
    private var pausedTotalMs = 0L

    @Volatile
    private var pauseCount = 0

    /**
     * Origin of the "silent-leg" grace window: `startMs` at start, and the resume
     * instant after every hold. Without it, a leg that has been deliberately
     * re-anchored (and so reads `started == false` for the ~10 ms until its first
     * post-resume batch) could be reported as `near_no_samples` — a hold masquerading
     * as the one failure that report exists to catch.
     */
    @Volatile
    private var legClockBaseMs = 0L

    /**
     * The recorded-output origin. `startMs` shifted forward by everything spliced
     * out, so `now - recStartMs()` is RECORDED elapsed, not wall-clock elapsed.
     * Identical to `startMs` until the first hold, which is why an un-held call
     * behaves byte-for-byte as it did before [CALLHOLD-1].
     */
    private fun recStartMs(): Long = startMs + pausedTotalMs

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
            "pause" -> handlePause(result)
            "resume" -> handleResume(result)
            "cancel" -> handleCancel(result)
            "state" -> result.success(stateMap())
            "freeBytes" -> handleFreeBytes(call, result)
            "recoverOrphans" -> handleRecoverOrphans(call, result)
            else -> result.notImplemented()
        }
    }

    // ------------------------------------------------------------------------
    // start / stop / cancel
    // ------------------------------------------------------------------------

    /**
     * [CALLREC-NATIVE-3] `start` does its cheap admission checks on the platform
     * thread and then hands the whole session setup to a background thread.
     *
     * **Why:** [AacAdtsWriter]'s constructor calls `MediaCodec.createEncoderByType` +
     * `configure` + `start`. Acquiring a codec while a 540p30 video encoder session is
     * already running can block for tens to hundreds of milliseconds on a low-end
     * device — i.e. a visible UI stall on the call screen at the exact moment the user
     * taps Record. `StatFs`, `mkdirs` and the reflective adapter probe are filesystem
     * and reflection work in the same breath. Every other heavy operation in this file
     * (`stop`, `cancel`, `recoverOrphans`) was already off the platform thread; this
     * one was the omission.
     *
     * **The result contract is unchanged.** `start` still answers exactly one
     * `{ok, path, error}` map — it just answers it a few milliseconds later, after
     * setup has really succeeded or really failed. Nothing reports `ok:true` before
     * the encoder exists, so an async `encoder_init_failed` is still a loud, explicit
     * failure and never a silent non-start.
     *
     * **No new race.** Ordering inside [startSession] is untouched: the encoder is
     * constructed BEFORE the ADM callbacks are subscribed, so PCM can never arrive
     * without somewhere to put it. [starting] holds the admission gate across the
     * async window so a second `start` still gets `busy_other_call` rather than
     * racing into a half-built session.
     */
    private fun handleStart(call: MethodCall, result: MethodChannel.Result) {
        val id = call.argument<String>("callId")
        val dirPath = call.argument<String>("outputDir")
        val wantStereo = call.argument<Boolean>("stereo") ?: false
        if (id.isNullOrEmpty() || dirPath.isNullOrEmpty()) {
            result.success(fail("invalid_arguments"))
            return
        }
        synchronized(startLock) {
            if (recording || starting) {
                result.success(
                    fail(if (callId == id) "already_recording" else "busy_other_call"),
                )
                return
            }
            if (disabledCalls.contains(id)) {
                // Ladder step 3: this call already burned its recording.
                result.success(fail("disabled_for_call"))
                return
            }
            starting = true
        }
        Thread({
            val map = try {
                startSession(id, dirPath, wantStereo)
            } catch (t: Throwable) {
                // Belt and braces: an unexpected throw must still produce a clear
                // {ok:false} answer, never an unresolved Dart future.
                fail("start_failed:" + t.javaClass.simpleName)
            } finally {
                // Cleared AFTER `recording` has been set, so the admission gate above
                // is continuously closed for a successful start.
                starting = false
            }
            main.post { result.success(map) }
        }, "avatok-callrec-start").apply { isDaemon = true }.start()
    }

    /** The real work of `start`. Runs on `avatok-callrec-start`, never on the platform thread. */
    private fun startSession(id: String, dirPath: String, wantStereo: Boolean): Map<String, Any?> {
        val dir = File(dirPath)
        if (!dir.exists() && !dir.mkdirs()) {
            return fail("output_dir_unavailable")
        }
        if (freeBytes(dir) < STORAGE_FLOOR_BYTES) {
            return fail("insufficient_storage")
        }

        // Resolve BOTH adapters before committing to anything.
        val nearAd = resolveAdapter("recordSamplesReadyCallbackAdapter") { nearFailure = it }
        val farAd = resolveAdapter("playbackSamplesReadyCallbackAdapter") { farFailure = it }
        emitProbe()
        if (farAd == null) {
            return fail("far_adapter_unavailable:$farFailure")
        }
        if (nearAd == null) {
            // Deliberately fatal. A "recording" holding only the other party's voice is
            // worse than no recording — it is misleading, and the near-end tap is the
            // unproven half of this feature (spec §3.1), so it must fail loudly.
            return fail("near_adapter_unavailable:$nearFailure")
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
            return fail("encoder_init_failed:" + t.javaClass.simpleName)
        }

        // Subscribe LAST, so nothing can arrive before the session is coherent.
        val nearOk = adapterCall(nearAd, "addCallback", this)
        val farOk = adapterCall(farAd, "addCallback", this)
        if (!nearOk || !farOk) {
            if (nearOk) adapterCall(nearAd, "removeCallback", this)
            if (farOk) adapterCall(farAd, "removeCallback", this)
            w.close()
            work.delete()
            return fail("subscribe_failed:near=" + nearOk + ",far=" + farOk)
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
        // [CALLHOLD-1] A fresh session never inherits a previous one's splice state.
        paused = false
        pauseAtMs = 0L
        pausedTotalMs = 0L
        pauseCount = 0
        legClockBaseMs = startMs
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
        return mapOf(
            "ok" to true,
            "path" to AdtsRemuxer.finalFile(dir, sid).absolutePath,
            "error" to null,
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

    /**
     * [CALLHOLD-1] Pause capture. Cheap, synchronous and safe on the platform
     * thread: it sets two volatiles and returns.
     *
     * From this instant both ADM callbacks return early, so nothing new enters
     * either ring, and the mixer's output clock freezes at [pauseAtMs] — which
     * also lets the worker DRAIN whatever already sits in the rings up to the
     * pause instant, so the last ~250 ms of real speech before the tap is kept
     * rather than thrown away with the jitter budget.
     *
     * Idempotent: a second `pause` is `ok:true`, because a hold that answers
     * "error" to a duplicate would leave callers writing recovery code for a state
     * that is already correct.
     */
    private fun handlePause(result: MethodChannel.Result) {
        synchronized(startLock) {
            if (!recording) {
                result.success(mapOf("ok" to false, "error" to "not_recording"))
                return
            }
            if (!paused) {
                pauseAtMs = SystemClock.elapsedRealtime()
                pauseCount++
                paused = true
            }
        }
        emit(stateMap().plus("type" to "state"))
        result.success(mapOf("ok" to true, "error" to null))
    }

    /**
     * [CALLHOLD-1] Resume capture, splicing the held period out of the timeline.
     *
     * Order is load-bearing and is the whole correctness argument:
     *  1. accumulate the pause into [pausedTotalMs] — this is what moves
     *     [recStartMs] forward and keeps the output clock continuous;
     *  2. re-anchor both legs while the producer is STILL quiesced;
     *  3. only then clear [paused], which is the volatile write that releases the
     *     ADM callbacks and publishes (1) and (2) to the mixer thread.
     *
     * Doing (3) first would let a batch land against a ring that is about to be
     * reset, and doing (2) after it would let the first post-resume batch anchor
     * against the pre-pause origin — a hole exactly the length of the hold.
     */
    private fun handleResume(result: MethodChannel.Result) {
        synchronized(startLock) {
            if (!recording) {
                result.success(mapOf("ok" to false, "error" to "not_recording"))
                return
            }
            if (paused) {
                val now = SystemClock.elapsedRealtime()
                val heldMs = now - pauseAtMs
                if (heldMs > 0L) pausedTotalMs += heldMs
                pauseAtMs = 0L
                legClockBaseMs = now
                near?.rebaseAfterPause()
                far?.rebaseAfterPause()
                paused = false
            }
        }
        emit(stateMap().plus("type" to "state"))
        result.success(mapOf("ok" to true, "error" to null))
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

    /**
     * [CALLREC-NATIVE-2] Free bytes on the volume holding `outputDir`.
     *
     * This is what makes `callRecordingMinFreeMb` a real flag. Without it,
     * `CallRecordingStore.hasFreeSpace()` hit `notImplemented()`, failed open, and
     * ALWAYS returned true — so the only storage check in the product was
     * [STORAGE_FLOOR_BYTES] here, a lower and non-configurable number that only fires
     * after the user has already tapped Record.
     *
     * Dart owns the SOFT, user-facing floor ("your phone is low on storage", before
     * arming — spec §5.2); the hard floor below stays as the last line of defence.
     *
     * Returns null rather than a number when there is nothing to measure — Dart reads
     * a non-`num` as "could not measure" and fails open, which is the correct
     * degradation. Never `!!` the argument: this is called on the platform thread and
     * an NPE here would surface as a crash, not a missing pre-check.
     */
    private fun handleFreeBytes(call: MethodCall, result: MethodChannel.Result) {
        val dirPath = call.argument<String>("outputDir")
        if (dirPath.isNullOrBlank()) {
            result.success(null)
            return
        }
        val free = freeBytes(File(dirPath))
        result.success(if (free == Long.MAX_VALUE) null else free)
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
        // [CALLHOLD-1] Held: drop the batch. One volatile read, no allocation — the
        // §3.2 invariant is untouched. This is ALSO what stops a long hold from
        // overflowing the ring and tripping the drop-abort ladder.
        if (paused) return
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
        if (paused) return // [CALLHOLD-1] — see the near-end callback above.
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
            // [CALLREC-NATIVE-3] NORM_PRIORITY, and it must never be raised.
            //
            // Java thread priority maps to a Linux nice value, so NORM_PRIORITY + 1
            // scheduled this mixer ABOVE the video encoder's feeding threads — on a
            // device that may already be thermally throttled, that is the recorder
            // taking CPU from the live call, which inverts the governing invariant
            // (spec §3.2). Nothing here needs the head start: [RING_MS] is a 4-second
            // jitter budget, and falling behind costs frames in the recording only.
            priority = Thread.NORM_PRIORITY
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
            // [CALLHOLD-1] Two changes, and neither one moves for an un-held call
            // (`pausedTotalMs` is 0 and `held` is false, so this is the original
            // expression verbatim):
            //  - the origin is `recStartMs()`, so held time never becomes output
            //    samples — that IS the splice;
            //  - while held the clock is FROZEN at `pauseAtMs` and the jitter
            //    budget is not subtracted, so the worker drains the rings right up
            //    to the moment of the tap and then naturally goes idle (target
            //    stops moving). Without dropping the budget we would discard the
            //    last TARGET_LATENCY_MS of genuine speech at every hold.
            val held = paused
            val clockNow = if (held) pauseAtMs else now
            val latency = if (held) 0L else TARGET_LATENCY_MS
            val target = (clockNow - recStartMs() - latency) * OUT_RATE / 1000L

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
                // Still emitted while held — the UI has to see a recording that is
                // paused rather than one that silently stopped ticking. `durationMs`
                // simply stops advancing, which is exactly what is happening.
                emit(stateMap().plus("type" to "state"))
                // [CALLHOLD-1] EVERY health check below is suspended while held.
                // A hold is a deliberate discontinuity: no samples are arriving
                // because we asked for none, so leg liveness would read it as two
                // stalled legs, and after LEG_STALL_ABORT_MS the ladder would close
                // and BURN a recording the user only paused.
                if (!held) {
                    // [CALLREC-TELEM-1] Before the silence check, not after: a leg
                    // that DID deliver must be recorded as having delivered even on
                    // a session that later fails, or the two events disagree.
                    reportFirstSamples(now)
                    if (!legSilenceReported && now - legClockBaseMs > LEG_SILENT_TIMEOUT_MS) {
                        legSilenceReported = true
                        reportSilentLegs()
                    }
                    // [CALLREC-NATIVE-3] Continuous liveness. Cheap (two volatile reads),
                    // reports only on a transition, and can escalate to the ladder.
                    if (checkLegLiveness(now)) return
                    if (droppedSamplesTotal() > DROP_ABORT_SAMPLES) {
                        // Ladder step 2: the recording is losing more audio than it is
                        // keeping. Close it cleanly rather than write minutes of holes.
                        degradeAndFinish("ring_overflow")
                        return
                    }
                }
            }

            if (held) {
                // [CALLHOLD-1] Keep the re-alignment cadence rolling forward while
                // held, so a 10-minute hold does not fire an immediate realign the
                // instant we resume — against legs that were re-anchored 20 ms ago
                // and whose measured "drift" would be pure noise.
                lastAlign = now
            } else if (now - lastAlign >= ALIGN_INTERVAL_MS) {
                lastAlign = now
                realign(now)
                reportRateChanges()
                // [CALLREC-NATIVE-3] The storage floor lives on the 5 s cadence, not
                // the 1 s one. `freeBytes` is a StatFs syscall — filesystem I/O on the
                // thread that also feeds MediaCodec every 20 ms. The floor itself is
                // unchanged ([STORAGE_FLOOR_BYTES], same `degradeAndFinish` reason);
                // only how often we go and ask the kernel changed. Dart's soft floor
                // (`callRecordingMinFreeMb`, ≥ 10× larger) is what the user actually
                // hits, and `start` has already checked this one.
                if (freeBytes(outputDir) < STORAGE_FLOOR_BYTES) {
                    degradeAndFinish("low_storage")
                    return
                }
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
        // [CALLHOLD-1] `recStartMs()`, not `startMs`: the leg is placed on the
        // RECORDED timeline. Identical until the first hold, and after one the leg
        // has been re-anchored to match this origin exactly.
        val origin = recStartMs()
        var skew = leg.headTimeline(origin) - outStart
        if (skew < 0L) {
            val skipped = leg.ring.skip(-skew)
            leg.staleSkipped += skipped
            skew = leg.headTimeline(origin) - outStart
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
                // [CALLREC-NATIVE-3] Ride along on the periodic event so the true
                // stall count survives the MAX_STALL_REPORTS cap.
                "nearStalls" to (n?.stallEvents ?: 0),
                "farStalls" to (f?.stallEvents ?: 0),
                // [CALLREC-TELEM-1] Everything else needed to judge recording HEALTH
                // from this one periodic event, so a reader does not have to join
                // five event types to answer "was this recording any good".
                //
                // `staleSkipped` is the counterpart of `gap`: a gap means a leg was
                // BEHIND (silence written where its audio had not arrived), stale
                // means it was AHEAD and audio was thrown away. A recording with a
                // large number of one and none of the other is a clock problem; both
                // together is jitter.
                "nearStaleMs" to samplesToMs(n?.staleSkipped ?: 0L),
                "farStaleMs" to samplesToMs(f?.staleSkipped ?: 0L),
                // Per-leg ADM truth, repeated here so ANY drift sample is
                // self-describing — a rate change that happened before telemetry
                // was flushed is still visible in the next drift row.
                "nearRate" to (n?.inputRate ?: 0),
                "farRate" to (f?.inputRate ?: 0),
                "nearChannels" to (n?.inputChannels ?: 0),
                "farChannels" to (f?.inputChannels ?: 0),
                "nearBatches" to (n?.batches ?: 0L),
                "farBatches" to (f?.batches ?: 0L),
                "nearRejected" to (n?.rejectedBatches ?: 0L),
                "farRejected" to (f?.rejectedBatches ?: 0L),
                // Recorded elapsed, so drift can be read as a RATE (ms per minute)
                // rather than an unanchored absolute.
                "elapsedMs" to (now - recStartMs()),
                "pausedTotalMs" to pausedTotalMs,
                "paused" to paused,
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

    /**
     * [CALLREC-NATIVE-3] Continuous liveness for a leg that already started.
     *
     * [reportSilentLegs] only ever answered "did this leg EVER produce anything", once,
     * three seconds in. A leg that started fine and then stopped delivering at minute
     * 12 was completely invisible: half the recording silent, no event, and the user
     * believing they hold a two-sided file. [LegTap.lastSampleMs] was being written on
     * every batch and read by nobody. This reads it.
     *
     * Reports the TRANSITION into stalled (and out of it), never per tick, and caps
     * emissions at [MAX_STALL_REPORTS] per leg so a flapping route cannot spam the
     * sink. `stallEvents` keeps counting past the cap and rides along on every `drift`
     * event, so the true count is always retrievable.
     *
     * ## Does a stalled leg trigger the degradation ladder? Only after 30 s, and only
     * ## when the OTHER leg is still alive.
     *
     * `near_adapter_unavailable` is fatal at `start` because a recording that never
     * contained the user's own voice is misleading from its first byte. A mid-call
     * stall is a different shape: minutes of good two-sided audio are already on disk,
     * and short stalls are usually transient (SCO transition, route switch, an ADM
     * rebuild), so aborting on the first blip would throw the rest of every Bluetooth
     * call away for nothing. But a leg that is still dead 30 s later is not a
     * transition, and everything recorded from here on is one-sided — the misleading
     * outcome the start-time rule exists to prevent. So the ladder closes it, keeping
     * the good prefix (finalize never deletes) instead of accumulating a long
     * half-silent tail.
     *
     * BOTH legs stalled is deliberately NOT escalated: the output is then honest
     * silence, not a misleading one-sided recording, and it is the shape a hold or a
     * PSTN interruption takes — which can resume.
     *
     * @return true if the ladder fired and the caller must return from the worker loop.
     */
    private fun checkLegLiveness(now: Long): Boolean {
        val n = near
        val f = far
        updateStall(n, now)
        updateStall(f, now)
        val nearDead = n != null && n.stalled && now - n.stalledSinceMs >= LEG_STALL_ABORT_MS
        val farDead = f != null && f.stalled && now - f.stalledSinceMs >= LEG_STALL_ABORT_MS
        if (nearDead && !farDead) {
            degradeAndFinish("near_leg_stalled")
            return true
        }
        if (farDead && !nearDead) {
            degradeAndFinish("far_leg_stalled")
            return true
        }
        return false
    }

    private fun updateStall(leg: LegTap?, now: Long) {
        if (leg == null || !leg.started) return
        val last = leg.lastSampleMs
        if (last <= 0L) return
        val gap = now - last
        if (!leg.stalled) {
            if (gap < LEG_STALL_TIMEOUT_MS) return
            leg.stalled = true
            leg.stalledSinceMs = now
            leg.stallEvents++
            if (leg.stallsReported < MAX_STALL_REPORTS) {
                leg.stallsReported++
                emit(
                    mapOf(
                        "type" to "error", "callId" to callId,
                        "code" to "leg_stalled",
                        "leg" to leg.name,
                        "gapMs" to gap,
                        "stallEvents" to leg.stallEvents,
                        "detail" to (
                            "leg " + leg.name + " started but has delivered no samples for " +
                                gap + "ms; playout is clock-driven, so this is stopped " +
                                "delivery, not silence"
                            ),
                        "adapterSource" to adapterSource,
                    ),
                )
            }
            return
        }
        if (gap < LEG_STALL_TIMEOUT_MS) {
            // Recovered. Clear the latch (silently past the cap) so a LATER stall is
            // still reported, and record how long the hole was.
            val stalledMs = now - leg.stalledSinceMs
            leg.stalled = false
            leg.stalledSinceMs = 0L
            if (leg.stallsReported <= MAX_STALL_REPORTS) {
                emit(
                    mapOf(
                        "type" to "legResumed", "callId" to callId,
                        "leg" to leg.name,
                        "stalledMs" to stalledMs,
                        "stallEvents" to leg.stallEvents,
                    ),
                )
            }
        }
    }

    private fun droppedSamplesTotal(): Long =
        (near?.ring?.droppedSamples ?: 0L) + (far?.ring?.droppedSamples ?: 0L)

    /** Ladder steps 2 + 3: close the recording, keep what was captured, burn the call. */
    private fun degradeAndFinish(reason: String) {
        val id = callId
        // [CALLREC-TELEM-1] Read BEFORE finishSession clears outputDir, and read
        // once: this is the number that distinguishes "the phone filled up" from
        // "the encoder died", and after the teardown there is nothing left to
        // measure. The reason string alone cannot make that distinction, because
        // `low_storage` and `encoder_failed` arrive on the same code path.
        val free = freeBytes(outputDir)
        val droppedMs = samplesToMs(droppedSamplesTotal())
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
                "freeMb" to (if (free == Long.MAX_VALUE) -1L else free / (1024L * 1024L)),
                "droppedMs" to droppedMs,
                "pauseCount" to pauseCount,
                "pausedTotalMs" to pausedTotalMs,
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
        // [CALLHOLD-1] Stopping while held is normal — the user can end a call they
        // put on hold. Clearing the latch here means the encoder is finalized with
        // exactly what it captured (the splice is already baked into the frames
        // written) and nothing carries into the next session.
        paused = false
        pauseAtMs = 0L

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

        // [CALLREC-TELEM-1] Snapshot the per-leg health BEFORE the legs are dropped.
        // These fields are the closing summary of the capture — they are what tells
        // a reader whether the file that just landed contains two voices or one —
        // and reading them after the nulls below would report zeros for every
        // recording, which is worse than not reporting them at all.
        val nSnap = near
        val fSnap = far
        // Explicitly typed: `mapOf` over mixed Boolean/Int/Long infers an
        // intersection type, and there is no local Kotlin toolchain to prove it
        // still satisfies `plus` on a Map<String, Any?> — a wrong guess costs a
        // 40–80 min CI round trip.
        val legSummary: Map<String, Any?> = mapOf(
            "nearStarted" to (nSnap?.started ?: false),
            "farStarted" to (fSnap?.started ?: false),
            "nearBatches" to (nSnap?.batches ?: 0L),
            "farBatches" to (fSnap?.batches ?: 0L),
            "nearRate" to (nSnap?.inputRate ?: 0),
            "farRate" to (fSnap?.inputRate ?: 0),
            "nearChannels" to (nSnap?.inputChannels ?: 0),
            "farChannels" to (fSnap?.inputChannels ?: 0),
            "nearGapMs" to samplesToMs(nSnap?.gapSamples ?: 0L),
            "farGapMs" to samplesToMs(fSnap?.gapSamples ?: 0L),
            "nearDroppedMs" to samplesToMs(nSnap?.ring?.droppedSamples ?: 0L),
            "farDroppedMs" to samplesToMs(fSnap?.ring?.droppedSamples ?: 0L),
            "nearStalls" to (nSnap?.stallEvents ?: 0),
            "farStalls" to (fSnap?.stallEvents ?: 0),
            "nearRejected" to (nSnap?.rejectedBatches ?: 0L),
            "farRejected" to (fSnap?.rejectedBatches ?: 0L),
        )

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
                "paused" to false,
                // [CALLHOLD-1] How much wall clock was spliced out, so a "my
                // recording is shorter than the call" report can be answered with
                // the number instead of a guess.
                "pausedTotalMs" to pausedTotalMs.toInt(),
                "pauseCount" to pauseCount,
                // [CALLREC-TELEM-1] The file's own shape, so `callrec_finalized`
                // describes the artifact and not just its size. `sampleRate` is the
                // FIXED output rate every batch was resampled to — the per-leg INPUT
                // rates are in `legSummary` and are the ones that move.
                "sampleRate" to OUT_RATE,
                "channels" to (if (stereo) 2 else 1),
                "stereo" to stereo,
            ).plus(legSummary),
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

    /**
     * [CALLREC-TELEM-1] THE event to read first when someone says "recording did
     * not work on my phone".
     *
     * The near-end microphone tap has never fired in this app — nothing in the repo
     * has ever subscribed to `recordSamplesReadyCallbackAdapter` (spec §3.1) — so
     * "did it bind, and on what hardware" is the single highest-value fact this
     * feature can report. It carries:
     *
     *  - `near` / `far`: the EXACT resolver token per leg (`none` = bound). The two
     *    are separate because the far leg is proven in production and the near leg
     *    is not: `near=adapter_field_null, far=none` is a completely different bug
     *    from both legs failing.
     *  - `adapterSource`: which binding path won — `engine_bound` (correct),
     *    `shared_singleton` (the fallback that produced `adapter_field_null` before
     *    `[CALL-TRANSLATE-BIND-1]`), or `engine_bound_singleton_mismatch` (bound,
     *    but a second plugin instance owns the static — the shape of the 2026-08-05
     *    bug, and worth knowing even when the probe succeeded).
     *  - device context. A binding failure is almost never about the user; it is
     *    about the OEM's WebRTC build, the API level and the audio HAL. Without
     *    manufacturer/model/API/AEC this event answers "it didn't work on his
     *    phone"; with them it answers "it doesn't work on this SoC family", which
     *    is the difference between one more test cycle and a fix.
     *
     * `hwAec` is `AcousticEchoCanceler.isAvailable()` — the pre/post-APM question
     * in §9. If the near tap is pre-APM, a device with NO hardware AEC records
     * un-cancelled far-end leakage into the near leg and mono summing comb-filters
     * it, so "the recording echoes but the call was clean" correlates with
     * `hwAec=false`, not with anything in the mixer.
     */
    private fun emitProbe() {
        emit(
            mapOf(
                "type" to "probe",
                "adapterSource" to adapterSource,
                "near" to nearFailure,
                "far" to farFailure,
                "callId" to callId,
                "manufacturer" to safeStr { Build.MANUFACTURER },
                "model" to safeStr { Build.MODEL },
                "device" to safeStr { Build.DEVICE },
                "apiLevel" to Build.VERSION.SDK_INT,
                "hwAec" to hasHardwareAec(),
                "outRate" to OUT_RATE,
                "stereo" to stereo,
            ),
        )
    }

    /**
     * Does this device advertise a hardware acoustic echo canceller? Wrapped
     * because `isAvailable()` reaches the audio HAL and has been seen to throw on
     * odd OEM builds — a telemetry probe must never be able to fail a start.
     */
    private fun hasHardwareAec(): Boolean = try {
        AcousticEchoCanceler.isAvailable()
    } catch (_: Throwable) {
        false
    }

    private fun safeStr(f: () -> String?): String = try {
        f() ?: "unknown"
    } catch (_: Throwable) {
        "unknown"
    }

    /**
     * [CALLREC-TELEM-1] "The adapter bound" and "the adapter delivers audio" are
     * two different facts, and only the second one produces a recording. This is
     * the second one: emitted from the MIXER thread (never from an audio callback —
     * §3.2) the first time a leg has produced anything.
     *
     * `firstSampleMs` is measured from [legClockBaseMs], i.e. from the start of the
     * session or from the last resume, so a hold does not inflate it. The ADM's own
     * reported rate and channel count ride along because they are per-leg and can
     * differ (mic at 48 kHz mono, playout at 16 kHz stereo is a perfectly normal
     * pair) — and because a leg that reports a rate we then resample from is where
     * a pitch-shift complaint has to be traced to.
     *
     * A leg with a probe token of `none` and NO `legFirstSample` event is the exact
     * silent-failure this feature's biggest risk describes: bound, subscribed,
     * never called. That pair of facts is the answer, and it needs both events.
     */
    private fun reportFirstSamples(now: Long) {
        reportFirstSample(near, now)
        reportFirstSample(far, now)
    }

    private fun reportFirstSample(leg: LegTap?, now: Long) {
        if (leg == null || !leg.started || leg.firstReported) return
        leg.firstReported = true
        val anchor = leg.anchorMs
        val base = legClockBaseMs
        emit(
            mapOf(
                "type" to "legFirstSample",
                "callId" to callId,
                "leg" to leg.name,
                "firstSampleMs" to (if (anchor > 0L && base > 0L) anchor - base else now - base),
                "inputRate" to leg.inputRate,
                "inputChannels" to leg.inputChannels,
                "outRate" to OUT_RATE,
                "adapterSource" to adapterSource,
                // Non-PCM16 batches. Should be 0; anything else means this leg is
                // delivering a format the tap cannot use, which looks identical to
                // silence in the finished file.
                "rejected" to leg.rejectedBatches,
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
            // [CALLHOLD-1] RECORDED duration — frames actually written. Held time is
            // not in it, which is the point: this is the number Dart persists and
            // the Inbox card shows, and it must describe the file, not the call.
            "durationMs" to (w?.durationMs() ?: 0L).toInt(),
            "bytes" to (w?.bytesWritten ?: 0L).toInt(),
            "paused" to paused,
            "pausedTotalMs" to pausedTotalMs.toInt(),
            "pauseCount" to pauseCount,
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

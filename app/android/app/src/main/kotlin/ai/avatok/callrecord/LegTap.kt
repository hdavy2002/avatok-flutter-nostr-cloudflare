package ai.avatok.callrecord

/**
 * [CALLREC-NATIVE-1] One leg of the recording (near-end mic, or far-end decoded
 * playback): downmix → resample → bounded ring, plus the wall-clock anchor the
 * mixer uses to place this leg on the shared output timeline.
 *
 * Everything in [onSamples] runs on a WebRTC real-time audio thread. It is
 * allocation-free (both scratch arrays are sized at construction), lock-free and
 * silent — no logging, no disk, no event emission. Rate changes only bump a
 * counter; the mixer thread is what reports them.
 *
 * **The sample rate is read off EVERY batch, never cached once** (spec §3.3):
 * Bluetooth SCO and wired/speaker transitions change the capture rate mid-call, and
 * with no segmentation there is no part boundary to re-open at. A recorder that
 * latched the rate at start would silently produce pitch-shifted audio from that
 * moment on, so the resampler re-derives its step from `inputRate` every batch.
 */
internal class LegTap(val name: String, private val outRate: Int, ringMs: Int) {

    companion object {
        /** ~42 ms of input at 48 kHz — comfortably larger than a 10 ms WebRTC batch. */
        private const val MAX_IN = 2048

        /** Lowest capture rate a route can plausibly report (narrowband SCO). */
        private const val MIN_IN_RATE = 8000
    }

    /**
     * Worst case is upsampling [MIN_IN_RATE] to [outRate], i.e. `outRate / 8000` output
     * samples per input frame. **Derived from [outRate], never a literal** — when the
     * output rate went 16 kHz → 32 kHz in `[CALLREC-NATIVE-2]` a hard-coded `MAX_IN * 2`
     * would have silently truncated every 8 kHz batch to half its samples and shown up
     * only as unexplained drift. +8 of slack so a fractional-phase carry can never run
     * off the end.
     */
    private val maxOut =
        MAX_IN * ((outRate + MIN_IN_RATE - 1) / MIN_IN_RATE).coerceAtLeast(1) + 8

    val ring = PcmRing(outRate / 1000 * ringMs)

    /** elapsedRealtime of the first sample of the FIRST batch on this leg. */
    @Volatile
    var anchorMs: Long = 0L

    @Volatile
    var started: Boolean = false

    @Volatile
    var lastSampleMs: Long = 0L

    @Volatile
    var inputRate: Int = 0

    @Volatile
    var inputChannels: Int = 0

    /** Bumped on every observed rate/channel change; the mixer reports the deltas. */
    @Volatile
    var rateChangeSeq: Int = 0

    @Volatile
    var previousRate: Int = 0

    @Volatile
    var batches: Long = 0L

    /** Non-PCM16 batches seen. Should be 0; a non-zero value is diagnostic. */
    @Volatile
    var rejectedBatches: Long = 0L

    // --- mixer-thread-only bookkeeping --------------------------------------
    /** Timeline correction applied by the periodic re-alignment pass, in samples. */
    var adjustSamples: Long = 0L

    /** Output samples this leg could not fill because its audio had not arrived. */
    var gapSamples: Long = 0L

    /** Samples discarded because they belonged to an already-emitted output frame. */
    var staleSkipped: Long = 0L

    /** Last reported rate-change sequence, so the mixer emits each change once. */
    var reportedRateSeq: Int = 0

    /**
     * [CALLREC-NATIVE-3] Liveness latch. True while this leg has STARTED but has
     * stopped delivering batches. Mixer-thread-only, so a stall is reported on the
     * TRANSITION into it and not once per tick.
     *
     * Before this existed, [lastSampleMs] was written on every batch and read by
     * nobody: a leg that started fine and then died at minute 12 produced a
     * half-silent recording with zero telemetry, which is the worst outcome this
     * feature has — the user believes they have both voices and does not.
     */
    var stalled: Boolean = false

    /** elapsedRealtime at which the current stall began; 0 when not stalled. */
    var stalledSinceMs: Long = 0L

    /** How many times this leg has gone silent. Published even once reporting caps. */
    var stallEvents: Int = 0

    /** Stall events actually emitted, so a flapping route cannot spam the sink. */
    var stallsReported: Int = 0

    /** Cumulative correction the re-alignment pass has applied, in samples. */
    var correctedSamples: Long = 0L

    // --- resampler state (audio thread only) --------------------------------
    private val monoIn = ShortArray(MAX_IN)
    private val outBuf = ShortArray(maxOut)
    private var phase: Double = 0.0
    private var prev: Short = 0
    private var primed: Boolean = false

    /**
     * The timeline index (in output samples, relative to the recording start) of the
     * OLDEST sample still sitting unread in the ring.
     */
    fun headTimeline(startMs: Long): Long =
        (anchorMs - startMs) * outRate / 1000L + adjustSamples + ring.readIndex()

    /** Timeline index one past the NEWEST sample written. */
    fun tailTimeline(startMs: Long): Long =
        (anchorMs - startMs) * outRate / 1000L + adjustSamples + ring.writeIndex()

    /**
     * Producer. Called on a WebRTC audio thread. Copy, convert, enqueue, return.
     *
     * @param data PCM16 little-endian, interleaved.
     * @param rate the rate reported by THIS batch.
     * @param channels the channel count reported by THIS batch.
     * @param nowMs monotonic clock (SystemClock.elapsedRealtime) at delivery.
     */
    fun onSamples(data: ByteArray, rate: Int, channels: Int, nowMs: Long) {
        if (rate <= 0 || channels <= 0) return
        val frameBytes = channels * 2
        val totalFrames = data.size / frameBytes
        if (totalFrames <= 0) return

        if (rate != inputRate || channels != inputChannels) {
            previousRate = inputRate
            inputRate = rate
            inputChannels = channels
            phase = 0.0
            primed = false
            rateChangeSeq++
        }

        if (!started) {
            // Anchor on the START of the batch, not its delivery instant.
            anchorMs = nowMs - totalFrames.toLong() * 1000L / rate
            started = true
        }
        lastSampleMs = nowMs
        batches++

        val step = rate.toDouble() / outRate.toDouble()
        var f = 0
        while (f < totalFrames) {
            var n = totalFrames - f
            if (n > MAX_IN) n = MAX_IN

            // Downmix to mono. Sum-and-average across channels; no attenuation.
            var i = 0
            while (i < n) {
                val base = (f + i) * frameBytes
                var acc = 0
                var c = 0
                while (c < channels) {
                    val p = base + c * 2
                    acc += ((data[p].toInt() and 0xFF) or (data[p + 1].toInt() shl 8))
                    c++
                }
                monoIn[i] = (acc / channels).toShort()
                i++
            }

            if (!primed) {
                prev = monoIn[0]
                phase = 0.0
                primed = true
            }

            // Linear-interpolating resampler over the virtual array
            // [prev, monoIn[0] … monoIn[n-1]] — index 0 is the carried sample, so a
            // fractional phase survives batch boundaries without a click.
            var out = 0
            var p = phase
            while (p < n && out < maxOut) {
                val idx = p.toInt()
                val frac = p - idx
                val a = if (idx == 0) prev.toInt() else monoIn[idx - 1].toInt()
                val b = monoIn[idx].toInt()
                var v = (a + (b - a) * frac).toInt()
                if (v > 32767) v = 32767 else if (v < -32768) v = -32768
                outBuf[out++] = v.toShort()
                p += step
            }
            phase = p - n
            if (phase < 0.0) phase = 0.0
            prev = monoIn[n - 1]

            if (out > 0) ring.write(outBuf, out)
            f += n
        }
    }

    fun rejectBatch() {
        rejectedBatches++
    }
}

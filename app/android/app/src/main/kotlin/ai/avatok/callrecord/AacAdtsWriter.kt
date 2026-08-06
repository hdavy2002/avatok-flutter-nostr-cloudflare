package ai.avatok.callrecord

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.Buffer

/**
 * [CALLREC-NATIVE-1] AAC-LC encoder writing a live **ADTS** stream.
 *
 * Why ADTS and not MediaMuxer directly (spec §3.3): `MediaMuxer` only writes its
 * `moov` index on `stop()`, so a process kill mid-recording leaves an unplayable
 * file — and with no segmentation that means the WHOLE recording is lost. ADTS is
 * self-framing and plays fine truncated, so a crash costs about one frame. The
 * stream is remuxed to `.m4a` by [AdtsRemuxer] on stop, and any `.aac` left behind
 * by a crash is recovered on the next launch.
 *
 * Runs on the recorder worker thread only. Never on an audio callback thread.
 */
internal class AacAdtsWriter(
    file: File,
    private val requestedRate: Int,
    private val requestedChannels: Int,
    bitRate: Int,
) {

    companion object {
        const val MIME = "audio/mp4a-latm"

        private val SAMPLE_RATES = intArrayOf(
            96000, 88200, 64000, 48000, 44100, 32000,
            24000, 22050, 16000, 12000, 11025, 8000, 7350,
        )

        /**
         * Fallback index for a rate not in the table — the recorder's own output rate
         * ([CallRecorderPlugin.OUT_RATE]), resolved from the table rather than written
         * as a literal so it cannot drift out of sync with it again.
         */
        private val DEFAULT_INDEX =
            SAMPLE_RATES.indexOf(CallRecorderPlugin.OUT_RATE).let { if (it < 0) 8 else it }

        fun freqIndex(rate: Int): Int {
            for (i in SAMPLE_RATES.indices) if (SAMPLE_RATES[i] == rate) return i
            return DEFAULT_INDEX
        }

        fun rateForIndex(index: Int): Int =
            if (index in SAMPLE_RATES.indices) SAMPLE_RATES[index] else SAMPLE_RATES[DEFAULT_INDEX]
    }

    private val codec: MediaCodec = MediaCodec.createEncoderByType(MIME)
    private val out = BufferedOutputStream(FileOutputStream(file), 64 * 1024)
    private val info = MediaCodec.BufferInfo()

    /** Header (7 B) + payload live in one scratch array so a frame is a single write. */
    private val pkt = ByteArray(16 * 1024)

    private var ptsUs: Long = 0L
    private var adtsRate: Int = requestedRate
    private var adtsChannels: Int = requestedChannels
    private var closed = false

    @Volatile
    var bytesWritten: Long = 0L
        private set

    @Volatile
    var framesWritten: Long = 0L
        private set

    /** Frames the encoder could not accept, or that overflowed [pkt]. */
    @Volatile
    var droppedFrames: Long = 0L
        private set

    init {
        val format = MediaFormat.createAudioFormat(MIME, requestedRate, requestedChannels)
        format.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
        format.setInteger(MediaFormat.KEY_BIT_RATE, bitRate)
        format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 32 * 1024)
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        codec.start()
    }

    /** Duration implied by what has actually been written, not by wall clock. */
    fun durationMs(): Long =
        if (adtsRate <= 0) 0L else framesWritten * 1024L * 1000L / adtsRate

    /**
     * Feeds one interleaved PCM16 block. Returns false if the encoder refused it
     * (which is a dropped frame, never a stall — see the invariant in [PcmRing]).
     */
    fun encode(pcm: ByteArray, size: Int): Boolean {
        if (closed || size <= 0) return false
        val idx = codec.dequeueInputBuffer(20_000L)
        if (idx < 0) {
            droppedFrames++
            drain(false)
            return false
        }
        val buf = codec.getInputBuffer(idx)
        if (buf == null) {
            droppedFrames++
            return false
        }
        // Go through java.nio.Buffer for clear()/position()/limit(): compiled against a
        // modern android.jar those resolve to the covariant ByteBuffer overrides added
        // in API 33, which do not exist on older devices (NoSuchMethodError at runtime).
        val asBuffer: Buffer = buf
        asBuffer.clear()
        buf.put(pcm, 0, size)
        codec.queueInputBuffer(idx, 0, size, ptsUs, 0)
        val frames = size / (2 * requestedChannels)
        ptsUs += frames.toLong() * 1_000_000L / requestedRate
        drain(false)
        return true
    }

    private fun drain(endOfStream: Boolean) {
        var guard = 0
        while (guard++ < 4096) {
            val outIdx = codec.dequeueOutputBuffer(info, if (endOfStream) 10_000L else 0L)
            if (outIdx >= 0) {
                val len = info.size
                val isConfig = (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
                if (len > 0 && !isConfig) {
                    if (len + 7 <= pkt.size) {
                        val ob = codec.getOutputBuffer(outIdx)
                        if (ob != null) {
                            val obBuffer: Buffer = ob
                            obBuffer.position(info.offset)
                            obBuffer.limit(info.offset + len)
                            writeAdtsHeader(len + 7)
                            ob.get(pkt, 7, len)
                            out.write(pkt, 0, len + 7)
                            bytesWritten += (len + 7).toLong()
                            framesWritten++
                        }
                    } else {
                        droppedFrames++
                    }
                }
                val flags = info.flags
                codec.releaseOutputBuffer(outIdx, false)
                if ((flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return
            } else if (outIdx == MediaCodec.INFO_TRY_AGAIN_LATER) {
                if (!endOfStream) return
            } else if (outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                // Trust what the encoder actually produced, not what we asked for —
                // an ADTS header that disagrees with the payload is unplayable.
                val f = codec.outputFormat
                try {
                    adtsRate = f.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                    adtsChannels = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                } catch (_: Throwable) {
                    // keep the requested values
                }
            }
        }
    }

    /** 7-byte ADTS header, protection absent. [packetLen] INCLUDES the header. */
    private fun writeAdtsHeader(packetLen: Int) {
        val profile = 2 // AAC-LC
        val freqIdx = freqIndex(adtsRate)
        val chanCfg = if (adtsChannels < 1) 1 else adtsChannels
        pkt[0] = 0xFF.toByte()
        pkt[1] = 0xF9.toByte()
        pkt[2] = (((profile - 1) shl 6) + (freqIdx shl 2) + (chanCfg shr 2)).toByte()
        pkt[3] = (((chanCfg and 3) shl 6) + (packetLen shr 11)).toByte()
        pkt[4] = ((packetLen and 0x7FF) shr 3).toByte()
        pkt[5] = (((packetLen and 7) shl 5) + 0x1F).toByte()
        pkt[6] = 0xFC.toByte()
    }

    /** Flushes the encoder and closes the file. Safe to call twice. */
    fun close() {
        if (closed) return
        closed = true
        try {
            val idx = codec.dequeueInputBuffer(20_000L)
            if (idx >= 0) {
                codec.queueInputBuffer(
                    idx, 0, 0, ptsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM,
                )
                drain(true)
            }
        } catch (_: Throwable) {
            // A wedged encoder must not cost us the bytes already on disk.
        }
        try { codec.stop() } catch (_: Throwable) {}
        try { codec.release() } catch (_: Throwable) {}
        try { out.flush() } catch (_: Throwable) {}
        try { out.close() } catch (_: Throwable) {}
    }
}

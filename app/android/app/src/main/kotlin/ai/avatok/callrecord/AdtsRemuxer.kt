package ai.avatok.callrecord

import android.media.MediaCodec
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.nio.Buffer
import java.nio.ByteBuffer

/**
 * [CALLREC-NATIVE-1] Turns the live ADTS stream into a `.m4a` container.
 *
 * This is the second half of the crash-safety design (spec §3.3): the recorder
 * writes self-framing ADTS while the call is live, and this remux runs once, on
 * stop — or on the next launch for a file a crash left behind ([orphans]).
 *
 * The remux is a pure container rewrite: AAC frames are copied verbatim, never
 * re-encoded, so it costs no quality and runs far faster than real time.
 */
internal object AdtsRemuxer {

    /** Result of a successful remux. */
    data class Remuxed(val file: File, val durationMs: Long, val bytes: Long)

    const val WORK_SUFFIX = ".aac"
    const val FINAL_SUFFIX = ".m4a"
    const val META_SUFFIX = ".meta"
    const val PREFIX = "callrec_"

    fun workFile(dir: File, safeId: String): File = File(dir, PREFIX + safeId + WORK_SUFFIX)

    fun finalFile(dir: File, safeId: String): File = File(dir, PREFIX + safeId + FINAL_SUFFIX)

    fun metaFile(dir: File, safeId: String): File = File(dir, PREFIX + safeId + META_SUFFIX)

    /** `callrec_<safeId>.aac` → `<safeId>`. */
    fun safeIdOf(work: File): String =
        work.name.removePrefix(PREFIX).removeSuffix(WORK_SUFFIX)

    /** File-system-safe form of an arbitrary call id. */
    fun sanitize(callId: String): String {
        val sb = StringBuilder(callId.length)
        for (ch in callId) {
            sb.append(
                if (ch.isLetterOrDigit() || ch == '-' || ch == '_' || ch == '.') ch else '_',
            )
        }
        val s = sb.toString()
        return if (s.isEmpty()) "unknown" else if (s.length > 96) s.substring(0, 96) else s
    }

    /**
     * Remuxes [work] into [target]. Deletes [work] on success. Returns null when the
     * file holds no decodable frames (a recording that never got off the ground) —
     * in which case both files are removed so nothing half-formed is reported.
     */
    fun remux(work: File, target: File): Remuxed? {
        if (!work.exists() || work.length() < 8L) {
            work.delete()
            return null
        }
        var muxer: MediaMuxer? = null
        var input: BufferedInputStream? = null
        var frames = 0L
        // Overwritten from the first ADTS header below; this is only the value used if
        // the file has no readable frame at all.
        var rate = CallRecorderPlugin.OUT_RATE
        try {
            val ins = BufferedInputStream(FileInputStream(work), 64 * 1024)
            input = ins
            val header = ByteArray(9)
            val payload = ByteBuffer.allocate(16 * 1024)
            // See AacAdtsWriter: clear()/position()/limit() must go through
            // java.nio.Buffer or the call binds to an API-33-only covariant override.
            val payloadBuffer: Buffer = payload
            val raw = ByteArray(16 * 1024)
            val info = MediaCodec.BufferInfo()
            var track = -1
            var started = false
            var channels = 1

            while (true) {
                if (!readFully(ins, header, 0, 7)) break
                if ((header[0].toInt() and 0xFF) != 0xFF ||
                    (header[1].toInt() and 0xF0) != 0xF0
                ) {
                    // Lost sync (a torn tail from a kill). Everything before this point
                    // is already valid, so stop here rather than discard the recording.
                    break
                }
                val protectionAbsent = (header[1].toInt() and 0x01) == 1
                val headerLen = if (protectionAbsent) 7 else 9
                val freqIdx = (header[2].toInt() and 0x3C) shr 2
                val chanCfg = ((header[2].toInt() and 0x01) shl 2) or
                    ((header[3].toInt() and 0xC0) shr 6)
                val frameLen = ((header[3].toInt() and 0x03) shl 11) or
                    ((header[4].toInt() and 0xFF) shl 3) or
                    ((header[5].toInt() and 0xFF) shr 5)
                if (frameLen <= headerLen || frameLen > raw.size) break
                if (!protectionAbsent && !readFully(ins, header, 7, 2)) break

                val dataLen = frameLen - headerLen
                if (!readFully(ins, raw, 0, dataLen)) break

                if (!started) {
                    rate = AacAdtsWriter.rateForIndex(freqIdx)
                    channels = if (chanCfg < 1) 1 else chanCfg
                    val mx = MediaMuxer(
                        target.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4,
                    )
                    muxer = mx
                    val format = MediaFormat.createAudioFormat(AacAdtsWriter.MIME, rate, channels)
                    format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, raw.size)
                    // AudioSpecificConfig for AAC-LC (audioObjectType = 2).
                    val csd = ByteArray(2)
                    csd[0] = (((2 shl 3) or (freqIdx shr 1)) and 0xFF).toByte()
                    csd[1] = ((((freqIdx and 0x01) shl 7) or (channels shl 3)) and 0xFF).toByte()
                    format.setByteBuffer("csd-0", ByteBuffer.wrap(csd))
                    track = mx.addTrack(format)
                    mx.start()
                    started = true
                }

                payloadBuffer.clear()
                payload.put(raw, 0, dataLen)
                payloadBuffer.position(0)
                payloadBuffer.limit(dataLen)
                info.offset = 0
                info.size = dataLen
                info.flags = MediaCodec.BUFFER_FLAG_KEY_FRAME
                info.presentationTimeUs = frames * 1024L * 1_000_000L / rate
                muxer!!.writeSampleData(track, payload, info)
                frames++
            }
        } catch (_: Throwable) {
            // Fall through: whatever was written before the failure still counts.
        } finally {
            try { input?.close() } catch (_: Throwable) {}
            val mx = muxer
            if (mx != null) {
                try { mx.stop() } catch (_: Throwable) {}
                try { mx.release() } catch (_: Throwable) {}
            }
        }

        if (frames <= 0L) {
            work.delete()
            target.delete()
            return null
        }
        work.delete()
        return Remuxed(target, frames * 1024L * 1000L / rate, target.length())
    }

    /** Working files a previous process left behind, excluding [activeSafeId]. */
    fun orphans(dir: File, activeSafeId: String?): List<File> {
        val list = dir.listFiles() ?: return emptyList()
        val out = ArrayList<File>()
        for (f in list) {
            if (!f.isFile) continue
            if (!f.name.startsWith(PREFIX) || !f.name.endsWith(WORK_SUFFIX)) continue
            if (activeSafeId != null && f.name == PREFIX + activeSafeId + WORK_SUFFIX) continue
            out.add(f)
        }
        return out
    }

    private fun readFully(input: BufferedInputStream, dst: ByteArray, off: Int, len: Int): Boolean {
        var read = 0
        while (read < len) {
            val n = input.read(dst, off + read, len - read)
            if (n <= 0) return false
            read += n
        }
        return true
    }
}

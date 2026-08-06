package ai.avatok.callrecord

import java.util.concurrent.atomic.AtomicLong

/**
 * [CALLREC-NATIVE-1] Bounded single-producer / single-consumer PCM16 ring.
 *
 * THE GOVERNING INVARIANT (spec §3.2): the producer is a WebRTC real-time audio
 * thread. [write] therefore NEVER blocks, NEVER allocates and NEVER logs. When the
 * ring is full it advances the read cursor — i.e. it DROPS THE OLDEST samples — and
 * keeps going. Backpressure is forbidden: a slow disk on a cheap phone must degrade
 * the recording, never the live conversation.
 *
 * `writeIndex` / `readIndex` are absolute, monotonic sample counts (not wrapped
 * offsets), because the mixer uses them to place this leg on a shared output
 * timeline. Dropping oldest advances `readIndex`, which is exactly right: those
 * samples were never consumed, and the timeline must not shift because of it.
 *
 * The overflow path is the one place the producer touches `readIndex`, so a
 * concurrent [read] can in principle copy a couple of samples that are being
 * overwritten underneath it. That is a torn frame in a recording that is already
 * dropping audio — deliberately accepted in exchange for a lock-free producer.
 */
internal class PcmRing(capacitySamples: Int) {

    private val cap: Int = if (capacitySamples < 1024) 1024 else capacitySamples
    private val buf = ShortArray(cap)
    private val wIdx = AtomicLong(0L)
    private val rIdx = AtomicLong(0L)

    /** Samples thrown away because the consumer fell behind. Producer-written only. */
    @Volatile
    var droppedSamples: Long = 0L
        private set

    fun writeIndex(): Long = wIdx.get()

    fun readIndex(): Long = rIdx.get()

    fun available(): Long {
        val a = wIdx.get() - rIdx.get()
        return if (a < 0L) 0L else if (a > cap) cap.toLong() else a
    }

    fun capacity(): Int = cap

    /** Producer — audio thread. Allocation-free, lock-free, drop-oldest on overflow. */
    fun write(src: ShortArray, count: Int) {
        if (count <= 0) return
        var n = count
        var srcOff = 0
        if (n > cap) {
            // A single batch larger than the whole ring: keep the newest tail.
            srcOff = n - cap
            droppedSamples += srcOff.toLong()
            n = cap
        }
        val w = wIdx.get()
        val free = cap - (w - rIdx.get())
        if (free < n) {
            val drop = n - free
            rIdx.addAndGet(drop)
            droppedSamples += drop
        }
        var pos = (w % cap).toInt()
        var i = 0
        while (i < n) {
            var chunk = n - i
            if (chunk > cap - pos) chunk = cap - pos
            System.arraycopy(src, srcOff + i, buf, pos, chunk)
            i += chunk
            pos += chunk
            if (pos >= cap) pos = 0
        }
        wIdx.set(w + n)
    }

    /** Consumer — mixer thread. Returns how many samples were actually copied. */
    fun read(dst: ShortArray, dstOff: Int, count: Int): Int {
        val avail = available()
        var n = if (count.toLong() < avail) count else avail.toInt()
        if (n <= 0) return 0
        if (dstOff + n > dst.size) n = dst.size - dstOff
        if (n <= 0) return 0
        val r = rIdx.get()
        var pos = (r % cap).toInt()
        var i = 0
        while (i < n) {
            var chunk = n - i
            if (chunk > cap - pos) chunk = cap - pos
            System.arraycopy(buf, pos, dst, dstOff + i, chunk)
            i += chunk
            pos += chunk
            if (pos >= cap) pos = 0
        }
        rIdx.addAndGet(n.toLong())
        return n
    }

    /** Consumer — discards up to [count] samples (used to shed stale backlog). */
    fun skip(count: Long): Long {
        if (count <= 0L) return 0L
        val avail = available()
        val n = if (count < avail) count else avail
        if (n > 0L) rIdx.addAndGet(n)
        return n
    }
}

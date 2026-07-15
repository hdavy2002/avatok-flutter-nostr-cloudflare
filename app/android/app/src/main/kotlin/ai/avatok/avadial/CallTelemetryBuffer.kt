package ai.avatok.avadial

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * [AVADIAL-CALL-INTEL-1] Durable, disk-backed buffer for call-intelligence events.
 *
 * WHY THIS EXISTS SEPARATELY FROM [AvaDialPlugin.track]:
 *
 *  1. DURABILITY. The existing `track()` spine is an in-memory
 *     ConcurrentLinkedQueue that "dies with the process — if the user never opens
 *     the app, the entries are lost, and that is an accepted trade." That trade is
 *     fine for SMS diagnostics. It is NOT fine for the data we intend to train a
 *     spam model on: the whole point of this pipeline is the calls from people who
 *     never open the app afterwards. So this one writes to disk.
 *
 *  2. PRIVACY ROUTING. `track()` goes straight to PostHog, and its hard rule is that
 *     no raw phone number may ever enter a props map. That rule stands. This buffer
 *     holds the RAW E.164 on purpose, and it does NOT go to PostHog — it goes to the
 *     AvaTOK Worker, which HMACs the number with a server-held secret before
 *     forwarding to PostHog, and keeps the raw copy only in the operational store.
 *
 *     The device must never compute the HMAC itself: a key shipped inside an APK is
 *     not a secret, and anyone who unpacks the app could dictionary-attack the whole
 *     number space — which is the exact thing the HMAC is there to prevent.
 *
 * WHY DISK IS AFFORDABLE HERE: nothing in this file runs while the call is live in
 * any way the user can feel. Events append during the call (a few hundred bytes to
 * app-private storage), and the upload happens AFTER hangup. There is no latency
 * budget to blow — the call is already over.
 *
 * Format is JSONL (one JSON object per line) so an append is a single write with no
 * read-modify-write of the whole file, and a truncated tail from a process death
 * costs exactly one event instead of the entire buffer.
 */
internal object CallTelemetryBuffer {

    private const val DIR = "avadial"
    private const val FILE = "call_telemetry.jsonl"

    /** Bounded: this is a buffer, not an archive. Oldest dropped first. */
    private const val MAX_EVENTS = 500
    private const val TTL_MS = 7L * 24 * 60 * 60 * 1000 // 7 days

    private val lock = Any()

    private fun file(ctx: Context): File {
        val dir = File(ctx.filesDir, DIR).apply { if (!exists()) mkdirs() }
        return File(dir, FILE)
    }

    /** Append one event. Safe from any thread, and from a process with no engine. */
    fun append(ctx: Context, event: JSONObject) {
        synchronized(lock) {
            try {
                if (!event.has("ts")) event.put("ts", System.currentTimeMillis())
                file(ctx).appendText(event.toString() + "\n")
                trimLocked(ctx)
            } catch (_: Throwable) { /* best-effort — never break a call over telemetry */ }
        }
    }

    /**
     * Read everything without removing it. Dart uploads first and only then calls
     * [clear] — so a failed upload retries next time instead of silently binning the
     * data. At-least-once beats at-most-once here; the Worker dedupes on `call_uuid`.
     */
    fun readAll(ctx: Context): List<Map<String, Any?>> = synchronized(lock) {
        try {
            val f = file(ctx)
            if (!f.exists() || f.length() == 0L) return emptyList()
            val cutoff = System.currentTimeMillis() - TTL_MS
            f.readLines().mapNotNull { line ->
                if (line.isBlank()) return@mapNotNull null
                try {
                    val o = JSONObject(line)
                    if (o.optLong("ts", 0L) < cutoff) null else jsonToMap(o)
                } catch (_: Throwable) {
                    null // a torn line from a process death — drop just that one
                }
            }
        } catch (_: Throwable) {
            emptyList()
        }
    }

    /** Drop everything the given upload covered. Called only after a 2xx. */
    fun clear(ctx: Context) {
        synchronized(lock) {
            try { file(ctx).delete() } catch (_: Throwable) { }
        }
    }

    fun pendingCount(ctx: Context): Int = synchronized(lock) {
        try {
            val f = file(ctx)
            if (!f.exists()) 0 else f.readLines().count { it.isNotBlank() }
        } catch (_: Throwable) { 0 }
    }

    /** Enforce the cap + TTL. Rewrites the file only when it's actually over. */
    private fun trimLocked(ctx: Context) {
        try {
            val f = file(ctx)
            val lines = f.readLines().filter { it.isNotBlank() }
            val cutoff = System.currentTimeMillis() - TTL_MS
            val fresh = lines.filter { line ->
                try { JSONObject(line).optLong("ts", 0L) >= cutoff } catch (_: Throwable) { false }
            }
            val capped = if (fresh.size > MAX_EVENTS) fresh.takeLast(MAX_EVENTS) else fresh
            if (capped.size != lines.size) {
                val tmp = File(f.parentFile, "$FILE.tmp")
                tmp.writeText(capped.joinToString("\n", postfix = "\n"))
                tmp.renameTo(f)
            }
        } catch (_: Throwable) { }
    }

    private fun jsonToMap(o: JSONObject): Map<String, Any?> {
        val out = HashMap<String, Any?>()
        val keys = o.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            out[k] = unwrap(o.get(k))
        }
        return out
    }

    private fun unwrap(v: Any?): Any? = when (v) {
        JSONObject.NULL, null -> null
        is JSONObject -> jsonToMap(v)
        is JSONArray -> (0 until v.length()).map { unwrap(v.get(it)) }
        else -> v
    }
}

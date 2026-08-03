package ai.avatok.avatok_call

import android.content.Context
import android.os.Bundle
import androidx.annotation.Keep
import androidx.core.app.NotificationManagerCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * [CALL-NATIVE-DECLINE-1]
 *
 * flutter_callkit_incoming 2.5.8 clears its notification when Decline is tapped,
 * then emits the action only to an in-memory Flutter EventChannel. If the app was
 * swiped away, there is no EventChannel sink and the decline disappears forever.
 *
 * The build-time locked plugin hook calls [enqueue] before attempting that lossy
 * Dart event. WorkManager makes the server notification independent of the Dart
 * VM and durable across process death. The server still owns authorization and
 * state: this bridge carries only a short-lived per-call capability.
 */
@Keep
object NativeCallDeclineBridge {
    private const val EXTRA_CALLKIT_EXTRA = "EXTRA_CALLKIT_EXTRA"
    private const val GUARD_PREFS = "avatok_callkit_action_guard"
    private const val PROGRAMMATIC_END_PREFIX = "programmatic_end:"
    private const val PROGRAMMATIC_END_TTL_MS = 90_000L
    private val allowedHosts = setOf("api.avatok.ai", "api-staging.avatok.ai")

    /**
     * Stamped by the build-locked flutter_callkit_incoming `endCall` hook before
     * that plugin broadcasts ACTION_CALL_DECLINE for an unaccepted call.
     *
     * SharedPreferences is intentional: the receiver and WorkManager worker can
     * run after the Flutter engine (and its in-memory Dart guard) is gone. A
     * synchronous commit makes the marker visible before the broadcast leaves
     * the plugin method that manufactured it.
     */
    @JvmStatic
    @Keep
    fun markProgrammaticEnd(context: Context, callId: String) {
        val normalized = callId.trim()
        if (normalized.isEmpty()) return
        val now = System.currentTimeMillis()
        val prefs = context.applicationContext.getSharedPreferences(GUARD_PREFS, Context.MODE_PRIVATE)
        val edit = prefs.edit().putLong(PROGRAMMATIC_END_PREFIX + normalized, now)
        if (prefs.all.size > 64) {
            for ((key, value) in prefs.all) {
                val stampedAt = value as? Long ?: continue
                if (now - stampedAt > PROGRAMMATIC_END_TTL_MS) edit.remove(key)
            }
        }
        edit.commit()
    }

    private fun wasProgrammaticEnd(context: Context, callId: String): Boolean {
        val key = PROGRAMMATIC_END_PREFIX + callId
        val prefs = context.applicationContext.getSharedPreferences(GUARD_PREFS, Context.MODE_PRIVATE)
        val stampedAt = prefs.getLong(key, 0L)
        if (stampedAt <= 0L) return false
        val age = System.currentTimeMillis() - stampedAt
        if (age in 0..PROGRAMMATIC_END_TTL_MS) return true
        prefs.edit().remove(key).apply()
        return false
    }

    /** Called by the patched receiver before either its native relay or Dart event. */
    @JvmStatic
    @Keep
    fun shouldSuppressProgrammaticDecline(context: Context, callkitData: Bundle): Boolean {
        @Suppress("DEPRECATION", "UNCHECKED_CAST")
        val extra = callkitData.getSerializable(EXTRA_CALLKIT_EXTRA) as? Map<String, Any?> ?: return false
        val callId = extra["callId"]?.toString()?.trim().orEmpty()
        return callId.isNotEmpty() && wasProgrammaticEnd(context, callId)
    }

    @JvmStatic
    @Keep
    fun enqueue(context: Context, callkitData: Bundle) {
        // The branded Flutter FSI is notification 8005, separate from the
        // plugin notification that invoked this receiver. Flutter may be dead,
        // so clear it natively before doing any parsing/network work.
        NotificationManagerCompat.from(context.applicationContext).cancel(8005)
        @Suppress("DEPRECATION", "UNCHECKED_CAST")
        val extra = callkitData.getSerializable(EXTRA_CALLKIT_EXTRA) as? Map<String, Any?> ?: return
        val callId = extra["callId"]?.toString()?.trim().orEmpty()
        // flutter_callkit_incoming maps Dart endCall() on an unaccepted ring to
        // ACTION_CALL_DECLINE. That is UI cleanup, not human intent. The hook in
        // patch_callkit_native_decline.py stamps this marker before broadcasting;
        // never turn the manufactured action into a server decline.
        if (callId.isNotEmpty() && wasProgrammaticEnd(context, callId)) return
        val token = extra["nativeActionToken"]?.toString()?.trim().orEmpty()
        val endpoint = extra["nativeDeclineUrl"]?.toString()?.trim().orEmpty()
        val expiresAt = extra["nativeActionExpiresAt"]?.toString()?.toLongOrNull() ?: 0L
        if (callId.isEmpty() || token.isEmpty() || !isAllowedEndpoint(endpoint)) return
        if (expiresAt > 0L && System.currentTimeMillis() >= expiresAt) return

        val request = OneTimeWorkRequestBuilder<NativeCallDeclineWorker>()
            .setInputData(workDataOf(
                "callId" to callId,
                "token" to token,
                "endpoint" to endpoint,
                "expiresAt" to expiresAt,
            ))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .build()

        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
            "avatok-native-decline-$callId",
            ExistingWorkPolicy.KEEP,
            request,
        )
    }

    private fun isAllowedEndpoint(raw: String): Boolean = try {
        val uri = URI(raw)
        uri.scheme == "https" && uri.host in allowedHosts &&
            uri.path == "/api/call/native-decline" && uri.query == null && uri.fragment == null
    } catch (_: Throwable) {
        false
    }
}

@Keep
class NativeCallDeclineWorker(
    context: Context,
    params: WorkerParameters,
) : Worker(context, params) {
    override fun doWork(): Result {
        val callId = inputData.getString("callId").orEmpty()
        val token = inputData.getString("token").orEmpty()
        val endpoint = inputData.getString("endpoint").orEmpty()
        val expiresAt = inputData.getLong("expiresAt", 0L)
        if (callId.isEmpty() || token.isEmpty() || endpoint.isEmpty()) return Result.failure()
        // The caller's own ring deadline is 45 seconds. A retry after the scoped
        // capability expires cannot improve the outcome and must not loop forever.
        if (expiresAt > 0L && System.currentTimeMillis() >= expiresAt) return Result.success()

        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 4_000
                readTimeout = 4_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
            }
            val body = JSONObject().put("callId", callId).put("token", token).toString()
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            when (connection.responseCode) {
                in 200..299, 403, 409 -> Result.success()
                in 500..599 -> Result.retry()
                else -> Result.failure()
            }
        } catch (_: Throwable) {
            Result.retry()
        } finally {
            connection?.disconnect()
        }
    }
}

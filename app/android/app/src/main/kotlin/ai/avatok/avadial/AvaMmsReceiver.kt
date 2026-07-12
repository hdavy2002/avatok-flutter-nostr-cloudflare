package ai.avatok.avadial

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Telephony

/**
 * Default-SMS-app inbound MMS receiver (AVA-SMS). Registered for
 * `WAP_PUSH_DELIVER_ACTION` with the `application/vnd.wap.mms-message` mime type and
 * protected by `BROADCAST_WAP_PUSH`. This is the fourth of the four mandatory
 * default-SMS components — WITHOUT it the ROLE_SMS request silently fails, even
 * though we do not do full MMS handling yet.
 *
 * SCOPE (intentionally minimal): acknowledge the WAP push and post a "MMS received"
 * notification. Full MMS download/parse (pointer → M-Retrieve.conf fetch over the
 * carrier APN, part decoding, attachment persistence) is DEFERRED — documented in
 * Specs/SPIKE-2026-07-12-avadial-telecom.md. We never drop or block the push; the
 * OS still records the MMS pointer in the provider.
 *
 * DARK behind the Flutter `avaSms` flag — only fires while AvaTOK holds ROLE_SMS.
 */
class AvaMmsReceiver : BroadcastReceiver() {

    companion object {
        private const val CHANNEL_ID = "avadial_sms"
        private const val NOTIF_ID = 42260
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.WAP_PUSH_DELIVER_ACTION) return
        try {
            // Best-effort telemetry hop to Flutter (full parse is out of scope).
            AvaDialPlugin.emit("onMmsReceived", mapOf("acknowledged" to true))
            notify(context)
        } catch (_: Throwable) {
            // Never crash the MMS pipeline.
        }
    }

    private fun notify(ctx: Context) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Text messages", NotificationManager.IMPORTANCE_HIGH)
            )
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(ctx, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(ctx)
        }
        val notif = builder
            .setSmallIcon(ctx.applicationInfo.icon)
            .setContentTitle("MMS received")
            .setContentText("A multimedia message arrived.")
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .build()
        try {
            nm.notify(NOTIF_ID, notif)
        } catch (_: Throwable) { /* best-effort */ }
    }
}

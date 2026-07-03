package ai.avatok.avavoiceaudio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import io.flutter.plugin.common.EventChannel

/**
 * CallForegroundService — keeps VoIP calls alive while backgrounded by running as a
 * foreground service with an ongoing-call notification. The notification shows a
 * chronometer (call timer) and a "Hang up" action that closes the call.
 *
 * Usage:
 *   val intent = Intent(context, CallForegroundService::class.java).apply {
 *       putExtra("callId", "...")
 *       putExtra("peerName", "...")
 *   }
 *   startForegroundService(intent)  // or startService() on older APIs
 *
 * Android requires:
 *   - android:foregroundServiceType="phoneCall|microphone" in manifest
 *   - FOREGROUND_SERVICE and FOREGROUND_SERVICE_PHONE_CALL permissions
 *   - POST_NOTIFICATIONS permission (for the notification to show)
 */
class CallForegroundService : Service() {
    companion object {
        const val CHANNEL_ID = "ongoing_call"
        const val NOTIFICATION_ID = 8001
        const val INTENT_HANG_UP = "HANG_UP"
    }

    private var callId: String = ""
    private var peerName: String = ""
    private var startTimeMs: Long = 0L
    private var isRunning = false

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == INTENT_HANG_UP) {
            // Hang-up action tapped in the notification.
            // CALLFIX-R4: emit hangup_requested event to Dart so the call can be ended there.
            callId = intent.getStringExtra("callId") ?: ""
            emitHangupEvent()
            isRunning = false
            stopSelf()
            return START_NOT_STICKY
        }

        // Normal start: begin or resume the service.
        callId = intent?.getStringExtra("callId") ?: ""
        peerName = intent?.getStringExtra("peerName") ?: "Unknown"
        if (startTimeMs == 0L) startTimeMs = System.currentTimeMillis()
        isRunning = true

        ensureNotificationChannel()
        startForegroundNotification()

        return START_STICKY
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Ongoing Calls",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Notifications for active voice calls"
                // Chronometer is enabled via setUsesChronometer on the notification
            }
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    private fun startForegroundNotification() {
        val hangUpIntent = Intent(this, CallForegroundService::class.java).apply {
            action = INTENT_HANG_UP
            putExtra("callId", callId)
        }
        val hangUpPendingIntent = PendingIntent.getService(
            this, callId.hashCode(),
            hangUpIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Intent to reopen the app when the notification is tapped.
        val launchIntent = Intent(this, ai.avatok.avatok_call.MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val launchPendingIntent = PendingIntent.getActivity(
            this, (callId + "_launch").hashCode(),
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notif = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Call with $peerName")
            .setContentText("Tap to return to the call")
            .setSmallIcon(android.R.drawable.ic_dialog_info) // Placeholder; replace with app's call icon
            .setContentIntent(launchPendingIntent)
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "Hang up",
                hangUpPendingIntent
            )
            .setUsesChronometer(true)
            .setShowWhen(true)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        try {
            startForeground(NOTIFICATION_ID, notif)
        } catch (e: Exception) {
            // On Android 12+, POST_NOTIFICATIONS permission may not be granted.
            // The service still runs in the background; the notification just won't show.
            // Silently continue.
        }
    }

    // CALLFIX-R4: Emit hangup_requested event to Dart via the call_hangup channel.
    // This allows the notification hang-up button to end the call in the app.
    private fun emitHangupEvent() {
        try {
            // Static reference to AvaVoiceAudioPlugin's method channel.
            // The plugin must expose a method channel that Dart listens to for hangup_requested events.
            // For now, use a broadcast or intent-based approach: send a broadcast that the plugin listens to.
            val hangupIntent = Intent("avatok.HANGUP_REQUESTED").apply {
                putExtra("callId", callId)
            }
            sendBroadcast(hangupIntent)
        } catch (_: Throwable) {
            // If emission fails, the call will end when stopSelf() is called anyway.
        }
    }

    override fun onDestroy() {
        isRunning = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}

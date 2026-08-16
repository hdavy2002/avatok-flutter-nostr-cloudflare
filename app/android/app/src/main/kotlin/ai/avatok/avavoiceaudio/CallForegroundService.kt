package ai.avatok.avavoiceaudio

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * CallForegroundService — keeps VoIP calls alive while backgrounded by running as a
 * foreground service with an ongoing-call notification. The notification shows a
 * chronometer (call timer) and a "Hang up" action that closes the call.
 *
 * CALL-BG-B: started at CALL SETUP (dial placed / incoming accepted) — NOT when P2P
 * connects — so a call backgrounded while still ringing/connecting survives. Stopped
 * exactly once, from CallSession.hangup() (via AvaVoiceAudioPlugin.stopCallForegroundService).
 *
 * Usage:
 *   val intent = Intent(context, CallForegroundService::class.java).apply {
 *       putExtra("callId", "...")
 *       putExtra("peerName", "...")
 *       putExtra("isVideo", false)
 *   }
 *   startForegroundService(intent)  // or startService() on older APIs
 *
 * Android requires:
 *   - android:foregroundServiceType="phoneCall|microphone|camera" in manifest
 *   - FOREGROUND_SERVICE, FOREGROUND_SERVICE_PHONE_CALL, FOREGROUND_SERVICE_MICROPHONE,
 *     FOREGROUND_SERVICE_CAMERA permissions
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
    private var isVideo: Boolean = false
    private var startTimeMs: Long = 0L
    private var isRunning = false

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == INTENT_HANG_UP) {
            // Hang-up action tapped in the notification.
            // CALLFIX-R4 / CALL-BG-B2: emit hangup_requested event to Dart so the call
            // can be ended there (CallSession.hangup()), then tear the FGS down.
            callId = intent.getStringExtra("callId") ?: callId
            emitHangupEvent()
            isRunning = false
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        // [CALL-FGS-GHOST-1 2026-08-16] A null intent means Android is
        // resurrecting a STICKY service after our process died (seen live when
        // the translation-start crash killed the app mid-call): there is no
        // call to resume — the engine and media died with the process — but the
        // restart used to post an "Unknown · 00:20 · tap to return to the call"
        // notification pointing at nothing, and it could not be dismissed
        // except via Hang up. A call FGS only makes sense when started by a
        // live call with extras; refuse the ghost.
        if (intent == null) {
            isRunning = false
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        // Normal start: begin or resume the service.
        callId = intent.getStringExtra("callId") ?: ""
        peerName = intent.getStringExtra("peerName") ?: "Unknown"
        isVideo = intent.getBooleanExtra("isVideo", false)
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

        // CALL-BG-B3: Intent to reopen the app when the notification is tapped, with
        // extras so Dart can route straight back to the active call screen instead of
        // just landing on whatever the last route was. MainActivity forwards these via
        // the avatok/voice_audio method channel as onNotificationTapReturnToCall(callId).
        val launchIntent = Intent(this, ai.avatok.avatok_call.MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("callId", callId)
            putExtra("from", "call_notification")
        }
        val launchPendingIntent = PendingIntent.getActivity(
            this, (callId + "_launch").hashCode(),
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // CALL-BG-B2: CATEGORY_CALL + setOngoing(true) + setUsesChronometer, with
        // Notification.when set to the real call start time (startTimeMs, captured
        // once in onStartCommand) so the timer reflects when the call actually
        // started, not when the notification was last rebuilt (e.g. on hangup-intent
        // updates or process restarts while the FGS is still alive).
        //
        // CALL-CHIP-1: on Android 12+ (API 31) use the platform CallStyle notification.
        // Only CallStyle earns the OS's ongoing-call status-bar chip (the green pill
        // with the timer next to the clock, Android 13/14+) that stays tappable from
        // ANY app — a plain CATEGORY_CALL builder never gets the chip, which is why
        // the only way back into an AvaTOK call from another app used to be the
        // notification shade. CallStyle renders its own Hang up button from the
        // pendingIntent we pass, so no explicit addAction on this path. The platform
        // builder (not NotificationCompat) is used deliberately: it has carried
        // CallStyle since API 31, so this compiles against whatever androidx.core
        // version the app has. Pre-31 devices keep the compat builder below (the
        // chip doesn't exist there anyway) — now with the real phone icon instead
        // of the ic_dialog_info placeholder.
        val notif = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val person = android.app.Person.Builder()
                .setName(if (peerName.isBlank()) "AvaTOK call" else peerName)
                .setImportant(true)
                .build()
            android.app.Notification.Builder(this, CHANNEL_ID)
                .setStyle(
                    android.app.Notification.CallStyle.forOngoingCall(
                        person, hangUpPendingIntent
                    )
                )
                .setCategory(android.app.Notification.CATEGORY_CALL)
                .setContentText("Tap to return to the call")
                .setSmallIcon(ai.avatok.avatok_call.R.drawable.ic_avadial_phone)
                .setContentIntent(launchPendingIntent)
                .setUsesChronometer(true)
                .setWhen(startTimeMs)
                .setShowWhen(true)
                .setOngoing(true)
                .build()
        } else {
            NotificationCompat.Builder(this, CHANNEL_ID)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setContentTitle("Call with $peerName")
                .setContentText("Tap to return to the call")
                .setSmallIcon(ai.avatok.avatok_call.R.drawable.ic_avadial_phone)
                .setContentIntent(launchPendingIntent)
                .addAction(
                    android.R.drawable.ic_menu_close_clear_cancel,
                    "Hang up",
                    hangUpPendingIntent
                )
                .setUsesChronometer(true)
                .setChronometerCountDown(false)
                .setWhen(startTimeMs)
                .setShowWhen(true)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build()
        }

        try {
            // CALL-BG-B4: on Android 14+ (API 34) ServiceCompat.startForeground must be
            // given the exact foregroundServiceType(s) actually in use — phoneCall +
            // microphone always, plus camera when it's a video call.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                if (isVideo) {
                    type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
                }
                ServiceCompat.startForeground(this, NOTIFICATION_ID, notif, type)
            } else {
                startForeground(NOTIFICATION_ID, notif)
            }
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
            // CALL-BG-B2: also deliver directly through the plugin's method channel
            // (when the Flutter engine/plugin instance is alive) so Dart's
            // onNotificationHangup callback fires even if nothing is listening for the
            // broadcast (e.g. broadcast delivery delayed while backgrounded).
            AvaVoiceAudioPlugin.notifyHangupRequested(callId)
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

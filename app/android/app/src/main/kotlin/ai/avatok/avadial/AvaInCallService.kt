package ai.avatok.avadial

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.telecom.Call
import android.telecom.CallAudioState
import android.telecom.InCallService

/**
 * Minimal default-dialer in-call surface (spike §2). Bound by the OS for every PSTN
 * call once ROLE_DIALER is held. It:
 *   - caches live [Call] objects keyed by a stable id;
 *   - forwards add/state/remove events to Flutter over `avatok/avadial`;
 *   - launches the full-screen incoming activity ([MainActivity] with a route
 *     extra) + a full-screen-intent notification as the OEM-safe fallback;
 *   - exposes answer/reject/disconnect/mute/speaker back to Flutter via [action].
 *
 * We NEVER touch emergency routing — outgoing calls are always placed via
 * TelecomManager.placeCall on the Dart side, so the platform's emergency flow stays
 * in force (spike §1).
 */
class AvaInCallService : InCallService() {

    companion object {
        private const val CHANNEL_ID = "avadial_incoming"
        private const val NOTIF_ID = 42110

        @Volatile
        private var instance: AvaInCallService? = null
        private val callMap = LinkedHashMap<String, Call>()

        private fun idFor(call: Call): String = System.identityHashCode(call).toString()

        /**
         * Relay an in-call action from Flutter. [id] targets a specific call
         * (answer/reject/disconnect); mute/speaker are service-wide. Returns true
         * when the action was dispatched.
         */
        fun action(id: String?, action: String, arg: Any?): Boolean {
            val svc = instance ?: return false
            return when (action) {
                "answer" -> id?.let { callMap[it]?.answer(android.telecom.VideoProfile.STATE_AUDIO_ONLY); true } ?: false
                "reject" -> id?.let { callMap[it]?.reject(false, null); true } ?: false
                "disconnect" -> id?.let { callMap[it]?.disconnect(); true } ?: false
                "setMuted" -> { svc.setMuted(arg == true); true }
                "setSpeaker" -> {
                    // NOTE: setAudioRoute is deprecated on API 34 in favour of
                    // CallEndpoint APIs — [verify in device testing on target SDK].
                    svc.setAudioRoute(
                        if (arg == true) CallAudioState.ROUTE_SPEAKER else CallAudioState.ROUTE_EARPIECE
                    )
                    true
                }
                // DTMF keypad: play the tone for the digit then stop it. [arg] is the
                // single-char digit ("0".."9","*","#") as a String from Dart.
                "dtmf" -> {
                    val digit = (arg as? String)?.firstOrNull() ?: return false
                    id?.let {
                        callMap[it]?.playDtmfTone(digit)
                        callMap[it]?.stopDtmfTone()
                        true
                    } ?: false
                }
                else -> false
            }
        }
    }

    override fun onCallAdded(call: Call) {
        super.onCallAdded(call)
        instance = this
        val id = idFor(call)
        callMap[id] = call
        call.registerCallback(callbackFor(id))

        val number = call.details?.handle?.schemeSpecificPart
        val direction = try {
            when (call.details?.callDirection) {
                Call.Details.DIRECTION_INCOMING -> "incoming"
                Call.Details.DIRECTION_OUTGOING -> "outgoing"
                else -> "unknown"
            }
        } catch (_: Throwable) {
            "unknown"
        }
        AvaDialPlugin.emit(
            "onCallAdded",
            mapOf("id" to id, "number" to number, "state" to stateName(call.state), "direction" to direction)
        )
        if (call.state == Call.STATE_RINGING || direction == "incoming") {
            launchIncoming(id, number)
        }
    }

    override fun onCallRemoved(call: Call) {
        super.onCallRemoved(call)
        val id = idFor(call)
        callMap.remove(id)
        AvaDialPlugin.emit("onCallRemoved", mapOf("id" to id))
        if (callMap.isEmpty()) {
            try {
                (getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)?.cancel(NOTIF_ID)
            } catch (_: Throwable) { /* best-effort */ }
        }
    }

    private fun callbackFor(id: String) = object : Call.Callback() {
        override fun onStateChanged(call: Call, state: Int) {
            AvaDialPlugin.emit("onCallState", mapOf("id" to id, "state" to stateName(state)))
        }
    }

    /**
     * Audio-route + mute report (drives the in-call UI's speaker/mute chips). Fired by
     * the OS whenever the route or mute state changes. `route` is "speaker" | "earpiece"
     * | "bluetooth" | "headset". Best-effort — a dead engine simply doesn't receive it.
     */
    override fun onCallAudioStateChanged(audioState: CallAudioState?) {
        super.onCallAudioStateChanged(audioState)
        val state = audioState ?: return
        val route = when (state.route) {
            CallAudioState.ROUTE_SPEAKER -> "speaker"
            CallAudioState.ROUTE_BLUETOOTH -> "bluetooth"
            CallAudioState.ROUTE_WIRED_HEADSET -> "headset"
            else -> "earpiece"
        }
        AvaDialPlugin.emit("onAudioRoute", mapOf("route" to route, "muted" to state.isMuted))
    }

    private fun stateName(state: Int): String = when (state) {
        Call.STATE_NEW -> "new"
        Call.STATE_RINGING -> "ringing"
        Call.STATE_DIALING -> "dialing"
        Call.STATE_ACTIVE -> "active"
        Call.STATE_HOLDING -> "holding"
        Call.STATE_DISCONNECTING -> "disconnecting"
        Call.STATE_DISCONNECTED -> "disconnected"
        Call.STATE_CONNECTING -> "connecting"
        else -> "unknown"
    }

    /**
     * Launch the Flutter incoming-call UI. Uses a full-screen-intent notification
     * (the reliable path on OEMs with aggressive battery management — spike §7) that
     * relaunches [MainActivity] with a route extra the shell reads.
     */
    private fun launchIncoming(id: String, number: String?) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID, "Incoming calls", NotificationManager.IMPORTANCE_HIGH
            )
            nm.createNotificationChannel(channel)
        }
        val intent = Intent(this, Class.forName("ai.avatok.avatok_call.MainActivity")).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra("route", "avadial/incoming")
            putExtra("call_id", id)
            putExtra("number", number)
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pending = PendingIntent.getActivity(this, NOTIF_ID, intent, flags)

        // [AVADIAL-LOCKSCREEN-1] Launch the call screen DIRECTLY, over the lock
        // screen. As the OS-bound default-dialer InCallService for this call we are
        // permitted to start the incoming-call activity from the background, so the
        // full-screen call UI appears WITHOUT the user opening the app — the way any
        // real phone app (and Truecaller) behaves. MainActivity is showWhenLocked +
        // turnScreenOn + singleTask, so this wakes the screen and reuses the task.
        // Previously we relied ONLY on the full-screen-intent notification below,
        // which Android 14+ and aggressive OEM skins silently demote to a heads-up
        // banner unless USE_FULL_SCREEN_INTENT is granted — which is why the screen
        // only showed once the app was opened manually. The FSI notification stays
        // as the OEM-safe fallback for the cases where a background launch is blocked.
        try {
            startActivity(intent)
        } catch (_: Throwable) {
            /* background-activity-launch blocked on this OEM — FSI notification below is the fallback */
        }

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val notif = builder
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle("Incoming call")
            .setContentText(number ?: "Unknown number")
            .setCategory(Notification.CATEGORY_CALL)
            .setOngoing(true)
            .setFullScreenIntent(pending, true)
            .setContentIntent(pending)
            .build()
        try {
            nm.notify(NOTIF_ID, notif)
        } catch (_: Throwable) { /* POST_NOTIFICATIONS may be denied — best-effort */ }
    }
}

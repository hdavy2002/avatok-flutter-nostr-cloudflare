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
        // [AVADIAL-NAME-1] Named missed-call notifications.
        private const val MISSED_CHANNEL_ID = "avadial_missed"
        private const val MISSED_NOTIF_TAG = "avadial_missed"
        // [AVADIAL-HARDEN-1] Internal (not private) — AvaCallActionReceiver cancels
        // this same notification id when the user taps "Decline".
        internal const val NOTIF_ID = 42110

        @Volatile
        private var instance: AvaInCallService? = null
        private val callMap = LinkedHashMap<String, Call>()

        // [AVADIAL-NAME-1] Calls that reached ACTIVE — an incoming call removed
        // WITHOUT ever going active is a missed call (drives the named missed-call
        // notification). Keyed by our stable call id.
        private val sawActive = HashSet<String>()
        private val incomingIds = HashSet<String>()

        private fun idFor(call: Call): String = System.identityHashCode(call).toString()

        /**
         * [AVADIAL-STUCK-1] Live state of a cached call, or null when the call is gone
         * (removed / never existed). Lets the plugin drop a stale pending incoming
         * launch and lets PstnCallScreen verify its call on mount instead of trusting
         * a possibly-minutes-old launch extra.
         */
        fun stateOf(id: String): String? {
            val call = callMap[id] ?: return null
            return when (call.state) {
                Call.STATE_RINGING -> "ringing"
                Call.STATE_ACTIVE -> "active"
                Call.STATE_DIALING -> "dialing"
                Call.STATE_HOLDING -> "holding"
                Call.STATE_CONNECTING -> "connecting"
                Call.STATE_DISCONNECTING -> "disconnecting"
                Call.STATE_DISCONNECTED -> "disconnected"
                else -> "unknown"
            }
        }

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
        // [AVADIAL-HARDEN-3] Pick up the screening verdict AvaCallScreeningService
        // stashed for this same number (moments earlier, in the OS's pre-answer
        // screening window) so PstnCallScreen can paint the red spam UI instead of
        // it being unreachable.
        val verdict = number?.let { AvaCallScreeningService.takeVerdict(it) }
        AvaDialPlugin.emit(
            "onCallAdded",
            mapOf(
                "id" to id, "number" to number, "state" to stateName(call.state), "direction" to direction,
                "spam_score" to verdict?.score, "spam_bucket" to verdict?.bucket,
            )
        )
        if (call.state == Call.STATE_RINGING || direction == "incoming") {
            incomingIds.add(id)
            launchIncoming(id, number, verdict?.score, verdict?.bucket)
        }
    }

    override fun onCallRemoved(call: Call) {
        super.onCallRemoved(call)
        val id = idFor(call)
        callMap.remove(id)
        // [AVADIAL-STUCK-1] The call is dead — a pending incoming launch for it must
        // never be drained by a later app open (ghost ringing screen).
        AvaDialPlugin.clearPendingIncoming(id)
        // [AVADIAL-NATIVE-RING-1] Tear down the native ringing screen the moment the
        // call dies — no ghost screens, ever.
        IncomingCallActivity.closeFor(id)
        AvaDialPlugin.emit("onCallRemoved", mapOf("id" to id))

        // [AVADIAL-NAME-1] Incoming call that never went active = missed call. Post a
        // notification that says WHO called, not just "missed call" (owner request
        // 2026-07-14, pic 3). Best-effort; the OS/Telecom one may appear alongside.
        val wasIncoming = incomingIds.remove(id)
        val wasActive = sawActive.remove(id)
        if (wasIncoming && !wasActive) {
            postMissedCallNotification(call.details?.handle?.schemeSpecificPart)
        }

        if (callMap.isEmpty()) {
            try {
                (getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)?.cancel(NOTIF_ID)
            } catch (_: Throwable) { /* best-effort */ }
        }
    }

    private fun callbackFor(id: String) = object : Call.Callback() {
        override fun onStateChanged(call: Call, state: Int) {
            if (state == Call.STATE_ACTIVE) {
                sawActive.add(id)
                // [AVADIAL-NATIVE-RING-1] Answered (here, from the notification, or
                // from Flutter) — swap the native ringing screen for the in-call UI.
                IncomingCallActivity.onCallActive(id)
            }
            AvaDialPlugin.emit("onCallState", mapOf("id" to id, "state" to stateName(state)))
        }
    }

    /**
     * [AVADIAL-NAME-1] Contact display name for [number] via ContactsContract
     * PhoneLookup. Null when unknown / READ_CONTACTS not granted / lookup fails.
     */
    private fun displayNameFor(number: String?): String? {
        if (number.isNullOrEmpty()) return null
        return try {
            val uri = android.net.Uri.withAppendedPath(
                android.provider.ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
                android.net.Uri.encode(number),
            )
            contentResolver.query(
                uri,
                arrayOf(android.provider.ContactsContract.PhoneLookup.DISPLAY_NAME),
                null, null, null,
            )?.use { c -> if (c.moveToFirst()) c.getString(0)?.takeIf { it.isNotBlank() } else null }
        } catch (_: Throwable) {
            null
        }
    }

    /**
     * [AVADIAL-NAME-1] "Missed call · <name>" notification with the caller's contact
     * name and number. Tapping it opens the app on the caller (avadial/openDial route,
     * same path the missed-call overlay uses). One notification per number.
     */
    private fun postMissedCallNotification(number: String?) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(
                    MISSED_CHANNEL_ID, "Missed calls", NotificationManager.IMPORTANCE_DEFAULT
                )
            )
        }
        val name = displayNameFor(number)
        val who = name ?: number ?: "Unknown number"
        val tapIntent = try {
            Intent(this, Class.forName("ai.avatok.avatok_call.MainActivity")).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra("route", "avadial/openDial")
                putExtra("number", number)
            }
        } catch (_: Throwable) { null } ?: return
        val pending = PendingIntent.getActivity(
            this,
            (number ?: who).hashCode(),
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, MISSED_CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val notif = b
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle("Missed call · $who")
            .setContentText(if (name != null && number != null) number else "Tap to call back or message")
            .setCategory(Notification.CATEGORY_MISSED_CALL)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        try {
            nm.notify(MISSED_NOTIF_TAG, (number ?: who).hashCode(), notif)
        } catch (_: Throwable) { /* POST_NOTIFICATIONS denied — best-effort */ }
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
    private fun launchIncoming(id: String, number: String?, spamScore: Int? = null, spamBucket: String? = null) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID, "Incoming calls", NotificationManager.IMPORTANCE_HIGH
            )
            nm.createNotificationChannel(channel)
        }
        // [AVADIAL-NATIVE-RING-1] The ringing UI is now the dedicated native
        // IncomingCallActivity — NOT MainActivity/Flutter. Opening the whole app
        // meant landing on the messenger root with the setup sheet popping over the
        // call (owner bug 2026-07-14). The native screen needs no engine, shows the
        // caller's contact name, and finishes itself when the call dies. MainActivity
        // is only involved AFTER answer (in-call UI, answered=true).
        val callerName = displayNameFor(number)
        val intent = Intent(this, IncomingCallActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra("call_id", id)
            putExtra("number", number)
            if (callerName != null) putExtra("name", callerName)
            // [AVADIAL-HARDEN-3] Screening verdict → red spam paint on the native screen.
            if (spamScore != null) putExtra("spam_score", spamScore)
            if (spamBucket != null) putExtra("spam_bucket", spamBucket)
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
        var startedActivity = true
        try {
            startActivity(intent)
        } catch (_: Throwable) {
            /* background-activity-launch blocked on this OEM — FSI notification below is the fallback */
            startedActivity = false
        }

        // [AVADIAL-POPUP-1] Android 14+ gates full-screen intents behind a per-app
        // grant (Settings > Apps > Special access > Full-screen notifications). When
        // it's missing, the FSI silently degrades to a plain banner — record it so
        // telemetry can prove which leg failed on a given device, and so the setup
        // sheet can prompt the user to grant it.
        val fsiAllowed = if (Build.VERSION.SDK_INT >= 34) {
            try { nm.canUseFullScreenIntent() } catch (_: Throwable) { true }
        } else true
        AvaDialPlugin.emit(
            "onIncomingLaunchDiag",
            mapOf(
                "call_id" to id,
                "start_activity" to startedActivity,
                "fsi_allowed" to fsiAllowed,
                "notifs_enabled" to nm.areNotificationsEnabled(),
                "sdk" to Build.VERSION.SDK_INT,
            ),
        )

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        // [AVADIAL-HARDEN-1] Answer/Decline actions — the fallback for when Android
        // 14+/OEM skins demote the full-screen intent to a plain heads-up banner,
        // which otherwise leaves the user nothing to tap. Distinct request codes
        // (NOTIF_ID+1/+2) so the two PendingIntents never collide/overwrite each other.
        fun actionIntent(action: String, requestCode: Int): PendingIntent {
            val i = Intent(this, AvaCallActionReceiver::class.java).apply {
                setAction(AvaCallActionReceiver.ACTION_CALL_ACTION)
                putExtra(AvaCallActionReceiver.EXTRA_CALL_ID, id)
                putExtra(AvaCallActionReceiver.EXTRA_NUMBER, number)
                putExtra(AvaCallActionReceiver.EXTRA_ACTION, action)
            }
            return PendingIntent.getBroadcast(this, requestCode, i, flags)
        }
        val actionIcon = android.graphics.drawable.Icon.createWithResource(this, applicationInfo.icon)
        val answerAction = Notification.Action.Builder(
            actionIcon, "Answer", actionIntent("answer", NOTIF_ID + 1)
        ).build()
        val declineAction = Notification.Action.Builder(
            actionIcon, "Decline", actionIntent("reject", NOTIF_ID + 2)
        ).build()

        builder
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle("Incoming call")
            .setContentText(callerName ?: number ?: "Unknown number")
            .setCategory(Notification.CATEGORY_CALL)
            .setOngoing(true)
            .setFullScreenIntent(pending, true)
            .setContentIntent(pending)

        // [AVADIAL-POPUP-1] On Android 12+ use the system CallStyle template — it is
        // ranked at the very top of the shade, always heads-up, and is the ONLY
        // notification style OEM skins reliably surface over a foreground app (the
        // WhatsApp-style incoming banner). Falls back to plain Answer/Decline actions
        // on older releases.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // [AVADIAL-NAME-1] Show WHO is calling on the banner — contact name when
            // we have one, the number otherwise (owner bug 2026-07-14, pic 2).
            val caller = android.app.Person.Builder()
                .setName(callerName ?: number ?: "Unknown number")
                .setImportant(true)
                .build()
            builder.setStyle(
                Notification.CallStyle.forIncomingCall(
                    caller,
                    actionIntent("reject", NOTIF_ID + 2),
                    actionIntent("answer", NOTIF_ID + 1),
                )
            )
        } else {
            builder.addAction(answerAction).addAction(declineAction)
        }
        val notif = builder.build()
        try {
            nm.notify(NOTIF_ID, notif)
        } catch (_: Throwable) { /* POST_NOTIFICATIONS may be denied — best-effort */ }
    }
}

package ai.avatok.avadial

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
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

        /**
         * [AVADIAL-CALL-INTEL-1] Per-call intelligence record, keyed by the same local
         * id as [callMap]. Holds the REAL uuid, the timings, and the actions taken.
         *
         * The local id below stays `System.identityHashCode(call)` because every
         * existing caller (plugin, activities, notification receiver) is built on it —
         * but that is a memory-address hash: it can collide and means nothing once the
         * process dies. So it is a map key ONLY. Anything durable uses [CallRecord.uuid].
         */
        private val records = LinkedHashMap<String, CallRecord>()

        private fun idFor(call: Call): String = System.identityHashCode(call).toString()

        internal fun recordFor(id: String): CallRecord? = records[id]

        /**
         * [AVADIAL-CALL-INTEL-1] Note that the user physically tapped Answer, so we can
         * measure tap → STATE_ACTIVE. That gap is the entire reason the answer path was
         * rearchitected: it used to be dead, silent time with no feedback.
         */
        internal fun noteAnswerTapped(id: String) {
            records[id]?.let { if (it.answerTappedAt == null) it.answerTappedAt = System.currentTimeMillis() }
        }

        internal fun noteAction(id: String, action: String) {
            records[id]?.addAction(action)
        }

        // [AVADIAL-INCALL-ANSWER-1] uiReady handshake (Fix 4). InCallActivity is a
        // disposable VIEW; this is the honest signal that a screen actually
        // rendered, not just that we asked Android to show one — the old
        // `start_activity: true` diagnostic proved nothing (spike: SystemUI/Android
        // silently drops background launches with no exception). Keyed by callId.
        private val main = Handler(Looper.getMainLooper())
        private val ackedCallIds = HashSet<String>()
        private val watchdogRunnables = HashMap<String, Runnable>()

        /**
         * InCallActivity calls this once its content view is set, on every launch
         * path (answer, viewer attach, call-waiting re-launch, rotation). ONE-SHOT
         * per callId — the first ack wins; duplicates (rotation, config change,
         * process recreation) are ignored so they can't re-arm anything or double
         * count in telemetry.
         */
        fun uiReady(callId: String) {
            if (!ackedCallIds.add(callId)) return
            cancelWatchdog(callId)
        }

        /**
         * Arm a 3s watchdog for [callId] on launch path [path]. If [uiReady] has not
         * landed by the time it fires, the UI that was supposed to surface silently
         * failed to render — telemetry only (`ui_watchdog_fired`), no behavioral
         * change; the service-owned notification already covers the call either way.
         * Cancelled immediately by [uiReady] and by [onCallRemoved] — must never
         * fire after a successful ack or after the call is gone.
         */
        private fun armWatchdog(callId: String, path: String) {
            cancelWatchdog(callId)
            val r = Runnable {
                watchdogRunnables.remove(callId)
                if (ackedCallIds.contains(callId)) return@Runnable // acked in the meantime
                val state = stateOf(callId) ?: "gone"
                noteAction(callId, "ui_watchdog_fired:$path:$state:${Build.MANUFACTURER}/${Build.MODEL}")
            }
            watchdogRunnables[callId] = r
            main.postDelayed(r, 3000L)
        }

        private fun cancelWatchdog(callId: String) {
            watchdogRunnables.remove(callId)?.let { main.removeCallbacks(it) }
        }

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
                "answer" -> id?.let {
                    noteAnswerTapped(it)
                    noteAction(it, "answered")
                    callMap[it]?.answer(android.telecom.VideoProfile.STATE_AUDIO_ONLY); true
                } ?: false
                // [AVADIAL-INCALL-NOTIF-1] FIX 3 — the semantic vocabulary. UI
                // components (notification, native screens, Flutter) never choose a
                // Telecom API directly; they send "end_call" and the service maps
                // state → API. reject() is only valid while ringing — wired to any
                // other state it is a silent no-op, which is exactly how a live call
                // ended up with no working Hang Up button. IDEMPOTENT: a missing/gone
                // call (double-tap after the call already tore down) is ignored, not
                // thrown.
                "end_call" -> {
                    if (id == null) {
                        false
                    } else {
                        val callState = stateOf(id)
                        when (callState) {
                            "ringing" -> {
                                // Same first-writer-wins guard as the "reject" alias
                                // below — IncomingCallActivity.block() may already have
                                // stamped finalState = "blocked" before relaying here;
                                // never overwrite a more specific disposition.
                                records[id]?.let { r -> if (r.finalState == null) r.finalState = "rejected" }
                                noteAction(id, "end_call")
                                callMap[id]?.reject(false, null)
                                true
                            }
                            null -> {
                                // Call already gone — most likely a double-tap on a
                                // notification/UI button that already fired once, or a
                                // race with the remote hanging up. Never throw.
                                noteAction(id, "end_call_ignored_no_call")
                                true
                            }
                            else -> {
                                // dialing / active / holding / connecting / etc.
                                noteAction(id, "end_call")
                                callMap[id]?.disconnect()
                                true
                            }
                        }
                    }
                }
                // DEPRECATED — internal aliases only, kept for migration safety. New
                // callers (notification actions, native screens, Flutter) must send
                // "end_call"; the service alone decides reject() vs disconnect() by
                // state. Made state-defensive so a missed/future call site that still
                // sends the raw verb cannot regress into the reject()-on-active no-op
                // that originally made "Hang Up" do nothing.
                "reject" -> id?.let {
                    if (stateOf(it) != "ringing") {
                        noteAction(it, "disconnect_via_reject_alias")
                        callMap[it]?.disconnect()
                        return@let true
                    }
                    noteAction(it, "rejected")
                    // NON-DESTRUCTIVE on purpose. Block/Report call decline() to hang
                    // up, so they route through here — and if this overwrote the state
                    // unconditionally, a blocked call would always be recorded as a
                    // plain "rejected" one. That would silently starve the
                    // idx_call_intel_bucket training slice: zero blocked calls, forever.
                    // First writer wins; the caller sets the more specific value first.
                    records[it]?.let { r -> if (r.finalState == null) r.finalState = "rejected" }
                    callMap[it]?.reject(false, null); true
                } ?: false
                // DEPRECATED — internal alias only, see "reject" above. New callers
                // must send "end_call".
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
                // [AVADIAL-NATIVE-INCALL-1] Hold/unhold. The state was already READ and
                // surfaced ("holding"), but nothing could ever trigger it — the Flutter
                // in-call screen showed an "On hold" status the user had no way to reach.
                "hold" -> id?.let {
                    noteAction(it, "held")
                    callMap[it]?.hold(); true
                } ?: false
                "unhold" -> id?.let {
                    noteAction(it, "unheld")
                    callMap[it]?.unhold(); true
                } ?: false
                /**
                 * [AVADIAL-NATIVE-INCALL-1] Explicit route selection, replacing the
                 * speaker-only toggle. `setSpeaker` could only ever pick
                 * SPEAKER↔EARPIECE, so a call on AirPods rendered identically to one
                 * on the earpiece and the user had no way to see or change it.
                 * [arg] is "earpiece" | "speaker" | "bluetooth" | "headset".
                 */
                "setAudioRoute" -> {
                    val route = when (arg as? String) {
                        "speaker" -> CallAudioState.ROUTE_SPEAKER
                        "bluetooth" -> CallAudioState.ROUTE_BLUETOOTH
                        "headset" -> CallAudioState.ROUTE_WIRED_HEADSET
                        else -> CallAudioState.ROUTE_EARPIECE
                    }
                    svc.setAudioRoute(route)
                    true
                }
                // [AVADIAL-INCALL-NOTIF-1] FIX 2/3 — notification Mute/Speaker buttons.
                // Read the CURRENT OS-reported state and flip it, rather than trusting
                // any UI's cached idea of it — the notification can outlive the
                // activity that would otherwise track this locally. Idempotent by
                // construction (reads fresh each call) and never throws even with no
                // live call (setMuted/setAudioRoute are service-wide, not call-keyed).
                "mute_toggle" -> {
                    svc.setMuted(!(svc.callAudioState?.isMuted == true))
                    true
                }
                "speaker_toggle" -> {
                    val onSpeaker = svc.callAudioState?.route == CallAudioState.ROUTE_SPEAKER
                    svc.setAudioRoute(
                        if (onSpeaker) CallAudioState.ROUTE_EARPIECE else CallAudioState.ROUTE_SPEAKER
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

        /**
         * [AVADIAL-NATIVE-INCALL-1] Routes this device/call actually supports right
         * now, so the in-call screen can cycle only through real options instead of
         * offering bluetooth on a phone with nothing paired.
         */
        fun supportedRoutes(): List<String> {
            val mask = instance?.callAudioState?.supportedRouteMask ?: return listOf("earpiece", "speaker")
            val out = ArrayList<String>()
            if (mask and CallAudioState.ROUTE_EARPIECE != 0) out.add("earpiece")
            if (mask and CallAudioState.ROUTE_SPEAKER != 0) out.add("speaker")
            if (mask and CallAudioState.ROUTE_WIRED_HEADSET != 0) out.add("headset")
            if (mask and CallAudioState.ROUTE_BLUETOOTH != 0) out.add("bluetooth")
            return if (out.isEmpty()) listOf("earpiece", "speaker") else out
        }

        fun currentRoute(): String = when (instance?.callAudioState?.route) {
            CallAudioState.ROUTE_SPEAKER -> "speaker"
            CallAudioState.ROUTE_BLUETOOTH -> "bluetooth"
            CallAudioState.ROUTE_WIRED_HEADSET -> "headset"
            else -> "earpiece"
        }

        fun isMuted(): Boolean = instance?.callAudioState?.isMuted == true

        /** Human label for the active route — drives the in-call route chip. */
        fun routeLabel(route: String): String = when (route) {
            "speaker" -> "Speaker"
            "bluetooth" -> "Bluetooth"
            "headset" -> "Headset"
            else -> "Earpiece"
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

        // [AVADIAL-CALL-INTEL-1] Open the intelligence record for this call. Everything
        // below is a local read — no network, no engine — because the OS is holding a
        // ringing call and the Flutter side may not exist.
        val callerName = displayNameFor(number)
        records[id] = CallRecord(localId = id, number = number, direction = direction).apply {
            contactName = callerName
            contactExists = callerName != null
            spamScore = verdict?.score
            spamBucket = verdict?.bucket
            captureTelephony(this@AvaInCallService)
        }

        AvaDialPlugin.emit(
            "onCallAdded",
            mapOf(
                "id" to id, "number" to number, "state" to stateName(call.state), "direction" to direction,
                "spam_score" to verdict?.score, "spam_bucket" to verdict?.bucket,
                "call_uuid" to records[id]?.uuid,
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
        // [AVADIAL-NATIVE-INCALL-1] Same for the native in-call screen.
        InCallActivity.closeFor(id)
        // [AVADIAL-INCALL-ANSWER-1] Never let a watchdog fire after the call is
        // gone, and don't let a stale ack linger past the call it belonged to.
        cancelWatchdog(id)
        ackedCallIds.remove(id)
        AvaDialPlugin.emit("onCallRemoved", mapOf("id" to id))

        // [AVADIAL-NAME-1] Incoming call that never went active = missed call. Post a
        // notification that says WHO called, not just "missed call" (owner request
        // 2026-07-14, pic 3). Best-effort; the OS/Telecom one may appear alongside.
        val wasIncoming = incomingIds.remove(id)
        val wasActive = sawActive.remove(id)
        if (wasIncoming && !wasActive) {
            postMissedCallNotification(call.details?.handle?.schemeSpecificPart)
        }

        // [AVADIAL-CALL-INTEL-1] Close the record and flush it to the durable buffer.
        // This is the ONLY place a call_completed row is produced, so every call —
        // answered, missed, rejected, blocked — lands exactly once.
        records.remove(id)?.let { rec ->
            rec.endedAt = System.currentTimeMillis()
            if (rec.finalState == null) {
                rec.finalState = when {
                    wasActive -> "answered"
                    // NOTE: "voicemail" is deliberately absent. PSTN voicemail is
                    // carrier-side — Telecom never tells us it happened, so the dialer
                    // cannot observe it. It has to be inferred server-side or dropped.
                    wasIncoming -> "missed"
                    else -> "failed"
                }
            }
            try {
                val json = rec.toCompletedJson(applicationContext)
                AvaDialPlugin.identityOf(applicationContext).forEach { (k, v) ->
                    if (v != null) json.put(k, v)
                }
                CallTelemetryBuffer.append(applicationContext, json)
            } catch (_: Throwable) { /* telemetry must never break call teardown */ }

            // Live nudge so Dart uploads promptly when the app happens to be open.
            // When it isn't, the buffer just waits on disk for the next boot — which
            // is exactly the case this pipeline exists to capture.
            AvaDialPlugin.emit("onCallTelemetryReady", mapOf("call_uuid" to rec.uuid))
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
                // [AVADIAL-CALL-INTEL-1] Stamp the moment the call actually connected —
                // this closes the answer_delay_ms measurement started at the Answer tap.
                records[id]?.let { if (it.activeAt == null) it.activeAt = System.currentTimeMillis() }
                // [AVADIAL-NATIVE-RING-1] Answered (here, from the notification, or
                // from Flutter) — swap the native ringing screen for the in-call UI.
                IncomingCallActivity.onCallActive(id)
                // [AVADIAL-INCALL-ANSWER-1] A UI is now expected to surface (the
                // in-call screen taking over from the ringing one). Arm the 3s
                // watchdog; uiReady() cancels it the moment InCallActivity actually
                // renders.
                armWatchdog(id, "call_active")
                // [AVADIAL-INCALL-NOTIF-1] FIX 2 — the guaranteed floor. Post/replace
                // the ongoing CallStyle notification on the SAME NOTIF_ID as the
                // ringing notification, so this atomically replaces it — there is no
                // window where the stale *ringing* notification (whose Decline maps
                // to a no-op reject() once active) is the only control surface. Also
                // fires again here when a held call returns to ACTIVE (the "unhold"
                // refresh case).
                postOngoingNotification(id)
            } else if (state == Call.STATE_HOLDING) {
                // [AVADIAL-INCALL-NOTIF-1] Refresh the notification so it reflects
                // hold instead of silently ticking on as if nothing changed.
                postOngoingNotification(id)
            }
            // [AVADIAL-NATIVE-INCALL-1] Keep the native in-call screen in step with
            // Telecom (hold/unhold, remote hangup). No-op when it isn't showing.
            InCallActivity.onCallState(id, stateName(state))
            AvaDialPlugin.emit("onCallState", mapOf("id" to id, "state" to stateName(state)))
        }
    }

    /**
     * [AVADIAL-INCALL-NOTIF-1] FIX 2 — the guaranteed floor. Builds and posts the
     * ongoing-call notification on [NOTIF_ID] so it atomically replaces whatever
     * ringing notification was there. UNCONDITIONAL — not gated on
     * [AvaDialPlugin.nativeInCallEnabled]: even with the native screen flag off, and
     * even if every UI surface (Flutter, native screen) crashes or is swiped away,
     * this notification is the one thing that survives for the entire life of the
     * call and every action on it is idempotent (see [action]'s "end_call" branch).
     *
     * Every action routed through here sends a SEMANTIC verb ("end_call",
     * "mute_toggle", "speaker_toggle") — never "disconnect"/"reject" — because this
     * notification has no idea what Telecom state the call is in; only the service
     * does (Fix 3).
     */
    private fun postOngoingNotification(id: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        try {
            val call = callMap[id]
            val number = call?.details?.handle?.schemeSpecificPart
            val rec = records[id]
            val callerName = rec?.contactName ?: displayNameFor(number)
            val who = callerName ?: number ?: "Unknown number"
            val holding = call?.state == Call.STATE_HOLDING

            val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            fun actionIntent(action: String, requestCode: Int): PendingIntent {
                val i = Intent(this, AvaCallActionReceiver::class.java).apply {
                    setAction(AvaCallActionReceiver.ACTION_CALL_ACTION)
                    putExtra(AvaCallActionReceiver.EXTRA_CALL_ID, id)
                    putExtra(AvaCallActionReceiver.EXTRA_NUMBER, number)
                    putExtra(AvaCallActionReceiver.EXTRA_ACTION, action)
                }
                return PendingIntent.getBroadcast(this, requestCode, i, flags)
            }
            // Distinct request codes from the ringing notification's Answer/Decline
            // (NOTIF_ID+1/+2, see launchIncoming) so none of these PendingIntents
            // collide or overwrite each other.
            val hangupPending = actionIntent("end_call", NOTIF_ID + 3)
            val mutePending = actionIntent("mute_toggle", NOTIF_ID + 4)
            val speakerPending = actionIntent("speaker_toggle", NOTIF_ID + 5)

            // Tapping the body (or the full-screen intent auto-raising over a locked
            // device) opens the in-call screen WITHOUT re-answering — no EXTRA_ANSWER
            // here, unlike the ringing notification's Answer action.
            val bodyPending = PendingIntent.getActivity(
                this, NOTIF_ID + 6, InCallActivity.intentFor(this, id, number), flags,
            )

            val actionIcon = android.graphics.drawable.Icon.createWithResource(this, applicationInfo.icon)
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(this, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(this)
            }

            builder
                .setSmallIcon(applicationInfo.icon)
                .setContentTitle(who)
                .setContentText(
                    when {
                        holding -> "On hold"
                        callerName != null && number != null -> number
                        else -> "Ongoing call"
                    }
                )
                .setCategory(Notification.CATEGORY_CALL)
                .setOngoing(true)
                // [AVADIAL-INCALL-NOTIF-1] This notification is re-posted on every
                // hold/unhold refresh on the same NOTIF_ID/channel — without this,
                // each refresh re-alerts (sound/heads-up) mid-call.
                .setOnlyAlertOnce(true)
                .setWhen(rec?.activeAt ?: System.currentTimeMillis())
                .setUsesChronometer(true)
                .setShowWhen(true)
                // Auto-raises the screen when the device is locked; tapping the body
                // opens the same screen when it's not.
                .setFullScreenIntent(bodyPending, true)
                .setContentIntent(bodyPending)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val caller = android.app.Person.Builder()
                    .setName(who)
                    .setImportant(true)
                    .build()
                builder.setStyle(Notification.CallStyle.forOngoingCall(caller, hangupPending))
                builder.addAction(Notification.Action.Builder(actionIcon, "Mute", mutePending).build())
                builder.addAction(Notification.Action.Builder(actionIcon, "Speaker", speakerPending).build())
            } else {
                // < Android 12: no CallStyle template — plain notification, same
                // three actions.
                builder
                    .addAction(Notification.Action.Builder(actionIcon, "Hang Up", hangupPending).build())
                    .addAction(Notification.Action.Builder(actionIcon, "Mute", mutePending).build())
                    .addAction(Notification.Action.Builder(actionIcon, "Speaker", speakerPending).build())
            }

            nm.notify(NOTIF_ID, builder.build())
        } catch (_: Throwable) { /* best-effort — a notification failure must never affect call handling */ }
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
        // [AVADIAL-NATIVE-INCALL-1] Repaint the native in-call controls. No-op when the
        // screen isn't up.
        InCallActivity.onAudioRoute(route, state.isMuted)
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

        // [AVADIAL-INCALL-ANSWER-1] The guaranteed screen. When the native in-call
        // UI is enabled, the Answer action must be an ACTIVITY PendingIntent, not a
        // broadcast: SystemUI launches a notification action's activity directly, so
        // the background-activity-launch restrictions that silently swallowed
        // AvaCallActionReceiver's startActivity (no exception, unconditional return,
        // dead call with no screen) do not apply here. answer() itself now fires
        // from inside InCallActivity.onCreate AFTER validating the call is still
        // ringing (never a blind answer) — this receiver no longer answers on this
        // path at all. Flag OFF keeps today's broadcast→receiver path byte-for-byte
        // (kill switch preserved).
        val answerPending: PendingIntent = if (AvaDialPlugin.nativeInCallEnabled(this)) {
            PendingIntent.getActivity(
                this,
                NOTIF_ID + 1,
                InCallActivity.intentFor(this, id, number, answer = true),
                flags,
            )
        } else {
            actionIntent("answer", NOTIF_ID + 1)
        }
        val answerAction = Notification.Action.Builder(
            actionIcon, "Answer", answerPending
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
                    answerPending,
                )
            )
        } else {
            builder.addAction(answerAction).addAction(declineAction)
        }
        val notif = builder.build()
        try {
            nm.notify(NOTIF_ID, notif)
        } catch (_: Throwable) { /* POST_NOTIFICATIONS may be denied — best-effort */ }

        // [AVADIAL-INCALL-ANSWER-1] A UI (the ringing screen, via startActivity or
        // the FSI notification above) is now expected to surface. Arm the 3s
        // watchdog; uiReady() cancels it the moment a screen actually renders.
        armWatchdog(id, "fsi_notification")
    }
}

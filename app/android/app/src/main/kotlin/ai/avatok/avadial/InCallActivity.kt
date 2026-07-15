package ai.avatok.avadial

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Space
import android.widget.TextView
import ai.avatok.avatok_call.R

/**
 * [AVADIAL-NATIVE-INCALL-1] The native active-call screen. Owner decision 2026-07-15.
 *
 * WHY THIS EXISTS — the whole point of the change:
 *
 * Answering a PSTN call used to finish the (fast, native) ringing screen and then
 * COLD-BOOT THE ENTIRE FLUTTER APP just to draw mute/keypad/speaker/end. Those four
 * buttons had no logic of their own — the Dart in-call screen was a remote control,
 * four proxy calls over a MethodChannel to native functions that were already
 * running in this very process:
 *
 *     await AvaDialChannel.I.setMuted(next);
 *     await AvaDialChannel.I.setSpeaker(next);
 *     await AvaDialChannel.I.sendDtmf(widget.callId, d);
 *     await AvaDialChannel.I.disconnect(widget.callId);
 *
 * Meanwhile the boot it triggered was not cheap: FontScale.load() hits the Android
 * Keystore and BLOCKS the first frame; PostHog → Firebase → push init run awaited
 * one after another; validateGates() makes real network calls behind a 3s timer
 * (shell_gate_ms p90 ≈ 2s, max 3s). There is no engine caching anywhere
 * (FlutterEngineCache/FlutterEngineGroup: zero matches in the android tree), so every
 * answer paid a full Dart VM start plus GeneratedPluginRegistrant constructing every
 * plugin in pubspec — WebRTC, LiveKit, Firebase, Stripe. Single process, so all of
 * that contends with the live call for the main thread. There is a recorded race
 * where shellv2_landing_root fired 1.5s AFTER pstn_call_screen_shown and hid the
 * answer UI behind the chat list.
 *
 * A common misreading: the PROCESS is not cold when the phone rings. Telecom binds
 * AvaInCallService the moment a call arrives — that is why the native ring screen
 * paints instantly. What was cold was the Flutter ENGINE. So the fix is not a
 * separate slim app (only one app can hold ROLE_DIALER anyway); it is simply to stop
 * starting the engine. This is how Truecaller works, and the hard part — the Telecom
 * integration in AvaInCallService — was already done.
 *
 * Flutter now only ever shows call HISTORY, which it can read whenever it boots.
 *
 * SHIPS DARK behind `nativeInCallUi` (default OFF). While the flag is off,
 * IncomingCallActivity keeps handing off to MainActivity exactly as before, and the
 * Dart in_call_screen.dart path is untouched. This matters: the answer path is the
 * one that broke prod testers on 2026-07-14.
 */
class InCallActivity : Activity() {

    companion object {
        private const val EXTRA_CALL_ID = "call_id"
        private const val EXTRA_NUMBER = "number"
        // [AVADIAL-INCALL-ANSWER-1] Set only on the notification Answer PendingIntent
        // (see AvaInCallService.launchIncoming) — tells onCreate this launch IS the
        // user's answer tap, so it must validate + answer BEFORE inflating any view.
        private const val EXTRA_ANSWER = "answer"

        @Volatile
        private var live: InCallActivity? = null
        private val main = Handler(Looper.getMainLooper())

        fun intentFor(ctx: Context, callId: String, number: String?, answer: Boolean = false): Intent =
            Intent(ctx, InCallActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra(EXTRA_CALL_ID, callId)
                putExtra(EXTRA_NUMBER, number)
                if (answer) putExtra(EXTRA_ANSWER, true)
            }

        /** The call ended (either side hung up) — tear the screen down. */
        fun closeFor(callId: String) {
            main.post {
                val act = live ?: return@post
                if (act.callId == callId) act.finishQuiet()
            }
        }

        /** Telecom state moved (active / holding / disconnecting) — repaint. */
        fun onCallState(callId: String, state: String) {
            main.post {
                val act = live ?: return@post
                if (act.callId != callId) return@post
                act.applyState(state)
            }
        }

        /** Route or mute changed underneath us (headset unplugged, BT connected). */
        fun onAudioRoute(route: String, muted: Boolean) {
            main.post {
                val act = live ?: return@post
                act.applyAudio(route, muted)
            }
        }
    }

    private var callId: String? = null
    private var number: String? = null
    private var closed = false

    private var keypadOpen = false
    private var muted = false
    private var route = "earpiece"
    private var held = false
    private var state = "active"

    private var timerRunning = false
    private var startedAtMs = 0L

    private var statusView: TextView? = null
    private var controlsHost: LinearLayout? = null
    private var routeChip: LinearLayout? = null

    private val ticker = object : Runnable {
        override fun run() {
            if (closed) return
            renderStatus()
            main.postDelayed(this, 1000L)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        live = this
        callId = intent.getStringExtra(EXTRA_CALL_ID)
        number = intent.getStringExtra(EXTRA_NUMBER)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            (getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager)
                ?.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            )
        }
        window.statusBarColor = AvaCallTheme.c(AvaCallTheme.BG)
        window.navigationBarColor = AvaCallTheme.c(AvaCallTheme.BG)

        // The call may already be gone by the time we're created (hung up during the
        // task swap) — never strand the user on a screen for a dead call.
        val id = callId
        if (id == null || AvaInCallService.stateOf(id) == null) {
            finishQuiet()
            return
        }

        // [AVADIAL-INCALL-ANSWER-1] This launch IS the notification Answer tap — the
        // PendingIntent is now an activity intent (SystemUI-launched), so we own
        // firing answer(), not AvaCallActionReceiver. Validate BEFORE touching
        // Telecom: the tap happened in the past (however briefly) and the call may
        // have been hung up or answered elsewhere in the gap. Never blind-answer.
        if (intent.getBooleanExtra(EXTRA_ANSWER, false)) {
            when (val callState = AvaInCallService.stateOf(id)) {
                null, "unknown" -> {
                    // Call gone — do not answer. No transient UI; the service's own
                    // onCallRemoved cleanup (notification cancel, etc.) already
                    // covers teardown.
                    finishQuiet()
                    return
                }
                "ringing" -> {
                    // Valid and still ringing — this tap IS the answer. Fire it
                    // before any view inflation so a slow/crashing inflate can never
                    // leave the call unanswered; the service-owned notification
                    // (Fix 2) covers the call either way once it's live.
                    AvaInCallService.action(id, "answer", null)
                }
                else -> {
                    // Already active — answered elsewhere (Flutter, Bluetooth,
                    // another surface) between tap and launch. Do not re-answer;
                    // fall through and attach as a viewer rendering live state.
                }
            }
        }

        state = AvaInCallService.stateOf(id) ?: "active"
        held = state == "holding"
        muted = AvaInCallService.isMuted()
        route = AvaInCallService.currentRoute()
        startedAtMs = AvaInCallService.recordFor(id)?.activeAt ?: System.currentTimeMillis()

        setContentView(buildUi())
        // [AVADIAL-INCALL-ANSWER-1] uiReady handshake (Fix 4) — the honest signal
        // that a screen actually rendered, not just that we asked Android to show
        // one. Fired on every launch path, not just answer.
        AvaInCallService.uiReady(id)
        startTimer()
    }

    /**
     * launchMode is singleTop, so a SECOND launch for a different call reuses this
     * instance instead of creating one. Without this override the extras would be
     * ignored and the screen would keep driving the OLD call — muting, holding and
     * ending the wrong one. Reachable via call waiting, and via AvaCallActionReceiver
     * racing IncomingCallActivity.onCallActive.
     */
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        val id = intent?.getStringExtra(EXTRA_CALL_ID) ?: return
        if (id == callId) return
        setIntent(intent)
        callId = id
        number = intent.getStringExtra(EXTRA_NUMBER)
        if (AvaInCallService.stateOf(id) == null) { finishQuiet(); return }
        state = AvaInCallService.stateOf(id) ?: "active"
        held = state == "holding"
        muted = AvaInCallService.isMuted()
        route = AvaInCallService.currentRoute()
        keypadOpen = false
        startedAtMs = AvaInCallService.recordFor(id)?.activeAt ?: System.currentTimeMillis()
        setContentView(buildUi())
        // [AVADIAL-INCALL-ANSWER-1] Same handshake as onCreate — this is a launch
        // path too (call waiting reusing the singleTop instance).
        AvaInCallService.uiReady(id)
    }

    override fun onDestroy() {
        if (live == this) live = null
        main.removeCallbacks(ticker)
        super.onDestroy()
    }

    /** Back must not kill the call — it's a live phone call, not a page. */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        moveTaskToBack(true)
    }

    // ── actions ───────────────────────────────────────────────────────────────

    private fun toggleMute() {
        muted = !muted
        callId?.let { AvaInCallService.noteAction(it, if (muted) "muted" else "unmuted") }
        AvaInCallService.action(null, "setMuted", muted)
        rebuildControls()
    }

    /**
     * Cycle the audio route through what the device ACTUALLY supports right now.
     *
     * The old Flutter screen had a binary speaker toggle backed by setSpeaker, which
     * could only ever pick SPEAKER↔EARPIECE. A call on AirPods therefore rendered
     * identically to one on the earpiece, with no indication and no way to change it.
     */
    private fun cycleRoute() {
        val routes = AvaInCallService.supportedRoutes()
        if (routes.isEmpty()) return
        val i = routes.indexOf(route)
        val next = routes[(if (i < 0) 0 else i + 1) % routes.size]
        route = next
        AvaInCallService.action(null, "setAudioRoute", next)
        rebuildControls()
        renderRouteChip()
    }

    private fun toggleHold() {
        val id = callId ?: return
        held = !held
        AvaInCallService.action(id, if (held) "hold" else "unhold", null)
        rebuildControls()
        renderStatus()
    }

    private fun toggleKeypad() {
        keypadOpen = !keypadOpen
        rebuildControls()
    }

    private fun dtmf(digit: String) {
        val id = callId ?: return
        AvaInCallService.action(id, "dtmf", digit)
    }

    private fun endCall() {
        val id = callId ?: return
        AvaInCallService.action(id, "disconnect", null)
        finishQuiet()
    }

    private fun addCall() {
        callId?.let { AvaInCallService.noteAction(it, "add_call") }
        try {
            startActivity(Intent(Intent.ACTION_DIAL).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) })
        } catch (_: Throwable) { }
    }

    /** Save an unknown caller, or open a known one. */
    private fun contactAction() {
        val n = number ?: return
        val id = callId
        val known = id?.let { AvaInCallService.recordFor(it)?.contactExists } == true
        id?.let { AvaInCallService.noteAction(it, if (known) "opened_contact" else "saved_contact") }
        try {
            val i = if (known) {
                Intent(Intent.ACTION_VIEW, android.net.Uri.withAppendedPath(
                    android.provider.ContactsContract.CommonDataKinds.Phone.CONTENT_FILTER_URI,
                    android.net.Uri.encode(n),
                ))
            } else {
                Intent(Intent.ACTION_INSERT).apply {
                    type = android.provider.ContactsContract.Contacts.CONTENT_TYPE
                    putExtra(android.provider.ContactsContract.Intents.Insert.PHONE, n)
                }
            }
            startActivity(i.apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) })
        } catch (_: Throwable) { }
    }

    /**
     * Report the caller as spam mid-call. [anchor] gets an acknowledgement bubble —
     * without it this button writes a file and returns with NOTHING on screen, which
     * is exactly the dead-control defect this whole rewrite exists to remove.
     */
    private fun report(anchor: View) {
        val n = number ?: return
        val id = callId
        IncomingCallActivity.stashPendingAction(this, n, "report_spam")
        id?.let { AvaInCallService.noteAction(it, "reported_spam") }
        AvaCallTheme.comingSoon(this, anchor, "Reported as spam")
    }

    private fun finishQuiet() {
        if (closed) return
        closed = true
        main.removeCallbacks(ticker)
        try { finishAndRemoveTask() } catch (_: Throwable) { finish() }
    }

    // ── state in ──────────────────────────────────────────────────────────────

    private fun applyState(s: String) {
        state = s
        held = s == "holding"
        if (s == "active" && startedAtMs == 0L) startedAtMs = System.currentTimeMillis()
        renderStatus()
        rebuildControls()
    }

    private fun applyAudio(r: String, m: Boolean) {
        route = r
        muted = m
        renderRouteChip()
        rebuildControls()
    }

    // ── UI ────────────────────────────────────────────────────────────────────

    private fun dp(v: Int): Int = AvaCallTheme.dp(this, v)

    private fun buildUi(): View {
        val id = callId
        val rec = id?.let { AvaInCallService.recordFor(it) }
        val name = rec?.contactName
        val known = rec?.contactExists == true
        val accent = AvaCallTheme.c(
            if (known) AvaCallTheme.CONTACT_GREEN else AvaCallTheme.UNKNOWN_BLUE
        )

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(AvaCallTheme.c(AvaCallTheme.BG))
            setPadding(dp(24), dp(28), dp(24), dp(28))
        }

        // ── header: avatar + name + timer (the approved mockup) ──
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(
            AvaCallTheme.avatar(
                this,
                if (known) R.drawable.ic_avadial_person else R.drawable.ic_avadial_phone,
                accent, 44, 22,
            ),
            LinearLayout.LayoutParams(dp(44), dp(44)),
        )
        val who = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        who.addView(TextView(this).apply {
            text = name ?: number ?: "Unknown"
            textSize = 19f
            typeface = Typeface.DEFAULT_BOLD
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            setTextColor(AvaCallTheme.c(AvaCallTheme.TEXT_PRIMARY))
        })
        statusView = TextView(this).apply {
            textSize = 14f
            setTextColor(AvaCallTheme.c(AvaCallTheme.TEXT_SOFT))
        }
        who.addView(statusView)
        header.addView(who, LinearLayout.LayoutParams(
            0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f
        ).apply { leftMargin = dp(12) })
        root.addView(header, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        // ── audio route chip (only when we're NOT on the earpiece) ──
        routeChip = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(9), dp(12), dp(9))
            background = AvaCallTheme.card(this@InCallActivity)
            visibility = View.GONE
        }
        root.addView(routeChip, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(14) })

        root.addView(Space(this), LinearLayout.LayoutParams(0, 0, 1f))

        controlsHost = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
        }
        root.addView(controlsHost, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        root.addView(Space(this), LinearLayout.LayoutParams(0, 0, 1f))

        // ── end ──
        root.addView(
            AvaCallTheme.circleButton(
                this, R.drawable.ic_avadial_phone_end, "",
                AvaCallTheme.c(AvaCallTheme.DANGER), diameterDp = 64, iconDp = 28,
            ) { endCall() },
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = dp(10) },
        )

        rebuildControls()
        renderStatus()
        renderRouteChip()

        return ScrollView(this).apply {
            isFillViewport = true
            addView(root, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT
            ))
        }
    }

    private fun rebuildControls() {
        val host = controlsHost ?: return
        host.removeAllViews()
        if (keypadOpen) buildKeypad(host) else buildControlGrid(host)
    }

    /** The 2×3 control grid from the approved mockup. */
    private fun buildControlGrid(host: LinearLayout) {
        val grid = GridLayout(this).apply {
            columnCount = 3
            rowCount = 2
        }
        val chip = AvaCallTheme.c(AvaCallTheme.CHIP)
        val on = AvaCallTheme.c(AvaCallTheme.ACCENT_ORANGE)

        fun cell(v: View) {
            grid.addView(v, GridLayout.LayoutParams().apply {
                width = 0
                columnSpec = GridLayout.spec(GridLayout.UNDEFINED, 1, 1f)
                setMargins(dp(6), dp(8), dp(6), dp(8))
            })
        }

        cell(AvaCallTheme.circleButton(
            this,
            if (muted) R.drawable.ic_avadial_mic_off else R.drawable.ic_avadial_mic,
            "mute", if (muted) on else chip,
        ) { toggleMute() })

        cell(AvaCallTheme.circleButton(
            this, R.drawable.ic_avadial_dialpad, "keypad", chip,
        ) { toggleKeypad() })

        // The audio button reflects the ACTUAL route, and lights up whenever we're off
        // the earpiece — so bluetooth is finally visible instead of looking like a
        // muted speaker.
        cell(AvaCallTheme.circleButton(
            this,
            when (route) {
                "speaker" -> R.drawable.ic_avadial_speaker
                "bluetooth" -> R.drawable.ic_avadial_bluetooth
                "headset" -> R.drawable.ic_avadial_headset
                else -> R.drawable.ic_avadial_earpiece
            },
            "audio", if (route == "earpiece") chip else on,
        ) { cycleRoute() })

        cell(AvaCallTheme.circleButton(
            this, R.drawable.ic_avadial_pause, "hold", if (held) on else chip,
        ) { toggleHold() })

        val known = callId?.let { AvaInCallService.recordFor(it)?.contactExists } == true
        if (known) {
            cell(AvaCallTheme.circleButton(
                this, R.drawable.ic_avadial_add, "add call", chip,
            ) { addCall() })
            cell(AvaCallTheme.circleButton(
                this, R.drawable.ic_avadial_person, "contact", chip,
            ) { contactAction() })
        } else {
            // An unknown caller mid-call is exactly when reporting or saving matters.
            cell(AvaCallTheme.circleButton(
                this, R.drawable.ic_avadial_flag, "report", chip,
            ) { v -> report(v) })
            cell(AvaCallTheme.circleButton(
                this, R.drawable.ic_avadial_person_add, "save", chip,
            ) { contactAction() })
        }

        host.addView(grid, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))
    }

    /** DTMF pad — replaces the control grid, exactly like the Flutter screen did. */
    private fun buildKeypad(host: LinearLayout) {
        val grid = GridLayout(this).apply {
            columnCount = 3
            rowCount = 4
        }
        val chip = AvaCallTheme.c(AvaCallTheme.CHIP)
        val keys = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#")
        keys.forEach { k ->
            grid.addView(
                AvaCallTheme.pill(this, k, chip, AvaCallTheme.c(AvaCallTheme.TEXT_PRIMARY)) { dtmf(k) },
                GridLayout.LayoutParams().apply {
                    width = 0
                    height = dp(48)
                    columnSpec = GridLayout.spec(GridLayout.UNDEFINED, 1, 1f)
                    setMargins(dp(5), dp(5), dp(5), dp(5))
                },
            )
        }
        host.addView(grid, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        host.addView(TextView(this).apply {
            text = "Hide keypad"
            textSize = 14f
            gravity = Gravity.CENTER
            setPadding(dp(12), dp(14), dp(12), dp(6))
            setTextColor(AvaCallTheme.c(AvaCallTheme.TEXT_SOFT))
            setOnClickListener { toggleKeypad() }
        }, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))
    }

    private fun renderRouteChip() {
        val chip = routeChip ?: return
        chip.removeAllViews()
        if (route == "earpiece") {
            chip.visibility = View.GONE
            return
        }
        chip.visibility = View.VISIBLE
        chip.addView(android.widget.ImageView(this).apply {
            setImageResource(
                when (route) {
                    "speaker" -> R.drawable.ic_avadial_speaker
                    "bluetooth" -> R.drawable.ic_avadial_bluetooth
                    else -> R.drawable.ic_avadial_headset
                }
            )
            setColorFilter(AvaCallTheme.c(AvaCallTheme.UNKNOWN_BLUE))
        }, LinearLayout.LayoutParams(dp(16), dp(16)))
        chip.addView(TextView(this).apply {
            text = AvaInCallService.routeLabel(route)
            textSize = 12f
            setTextColor(AvaCallTheme.c(AvaCallTheme.TEXT_SOFT))
        }, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { leftMargin = dp(8) })
    }

    private fun startTimer() {
        if (timerRunning) return
        timerRunning = true
        main.post(ticker)
    }

    private fun renderStatus() {
        val v = statusView ?: return
        v.text = when {
            held -> "On hold"
            state == "dialing" || state == "connecting" -> "Dialing…"
            state == "ringing" -> "Ringing…"
            state == "disconnecting" -> "Ending…"
            else -> fmt(System.currentTimeMillis() - startedAtMs)
        }
    }

    /** mm:ss, or h:mm:ss past the hour. */
    private fun fmt(ms: Long): String {
        val total = (ms / 1000).coerceAtLeast(0L)
        val h = total / 3600
        val m = (total % 3600) / 60
        val s = total % 60
        return if (h > 0) String.format("%d:%02d:%02d", h, m, s)
        else String.format("%02d:%02d", m, s)
    }
}

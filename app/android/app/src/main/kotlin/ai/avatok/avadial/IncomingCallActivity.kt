package ai.avatok.avadial

import android.app.Activity
import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.BlockedNumberContract
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.animation.Animation
import android.view.animation.ScaleAnimation
import android.view.animation.AlphaAnimation
import android.view.animation.AnimationSet
import android.view.animation.LinearInterpolator
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.Space
import android.widget.TextView
// R is generated under the module namespace (ai.avatok.avatok_call), not this package.
import ai.avatok.avatok_call.R
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * [AVADIAL-NATIVE-RING-1] Dedicated, self-contained incoming-call screen (owner
 * request 2026-07-14: "separate the incoming call screen from the app — users
 * should not need the app open to receive a call").
 *
 * This is a pure-native activity in its OWN task: no Flutter engine, no shell,
 * no landing page, no setup sheet. AvaInCallService launches it directly (and
 * points the full-screen-intent notification here).
 *
 * [AVADIAL-NATIVE-INCALL-1] (2026-07-15) Rebuilt to the owner-approved iOS-style
 * mockup, and now hands off to the NATIVE [InCallActivity] instead of cold-booting
 * Flutter. Three things changed and each fixes a real defect:
 *
 *  1. ANSWER FEEDBACK. Tapping Answer used to do NOTHING on screen — the frame sat
 *     frozen until Telecom reported ACTIVE (typically sub-second, but up to the 10s
 *     fallback on a bad network), then hard-swapped. The buttons were TextViews with
 *     click listeners, so they didn't even ripple. Now: haptic on touch, an explicit
 *     ANSWERING state (buttons fade, spinner, "Connecting…"), and re-taps are
 *     swallowed. Multi-tapping was always harmless — Telecom drops answer() on a
 *     non-RINGING call — but it looked broken, which is its own bug.
 *
 *  2. SHARED PALETTE. Colours come from [AvaCallTheme], the same file the in-call
 *     screen reads, so answering no longer shifts the palette mid-flow.
 *
 *  3. CONFIGURED SPAM THRESHOLD. Reads `warn_threshold` from the screening snapshot
 *     instead of a hardcoded 70, so the paint matches what the screening service
 *     actually scored against.
 *
 * Still true: finishes itself the moment the call dies (missed / hung up / answered
 * elsewhere) via [closeFor]/[onCallActive] — no ghost ringing screens.
 */
class IncomingCallActivity : Activity() {

    companion object {
        /** Fallback only — the live value comes from the snapshot. See [AvaCallTheme]. */
        private const val ANSWER_TIMEOUT_MS = 10_000L

        @Volatile
        private var live: IncomingCallActivity? = null
        private val main = Handler(Looper.getMainLooper())

        /** The call died (missed / hung up / declined elsewhere) — tear down. */
        fun closeFor(callId: String) {
            main.post {
                val act = live ?: return@post
                if (act.callId == callId) act.finishQuiet()
            }
        }

        /**
         * The call went ACTIVE (answered here, from the notification, or from the
         * Flutter UI) — hand off to the in-call screen and tear down.
         */
        fun onCallActive(callId: String) {
            main.post {
                val act = live ?: return@post
                if (act.callId != callId) return@post
                act.launchInCallUi()
                act.finishQuiet()
            }
        }

        /**
         * [AVADIAL-CNAP-1] The network delivered the caller's CNAP name AFTER this
         * screen launched (the common case on Indian VoLTE — the IMS layer updates
         * the call mid-ring). Repaint the name + kicker live, but only when there is
         * no local contact match: the user's own label always wins, and the spam
         * paint is never overridden by a name. Also stashed onto the intent so the
         * answer-timeout rebuild path ([recreateActions]) keeps the name.
         */
        fun onCnapName(callId: String, name: String) {
            main.post {
                val act = live ?: return@post
                if (act.callId != callId || act.closed || act.answering) return@post
                act.applyCnapName(name)
            }
        }

        /** Append a native action for the Dart side to drain into BlockList later. */
        internal fun stashPendingAction(ctx: Context, number: String, action: String) {
            try {
                val dir = File(ctx.filesDir, "avadial").apply { mkdirs() }
                val f = File(dir, "pending_call_actions.json")
                val arr = if (f.exists() && f.length() > 0L) JSONArray(f.readText()) else JSONArray()
                arr.put(
                    JSONObject()
                        .put("number", number)
                        .put("action", action)
                        .put("ts", System.currentTimeMillis())
                )
                val tmp = File(dir, "pending_call_actions.json.tmp")
                tmp.writeText(arr.toString())
                tmp.renameTo(f)
            } catch (_: Throwable) { /* best-effort */ }
        }
    }

    private var callId: String? = null
    private var number: String? = null
    private var closed = false
    private var answering = false

    /**
     * True once we've launched the NATIVE [InCallActivity], which shares this
     * activity's taskAffinity — see [finishQuiet] for why that matters.
     */
    private var handedOffToNative = false

    // Views we mutate when entering the ANSWERING state.
    private var actionsHost: LinearLayout? = null
    private var kickerView: TextView? = null
    private var avatarView: ImageView? = null
    private var pulseView: View? = null
    // [AVADIAL-CNAP-1] Mutated live when a late CNAP name lands mid-ring.
    private var nameView: TextView? = null
    private var subtitleView: TextView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        live = this
        callId = intent.getStringExtra("call_id")
        number = intent.getStringExtra("number")
        val name = intent.getStringExtra("name")
        val spamScore = if (intent.hasExtra("spam_score")) intent.getIntExtra("spam_score", 0) else null

        // Over the lock screen, waking the display — a phone must ring like a phone.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            (getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager)
                ?.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                    WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            )
        }
        window.statusBarColor = AvaCallTheme.c(AvaCallTheme.BG)
        window.navigationBarColor = AvaCallTheme.c(AvaCallTheme.BG)

        // If the call already died before we got here (race), bail immediately.
        val id = callId
        if (id == null || AvaInCallService.stateOf(id) == null) {
            finishQuiet()
            return
        }
        if (AvaInCallService.stateOf(id) == "active") {
            launchInCallUi()
            finishQuiet()
            return
        }

        setContentView(buildUi(name, spamScore))
        // [AVADIAL-INCALL-DIAG-1] uiReady handshake (Fix 4), phase "ring" — the
        // native ringing screen never acked at all before this change, which meant
        // the "ring" watchdog armed in AvaInCallService.launchIncoming fired on
        // every call that simply rang longer than 3s (false-positive noise) and
        // there was no honest per-call signal that the ring screen ever rendered.
        AvaInCallService.uiReady(id, "ring")
    }

    override fun onDestroy() {
        if (live == this) live = null
        super.onDestroy()
    }

    /** No back-button escape into a ghost task — back behaves like "dismiss". */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // Keep ringing in the background (notification stays) — just hide the screen.
        finishQuiet()
    }

    // ── actions ────────────────────────────────────────────────────────────────

    /**
     * Answer, and IMMEDIATELY acknowledge it on screen.
     *
     * The tap→ACTIVE gap is usually short but is never zero, and on a bad network it
     * can run to [ANSWER_TIMEOUT_MS]. Previously that whole window was silent, so the
     * user tapped again, and again. Now the UI commits to ANSWERING on the first tap
     * and re-taps are ignored.
     */
    private fun answer() {
        val id = callId ?: return
        if (answering) return
        answering = true
        enterAnsweringState()
        // [AVADIAL-INCALL-DIAG-1] Stamp the honest answer source BEFORE answering —
        // this IS the native ring screen's Accept tap.
        AvaInCallService.noteAnswerSource(id, "ring_screen")
        AvaInCallService.action(id, "answer", null)
        // The ACTIVE callback fires [onCallActive] → in-call UI + finish.
        // If nothing lands in time, restore the buttons rather than stranding the
        // user on a spinner for a call that is somehow still ringing.
        main.postDelayed({
            if (!closed && answering && AvaInCallService.stateOf(id) == "ringing") {
                answering = false
                recreateActions()
            }
        }, ANSWER_TIMEOUT_MS)
    }

    private fun decline() {
        val id = callId ?: return
        // [AVADIAL-INCALL-NOTIF-1] FIX 3 — semantic verb, not the raw Telecom API.
        // block() (below) stamps finalState = "blocked" BEFORE calling decline(), and
        // action()'s "end_call" ringing branch only sets finalState when it is still
        // null — first-writer-wins is preserved, so a blocked call still lands as
        // "blocked", not demoted to "rejected". This call is only ever reached while
        // the call is still ringing (the native ring screen has already handed off to
        // InCallActivity by the time the call goes active), so "end_call" maps to
        // reject() here exactly like the old "reject" verb did.
        AvaInCallService.action(id, "end_call", null)
        cancelNotif()
        finishQuiet()
    }

    private fun block(reportSpam: Boolean) {
        val n = number
        val id = callId
        if (!n.isNullOrEmpty()) {
            try {
                val values = android.content.ContentValues()
                values.put(BlockedNumberContract.BlockedNumbers.COLUMN_ORIGINAL_NUMBER, n)
                contentResolver.insert(BlockedNumberContract.BlockedNumbers.CONTENT_URI, values)
            } catch (_: Throwable) { /* not default dialer / OEM quirk — best-effort */ }
            stashPendingAction(this, n, if (reportSpam) "report_spam" else "block")
        }
        // [AVADIAL-CALL-INTEL-1] Record the disposition BEFORE decline() tears the
        // call down — onCallRemoved reads finalState to write the completed row.
        if (id != null) {
            AvaInCallService.noteAction(id, if (reportSpam) "reported_spam" else "blocked_number")
            AvaInCallService.recordFor(id)?.finalState = "blocked"
        }
        decline()
    }

    /**
     * [AVADIAL-CNAP-1] A late network name landed mid-ring. Guards (companion
     * [onCnapName]) already ensured this call is live, un-answered, and the guard
     * here keeps contact and spam paints untouched: only the anonymous-number case
     * upgrades. Stashed on the intent so [recreateActions]' rebuild keeps it.
     */
    private fun applyCnapName(cnap: String) {
        if (!intent.getStringExtra("name").isNullOrEmpty()) return // contact label wins
        if (intent.hasExtra("spam_score")) {
            val warn = AvaCallScreeningService.warnThresholdOf(this)
            if (intent.getIntExtra("spam_score", 0) >= warn) return // spam paint wins
        }
        intent.putExtra("cnap_name", cnap)
        nameView?.text = cnap
        kickerView?.text = "✓ Network verified"
        subtitleView?.let {
            if (!number.isNullOrEmpty()) {
                it.text = number
                it.visibility = View.VISIBLE
            }
        }
    }

    /** Open the SMS composer for this caller (quick reply instead of answering). */
    private fun message() {
        val n = number ?: return
        callId?.let { AvaInCallService.noteAction(it, "sent_sms") }
        try {
            startActivity(Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:$n")).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            })
        } catch (_: Throwable) { /* no SMS app — best-effort */ }
    }

    private fun launchInCallUi() {
        val id = callId
        // [AVADIAL-NATIVE-INCALL-1] Native in-call screen when the flag is on; the old
        // Flutter path otherwise. Read fresh from disk on every answer so a config flip
        // takes effect without a restart, and fail-closed so any doubt keeps the
        // known-good Flutter path.
        if (id != null && AvaDialPlugin.nativeInCallEnabled(this)) {
            try {
                startActivity(InCallActivity.intentFor(this, id, number))
                handedOffToNative = true
                return
            } catch (_: Throwable) { /* fall through to the Flutter path below */ }
        }
        try {
            val i = Intent(this, Class.forName("ai.avatok.avatok_call.MainActivity")).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra("route", "avadial/incoming")
                putExtra("call_id", callId)
                putExtra("number", number)
                putExtra("answered", true)
            }
            startActivity(i)
        } catch (_: Throwable) { /* best-effort */ }
    }

    private fun cancelNotif() {
        try {
            (getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)
                ?.cancel(AvaInCallService.NOTIF_ID)
        } catch (_: Throwable) { /* best-effort */ }
    }

    /**
     * Dismiss this screen.
     *
     * CAREFUL — [finishAndRemoveTask] finishes EVERY activity in this task, not just
     * this one. That was always the intent (kill the whole `avadial.incoming` task so
     * no ghost card lingers in recents), and it was safe while the handoff target was
     * MainActivity, which lives on the app's own default affinity in a DIFFERENT task.
     *
     * The native [InCallActivity] deliberately shares this task's affinity — so
     * calling finishAndRemoveTask() after launching it would destroy the in-call
     * screen we just created, one line later. When we've handed off natively we must
     * finish ONLY ourselves and let InCallActivity own the task's lifetime.
     */
    private fun finishQuiet() {
        if (closed) return
        closed = true
        try {
            if (handedOffToNative) finish() else finishAndRemoveTask()
        } catch (_: Throwable) {
            finish()
        }
    }

    // ── UI ────────────────────────────────────────────────────────────────────

    private fun dp(v: Int): Int = AvaCallTheme.dp(this, v)

    private enum class Bucket { CONTACT, UNKNOWN, SPAM }

    private fun buildUi(name: String?, spamScore: Int?): View {
        // [AVADIAL-NATIVE-INCALL-1] The CONFIGURED threshold, not a hardcoded 70.
        val warn = AvaCallScreeningService.warnThresholdOf(this)
        val bucket = when {
            spamScore != null && spamScore >= warn -> Bucket.SPAM
            !name.isNullOrEmpty() -> Bucket.CONTACT
            else -> Bucket.UNKNOWN
        }
        // [AVADIAL-CNAP-1] Network caller name — display only (bucket stays UNKNOWN:
        // a network name is identity, not trust, so the visuals keep the unknown
        // blue and the Block/Report actions stay available).
        val cnap = intent.getStringExtra("cnap_name")?.takeIf { bucket == Bucket.UNKNOWN }
        val accent = AvaCallTheme.c(
            when (bucket) {
                Bucket.SPAM -> AvaCallTheme.DANGER
                Bucket.CONTACT -> AvaCallTheme.CONTACT_GREEN
                Bucket.UNKNOWN -> AvaCallTheme.UNKNOWN_BLUE
            }
        )

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(AvaCallTheme.c(AvaCallTheme.BG))
            setPadding(dp(24), dp(44), dp(24), dp(28))
            gravity = Gravity.CENTER_HORIZONTAL
        }

        root.addView(Space(this), LinearLayout.LayoutParams(0, 0, 1f))

        // Avatar with a pulsing halo — a ringing phone should look alive. The old
        // screen was a completely static frame with no motion anywhere.
        root.addView(buildAvatar(bucket, accent))

        root.addView(Space(this), LinearLayout.LayoutParams(1, dp(18)))

        // Kicker
        kickerView = TextView(this).apply {
            text = when {
                bucket == Bucket.SPAM -> "Suspected spam"
                bucket == Bucket.CONTACT -> "Incoming call"
                // [AVADIAL-CNAP-1] The carrier vouches for this name (SIM-KYC
                // sourced) — say so instead of "Unknown number".
                cnap != null -> "✓ Network verified"
                else -> "Unknown number"
            }
            textSize = 13f
            letterSpacing = 0.1f
            setTextColor(
                if (bucket == Bucket.SPAM) AvaCallTheme.c(AvaCallTheme.DANGER)
                else AvaCallTheme.c(AvaCallTheme.TEXT_SOFT)
            )
        }
        root.addView(kickerView)

        root.addView(Space(this), LinearLayout.LayoutParams(1, dp(6)))

        // Name — contact label > network CNAP name > number ([AVADIAL-CNAP-1]).
        nameView = TextView(this).apply {
            text = name ?: cnap ?: number ?: "Unknown"
            textSize = 30f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setTextColor(AvaCallTheme.c(AvaCallTheme.TEXT_PRIMARY))
        }
        root.addView(nameView)
        subtitleView = if ((!name.isNullOrEmpty() || cnap != null) && !number.isNullOrEmpty()) {
            root.addView(Space(this), LinearLayout.LayoutParams(1, dp(4)))
            TextView(this).apply {
                text = number
                textSize = 15f
                setTextColor(AvaCallTheme.c(AvaCallTheme.TEXT_SOFT))
            }.also { root.addView(it) }
        } else {
            // Placeholder so a LATE CNAP name can add the number subtitle without
            // rebuilding the layout — hidden until it has something to say.
            TextView(this).apply {
                text = number ?: ""
                textSize = 15f
                setTextColor(AvaCallTheme.c(AvaCallTheme.TEXT_SOFT))
                visibility = View.GONE
            }.also { root.addView(it) }
        }

        // Spam banner
        if (bucket == Bucket.SPAM) {
            root.addView(Space(this), LinearLayout.LayoutParams(1, dp(18)))
            root.addView(TextView(this).apply {
                text = "Reported by the community (score $spamScore). We recommend declining."
                textSize = 13f
                gravity = Gravity.CENTER
                setTextColor(AvaCallTheme.c(AvaCallTheme.TEXT_SOFT))
                setPadding(dp(14), dp(12), dp(14), dp(12))
                background = AvaCallTheme.card(this@IncomingCallActivity)
            }, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ))
        }

        root.addView(Space(this), LinearLayout.LayoutParams(0, 0, 1f))

        // Everything below the fold swaps wholesale when we enter ANSWERING.
        actionsHost = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
        }
        buildActions(actionsHost!!, bucket)
        root.addView(actionsHost, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ))

        // ScrollView so small screens / landscape never clip the buttons.
        return ScrollView(this).apply {
            isFillViewport = true
            addView(root, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT
            ))
        }
    }

    /** Avatar circle + the pulsing ring behind it. */
    private fun buildAvatar(bucket: Bucket, accent: Int): View {
        val size = dp(108)
        val host = android.widget.FrameLayout(this)

        // The halo: a stroked circle that scales up and fades out, forever.
        val pulse = View(this).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setStroke(dp(2), accent)
                setColor(Color.TRANSPARENT)
            }
        }
        host.addView(pulse, android.widget.FrameLayout.LayoutParams(size, size, Gravity.CENTER))
        pulseView = pulse

        val icon = when (bucket) {
            Bucket.SPAM -> R.drawable.ic_avadial_warning
            Bucket.CONTACT -> R.drawable.ic_avadial_person
            Bucket.UNKNOWN -> R.drawable.ic_avadial_call_received
        }
        // NOTE: no contact photo yet. Phone.PHOTO_URI is one extra projection column on
        // the lookup AvaInCallService already runs — worth doing, but it is a separate
        // change and the glyph is the honest fallback state either way.
        val avatar = AvaCallTheme.avatar(this, icon, accent, 108, 46)
        host.addView(avatar, android.widget.FrameLayout.LayoutParams(size, size, Gravity.CENTER))
        avatarView = avatar

        startPulse(pulse)
        return host
    }

    /**
     * Breathing halo. Kept deliberately cheap (view animation, two properties, no
     * layout passes) because this runs on a locked phone with a cold CPU.
     */
    private fun startPulse(v: View) {
        val set = AnimationSet(false).apply {
            addAnimation(ScaleAnimation(
                1f, 1.35f, 1f, 1.35f,
                Animation.RELATIVE_TO_SELF, 0.5f,
                Animation.RELATIVE_TO_SELF, 0.5f,
            ).apply { duration = 1500; repeatCount = Animation.INFINITE; interpolator = LinearInterpolator() })
            addAnimation(AlphaAnimation(0.55f, 0f).apply {
                duration = 1500; repeatCount = Animation.INFINITE; interpolator = LinearInterpolator()
            })
        }
        v.startAnimation(set)
    }

    private fun stopPulse() {
        try { pulseView?.clearAnimation(); pulseView?.visibility = View.INVISIBLE } catch (_: Throwable) { }
    }

    /**
     * The action stack: a secondary icon row, then the big Decline/Accept circles.
     * Matches the owner-approved mockup (2026-07-15).
     */
    private fun buildActions(host: LinearLayout, bucket: Bucket) {
        host.removeAllViews()

        // ── secondary row ──
        val secondary = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        val chip = AvaCallTheme.c(AvaCallTheme.CHIP)
        fun addSecondary(iconRes: Int, label: String, onTap: (View) -> Unit) {
            secondary.addView(
                AvaCallTheme.circleButton(this, iconRes, label, chip, diameterDp = 48, iconDp = 21, onTap = onTap),
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
            )
        }

        if (bucket == Bucket.CONTACT) {
            addSecondary(R.drawable.ic_avadial_message, "Message") { message() }
        } else {
            addSecondary(R.drawable.ic_avadial_block, "Block") { block(reportSpam = false) }
            addSecondary(R.drawable.ic_avadial_flag, "Report") { block(reportSpam = true) }
        }

        // [AVADIAL-NATIVE-INCALL-1] Owner request 2026-07-15: both of these are
        // announced-but-unbuilt products. They are on screen deliberately — the shape
        // of the flow is being set now — but they must say so rather than silently do
        // nothing, which reads as a bug.
        addSecondary(R.drawable.ic_avadial_voicemail, "Voicemail") { v ->
            AvaCallTheme.comingSoon(this, v, "Voicemail — coming soon")
        }
        addSecondary(R.drawable.ic_avadial_ava, "Ava") { v ->
            AvaCallTheme.comingSoon(this, v, "Chat with Ava — coming soon")
        }

        if (bucket == Bucket.CONTACT) {
            addSecondary(R.drawable.ic_avadial_block, "Block") { block(reportSpam = false) }
        }

        host.addView(secondary, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ))

        host.addView(Space(this), LinearLayout.LayoutParams(1, dp(24)))

        // ── primary row ──
        val primary = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        primary.addView(
            AvaCallTheme.circleButton(
                this, R.drawable.ic_avadial_phone_end, "Decline",
                AvaCallTheme.c(AvaCallTheme.DANGER), diameterDp = 64, iconDp = 28,
            ) { decline() },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        // On a suspected spammer, Accept keeps its POSITION (muscle memory) but loses
        // its colour and gains a warning label — demoted, not hidden.
        primary.addView(
            AvaCallTheme.circleButton(
                this, R.drawable.ic_avadial_phone,
                if (bucket == Bucket.SPAM) "Answer anyway" else "Accept",
                if (bucket == Bucket.SPAM) AvaCallTheme.c(AvaCallTheme.CHIP)
                else AvaCallTheme.c(AvaCallTheme.CONTACT_GREEN),
                iconTint = if (bucket == Bucket.SPAM) AvaCallTheme.c(AvaCallTheme.TEXT_DIM) else Color.WHITE,
                labelColor = if (bucket == Bucket.SPAM) AvaCallTheme.c(AvaCallTheme.TEXT_DIM)
                else AvaCallTheme.c(AvaCallTheme.TEXT_SOFT),
                diameterDp = 64, iconDp = 28,
            ) { answer() },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        host.addView(primary, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ))
    }

    /** Swap the buttons for a spinner. THE fix for the dead-tap gap. */
    private fun enterAnsweringState() {
        stopPulse()
        kickerView?.text = "Connecting…"
        kickerView?.setTextColor(AvaCallTheme.c(AvaCallTheme.TEXT_SOFT))
        val host = actionsHost ?: return
        host.removeAllViews()
        host.addView(ProgressBar(this).apply {
            isIndeterminate = true
            indeterminateTintList = android.content.res.ColorStateList.valueOf(
                AvaCallTheme.c(AvaCallTheme.CONTACT_GREEN)
            )
        }, LinearLayout.LayoutParams(dp(44), dp(44)).apply { gravity = Gravity.CENTER_HORIZONTAL })
    }

    /** Answer timed out and the call is somehow still ringing — give the buttons back. */
    private fun recreateActions() {
        val name = intent.getStringExtra("name")
        val spamScore = if (intent.hasExtra("spam_score")) intent.getIntExtra("spam_score", 0) else null
        val warn = AvaCallScreeningService.warnThresholdOf(this)
        val bucket = when {
            spamScore != null && spamScore >= warn -> Bucket.SPAM
            !name.isNullOrEmpty() -> Bucket.CONTACT
            else -> Bucket.UNKNOWN
        }
        kickerView?.text = when {
            bucket == Bucket.SPAM -> "Suspected spam"
            bucket == Bucket.CONTACT -> "Incoming call"
            // [AVADIAL-CNAP-1] Keep the verified kicker across the rebuild.
            intent.getStringExtra("cnap_name") != null -> "✓ Network verified"
            else -> "Unknown number"
        }
        pulseView?.visibility = View.VISIBLE
        pulseView?.let { startPulse(it) }
        actionsHost?.let { buildActions(it, bucket) }
    }
}

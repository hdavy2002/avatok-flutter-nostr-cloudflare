package ai.avatok.avadial

import android.app.Activity
import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.BlockedNumberContract
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Space
import android.widget.TextView
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
 * points the full-screen-intent notification here). It:
 *   • shows caller name (ContactsContract lookup), number, and the spam paint
 *     (red = community-reported spammer, green = contact, blue = unknown) —
 *     mirroring the Flutter PstnCallScreen's buckets;
 *   • Answer → answers via the live Call, then hands off to MainActivity's
 *     in-call UI (route avadial/incoming, answered=true);
 *   • Decline / Block / Report spam → act natively (BlockedNumberContract for
 *     the system block list; a pending-actions file the Dart side drains later
 *     so the in-app Block tab stays in sync);
 *   • finishes itself the moment the call dies (missed / caller hung up /
 *     answered elsewhere) via [closeFor]/[onCallActive] hooks fired by
 *     AvaInCallService — no ghost ringing screens.
 *
 * Styling mirrors AvaMissedCallOverlay's dark palette (built programmatically,
 * no XML resources).
 */
class IncomingCallActivity : Activity() {

    companion object {
        private const val BG = "#141416"
        private const val CARD_BG = "#1B1B1D"
        private const val CARD_STROKE = "#2E2E31"
        private const val TEXT_PRIMARY = "#FFFFFF"
        private const val TEXT_SOFT = "#B5B5B8"
        private const val DANGER = "#D9534F"
        private const val ANSWER_ORANGE = "#E8883A"
        private const val CONTACT_GREEN = "#11A37F"
        private const val UNKNOWN_BLUE = "#7BA7D9"
        private const val CHIP_BG = "#2A2A2D"
        private const val WARN_THRESHOLD = 70

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
         * Flutter UI) — hand off to the app's in-call screen and tear down.
         */
        fun onCallActive(callId: String) {
            main.post {
                val act = live ?: return@post
                if (act.callId != callId) return@post
                act.launchInCallUi()
                act.finishQuiet()
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
        window.statusBarColor = Color.parseColor(BG)
        window.navigationBarColor = Color.parseColor(BG)

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

    private fun answer() {
        val id = callId ?: return
        AvaInCallService.action(id, "answer", null)
        // The ACTIVE state callback fires [onCallActive] → in-call UI + finish.
        // Fallback: if no state change lands in 10s the screen stays (still ringing).
    }

    private fun decline() {
        val id = callId ?: return
        AvaInCallService.action(id, "reject", null)
        cancelNotif()
        finishQuiet()
    }

    private fun block(reportSpam: Boolean) {
        val n = number
        if (!n.isNullOrEmpty()) {
            try {
                val values = android.content.ContentValues()
                values.put(BlockedNumberContract.BlockedNumbers.COLUMN_ORIGINAL_NUMBER, n)
                contentResolver.insert(BlockedNumberContract.BlockedNumbers.CONTENT_URI, values)
            } catch (_: Throwable) { /* not default dialer / OEM quirk — best-effort */ }
            stashPendingAction(this, n, if (reportSpam) "report_spam" else "block")
        }
        decline()
    }

    private fun launchInCallUi() {
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

    private fun finishQuiet() {
        if (closed) return
        closed = true
        try {
            finishAndRemoveTask()
        } catch (_: Throwable) {
            finish()
        }
    }

    // ── UI (programmatic, mirrors PstnCallScreen's red/green/blue buckets) ─────

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun buildUi(name: String?, spamScore: Int?): View {
        val isSpam = spamScore != null && spamScore >= WARN_THRESHOLD
        val isContact = !isSpam && !name.isNullOrEmpty()
        val accent = Color.parseColor(if (isSpam) DANGER else if (isContact) CONTACT_GREEN else UNKNOWN_BLUE)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor(BG))
            setPadding(dp(24), dp(48), dp(24), dp(28))
            gravity = Gravity.CENTER_HORIZONTAL
        }

        root.addView(Space(this), LinearLayout.LayoutParams(0, 0, 1f))

        // Avatar circle
        root.addView(TextView(this).apply {
            text = if (isSpam) "!" else "↙"
            textSize = 40f
            setTextColor(Color.WHITE)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(accent)
                setStroke(dp(2), Color.parseColor(CARD_STROKE))
            }
        }, LinearLayout.LayoutParams(dp(108), dp(108)))

        root.addView(Space(this), LinearLayout.LayoutParams(1, dp(20)))

        // Kicker
        root.addView(TextView(this).apply {
            text = if (isSpam) "SUSPECTED SPAM" else if (isContact) "INCOMING CALL" else "UNKNOWN NUMBER"
            textSize = 13f
            letterSpacing = 0.12f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(if (isSpam) Color.parseColor(DANGER) else Color.parseColor(TEXT_SOFT))
        })

        root.addView(Space(this), LinearLayout.LayoutParams(1, dp(6)))

        // Name (or number when no contact match)
        root.addView(TextView(this).apply {
            text = name ?: number ?: "Unknown"
            textSize = 30f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setTextColor(Color.parseColor(TEXT_PRIMARY))
        })
        if (!name.isNullOrEmpty() && !number.isNullOrEmpty()) {
            root.addView(Space(this), LinearLayout.LayoutParams(1, dp(4)))
            root.addView(TextView(this).apply {
                text = number
                textSize = 15f
                setTextColor(Color.parseColor(TEXT_SOFT))
            })
        }

        // Spam banner
        if (isSpam) {
            root.addView(Space(this), LinearLayout.LayoutParams(1, dp(20)))
            root.addView(TextView(this).apply {
                text = "Reported by the community (score $spamScore). We recommend declining."
                textSize = 13.5f
                setTextColor(Color.parseColor(TEXT_PRIMARY))
                setPadding(dp(14), dp(12), dp(14), dp(12))
                background = GradientDrawable().apply {
                    cornerRadius = dp(14).toFloat()
                    setColor(Color.parseColor(CARD_BG))
                    setStroke(dp(1), Color.parseColor(CARD_STROKE))
                }
            }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        }

        root.addView(Space(this), LinearLayout.LayoutParams(0, 0, 1f))

        // Primary row: Decline · Answer  (spam: Decline is the full-width primary)
        val primaryRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        primaryRow.addView(
            pillButton("Decline", Color.parseColor(DANGER), Color.WHITE) { decline() },
            LinearLayout.LayoutParams(0, dp(52), 1f).apply { rightMargin = dp(6) },
        )
        primaryRow.addView(
            pillButton(
                if (isSpam) "Answer anyway" else "Answer",
                if (isSpam) Color.parseColor(CHIP_BG) else Color.parseColor(ANSWER_ORANGE),
                Color.WHITE,
            ) { answer() },
            LinearLayout.LayoutParams(0, dp(52), 1f).apply { leftMargin = dp(6) },
        )
        root.addView(primaryRow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

        root.addView(Space(this), LinearLayout.LayoutParams(1, dp(12)))

        // Secondary row: Block · Report spam
        val secondaryRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        secondaryRow.addView(
            pillButton("Block", Color.parseColor(CHIP_BG), Color.parseColor(TEXT_PRIMARY)) { block(reportSpam = false) },
            LinearLayout.LayoutParams(0, dp(48), 1f).apply { rightMargin = dp(6) },
        )
        secondaryRow.addView(
            pillButton("Report spam", Color.parseColor(CHIP_BG), Color.parseColor(TEXT_PRIMARY)) { block(reportSpam = true) },
            LinearLayout.LayoutParams(0, dp(48), 1f).apply { leftMargin = dp(6) },
        )
        root.addView(secondaryRow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

        // ScrollView so small screens / landscape never clip the buttons.
        return ScrollView(this).apply {
            isFillViewport = true
            addView(root, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT))
        }
    }

    private fun pillButton(label: String, bg: Int, fg: Int, onTap: () -> Unit): TextView =
        TextView(this).apply {
            text = label
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setTextColor(fg)
            background = GradientDrawable().apply {
                cornerRadius = dp(26).toFloat()
                setColor(bg)
                setStroke(dp(1), Color.parseColor(CARD_STROKE))
            }
            setOnClickListener { onTap() }
        }
}

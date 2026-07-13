package ai.avatok.avadial

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * [AVADIAL-OTP-1] Truecaller-style floating OTP card, drawn OVER all apps via
 * SYSTEM_ALERT_WINDOW so the user copies a one-time code without opening AvaTOK.
 *
 * Built programmatically (no XML) to keep it self-contained and theme-independent.
 * Tapping the card or the "Copy code" button writes the code to the clipboard and
 * dismisses; the ✕ dismisses; it also auto-dismisses after [AUTO_DISMISS_MS]. It is
 * self-cleaning: if the process is killed, the system removes the window with it.
 *
 * Requires the "appear on top" permission — [canDraw] gates every show(); the caller
 * (AvaSmsReceiver) falls back to a heads-up copy notification when it isn't granted.
 */
object AvaOtpOverlay {
    private const val AUTO_DISMISS_MS = 60_000L
    private val main = Handler(Looper.getMainLooper())
    private var current: View? = null
    private var pendingDismiss: Runnable? = null

    /** True when we may draw over other apps (always true pre-Android 6). */
    fun canDraw(ctx: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(ctx)

    fun show(ctx: Context, code: String, sender: String?) {
        val app = ctx.applicationContext
        if (!canDraw(app)) return
        main.post {
            try {
                val wm = app.getSystemService(Context.WINDOW_SERVICE) as? WindowManager ?: return@post
                removeCurrent(wm)
                val card = buildCard(
                    app, code, sender,
                    onCopy = {
                        val cm = app.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                        cm?.setPrimaryClip(ClipData.newPlainText("OTP", code))
                        Toast.makeText(app, "Code $code copied", Toast.LENGTH_SHORT).show()
                        removeCurrent(wm)
                    },
                    onClose = { removeCurrent(wm) },
                )
                val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                } else {
                    @Suppress("DEPRECATION")
                    WindowManager.LayoutParams.TYPE_PHONE
                }
                val lp = WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    type,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                    PixelFormat.TRANSLUCENT,
                )
                lp.gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
                lp.y = dp(app, 72)
                lp.width = screenWidth(wm) - dp(app, 24)
                wm.addView(card, lp)
                current = card
                pendingDismiss = Runnable { removeCurrent(wm) }
                main.postDelayed(pendingDismiss!!, AUTO_DISMISS_MS)
            } catch (_: Throwable) {
                // Overlay add can fail on some OEMs / race conditions — best-effort.
            }
        }
    }

    private fun removeCurrent(wm: WindowManager) {
        pendingDismiss?.let { main.removeCallbacks(it) }
        pendingDismiss = null
        val v = current ?: return
        current = null
        try {
            wm.removeView(v)
        } catch (_: Throwable) { /* already gone */ }
    }

    private fun buildCard(
        ctx: Context,
        code: String,
        sender: String?,
        onCopy: () -> Unit,
        onClose: () -> Unit,
    ): View {
        val pad = dp(ctx, 16)
        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            background = GradientDrawable().apply {
                cornerRadius = dp(ctx, 18).toFloat()
                setColor(Color.parseColor("#1B1B1D"))
                setStroke(dp(ctx, 1), Color.parseColor("#2E2E31"))
            }
            setOnClickListener { onCopy() }
        }

        val header = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
        }
        val brand = TextView(ctx).apply {
            text = "AvaTOK · OTP"
            setTextColor(Color.parseColor("#11A37F"))
            textSize = 13f
            setTypeface(typeface, Typeface.BOLD)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        val close = TextView(ctx).apply {
            text = "✕"
            setTextColor(Color.parseColor("#9A9A9E"))
            textSize = 16f
            setPadding(dp(ctx, 10), dp(ctx, 2), dp(ctx, 4), dp(ctx, 2))
            setOnClickListener { onClose() }
        }
        header.addView(brand)
        header.addView(close)
        root.addView(header)

        val codeView = TextView(ctx).apply {
            text = code
            setTextColor(Color.WHITE)
            textSize = 30f
            setTypeface(typeface, Typeface.BOLD)
            letterSpacing = 0.15f
            setPadding(0, dp(ctx, 8), 0, dp(ctx, 2))
        }
        root.addView(codeView)

        val hint = TextView(ctx).apply {
            text = if (!sender.isNullOrEmpty()) "One-time code from $sender" else "One-time code"
            setTextColor(Color.parseColor("#B5B5B8"))
            textSize = 13f
            setPadding(0, 0, 0, dp(ctx, 12))
        }
        root.addView(hint)

        val copyBtn = TextView(ctx).apply {
            text = "Copy code"
            setTextColor(Color.WHITE)
            textSize = 15f
            setTypeface(typeface, Typeface.BOLD)
            gravity = Gravity.CENTER
            setPadding(0, dp(ctx, 12), 0, dp(ctx, 12))
            background = GradientDrawable().apply {
                cornerRadius = dp(ctx, 12).toFloat()
                setColor(Color.parseColor("#11A37F"))
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
            setOnClickListener { onCopy() }
        }
        root.addView(copyBtn)

        return root
    }

    private fun dp(ctx: Context, v: Int): Int =
        (v * ctx.resources.displayMetrics.density).toInt()

    private fun screenWidth(wm: WindowManager): Int = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            wm.currentWindowMetrics.bounds.width()
        } else {
            val dm = android.util.DisplayMetrics()
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getMetrics(dm)
            dm.widthPixels
        }
    } catch (_: Throwable) {
        1080
    }
}

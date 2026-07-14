package ai.avatok.avadial

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

/**
 * [AVA-MISSEDCALL-1] Truecaller-style "you missed a call" card, drawn OVER all apps via
 * SYSTEM_ALERT_WINDOW so the user sees who called and can act without opening AvaTOK.
 * Mirrors the [AvaOtpOverlay] pattern (built programmatically, no XML, self-cleaning if
 * the process dies).
 *
 * Layout mirrors the reference screenshot:
 *   • avatar circle (initial) + name/number + "Missed call … rang Xs" + ✕
 *   • a full-width "View profile" button
 *   • RESPOND WITH MESSAGE chips: "Call me back?", "Sorry I'm busy", "Type custom…"
 *   • action row: CALL · MESSAGE · AVATOK  (NO WhatsApp — owner request)
 *
 * The AvaTOK action shows a round "t" badge that is BRIGHT (green) when the caller is a
 * known AvaTOK user and GREYED OUT otherwise. [update] re-paints it in place when a
 * late backend confirmation arrives (the "cache then backend" flow).
 *
 * Every button routes through [AvaMissedCallActions], so the card is fully functional
 * even when the Flutter engine is dead. Requires the "appear on top" permission —
 * [canDraw] gates every [show].
 */
object AvaMissedCallOverlay {
    private const val AUTO_DISMISS_MS = 45_000L
    private const val ACCENT = "#11A37F"        // AvaTOK green (bright AvaTOK badge)
    private const val GREY = "#4A4A4E"          // greyed AvaTOK badge (not on AvaTOK)
    private const val CARD_BG = "#1B1B1D"
    private const val CARD_STROKE = "#2E2E31"
    private const val CHIP_BG = "#2A2A2D"
    private const val TEXT_PRIMARY = "#FFFFFF"
    private const val TEXT_SECONDARY = "#B5B5B8"
    private const val TEXT_MUTED = "#9A9A9E"

    data class Info(
        val number: String?,
        val name: String?,
        val ringSecs: Int,
        val isAvatok: Boolean,
        val avatokNumber: String?,
    )

    private val main = Handler(Looper.getMainLooper())
    private var current: View? = null
    private var pendingDismiss: Runnable? = null

    // Live references so a late backend confirm can re-paint without rebuilding.
    private var avatokBadge: TextView? = null
    private var avatokLabel: TextView? = null
    private var nameView: TextView? = null
    private var shownNumber: String? = null

    /** True when we may draw over other apps (always true pre-Android 6). */
    fun canDraw(ctx: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(ctx)

    fun show(ctx: Context, info: Info) {
        val app = ctx.applicationContext
        if (!canDraw(app)) return
        main.post {
            try {
                val wm = app.getSystemService(Context.WINDOW_SERVICE) as? WindowManager ?: return@post
                removeCurrent(wm)
                shownNumber = info.number
                val card = buildCard(app, info, wm)
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
                lp.y = dp(app, 64)
                lp.width = screenWidth(wm) - dp(app, 24)
                wm.addView(card, lp)
                current = card
                pendingDismiss = Runnable { removeCurrent(wm) }
                main.postDelayed(pendingDismiss!!, AUTO_DISMISS_MS)
            } catch (_: Throwable) {
                // Overlay add can fail on some OEMs / races — best-effort.
            }
        }
    }

    /**
     * Late backend confirmation of the caller's AvaTOK status / name arrived — re-paint
     * the AvaTOK badge and (if we still only had a number) the caller name, in place. Only
     * applies if the currently-shown card is still for [number].
     */
    fun update(number: String?, isAvatok: Boolean, name: String?) {
        main.post {
            if (current == null || number == null || number != shownNumber) return@post
            paintAvatok(isAvatok)
            if (!name.isNullOrBlank()) nameView?.text = name
        }
    }

    fun dismiss() {
        main.post {
            val v = current ?: return@post
            try {
                val wm = v.context.applicationContext
                    .getSystemService(Context.WINDOW_SERVICE) as? WindowManager
                if (wm != null) removeCurrent(wm)
            } catch (_: Throwable) { /* ignore */ }
        }
    }

    private fun paintAvatok(isAvatok: Boolean) {
        val color = Color.parseColor(if (isAvatok) ACCENT else GREY)
        avatokBadge?.apply {
            (background as? GradientDrawable)?.setColor(color)
            alpha = if (isAvatok) 1f else 0.55f
        }
        avatokLabel?.setTextColor(Color.parseColor(if (isAvatok) TEXT_SECONDARY else TEXT_MUTED))
    }

    private fun removeCurrent(wm: WindowManager) {
        pendingDismiss?.let { main.removeCallbacks(it) }
        pendingDismiss = null
        val v = current ?: return
        current = null
        avatokBadge = null
        avatokLabel = null
        nameView = null
        shownNumber = null
        try {
            wm.removeView(v)
        } catch (_: Throwable) { /* already gone */ }
    }

    // ── View construction ───────────────────────────────────────────────────────
    private fun buildCard(ctx: Context, info: Info, wm: WindowManager): View {
        val pad = dp(ctx, 16)
        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            background = GradientDrawable().apply {
                cornerRadius = dp(ctx, 20).toFloat()
                setColor(Color.parseColor(CARD_BG))
                setStroke(dp(ctx, 1), Color.parseColor(CARD_STROKE))
            }
        }

        root.addView(buildHeader(ctx, info, wm))
        root.addView(buildViewProfileButton(ctx, info))
        root.addView(sectionLabel(ctx, "RESPOND WITH MESSAGE"))
        root.addView(buildChipRow(ctx, info))
        root.addView(divider(ctx))
        root.addView(buildActionRow(ctx, info))
        return root
    }

    private fun buildHeader(ctx: Context, info: Info, wm: WindowManager): View {
        val header = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
        }

        val title = (info.name?.takeIf { it.isNotBlank() } ?: info.number ?: "Unknown")
        val initial = title.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "?"

        val avatar = TextView(ctx).apply {
            text = initial
            setTextColor(Color.WHITE)
            textSize = 20f
            gravity = Gravity.CENTER
            setTypeface(typeface, Typeface.BOLD)
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#2E5D57"))
            }
            layoutParams = LinearLayout.LayoutParams(dp(ctx, 44), dp(ctx, 44)).apply {
                marginEnd = dp(ctx, 12)
            }
        }
        header.addView(avatar)

        val textCol = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        val name = TextView(ctx).apply {
            text = title
            setTextColor(Color.parseColor(TEXT_PRIMARY))
            textSize = 17f
            setTypeface(typeface, Typeface.BOLD)
            maxLines = 1
        }
        nameView = name
        val ringText = if (info.ringSecs > 0) {
            "Missed call · rang ${info.ringSecs}s"
        } else {
            "Missed call"
        }
        val sub = TextView(ctx).apply {
            text = ringText
            setTextColor(Color.parseColor(TEXT_SECONDARY))
            textSize = 13f
            setPadding(0, dp(ctx, 2), 0, 0)
        }
        textCol.addView(name)
        textCol.addView(sub)
        header.addView(textCol)

        val close = TextView(ctx).apply {
            text = "✕"
            setTextColor(Color.parseColor(TEXT_MUTED))
            textSize = 16f
            setPadding(dp(ctx, 12), dp(ctx, 4), dp(ctx, 4), dp(ctx, 4))
            setOnClickListener { removeCurrent(wm) }
        }
        header.addView(close)
        return header
    }

    private fun buildViewProfileButton(ctx: Context, info: Info): View {
        return TextView(ctx).apply {
            text = "View profile"
            setTextColor(Color.WHITE)
            textSize = 15f
            gravity = Gravity.CENTER
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, dp(ctx, 12), 0, dp(ctx, 12))
            background = GradientDrawable().apply {
                cornerRadius = dp(ctx, 12).toFloat()
                setColor(Color.parseColor("#2563C9"))
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = dp(ctx, 14) }
            setOnClickListener {
                AvaMissedCallActions.openInAvatok(ctx, info.number, info.avatokNumber)
            }
        }
    }

    private fun sectionLabel(ctx: Context, text: String): View =
        TextView(ctx).apply {
            this.text = text
            setTextColor(Color.parseColor(TEXT_MUTED))
            textSize = 11f
            letterSpacing = 0.08f
            setPadding(0, dp(ctx, 16), 0, dp(ctx, 8))
        }

    private fun buildChipRow(ctx: Context, info: Info): View {
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
        }
        row.addView(chip(ctx, "Call me back?") {
            AvaMissedCallActions.composeSms(ctx, info.number, "Call me back?")
        })
        row.addView(chip(ctx, "Sorry I'm busy") {
            AvaMissedCallActions.composeSms(ctx, info.number, "Sorry I'm busy")
        })
        row.addView(chip(ctx, "Type custom…") {
            AvaMissedCallActions.composeSms(ctx, info.number, null)
        })
        return row
    }

    private fun chip(ctx: Context, label: String, onTap: () -> Unit): View =
        TextView(ctx).apply {
            text = label
            setTextColor(Color.parseColor(TEXT_PRIMARY))
            textSize = 13f
            gravity = Gravity.CENTER
            maxLines = 1
            setPadding(dp(ctx, 10), dp(ctx, 10), dp(ctx, 10), dp(ctx, 10))
            background = GradientDrawable().apply {
                cornerRadius = dp(ctx, 20).toFloat()
                setColor(Color.parseColor(CHIP_BG))
            }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                .apply { marginEnd = dp(ctx, 8) }
            setOnClickListener { onTap() }
        }

    private fun divider(ctx: Context): View =
        View(ctx).apply {
            setBackgroundColor(Color.parseColor(CARD_STROKE))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(ctx, 1),
            ).apply { topMargin = dp(ctx, 16) }
        }

    private fun buildActionRow(ctx: Context, info: Info): View {
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = dp(ctx, 12) }
        }
        row.addView(action(ctx, "📞", "CALL", Color.parseColor(ACCENT)) {
            AvaMissedCallActions.callBack(ctx, info.number)
        })
        row.addView(action(ctx, "💬", "MESSAGE", Color.parseColor("#3A88E0")) {
            AvaMissedCallActions.composeSms(ctx, info.number, null)
        })
        row.addView(buildAvatokAction(ctx, info))
        return row
    }

    /** Generic circular emoji-glyph action (CALL / MESSAGE). */
    private fun action(ctx: Context, glyph: String, label: String, tint: Int, onTap: () -> Unit): View {
        val col = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            setOnClickListener { onTap() }
        }
        val badge = TextView(ctx).apply {
            text = glyph
            textSize = 20f
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(tint)
            }
            layoutParams = LinearLayout.LayoutParams(dp(ctx, 46), dp(ctx, 46))
        }
        val text = TextView(ctx).apply {
            this.text = label
            setTextColor(Color.parseColor(TEXT_SECONDARY))
            textSize = 11f
            setPadding(0, dp(ctx, 6), 0, 0)
        }
        col.addView(badge)
        col.addView(text)
        return col
    }

    /** The AvaTOK action — a round "t" badge, bright when the caller is on AvaTOK,
     *  greyed out otherwise. Held in [avatokBadge]/[avatokLabel] so [update] can re-paint. */
    private fun buildAvatokAction(ctx: Context, info: Info): View {
        val col = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            setOnClickListener {
                AvaMissedCallActions.openInAvatok(ctx, info.number, info.avatokNumber)
            }
        }
        val badge = TextView(ctx).apply {
            text = "t"
            setTextColor(Color.WHITE)
            textSize = 22f
            gravity = Gravity.CENTER
            setTypeface(typeface, Typeface.BOLD)
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor(if (info.isAvatok) ACCENT else GREY))
            }
            layoutParams = LinearLayout.LayoutParams(dp(ctx, 46), dp(ctx, 46))
        }
        val label = TextView(ctx).apply {
            text = "AVATOK"
            setTextColor(Color.parseColor(if (info.isAvatok) TEXT_SECONDARY else TEXT_MUTED))
            textSize = 11f
            setPadding(0, dp(ctx, 6), 0, 0)
        }
        avatokBadge = badge
        avatokLabel = label
        col.addView(badge)
        col.addView(label)
        paintAvatok(info.isAvatok)
        return col
    }

    // ── Utils ────────────────────────────────────────────────────────────────
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

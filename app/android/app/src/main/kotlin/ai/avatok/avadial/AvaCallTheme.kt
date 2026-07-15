package ai.avatok.avadial

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.TextView

/**
 * [AVADIAL-NATIVE-INCALL-1] ONE palette + ONE set of view builders shared by the
 * native ringing screen ([IncomingCallActivity]) and the native in-call screen
 * ([InCallActivity]).
 *
 * WHY THIS FILE EXISTS: before this, the ringing screen (native, #141416) and the
 * in-call screen (Flutter, #0B0B0D) were literally different colour schemes —
 * different background, different red, different green, different blue — so
 * answering a call visibly shifted the palette mid-flow. They read as two
 * different products because they WERE two different products. Now both screens
 * are native and both read their colours from here, so the ring → in-call handoff
 * (which is an Android task swap and can never be a shared-element transition)
 * reads as a crossfade instead of a jump.
 *
 * Everything is programmatic — this package has no XML layouts on purpose, because
 * the ringing screen must paint on a locked phone with no Flutter engine running.
 * The only resources it touches are the `ic_avadial_*` vector drawables.
 */
internal object AvaCallTheme {

    // ── palette (single source of truth for BOTH native call screens) ──────────
    const val BG = "#141416"
    const val SURFACE = "#1B1B1D"
    const val STROKE = "#2E2E31"
    const val CHIP = "#2A2A2D"
    const val TEXT_PRIMARY = "#FFFFFF"
    const val TEXT_SOFT = "#B5B5B8"
    const val TEXT_DIM = "#8A8A8D"

    const val DANGER = "#D9534F"
    const val ACCENT_ORANGE = "#E8883A"
    const val CONTACT_GREEN = "#11A37F"
    const val UNKNOWN_BLUE = "#7BA7D9"

    fun c(hex: String): Int = Color.parseColor(hex)

    /**
     * Fallback spam threshold. The REAL value is read from spam_snapshot.json's
     * `warn_threshold` (see [AvaCallScreeningService.warnThresholdOf]) — this is only
     * used when the snapshot is missing or unreadable. Previously the ring screen
     * hardcoded 70 and ignored the snapshot entirely, so tuning the threshold
     * server-side silently did nothing to the UI.
     */
    const val WARN_THRESHOLD_FALLBACK = 70

    // ── builders ──────────────────────────────────────────────────────────────

    fun dp(ctx: Context, v: Int): Int = (v * ctx.resources.displayMetrics.density).toInt()
    fun dpf(ctx: Context, v: Float): Int = (v * ctx.resources.displayMetrics.density).toInt()

    /** Filled circle holding a vector icon — the avatar on both screens. */
    fun avatar(ctx: Context, iconRes: Int, fill: Int, sizeDp: Int, iconDp: Int): ImageView =
        ImageView(ctx).apply {
            setImageResource(iconRes)
            scaleType = ImageView.ScaleType.FIT_CENTER
            val pad = dp(ctx, (sizeDp - iconDp) / 2)
            setPadding(pad, pad, pad, pad)
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(fill)
            }
        }

    /**
     * Circular icon button with a label underneath — the iOS-style control the owner
     * approved (2026-07-15 mockups). Returns the whole column; [onTap] fires on the
     * circle. Haptic on every press: these are TextView/ImageView-based (no Material
     * ripple), so without it a tap has NO acknowledgement whatsoever.
     */
    fun circleButton(
        ctx: Context,
        iconRes: Int,
        label: String,
        fill: Int,
        iconTint: Int = Color.WHITE,
        labelColor: Int = c(TEXT_SOFT),
        diameterDp: Int = 56,
        iconDp: Int = 24,
        onTap: (View) -> Unit,
    ): LinearLayout {
        val col = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
        }
        val circle = ImageView(ctx).apply {
            setImageResource(iconRes)
            setColorFilter(iconTint)
            scaleType = ImageView.ScaleType.FIT_CENTER
            val pad = dp(ctx, (diameterDp - iconDp) / 2)
            setPadding(pad, pad, pad, pad)
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(fill)
            }
            isClickable = true
            isFocusable = true
            setOnClickListener { v ->
                v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
                onTap(v)
            }
            attachPressFeedback(this)
        }
        col.addView(circle, LinearLayout.LayoutParams(dp(ctx, diameterDp), dp(ctx, diameterDp)))
        if (label.isNotEmpty()) {
            col.addView(TextView(ctx).apply {
                text = label
                textSize = 11f
                gravity = Gravity.CENTER
                setTextColor(labelColor)
            }, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(ctx, 6) })
        }
        return col
    }

    /** Rounded-rect pill (keypad digits, "Hide keypad"). */
    fun pill(
        ctx: Context,
        label: String,
        bg: Int,
        fg: Int,
        radiusDp: Int = 12,
        textSize: Float = 22f,
        onTap: () -> Unit,
    ): TextView = TextView(ctx).apply {
        text = label
        this.textSize = textSize
        gravity = Gravity.CENTER
        setTextColor(fg)
        background = GradientDrawable().apply {
            cornerRadius = dp(ctx, radiusDp).toFloat()
            setColor(bg)
        }
        isClickable = true
        isFocusable = true
        setOnClickListener {
            it.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
            onTap()
        }
        attachPressFeedback(this)
    }

    /** Card surface used by the spam banner and the audio-route chip. */
    fun card(ctx: Context): GradientDrawable = GradientDrawable().apply {
        cornerRadius = dp(ctx, 12).toFloat()
        setColor(c(SURFACE))
        setStroke(dp(ctx, 1), c(STROKE))
    }

    /**
     * Press feedback for views that have no Material ripple. Alpha dip only — cheap
     * enough for a cold locked device, and it means a tap is ALWAYS acknowledged
     * within one frame even when the action behind it takes a second to land.
     */
    private fun attachPressFeedback(v: View) {
        v.setOnTouchListener { view, ev ->
            when (ev.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN -> view.alpha = 0.6f
                android.view.MotionEvent.ACTION_UP,
                android.view.MotionEvent.ACTION_CANCEL -> view.alpha = 1f
            }
            false // never consume — the click listener still runs
        }
    }

    /**
     * Small "Coming soon" bubble anchored ABOVE a control (owner request 2026-07-15
     * for Voicemail + Send to Ava, which are announced-but-unbuilt products). Auto
     * dismisses. Deliberately NOT a Toast: a Toast renders at the bottom of the
     * screen behind the buttons and is easy to miss while a phone is ringing.
     */
    fun comingSoon(ctx: Context, anchor: View, text: String) {
        try {
            val bubble = TextView(ctx).apply {
                this.text = text
                textSize = 12f
                setTextColor(Color.WHITE)
                typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                setPadding(dp(ctx, 12), dp(ctx, 8), dp(ctx, 12), dp(ctx, 8))
                background = GradientDrawable().apply {
                    cornerRadius = dp(ctx, 10).toFloat()
                    setColor(c(CHIP))
                    setStroke(dp(ctx, 1), c(STROKE))
                }
            }
            val pop = PopupWindow(bubble, ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, false)
            pop.isOutsideTouchable = true
            bubble.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
            // Centre it over the anchor, sitting just above it.
            val xOff = (anchor.width - bubble.measuredWidth) / 2
            val yOff = -(anchor.height + bubble.measuredHeight + dp(ctx, 8))
            pop.showAsDropDown(anchor, xOff, yOff)
            anchor.postDelayed({ try { pop.dismiss() } catch (_: Throwable) {} }, 1800L)
        } catch (_: Throwable) { /* best-effort — never break a live call over a tooltip */ }
    }
}

package ai.avatok.avadial

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.widget.Toast

/**
 * [AVADIAL-OTP-1] Handles the "Copy code" action on the OTP heads-up pop-up posted
 * by [AvaSmsReceiver]. Runs as a background broadcast so the code lands on the
 * clipboard WITHOUT opening the app (clipboard WRITE from the background is allowed;
 * only READ is focus-restricted), then dismisses the pop-up. Not exported — only our
 * own notification action can trigger it.
 */
class AvaOtpCopyReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_COPY_OTP = "ai.avatok.avadial.COPY_OTP"
        const val EXTRA_CODE = "code"
        const val EXTRA_NOTIF_ID = "notif_id"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_COPY_OTP) return
        try {
            val code = intent.getStringExtra(EXTRA_CODE) ?: return
            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            cm?.setPrimaryClip(ClipData.newPlainText("OTP", code))
            Toast.makeText(context, "Code $code copied", Toast.LENGTH_SHORT).show()
            // [AVADIAL-OTP-TELEMETRY-1] Copy = the OTP feature paying off; paired with
            // avadial_otp_detected this is the conversion rate of the whole flow
            // (detected → copied), split by surface. Runs with the app closed and the
            // engine dead by design — the entire point of this receiver is that the
            // code reaches the clipboard WITHOUT opening AvaTOK — so it must be
            // track()'d, never emit()'d. `surface=notification` is hard-coded because
            // only the fallback notification's action can reach this receiver; the
            // overlay copies in-process and reports itself.
            // The code value never leaves the device: length only.
            AvaDialPlugin.track("avadial_otp_copied", mapOf(
                "surface" to "notification",
                "code_len" to code.length,
            ))
            val nid = intent.getIntExtra(EXTRA_NOTIF_ID, -1)
            if (nid != -1) {
                (context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)
                    ?.cancel(nid)
            }
        } catch (_: Throwable) {
            // Best-effort — never crash on a clipboard/notification hiccup.
        }
    }
}

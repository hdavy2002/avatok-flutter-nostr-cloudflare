package ai.avatok.avadial

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager

/**
 * [AVA-RCPT-5] AI-receptionist PSTN "expect" ping.
 *
 * [PLAY-SCOPE-1 2026-08-05] This receiver USED to raise a Truecaller-style missed-call
 * overlay (AvaMissedCallOverlay) and fall back to reading the device call log to name
 * the caller. Both are GONE: AvaTOK is AvaTOK-to-AvaTOK calling only, so there is no
 * overlay, no SYSTEM_ALERT_WINDOW, no READ_CALL_LOG and no /api/missedcall/lookup
 * confirm. The single remaining job is the receptionist ping described below.
 *
 * Registered for `android.intent.action.PHONE_STATE` — a protected broadcast the OS
 * delivers to a manifest receiver holding READ_PHONE_STATE, and one of the few implicit
 * broadcasts still allowed to a manifest receiver on Android 8+.
 *
 * Unanswered = we saw RINGING and then went IDLE WITHOUT ever passing through OFFHOOK
 * (an OFFHOOK means the call was answered — or it was an outgoing call, which starts at
 * OFFHOOK and so is ignored). State is tracked in the companion because the OS spins up
 * a fresh receiver instance per broadcast.
 *
 * When that happens, the carrier's own no-answer forwarding (CFNRy — armed by the
 * receptionist setup's MMI dial) has ALREADY diverted the call to the receptionist DID.
 * All we do is pre-register the caller with the worker so its answer route can map that
 * forwarded leg back to this owner. Nothing is read, shown or stored on the device.
 *
 * Fully DARK unless Dart wrote `{enabled:true}` into pstn_config.json — see
 * [AvaDialPlugin.pstnVoicemailEnabled], which fails CLOSED.
 */
class AvaMissedCallReceiver : BroadcastReceiver() {

    companion object {
        @Volatile private var sawRinging = false
        @Volatile private var wasOffhook = false
        @Volatile private var incomingNumber: String? = null
        @Volatile private var lastState: String? = null
    }

    override fun onReceive(context: Context?, intent: Intent?) {
        val ctx = context?.applicationContext ?: return
        if (intent?.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return

        val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE) ?: return
        if (state == lastState) return // de-dupe duplicate broadcasts
        lastState = state

        when (state) {
            TelephonyManager.EXTRA_STATE_RINGING -> {
                sawRinging = true
                wasOffhook = false
                // Best-effort — the OS usually withholds this now that we no longer
                // hold READ_CALL_LOG. The worker tolerates a null caller exactly the
                // way it already did for hidden caller ID.
                intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)
                    ?.takeIf { it.isNotBlank() }?.let { incomingNumber = it }
            }

            TelephonyManager.EXTRA_STATE_OFFHOOK -> {
                wasOffhook = true
            }

            TelephonyManager.EXTRA_STATE_IDLE -> {
                val unanswered = sawRinging && !wasOffhook
                val number = incomingNumber
                // Reset before any work so a re-entrant broadcast can't double-fire.
                sawRinging = false
                wasOffhook = false
                incomingNumber = null
                if (unanswered && AvaDialPlugin.pstnVoicemailEnabled(ctx)) {
                    AvaDialPlugin.firePstnExpect(ctx, number)
                }
            }
        }
    }
}

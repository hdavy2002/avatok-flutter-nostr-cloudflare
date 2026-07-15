package ai.avatok.avadial

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * [AVADIAL-HARDEN-1] Handles the Answer/Decline actions on the incoming-call
 * notification posted by [AvaInCallService.launchIncoming]. Needed because on
 * Android 14+ (and many OEM skins) the full-screen intent is routinely demoted to a
 * plain heads-up banner, leaving the user nothing to tap if Flutter/MainActivity
 * hasn't come up yet — these two buttons work directly off the notification with
 * zero dependency on the Dart side being alive. Not exported — only our own
 * notification actions fire it.
 */
class AvaCallActionReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_CALL_ACTION = "ai.avatok.avadial.CALL_ACTION"
        const val EXTRA_CALL_ID = "call_id"
        const val EXTRA_NUMBER = "number"
        const val EXTRA_ACTION = "action"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_CALL_ACTION) return
        try {
            val callId = intent.getStringExtra(EXTRA_CALL_ID)
            val number = intent.getStringExtra(EXTRA_NUMBER)
            val action = intent.getStringExtra(EXTRA_ACTION) ?: return

            // Relay to the live Call via AvaInCallService's static call map — same
            // path Flutter's answer()/reject() use. This is the ONLY line that talks
            // to Telecom; the when-block below exists purely for UI side effects
            // (bringing up an activity, cancelling a notification) on TOP of the
            // relay, never instead of it. [AVADIAL-INCALL-NOTIF-1] "end_call",
            // "mute_toggle", "speaker_toggle" (sent by the ongoing CallStyle
            // notification's Hang Up/Mute/Speaker actions) are fully handled by this
            // one relay call — AvaInCallService.action() does all the state mapping
            // and idempotency guarding — so they deliberately fall through the
            // when-block below with no matching branch (a Kotlin `when` used as a
            // statement, not an expression, does not require exhaustiveness).
            AvaInCallService.action(callId, action, null)

            when (action) {
                "answer" -> {
                    // [AVADIAL-INCALL-ANSWER-1] With the native in-call flag ON, the
                    // notification's Answer action is now an ACTIVITY PendingIntent
                    // straight to InCallActivity (see AvaInCallService.launchIncoming) —
                    // SystemUI launches it directly, so this receiver is never reached
                    // for that tap at all, and InCallActivity.onCreate is the one that
                    // calls answer() (after validating the call is still ringing).
                    // What follows is the flag-OFF fallback only: the call was already
                    // answered above via AvaInCallService.action(callId, action, null),
                    // and we bring up the legacy Flutter in-call UI the same way
                    // AvaInCallService.launchIncoming does, in case Flutter/MainActivity
                    // isn't already on screen.
                    // [AVADIAL-HARDEN-2] "answered" tells the Dart side the call was already
                    // answered from this notification action — so it lands on the ACTIVE
                    // call UI instead of the ringing screen (which would be stuck: the call
                    // is already answered by the time Flutter boots on a cold start).
                    val activityIntent = Intent(context, Class.forName("ai.avatok.avatok_call.MainActivity")).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                        putExtra("route", "avadial/incoming")
                        putExtra("call_id", callId)
                        putExtra("number", number)
                        putExtra("answered", true)
                    }
                    try {
                        context.startActivity(activityIntent)
                    } catch (_: Throwable) {
                        /* background-activity-launch blocked on this OEM — best-effort */
                    }
                }
                "reject" -> {
                    try {
                        (context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)
                            ?.cancel(AvaInCallService.NOTIF_ID)
                    } catch (_: Throwable) { /* best-effort */ }
                }
                // [AVADIAL-INCALL-NOTIF-1] The ongoing CallStyle notification's Hang
                // Up action. Explicit no-op branch on purpose: unlike "reject" above
                // (a still-RINGING call whose notification should disappear), an
                // "end_call" on an ACTIVE/HOLDING call must NOT cancel NOTIF_ID here —
                // that same id is the ongoing notification, and cancelling it early
                // would blank the control surface before onCallRemoved's normal
                // teardown. The relay call above already told the service to
                // reject()/disconnect() by state; nothing else to do, and definitely
                // must never fall into the "answer" branch's MainActivity launch.
                "end_call" -> { /* no UI side effect — service + notification own this */ }
                // [AVADIAL-INCALL-NOTIF-1] Ongoing-notification Mute/Speaker actions.
                // Fully handled by the relay call above (toggles the live
                // CallAudioState); no activity to launch, nothing to cancel.
                "mute_toggle" -> { /* no-op here — handled by the relay above */ }
                "speaker_toggle" -> { /* no-op here — handled by the relay above */ }
            }
        } catch (_: Throwable) {
            // Best-effort — never crash on a notification-action hiccup.
        }
    }
}

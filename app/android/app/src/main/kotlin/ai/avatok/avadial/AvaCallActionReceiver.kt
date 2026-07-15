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
            // path Flutter's answer()/reject() use.
            AvaInCallService.action(callId, action, null)

            when (action) {
                "answer" -> {
                    // [AVADIAL-NATIVE-INCALL-1] Prefer the native in-call screen when the
                    // flag is on — same handoff IncomingCallActivity makes, and the same
                    // reason: answering from the notification should not cold-boot the
                    // whole Flutter app to draw four buttons over native functions.
                    // Fail-closed to the Flutter path on any doubt.
                    if (callId != null && AvaDialPlugin.nativeInCallEnabled(context)) {
                        try {
                            context.startActivity(InCallActivity.intentFor(context, callId, number))
                            return
                        } catch (_: Throwable) { /* fall through to Flutter below */ }
                    }
                    // Bring the in-call UI up the same way AvaInCallService.launchIncoming
                    // does, in case Flutter/MainActivity isn't already on screen.
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
            }
        } catch (_: Throwable) {
            // Best-effort — never crash on a notification-action hiccup.
        }
    }
}

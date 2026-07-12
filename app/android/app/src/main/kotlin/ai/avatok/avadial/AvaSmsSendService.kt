package ai.avatok.avadial

import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * "Respond via message" service (AVA-SMS). Registered for
 * `android.intent.action.RESPOND_VIA_MESSAGE` and protected by
 * `SEND_RESPOND_VIA_MESSAGE_SERVICE`. This is the third of the four mandatory
 * default-SMS components: the platform's incoming-call UI ("reject with a quick
 * text") starts THIS service on the current default SMS app. WITHOUT it declared,
 * the ROLE_SMS request silently fails (see Specs/SPIKE-2026-07-12-avadial-telecom.md).
 *
 * SCOPE (minimal, spec-compliant): the OS delivers the quick-reply text via the
 * start intent (EXTRA_TEXT + the recipient in the intent data). We hand it to the
 * existing send path so the reply actually goes out, then stop. Bound calls are not
 * used by this action (the platform starts it, it never binds), so onBind returns
 * null. DARK behind the Flutter `avaSms` flag — only reachable while AvaTOK holds
 * ROLE_SMS.
 */
class AvaSmsSendService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            if (intent?.action == "android.intent.action.RESPOND_VIA_MESSAGE") {
                val text = intent.getStringExtra(Intent.EXTRA_TEXT)
                // Recipient comes from the intent data URI: sms:/smsto:/mms:/mmsto:.
                val dest = intent.data?.schemeSpecificPart
                    ?.substringBefore('?')
                    ?.trim()
                    ?.takeIf { it.isNotEmpty() }
                if (!dest.isNullOrEmpty() && !text.isNullOrEmpty()) {
                    // Reuse the plugin's send path (multipart + provider mirror). It is
                    // a no-op status-wise if the engine is dead, but the SMS still goes.
                    AvaDialPlugin.sendQuickReply(applicationContext, dest, text)
                }
            }
        } catch (_: Throwable) {
            // Never crash the respond-via-message flow.
        }
        // Not sticky — one-shot per quick-reply.
        stopSelf(startId)
        return START_NOT_STICKY
    }
}

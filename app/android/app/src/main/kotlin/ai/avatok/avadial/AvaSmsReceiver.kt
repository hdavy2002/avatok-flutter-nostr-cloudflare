package ai.avatok.avadial

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Telephony
import android.telephony.SmsMessage
import org.json.JSONObject
import java.security.MessageDigest

/**
 * Default-SMS-app inbound receiver (AVA-SMS). Registered for
 * `SMS_DELIVER_ACTION` and protected by `BROADCAST_SMS`, so the OS delivers
 * incoming SMS to us ONLY while AvaTOK holds ROLE_SMS. This is one of the four
 * mandatory default-SMS components — the role request silently fails if any is
 * missing (see the manifest + Specs/SPIKE-2026-07-12-avadial-telecom.md §SMS).
 *
 * Responsibilities on each inbound message:
 *   1. Parse the PDUs → sender + body (multipart concatenated).
 *   2. Persist to the OS SMS provider (`content://sms/inbox`). Unlike SMS_RECEIVED,
 *      SMS_DELIVER makes US responsible for writing the message — the platform no
 *      longer auto-persists it. Bodies live ONLY here (device-data boundary); our
 *      scoped store keeps spam labels/metadata, never text.
 *   3. Run the local spam check against the SAME snapshot the CallScreeningService
 *      reads (`<filesDir>/avadial/spam_snapshot.json`) — LABEL only, never drop.
 *   4. Forward `onSmsReceived {address, body, date, spam}` to Flutter (best-effort;
 *      the engine may be dead — the provider write above is the durable path).
 *   5. Post a notification on the "avadial_sms" channel.
 *
 * Everything is DARK behind the Flutter `avaSms` flag: this component only ever
 * fires once the user grants ROLE_SMS, which the app never requests unless the
 * flag is on.
 */
class AvaSmsReceiver : BroadcastReceiver() {

    companion object {
        private const val CHANNEL_ID = "avadial_sms"
        private const val NOTIF_BASE = 42200
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_DELIVER_ACTION) return
        try {
            val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
            if (messages.isEmpty()) return
            val address = messages[0].originatingAddress ?: messages[0].displayOriginatingAddress
            val body = StringBuilder()
            for (m: SmsMessage in messages) body.append(m.messageBody ?: "")
            val text = body.toString()
            val ts = messages[0].timestampMillis.takeIf { it > 0 } ?: System.currentTimeMillis()

            persistToInbox(context, address, text, ts)
            val spam = isSpam(context, address)

            AvaDialPlugin.emit(
                "onSmsReceived",
                mapOf("address" to address, "body" to text, "date" to ts, "spam" to spam)
            )
            // OTP fast-path: if the message carries a one-time code, surface a
            // high-priority heads-up pop-up with a one-tap "Copy code" button — the
            // AvaTOK equivalent of Truecaller's OTP card. Only fires when the body
            // both mentions a code and contains a 4–8 digit run, to avoid false
            // positives on ordinary texts. Spam messages are skipped (never invite a
            // one-tap copy from a suspected-spam sender).
            if (!spam) {
                extractOtp(text)?.let { code ->
                    if (AvaOtpOverlay.canDraw(context)) {
                        // Primary: the Truecaller-style floating card over all apps.
                        AvaOtpOverlay.show(context, code, address)
                    } else {
                        // "Appear on top" not granted yet (the setup sheet prompts for
                        // it) — fall back to the heads-up copy notification so the OTP
                        // is never lost in the meantime.
                        notifyOtp(context, address, code)
                    }
                }
            }
            notify(context, address, text, spam)
        } catch (_: Throwable) {
            // Never crash the SMS pipeline — a parse/store failure just drops our
            // enrichment; the message is not lost from the user's perspective.
        }
    }

    /** Write the inbound message into the OS SMS provider (default-app duty). */
    private fun persistToInbox(ctx: Context, address: String?, body: String, ts: Long) {
        try {
            val values = ContentValues().apply {
                put(Telephony.Sms.ADDRESS, address)
                put(Telephony.Sms.BODY, body)
                put(Telephony.Sms.DATE, ts)
                put(Telephony.Sms.READ, 0)
                put(Telephony.Sms.SEEN, 0)
                put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_INBOX)
            }
            ctx.contentResolver.insert(Telephony.Sms.Inbox.CONTENT_URI, values)
        } catch (_: Throwable) { /* not default SMS app → provider write denied */ }
    }

    /**
     * Local, zero-network spam check against the shared snapshot. Mirrors
     * [AvaCallScreeningService]'s hashing (SHA-256 of the raw number, lowercase hex).
     * Missing/corrupt snapshot → not spam (fail-open). Warn-threshold and above
     * counts as spam-labelled (label only — the message is always delivered).
     */
    private fun isSpam(ctx: Context, address: String?): Boolean {
        if (address.isNullOrEmpty()) return false
        return try {
            val file = AvaDialPlugin.snapshotFile(ctx)
            if (!file.exists() || file.length() == 0L) return false
            val json = JSONObject(file.readText())
            val warn = json.optInt("warn_threshold", 70)
            val scores = json.optJSONObject("scores") ?: return false
            val hash = sha256Hex(address)
            scores.has(hash) && scores.optInt(hash, 0) >= warn
        } catch (_: Throwable) {
            false
        }
    }

    private fun sha256Hex(s: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        val bytes = md.digest(s.toByteArray(Charsets.UTF_8))
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            if (v < 0x10) sb.append('0')
            sb.append(Integer.toHexString(v))
        }
        return sb.toString()
    }

    /**
     * Pull a one-time passcode out of an SMS body, or null if it isn't an OTP
     * message. Requires BOTH an OTP-ish keyword AND a standalone 4–8 digit run, so
     * ordinary texts that merely contain numbers don't trigger the copy pop-up.
     */
    private fun extractOtp(body: String): String? {
        val lower = body.lowercase()
        val keyword = listOf(
            "otp", "one-time", "one time", "verification", "verify", "code",
            "passcode", "password", "pin", "2fa", "auth", "confirm",
        ).any { lower.contains(it) }
        if (!keyword) return null
        // A 4–8 digit run not glued to more digits (avoids grabbing phone numbers /
        // order ids). Prefer the first such run — OTPs lead the message in practice.
        val match = Regex("(?<![0-9])[0-9]{4,8}(?![0-9])").find(body) ?: return null
        return match.value
    }

    /**
     * High-priority heads-up OTP pop-up with a one-tap "Copy code" action. The copy
     * runs in [AvaOtpCopyReceiver] (a background broadcast) so the code lands on the
     * clipboard WITHOUT opening the app, then the pop-up dismisses itself.
     */
    private fun notifyOtp(ctx: Context, address: String?, code: String) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        val channelId = "avadial_otp"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(channelId, "OTP codes", NotificationManager.IMPORTANCE_HIGH)
            )
        }
        // Offset by 0x10000 so OTP ids never collide with the per-sender message
        // notification ids (NOTIF_BASE + a 16-bit sender hash).
        val id = NOTIF_BASE + 0x10000 + (code.hashCode() and 0x0000ffff)
        val copyIntent = Intent(ctx, AvaOtpCopyReceiver::class.java).apply {
            action = AvaOtpCopyReceiver.ACTION_COPY_OTP
            putExtra(AvaOtpCopyReceiver.EXTRA_CODE, code)
            putExtra(AvaOtpCopyReceiver.EXTRA_NOTIF_ID, id)
        }
        val copyPending = PendingIntent.getBroadcast(
            ctx, id, copyIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(ctx, channelId)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(ctx)
        }
        @Suppress("DEPRECATION")
        val notif = builder
            .setSmallIcon(ctx.applicationInfo.icon)
            .setContentTitle("Your code: $code")
            .setContentText(if (!address.isNullOrEmpty()) "From $address · tap Copy code" else "Tap Copy code")
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setPriority(Notification.PRIORITY_HIGH) // heads-up on API < 26
            .addAction(0, "Copy code", copyPending)
            .build()
        try {
            nm.notify(id, notif)
        } catch (_: Throwable) { /* POST_NOTIFICATIONS may be denied — best-effort */ }
    }

    private fun notify(ctx: Context, address: String?, body: String, spam: Boolean) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Text messages", NotificationManager.IMPORTANCE_HIGH)
            )
        }
        // Tap → open the compose/thread route in the Flutter shell.
        val intent = Intent().apply {
            setClassName(ctx, "ai.avatok.avatok_call.MainActivity")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra("route", "avadial/compose")
            putExtra("number", address)
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val id = NOTIF_BASE + ((address?.hashCode() ?: 0) and 0x0000ffff)
        val pending = PendingIntent.getActivity(ctx, id, intent, flags)
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(ctx, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(ctx)
        }
        val title = if (spam) "Suspected spam · ${address ?: "Unknown"}" else (address ?: "New message")
        val notif = builder
            .setSmallIcon(ctx.applicationInfo.icon)
            .setContentTitle(title)
            .setContentText(body)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        try {
            nm.notify(id, notif)
        } catch (_: Throwable) { /* POST_NOTIFICATIONS may be denied — best-effort */ }
    }
}

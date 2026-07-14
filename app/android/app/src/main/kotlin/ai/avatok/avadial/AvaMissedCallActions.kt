package ai.avatok.avadial

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri

/**
 * [AVA-MISSEDCALL-1] Side-effect helpers for the Truecaller-style missed-call overlay
 * ([AvaMissedCallOverlay]). Kept OUT of the overlay's view code so the card stays pure
 * UI and every button routes through one audited place.
 *
 * These run from a windowless context (a BroadcastReceiver / the overlay's WindowManager
 * view), so every intent is launched with FLAG_ACTIVITY_NEW_TASK. All are best-effort —
 * a missing dialer/SMS app must never crash the overlay.
 */
object AvaMissedCallActions {

    /** Call the number back. Direct ACTION_CALL when CALL_PHONE is granted, else the
     *  dialer is opened pre-filled (ACTION_DIAL needs no permission). */
    fun callBack(ctx: Context, number: String?) {
        if (number.isNullOrBlank()) return
        val app = ctx.applicationContext
        val canCall = app.checkSelfPermission(Manifest.permission.CALL_PHONE) ==
            PackageManager.PERMISSION_GRANTED
        val action = if (canCall) Intent.ACTION_CALL else Intent.ACTION_DIAL
        try {
            app.startActivity(
                Intent(action, Uri.fromParts("tel", number, null))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (_: Throwable) {
            // Fall back to the plain dialer if a direct call was refused.
            try {
                app.startActivity(
                    Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            } catch (_: Throwable) { /* no dialer — give up */ }
        }
    }

    /** Open the system SMS composer to [number], optionally pre-filled with [body]
     *  (the "Call me back?" / "Sorry I'm busy" quick replies). */
    fun composeSms(ctx: Context, number: String?, body: String?) {
        if (number.isNullOrBlank()) return
        val app = ctx.applicationContext
        try {
            val i = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(number)))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (!body.isNullOrEmpty()) i.putExtra("sms_body", body)
            app.startActivity(i)
        } catch (_: Throwable) { /* no SMS app */ }
    }

    /** Open AvaTOK to this caller (the "View profile" button + the AvaTOK action). Brings
     *  the app forward and hands the number to Dart via [AvaDialPlugin.notifyOpenDial],
     *  which routes to the contact / dialer. Falls back to a plain app launch. */
    fun openInAvatok(ctx: Context, number: String?, avatokNumber: String?) {
        val app = ctx.applicationContext
        // Cold-start drain path: stash the pending open even if the engine is dead, so
        // Dart picks it up on next launch.
        AvaDialPlugin.notifyOpenDial(number, avatokNumber)
        try {
            val launch = app.packageManager.getLaunchIntentForPackage(app.packageName)
            if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                launch.putExtra("route", "avadial/openDial")
                if (!number.isNullOrEmpty()) launch.putExtra("number", number)
                if (!avatokNumber.isNullOrEmpty()) launch.putExtra("avatok_number", avatokNumber)
                app.startActivity(launch)
            }
        } catch (_: Throwable) { /* best-effort */ }
    }
}

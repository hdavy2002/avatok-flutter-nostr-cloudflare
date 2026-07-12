package ai.avatok.avadial

import android.app.Activity
import android.app.role.RoleManager
import android.content.Context

/**
 * Thin wrapper over [RoleManager] for the two AvaDial roles (spike §1, §3):
 *   - ROLE_DIALER          — "Phone app" / default dialer (grants InCallService +
 *                            READ_CALL_LOG + BlockedNumberContract write).
 *   - ROLE_CALL_SCREENING  — "Caller ID & spam app" — independently requestable, so
 *                            the spam shield works even when the user declines the
 *                            full dialer role.
 *
 * We NEVER strip our own role (the OS owns removal). "Rollback" = detect we lost it
 * on resume ([isRoleHeld]) and downgrade the UI; that logic lives on the Dart side.
 */
object AvaDialRoleHelper {
    const val REQ_DIALER = 42101
    const val REQ_SCREENING = 42102

    private fun requestCodeFor(roleName: String): Int = when (roleName) {
        RoleManager.ROLE_CALL_SCREENING -> REQ_SCREENING
        else -> REQ_DIALER
    }

    /**
     * Kick off the role request. Returns:
     *   - `false` when there is nothing to prompt for (role unavailable on this
     *     device, or already held) — caller resolves synchronously via [isRoleHeld];
     *   - `true` when a system prompt was launched — the verdict arrives in the
     *     Activity's onActivityResult (forwarded to Dart as `onRoleResult`).
     */
    fun requestRole(activity: Activity, roleName: String): Boolean {
        val rm = activity.getSystemService(RoleManager::class.java) ?: return false
        if (!rm.isRoleAvailable(roleName)) return false
        if (rm.isRoleHeld(roleName)) return false
        val intent = rm.createRequestRoleIntent(roleName)
        activity.startActivityForResult(intent, requestCodeFor(roleName))
        return true
    }

    /** Whether the given role is currently held. Safe on devices without telephony. */
    fun isRoleHeld(context: Context, roleName: String): Boolean {
        val rm = context.getSystemService(RoleManager::class.java) ?: return false
        return try {
            rm.isRoleAvailable(roleName) && rm.isRoleHeld(roleName)
        } catch (_: Throwable) {
            false
        }
    }
}

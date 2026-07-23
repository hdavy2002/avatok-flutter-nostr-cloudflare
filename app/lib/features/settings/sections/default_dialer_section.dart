// [ONBOARD-CLEANUP-1 2026-07-23] The "Default phone & messages" settings
// section (AVA-DIAL-6) has been REMOVED. AvaTOK no longer seeks the Android
// default dialer / SMS roles — spam can't be filtered well enough as a default
// handler, and the consolidated onboarding permissions page now covers every
// permission the app legitimately needs.
//
// Registration was already disabled on 2026-07-16 (see ava_bootstrap.dart —
// registerDefaultDialerSection() call site is commented out). The whole
// role-request card + "Phone setup checklist" entry point that lived here is
// gone. This stub is retained only because the file cannot be deleted from the
// shared tree in this environment; it registers NOTHING.
//
// The native role-helper plumbing (AvaDialChannel / RoleManager / InCallService)
// is intentionally left intact for AvaTOK-to-AvaTOK calling where the role was
// granted before. Do NOT re-introduce a default-dialer/SMS role request without
// an explicit owner decision.
library;

/// No-op. Kept so any stale call site still resolves; it registers no settings
/// section. See the file header for why the section was removed.
void registerDefaultDialerSection() {
  // Intentionally empty — the default-dialer/SMS settings section is removed.
}

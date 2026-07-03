import 'package:flutter/material.dart';

import '../auth/clerk_client.dart';
import '../features/auth/sign_in_screen.dart';
import '../features/identity/human_check_page.dart';
import '../identity/identity.dart';
import 'remote_config.dart';

/// Account gate (Trust Ladder L0 → L1). Browsing is free for an L0 visitor
/// (handle-only guest token). The moment a guest tries to do something that
/// needs a real, recoverable account — adding an AvaTok contact, messaging,
/// etc. — we send them to AvaIdentity to become an L1 member (Clerk
/// email + password + OTP; the @handle they already reserved is kept).
///
/// This is the ONLY place the email/password sign-up surfaces from inside the
/// app: every other auth layer stays hidden until an action actually needs it.
///
/// Usage:
///   final ok = await AccountGate.ensureMember(context, reason: 'add a contact');
///   if (!ok) return; // still a guest — they backed out
class AccountGate {
  AccountGate._();

  /// A member is anyone with a real (Clerk) account. We scope all per-account
  /// state to the Clerk id, so a non-empty [AccountScope.id] == signed-in member.
  /// A guest browses with [AccountScope.id] == null (default/legacy scope).
  static bool get isMember =>
      AccountScope.id != null && AccountScope.id!.isNotEmpty;

  /// Wired once by RootFlow so the gate can drive Clerk sign-up and re-route the
  /// app after a guest upgrades.
  static ClerkClient? clerk;
  static Future<void> Function()? onUpgraded;

  /// Ensures the caller is at least an L1 member. Returns immediately for
  /// members. For guests, opens the AvaIdentity sign-up (email + password +
  /// OTP). Returns true once the upgrade completes.
  static Future<bool> ensureMember(BuildContext context,
      {required String reason}) async {
    if (isMember) return true;
    final c = clerk;
    if (c == null) return false;

    final done = await Navigator.of(context, rootNavigator: true).push<bool>(
      MaterialPageRoute(
        fullscreenDialog: true,
        builder: (_) => SignInScreen(
          clerk: c,
          initialMode: SignInMode.signUp,
          gateReason: reason,
          onSignedIn: () =>
              Navigator.of(context, rootNavigator: true).pop(true),
        ),
      ),
    );
    if (done == true) {
      await onUpgraded?.call();
      // STREAM H [LIVE-GATE-3 signup]: D12 hard gate. The moment a real account is
      // created (credentials now exist), require the human check BEFORE the gated
      // action resumes / the app lands. Non-dismissible while the flag is ON.
      if (RemoteConfig.livenessOnboardingGate && isMember && context.mounted) {
        await Navigator.of(context, rootNavigator: true).push<bool>(
          MaterialPageRoute(
            fullscreenDialog: true,
            builder: (_) => HumanCheckPage(
              source: HumanCheckSource.signup,
              // Signup variant pops itself on pass; the gated action then resumes.
              onVerified: () => Navigator.of(context, rootNavigator: true).pop(true),
            ),
          ),
        );
      }
      return isMember;
    }
    return false;
  }
}

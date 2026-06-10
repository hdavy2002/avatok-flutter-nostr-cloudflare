import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';
import 'onboarding_store.dart';
import 'prefs_sync.dart';
import 'profile_store.dart';
import '../identity/identity.dart';

/// Transient holder for the password typed at sign-in / sign-up. Kept only
/// because the sign-in screen sets it; the restore flow no longer needs it —
/// the Clerk session IS the account credential (Cloudflare-native pivot).
class AuthSession {
  static String? lastPassword;
}

/// What the server knows about the signed-in Clerk account (GET /api/me).
/// Post-pivot the account IS the Clerk uid — there are no key backups.
class MeResult {
  final bool found;
  final bool clerkEnabled;
  final String? uid;
  final String? handle;
  final String? displayName;
  final String? avatarUrl;
  const MeResult({
    required this.found,
    required this.clerkEnabled,
    this.uid,
    this.handle,
    this.displayName,
    this.avatarUrl,
  });
}

/// Where login routes a user with NO local state (fresh install / new phone):
/// - restored:    account found → device set up automatically → dashboard.
/// - newUser:     server has no account for them → onboarding.
/// - unavailable: couldn't reach the server → retry screen. Never onboarding,
///                so an existing user can't accidentally fork their account.
/// (needsRecovery is retired: signing in IS the recovery. Kept in the enum so
/// old switch statements compile; it is never produced.)
enum RestoreOutcome { restored, newUser, needsRecovery, unavailable }

class RestoreState {
  final RestoreOutcome outcome;
  final String? handle;
  final String? displayName;
  const RestoreState(this.outcome, {this.handle, this.displayName});
}

/// Sets up a returning user's account on a new device / fresh install.
///
/// Cloudflare-native model: the Clerk sign-in is the ONLY credential. Messages
/// live server-side in the user's InboxDO (keyed by uid), prefs/settings/apps
/// live in the server vault, media is re-cached on demand. The local keypair is
/// a vestigial internal credential the server no longer verifies — we mint a
/// fresh one silently. No password re-entry, no recovery key, ever.
class AccountRestore {
  /// GET /api/me using the Clerk session JWT.
  static Future<MeResult?> fetchMe() async {
    try {
      final r = await ApiAuth.getSigned(kMeUrl);
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      return MeResult(
        found: j['found'] == true,
        clerkEnabled: j['clerk_enabled'] != false,
        uid: j['uid']?.toString(),
        handle: (j['handle'] ?? '').toString().isEmpty ? null : j['handle'].toString(),
        displayName: (j['display_name'] ?? '').toString().isEmpty ? null : j['display_name'].toString(),
        avatarUrl: (j['avatar_url'] ?? '').toString().isEmpty ? null : j['avatar_url'].toString(),
      );
    } catch (_) {
      return null; // offline → caller shows retry, never onboarding
    }
  }

  /// Decide where login routes a user with no local state. If the server knows
  /// this Clerk account, the device is set up automatically — signing in is all
  /// the proof we need.
  static Future<RestoreState> restoreFromServer() async {
    final me = await fetchMe();
    if (me == null) return const RestoreState(RestoreOutcome.unavailable);
    if (!me.found) {
      // Only treat as brand-new when Clerk verification positively told us
      // there's no account. If Clerk is off/unknown, don't risk onboarding.
      return me.clerkEnabled
          ? const RestoreState(RestoreOutcome.newUser)
          : const RestoreState(RestoreOutcome.unavailable);
    }
    await _install(handle: me.handle, displayName: me.displayName);
    return RestoreState(RestoreOutcome.restored, handle: me.handle, displayName: me.displayName);
  }

  /// Set the device up for this account: mint the internal signing key if none,
  /// refill the local profile, pull prefs (enabled apps, filters, settings…)
  /// from the server vault, and mark onboarding done → straight to dashboard.
  static Future<void> _install({String? handle, String? displayName}) async {
    final store = IdentityStore();
    if (await store.load() == null) await store.createAndStore();
    final ps = ProfileStore();
    final cur = await ps.load();
    await ps.save(cur.copyWith(
      displayName: displayName ?? cur.displayName,
      handle: handle ?? cur.handle,
    ));
    await PrefsSync.pull();
    await OnboardingStore().setDone();
  }
}

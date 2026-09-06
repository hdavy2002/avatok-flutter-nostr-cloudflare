import 'dart:convert';

import 'account_key.dart';
import 'api_auth.dart';
import 'config.dart';
import 'onboarding_store.dart';
import 'prefs_sync.dart';
import 'profile_store.dart';
import '../identity/identity.dart';

// [AVA-PWLESS-1 2026-09-06] `AuthSession.lastPassword` is GONE. It was a
// transient holder for the password typed at sign-in, already vestigial (the
// restore flow stopped needing it at the Cloudflare-native pivot — the Clerk
// session IS the account credential). Now nothing types a password at all:
// sign-in is an emailed 6-digit code or Google, and `password` is disabled on
// the Clerk instance. Holding a user's password in a static field for the life
// of the process was never something to keep for sentiment.

/// What the server knows about the signed-in Clerk account (GET /api/me).
/// Post-pivot the account IS the Clerk uid — there are no key backups.
class MeResult {
  final bool found;
  final bool clerkEnabled;
  final String? uid;
  final String? handle;
  final String? displayName;
  final String? avatarUrl;

  /// [WEB-APP-ONBOARD-1 2026-09-06] The account exists because someone signed
  /// up and paid on avatok.ai, and has never been through the app's onboarding.
  /// Decided by the server (`created_via='web' AND app_onboarded_at IS NULL`),
  /// not inferred here.
  final bool needsAppOnboarding;

  const MeResult({
    required this.found,
    required this.clerkEnabled,
    this.uid,
    this.handle,
    this.displayName,
    this.avatarUrl,
    this.needsAppOnboarding = false,
  });
}

/// Where login routes a user with NO local state (fresh install / new phone):
/// - restored:    account found → device set up automatically → dashboard.
/// - newUser:     server has no account for them → onboarding.
/// - unavailable: couldn't reach the server → retry screen. Never onboarding,
///                so an existing user can't accidentally fork their account.
/// (needsRecovery is retired: signing in IS the recovery. Kept in the enum so
/// old switch statements compile; it is never produced.)
/// - appOnboarding: the account exists but was born on the website. The device
///                  is set up exactly as for `restored` — identity, encryption
///                  key, profile, prefs — but onboarding is NOT marked done, so
///                  the user is routed through terms + permissions first. This
///                  is a real account, never a fork: `_install()` has already
///                  run by the time this is returned.
enum RestoreOutcome { restored, newUser, needsRecovery, unavailable, appOnboarding }

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
        // Absent on an older worker → false → nobody is gated. The gate must
        // never be something a missing field can switch ON.
        needsAppOnboarding: j['needs_app_onboarding'] == true,
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
    // [WEB-APP-ONBOARD-1] A web-born account: set the device up fully, but stop
    // short of declaring onboarding done. `markOnboarded()` is what finishes the
    // job, and only the onboarding flow calls it.
    await _install(handle: me.handle, displayName: me.displayName,
        markOnboardingDone: !me.needsAppOnboarding);
    return RestoreState(
      me.needsAppOnboarding ? RestoreOutcome.appOnboarding : RestoreOutcome.restored,
      handle: me.handle,
      displayName: me.displayName,
    );
  }

  /// Tell the server this account has now completed the app's onboarding, which
  /// is what lifts `needs_app_onboarding` for good.
  ///
  /// Best-effort by design. The local `OnboardingStore` flag is already set by
  /// the time this runs, so a failure here does not trap the user on this
  /// device — the worst case is that a reinstall shows terms and permissions
  /// once more, which is a great deal better than a network blip locking
  /// someone out of an app they have paid for.
  static Future<void> markOnboarded() async {
    try {
      await ApiAuth.postJson(kAppOnboardedUrl, const <String, dynamic>{});
    } catch (_) {/* the gate re-asks on reinstall; never block the user */}
  }

  /// Set the device up for this account: mint the internal signing key if none,
  /// refill the local profile, pull prefs (enabled apps, filters, settings…)
  /// from the server vault, and mark onboarding done → straight to dashboard.
  static Future<void> _install({String? handle, String? displayName,
      bool markOnboardingDone = true}) async {
    final store = IdentityStore();
    if (await store.load() == null) await store.createAndStore();
    // [RESTORE-FIX 2026-07-08] Restore the Account Encryption Key from server
    // escrow BEFORE pulling the vault, so contacts / prefs / private media all
    // decrypt on this device instead of coming back blank. Best-effort: offline
    // falls back to the lazy restore inside each vault op.
    try { await AccountKey.I.ensureHex(); } catch (_) {/* lazy restore still covers it */}
    final ps = ProfileStore();
    final cur = await ps.load();
    await ps.save(cur.copyWith(
      displayName: displayName ?? cur.displayName,
      handle: handle ?? cur.handle,
    ));
    await PrefsSync.pull();
    if (markOnboardingDone) await OnboardingStore().setDone();
  }
}

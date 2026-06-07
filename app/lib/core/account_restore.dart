import 'dart:convert';

import 'admin_tools.dart';
import 'api_auth.dart';
import 'config.dart';
import 'key_backup.dart';
import 'onboarding_store.dart';
import 'prefs_sync.dart';
import 'profile_store.dart';
import '../identity/identity.dart';
import '../identity/nostr_keys.dart';

/// Transient holder for the password the user just typed at sign-in / sign-up.
/// Used only in-memory to encrypt (on sign-up) or decrypt (on a new device) the
/// Nostr key backup, then it can be discarded. Never persisted.
class AuthSession {
  static String? lastPassword;
}

/// What the server knows about the signed-in Clerk account (GET /api/me).
class MeResult {
  final bool found;
  final bool clerkEnabled;
  final String? npub;
  final String? handle;
  final String? displayName;
  final String? encBackup;
  final String? backupMethod;
  final String? accountKind;
  const MeResult({
    required this.found,
    required this.clerkEnabled,
    this.npub,
    this.handle,
    this.displayName,
    this.encBackup,
    this.backupMethod,
    this.accountKind,
  });
}

/// Where login should route a user with NO local key (fresh install / new phone):
/// - restored:     identity re-installed automatically → go straight to dashboard.
/// - newUser:      server has no account for them → show onboarding.
/// - needsRecovery: an account EXISTS but couldn't auto-restore (no/!match
///                  password) → show the recovery screen. NEVER onboarding, so the
///                  user can't accidentally create a second handle and "lose" data.
/// - unavailable:  couldn't reach the server → show retry. Never onboarding.
enum RestoreOutcome { restored, newUser, needsRecovery, unavailable }

class RestoreState {
  final RestoreOutcome outcome;
  final String? handle;
  final String? displayName;
  final String? npub;
  final String? encBackup;
  final String? accountKind;
  const RestoreState(this.outcome,
      {this.handle, this.displayName, this.npub, this.encBackup, this.accountKind});
}

/// Restores a returning user's account from the server after they log in on a
/// new device / fresh install: fetches their linked identity + encrypted key
/// backup, decrypts it with their password, and re-installs the SAME Nostr key
/// so their handle and messages all come back — no re-onboarding.
class AccountRestore {
  /// GET /api/me using the Clerk session JWT (no Nostr key needed yet).
  static Future<MeResult?> fetchMe() async {
    try {
      final r = await ApiAuth.getSigned(kMeUrl);
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      return MeResult(
        found: j['found'] == true,
        clerkEnabled: j['clerk_enabled'] != false,
        npub: j['npub']?.toString(),
        handle: (j['handle'] ?? '').toString().isEmpty ? null : j['handle'].toString(),
        displayName: (j['display_name'] ?? '').toString().isEmpty ? null : j['display_name'].toString(),
        encBackup: (j['encrypted_nsec_backup'] ?? '').toString().isEmpty ? null : j['encrypted_nsec_backup'].toString(),
        backupMethod: j['backup_method']?.toString(),
        accountKind: (j['account_kind'] ?? '').toString().isEmpty ? null : j['account_kind'].toString(),
      );
    } catch (_) {
      return null; // offline / endpoint missing → caller falls back to onboarding
    }
  }

  /// Decide where login should route a user who has NO local key yet (fresh
  /// install / new device). Crucially, if the server already has an account for
  /// this Clerk user we return `restored` or `needsRecovery` — NEVER `newUser` —
  /// so an existing user can never be dropped into the claim-a-handle flow and
  /// accidentally fork their account.
  static Future<RestoreState> restoreFromServer() async {
    final me = await fetchMe();
    if (me == null) return const RestoreState(RestoreOutcome.unavailable);
    if (!me.found) {
      // Only treat as a brand-new user when Clerk verification positively told us
      // there's no linked account. If Clerk is off/unknown, don't risk onboarding.
      return me.clerkEnabled
          ? const RestoreState(RestoreOutcome.newUser)
          : const RestoreState(RestoreOutcome.unavailable);
    }
    // The account exists. Try a silent auto-restore with the password just typed.
    final pw = AuthSession.lastPassword;
    if (me.encBackup != null && pw != null && pw.isNotEmpty) {
      final priv = await KeyBackup.decryptSecret(me.encBackup!, pw);
      if (priv != null && priv.isNotEmpty) {
        await _install(priv, handle: me.handle, displayName: me.displayName, accountKind: me.accountKind);
        return RestoreState(RestoreOutcome.restored, handle: me.handle, displayName: me.displayName);
      }
    }
    // Account exists but we couldn't auto-restore → recovery screen, not onboarding.
    return RestoreState(RestoreOutcome.needsRecovery,
        handle: me.handle, displayName: me.displayName, npub: me.npub,
        encBackup: me.encBackup, accountKind: me.accountKind);
  }

  /// Recovery path 1: decrypt the server backup with a (re-entered) password.
  static Future<bool> recoverWithPassword(RestoreState st, String password) async {
    if (st.encBackup == null || password.isEmpty) return false;
    final priv = await KeyBackup.decryptSecret(st.encBackup!, password);
    if (priv == null || priv.isEmpty) return false;
    await _install(priv, handle: st.handle, displayName: st.displayName, accountKind: st.accountKind);
    return true;
  }

  /// Recovery path 2: paste the saved recovery key (nsec or 64-char hex). We only
  /// accept it if it derives the SAME npub the account is linked to.
  static Future<bool> recoverWithKey(RestoreState st, String input) async {
    final hex = _toPrivHex(input.trim());
    if (hex == null) return false;
    final id = Identity.fromPrivateKey(hex);
    if (st.npub != null && st.npub!.isNotEmpty && id.npub != st.npub) return false;
    await _install(hex, handle: st.handle, displayName: st.displayName, accountKind: st.accountKind);
    return true;
  }

  static String? _toPrivHex(String s) {
    if (s.startsWith('nsec')) return NostrKeys.decodeToHex(s, 'nsec');
    final hex = s.toLowerCase();
    if (RegExp(r'^[0-9a-f]{64}$').hasMatch(hex)) return hex;
    return null;
  }

  /// Install a restored private key + refill local profile/account-kind and mark
  /// onboarding done so the returning user lands straight on the dashboard.
  static Future<void> _install(String privHex,
      {String? handle, String? displayName, String? accountKind}) async {
    await IdentityStore().importPrivateKey(privHex); // same npub; sets ApiAuth.identity
    final ps = ProfileStore();
    final cur = await ps.load();
    await ps.save(cur.copyWith(
      displayName: displayName ?? cur.displayName,
      handle: handle ?? cur.handle,
    ));
    if (accountKind != null) {
      await AccountKindStore().set(AccountKindX.fromWire(accountKind));
    }
    // Pull the rest of the user's prefs (enabled apps, filters, stars, flags…)
    // so the device is fully set up before we show the dashboard.
    await PrefsSync.pull();
    await OnboardingStore().setDone();
  }
}

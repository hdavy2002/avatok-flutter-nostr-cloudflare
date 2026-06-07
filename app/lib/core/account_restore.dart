import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';
import 'key_backup.dart';
import 'onboarding_store.dart';
import 'profile_store.dart';
import '../identity/identity.dart';

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
  const MeResult({
    required this.found,
    required this.clerkEnabled,
    this.npub,
    this.handle,
    this.displayName,
    this.encBackup,
    this.backupMethod,
  });
}

/// Restores a returning user's account from the server after they log in on a
/// new device / fresh install: fetches their linked identity + encrypted key
/// backup, decrypts it with their password, and re-installs the SAME Nostr key
/// so their handle, contacts and messages all come back — no re-onboarding.
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
      );
    } catch (_) {
      return null; // offline / endpoint missing → caller falls back to onboarding
    }
  }

  /// Try to restore this account on the current device. Returns true when the
  /// identity was restored (caller should skip onboarding). Safe to call on
  /// every login — it no-ops when an identity already exists locally.
  static Future<bool> tryRestore() async {
    final idStore = IdentityStore();
    // Already have this account's key on this device → nothing to restore.
    if (await idStore.load() != null) return false;

    final me = await fetchMe();
    if (me == null || !me.found) return false;

    final pw = AuthSession.lastPassword;
    if (me.encBackup == null || pw == null || pw.isEmpty) return false;

    final priv = await KeyBackup.decryptSecret(me.encBackup!, pw);
    if (priv == null || priv.isEmpty) return false; // wrong password / corrupt

    await idStore.importPrivateKey(priv); // same npub as before; sets ApiAuth.identity

    // Refill the local profile so the sidebar + screens show the right person.
    final ps = ProfileStore();
    final cur = await ps.load();
    await ps.save(cur.copyWith(
      displayName: me.displayName ?? cur.displayName,
      handle: me.handle ?? cur.handle,
    ));

    // A returning user with a claimed handle skips onboarding entirely.
    if ((me.handle ?? '').isNotEmpty) {
      await OnboardingStore().setDone();
    }
    return true;
  }
}

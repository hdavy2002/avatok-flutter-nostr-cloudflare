import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../identity/identity.dart';
import 'analytics.dart';
import 'ava_log.dart';

/// Namespaces a secure-storage key to the active Clerk account so multiple
/// users on one device keep separate onboarding / profile / account-kind state.
///
/// Mirrors [IdentityStore]: each account gets its own value, and the FIRST
/// account to log in after this change migrates the pre-namespacing ("legacy")
/// value so the existing user keeps their data instead of being re-onboarded.
///
/// The bug this fixes: onboarding-done, profile and account-kind used to be
/// stored under a single global key, so a second account signing in on the same
/// phone skipped onboarding (no handle prompt) and saw the first user's profile.
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ STANDARD (all AvaVerse apps): ALL per-user local state MUST be account-     │
// │ scoped. One phone is routinely shared by multiple accounts (a parent and    │
// │ each child), so any store keyed by a single global key leaks data between   │
// │ accounts. Rule: every FlutterSecureStorage/SharedPreferences/file-cache key │
// │ goes through scopedKey(...) (or a per-account subdir using AccountScope.id). │
// │ Never read/write a raw constant key for user data. The ONLY exceptions are  │
// │ device-level, account-agnostic values (e.g. the Clerk client token).        │
// └──────────────────────────────────────────────────────────────────────────┘
/// The namespace used when no Clerk account is active (L0 guest, or any read
/// that races ahead of `AccountScope.id` being set right after auth).
///
/// [PROFILE-LEAK 2026-07-09] This used to fall back to the RAW `base` key. Two
/// ways that leaked one account's data into another's:
///   1. `_enterAsGuest()` sets `AccountScope.id = null`, so every guest-scope
///      write landed on the un-namespaced key.
///   2. Any read/write that ran before `AccountScope.id` was assigned (the
///      window between Clerk sign-in and `_afterAuth`) hit the same raw key.
/// The next account to sign in then found its own scoped key empty and inherited
/// the raw value via the legacy migration below — name, bio and AVATAR included.
/// A guest now gets its own explicit namespace, so nothing ever writes `base`.
const String kGuestScope = 'guest';

String scopedKey(String base) =>
    (AccountScope.id == null || AccountScope.id!.isEmpty)
        ? '${base}_$kGuestScope'
        : '${base}_${AccountScope.id}';

/// Device-level marker: set the first time ANY scope claims the pre-namespacing
/// value of [base]. Intentionally un-namespaced — it describes the device, not
/// an account (same class of exception as the Clerk client token).
String _legacyClaimKey(String base) => 'legacy_claimed_v1_$base';

/// Reads a per-account key, migrating a legacy (un-namespaced) value the first
/// time a real account reads it. Returns null when nothing is stored yet.
/// On BadPaddingException (corrupt cipher), logs telemetry, deletes the key only,
/// and returns null so callers regenerate (does NOT deleteAll — other accounts on
/// a shared phone must not be wiped).
Future<String?> readScoped(FlutterSecureStorage s, String base) async {
  final key = scopedKey(base);
  String? v;
  try {
    v = await s.read(key: key);
  } on PlatformException catch (e) {
    if (e.message?.contains('BadPaddingException') ?? false) {
      AvaLog.I.log('storage', 'Secure storage BadPaddingException on key: $base (scoped: $key)');
      Analytics.capture('secure_storage_corrupt', {'key_hint': base});
      // Delete only the affected key, not deleteAll (which would wipe other accounts)
      try {
        await s.delete(key: key);
      } catch (delErr) {
        AvaLog.I.log('storage', 'Failed to delete corrupt key $key: $delErr');
      }
      return null; // Caller will regenerate on null
    }
    rethrow; // Re-throw other PlatformExceptions
  }

  // Try legacy migration only if current key read succeeded and is empty/null.
  //
  // [PROFILE-LEAK 2026-07-09] The pre-namespacing value belongs to exactly ONE
  // account — whoever was using the device before scoping existed. It must be
  // claimed AT MOST ONCE. Without this guard every subsequent account that found
  // its own scoped key empty re-read `base` and adopted the previous user's
  // profile (the "my new account has the last account's photo" bug). We set the
  // claim marker on the first attempt whether or not a legacy value was present,
  // so a later account can never inherit one that shows up afterwards.
  if ((v == null || v.isEmpty) && key != base) {
    final claimKey = _legacyClaimKey(base);
    String? claimed;
    try { claimed = await s.read(key: claimKey); } catch (_) {/* treat as unclaimed */}
    if (claimed == '1') return v; // already claimed by another scope — clean slate
    try {
      final legacy = await s.read(key: base);
      try { await s.write(key: claimKey, value: '1'); } catch (_) {/* best-effort */}
      if (legacy != null && legacy.isNotEmpty) {
        await s.write(key: key, value: legacy);
        await s.delete(key: base);
        v = legacy;
        Analytics.capture('legacy_key_claimed', {
          'key_hint': base,
          'scope': (AccountScope.id == null || AccountScope.id!.isEmpty) ? kGuestScope : 'account',
        });
      }
    } on PlatformException catch (e) {
      // Corruption in the legacy key during migration attempt
      if (e.message?.contains('BadPaddingException') ?? false) {
        AvaLog.I.log('storage', 'BadPaddingException on legacy key: $base');
        Analytics.capture('secure_storage_corrupt', {'key_hint': '$base (legacy)'});
        try {
          await s.delete(key: base);
        } catch (delErr) {
          AvaLog.I.log('storage', 'Failed to delete corrupt legacy key $base: $delErr');
        }
        return null;
      }
      rethrow;
    }
  }
  return v;
}

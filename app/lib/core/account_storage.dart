import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../identity/identity.dart';

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
String scopedKey(String base) =>
    (AccountScope.id == null || AccountScope.id!.isEmpty)
        ? base
        : '${base}_${AccountScope.id}';

/// Reads a per-account key, migrating a legacy (un-namespaced) value the first
/// time a real account reads it. Returns null when nothing is stored yet.
Future<String?> readScoped(FlutterSecureStorage s, String base) async {
  final key = scopedKey(base);
  var v = await s.read(key: key);
  if ((v == null || v.isEmpty) && key != base) {
    final legacy = await s.read(key: base);
    if (legacy != null && legacy.isNotEmpty) {
      await s.write(key: key, value: legacy);
      await s.delete(key: base);
      v = legacy;
    }
  }
  return v;
}

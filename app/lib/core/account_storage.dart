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

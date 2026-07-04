import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../../core/account_storage.dart';

/// Verify-pending resilience for Liveness V2 (Agent E P4, plan §4 step 7).
///
/// The async verify can outlive the screen: a user may background the app while
/// the server is still checking their clip. We persist the pending session id so
/// that on the next open of an entry point we can poll `livenessResult` for it
/// and show the outcome instead of making the user redo the whole video.
///
/// PER-ACCOUNT SCOPED (mandatory — one phone is shared by parent + child
/// accounts). The key goes through [scopedKey] so account A's pending session
/// never leaks into account B's session on the same device.
class LivenessPendingSession {
  static const _base = 'liveness_pending_sid';
  static const _sec = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
    mOptions: MacOsOptions(useDataProtectionKeyChain: false),
  );

  /// Remember that [sessionId] was submitted and is awaiting a verify result.
  static Future<void> set(String sessionId) async {
    if (sessionId.isEmpty) return;
    try {
      await _sec.write(key: scopedKey(_base), value: sessionId);
    } catch (_) {/* best-effort — resilience only */}
  }

  /// The pending session id for the active account, or null if none.
  static Future<String?> get() async {
    try {
      final v = await readScoped(_sec, _base);
      return (v == null || v.isEmpty) ? null : v;
    } catch (_) {
      return null;
    }
  }

  /// Clear on any terminal outcome (pass, fail, or session gone).
  static Future<void> clear() async {
    try {
      await _sec.delete(key: scopedKey(_base));
    } catch (_) {/* best-effort */}
  }
}

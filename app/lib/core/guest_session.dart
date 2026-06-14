import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import 'api_auth.dart';
import 'config.dart';

/// L0 visitor tier (Trust Ladder). Reserves a unique @handle on the server
/// BEFORE any Clerk account exists, holding it with a signed guest token.
/// After Clerk signup, [upgradeIfAny] merges the reservation into the real
/// account and clears the local guest state.
///
/// NOTE: these keys are intentionally DEVICE-level (not scopedKey): a guest
/// reservation exists before any account, so there is no AccountScope yet.
/// They are wiped on upgrade, so they never leak across signed-in accounts.
class GuestSession {
  static const _storage = FlutterSecureStorage(mOptions: MacOsOptions(useDataProtectionKeyChain: false), );
  static const _kToken = 'guest_token_v1';
  static const _kHandle = 'guest_handle_v1';

  static Future<String?> reservedHandle() => _storage.read(key: _kHandle);
  static Future<String?> token() => _storage.read(key: _kToken);

  /// GET /api/identity/guest/check — availability while the visitor types.
  static Future<({bool ok, String? message})> checkHandle(String handle) async {
    try {
      final r = await http
          .get(Uri.parse('$kGuestCheckUrl?handle=${Uri.encodeComponent(handle.trim())}'))
          .timeout(const Duration(seconds: 8));
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      return (ok: j['ok'] == true, message: j['message']?.toString());
    } catch (_) {
      return (ok: false, message: 'Could not check — are you online?');
    }
  }

  /// POST /api/identity/guest — reserve the handle, store the guest token.
  static Future<({bool ok, String? message})> reserve(String handle) async {
    try {
      final r = await http
          .post(Uri.parse(kGuestCreateUrl),
              headers: {'content-type': 'application/json'},
              body: jsonEncode({'handle': handle.trim().toLowerCase()}))
          .timeout(const Duration(seconds: 10));
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      if (r.statusCode != 200) {
        return (ok: false, message: (j['message'] ?? j['error'] ?? 'Could not reserve handle').toString());
      }
      await _storage.write(key: _kToken, value: (j['guest_token'] ?? '').toString());
      await _storage.write(key: _kHandle, value: (j['handle'] ?? handle).toString());
      return (ok: true, message: null);
    } catch (_) {
      return (ok: false, message: 'Network error — try again');
    }
  }

  /// POST /api/identity/upgrade (Clerk-authed) — merge the guest reservation
  /// into the signed-in account. Best-effort + idempotent; clears local state
  /// on success or when the server says the guest is gone.
  static Future<bool> upgradeIfAny() async {
    final t = await token();
    if (t == null || t.isEmpty) return false;
    try {
      final r = await ApiAuth.postJson(kGuestUpgradeUrl, {'guest_token': t});
      if (r.statusCode == 200 || r.statusCode == 404) {
        await _storage.delete(key: _kToken);
        await _storage.delete(key: _kHandle);
        return r.statusCode == 200;
      }
    } catch (_) {/* retried on next sign-in */}
    return false;
  }
}

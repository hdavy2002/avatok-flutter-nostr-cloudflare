import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'api_auth.dart';
import 'config.dart';

/// Referral token bridge for cold-start/install flows. This one value is
/// intentionally device-level and pre-auth: there is no AccountScope before
/// signup. It is opaque, short-lived, and deleted after the first bind attempt.
class AffiliateBindService {
  static const _key = 'avatok_affiliate_pending_token_v1';
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
    mOptions: MacOsOptions(useDataProtectionKeyChain: false),
  );

  static Future<void> savePendingToken(String token) async {
    if (token.isEmpty) return;
    await _storage.write(key: _key, value: token);
  }

  static Future<bool> bindPending() async {
    final token = await _storage.read(key: _key);
    if (token == null || token.isEmpty) return false;
    try {
      final r = await ApiAuth.postJson('$kApiBase/affiliate/bind', {
        'token': token,
        'source': 'deep_link',
      });
      if (r.statusCode == 200) {
        final body = r.body;
        if (body.contains('"bound":true') || body.contains('"already":true') ||
            body.contains('"reason":"invalid_token"') || body.contains('"reason":"link_inactive"')) {
          await _storage.delete(key: _key);
          return true;
        }
      }
    } catch (_) {/* retry on the next authenticated cold start */}
    return false;
  }
}

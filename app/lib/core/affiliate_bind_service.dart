import 'dart:io';

import 'package:android_play_install_referrer/android_play_install_referrer.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'api_auth.dart';
import 'config.dart';

/// Referral token bridge for cold-start/install flows. This one value is
/// intentionally device-level and pre-auth: there is no AccountScope before
/// signup. It is opaque, short-lived, and deleted after the first bind attempt.
class AffiliateBindService {
  static const _key = 'avatok_affiliate_pending_token_v1';
  static const _sourceKey = 'avatok_affiliate_pending_source_v1';
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
    mOptions: MacOsOptions(useDataProtectionKeyChain: false),
  );

  static Future<void> savePendingToken(String token, {String source = 'deep_link'}) async {
    if (token.isEmpty) return;
    await _storage.write(key: _key, value: token);
    await _storage.write(key: _sourceKey, value: source);
  }

  /// Capture the Play referrer before authentication. Google retains it across
  /// the install, so this also works when the user signs up days after install.
  static Future<void> capturePlayInstallReferrer() async {
    if (!Platform.isAndroid) return;
    try {
      final details = await AndroidPlayInstallReferrer.installReferrer;
      final raw = details.installReferrer ?? '';
      if (raw.isEmpty) return;
      final params = Uri.splitQueryString(raw);
      final token = (params['aff'] ?? '').trim();
      if (token.isNotEmpty) {
        await savePendingToken(token, source: 'play_install_referrer');
      }
    } catch (_) {/* Play services unavailable; deep links still work. */}
  }

  static Future<bool> bindPending() async {
    await capturePlayInstallReferrer();
    final token = await _storage.read(key: _key);
    if (token == null || token.isEmpty) return false;
    final source = await _storage.read(key: _sourceKey) ?? 'deep_link';
    try {
      final r = await ApiAuth.postJson('$kApiBase/affiliate/bind', {
        'token': token,
        'source': source,
      });
      if (r.statusCode == 200) {
        final body = r.body;
        if (body.contains('"bound":true') || body.contains('"already":true') ||
          body.contains('"reason":"invalid_token"') || body.contains('"reason":"link_inactive"')) {
          await _storage.delete(key: _key);
          await _storage.delete(key: _sourceKey);
          return true;
        }
      }
    } catch (_) {/* retry on the next authenticated cold start */}
    return false;
  }
}

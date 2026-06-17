import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'account_storage.dart';

/// Stores the user's **bring-your-own** Gemini (Google AI Studio) API key and
/// the Google account it belongs to. Having a key == AI mode is ON; clearing it
/// == back to plain messaging.
///
/// The key is sensitive, so it lives in [FlutterSecureStorage] (never DiskCache),
/// and — like every other per-user store — it is account-scoped via [scopedKey]
/// so a parent and each child sharing one phone keep separate keys.
class AvaAiStore {
  static const _kKey = 'ava_ai_gemini_key';
  static const _kEmail = 'ava_ai_google_email';
  static const _s = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
    mOptions: MacOsOptions(useDataProtectionKeyChain: false),
  );

  /// AI Studio keys look like `AIza...` (~39 chars). Loose check — we only
  /// reject obviously-wrong paste, the worker does the real validation on use.
  static bool looksValid(String raw) {
    final k = raw.trim();
    return k.startsWith('AIza') && k.length >= 30 && !k.contains(' ');
  }

  Future<String?> apiKey() => readScoped(_s, _kKey);
  Future<String?> googleEmail() => readScoped(_s, _kEmail);
  Future<bool> isConnected() async => (await apiKey())?.isNotEmpty ?? false;

  Future<void> save({required String apiKey, String? googleEmail}) async {
    await _s.write(key: scopedKey(_kKey), value: apiKey.trim());
    final email = googleEmail?.trim() ?? '';
    if (email.isNotEmpty) {
      await _s.write(key: scopedKey(_kEmail), value: email);
    }
  }

  /// Disconnect: wipes the key AND the linked Google account so the user can
  /// connect a different account.
  Future<void> clear() async {
    await _s.delete(key: scopedKey(_kKey));
    await _s.delete(key: scopedKey(_kEmail));
  }
}

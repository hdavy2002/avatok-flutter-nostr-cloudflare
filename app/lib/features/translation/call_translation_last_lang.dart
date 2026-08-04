import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/account_storage.dart' show readScoped, scopedKey;
import '../../identity/identity.dart' show AccountScope;
import 'translation_langs.dart';

/// [CALL-TRANSLATE-2C-2] The last target language this ACCOUNT translated a call
/// into. Phase C's speculative warm-up needs a guess to pre-mint against while
/// the language sheet is open; this is that guess.
///
/// PER-ACCOUNT SCOPING IS MANDATORY (rulebook rule 1). One phone is routinely
/// shared by a parent and each child account. A raw global key here would mean
/// the child's sheet warms up on the parent's language — a small leak, but a
/// leak of the same class the scoping rule exists to stop, and it would also
/// pre-mint (and speculatively mutate the session row) for the wrong language.
/// Values therefore go through [scopedKey] / [readScoped], and the in-memory
/// memo is invalidated whenever [AccountScope.id] changes.
///
/// Never throws: a warm-up hint is a nice-to-have, and storage failing must
/// never be able to block or break a translation session.
class CallTranslationLastLang {
  CallTranslationLastLang._();

  static const _ss = FlutterSecureStorage(
    mOptions: MacOsOptions(useDataProtectionKeyChain: false),
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  static const _base = 'avatok_call_translation_last_lang_v1';

  static String? _cached;
  static String? _cachedScope;

  /// The current account's last-used call-translation language, or null if this
  /// account has never run one (or the stored code is no longer supported).
  static Future<String?> read() async {
    final scope = AccountScope.id ?? '';
    if (_cachedScope == scope) return _cached;
    try {
      final v = await readScoped(_ss, _base);
      _cached = (v != null && _supported(v)) ? v : null;
      _cachedScope = scope;
      return _cached;
    } catch (_) {
      return null;
    }
  }

  /// Records [code] as this account's last-used language. Best effort.
  static Future<void> write(String code) async {
    if (!_supported(code)) return;
    final scope = AccountScope.id ?? '';
    _cached = code;
    _cachedScope = scope;
    try {
      await _ss.write(key: scopedKey(_base), value: code);
    } catch (_) {}
  }

  /// Drop the memo so the next [read] re-reads under the new account. Call on
  /// account switch / sign-out.
  static void invalidate() {
    _cached = null;
    _cachedScope = null;
  }

  static bool _supported(String code) =>
      kTranslationLangs.any((item) => item.code == code);
}

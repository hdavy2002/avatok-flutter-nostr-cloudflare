import 'dart:math';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/account_storage.dart' show readScoped, scopedKey;
import '../../identity/identity.dart' show AccountScope;

/// [CALL-TRANSLATE-2B-3] Stable per-install, PER-ACCOUNT nonce sent on
/// call-translation start/activate/renew/token (and, in Phase C, /language).
///
/// The Worker binds token issuance to `call_id + session_id + device_nonce` and
/// rejects a mint whose nonce does not match the one recorded at session
/// create. That turns a leaked ephemeral token into a dead token on any other
/// device.
///
/// PER-ACCOUNT SCOPING IS MANDATORY (rulebook rule 1): one phone is routinely
/// shared by a parent and each child account. A single global nonce key would
/// mean every account on the device shares one binding identity, so a session
/// created under one account could have its token refreshed under another —
/// exactly the cross-account leak the scoping rule exists to prevent. The value
/// therefore goes through [scopedKey] / [readScoped], and the in-memory cache is
/// invalidated whenever [AccountScope.id] changes.
///
/// Wire format must satisfy the Worker's `^[A-Za-z0-9_.:-]{8,128}$` — a
/// malformed nonce is a 400 `invalid_device_nonce` (billable:false). We emit
/// 32 lowercase hex characters, which is inside that set by construction.
class CallTranslationDeviceNonce {
  CallTranslationDeviceNonce._();

  static const _ss = FlutterSecureStorage(
    mOptions: MacOsOptions(useDataProtectionKeyChain: false),
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  static const _base = 'avatok_call_translation_nonce_v1';

  static String? _cached;
  static String? _cachedScope;

  /// The current account's nonce, minting and persisting one on first use.
  /// Returns null only if secure storage is unusable — callers then omit the
  /// field entirely (the Worker treats an absent nonce as "not device bound"
  /// and still serves the session, so translation must not be blocked by it).
  static Future<String?> ensure() async {
    final scope = AccountScope.id ?? '';
    if (_cached != null && _cachedScope == scope) return _cached;
    try {
      final existing = await readScoped(_ss, _base);
      if (existing != null && _valid(existing)) {
        _cached = existing;
        _cachedScope = scope;
        return existing;
      }
      final minted = _mint();
      await _ss.write(key: scopedKey(_base), value: minted);
      _cached = minted;
      _cachedScope = scope;
      return minted;
    } catch (_) {
      return null;
    }
  }

  /// Drop the memo so the next [ensure] re-reads under the new account. Call on
  /// account switch / sign-out.
  static void invalidate() {
    _cached = null;
    _cachedScope = null;
  }

  static final _rng = Random.secure();

  static String _mint() {
    const hex = '0123456789abcdef';
    return String.fromCharCodes(
      List<int>.generate(32, (_) => hex.codeUnitAt(_rng.nextInt(16))),
    );
  }

  static bool _valid(String v) =>
      v.length >= 8 && v.length <= 128 && RegExp(r'^[A-Za-z0-9_.:-]+$').hasMatch(v);
}

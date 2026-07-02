import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../identity/identity.dart' show AccountScope;
import 'account_storage.dart' show scopedKey;
import 'analytics.dart';
import 'api_auth.dart';
import 'config.dart';

/// The Account Encryption Key (aek): the recoverable key the cross-device vault
/// (contacts + prefs) is encrypted with. It is ESCROWED server-side
/// (/api/keybackup) under the account's Clerk uid, so a reinstall / new phone
/// pulls it back and every uid-keyed vault blob decrypts again — no data loss,
/// no passphrase (Specs/ARCH-REMOVE-NOSTR-ABLY-AND-DATA-DURABILITY.md, Part C).
///
/// Representations:
///  • 32 raw bytes — the source of truth.
///  • escrow wire form: base64(bytes) — what /api/keybackup stores.
///  • VAULT KEY MATERIAL: hex(bytes), a 64-char hex string. For EXISTING users the
///    aek is SEEDED from their current Nostr privHex, so hex(aek) == privHex and
///    their existing vault stays decryptable with ZERO re-encryption. New users
///    get a random key. Either way the key is escrowed, so it survives reinstall.
class AccountKey {
  static final AccountKey I = AccountKey._();
  AccountKey._();

  static const _ss = FlutterSecureStorage(
    mOptions: MacOsOptions(useDataProtectionKeyChain: false),
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  static const _base = 'avatok_aek_v1';

  String? _cachedHex;
  String? _cachedScope;

  String get _key => scopedKey(_base);

  /// Vault key material (64-char hex) for the current account, or null when
  /// offline AND nothing is cached (caller then skips the vault op, as before).
  /// Order: local → server escrow (restore) → seed from legacy key / mint + escrow.
  Future<String?> ensureHex() async {
    final scope = AccountScope.id ?? '';
    if (_cachedHex != null && _cachedScope == scope) return _cachedHex;

    // 1) already on this device
    final local = await _read();
    if (local != null && local.isNotEmpty) { _cache(local, scope); return local; }

    // 2) restore from escrow (returning user on a fresh install / new phone).
    //    Takes precedence over seeding, so a reinstall pulls the ORIGINAL key back
    //    even though the local Nostr key was regenerated.
    final restored = await _fetchEscrow();
    if (restored != null) {
      await _write(restored);
      _cache(restored, scope);
      Analytics.capture('key_restore_ok', const {'src': 'escrow'});
      return restored;
    }

    // 3) first time on this account anywhere: seed from the current Nostr privHex
    //    (so the vault already written under it keeps decrypting — no re-encrypt),
    //    else mint a random key. Then escrow it so future reinstalls are safe.
    final legacy = (ApiAuth.identity?.privHex ?? '').toLowerCase();
    final hexKey = _isHex64(legacy) ? legacy : _randomHex();
    await _write(hexKey);
    _cache(hexKey, scope);
    unawaited(_escrow(hexKey)); // best-effort; retried on the next launch if it fails
    return hexKey;
  }

  void _cache(String hex, String scope) { _cachedHex = hex; _cachedScope = scope; }

  Future<String?> _read() async {
    try { return await _ss.read(key: _key); } catch (_) { return null; }
  }
  Future<void> _write(String hex) async {
    try { await _ss.write(key: _key, value: hex); } catch (_) {/* best-effort */}
  }

  /// GET /api/keybackup → the escrowed aek as a hex string, or null.
  Future<String?> _fetchEscrow() async {
    try {
      final r = await ApiAuth.getSigned(kKeyBackupUrl);
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      if (j['found'] != true) return null;
      final aekB64 = (j['aek'] ?? '').toString();
      if (aekB64.isEmpty) return null;
      final bytes = base64.decode(aekB64);
      if (bytes.length != 32) return null;
      return _hex(bytes);
    } catch (_) { return null; }
  }

  /// POST /api/keybackup { aek: base64(bytes) }. Idempotent server-side upsert.
  Future<void> _escrow(String hexKey) async {
    try {
      final bytes = _unhex(hexKey);
      if (bytes.length != 32) return;
      final r = await ApiAuth.postJson(kKeyBackupUrl, {'aek': base64.encode(bytes)});
      Analytics.capture(
          r.statusCode == 200 ? 'key_backup_ok' : 'key_backup_failed', {'status': r.statusCode});
    } catch (e) {
      Analytics.capture('key_backup_failed', {'err': e.toString()});
    }
  }

  static bool _isHex64(String s) => RegExp(r'^[0-9a-f]{64}$').hasMatch(s);

  static String _randomHex() {
    final rnd = Random.secure();
    final b = Uint8List(32);
    for (var i = 0; i < 32; i++) b[i] = rnd.nextInt(256);
    return _hex(b);
  }

  static String _hex(List<int> b) {
    final sb = StringBuffer();
    for (final x in b) sb.write(x.toRadixString(16).padLeft(2, '0'));
    return sb.toString();
  }

  static Uint8List _unhex(String h) {
    final out = Uint8List(h.length ~/ 2);
    for (var i = 0; i < out.length; i++) {
      out[i] = int.parse(h.substring(i * 2, i * 2 + 2), radix: 16);
    }
    return out;
  }
}

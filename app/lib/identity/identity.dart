import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:pointycastle/export.dart' show SHA256Digest;

import '../core/api_auth.dart';

/// A user's device identity. The Clerk user id ([uid]) is the real account id
/// that the messaging/backup layers address by. [privHex] is opaque local key
/// material retained ONLY as a legacy vault-decryption key (see AccountKey's
/// dual-key set); [pubHex] is a derived, non-secret id kept for status
/// attribution and as a uid fallback. (Nostr — npub/nsec/secp keys — removed
/// 2026-07-02.)
class Identity {
  final String privHex;
  final String pubHex;

  Identity._(this.privHex, this.pubHex);

  factory Identity.fromPrivateKey(String privHex) =>
      Identity._(privHex, _derivePub(privHex));

  /// Non-secret, stable id derived from the local key material (SHA-256). Not a
  /// signing key — just an opaque per-device fallback id.
  static String _derivePub(String privHex) {
    final d = SHA256Digest().process(Uint8List.fromList(utf8.encode(privHex)));
    final sb = StringBuffer();
    for (final b in d) sb.write(b.toRadixString(16).padLeft(2, '0'));
    return sb.toString();
  }

  /// Short display form of the account id, e.g. user_2abcd…wxyz.
  String get shortId => uid.length > 16
      ? '${uid.substring(0, 10)}…${uid.substring(uid.length - 6)}'
      : uid;

  /// The account id = the Clerk user id (AccountScope.id). Falls back to the
  /// derived local id only if the account scope isn't set yet.
  String get uid => AccountScope.id ?? pubHex;
}

/// Holds the signed-in Clerk account id so each account gets its OWN local key
/// on a shared device. Set right after auth; cleared on sign-out.
class AccountScope {
  static String? id;
}

/// Persists the local key material in platform secure storage (Keychain /
/// EncryptedSharedPreferences). It NEVER leaves the device in plaintext. The key
/// is namespaced per Clerk account so two accounts on one phone don't share an
/// identity. (Storage-key names retain the historical `ava_nostr_priv` prefix so
/// existing installs keep reading the same stored value — renaming it would
/// orphan that material, which is still the legacy vault key.)
class IdentityStore {
  static const _legacyKey = 'ava_nostr_priv';
  // In-memory cache. flutter_secure_storage reads are slow on some devices
  // (notably Samsung), and load() is called from many screens — re-reading the
  // encrypted key every time added ~1s+ to cold-start. Cache it per account; the
  // scope check invalidates on switch.
  static Identity? _cached;
  static String? _cachedScope;
  final FlutterSecureStorage _storage;

  IdentityStore([FlutterSecureStorage? s])
      : _storage = s ??
            const FlutterSecureStorage(
              mOptions: MacOsOptions(useDataProtectionKeyChain: false),
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  String get _key => (AccountScope.id == null || AccountScope.id!.isEmpty)
      ? _legacyKey
      : 'ava_nostr_priv_${AccountScope.id}';

  Future<Identity?> load() async {
    final scope = AccountScope.id ?? '';
    if (_cached != null && _cachedScope == scope) {
      ApiAuth.identity = _cached; // keep the legacy-key accessor in sync
      return _cached;
    }
    final key = _key;
    var priv = await _storage.read(key: key);
    // One-time migration: the first account to log in after namespacing claims
    // the pre-namespacing key, so the existing user keeps their key material.
    if ((priv == null || priv.isEmpty) && key != _legacyKey) {
      final legacy = await _storage.read(key: _legacyKey);
      if (legacy != null && legacy.isNotEmpty) {
        await _storage.write(key: key, value: legacy);
        await _storage.delete(key: _legacyKey);
        priv = legacy;
      }
    }
    if (priv == null || priv.isEmpty) return null;
    final id = Identity.fromPrivateKey(priv);
    ApiAuth.identity = id; // keep the legacy-key accessor in sync
    _cached = id;
    _cachedScope = scope;
    return id;
  }

  Future<Identity> createAndStore() async {
    final priv = _randomHex();
    await _storage.write(key: _key, value: priv);
    final id = Identity.fromPrivateKey(priv);
    ApiAuth.identity = id;
    _cached = id;
    _cachedScope = AccountScope.id ?? '';
    return id;
  }

  /// Import existing hex key material (paste flow, optional).
  Future<Identity> importPrivateKey(String privHex) async {
    await _storage.write(key: _key, value: privHex);
    final id = Identity.fromPrivateKey(privHex);
    ApiAuth.identity = id;
    _cached = id;
    _cachedScope = AccountScope.id ?? '';
    return id;
  }

  Future<void> clear() {
    ApiAuth.identity = null;
    _cached = null;
    _cachedScope = null;
    return _storage.delete(key: _key);
  }

  static String _randomHex() {
    final rnd = Random.secure();
    final b = Uint8List(32);
    for (var i = 0; i < 32; i++) b[i] = rnd.nextInt(256);
    final sb = StringBuffer();
    for (final x in b) sb.write(x.toRadixString(16).padLeft(2, '0'));
    return sb.toString();
  }
}

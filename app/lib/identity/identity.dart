import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/services.dart' show PlatformException;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:crypto/crypto.dart' as crypto;

import '../core/api_auth.dart';

/// A user's device identity. The Clerk user id ([uid]) is the real account id
/// that the messaging/backup layers address by. [privHex] is opaque local key
/// material retained ONLY as a legacy vault-decryption key (see AccountKey's
/// dual-key set); [pubHex] is a derived, non-secret id kept for status
/// attribution and as a uid fallback. (Nostr — uid/nsec/secp keys — removed
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
    final d = Uint8List.fromList(crypto.sha256.convert(Uint8List.fromList(utf8.encode(privHex))).bytes);
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
/// identity.
class IdentityStore {
  static const _unscopedKey = 'ava_device_key';
  // In-memory cache. flutter_secure_storage reads are slow on some devices
  // (notably Samsung), and load() is called from many screens — re-reading the
  // encrypted key every time added ~1s+ to cold-start. Cache it per account; the
  // scope check invalidates on switch.
  static Identity? _cached;
  static String? _cachedScope;

  /// Set true when a secure-storage read could not be DECRYPTED — i.e. the
  /// Android Keystore key no longer matches the EncryptedSharedPreferences
  /// ciphertext (surfaces as `PlatformException(read, …BadPaddingException:
  /// …BAD_DECRYPT)`). This happens after an app update, an OS/cloud backup
  /// restore, or a device transfer, because the ciphertext is backed up but the
  /// Keystore key is not. A raw read used to THROW straight out of `_boot()`,
  /// dumping the user on the "Can't reach AvaTOK" reconnect screen in a relaunch
  /// loop. We never throw now: we flag here so boot can self-heal (wipe the
  /// un-decryptable store + caches, then re-restore the account from the server).
  static bool storageCorrupt = false;

  final FlutterSecureStorage _storage;

  IdentityStore([FlutterSecureStorage? s])
      : _storage = s ??
            const FlutterSecureStorage(
              mOptions: MacOsOptions(useDataProtectionKeyChain: false),
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  String get _key => (AccountScope.id == null || AccountScope.id!.isEmpty)
      ? _unscopedKey
      : 'ava_device_key_${AccountScope.id}';

  Future<Identity?> load() async {
    final scope = AccountScope.id ?? '';
    if (_cached != null && _cachedScope == scope) {
      ApiAuth.identity = _cached; // keep the key accessor in sync
      return _cached;
    }
    String? priv;
    try {
      priv = await _storage.read(key: _key);
    } on PlatformException catch (e) {
      // BAD_DECRYPT / BadPaddingException: the Keystore key ⇄ ciphertext link is
      // broken (update / OS restore / device transfer). NEVER let this throw into
      // boot. Flag for the boot-time self-heal, drop the corrupt entry, and return
      // null so the caller re-provisions (server key-restore rehydrates us).
      if ((e.message?.contains('BadPaddingException') ?? false) ||
          (e.message?.contains('BAD_DECRYPT') ?? false) ||
          e.code == 'read') {
        storageCorrupt = true;
        try { await _storage.delete(key: _key); } catch (_) {/* best-effort */}
        return null;
      }
      rethrow; // a different platform error — don't mask it
    }
    if (priv == null || priv.isEmpty) return null;
    final id = Identity.fromPrivateKey(priv);
    ApiAuth.identity = id; // keep the legacy-key accessor in sync
    _cached = id;
    _cachedScope = scope;
    return id;
  }

  /// Nuke EVERY secure-storage entry. Used only by the boot-time self-heal when
  /// the store is un-decryptable (BAD_DECRYPT): on a Keystore-key mismatch ALL
  /// values are corrupt, so a per-key delete can't recover us — clear the lot and
  /// let the server re-provision each account. Best-effort; never throws.
  Future<void> wipeAllSecureStorage() async {
    try {
      await _storage.deleteAll();
    } catch (_) {/* best-effort — some entries may already be unreadable */}
    ApiAuth.identity = null;
    _cached = null;
    _cachedScope = null;
    storageCorrupt = false;
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

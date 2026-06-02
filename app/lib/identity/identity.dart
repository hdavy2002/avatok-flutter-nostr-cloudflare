import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'nostr_keys.dart';

/// A user's Nostr identity, derived from their private key.
class Identity {
  final String privHex;
  final String pubHex;
  final String npub;
  final String nsec;

  Identity._(this.privHex, this.pubHex, this.npub, this.nsec);

  factory Identity.fromPrivateKey(String privHex) {
    final pub = NostrKeys.publicKeyFromPrivate(privHex);
    return Identity._(privHex, pub, NostrKeys.npub(pub), NostrKeys.nsec(privHex));
  }

  /// Short display form, e.g. npub1abcd…wxyz
  String get shortNpub =>
      npub.length > 16 ? '${npub.substring(0, 10)}…${npub.substring(npub.length - 6)}' : npub;
}

/// Persists the nsec in platform secure storage (Keychain / EncryptedSharedPreferences).
/// nsec NEVER leaves the device in plaintext (spec §10).
class IdentityStore {
  static const _key = 'ava_nostr_priv';
  final FlutterSecureStorage _storage;

  IdentityStore([FlutterSecureStorage? s])
      : _storage = s ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  Future<Identity?> load() async {
    final priv = await _storage.read(key: _key);
    if (priv == null || priv.isEmpty) return null;
    return Identity.fromPrivateKey(priv);
  }

  Future<Identity> createAndStore() async {
    final priv = NostrKeys.generatePrivateKey();
    await _storage.write(key: _key, value: priv);
    return Identity.fromPrivateKey(priv);
  }

  /// Import an existing nsec/hex private key (paste flow, optional).
  Future<Identity> importPrivateKey(String privHex) async {
    await _storage.write(key: _key, value: privHex);
    return Identity.fromPrivateKey(privHex);
  }

  Future<void> clear() => _storage.delete(key: _key);
}

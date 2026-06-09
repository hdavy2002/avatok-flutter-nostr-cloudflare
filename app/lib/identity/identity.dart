import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../core/api_auth.dart';
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

/// Holds the signed-in Clerk account id so each account gets its OWN Nostr
/// identity on a shared device. Set right after auth; cleared on sign-out.
/// (Before this, all accounts on one device shared a single npub, which made
/// adding another account's email resolve to your own npub.)
class AccountScope {
  static String? id;
}

/// Persists the nsec in platform secure storage (Keychain / EncryptedSharedPreferences).
/// nsec NEVER leaves the device in plaintext (spec §10). The key is namespaced
/// per Clerk account so two accounts on one phone don't share an identity.
class IdentityStore {
  static const _legacyKey = 'ava_nostr_priv';
  // In-memory cache. flutter_secure_storage reads are slow on some devices
  // (notably Samsung), and load() is called from many screens (shell, chat list,
  // each thread, profile…) — re-reading the encrypted key every time added ~1s+
  // to cold-start. Cache it per account; the scope check invalidates on switch.
  static Identity? _cached;
  static String? _cachedScope;
  final FlutterSecureStorage _storage;

  IdentityStore([FlutterSecureStorage? s])
      : _storage = s ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  String get _key =>
      (AccountScope.id == null || AccountScope.id!.isEmpty) ? _legacyKey : 'ava_nostr_priv_${AccountScope.id}';

  Future<Identity?> load() async {
    final scope = AccountScope.id ?? '';
    if (_cached != null && _cachedScope == scope) {
      ApiAuth.identity = _cached; // keep the NIP-98 signer in sync
      return _cached;
    }
    final key = _key;
    var priv = await _storage.read(key: key);
    // One-time migration: the first account to log in after this change claims
    // the pre-namespacing identity, so the existing user keeps their key/npub.
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
    ApiAuth.identity = id; // keep the NIP-98 signer in sync
    _cached = id;
    _cachedScope = scope;
    return id;
  }

  Future<Identity> createAndStore() async {
    final priv = NostrKeys.generatePrivateKey();
    await _storage.write(key: _key, value: priv);
    final id = Identity.fromPrivateKey(priv);
    ApiAuth.identity = id;
    _cached = id;
    _cachedScope = AccountScope.id ?? '';
    return id;
  }

  /// Import an existing nsec/hex private key (paste flow, optional).
  Future<Identity> importPrivateKey(String privHex) async {
    await _storage.write(key: _key, value: privHex);
    final id = Identity.fromPrivateKey(privHex);
    ApiAuth.identity = id;
    _cached = id;
    _cachedScope = AccountScope.id ?? '';
    return id;
  }

  Future<void> clear() {
    ApiAuth.identity = null; // stop signing once the account is cleared
    _cached = null;
    _cachedScope = null;
    return _storage.delete(key: _key);
  }
}

// Concrete per-account secure storage for AvaChat (Phase: identity).
//
// Implements AvaChatSecureScope with flutter_secure_storage, namespaced per
// account so a parent + each child on the same phone never share secrets
// (mandatory per the rulebook). For v1 there is a single active account id
// ("primary"); parent/child switching just changes _activeAccountId before a
// re-login. Clerk JWT is wired via [clerkJwtProvider] when available; until then
// the backend gates on NIP-98 alone (matches the existing app's ApiAuth design).

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'avachat_identity.dart';

class DeviceSecureScope implements AvaChatSecureScope {
  DeviceSecureScope({String activeAccountId = 'primary'})
      : _activeAccountId = activeAccountId;

  final _storage = const FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  String _activeAccountId;

  /// Swap the active account (parent <-> child). Caller re-logs-in after.
  void setActiveAccount(String id) => _activeAccountId = id;

  @override
  String get accountId => _activeAccountId;

  @override
  Future<String?> read(String scopedKey) => _storage.read(key: scopedKey);

  @override
  Future<void> write(String scopedKey, String value) =>
      _storage.write(key: scopedKey, value: value);

  /// Optional: host injects a Clerk session JWT provider. Left null until the
  /// Clerk session is surfaced into the 0xchat shell (then bind it here).
  Future<String?> Function()? clerkJwtProvider;

  @override
  Future<String?> clerkJwt() async {
    try {
      return await clerkJwtProvider?.call();
    } catch (_) {
      return null; // Clerk optional; NIP-98 still authenticates.
    }
  }
}

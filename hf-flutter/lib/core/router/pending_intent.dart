import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/session.dart';
import '../storage/account_storage.dart';
import '../storage/secure_store.dart';
import 'routes.dart';

/// A short-lived, account-bound return destination. Never stores an OTP, identity
/// document, declaration or payment credential. Reading never performs an action.
class PendingIntentStore {
  PendingIntentStore(this.store, {DateTime Function()? now}) : _now = now ?? DateTime.now;
  final KeyValueStore store;
  final DateTime Function() _now;
  static const key = 'hf.pending.intent.v1';
  static const maxAge = Duration(hours: 24);

  Future<void> save(String destination) async {
    final uid = AccountScope.id ?? kGuestScope;
    if (Routes.safeNext(destination) == null) return;
    final storageKey = scopedKey(key);
    try { await store.write(storageKey, jsonEncode({
      'v': 1, 'uid': uid, 'next': destination, 'at': _now().millisecondsSinceEpoch,
    })); } catch (_) { /* The route query still carries the active return. */ }
  }

  Future<String?> read() async {
    final uid = AccountScope.id ?? kGuestScope;
    final storageKey = scopedKey(key);
    try {
      final raw = await store.read(storageKey);
      if (raw == null || (AccountScope.id ?? kGuestScope) != uid) return null;
      final data = jsonDecode(raw);
      if (data is Map && data['v'] == 1 && data['uid'] == uid && data['at'] is int) {
        final age = _now().millisecondsSinceEpoch - (data['at'] as int);
        final destination = data['next'];
        if (age >= 0 && age < maxAge.inMilliseconds && destination is String && Routes.isSafeNext(destination)) {
          return destination;
        }
      }
      await store.delete(storageKey);
    } catch (_) { /* Missing or corrupt recovery data never blocks browsing. */ }
    return null;
  }

  Future<void> clearGuest() async {
    try { await store.delete('${key}_$kGuestScope'); } catch (_) { /* Best effort. */ }
  }

  Future<void> clear() async {
    try { await store.delete(scopedKey(key)); } catch (_) { /* Best effort. */ }
  }
}

final pendingIntentProvider = Provider<PendingIntentStore>((ref) =>
    PendingIntentStore(ref.watch(secureStoreProvider)));

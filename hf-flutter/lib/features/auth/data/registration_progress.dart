import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/session.dart';
import '../../../core/storage/secure_store.dart';

/// Only an account created by this registration flow needs this completion step.
/// It survives a cancelled sheet/restart, and cannot affect an established account.
class RegistrationProgress {
  RegistrationProgress(this._ref);
  final Ref _ref;
  final Set<String> _required = {};
  static const key = 'hf.registration.name.v1';
  KeyValueStore get _store => _ref.read(secureStoreProvider);
  String? get _uid => _ref.read(sessionProvider).user?.id ?? _ref.read(sessionProvider).me?.uid;

  Future<void> markNewAccount() async {
    final uid = _uid;
    if (uid == null) return;
    _required.add(uid);
    try { await _store.write('${key}_$uid', 'required'); } catch (_) { /* Retain in memory while storage is unavailable. */ }
  }

  Future<bool> needsName() async {
    final uid = _uid;
    if (uid == null) return false;
    final name = _ref.read(sessionProvider).me?.displayName;
    if (name != null && name.trim().isNotEmpty) { await complete(expectedUid: uid); return false; }
    if (_required.contains(uid)) return true;
    try {
      final pending = await _store.read('${key}_$uid');
      return _uid == uid && pending == 'required';
    } catch (_) { return false; }
  }

  Future<void> complete({String? expectedUid}) async {
    final uid = expectedUid ?? _uid;
    if (uid == null || _uid != uid) return;
    _required.remove(uid);
    try { await _store.delete('${key}_$uid'); } catch (_) { /* Server-saved name also completes the step. */ }
  }
}

final registrationProgressProvider = Provider<RegistrationProgress>(RegistrationProgress.new);

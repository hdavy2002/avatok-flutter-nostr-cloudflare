import 'dart:convert';
import '../../../core/storage/secure_store.dart';

class RememberedAccount {
  const RememberedAccount({required this.uid, required this.label, required this.phone});
  final String uid;
  final String label;
  final String phone;
  String get masked => phone.length >= 4 ? '•••• ${phone.substring(phone.length - 4)}' : 'WhatsApp account';
}

/// A device discovery index contains IDs only. Account labels and identifiers are
/// held in separate UID-scoped secure entries. Every selection requires a new OTP;
/// remembered accounts never store reusable session credentials.
class RememberedAccounts {
  const RememberedAccounts(this.store);
  final KeyValueStore store;
  static const _index = 'hf.device.account-index.v1';
  String _key(String uid) => 'hf.account-choice.v1_$uid';

  Future<List<RememberedAccount>> read() async {
    try {
      final ids = jsonDecode(await store.read(_index) ?? '[]');
      if (ids is! List) return [];
      final accounts = <RememberedAccount>[];
      for (final id in ids.whereType<String>().take(8)) {
        final raw = await store.read(_key(id));
        if (raw == null) continue;
        final j = jsonDecode(raw);
        if (j is Map && j['phone'] is String && j['label'] is String) {
          accounts.add(RememberedAccount(uid: id, label: j['label'] as String, phone: j['phone'] as String));
        }
      }
      return accounts;
    } catch (_) { return []; }
  }

  Future<void> remember(RememberedAccount account) async {
    final accounts = await read();
    await store.write(_key(account.uid), jsonEncode({'label': account.label, 'phone': account.phone}));
    final ids = [account.uid, ...accounts.where((a) => a.uid != account.uid).map((a) => a.uid)].take(8).toList();
    await store.write(_index, jsonEncode(ids));
  }

  Future<void> forget(String uid) async {
    final accounts = await read();
    await store.delete(_key(uid));
    await store.write(_index, jsonEncode(accounts.where((a) => a.uid != uid).map((a) => a.uid).toList()));
  }
}

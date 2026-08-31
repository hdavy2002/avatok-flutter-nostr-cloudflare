import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/account_storage.dart';
import 'virtual_numbers_api.dart';
import 'virtual_numbers_models.dart';

/// Small account-scoped coordinator used by both the list and outgoing dialer.
/// Only the opaque line id is persisted locally; the server remains authoritative.
class VirtualNumbersStore {
  VirtualNumbersStore({VirtualNumbersApi? api, FlutterSecureStorage? storage})
      : api = api ?? VirtualNumbersApi(),
        _storage = storage ??
            const FlutterSecureStorage(
              mOptions: MacOsOptions(useDataProtectionKeyChain: false),
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  final VirtualNumbersApi api;
  final FlutterSecureStorage _storage;
  static const _defaultDidKey = 'virtual_numbers_default_outgoing_did';

  Future<String?> readDefaultDidId() => readScoped(_storage, _defaultDidKey);

  Future<void> saveDefaultDidId(String lineId) =>
      _storage.write(key: scopedKey(_defaultDidKey), value: lineId);

  Future<void> clearDefaultDidId() =>
      _storage.delete(key: scopedKey(_defaultDidKey));

  /// Drops a stale/suspended default and picks the first eligible DID. The
  /// returned list is intentionally immutable to callers through a new List.
  Future<List<VirtualLine>> reconcileDefault(List<VirtualLine> lines) async {
    final eligible = lines
        .where((line) =>
            line.isDid && line.isActive && line.can('outbound_caller_id'))
        .toList();
    final existing = await readDefaultDidId();
    final selected =
        eligible.where((line) => line.id == existing).firstOrNull ??
            (eligible.isEmpty ? null : eligible.first);
    if (selected == null) {
      await clearDefaultDidId();
    } else if (selected.id != existing) {
      await saveDefaultDidId(selected.id);
    }
    return lines
        .map(
            (line) => line.copyWith(isDefaultOutgoing: line.id == selected?.id))
        .toList(growable: false);
  }
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}

import 'dart:async';

import '../../identity/identity.dart';
import 'avadial_channel.dart';

/// Call type, mirrored from Android `CallLog.Calls.TYPE`.
enum DeviceCallType { incoming, outgoing, missed, rejected, blocked, voicemail, unknown }

DeviceCallType _typeFrom(int t) {
  // Values from android.provider.CallLog.Calls.
  switch (t) {
    case 1:
      return DeviceCallType.incoming;
    case 2:
      return DeviceCallType.outgoing;
    case 3:
      return DeviceCallType.missed;
    case 4:
      return DeviceCallType.voicemail;
    case 5:
      return DeviceCallType.rejected;
    case 6:
      return DeviceCallType.blocked;
    default:
      return DeviceCallType.unknown;
  }
}

/// One row of the DEVICE call log (OS-owned, device-global). Never persisted into
/// an account backup (plan §4.7 boundary).
class DeviceCall {
  final String number;
  final DeviceCallType type;
  final DateTime date;
  final Duration duration;
  final String? cachedName;
  const DeviceCall({
    required this.number,
    required this.type,
    required this.date,
    required this.duration,
    this.cachedName,
  });
}

/// LIVE device call-log reader (plan §4.1 Logs tab).
///
/// `READ_CALL_LOG` is a Play-restricted permission granted implicitly to the
/// default dialer (spike §6/§8), so the Logs tab is gated on the dialer role in the
/// UI. Device-data boundary identical to [DeviceContacts]: read live, cache in
/// memory only, keyed by [AccountScope.id], dropped on account switch.
class DeviceCallLog {
  DeviceCallLog._();
  static final DeviceCallLog I = DeviceCallLog._();

  List<DeviceCall>? _cache;
  String? _cacheScope;

  void _guardScope() {
    if (_cacheScope != AccountScope.id) {
      _cache = null;
      _cacheScope = AccountScope.id;
    }
  }

  /// Explicit clear — wire into the account-switch teardown.
  void clear() {
    _cache = null;
    _cacheScope = AccountScope.id;
  }

  /// Load the device call log (cache unless [force]). Empty when the dialer role /
  /// permission is absent or on an unsupported platform.
  Future<List<DeviceCall>> load({bool force = false, int limit = 500}) async {
    _guardScope();
    if (!force && _cache != null) return _cache!;
    final rows = await AvaDialChannel.I.readCallLog(limit: limit);
    final list = <DeviceCall>[];
    for (final r in rows) {
      final number = (r['number'] as String?)?.trim();
      if (number == null || number.isEmpty) continue;
      list.add(DeviceCall(
        number: number,
        type: _typeFrom((r['type'] as num?)?.toInt() ?? 0),
        date: DateTime.fromMillisecondsSinceEpoch((r['date'] as num?)?.toInt() ?? 0),
        duration: Duration(seconds: (r['duration'] as num?)?.toInt() ?? 0),
        cachedName: r['name'] as String?,
      ));
    }
    if (_cacheScope == AccountScope.id) _cache = list;
    return list;
  }
}

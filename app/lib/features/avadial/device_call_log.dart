import 'dart:async';
import 'dart:io' show Platform;

import 'package:permission_handler/permission_handler.dart';

import '../../core/analytics.dart';
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

  // [CALLLOG-PERM] Whether we've already surfaced ONE calllog_perm_blocked event
  // for the current denial. READ_CALL_LOG is device-level (not per-account), so
  // this is a plain process-global flag on the singleton — no scoped key needed.
  // Reset the moment we next observe the permission granted, so a later
  // revocation in the same session reports again (once).
  bool _permBlockedReported = false;

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
    // The device call log is an Android-only surface — never touch the native
    // channel elsewhere (and never emit a spurious perm-blocked event there).
    if (!Platform.isAndroid) return const [];
    // [CALLLOG-PERM] Read the live OS permission status FIRST rather than calling
    // the native readCallLog channel and letting it throw. When READ_CALL_LOG is
    // absent the old code hit a `PlatformException(…Permission…)` on EVERY call,
    // and each caller retried it on every screen open — 47 identical "readCallLog
    // failed" diag lines a week narrating a state we could have read for free.
    // `.status` is read-only and never prompts. If the permission is missing we
    // skip the channel entirely and surface ONE calllog_perm_blocked per session;
    // when the status later flips to granted, the next load() just proceeds — no
    // retry loop against the failing channel in between.
    if (!await _hasCallLogPermission()) {
      if (!_permBlockedReported) {
        _permBlockedReported = true;
        Analytics.capture('calllog_perm_blocked', {
          'source': 'device_call_log',
          'permission': 'READ_CALL_LOG',
        });
      }
      return _cache ?? const [];
    }
    // Permission present → re-arm the one-shot so a later revocation reports again.
    _permBlockedReported = false;
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

  /// [CALLLOG-PERM] True when READ_CALL_LOG is granted. permission_handler folds
  /// READ_CALL_LOG into the `phone` permission group; `.status` is a read-only
  /// query that never shows a prompt (same pattern push_service uses for
  /// `Permission.contacts.status`). The default dialer is auto-granted
  /// READ_CALL_LOG at the OS level, so this also reads true whenever AvaTOK holds
  /// the dialer role. Any failure is treated as "not granted" so we never fall
  /// through to the native channel on an unexpected error.
  Future<bool> _hasCallLogPermission() async {
    try {
      return (await Permission.phone.status).isGranted;
    } catch (_) {
      return false;
    }
  }
}

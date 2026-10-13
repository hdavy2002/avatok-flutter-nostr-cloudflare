import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/analytics/analytics.dart';

/// Account-independent installation state. Android's noBackupFilesDir deliberately
/// cannot be restored onto a new installation. Never put this in backed-up prefs.
class InstallIntroStore {
  InstallIntroStore({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel('hf/install_intro');

  final MethodChannel _channel;
  bool? _completed;
  Future<bool>? _reading;

  Future<bool> isCompleted() async {
    if (_completed != null) return _completed!;
    return _reading ??= _read();
  }

  Future<bool> _read() async {
    try {
      final completed = await _channel.invokeMethod<bool>('isCompleted')
          .timeout(const Duration(seconds: 2));
      if (completed == null) throw const FormatException();
      // A completion tap that raced the read always wins for this process.
      _completed ??= completed;
      await _report('read', 'ok');
    } catch (_) {
      _completed ??= false;
      await _report('read', 'unavailable');
    }
    return _completed!;
  }

  /// Storage failure never traps a person in the intro. It applies for this
  /// process and may be shown again on next launch; telemetry records that fact.
  Future<bool> complete() async {
    _completed = true;
    try {
      final saved = await _channel.invokeMethod<bool>('complete')
          .timeout(const Duration(seconds: 2));
      if (saved != true) throw const FormatException();
      await _report('write', 'ok');
      return true;
    } catch (_) {
      await _report('write', 'unavailable');
      return false;
    }
  }

  Future<void> _report(String operation, String outcome) => Analytics.capture(
    'hf_app_intro_storage_result',
    {'operation': operation, 'outcome': outcome, 'intro_version': 1},
  );
}

final installIntroStoreProvider = Provider<InstallIntroStore>(
  (_) => InstallIntroStore(),
);

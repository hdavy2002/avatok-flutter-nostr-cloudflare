import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'analytics.dart';

/// Reports Android's reason for the previous process exit on the next launch.
/// This closes the blind spot where an ANR, native crash, low-memory kill or
/// user-requested stop terminates Dart before `$exception` can be emitted.
class ProcessExitDiagnostics {
  ProcessExitDiagnostics._();

  static const _channel = MethodChannel('avatok/process_exit');

  static Future<void> reportPreviousExits() async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return;
    try {
      final rows = await _channel.invokeListMethod<dynamic>('consumePreviousExits') ?? const [];
      for (final raw in rows) {
        if (raw is! Map) continue;
        final row = Map<Object?, Object?>.from(raw);
        await Analytics.capture('android_process_exit', {
          'reason': (row['reason'] ?? 'unknown').toString(),
          'reason_code': (row['reason_code'] as num?)?.toInt() ?? -1,
          'status': (row['status'] as num?)?.toInt() ?? 0,
          'importance': (row['importance'] as num?)?.toInt() ?? 0,
          'pss_kb': (row['pss_kb'] as num?)?.toInt() ?? 0,
          'rss_kb': (row['rss_kb'] as num?)?.toInt() ?? 0,
          'exit_timestamp_ms': (row['timestamp_ms'] as num?)?.toInt() ?? 0,
          'description': (row['description'] ?? '').toString(),
          'trace_available': row['trace_available'] == true,
        });
      }
    } catch (error, stack) {
      await Analytics.captureException(error, stack,
          screen: 'startup_process_exit_diagnostics', handled: true);
    }
  }
}

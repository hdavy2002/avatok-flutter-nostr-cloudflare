import 'dart:async';

import '../../../core/analytics/analytics.dart';

/// Call events (catalog section "native app: calls and reviews"). No phone number, uid or call id rides on them.
/// Events that can fail carry `outcome` and `reason` (and `status`, the HTTP status, plus `ms` when known).
abstract final class CallTelemetry {
  /// `hf_app_call_started {slug}`: the person tapped Start call. `outcome` is `ok` or `failed`; a failure carries
  /// the server's error code as `reason`.
  static void started({
    required String slug,
    required bool ok,
    String? reason,
    int? httpStatus,
    int? ms,
    String? mode,
  }) {
    unawaited(Analytics.capture('hf_app_call_started', {
      'slug': slug,
      'outcome': ok ? 'ok' : 'failed',
      if (reason != null) 'reason': reason,
      if (httpStatus != null) 'status': httpStatus,
      if (ms != null) 'ms': ms,
      if (mode != null) 'mode': mode,
    }));
  }

  /// `hf_app_call_status {status}`: once per distinct status the call screen sees.
  static void status(String status) {
    unawaited(Analytics.capture('hf_app_call_status', {'status': status}));
  }

  /// `hf_app_call_cancelled`: `outcome` is `ok`, `too_late` (already connected) or `failed`.
  static void cancelled(String outcome, {String? reason}) {
    unawaited(Analytics.capture('hf_app_call_cancelled', {
      'outcome': outcome,
      if (reason != null) 'reason': reason,
    }));
  }

  /// `hf_app_call_ended {seconds, end_reason}`: once per call, when the status turns terminal.
  /// `status` is the terminal status; `end_reason` is `none` when the server sent none.
  static void ended({required int seconds, required String? endReason, required String status, String? mode}) {
    unawaited(Analytics.capture('hf_app_call_ended', {
      'seconds': seconds,
      'end_reason': endReason ?? 'none',
      'status': status,
      if (mode != null) 'mode': mode,
    }));
  }
}

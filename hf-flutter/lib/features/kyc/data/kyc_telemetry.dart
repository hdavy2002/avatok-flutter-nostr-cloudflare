import '../../../core/analytics/analytics.dart';

/// Where telemetry goes. The default is PostHog through [Analytics]; tests replace it with a recorder.
typedef TelemetrySink = Future<void> Function(String event, Map<String, Object> props);

/// The three events of HF-NATIVE-8 and HF-NATIVE-9 (telemetry catalog, native app section "identity checks").
///
/// - `hf_app_permission {kind: camera|mic, result: granted|denied|error}`
/// - `hf_app_kyc_step {step, result, reason?, status?}`
/// - `hf_app_lane_join {lane: women|lgbtq, result, reason?, status?}`
///
/// Never carries an Aadhaar number, a name, a bank detail or a gender (HF-PRIV-6, HF-KYC-2). Best effort:
/// it never throws into a screen.
abstract final class KycTelemetry {
  static TelemetrySink sink = _toAnalytics;

  static Future<void> _toAnalytics(String event, Map<String, Object> props) => Analytics.capture(event, props);

  static void resetSink() => sink = _toAnalytics;

  static void _send(String event, Map<String, Object> props) {
    try {
      sink(event, props).catchError((Object _) {});
    } catch (_) {
      // telemetry never breaks a screen
    }
  }

  static void permission(String kind, String result) =>
      _send('hf_app_permission', {'kind': kind, 'result': result});

  /// Steps: `aadhaar_otp`, `aadhaar_verify`, `digilocker_start`, `digilocker_complete`, `selfie_upload`, `payout_verify`.
  /// Results: `sent | ok | already_verified | fallback | pending | wrong_code | mismatch | error | ...`; failures carry `reason`
  /// (the worker's error code) and `status`.
  static void kycStep(String step, String result, {String? reason, int? status}) => _send('hf_app_kyc_step', {
        'step': step,
        'result': result,
        if (reason != null) 'reason': reason,
        if (status != null) 'status': status,
      });

  /// `result`: `joined | not_eligible | aadhaar_required | error`.
  static void laneJoin(String lane, String result, {String? reason, int? status}) => _send('hf_app_lane_join', {
        'lane': lane,
        'result': result,
        if (reason != null) 'reason': reason,
        if (status != null) 'status': status,
      });
}

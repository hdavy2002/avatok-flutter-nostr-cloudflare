import '../../../../core/analytics/analytics.dart';

/// Where part B telemetry goes. The default is PostHog through [Analytics]; tests replace it with a recorder.
typedef PartBTelemetrySink = Future<void> Function(String event, Map<String, Object> props);

/// The events of HF-NATIVE-10 (telemetry catalog, native app section "host onboarding part B"):
///
/// - `hf_app_onboarding_step {step, result, reason?, status?}`
/// - `hf_app_voice_recorded {seconds}`
/// - `hf_app_host_submitted`
///
/// Never carries a name, the about text, a transcript or anything the host typed. Best effort: it never throws
/// into a screen.
abstract final class OnboardingTelemetry {
  static PartBTelemetrySink sink = _toAnalytics;

  static Future<void> _toAnalytics(String event, Map<String, Object> props) => Analytics.capture(event, props);

  static void resetSink() => sink = _toAnalytics;

  static void _send(String event, Map<String, Object> props) {
    try {
      sink(event, props).catchError((Object _) {});
    } catch (_) {
      // telemetry never breaks a screen
    }
  }

  /// One per finished step action. [step] is the step key (`avatar`, `about`, `voice`, `generating`, `preview`, ...).
  /// [result]: `ok`, `saved`, `claimed`, `taken`, `started`, `done`, `failed`, `submitted`, `error`, `blocked`.
  /// Failures carry `reason` (the worker's error code) and `status` (HTTP).
  static void step(String step, String result, {String? reason, int? status}) => _send('hf_app_onboarding_step', {
        'step': step,
        'result': result,
        if (reason != null) 'reason': reason,
        if (status != null) 'status': status,
      });

  /// The voice introduction was accepted by the server. [seconds] is its length.
  static void voiceRecorded(int seconds) => _send('hf_app_voice_recorded', {'seconds': seconds});

  /// The profile was sent for review.
  static void hostSubmitted() => _send('hf_app_host_submitted', const <String, Object>{});
}

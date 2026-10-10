import '../../../core/analytics/analytics.dart';

/// Telemetry of the Me screen and the delete-account flow (catalog: "Me, settings and delete account",
/// `[HF-NATIVE-12]`). Best effort: it never throws into a screen. Tests replace [sink].
///
/// Never carries a name, a phone number or an amount of money.
abstract final class MeTelemetry {
  static Future<void> Function(String event, Map<String, Object> props) sink = _toAnalytics;

  static Future<void> _toAnalytics(String event, Map<String, Object> props) => Analytics.capture(event, props);

  static void resetSink() => sink = _toAnalytics;

  static void _send(String event, Map<String, Object> props) {
    try {
      sink(event, props).catchError((Object _) {});
    } catch (_) {
      // telemetry never breaks a screen
    }
  }

  /// The Me tab was opened.
  static void viewed({required bool signedIn}) => _send('hf_app_me_viewed', {'signed_in': signedIn});

  /// `outcome`: `ok | failed`. A failure carries `reason` (the worker's code, or `empty`, `network`) and `status`.
  static void nameUpdated(String outcome, {String? reason, int? status}) => _send('hf_app_name_updated', {
        'outcome': outcome,
        if (reason != null) 'reason': reason,
        if (status != null) 'status': status,
      });

  /// The person confirmed on the delete screen. `decision`: `delete | exit` (what the server said).
  static void deleteStarted(String decision) => _send('hf_app_account_delete_started', {'decision': decision});

  /// How the confirmed step ended. `outcome`: `ok | deferred | failed`; `reason` is the worker's code.
  static void deleteResult(String decision, String outcome, {String? reason, int? status}) =>
      _send('hf_app_account_delete_result', {
        'decision': decision,
        'outcome': outcome,
        if (reason != null) 'reason': reason,
        if (status != null) 'status': status,
      });
}

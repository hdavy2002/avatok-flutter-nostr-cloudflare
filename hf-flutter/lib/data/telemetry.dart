import 'package:flutter/foundation.dart';

/// One place the data layer reports to. Event names come from Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md
/// (`api_error`, `hf_app_open`, `hf_app_deeplink_opened`). The PostHog wiring itself arrives in a later
/// stage: until then [sink] only keeps the events in debug output, and tests can swap it.
///
/// Nothing in here may ever throw into the caller, and secrets (tokens, numbers, codes) never go in.
typedef TelemetrySink = void Function(String event, Map<String, Object?> props);

abstract final class Telemetry {
  static TelemetrySink sink = _debugSink;

  static void _debugSink(String event, Map<String, Object?> props) {
    if (kDebugMode) debugPrint('[telemetry] $event $props');
  }

  static void event(String name, [Map<String, Object?> props = const {}]) {
    try {
      sink(name, props);
    } catch (_) {
      // telemetry never throws into a request
    }
  }

  /// Catalog event `api_error`: every non-2xx or network failure, reported once by the API client.
  static void reportFetchFailure({
    required String method,
    required String endpoint,
    required int status,
    required String code,
    required int ms,
  }) {
    event('api_error', {
      'endpoint': endpoint,
      'method': method,
      'status': status,
      'code': code,
      'ms': ms,
      'latency_ms': ms,
    });
  }

  /// Catalog event `hf_app_deeplink_opened`: [path] must already be anonymised (`/h/:id`).
  static void deepLinkOpened({required String path, required String source, required String launch}) {
    event('hf_app_deeplink_opened', {'path': path, 'source': source, 'launch': launch});
  }

  /// Catalog event `hf_app_open`: once per process start, after the splash work.
  static void appOpen({required int coldMs, required bool signedIn}) {
    event('hf_app_open', {'cold_ms': coldMs, 'signed_in': signedIn});
  }
}

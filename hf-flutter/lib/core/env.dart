import 'brand.dart';

/// Build-time and brand-derived constants. Hosts, scheme and package id come from the
/// generated [Brand] (Specs/brand.json); never type them here.
abstract final class Env {
  /// API origin, e.g. `https://api.<domain>` (from Brand).
  static const String apiOrigin = Brand.apiOrigin;

  /// Site origin, e.g. `https://<domain>`.
  static const String webOrigin = Brand.webOrigin;

  /// Custom URL scheme (first label of the domain).
  static const String scheme = Brand.scheme;

  /// Git commit SHA stamped by CI (--dart-define=GIT_SHA=...); 'dev' for unstamped builds.
  static const String release = String.fromEnvironment('GIT_SHA', defaultValue: 'dev');

  /// PostHog EU project 139917 (same project key the avaTOK app uses; events are told apart by service_name).
  static const String posthogKey = 'phc_hmYMsHQEYjQU4bYXNdqA4VZVsfHEIkBQdQL0Kv7FIc5';
  static const String posthogHost = 'https://eu.i.posthog.com';

  /// Opens this app's page in the Play Store.
  static const String playMarketUri = 'market://details?id=${Brand.hfPlayPackageId}';

  /// Value of the telemetry super property `platform` for this app (owner decision; catalog section 1.1).
  static const String telemetryPlatform = 'android-app';

  /// Value of the telemetry super property `service_name` for this app.
  static const String telemetryService = 'hf-app';
}

import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:posthog_flutter/posthog_flutter.dart';

/// Central client-side analytics for AvaTOK → PostHog (EU region, project 139917).
///
/// Everything here is best-effort: a telemetry failure must never throw into the
/// app or block a user action. Identity is the npub (same distinct_id the Worker
/// backend uses in `worker/src/hooks.ts`), so client + server events stitch into
/// one person timeline. We never send PII (email, phone, private key, raw DOB) —
/// only buckets/booleans and scrubbed error text.
class Analytics {
  static const _apiKey = 'phc_hmYMsHQEYjQU4bYXNdqA4VZVsfHEIkBQdQL0Kv7FIc5';
  static const _host = 'https://eu.i.posthog.com'; // EU ingestion — must match project region
  static const appVersion = '0.1.13+14'; // keep in sync with pubspec version

  static bool _ready = false;

  /// Add to MaterialApp.navigatorObservers to auto-capture a screen on each route.
  static final PosthogObserver observer = PosthogObserver();

  static Future<void> init() async {
    try {
      final config = PostHogConfig(_apiKey)
        ..host = _host
        ..captureApplicationLifecycleEvents = true // app_opened / backgrounded / installed / updated
        ..debug = kDebugMode;
      await Posthog().setup(config);
      _ready = true;
    } catch (_) {/* analytics is optional; app runs without it */}
  }

  static String get _platform =>
      Platform.isIOS ? 'ios' : (Platform.isAndroid ? 'android' : 'other');

  static Map<String, Object> _base([Map<String, Object>? p]) => {
        'platform': _platform,
        'app_version': appVersion,
        'service_name': 'avatok-app',
        ...?p,
      };

  /// Attach all subsequent events to this person (call when the npub exists).
  static Future<void> identify(String npub, {Map<String, Object>? properties}) async {
    if (!_ready) return;
    try {
      await Posthog().identify(userId: npub, userProperties: _base(properties));
    } catch (_) {}
  }

  static Future<void> capture(String event, [Map<String, Object>? properties]) async {
    if (!_ready) return;
    try {
      await Posthog().capture(eventName: event, properties: _base(properties));
    } catch (_) {}
  }

  static Future<void> screen(String name, [Map<String, Object>? properties]) async {
    if (!_ready) return;
    try {
      await Posthog().screen(screenName: name, properties: _base(properties));
    } catch (_) {}
  }

  /// Standardized caught-error event. Every `catch` block in a screen should
  /// route here so all errors are queryable together by `error_domain`.
  /// Domains: auth, identity, otp, email_verification, liveness, messaging,
  /// call_setup, live, media, agent, community, profile, account, network.
  static Future<void> error({
    required String domain,
    required String code,
    String? message,
    String? screen,
    String? action,
    bool fatal = false,
    Map<String, Object>? extra,
  }) async {
    await capture('error_occurred', {
      'error_domain': domain,
      'error_code': code,
      if (message != null) 'error_message': _scrub(message),
      if (screen != null) 'screen': screen,
      if (action != null) 'action': action,
      'is_fatal': fatal,
      ...?extra,
    });
  }

  /// Uncaught crash → $exception (wire FlutterError.onError to this in main).
  static Future<void> captureException(Object error, StackTrace? stack, {String? screen}) async {
    if (!_ready) return;
    try {
      await Posthog().capture(eventName: '\$exception', properties: _base({
        '\$exception_message': _scrub(error.toString()),
        '\$exception_type': error.runtimeType.toString(),
        if (stack != null) 'stack': stack.toString(),
        if (screen != null) 'screen': screen,
        'is_fatal': true,
      }));
    } catch (_) {}
  }

  /// Clear the identity on sign-out so the next user starts anonymous.
  static Future<void> reset() async {
    if (!_ready) return;
    try {
      await Posthog().reset();
    } catch (_) {}
  }

  /// Remove anything that looks like an nsec / long token from error text so we
  /// never leak secrets into analytics.
  static String _scrub(String s) {
    var out = s.replaceAll(RegExp(r'nsec1[0-9a-z]+'), 'nsec[redacted]');
    out = out.replaceAll(RegExp(r'[A-Za-z0-9_\-]{40,}'), '[redacted]');
    return out.length > 500 ? out.substring(0, 500) : out;
  }
}

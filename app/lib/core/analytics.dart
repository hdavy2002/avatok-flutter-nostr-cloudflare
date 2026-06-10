import 'dart:io' show Platform;

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:posthog_flutter/posthog_flutter.dart';

import 'ava_log.dart';
import 'feature_flags.dart';

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
  static const appVersion = '0.1.16+17'; // keep in sync with pubspec version

  static bool _ready = false;

  // ── Envelope (ANALYTICS-OBSERVABILITY §1, BINDING) ─────────────────────────
  // Auto-merged onto EVERY event so any app's events are remotely diagnosable.
  /// Which AvaVerse app the user is in (avatok|wallet|explore|avalive|…).
  /// Screens set this when an app takes the foreground.
  static String app = 'avatok';
  /// Current logical screen (set via [screenViewed] or by screens directly).
  static String? currentScreen;
  /// Person buckets — set at identify time.
  static String? _accountId;
  static String accountKind = 'personal';
  static int _seq = 0; // session_seq — monotonic per app session
  static String _net = 'unknown'; // wifi|cell|offline

  /// Add to MaterialApp.navigatorObservers to auto-capture a screen on each route.
  static final PosthogObserver observer = PosthogObserver();

  /// Mandatory `screen_viewed` event (§2) — call on every route push.
  static Future<void> screenViewed(String appId, String screenName, {String? from}) {
    app = appId;
    currentScreen = screenName;
    return capture('screen_viewed', {if (from != null) 'from': from});
  }

  /// Central `api_error` event (§2) — emitted by the HTTP wrapper (ApiAuth),
  /// never per screen.
  static Future<void> apiError({
    required String endpoint,
    required int status,
    String? code,
    int? latencyMs,
    int retryCount = 0,
  }) =>
      capture('api_error', {
        'endpoint': endpoint,
        'status': status,
        if (code != null) 'code': code,
        if (latencyMs != null) 'latency_ms': latencyMs,
        'retry_count': retryCount,
      });

  static void _applyNet(List<ConnectivityResult> rs) {
    if (rs.isEmpty || rs.every((r) => r == ConnectivityResult.none)) {
      _net = 'offline';
    } else if (rs.contains(ConnectivityResult.wifi) || rs.contains(ConnectivityResult.ethernet)) {
      _net = 'wifi';
    } else if (rs.contains(ConnectivityResult.mobile)) {
      _net = 'cell';
    } else {
      _net = 'other';
    }
  }

  static Future<void> init() async {
    try {
      Connectivity().checkConnectivity().then(_applyNet).catchError((_) {});
      Connectivity().onConnectivityChanged.listen(_applyNet, onError: (_) {});
    } catch (_) {/* net dimension stays 'unknown' */}
    try {
      final config = PostHogConfig(_apiKey)
        ..host = _host
        ..captureApplicationLifecycleEvents = true // app_opened / backgrounded / installed / updated
        ..debug = kDebugMode;
      await Posthog().setup(config);
      _ready = true;
      // Stream every diagnostic log line live to PostHog (batched/flushed by the
      // SDK), keyed to the person via identify(npub). No manual upload, no
      // app-owned DB. Pull a user's logs by resolving their email -> npub.
      AvaLog.I.sink = (e) => capture('diag_log', {
            'tag': e.tag,
            'level': e.level,
            'line': e.line,
            'log_app': AvaLog.I.app,
            'session': AvaLog.I.session,
          });
    } catch (_) {/* analytics is optional; app runs without it */}
  }

  static String get _platform =>
      Platform.isIOS ? 'ios' : (Platform.isAndroid ? 'android' : 'other');

  static Map<String, Object> _base([Map<String, Object>? p]) => {
        'platform': _platform,
        'app_version': appVersion,
        'service_name': 'avatok-app',
        // Envelope (§1) — present on every event; explicit props win on clash.
        'app': app,
        if (currentScreen != null) 'screen': currentScreen!,
        if (_accountId != null) 'account_id': _accountId!,
        'account_kind': accountKind,
        'build': kAppBuild,
        'env': kAvatokEnv,
        'net': _net,
        'session_seq': ++_seq,
        ...?p,
      };

  /// Attach all subsequent events to this person (call when the npub exists).
  static Future<void> identify(String npub, {Map<String, Object>? properties}) async {
    _accountId = npub;
    final k = properties?['account_kind'];
    if (k is String && k.isNotEmpty) accountKind = k;
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
    _accountId = null;
    accountKind = 'personal';
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

import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:posthog_flutter/posthog_flutter.dart';

import '../brand.dart';
import '../env.dart';
import '../storage/secure_store.dart';

/// Client analytics for the native app, to PostHog EU (project 139917). Trimmed from the avaTOK
/// app's core/analytics.dart.
///
/// Rules (Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md):
///  * Event names are snake_case `<area>_<object>_<outcome>`.
///  * Every event that can fail carries `outcome, reason, status, ms`.
///  * Everything is best effort: telemetry never throws into the app or blocks a tap.
///  * Static and safe to call before [init]: events are dropped until PostHog is ready, which also
///    keeps widget tests free of platform channels.
///
/// Super properties on every event (see [_base]): `platform:'android-app'`, `service_name:'hf-app'`,
/// `app` (the brand slug, like the worker's app_name), `release` (GIT_SHA), `app_version`, `app_build`
/// (versionCode), `clerk_uid`, `email`, `phone`, `screen`. The `platform` value is new (owner decision,
/// catalog section 1.1): native events are told apart from the website by `service_name`.
class Analytics {
  /// `versionName+versionCode`, resolved from PackageInfo in [init]. Never hardcode.
  static String appVersion = 'unresolved';

  /// The numeric versionCode. -1 until resolved (an honest unknown).
  static int appBuild = -1;

  static bool _ready = false;
  static bool get isReady => _ready;

  /// Current logical screen. Set by [screenViewed].
  static String? currentScreen;

  static String? _accountId;
  static String? _email;
  static String? _phone;
  static String? _clerkUid;
  static int _seq = 0;
  static KeyValueStore? _store;

  /// Used by tests to read what would have been sent, without PostHog.
  @visibleForTesting
  static Map<String, Object> debugBase([Map<String, Object>? p]) => _base(p);

  /// Resets every static, for tests.
  @visibleForTesting
  static void debugReset() {
    _ready = false;
    currentScreen = null;
    _accountId = null;
    _email = null;
    _phone = null;
    _clerkUid = null;
    _seq = 0;
    _store = null;
    appVersion = 'unresolved';
    appBuild = -1;
  }

  static String _phoneKey(String uid) => 'ph_phone_$uid';
  static String _emailKey(String uid) => 'ph_email_$uid';

  static Future<void> init({KeyValueStore? store}) async {
    _store = store ?? SecureKeyValueStore();
    try {
      final info = await PackageInfo.fromPlatform();
      appVersion = '${info.version}+${info.buildNumber}';
      appBuild = int.tryParse(info.buildNumber) ?? -1;
    } catch (_) {
      // keep 'unresolved': an honest unknown beats a stale lie
    }
    try {
      final config = PostHogConfig(Env.posthogKey)
        ..host = Env.posthogHost
        ..captureApplicationLifecycleEvents = true
        ..debug = kDebugMode;
      // Native crash capture plus background-isolate errors. Flutter-framework and PlatformDispatcher
      // errors are reported by main.dart's own handlers, so they are not auto-captured twice.
      try {
        config.errorTrackingConfig.captureNativeExceptions = true;
        config.errorTrackingConfig.captureIsolateErrors = true;
        config.errorTrackingConfig.captureFlutterErrors = false;
        config.errorTrackingConfig.capturePlatformDispatcherErrors = false;
        config.errorTrackingConfig.inAppIncludes.add('package:hf_app');
      } catch (_) {
        // older SDK without errorTrackingConfig: no-op
      }
      // Session replay: masked, so no text or image content leaves the device. Needs PostHogWidget in main.
      try {
        config.sessionReplay = true;
        config.sessionReplayConfig.maskAllTexts = true;
        config.sessionReplayConfig.maskAllImages = true;
        config.sessionReplayConfig.sampleRate = 0.2;
      } catch (_) {
        // older SDK without sessionReplay: no-op
      }
      await Posthog().setup(config);
      _ready = true;
    } catch (_) {
      // analytics is optional: the app runs without it
    }
  }

  static String get _platformOs => Platform.isAndroid ? 'android' : 'other';

  static Map<String, Object> _base([Map<String, Object>? p]) => {
        'platform': Env.telemetryPlatform,
        'service_name': Env.telemetryService,
        'app': Brand.slug,
        'os': _platformOs,
        'release': Env.release,
        'app_version': appVersion,
        'app_build': appBuild,
        'environment': 'prod',
        if (currentScreen != null) 'screen': currentScreen!,
        if (_accountId != null) 'account_id': _accountId!,
        if (_email != null) 'email': _email!,
        if (_phone != null) 'phone': _phone!,
        if (_clerkUid != null) 'clerk_uid': _clerkUid!,
        'session_seq': ++_seq,
        ...?p,
      };

  /// Attach all later events to this person. Pass [phone] (E.164) and [email] when known; they ride
  /// every event and become person properties, so support can find a user's telemetry by phone.
  static Future<void> identify(String uid, {String? phone, String? email, Map<String, Object>? properties}) async {
    _accountId = uid;
    if (phone != null && phone.isNotEmpty) {
      _phone = phone;
      await _persist(_phoneKey(uid), phone);
    } else {
      _phone ??= await _load(_phoneKey(uid));
    }
    if (email != null && email.isNotEmpty) {
      _email = email;
      await _persist(_emailKey(uid), email);
    } else {
      _email ??= await _load(_emailKey(uid));
    }
    if (!_ready) return;
    try {
      await Posthog().identify(userId: uid, userProperties: _base(properties));
    } catch (_) {
      // best effort
    }
  }

  /// Link the person to their Clerk uid so client events and the worker's events join in PostHog.
  static Future<void> aliasClerk(String clerkUid) async {
    if (clerkUid.isEmpty || clerkUid == _clerkUid) return;
    _clerkUid = clerkUid;
    if (!_ready) return;
    try {
      await Posthog().alias(alias: clerkUid);
    } catch (_) {
      // the clerk_uid property still joins them
    }
  }

  static Future<void> capture(String event, [Map<String, Object>? properties]) async {
    if (!_ready) return;
    try {
      await Posthog().capture(eventName: event, properties: _base(_scrubErrorProps(properties)));
    } catch (_) {
      // best effort
    }
  }

  /// Mandatory `screen_viewed` event: call on every route change.
  static Future<void> screenViewed(String screen, {String? from}) {
    currentScreen = screen;
    return capture('screen_viewed', {if (from != null) 'from': from});
  }

  /// Central `api_error` event, emitted by the API client, never per screen.
  /// A `404 not_enabled` is NOT reported by the client: it is a normal flag-off state.
  static Future<void> apiError({
    required String endpoint,
    required int status,
    String? code,
    int? ms,
  }) =>
      capture('api_error', {
        'endpoint': endpoint,
        'status': status,
        if (code != null) 'code': code,
        if (ms != null) 'ms': ms,
        if (ms != null) 'latency_ms': ms,
      });

  /// Report an exception to PostHog Error Tracking. [handled] is for a failure the app recovered from.
  static Future<void> captureException(
    Object error,
    StackTrace? stack, {
    String? screen,
    bool handled = false,
    Map<String, Object>? extra,
  }) async {
    if (!_ready) return;
    try {
      final type = error.runtimeType.toString();
      final value = scrub(error.toString());
      await Posthog().capture(eventName: '\$exception', properties: _base({
        '\$exception_list': [
          {
            'type': type,
            'value': value,
            'mechanism': {'handled': handled, 'synthetic': false},
            if (stack != null)
              'stacktrace': {
                'type': 'raw',
                'frames': [
                  {'platform': 'dart', 'raw': scrub(stack.toString())},
                ],
              },
          },
        ],
        '\$exception_message': value,
        '\$exception_type': type,
        if (screen != null) 'screen': screen,
        '\$exception_level': handled ? 'error' : 'fatal',
        'is_fatal': !handled,
        ...?extra,
      }));
    } catch (_) {
      // best effort
    }
  }

  /// Clear the identity on sign-out so the next person starts anonymous.
  static Future<void> reset() async {
    final prev = _accountId;
    _accountId = null;
    _email = null;
    _phone = null;
    _clerkUid = null;
    if (prev != null && prev.isNotEmpty) {
      try {
        await _store?.delete(_phoneKey(prev));
        await _store?.delete(_emailKey(prev));
      } catch (_) {
        // best effort
      }
    }
    if (!_ready) return;
    try {
      await Posthog().reset();
    } catch (_) {
      // best effort
    }
  }

  static Future<void> _persist(String key, String value) async {
    try {
      await _store?.write(key, value);
    } catch (_) {
      // best effort
    }
  }

  static Future<String?> _load(String key) async {
    try {
      return await _store?.read(key);
    } catch (_) {
      return null;
    }
  }

  /// Any String value under an `error`-style key is scrubbed, so a call site that passes a raw
  /// exception string is still protected.
  static Map<String, Object>? _scrubErrorProps(Map<String, Object>? p) {
    if (p == null || p.isEmpty) return p;
    Map<String, Object>? out;
    for (final entry in p.entries) {
      final k = entry.key.toLowerCase();
      final v = entry.value;
      final isErrorKey = k == 'error' || k == 'err' || k.endsWith('_error') || k.endsWith('_err');
      if (isErrorKey && v is String) {
        (out ??= Map<String, Object>.of(p))[entry.key] = scrub(v);
      }
    }
    return out ?? p;
  }

  /// Remove anything that looks like a secret from error text: query strings of URLs (signed URLs are
  /// bearer credentials) and long token-like runs. Capped at 500 characters.
  static String scrub(String s) {
    var out = s.replaceAllMapped(
      RegExp(r'(https?://[^\s?#]+)\?[^\s]*', caseSensitive: false),
      (m) => '${m.group(1)}?[redacted]',
    );
    out = out.replaceAll(RegExp(r'[A-Za-z0-9_\-]{40,}'), '[redacted]');
    return out.length > 500 ? out.substring(0, 500) : out;
  }
}

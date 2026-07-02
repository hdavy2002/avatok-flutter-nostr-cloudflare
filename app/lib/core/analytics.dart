import 'dart:io' show Platform;

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:posthog_flutter/posthog_flutter.dart';

import 'ava_log.dart';
import 'feature_flags.dart';

/// Central client-side analytics for AvaTOK → PostHog (EU region, project 139917).
///
/// Everything here is best-effort: a telemetry failure must never throw into the
/// app or block a user action. The client identifies the person by their uid
/// (device identity); the Worker (`worker/src/hooks.ts`) stamps events with the
/// Clerk user id (`user_…`). Those are DIFFERENT distinct_ids, so client and
/// server events used to land on separate people. We bridge them two ways once
/// the Clerk uid is known: [aliasClerk] links the two distinct_ids in PostHog,
/// and every event also carries it as a `clerk_uid` property so the timelines
/// can be joined even before the alias propagates.
///
/// Email + phone are now the human-facing account ids, so — by product decision —
/// they ride on EVERY event (and as person properties) once known: this is what
/// lets support pull a specific user's errors / slow loads / log lines by their
/// phone or email in PostHog. We still NEVER send the private key or raw DOB, and
/// all free-text error messages are scrubbed of tokens/secrets via [_scrub].
class Analytics {
  static const _apiKey = 'phc_hmYMsHQEYjQU4bYXNdqA4VZVsfHEIkBQdQL0Kv7FIc5';
  static const _host = 'https://eu.i.posthog.com'; // EU ingestion — must match project region
  static const appVersion = '0.1.17+18'; // keep in sync with pubspec version
  // Git commit SHA stamped at build time (CI: --dart-define=GIT_SHA=<sha>);
  // 'dev' for local/unstamped builds. Sent on every event as `release` so PostHog
  // ties errors/metrics to the exact commit — CI also posts a matching annotation.
  static const release = String.fromEnvironment('GIT_SHA', defaultValue: 'dev');

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
  /// Human-facing ids — attached to every event + as person properties so a
  /// user's telemetry is retrievable by phone/email. Set via [identify]/[setUserKeys].
  static String? _email;
  static String? _phone;
  /// The Clerk user id (`user_…`) the Worker stamps server-side. Set via
  /// [aliasClerk] so client + server events can be joined by `clerk_uid`.
  static String? _clerkUid;
  static int _seq = 0; // session_seq — monotonic per app session
  static String _net = 'unknown'; // wifi|cell|offline
  /// P13: true when the last-known transport is cellular (for latency dashboards).
  static bool get isCellular => _net == 'cell';

  /// The email currently attached to telemetry ('' / null = not yet known).
  static String? get currentEmail => _email;

  // Email is persisted per-account so it survives app restarts and is reloaded
  // at identify() time — this is what guarantees a user's errors carry their
  // email EVEN when Clerk's currentUser() momentarily returns null on a session
  // (the symptom behind "the 502 had no email"). Keyed by uid so a shared phone
  // never leaks one account's email onto another's events.
  static const FlutterSecureStorage _sec = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  static String _emailKey(String uid) => 'ph_email_$uid';

  static Future<void> _persistEmail(String? uid, String email) async {
    if (uid == null || uid.isEmpty) return;
    try { await _sec.write(key: _emailKey(uid), value: email); } catch (_) {}
  }

  static Future<String?> _loadEmail(String uid) async {
    try { return await _sec.read(key: _emailKey(uid)); } catch (_) { return null; }
  }

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

  // ── In-chat health signals (ANALYTICS-OBSERVABILITY) ───────────────────────
  // Rich, queryable signals for issues a user hits INSIDE the chat interface, so
  // support can pull them by email/phone (auto-stamped via [_base]). These add
  // product context on top of the generic api_error: which app, and why it broke.

  /// The Clerk session lapsed and an authed call 401'd (e.g. after a backgrounded
  /// app-connect OAuth round-trip). This is the signal that precedes a blank
  /// thread — emitted once per cooldown by the HTTP wrapper, not per failed call.
  static Future<void> authSessionLost({required String endpoint}) =>
      capture('auth_session_lost', {'endpoint': endpoint});

  /// A connected-apps / Composio call (status, catalog, run) failed — the chat
  /// couldn't reach the user's Google apps (Drive/Gmail/Calendar/…).
  static Future<void> appsUnavailable(
          {required String endpoint, String? slug, int? status, String? code}) =>
      capture('apps_unavailable', {
        'endpoint': endpoint,
        if (slug != null) 'slug': slug,
        if (status != null) 'status': status,
        if (code != null) 'code': code,
      });

  /// A GenUI/A2UI surface arrived but rendered to nothing (missing root or no
  /// components) — the "blank card" case behind a blank-looking Ava reply.
  static Future<void> genuiBlankSurface(
          {String? tool, required String reason, int nodes = 0}) =>
      capture('genui_blank_surface', {
        if (tool != null) 'tool': tool,
        'reason': reason,
        'nodes': nodes,
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
      // SDK), keyed to the person via identify(uid). No manual upload, no
      // app-owned DB. Pull a user's logs by resolving their email -> uid.
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

  /// Device-configured region (e.g. 'US', 'IN') parsed from the OS locale. This
  /// is the user's SET country; PostHog also adds the NETWORK country server-side
  /// via GeoIP ($geoip_country_*). Having both lets support answer "country of
  /// use" even for VPN/roaming users. Best-effort — '' when unknown.
  static String get _deviceCountry {
    try {
      final loc = Platform.localeName; // e.g. en_US, en_IN.UTF-8
      final m = RegExp(r'[_-]([A-Za-z]{2})').firstMatch(loc);
      return m != null ? m.group(1)!.toUpperCase() : '';
    } catch (_) {
      return '';
    }
  }

  static Map<String, Object> _base([Map<String, Object>? p]) => {
        'platform': _platform,
        'app_version': appVersion,
        'release': release, // git commit SHA → filter errors/metrics by deploy
        'service_name': 'avatok-app',
        // Envelope (§1) — present on every event; explicit props win on clash.
        'app': app,
        if (currentScreen != null) 'screen': currentScreen!,
        if (_accountId != null) 'account_id': _accountId!,
        'account_kind': accountKind,
        // Human-facing ids on every event so support can pull a user's telemetry
        // (errors, slow loads, log lines) by their phone or email.
        if (_email != null) 'email': _email!,
        if (_phone != null) 'phone': _phone!,
        // Clerk uid (the Worker's distinct_id) on every event so client + server
        // timelines join even before the PostHog alias propagates.
        if (_clerkUid != null) 'clerk_uid': _clerkUid!,
        'build': kAppBuild,
        'env': kAvatokEnv,
        'net': _net,
        if (_deviceCountry.isNotEmpty) 'device_country': _deviceCountry,
        'session_seq': ++_seq,
        ...?p,
      };

  /// Attach all subsequent events to this person (call when the uid exists).
  /// Pass [email]/[phone] when known so they become person properties + ride
  /// every event; if not yet known, call [setUserKeys] later.
  static Future<void> identify(String uid,
      {Map<String, Object>? properties, String? email, String? phone}) async {
    _accountId = uid;
    if (email != null && email.isNotEmpty) {
      _email = email;
      await _persistEmail(uid, email);
    } else if (_email == null || _email!.isEmpty) {
      // No email passed (e.g. the app-open identify before Clerk responds) —
      // reload the last-known email for this account so events carry it now.
      final saved = await _loadEmail(uid);
      if (saved != null && saved.isNotEmpty) _email = saved;
    }
    if (phone != null && phone.isNotEmpty) _phone = phone;
    final k = properties?['account_kind'];
    if (k is String && k.isNotEmpty) accountKind = k;
    if (!_ready) return;
    try {
      await Posthog().identify(userId: uid, userProperties: _base(properties));
    } catch (_) {}
  }

  /// Attach (or update) the user's email/phone once known — re-identifies so they
  /// land as person properties and start riding every subsequent event. No-op if
  /// nothing changed or we don't yet have a distinct_id.
  static Future<void> setUserKeys({String? email, String? phone}) async {
    var changed = false;
    if (email != null && email.isNotEmpty && email != _email) {
      _email = email; changed = true;
      await _persistEmail(_accountId, email);
    }
    if (phone != null && phone.isNotEmpty && phone != _phone) { _phone = phone; changed = true; }
    if (!changed || !_ready || _accountId == null) return;
    try {
      await Posthog().identify(userId: _accountId!, userProperties: _base());
    } catch (_) {}
  }

  /// Link this person's uid distinct_id to their Clerk uid (`user_…`) so the
  /// client (identified by uid) and the Worker (which stamps the Clerk uid) land
  /// on ONE person in PostHog — closing the cross-stack debugging gap. Also keeps
  /// [_clerkUid] so it rides every subsequent event as a `clerk_uid` property.
  /// Idempotent and best-effort: no-op when unchanged or analytics isn't ready.
  static Future<void> aliasClerk(String clerkUid) async {
    if (clerkUid.isEmpty || clerkUid == _clerkUid) return;
    _clerkUid = clerkUid;
    if (!_ready) return;
    try {
      await Posthog().alias(alias: clerkUid);
    } catch (_) {/* alias is best-effort; the clerk_uid property still joins them */}
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
    final prev = _accountId;
    _accountId = null;
    accountKind = 'personal';
    _email = null;
    _phone = null;
    _clerkUid = null;
    if (prev != null && prev.isNotEmpty) {
      try { await _sec.delete(key: _emailKey(prev)); } catch (_) {}
    }
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

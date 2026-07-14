import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../identity/identity.dart';
import 'analytics.dart';
import 'net/ava_dns.dart';

/// Central authenticated-HTTP helper for the `/api/*` Worker contract.
///
/// Auth is the Clerk session JWT (Bearer): the Worker verifies it and derives the
/// uid from the verified token, never from the request body (see worker
/// authz.requireUser). Nostr/NIP-98 request signing has been removed — every
/// route authenticates via Clerk.
class ApiAuth {
  /// Current signed-in identity (uid-scoped). Set on login/onboarding, cleared on sign-out.
  static Identity? identity;

  /// Optional provider of a Clerk session JWT (RS256, verifiable via JWKS).
  static Future<String?> Function()? clerkBearer;

  /// Optional repair hook, invoked (at most once per [_authRepairCooldown]) when
  /// an authed request comes back 401 — wired in main to refresh the Clerk
  /// session so the NEXT call carries a valid Bearer instead of 401-storming.
  static Future<void> Function()? onAuthExpired;
  static DateTime _lastAuthRepair = DateTime.fromMillisecondsSinceEpoch(0);
  static const Duration _authRepairCooldown = Duration(seconds: 10);

  /// [AVA-AUTH-401] A repair is an authenticated round-trip to Clerk FAPI. Left
  /// ungoverned it becomes the very storm it is meant to fix: repairs stack, FAPI
  /// rate-limits us, mints fail, more 401s arrive, more repairs fire. These two
  /// hold the line — one repair at a time, and an escalating gap when it isn't
  /// helping. [_consecutiveAuthFailures] resets the moment any authed call succeeds.
  static bool _repairInFlight = false;
  static int _consecutiveAuthFailures = 0;
  static const Duration _authRepairCooldownMax = Duration(seconds: 60);

  /// [AVA-IDGATE-1] Invoked (at most once per [_identityPromptCooldown]) when a
  /// PUBLIC action comes back `403 {error:'identity_required', action:...}`. Wired
  /// in main.dart to open the consent + Didit liveness flow, so a gated action pops
  /// the camera flow instead of failing silently. The `action` string is the server's
  /// PublicAction (post/listing/live/dm_stranger/group_*/forward). The original
  /// request is NOT auto-retried here; the message outbox retries on its own, and
  /// other call sites re-issue after the user verifies.
  static void Function(String action)? onIdentityRequired;
  static DateTime _lastIdentityPrompt = DateTime.fromMillisecondsSinceEpoch(0);
  static const Duration _identityPromptCooldown = Duration(seconds: 3);

  static Future<Map<String, String>> _headers(
      String method, String url, {List<int>? body, Map<String, String>? base}) async {
    final h = <String, String>{...?base};
    // Observability: a trace id propagated through every layer. [TRACE-ID-1]
    // prefers, in order: an explicit X-Trace-Id / x-trace-id the caller put in
    // `base` (an ACTION-scoped id that stitches call/message journeys across
    // devices + server), then the current in-flight action trace, then a fresh
    // per-request id. This keeps the header additive + backward compatible.
    final explicit = h['X-Trace-Id'] ?? h['x-trace-id'];
    h.remove('x-trace-id');
    h['X-Trace-Id'] = explicit ?? Analytics.currentTraceId ?? _traceId();
    try {
      final b = await clerkBearer?.call();
      if (b != null && b.isNotEmpty) {
        h['Authorization'] = 'Bearer $b';
      } else if (clerkBearer != null) {
        // [AVA-AUTH-401] A null/empty bearer means this request is about to go out
        // unauthenticated and WILL come back 401. That was previously invisible: we
        // saw the resulting auth_session_lost but never that the token was simply
        // absent, so the 401 loop looked like a server problem. Name it at source.
        _bearerMissing(url, 'empty');
      }
    } catch (e) {
      // Clerk is optional, so we still send the request — but an exception here is
      // NOT benign: it strips auth and guarantees the 401. Never swallow it silently.
      _bearerMissing(url, e.runtimeType.toString());
    }
    return h;
  }

  static void _bearerMissing(String url, String reason) {
    try {
      Analytics.capture('auth_bearer_missing', {
        'endpoint': Uri.parse(url).path,
        'reason': reason,
      });
    } catch (_) {/* telemetry must never break an outbound request */}
  }

  /// Public signed headers for a manual request (e.g. an SSE streaming POST that
  /// reads the response stream itself). Same NIP-98 + Clerk signing as the rest.
  static Future<Map<String, String>> signedHeaders(String method, String url,
          {List<int>? body, Map<String, String>? extra}) =>
      _headers(method, url,
          body: body, base: {'Content-Type': 'application/json', ...?extra});

  static String _traceId() {
    final r = Random.secure();
    String h(int n) => List<int>.generate(n, (_) => r.nextInt(256)).map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    return '${h(4)}-${h(2)}-${h(2)}-${h(2)}-${h(6)}'; // uuid-ish, enough for tracing
  }

  /// Central api_error capture (ANALYTICS-OBSERVABILITY §2): every authed HTTP
  /// call reports failures here — screens never capture api_error themselves.
  static Future<http.Response> _tracked(String url, Future<http.Response> Function() run) async {
    final t0 = DateTime.now();
    final uri = Uri.parse(url);
    try {
      final res = await run();
      // [AVA-AUTH-401] Auth is demonstrably working again — clear the escalating
      // repair backoff so a later, unrelated 401 gets a prompt first repair.
      if (res.statusCode < 400) _consecutiveAuthFailures = 0;
      if (res.statusCode >= 400) {
        // Carry host + a short body snippet + content-type so api_error can tell
        // an EDGE rejection (Cloudflare, non-JSON body) from a genuine WORKER 400
        // (JSON) — the exact blind spot that hid the 2026-07-04 sign-in outage.
        String? snippet;
        try { snippet = res.body; } catch (_) {/* bytes/stream body — skip */}
        Analytics.apiError(
          endpoint: uri.path,
          status: res.statusCode,
          latencyMs: DateTime.now().difference(t0).inMilliseconds,
          host: uri.host,
          body: snippet,
          contentType: res.headers['content-type'],
        );
        if (res.statusCode == 401) _onUnauthorized(uri.path);
        // [AVA-IDGATE-1] A gated public action → open the liveness/consent flow.
        if (res.statusCode == 403 && snippet != null && snippet.contains('identity_required')) {
          String action = 'post';
          try {
            final j = jsonDecode(snippet);
            if (j is Map && j['action'] is String) action = j['action'] as String;
          } catch (_) { /* body wasn't the expected JSON; default action */ }
          _onIdentityRequired(action, uri.path);
        }
      }
      return res;
    } catch (e) {
      Analytics.apiError(
        endpoint: uri.path,
        status: 0,
        code: e.runtimeType.toString(),
        latencyMs: DateTime.now().difference(t0).inMilliseconds,
        host: uri.host,
      );
      // A transport failure (status 0) is often carrier DNS ("Failed host
      // lookup" on Jio). Fire a one-off DNS health probe so the real cause is
      // queryable instead of hiding behind a generic ClientException.
      // ignore: unawaited_futures
      AvaDns.I.probe(uri.host);
      rethrow;
    }
  }

  /// Coordinated, rate-limited reaction to a 401: emit a rich `auth_session_lost`
  /// signal AND trigger a single session refresh. The cooldown stops a screenful
  /// of concurrent authed calls (e.g. the chat thread's read/poll loop) from each
  /// firing a repair + signal — which is exactly what produced the 401 storm that
  /// blanked the thread after an app-connect OAuth round-trip.
  static void _onUnauthorized(String endpoint) {
    final now = DateTime.now();
    if (now.difference(_lastAuthRepair) < _currentAuthCooldown()) return;
    // A repair already running will refresh the session for everyone; a second one
    // only adds FAPI load. Concurrent 401s from a screenful of calls must collapse
    // into ONE repair, not one each.
    if (_repairInFlight) return;
    _lastAuthRepair = now;
    _consecutiveAuthFailures++;
    Analytics.authSessionLost(
        endpoint: endpoint, attempt: _consecutiveAuthFailures);
    final hook = onAuthExpired;
    if (hook == null) return;
    _repairInFlight = true;
    unawaited(Future(() async {
      try {
        await hook();
      } catch (_) {/* repair is best-effort — a failure just means the next 401 retries */}
    }).whenComplete(() => _repairInFlight = false));
  }

  /// Escalating gap between repairs: 10s → 20s → 40s → 60s (cap). A repair that
  /// isn't working must not be retried at the same rate indefinitely — each attempt
  /// re-mints against Clerk FAPI, and that storm is what earns the rate limiting
  /// that produces still more 401s. Reset by any successful authed response.
  static Duration _currentAuthCooldown() {
    if (_consecutiveAuthFailures <= 1) return _authRepairCooldown;
    final secs = _authRepairCooldown.inSeconds * (1 << min(_consecutiveAuthFailures - 1, 3));
    return Duration(seconds: min(secs, _authRepairCooldownMax.inSeconds));
  }

  /// [AVA-IDGATE-1] Coordinated, rate-limited reaction to a 403 identity_required.
  /// The cooldown stops a burst of gated calls (e.g. the outbox retrying a queued
  /// message every few seconds) from stacking multiple consent screens.
  static void _onIdentityRequired(String action, String endpoint) {
    final now = DateTime.now();
    if (now.difference(_lastIdentityPrompt) < _identityPromptCooldown) return;
    _lastIdentityPrompt = now;
    // Rich telemetry so we can see, per action, how often the gate is hit at the
    // client and whether the consent flow is actually being launched.
    Analytics.capture('identity_gate_intercepted', {'action': action, 'endpoint': endpoint});
    final hook = onIdentityRequired;
    if (hook != null) {
      hook(action);
    } else {
      // Should never happen once main.dart wires the hook — but if it does, we want
      // to know, because it means a gated action failed with no path forward.
      Analytics.capture('identity_gate_no_handler', {'action': action, 'endpoint': endpoint});
    }
  }

  /// Signed POST with a JSON body.
  /// Signed JSON POST with extra headers (e.g. Idempotency-Key on money routes).
  static Future<http.Response> postJsonH(String url, Object jsonBody, Map<String, String> extraHeaders,
      {Duration timeout = const Duration(seconds: 20)}) async {
    final bodyStr = jsonEncode(jsonBody);
    final bytes = utf8.encode(bodyStr);
    final headers = await _headers('POST', url,
        body: bytes, base: {'Content-Type': 'application/json', ...extraHeaders});
    return _tracked(url, () => http.post(Uri.parse(url), headers: headers, body: bodyStr).timeout(timeout));
  }

  static Future<http.Response> postJson(String url, Object jsonBody,
      {Duration timeout = const Duration(seconds: 8)}) async {
    final bodyStr = jsonEncode(jsonBody);
    final bytes = utf8.encode(bodyStr);
    final headers = await _headers('POST', url, body: bytes, base: {'Content-Type': 'application/json'});
    return _tracked(url, () => http.post(Uri.parse(url), headers: headers, body: bodyStr).timeout(timeout));
  }

  /// Signed POST with a raw byte body (media uploads).
  static Future<http.Response> postBytes(String url, List<int> bytes,
      {Map<String, String>? extraHeaders, Duration timeout = const Duration(seconds: 60)}) async {
    final headers = await _headers('POST', url, body: bytes, base: extraHeaders);
    return _tracked(url, () => http.post(Uri.parse(url), headers: headers, body: Uint8List.fromList(bytes)).timeout(timeout));
  }

  /// Signed PUT with a raw byte body (e.g. the Liveness V3 worker-proxy upload
  /// fallback, which is `requireUser`-authed on the Worker).
  static Future<http.Response> putBytes(String url, List<int> bytes,
      {Map<String, String>? extraHeaders, Duration timeout = const Duration(seconds: 60)}) async {
    final headers = await _headers('PUT', url, body: bytes, base: extraHeaders);
    return _tracked(url, () => http.put(Uri.parse(url), headers: headers, body: Uint8List.fromList(bytes)).timeout(timeout));
  }

  /// Signed GET (for authed reads like /api/library).
  static Future<http.Response> getSigned(String url,
      {Duration timeout = const Duration(seconds: 8)}) async {
    final headers = await _headers('GET', url);
    return _tracked(url, () => http.get(Uri.parse(url), headers: headers).timeout(timeout));
  }

  /// Signed PUT with a JSON body (e.g. agent persona, OLX listing edit).
  static Future<http.Response> putJson(String url, Object jsonBody,
      {Duration timeout = const Duration(seconds: 12)}) async {
    final bodyStr = jsonEncode(jsonBody);
    final bytes = utf8.encode(bodyStr);
    final headers = await _headers('PUT', url, body: bytes, base: {'Content-Type': 'application/json'});
    return _tracked(url, () => http.put(Uri.parse(url), headers: headers, body: bodyStr).timeout(timeout));
  }

  /// Signed DELETE.
  static Future<http.Response> deleteSigned(String url,
      {Duration timeout = const Duration(seconds: 8)}) async {
    final headers = await _headers('DELETE', url);
    return _tracked(url, () => http.delete(Uri.parse(url), headers: headers).timeout(timeout));
  }

  /// Signed DELETE with a JSON body (some routes, e.g. /api/agent/services,
  /// identify the row to delete via the body rather than a path/query param).
  static Future<http.Response> deleteJson(String url, Object jsonBody,
      {Duration timeout = const Duration(seconds: 8)}) async {
    final bodyStr = jsonEncode(jsonBody);
    final bytes = utf8.encode(bodyStr);
    final headers = await _headers('DELETE', url, body: bytes, base: {'Content-Type': 'application/json'});
    return _tracked(url, () => http.delete(Uri.parse(url), headers: headers, body: bodyStr).timeout(timeout));
  }

  /// Signed GET that returns raw bytes (e.g. agent TTS audio stream).
  static Future<http.Response> getBytes(String url,
      {Duration timeout = const Duration(seconds: 30)}) async {
    final headers = await _headers('GET', url);
    return _tracked(url, () => http.get(Uri.parse(url), headers: headers).timeout(timeout));
  }

}

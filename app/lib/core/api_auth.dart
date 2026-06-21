import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:bip340/bip340.dart' as bip340;
import 'package:http/http.dart' as http;
import 'package:pointycastle/export.dart';

import '../identity/identity.dart';
import 'analytics.dart';

/// Central authenticated-HTTP helper for the hardened `/api/*` Worker contract.
///
/// Every mutation carries a NIP-98 (kind-27235) signed event in the
/// `X-Nostr-Auth` header — base64(JSON(event)) — proving the caller owns the
/// npub. The Worker derives identity from this signature, never from the body,
/// so clients can only act as themselves. A Clerk session JWT is attached as a
/// Bearer token when [clerkBearer] is wired (Worker verifies it only when
/// CLERK_JWKS_URL is set; until then NIP-98 alone gates).
class ApiAuth {
  /// Current signed-in Nostr identity. Set on login/onboarding, cleared on sign-out.
  static Identity? identity;

  /// Optional provider of a Clerk session JWT (RS256, verifiable via JWKS).
  static Future<String?> Function()? clerkBearer;

  /// Optional repair hook, invoked (at most once per [_authRepairCooldown]) when
  /// an authed request comes back 401 — wired in main to refresh the Clerk
  /// session so the NEXT call carries a valid Bearer instead of 401-storming.
  static Future<void> Function()? onAuthExpired;
  static DateTime _lastAuthRepair = DateTime.fromMillisecondsSinceEpoch(0);
  static const Duration _authRepairCooldown = Duration(seconds: 10);

  /// Build the `X-Nostr-Auth` value: base64 of a signed kind-27235 event with
  /// `u` (url), `method`, and optional `payload` (sha256 of the body) tags.
  static String? nip98(String method, String url, {List<int>? body}) {
    final id = identity;
    if (id == null) return null;
    final tags = <List<String>>[
      ['u', url],
      ['method', method.toUpperCase()],
    ];
    if (body != null && body.isNotEmpty) tags.add(['payload', _sha256Hex(body)]);
    final ts = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final eventId = _eventId(id.pubHex, ts, 27235, tags, '');
    final sig = bip340.sign(id.privHex, eventId, _randomHex(32));
    final event = <String, dynamic>{
      'id': eventId, 'pubkey': id.pubHex, 'created_at': ts, 'kind': 27235,
      'tags': tags, 'content': '', 'sig': sig,
    };
    return base64.encode(utf8.encode(jsonEncode(event)));
  }

  static Future<Map<String, String>> _headers(
      String method, String url, {List<int>? body, Map<String, String>? base}) async {
    final h = <String, String>{...?base};
    final n = nip98(method, url, body: body);
    if (n != null) h['X-Nostr-Auth'] = n;
    // Observability: a trace id per request, propagated through every layer.
    h['X-Trace-Id'] = _traceId();
    try {
      final b = await clerkBearer?.call();
      if (b != null && b.isNotEmpty) h['Authorization'] = 'Bearer $b';
    } catch (_) {/* Clerk optional */}
    return h;
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
    try {
      final res = await run();
      if (res.statusCode >= 400) {
        Analytics.apiError(
          endpoint: Uri.parse(url).path,
          status: res.statusCode,
          latencyMs: DateTime.now().difference(t0).inMilliseconds,
        );
        if (res.statusCode == 401) _onUnauthorized(Uri.parse(url).path);
      }
      return res;
    } catch (e) {
      Analytics.apiError(
        endpoint: Uri.parse(url).path,
        status: 0,
        code: e.runtimeType.toString(),
        latencyMs: DateTime.now().difference(t0).inMilliseconds,
      );
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
    if (now.difference(_lastAuthRepair) < _authRepairCooldown) return;
    _lastAuthRepair = now;
    Analytics.authSessionLost(endpoint: endpoint);
    final hook = onAuthExpired;
    if (hook != null) {
      // ignore: unawaited_futures
      hook();
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

  /// Signed GET that returns raw bytes (e.g. agent TTS audio stream).
  static Future<http.Response> getBytes(String url,
      {Duration timeout = const Duration(seconds: 30)}) async {
    final headers = await _headers('GET', url);
    return _tracked(url, () => http.get(Uri.parse(url), headers: headers).timeout(timeout));
  }

  // ---- internals ----
  static String _sha256Hex(List<int> data) {
    final d = SHA256Digest().process(Uint8List.fromList(data));
    return d.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }

  static String _eventId(String pub, int ts, int kind, List<List<String>> tags, String content) {
    final serial = jsonEncode([0, pub, ts, kind, tags, content]);
    return _sha256Hex(utf8.encode(serial));
  }

  static String _randomHex(int n) {
    final r = Random.secure();
    return List<int>.generate(n, (_) => r.nextInt(256)).map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }
}

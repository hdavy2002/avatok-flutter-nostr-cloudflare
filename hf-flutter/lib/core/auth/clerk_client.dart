import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import '../analytics/analytics.dart';
import '../api/api_client.dart';
import '../brand.dart';
import '../storage/secure_store.dart';

/// What the rest of the app needs from Clerk. Features depend on this, so tests inject a fake and
/// never reach the network.
abstract interface class ClerkApi implements AuthTokens {
  /// Redeem a WhatsApp sign-in ticket (see Specs/HF-NATIVE-AUTH.md): a real Clerk session on this device.
  Future<ClerkStep> signInWithTicket(String ticket);

  /// The active session's user, or null when signed out.
  Future<ClerkUser?> currentUser();

  /// Sign out of every session on this device and forget the client token.
  Future<void> signOut();

  /// Force a fresh JWT mint (call on app resume, after the dialer or a browser trip).
  Future<void> warmSession();
}

/// Minimal Clerk Frontend API (FAPI) client, native mode. Trimmed from the avaTOK app's
/// auth/clerk_client.dart: email code, Google, password and deleteAccount are gone; the ticket
/// redeem is its own method, [signInWithTicket].
///
/// FAPI host: base64-decoded from the publishable key (Brand.clerkPublishableKey).
/// The client token is the long-lived credential of the signed-in device: it arrives in the
/// `authorization` response header, is stored in secure storage under `clerk_client_token` and sent
/// back on every call. The Worker never sees it: it verifies the short-lived session JWT minted by
/// [sessionToken].
class ClerkClient implements ClerkApi {
  static const _jsVersion = '4.70.0';
  static const _apiVersion = '2025-11-10';
  static const _tokenKey = 'clerk_client_token';

  ClerkClient({KeyValueStore? store, http.Client? httpClient, String? publishableKey})
      : _storage = store ?? SecureKeyValueStore(),
        _http = httpClient ?? http.Client(),
        _domain = deriveDomain(publishableKey ?? Brand.clerkPublishableKey);

  final KeyValueStore _storage;
  final http.Client _http;
  final String _domain;

  String? _clientToken;
  String? _sessionJwt;
  int _sessionJwtSoftExpiry = 0; // epoch s: refresh proactively after this
  int _sessionJwtHardExpiry = 0; // epoch s: the token is genuinely valid until this

  // Session-mint state. sessionToken() runs on EVERY authed request, so anything unguarded here
  // multiplies by the number of in-flight calls: single-flight, a cached session id, a failure backoff.
  String? _sessionId;
  Future<String?>? _mintInFlight;
  int _mintBackoffUntil = 0;
  int _mintFailures = 0;

  /// `clerk.<domain>`, from the publishable key.
  static String deriveDomain(String key) {
    final part = key.substring(key.lastIndexOf('_') + 1);
    final decoded = utf8.decode(base64.decode(base64.normalize(part)));
    return decoded.split(r'$').first;
  }

  Uri _uri(String path) => Uri(
        scheme: 'https',
        host: _domain,
        path: 'v1$path',
        queryParameters: {'_is_native': 'true', '_clerk_js_version': _jsVersion},
      );

  Map<String, String> _headers({bool get = false}) => {
        'Accept': 'application/json',
        'Accept-Language': 'en',
        'Content-Type': get ? 'application/json' : 'application/x-www-form-urlencoded',
        if (_clientToken != null) 'Authorization': _clientToken!,
        'clerk-api-version': _apiVersion,
        'x-mobile': '1',
      };

  void _capture(http.Response r) {
    final auth = r.headers['authorization'];
    if (auth != null && auth.isNotEmpty) {
      _clientToken = auth;
      // Fire and forget; a secure-storage write error must never escape into the auth path.
      unawaited(_storage.write(_tokenKey, auth).catchError((Object _) {}));
    }
  }

  Future<void> _loadToken() async {
    if (_clientToken != null) return;
    try {
      _clientToken = await _storage.read(_tokenKey);
    } catch (e) {
      // Unreadable store (the secure store already heals BadPadding on read): continue signed out.
      _sx('secure_storage_reset', reason: 'read_failed');
      try {
        await _storage.deleteAll();
      } catch (_) {
        // best effort wipe
      }
      _clientToken = null;
    }
  }

  Future<Map<String, dynamic>> _send(String path, {bool get = false, Map<String, String>? body}) async {
    await _loadToken();
    final uri = _uri(path);
    // 8 s cap on every FAPI round trip: a stalled connection used to hang the shell gate and the JWT mint.
    const timeout = Duration(seconds: 8);
    final http.Response r;
    try {
      r = get
          ? await _http.get(uri, headers: _headers(get: true)).timeout(timeout)
          : await (body == null
              ? _http.delete(uri, headers: _headers()).timeout(timeout)
              : _http.post(uri, headers: _headers(), body: body).timeout(timeout));
    } on TimeoutException {
      _sx('fapi_timeout', reason: path);
      rethrow;
    }
    _capture(r);
    try {
      final decoded = jsonDecode(r.body);
      return decoded is Map<String, dynamic> ? decoded : {'_status': r.statusCode};
    } catch (_) {
      return {'_status': r.statusCode};
    }
  }

  /// Redeem a Clerk sign-in ticket (`strategy=ticket`): create the device client, sign in, confirm a
  /// session is active. On success the next [sessionToken] mints the Bearer for the Worker.
  @override
  Future<ClerkStep> signInWithTicket(String ticket) async {
    final sw = Stopwatch()..start();
    _sx('ticket_redeem_started');
    final cleaned = ticket.trim();
    if (cleaned.isEmpty) {
      _sx('ticket_redeem_failed', reason: 'empty_ticket');
      return ClerkStep.error('We could not finish signing you in. Please try again.');
    }
    try {
      _resetSessionState(keepClientToken: false);
      await _send('/client', body: {});
      final body = await _send('/client/sign_ins', body: {'strategy': 'ticket', 'ticket': cleaned});
      final user = await currentUser();
      if (user != null) {
        _sx('ticket_redeem_completed', ms: sw.elapsedMilliseconds);
        return ClerkStep.complete(user);
      }
      final err = _firstError(body);
      _sx('ticket_redeem_failed', reason: 'no_session', detail: err, ms: sw.elapsedMilliseconds);
      return ClerkStep.error(err ?? 'We could not finish signing you in. Please try again.');
    } on TimeoutException {
      return ClerkStep.error('That took too long. Please try again.');
    } catch (e) {
      _sx('ticket_redeem_failed', reason: e.runtimeType.toString(), ms: sw.elapsedMilliseconds);
      return ClerkStep.error('We could not finish signing you in. Please check your connection and try again.');
    }
  }

  /// Active session's user, or null if signed out.
  @override
  Future<ClerkUser?> currentUser() async {
    await _loadToken();
    if (_clientToken == null) return null;
    final body = await _send('/client', get: true);
    final client = body['response'];
    final user = _activeUser(client is Map<String, dynamic> ? client : null);
    if (user != null) {
      // Cache the session id so the first mint skips a second /client round trip.
      _sessionId ??= _activeSessionId(client as Map<String, dynamic>);
    }
    return user;
  }

  /// Mint a short-lived Clerk SESSION JWT (RS256, about 60 s) for the active session. This is what the
  /// Worker verifies against Clerk's JWKS, not the client token. Null when signed out or unavailable, so
  /// the API client simply omits the Bearer header.
  ///
  /// NEVER throws: an exception here would silently drop the Authorization header and cause a 401 loop.
  /// Resilient on a flaky network: a cached JWT is served until its true (hard) expiry.
  @override
  Future<String?> sessionToken({bool forceRefresh = false}) async {
    try {
      await _loadToken();
      if (_clientToken == null) return null;
      if (forceRefresh) {
        _sessionJwtSoftExpiry = 0;
        _mintBackoffUntil = 0;
      }
      final now = _nowS();
      if (_sessionJwt != null && now < _sessionJwtSoftExpiry) return _sessionJwt;
      if (now < _mintBackoffUntil && _sessionJwt != null && now < _sessionJwtHardExpiry) {
        return _sessionJwt;
      }
      final minted = await _mintOnce();
      if (minted != null) return minted;
      if (_sessionJwt != null && now < _sessionJwtHardExpiry && !forceRefresh) return _sessionJwt;
      return null;
    } catch (e) {
      _sx('jwt_guard_tripped', reason: e.runtimeType.toString());
      final now = _nowS();
      if (_sessionJwt != null && now < _sessionJwtHardExpiry && !forceRefresh) return _sessionJwt;
      return null;
    }
  }

  @override
  Future<void> warmSession() async {
    _sessionJwtSoftExpiry = 0;
    _mintBackoffUntil = 0;
    _mintFailures = 0;
    try {
      await sessionToken();
    } catch (_) {
      // best effort warm-up
    }
  }

  /// Single flight: every concurrent caller awaits ONE in-flight mint.
  Future<String?> _mintOnce() {
    final inFlight = _mintInFlight;
    if (inFlight != null) return inFlight;
    final f = _mintSessionJwt().whenComplete(() {
      _mintInFlight = null;
    });
    _mintInFlight = f;
    return f;
  }

  Future<String?> _mintSessionJwt() async {
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        final sid = await _resolveSessionId(force: attempt > 0);
        if (sid == null) break; // signed out or /client unreadable: no point retrying
        final body = await _send('/client/sessions/$sid/tokens', body: {});
        final resp = body['response'];
        final jwt = (body['jwt'] ?? (resp is Map<String, dynamic> ? resp['jwt'] : null))?.toString();
        if (jwt != null && jwt.isNotEmpty) {
          _adoptJwt(jwt);
          _mintFailures = 0;
          _mintBackoffUntil = 0;
          return jwt;
        }
        _sessionId = null; // rotated or stale session id: re-resolve on the retry
      } catch (e) {
        _sx('jwt_mint_failed', reason: e.runtimeType.toString());
      }
    }
    _noteMintFailure();
    return null;
  }

  void _noteMintFailure() {
    _mintFailures++;
    const ladder = [2, 5, 15, 30]; // seconds
    final step = ladder[min(_mintFailures - 1, ladder.length - 1)];
    _mintBackoffUntil = _nowS() + step;
  }

  /// Refresh windows come from the token's REAL `exp` claim, not an assumed 60 s life.
  void _adoptJwt(String jwt) {
    final now = _nowS();
    _sessionJwt = jwt;
    final exp = _jwtExp(jwt);
    if (exp != null && exp > now) {
      final ttl = exp - now;
      _sessionJwtHardExpiry = exp - 2; // 2 s clock-skew margin
      _sessionJwtSoftExpiry = min(now + max(5, (ttl * 3) ~/ 4), _sessionJwtHardExpiry);
    } else {
      _sessionJwtSoftExpiry = now + 45;
      _sessionJwtHardExpiry = now + 58;
    }
  }

  static int? _jwtExp(String jwt) {
    try {
      final parts = jwt.split('.');
      if (parts.length < 2) return null;
      final payload = jsonDecode(utf8.decode(base64.decode(base64.normalize(parts[1]))));
      final exp = (payload as Map<String, dynamic>)['exp'];
      return exp is int ? exp : int.tryParse(exp.toString());
    } catch (_) {
      return null;
    }
  }

  static int _nowS() => DateTime.now().millisecondsSinceEpoch ~/ 1000;

  Future<String?> _resolveSessionId({bool force = false}) async {
    if (!force && _sessionId != null) return _sessionId;
    final body = await _send('/client', get: true);
    final resp = body['response'];
    _sessionId = resp is Map<String, dynamic> ? _activeSessionId(resp) : null;
    return _sessionId;
  }

  String? _activeSessionId(Map<String, dynamic> client) {
    for (final s in (client['sessions'] as List?) ?? const []) {
      final m = s as Map<String, dynamic>;
      if (m['status'] == 'active') return m['id']?.toString();
    }
    return null;
  }

  @override
  Future<void> signOut() async {
    try {
      await _send('/client'); // DELETE /client: signs out all sessions on this device
    } catch (_) {
      // offline sign-out still clears the device below
    }
    _resetSessionState();
    await _storage.delete(_tokenKey);
  }

  /// Clear every scrap of session state. A stale session id surviving a sign-out would make the next
  /// account's first mint fail and re-enter the 401 loop.
  void _resetSessionState({bool keepClientToken = false}) {
    if (!keepClientToken) _clientToken = null;
    _sessionJwt = null;
    _sessionJwtSoftExpiry = 0;
    _sessionJwtHardExpiry = 0;
    _sessionId = null;
    _mintInFlight = null;
    _mintBackoffUntil = 0;
    _mintFailures = 0;
  }

  ClerkUser? _activeUser(Map<String, dynamic>? client) {
    if (client == null) return null;
    for (final s in (client['sessions'] as List?) ?? const []) {
      final m = s as Map<String, dynamic>;
      if (m['status'] == 'active') {
        return ClerkUser.fromJson(m['user'] as Map<String, dynamic>?);
      }
    }
    return null;
  }

  String? _firstError(Map<String, dynamic> body) {
    final errors = body['errors'];
    if (errors is! List || errors.isEmpty) return null;
    final e = errors.first;
    if (e is! Map) return null;
    return (e['long_message'] ?? e['message'] ?? 'Authentication failed').toString();
  }

  /// `signup_step` telemetry for one stage. Best effort, never throws into the auth path.
  void _sx(String step, {String? reason, String? detail, int? ms}) {
    unawaited(Analytics.capture('signup_step', {
      'provider': 'whatsapp_ticket',
      'step': step,
      if (reason != null) 'reason': reason,
      if (detail != null && detail.isNotEmpty) 'detail': detail,
      if (ms != null) 'ms': ms,
    }));
  }
}

/// A step in an auth flow: complete or an error.
class ClerkStep {
  const ClerkStep._(this.user, this.error);

  /// Set when the sign-in completed.
  final ClerkUser? user;
  final String? error;

  factory ClerkStep.complete(ClerkUser user) => ClerkStep._(user, null);
  factory ClerkStep.error(String message) => ClerkStep._(null, message);

  bool get isComplete => user != null;
}

class ClerkUser {
  const ClerkUser({required this.id, this.label = 'Account', this.firstName, this.lastName, this.imageUrl});

  /// Clerk user id (`user_...`), stable per account.
  final String id;
  final String label;
  final String? firstName;
  final String? lastName;
  final String? imageUrl;

  factory ClerkUser.fromJson(Map<String, dynamic>? u) {
    if (u == null) return const ClerkUser(id: '');
    String? clean(Object? v) {
      final s = (v ?? '').toString().trim();
      return s.isEmpty ? null : s;
    }

    final first = clean(u['first_name']);
    return ClerkUser(
      id: (u['id'] ?? '').toString(),
      label: first ?? 'Account',
      firstName: first,
      lastName: clean(u['last_name']),
      imageUrl: clean(u['image_url'] ?? u['profile_image_url']),
    );
  }
}

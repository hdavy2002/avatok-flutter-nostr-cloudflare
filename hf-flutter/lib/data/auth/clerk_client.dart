import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import '../../core/brand.dart';
import 'key_value_store.dart';

/// What the rest of the app needs from Clerk. Features depend on this so tests inject a fake.
abstract interface class ClerkApi {
  /// A valid session JWT for the Worker, or null when signed out. Never throws.
  Future<String?> sessionToken({bool forceRefresh = false});

  /// The active session's user, or null when signed out (or when there is no connection).
  Future<ClerkUser?> currentUser();

  /// Redeem a WhatsApp sign-in ticket (Specs/HF-NATIVE-AUTH.md). Stage 2 calls this.
  Future<ClerkStep> signInWithTicket(String ticket);

  /// Sign out of every session on this device and forget the client token.
  Future<void> signOut();
}

/// Minimal Clerk Frontend API (FAPI) client, native mode. Trimmed from the earlier app's
/// clerk_client.dart (email code, Google and password flows are gone).
///
/// FAPI host comes from the publishable key in the generated brand file. The client token is the
/// long-lived credential of the signed-in device: it arrives in the `authorization` response header,
/// is kept in secure storage and sent back on every call. The Worker never sees it; it verifies the
/// short-lived session JWT minted by [sessionToken].
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
  int _softExpiry = 0; // epoch s: refresh proactively after this
  int _hardExpiry = 0; // epoch s: the token is genuinely valid until this
  String? _sessionId;
  Future<String?>? _mintInFlight;
  int _backoffUntil = 0;
  int _failures = 0;

  /// `clerk.<domain>`, from the publishable key (`pk_..._<base64>$`).
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
      unawaited(_storage.write(_tokenKey, auth).catchError((Object _) {}));
    }
  }

  Future<void> _loadToken() async {
    if (_clientToken != null) return;
    try {
      _clientToken = await _storage.read(_tokenKey);
    } catch (_) {
      // Unreadable store: continue signed out and wipe it.
      try {
        await _storage.deleteAll();
      } catch (_) {}
      _clientToken = null;
    }
  }

  /// One FAPI round trip, 8 s cap. [body] null with [get] false means DELETE.
  Future<Map<String, dynamic>> _send(String path, {bool get = false, Map<String, String>? body}) async {
    await _loadToken();
    final uri = _uri(path);
    const cap = Duration(seconds: 8);
    final http.Response r;
    if (get) {
      r = await _http.get(uri, headers: _headers(get: true)).timeout(cap);
    } else if (body == null) {
      r = await _http.delete(uri, headers: _headers()).timeout(cap);
    } else {
      r = await _http.post(uri, headers: _headers(), body: body).timeout(cap);
    }
    _capture(r);
    try {
      final decoded = jsonDecode(r.body);
      return decoded is Map<String, dynamic> ? decoded : {'_status': r.statusCode};
    } catch (_) {
      return {'_status': r.statusCode};
    }
  }

  @override
  Future<ClerkStep> signInWithTicket(String ticket) async {
    final cleaned = ticket.trim();
    if (cleaned.isEmpty) return ClerkStep.error('We could not finish signing you in. Please try again.');
    try {
      _resetSessionState();
      await _send('/client', body: {});
      final body = await _send('/client/sign_ins', body: {'strategy': 'ticket', 'ticket': cleaned});
      final user = await currentUser();
      if (user != null) return ClerkStep.complete(user);
      return ClerkStep.error(_firstError(body) ?? 'We could not finish signing you in. Please try again.');
    } on TimeoutException {
      return ClerkStep.error('That took too long. Please try again.');
    } catch (_) {
      return ClerkStep.error('We could not finish signing you in. Please check your connection and try again.');
    }
  }

  @override
  Future<ClerkUser?> currentUser() async {
    await _loadToken();
    if (_clientToken == null) return null;
    final body = await _send('/client', get: true);
    final client = body['response'];
    if (client is! Map<String, dynamic>) return null;
    final user = _activeUser(client);
    if (user != null) _sessionId ??= _activeSessionId(client);
    return user;
  }

  @override
  Future<String?> sessionToken({bool forceRefresh = false}) async {
    try {
      await _loadToken();
      if (_clientToken == null) return null;
      if (forceRefresh) {
        _softExpiry = 0;
        _backoffUntil = 0;
      }
      final now = _nowS();
      if (_sessionJwt != null && now < _softExpiry) return _sessionJwt;
      if (now < _backoffUntil && _sessionJwt != null && now < _hardExpiry) return _sessionJwt;
      final minted = await _mintOnce();
      if (minted != null) return minted;
      if (_sessionJwt != null && now < _hardExpiry && !forceRefresh) return _sessionJwt;
      return null;
    } catch (_) {
      final now = _nowS();
      if (_sessionJwt != null && now < _hardExpiry && !forceRefresh) return _sessionJwt;
      return null;
    }
  }

  /// Single flight: every concurrent caller awaits ONE in-flight mint.
  Future<String?> _mintOnce() {
    final inFlight = _mintInFlight;
    if (inFlight != null) return inFlight;
    final f = _mint().whenComplete(() => _mintInFlight = null);
    _mintInFlight = f;
    return f;
  }

  Future<String?> _mint() async {
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        final sid = await _resolveSessionId(force: attempt > 0);
        if (sid == null) break; // signed out
        final body = await _send('/client/sessions/$sid/tokens', body: {});
        final resp = body['response'];
        final jwt = (body['jwt'] ?? (resp is Map<String, dynamic> ? resp['jwt'] : null))?.toString();
        if (jwt != null && jwt.isNotEmpty) {
          _adoptJwt(jwt);
          _failures = 0;
          _backoffUntil = 0;
          return jwt;
        }
        _sessionId = null; // stale session id: re-resolve on the retry
      } catch (_) {
        // offline or timeout: fall through to the backoff below
      }
    }
    _failures++;
    const ladder = [2, 5, 15, 30];
    _backoffUntil = _nowS() + ladder[min(_failures - 1, ladder.length - 1)];
    return null;
  }

  void _adoptJwt(String jwt) {
    final now = _nowS();
    _sessionJwt = jwt;
    final exp = _jwtExp(jwt);
    if (exp != null && exp > now) {
      final ttl = exp - now;
      _hardExpiry = exp - 2;
      _softExpiry = min(now + max(5, (ttl * 3) ~/ 4), _hardExpiry);
    } else {
      _softExpiry = now + 45;
      _hardExpiry = now + 58;
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
      if (s is Map && s['status'] == 'active') return s['id']?.toString();
    }
    return null;
  }

  ClerkUser? _activeUser(Map<String, dynamic> client) {
    for (final s in (client['sessions'] as List?) ?? const []) {
      if (s is Map && s['status'] == 'active') {
        final u = s['user'];
        return ClerkUser.fromJson(u is Map ? Map<String, dynamic>.from(u) : null);
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

  @override
  Future<void> signOut() async {
    try {
      await _send('/client'); // DELETE /client: signs out every session on this device
    } catch (_) {
      // offline sign-out still clears the device below
    }
    _resetSessionState();
    _clientToken = null;
    try {
      await _storage.delete(_tokenKey);
    } catch (_) {}
  }

  /// A stale session id surviving a sign-out would make the next account's first mint fail.
  void _resetSessionState() {
    _clientToken = null;
    _sessionJwt = null;
    _softExpiry = 0;
    _hardExpiry = 0;
    _sessionId = null;
    _mintInFlight = null;
    _backoffUntil = 0;
    _failures = 0;
  }
}

/// A step in an auth flow: complete or an error.
class ClerkStep {
  const ClerkStep._(this.user, this.error);

  final ClerkUser? user;
  final String? error;

  factory ClerkStep.complete(ClerkUser user) => ClerkStep._(user, null);
  factory ClerkStep.error(String message) => ClerkStep._(null, message);

  bool get isComplete => user != null;
}

class ClerkUser {
  const ClerkUser({required this.id, this.firstName, this.lastName, this.imageUrl});

  /// Clerk user id (`user_...`), stable per account.
  final String id;
  final String? firstName;
  final String? lastName;
  final String? imageUrl;

  factory ClerkUser.fromJson(Map<String, dynamic>? u) {
    if (u == null) return const ClerkUser(id: '');
    String? clean(Object? v) {
      final s = (v ?? '').toString().trim();
      return s.isEmpty ? null : s;
    }

    return ClerkUser(
      id: (u['id'] ?? '').toString(),
      firstName: clean(u['first_name']),
      lastName: clean(u['last_name']),
      imageUrl: clean(u['image_url'] ?? u['profile_image_url']),
    );
  }
}

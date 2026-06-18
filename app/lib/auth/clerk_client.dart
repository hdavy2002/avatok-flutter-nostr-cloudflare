import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:http/http.dart' as http;

import '../core/config.dart';

/// Minimal Clerk Frontend API (FAPI) client — native mode.
/// Mirrors the official clerk_auth REST flow without the (broken) UI SDK.
/// Handles password sign-in/up and falls back to email-code verification.
class ClerkClient {
  static const _jsVersion = '4.70.0';
  static const _apiVersion = '2025-11-10';

  final FlutterSecureStorage _storage;
  final String _domain;
  String? _clientToken;
  String? _sessionJwt;       // short-lived Clerk session JWT (verifiable via JWKS)
  int _sessionJwtExpiry = 0; // epoch seconds when the cached JWT should be refreshed

  ClerkClient([FlutterSecureStorage? s])
      : _storage = s ??
            const FlutterSecureStorage(mOptions: MacOsOptions(useDataProtectionKeyChain: false), 
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            ),
        _domain = _deriveDomain(kClerkPublishableKey);

  static String _deriveDomain(String key) {
    final part = key.substring(key.lastIndexOf('_') + 1);
    final decoded = utf8.decode(base64.decode(base64.normalize(part)));
    return decoded.split(r'$').first; // "clerk.avatok.ai"
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
      _storage.write(key: 'clerk_client_token', value: auth);
    }
  }

  Future<void> _loadToken() async {
    _clientToken ??= await _storage.read(key: 'clerk_client_token');
  }

  Future<Map<String, dynamic>> _send(String path,
      {bool get = false, Map<String, String>? body}) async {
    await _loadToken();
    final uri = _uri(path);
    final r = get
        ? await http.get(uri, headers: _headers(get: true))
        : await (body == null
            ? http.delete(uri, headers: _headers())
            : http.post(uri, headers: _headers(), body: body));
    _capture(r);
    try {
      return jsonDecode(r.body) as Map<String, dynamic>;
    } catch (_) {
      return {'_status': r.statusCode};
    }
  }

  /// Active session's user, or null if signed out.
  Future<ClerkUser?> currentUser() async {
    await _loadToken();
    if (_clientToken == null) return null;
    final body = await _send('/client', get: true);
    return _activeUser(body['response'] as Map<String, dynamic>?);
  }

  /// Mint a short-lived Clerk SESSION JWT (RS256, ~60 s) for the active session.
  /// This is what the Worker verifies against the JWKS endpoint — NOT the FAPI
  /// client token. Cached ~50 s. Returns null when signed out / unavailable, so
  /// the API helper simply omits the Bearer header (NIP-98 still gates).
  Future<String?> sessionToken() async {
    await _loadToken();
    if (_clientToken == null) return null;
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    if (_sessionJwt != null && now < _sessionJwtExpiry) return _sessionJwt;
    final sid = await _activeSessionId();
    if (sid == null) return null;
    // POST /v1/client/sessions/{sid}/tokens → { jwt: "<RS256 session token>" }
    final body = await _send('/client/sessions/$sid/tokens', body: {});
    final jwt = (body['jwt'] ?? (body['response'] as Map<String, dynamic>?)?['jwt'])?.toString();
    if (jwt == null || jwt.isEmpty) return null;
    _sessionJwt = jwt;
    _sessionJwtExpiry = now + 50; // refresh before the ~60 s TTL elapses
    return jwt;
  }

  Future<String?> _activeSessionId() async {
    final body = await _send('/client', get: true);
    final client = body['response'] as Map<String, dynamic>?;
    for (final s in (client?['sessions'] as List?) ?? const []) {
      final m = s as Map<String, dynamic>;
      if (m['status'] == 'active') return m['id']?.toString();
    }
    return null;
  }

  /// Sign in / up with Google via Clerk's native OAuth flow — the Google-only
  /// login path. Opens the Google consent screen in a secure in-app browser and
  /// completes the Clerk session on return.
  ///
  /// Requires: the `flutter_web_auth_2` package, a Clerk "Google" social
  /// connection enabled, and `kOAuthRedirect` allowlisted in the Clerk dashboard,
  /// plus the CallbackActivity intent-filter in AndroidManifest. NEEDS DEVICE
  /// TESTING before the old password/OTP paths are removed — see
  /// Specs/AUTH-GOOGLE-ONLY.md.
  Future<ClerkStep> signInWithGoogle() async {
    try {
      await _send('/client', body: {});
      // 1. Start an OAuth sign-in; Clerk returns the Google consent URL.
      final start = await _send('/client/sign_ins', body: {
        'strategy': 'oauth_google',
        'redirect_url': kOAuthRedirect,
      });
      var extUrl = _externalRedirectUrl(start['response'] as Map<String, dynamic>?);
      // First-time Google users have no sign-in yet → start a sign-up instead.
      if (extUrl == null) {
        final startUp = await _send('/client/sign_ups', body: {
          'strategy': 'oauth_google',
          'redirect_url': kOAuthRedirect,
        });
        extUrl = _externalRedirectUrl(startUp['response'] as Map<String, dynamic>?);
      }
      if (extUrl == null) return ClerkStep.error('Could not start Google sign-in');

      // 2. Open the consent screen; returns the callback URL carrying a nonce.
      final result = await FlutterWebAuth2.authenticate(
          url: extUrl, callbackUrlScheme: kOAuthCallbackScheme);
      final nonce = Uri.parse(result).queryParameters['rotating_token_nonce'];

      // 3. Reload the client (with the nonce when present) to pick up the session.
      await _send(
          nonce != null && nonce.isNotEmpty ? '/client?rotating_token_nonce=$nonce' : '/client',
          get: true);

      return (await currentUser()) != null
          ? ClerkStep.complete()
          : ClerkStep.error('Google sign-in did not complete');
    } catch (e) {
      return ClerkStep.error('Google sign-in failed: $e');
    }
  }

  /// Pull the external OAuth redirect URL out of a sign-in/up response.
  String? _externalRedirectUrl(Map<String, dynamic>? su) {
    if (su == null) return null;
    final ffv = su['first_factor_verification'] as Map<String, dynamic>?;
    final url1 = ffv?['external_verification_redirect_url'];
    if (url1 is String && url1.isNotEmpty) return url1;
    final verif = (su['verifications'] as Map<String, dynamic>?)?['external_account'] as Map<String, dynamic>?;
    final url2 = verif?['external_verification_redirect_url'];
    if (url2 is String && url2.isNotEmpty) return url2;
    return null;
  }

  // Password / email-code / password-reset sign-in REMOVED 2026-06-18 — login is
  // Google-only via signInWithGoogle() above. Do NOT reintroduce password auth.

  Future<void> signOut() async {
    await _send('/client'); // DELETE /client → sign out all sessions
    _clientToken = null;
    _sessionJwt = null;
    _sessionJwtExpiry = 0;
    await _storage.delete(key: 'clerk_client_token');
  }

  Future<void> deleteAccount() async {
    await _send('/me'); // DELETE /me → delete the current user
    _clientToken = null;
    _sessionJwt = null;
    _sessionJwtExpiry = 0;
    await _storage.delete(key: 'clerk_client_token');
  }

  // ---- helpers ----

  ClerkUser? _activeUser(Map<String, dynamic>? client) {
    if (client == null) return null;
    final sessions = (client['sessions'] as List?) ?? const [];
    for (final s in sessions) {
      final m = s as Map<String, dynamic>;
      if (m['status'] == 'active') {
        return ClerkUser.fromJson(m['user'] as Map<String, dynamic>?);
      }
    }
    return null;
  }

  String? _firstError(Map<String, dynamic> body) {
    final errors = body['errors'] as List?;
    if (errors == null || errors.isEmpty) return null;
    final e = errors.first as Map<String, dynamic>;
    return (e['long_message'] ?? e['message'] ?? 'Authentication failed').toString();
  }
}

/// A step in an auth flow: complete, needs an email code, or an error.
class ClerkStep {
  final bool isComplete;
  final String? kind; // 'signin' | 'signup' when a code is required
  final String? id;
  final String? error;
  ClerkStep._(this.isComplete, this.kind, this.id, this.error);
  factory ClerkStep.complete() => ClerkStep._(true, null, null, null);
  factory ClerkStep.needsCode(String kind, String id) => ClerkStep._(false, kind, id, null);
  factory ClerkStep.error(String e) => ClerkStep._(false, null, null, e);
  bool get needsCode => kind != null && id != null;
}

class ClerkUser {
  final String id; // Clerk user id (e.g. user_abc123) — stable per account
  final String label;
  final String? email;
  ClerkUser(this.label, {this.id = '', this.email});
  factory ClerkUser.fromJson(Map<String, dynamic>? u) {
    if (u == null) return ClerkUser('Account');
    final first = u['first_name'];
    final emails = u['email_addresses'] as List?;
    final email = (emails != null && emails.isNotEmpty)
        ? (emails.first as Map)['email_address']?.toString()
        : null;
    return ClerkUser((first ?? email ?? 'Account').toString(),
        id: (u['id'] ?? '').toString(), email: email);
  }
}

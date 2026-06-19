import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:google_sign_in/google_sign_in.dart';
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

  /// Sign in / up with Google — NATIVE (no browser tab). `google_sign_in` gives the
  /// on-device account picker → Google ID token; our server (`/api/auth/google`)
  /// verifies it, finds/creates the Clerk user, and returns a sign-in TICKET which
  /// we redeem here (strategy=ticket). Avoids Clerk's native One Tap (which fails
  /// with "no account to transfer") and the browser-redirect flow entirely.
  ///
  /// One-time server setup required: the app's release SHA-1 must be registered in
  /// the Firebase / Google-Cloud project (otherwise Google throws DEVELOPER_ERROR),
  /// Google must be enabled in Clerk, and `kGoogleServerClientId` must be the
  /// project's WEB OAuth client id (so the ID token's audience matches Clerk's).
  Future<ClerkStep> signInWithGoogle() async {
    try {
      final gsi = GoogleSignIn(
        serverClientId: kGoogleServerClientId,
        scopes: const ['email', 'profile'],
      );
      // Force the picker each time instead of silently reusing the last account.
      try { await gsi.signOut(); } catch (_) {/* fine */}
      final account = await gsi.signIn();
      if (account == null) return ClerkStep.error('Google sign-in was cancelled');
      final idToken = (await account.authentication).idToken;
      if (idToken == null || idToken.isEmpty) {
        return ClerkStep.error('Google did not return an ID token');
      }

      // Exchange the Google ID token for a Clerk sign-in ticket on our server
      // (it verifies the token, finds/creates the Clerk user, mints the ticket).
      final r = await http.post(
        Uri.parse(kGoogleAuthUrl),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'id_token': idToken}),
      );
      if (r.statusCode != 200) {
        String msg = 'Sign-in failed (${r.statusCode})';
        try { msg = (jsonDecode(r.body) as Map<String, dynamic>)['error']?.toString() ?? msg; } catch (_) {}
        return ClerkStep.error(msg);
      }
      final ticket = (jsonDecode(r.body) as Map<String, dynamic>)['ticket']?.toString();
      if (ticket == null || ticket.isEmpty) return ClerkStep.error('No sign-in ticket');

      // Redeem the ticket → a real Clerk session (strategy=ticket).
      await _send('/client', body: {});
      final body = await _send('/client/sign_ins', body: {'strategy': 'ticket', 'ticket': ticket});
      if (_completed(body) && await currentUser() != null) return ClerkStep.complete();
      return (await currentUser()) != null
          ? ClerkStep.complete()
          : ClerkStep.error(_firstError(body) ?? 'Google sign-in did not complete');
    } catch (e) {
      return ClerkStep.error('Google sign-in failed: $e');
    }
  }

  /// Facebook / LinkedIn sign-in. The on-device flow MIRRORS [signInWithGoogle]
  /// exactly once wired:
  ///   1. get the provider token   — Facebook: flutter_facebook_auth native SDK;
  ///      LinkedIn: OAuth redirect (flutter_web_auth_2) → authorization code.
  ///   2. POST {token/code} to our Worker (`/api/auth/<provider>`) which verifies
  ///      it, finds/creates the Clerk user and mints a sign-in TICKET.
  ///   3. redeem the ticket here (strategy=ticket) → a real Clerk session.
  ///
  /// Pending provider config (Meta/LinkedIn apps + Clerk dashboard + the Worker
  /// endpoint), so this returns a clear, non-crashing message and never blocks
  /// the build. `provider` is 'facebook' | 'linkedin'. To enable: implement steps
  /// 1–3 below and flip kSocialFacebookEnabled / kSocialLinkedInEnabled.
  Future<ClerkStep> signInWithProvider(String provider) async {
    // TODO(auth): step 1 — obtain the provider token/code on device.
    // TODO(auth): step 2 — POST it to kFacebookAuthUrl / kLinkedInAuthUrl → {ticket}.
    // TODO(auth): step 3 —
    //   await _send('/client', body: {});
    //   final body = await _send('/client/sign_ins', body: {'strategy': 'ticket', 'ticket': ticket});
    //   return (await currentUser()) != null ? ClerkStep.complete() : ClerkStep.error(...);
    final name = provider.isEmpty
        ? 'This provider'
        : '${provider[0].toUpperCase()}${provider.substring(1)}';
    return ClerkStep.error('$name sign-in is being set up. Please continue with Google for now.');
  }

  bool _completed(Map<String, dynamic> body) {
    final r = body['response'] as Map<String, dynamic>?;
    return r?['status'] == 'complete' || _activeUser(body['client']) != null;
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

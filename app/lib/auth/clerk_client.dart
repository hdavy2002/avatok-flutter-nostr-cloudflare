import 'dart:async';
import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:http/http.dart' as http;

import '../core/analytics.dart';
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
  String? _sessionJwt;            // short-lived Clerk session JWT (verifiable via JWKS)
  int _sessionJwtSoftExpiry = 0;  // epoch s: refresh proactively after this (~TTL-15s)
  int _sessionJwtHardExpiry = 0;  // epoch s: token still genuinely valid until this

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
  /// client token. Returns null when signed out / unavailable, so the API helper
  /// simply omits the Bearer header (NIP-98 still gates).
  ///
  /// Resilience (the Drive blank-screen fix): a returning-from-background flow —
  /// e.g. an app-connect OAuth round-trip in the browser — can leave the cached
  /// JWT past its SOFT refresh point while a fresh mint transiently fails (flaky
  /// network on resume). Rather than return null — which strips the Authorization
  /// header and 401-storms the chat thread into a blank screen — we keep serving
  /// the cached JWT until its true (HARD) expiry, giving up only once it is
  /// genuinely expired.
  Future<String?> sessionToken() async {
    await _loadToken();
    if (_clientToken == null) return null;
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    if (_sessionJwt != null && now < _sessionJwtSoftExpiry) return _sessionJwt;
    final minted = await _mintSessionJwt();
    if (minted != null) return minted;
    // Mint failed — serve a still-genuinely-valid cached token instead of nulling
    // auth and triggering 401s.
    if (_sessionJwt != null && now < _sessionJwtHardExpiry) return _sessionJwt;
    return null;
  }

  /// Force a fresh session-JWT mint, bypassing the soft cache. Call on app RESUME
  /// (after a backgrounded OAuth/browser round-trip) so the chat thread's authed
  /// read/poll loops resume with a valid token instead of 401-storming.
  Future<void> warmSession() async {
    _sessionJwtSoftExpiry = 0; // invalidate the soft cache so we re-mint
    try { await sessionToken(); } catch (_) {/* best-effort warm-up */}
  }

  /// One mint attempt with a single retry (network on resume is often briefly
  /// flaky). Returns the JWT and updates the soft/hard expiry, or null on failure.
  Future<String?> _mintSessionJwt() async {
    for (var attempt = 0; attempt < 2; attempt++) {
      final sid = await _activeSessionId();
      if (sid == null) return null;
      // POST /v1/client/sessions/{sid}/tokens → { jwt: "<RS256 session token>" }
      final body = await _send('/client/sessions/$sid/tokens', body: {});
      final jwt = (body['jwt'] ?? (body['response'] as Map<String, dynamic>?)?['jwt'])?.toString();
      if (jwt != null && jwt.isNotEmpty) {
        final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
        _sessionJwt = jwt;
        _sessionJwtSoftExpiry = now + 45; // refresh proactively before the ~60s TTL
        _sessionJwtHardExpiry = now + 58; // ...but keep serving until truly expired
        return jwt;
      }
    }
    return null;
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
    final sw = Stopwatch()..start();
    _sx('started');
    try {
      final gsi = GoogleSignIn(
        serverClientId: kGoogleServerClientId,
        scopes: const ['email', 'profile'],
      );
      // Force the picker each time instead of silently reusing the last account.
      try { await gsi.signOut(); } catch (_) {/* fine */}
      final account = await gsi.signIn();
      if (account == null) {
        _sx('google_cancelled', reason: 'user_cancelled', ms: sw.elapsedMilliseconds);
        return ClerkStep.error('Google sign-in was cancelled');
      }
      final idToken = (await account.authentication).idToken;
      if (idToken == null || idToken.isEmpty) {
        _sx('no_id_token', reason: 'google_no_id_token', ms: sw.elapsedMilliseconds);
        return ClerkStep.error('Google did not return an ID token');
      }
      _sx('google_token_ok', ms: sw.elapsedMilliseconds);

      // Exchange the Google ID token for a Clerk sign-in ticket on our server
      // (it verifies the token, finds/creates the Clerk user, mints the ticket).
      final r = await http.post(
        Uri.parse(kGoogleAuthUrl),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'id_token': idToken}),
      );
      if (r.statusCode != 200) {
        String msg = 'Sign-in failed (${r.statusCode})';
        String? detail;
        try {
          final m = jsonDecode(r.body) as Map<String, dynamic>;
          msg = m['error']?.toString() ?? msg;
          // `detail` carries Clerk's real reason behind "could not create account".
          detail = [m['error'], m['detail']].where((x) => x != null).join(' · ');
        } catch (_) {}
        _sx('exchange_failed',
            reason: 'server_${r.statusCode}',
            status: r.statusCode,
            detail: (detail == null || detail.isEmpty) ? msg : detail,
            ms: sw.elapsedMilliseconds);
        return ClerkStep.error(msg);
      }
      final ticket = (jsonDecode(r.body) as Map<String, dynamic>)['ticket']?.toString();
      if (ticket == null || ticket.isEmpty) {
        _sx('no_ticket', reason: 'server_no_ticket', ms: sw.elapsedMilliseconds);
        return ClerkStep.error('No sign-in ticket');
      }
      _sx('ticket_received', ms: sw.elapsedMilliseconds);

      // Redeem the ticket → a real Clerk session (strategy=ticket).
      await _send('/client', body: {});
      final body = await _send('/client/sign_ins', body: {'strategy': 'ticket', 'ticket': ticket});
      final user = await currentUser();
      if (user != null) {
        _sx('completed', ms: sw.elapsedMilliseconds);
        // Attach this brand-new account's identity to telemetry so EVERY
        // subsequent event (and any future failure) carries their email + Clerk
        // uid — closing the "we have no eyes on this user" gap at the source.
        try {
          if (user.id.isNotEmpty) await Analytics.aliasClerk(user.id);
          if (user.email != null && user.email!.isNotEmpty) {
            await Analytics.setUserKeys(email: user.email);
          }
        } catch (_) {/* identity stamping is best-effort */}
        return ClerkStep.complete();
      }
      _sx('session_not_established',
          reason: 'ticket_redeem_no_session',
          detail: _firstError(body),
          ms: sw.elapsedMilliseconds);
      return ClerkStep.error(_firstError(body) ?? 'Google sign-in did not complete');
    } catch (e) {
      _sx('exception', reason: 'client_exception', detail: e.toString(), ms: sw.elapsedMilliseconds);
      return ClerkStep.error('Google sign-in failed: $e');
    }
  }

  /// Fire a `signup_step` telemetry event for one stage of the Google flow.
  /// Best-effort and never throws into the auth path (PostHog stamps email +
  /// clerk_uid automatically once known). Lets support trace exactly where a
  /// signup died — the client side of the server's `signup_server` events.
  void _sx(String step, {String? reason, int? status, String? detail, int? ms}) {
    unawaited(Analytics.capture('signup_step', {
      'provider': 'google',
      'step': step,
      if (reason != null) 'reason': reason,
      if (status != null) 'http_status': status,
      if (detail != null && detail.isNotEmpty) 'detail': detail,
      if (ms != null) 'duration_ms': ms,
    }));
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

  // Password / email-code / password-reset sign-in REMOVED 2026-06-18 — login is
  // Google-only via signInWithGoogle() above. Do NOT reintroduce password auth.

  Future<void> signOut() async {
    await _send('/client'); // DELETE /client → sign out all sessions
    _clientToken = null;
    _sessionJwt = null;
    _sessionJwtSoftExpiry = 0;
    _sessionJwtHardExpiry = 0;
    await _storage.delete(key: 'clerk_client_token');
  }

  Future<void> deleteAccount() async {
    await _send('/me'); // DELETE /me → delete the current user
    _clientToken = null;
    _sessionJwt = null;
    _sessionJwtSoftExpiry = 0;
    _sessionJwtHardExpiry = 0;
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

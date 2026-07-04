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
      // Fire-and-forget; never let a secure-storage write error escape into the
      // auth path (see _loadToken for the corruption case).
      unawaited(_storage
          .write(key: 'clerk_client_token', value: auth)
          .catchError((_) {/* best-effort persist */}));
    }
  }

  Future<void> _loadToken() async {
    if (_clientToken != null) return;
    try {
      _clientToken = await _storage.read(key: 'clerk_client_token');
    } catch (e) {
      // Corrupted secure storage (Android Keystore key rotated, an OS backup
      // restored encrypted prefs onto a different keystore, etc.) throws
      // PlatformException(BadPaddingException / BAD_DECRYPT) on read. Previously
      // this bubbled up through signIn() and froze the "Log in" button forever.
      // Self-heal: wipe the unreadable store and continue as a fresh, signed-out
      // session so the user can log in again instead of hanging.
      _sx('secure_storage_reset',
          provider: 'storage', reason: 'read_failed', detail: e.toString());
      try {
        await _storage.deleteAll();
      } catch (_) {/* best-effort wipe */}
      _clientToken = null;
    }
  }

  Future<Map<String, dynamic>> _send(String path,
      {bool get = false, Map<String, String>? body}) async {
    await _loadToken();
    final uri = _uri(path);
    // 8s cap on every FAPI round-trip (P0-2): a stalled TCP connection used to
    // hang whatever awaited it (shell gate, JWT mint) indefinitely. Callers
    // already try/catch network errors — let the TimeoutException flow after
    // capturing telemetry so "Clerk hung" is queryable.
    const timeout = Duration(seconds: 8);
    final http.Response r;
    try {
      r = get
          ? await http.get(uri, headers: _headers(get: true)).timeout(timeout)
          : await (body == null
              ? http.delete(uri, headers: _headers()).timeout(timeout)
              : http.post(uri, headers: _headers(), body: body).timeout(timeout));
    } on TimeoutException {
      _sx('fapi_timeout', provider: 'clerk', reason: path);
      rethrow;
    }
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
      try {
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
      } on TimeoutException {
        // Each attempt now fails fast (≤8s via _send). Treat a timeout as a
        // failed mint so sessionToken() can fall back to the still-valid cached
        // JWT instead of the exception nulling auth for every in-flight call.
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
        bool bodyIsJson = false;
        try {
          final m = jsonDecode(r.body) as Map<String, dynamic>;
          bodyIsJson = true;
          msg = m['error']?.toString() ?? msg;
          // `detail` carries Clerk's real reason behind "could not create account".
          detail = [m['error'], m['detail']].where((x) => x != null).join(' · ');
        } catch (_) {}
        // Edge-vs-Worker classification (2026-07-04 blind-spot fix): our Worker
        // ALWAYS returns JSON. A non-JSON body here = Cloudflare EDGE rejected the
        // request before the Worker (SNI/TLS/WAF/0-RTT) — so surface the origin +
        // a body snippet instead of a bare "(400)".
        final origin = bodyIsJson ? 'worker' : 'edge';
        final bodySnip = r.body.isEmpty
            ? ''
            : (r.body.length > 160 ? r.body.substring(0, 160) : r.body);
        _sx('exchange_failed',
            reason: 'server_${r.statusCode}',
            status: r.statusCode,
            origin: origin,
            respContentType: r.headers['content-type'],
            bodySnippet: bodySnip,
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
  void _sx(String step,
      {String provider = 'google',
      String? reason,
      int? status,
      String? detail,
      int? ms,
      String? origin,
      String? respContentType,
      String? bodySnippet}) {
    unawaited(Analytics.capture('signup_step', {
      'provider': provider,
      'step': step,
      if (reason != null) 'reason': reason,
      if (status != null) 'http_status': status,
      if (detail != null && detail.isNotEmpty) 'detail': detail,
      if (ms != null) 'duration_ms': ms,
      if (origin != null) 'origin': origin,                 // 'edge' | 'worker'
      if (respContentType != null) 'resp_content_type': respContentType,
      if (bodySnippet != null && bodySnippet.isNotEmpty) 'body_snippet': bodySnippet,
    }));
  }

  // ── Email + password (RESTORED 2026-06-23) ────────────────────────────────
  // Email/password sign-in & sign-up with an email-code fallback + password
  // reset, alongside Google (signInWithGoogle). Facebook/LinkedIn were removed.
  // Requires "Email address" enabled as an identifier in the Clerk Dashboard
  // (the same setting Google needs). Flow uses Clerk FAPI: /client/sign_ins and
  // /client/sign_ups. Each terminal state emits provider='password' telemetry.

  /// Sign in with email + password; falls back to an emailed code if the
  /// account has no usable password factor.
  Future<ClerkStep> signIn(String email, String password) async {
    _sx('started', provider: 'password');
    await _send('/client', body: {});
    if (password.isNotEmpty) {
      final body = await _send('/client/sign_ins',
          body: {'identifier': email.trim(), 'password': password});
      final su = body['response'] as Map<String, dynamic>?;
      if (su?['status'] == 'complete' || _activeUser(body['client']) != null) {
        _sx('completed', provider: 'password');
        await _attachIdentity();
        return ClerkStep.complete();
      }
      final err = _firstError(body);
      if (err != null &&
          err.toLowerCase().contains('password') &&
          !err.toLowerCase().contains('strategy')) {
        _sx('failed', provider: 'password', reason: 'wrong_password', detail: err);
        return ClerkStep.error(err); // genuinely wrong password
      }
      // otherwise fall through to email-code
    }
    // Identifier-only sign-in → discover email_code factor → email a code.
    final body2 = await _send('/client/sign_ins', body: {'identifier': email.trim()});
    final step = await _prepareSignInEmailCode(body2['response'] as Map<String, dynamic>?);
    if (step != null) {
      _sx('needs_email_code', provider: 'password', reason: 'signin');
      return step;
    }
    final err2 = _firstError(body2) ?? 'Sign-in is not available for this account';
    _sx('failed', provider: 'password', reason: 'signin_unavailable', detail: err2);
    return ClerkStep.error(err2);
  }

  Future<ClerkStep?> _prepareSignInEmailCode(Map<String, dynamic>? su) async {
    if (su == null) return null;
    final id = su['id']?.toString();
    final factors = (su['supported_first_factors'] as List?) ?? const [];
    Map<String, dynamic>? email;
    for (final f in factors) {
      if ((f as Map)['strategy'] == 'email_code') { email = f.cast<String, dynamic>(); break; }
    }
    if (id == null || email == null) return null;
    await _send('/client/sign_ins/$id/prepare_first_factor', body: {
      'strategy': 'email_code',
      if (email['email_address_id'] != null)
        'email_address_id': email['email_address_id'].toString(),
    });
    return ClerkStep.needsCode('signin', id);
  }

  /// Sign up with email + password; returns a code step if verification needed.
  /// [firstName]/[lastName] are sent when provided — the Clerk instance requires
  /// them at sign-up (User model → "Require first and last name").
  Future<ClerkStep> signUp(String email, String password,
      {String? firstName, String? lastName}) async {
    _sx('started', provider: 'password');
    await _send('/client', body: {});
    final body = await _send('/client/sign_ups', body: {
      'email_address': email.trim(),
      'password': password,
      if (firstName != null && firstName.trim().isNotEmpty) 'first_name': firstName.trim(),
      if (lastName != null && lastName.trim().isNotEmpty) 'last_name': lastName.trim(),
    });
    final err = _firstError(body);
    if (err != null) {
      _sx('failed', provider: 'password', reason: 'signup_rejected', detail: err);
      return ClerkStep.error(err);
    }
    final su = body['response'] as Map<String, dynamic>?;
    if (su?['status'] == 'complete' || _activeUser(body['client']) != null) {
      _sx('completed', provider: 'password');
      await _attachIdentity();
      return ClerkStep.complete();
    }
    final id = su?['id']?.toString();
    if (id == null) {
      _sx('failed', provider: 'password', reason: 'signup_no_id');
      return ClerkStep.error('Sign-up could not start');
    }
    await _send('/client/sign_ups/$id/prepare_verification', body: {'strategy': 'email_code'});
    _sx('needs_email_code', provider: 'password', reason: 'signup');
    return ClerkStep.needsCode('signup', id);
  }

  /// Verify an emailed code (kind = 'signin' or 'signup'). Null on success.
  Future<String?> verifyCode(String kind, String id, String code) async {
    final path = kind == 'signup'
        ? '/client/sign_ups/$id/attempt_verification'
        : '/client/sign_ins/$id/attempt_first_factor';
    final body = await _send(path, body: {'strategy': 'email_code', 'code': code.trim()});
    final err = _firstError(body);
    if (err != null) {
      _sx('email_code_failed', provider: 'password', reason: kind, detail: err);
      return err;
    }
    final r = body['response'] as Map<String, dynamic>?;
    if (r?['status'] == 'complete' || _activeUser(body['client']) != null) {
      _sx('completed', provider: 'password', reason: 'email_code_$kind');
      await _attachIdentity();
      return null;
    }
    return 'Verification incomplete';
  }

  /// Begin a password reset: emails a reset code to [email]. Returns a
  /// needsCode('reset', id) step, or an error.
  Future<ClerkStep> startPasswordReset(String email) async {
    await _send('/client', body: {});
    final body = await _send('/client/sign_ins', body: {'identifier': email.trim()});
    final su = body['response'] as Map<String, dynamic>?;
    final id = su?['id']?.toString();
    final factors = (su?['supported_first_factors'] as List?) ?? const [];
    Map<String, dynamic>? reset;
    for (final f in factors) {
      if ((f as Map)['strategy'] == 'reset_password_email_code') { reset = f.cast<String, dynamic>(); break; }
    }
    if (id == null || reset == null) {
      return ClerkStep.error(_firstError(body) ?? 'Password reset is not available for this account');
    }
    await _send('/client/sign_ins/$id/prepare_first_factor', body: {
      'strategy': 'reset_password_email_code',
      if (reset['email_address_id'] != null) 'email_address_id': reset['email_address_id'].toString(),
    });
    return ClerkStep.needsCode('reset', id);
  }

  /// Complete a password reset with the emailed [code] + a [newPassword].
  /// Null on success (the user is signed in), else an error message.
  Future<String?> resetPassword(String id, String code, String newPassword) async {
    final body = await _send('/client/sign_ins/$id/attempt_first_factor',
        body: {'strategy': 'reset_password_email_code', 'code': code.trim(), 'password': newPassword});
    final err = _firstError(body);
    if (err != null) return err;
    final r = body['response'] as Map<String, dynamic>?;
    final status = r?['status'];
    if (status == 'complete' || status == 'needs_second_factor' || _activeUser(body['client']) != null) {
      _sx('completed', provider: 'password', reason: 'password_reset');
      await _attachIdentity();
      return null;
    }
    return 'Could not reset password';
  }

  /// Attach the signed-in account's email + Clerk uid to telemetry so every
  /// subsequent event carries them. Shared by the Google and password flows.
  Future<void> _attachIdentity() async {
    try {
      final u = await currentUser();
      if (u == null) return;
      if (u.id.isNotEmpty) await Analytics.aliasClerk(u.id);
      if (u.email != null && u.email!.isNotEmpty) await Analytics.setUserKeys(email: u.email);
    } catch (_) {/* identity stamping is best-effort */}
  }

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

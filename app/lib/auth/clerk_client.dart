import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import '../core/config.dart';

/// Minimal Clerk Frontend API (FAPI) client — native mode.
/// Mirrors the official clerk_auth REST flow without the (broken) UI SDK.
class ClerkClient {
  static const _jsVersion = '4.70.0';
  static const _apiVersion = '2025-11-10';

  final FlutterSecureStorage _storage;
  final String _domain;
  String? _clientToken;

  ClerkClient([FlutterSecureStorage? s])
      : _storage = s ??
            const FlutterSecureStorage(
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

  /// Active session's display name/email, or null if signed out.
  Future<ClerkUser?> currentUser() async {
    await _loadToken();
    if (_clientToken == null) return null;
    final body = await _send('/client', get: true);
    return _activeUser(body['response'] as Map<String, dynamic>?);
  }

  /// Email/password sign-in. Returns null on success, or an error message.
  Future<String?> signIn(String email, String password) async {
    // Ensure a client exists.
    await _send('/client', body: {});
    final body = await _send('/client/sign_ins', body: {
      'identifier': email.trim(),
      'password': password,
      'strategy': 'password',
    });
    final err = _firstError(body);
    if (err != null) return err;
    final signIn = body['response'] as Map<String, dynamic>?;
    if (signIn?['status'] == 'complete') return null;
    // Fall back: check the client for an active session.
    final client = body['client'] as Map<String, dynamic>?;
    if (_activeUser(client) != null) return null;
    return 'Sign-in could not be completed';
  }

  /// Email/password sign-up. Returns a result indicating completion or that an
  /// email verification code is required.
  Future<ClerkSignUp> signUp(String email, String password) async {
    await _send('/client', body: {});
    final body = await _send('/client/sign_ups', body: {
      'email_address': email.trim(),
      'password': password,
    });
    final err = _firstError(body);
    if (err != null) return ClerkSignUp.error(err);
    final su = body['response'] as Map<String, dynamic>?;
    if (su?['status'] == 'complete' || _activeUser(body['client']) != null) {
      return ClerkSignUp.complete();
    }
    final id = su?['id']?.toString();
    if (id == null) return ClerkSignUp.error('Sign-up could not start');
    // Ask Clerk to email a verification code.
    await _send('/client/sign_ups/$id/prepare_verification',
        body: {'strategy': 'email_code'});
    return ClerkSignUp.needsCode(id);
  }

  /// Verify the emailed code to finish sign-up. Returns null on success.
  Future<String?> verifyEmailCode(String signUpId, String code) async {
    final body = await _send('/client/sign_ups/$signUpId/attempt_verification',
        body: {'strategy': 'email_code', 'code': code.trim()});
    final err = _firstError(body);
    if (err != null) return err;
    final su = body['response'] as Map<String, dynamic>?;
    if (su?['status'] == 'complete' || _activeUser(body['client']) != null) return null;
    return 'Verification incomplete';
  }

  Future<void> signOut() async {
    await _send('/client'); // DELETE /client → sign out all sessions
    _clientToken = null;
    await _storage.delete(key: 'clerk_client_token');
  }

  // ---- helpers ----

  ClerkUser? _activeUser(Map<String, dynamic>? client) {
    if (client == null) return null;
    final sessions = (client['sessions'] as List?) ?? const [];
    for (final s in sessions) {
      final m = s as Map<String, dynamic>;
      if (m['status'] == 'active') {
        final user = m['user'] as Map<String, dynamic>?;
        return ClerkUser.fromJson(user);
      }
    }
    return null;
  }

  String? _firstError(Map<String, dynamic> body) {
    final errors = body['errors'] as List?;
    if (errors == null || errors.isEmpty) return null;
    final e = errors.first as Map<String, dynamic>;
    return (e['long_message'] ?? e['message'] ?? 'Sign-in failed').toString();
  }
}

/// Result of a sign-up attempt.
class ClerkSignUp {
  final bool isComplete;
  final String? signUpId; // set when an email code is required
  final String? error;
  ClerkSignUp._(this.isComplete, this.signUpId, this.error);
  factory ClerkSignUp.complete() => ClerkSignUp._(true, null, null);
  factory ClerkSignUp.needsCode(String id) => ClerkSignUp._(false, id, null);
  factory ClerkSignUp.error(String e) => ClerkSignUp._(false, null, e);
  bool get needsCode => signUpId != null;
}

class ClerkUser {
  final String label;
  ClerkUser(this.label);
  factory ClerkUser.fromJson(Map<String, dynamic>? u) {
    if (u == null) return ClerkUser('Account');
    final first = u['first_name'];
    final emails = u['email_addresses'] as List?;
    final email = (emails != null && emails.isNotEmpty)
        ? (emails.first as Map)['email_address']
        : null;
    return ClerkUser((first ?? email ?? 'Account').toString());
  }
}

import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
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

  /// Active session's user, or null if signed out.
  Future<ClerkUser?> currentUser() async {
    await _loadToken();
    if (_clientToken == null) return null;
    final body = await _send('/client', get: true);
    return _activeUser(body['response'] as Map<String, dynamic>?);
  }

  /// Sign in with email + password; falls back to email-code if needed.
  Future<ClerkStep> signIn(String email, String password) async {
    await _send('/client', body: {});
    if (password.isNotEmpty) {
      final body = await _send('/client/sign_ins',
          body: {'identifier': email.trim(), 'password': password});
      final su = body['response'] as Map<String, dynamic>?;
      if (su?['status'] == 'complete' || _activeUser(body['client']) != null) {
        return ClerkStep.complete();
      }
      final err = _firstError(body);
      if (err != null && err.toLowerCase().contains('password') &&
          !err.toLowerCase().contains('strategy')) {
        return ClerkStep.error(err); // genuinely wrong password
      }
      // otherwise fall through to email-code
    }
    // Identifier-only sign-in → discover email_code factor → email a code.
    final body2 = await _send('/client/sign_ins', body: {'identifier': email.trim()});
    final step = await _prepareSignInEmailCode(body2['response'] as Map<String, dynamic>?);
    if (step != null) return step;
    return ClerkStep.error(_firstError(body2) ?? 'Sign-in is not available for this account');
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
  Future<ClerkStep> signUp(String email, String password) async {
    await _send('/client', body: {});
    final body = await _send('/client/sign_ups',
        body: {'email_address': email.trim(), 'password': password});
    final err = _firstError(body);
    if (err != null) return ClerkStep.error(err);
    final su = body['response'] as Map<String, dynamic>?;
    if (su?['status'] == 'complete' || _activeUser(body['client']) != null) {
      return ClerkStep.complete();
    }
    final id = su?['id']?.toString();
    if (id == null) return ClerkStep.error('Sign-up could not start');
    await _send('/client/sign_ups/$id/prepare_verification', body: {'strategy': 'email_code'});
    return ClerkStep.needsCode('signup', id);
  }

  /// Verify an emailed code (kind = 'signin' or 'signup'). Null on success.
  Future<String?> verifyCode(String kind, String id, String code) async {
    final path = kind == 'signup'
        ? '/client/sign_ups/$id/attempt_verification'
        : '/client/sign_ins/$id/attempt_first_factor';
    final body = await _send(path, body: {'strategy': 'email_code', 'code': code.trim()});
    final err = _firstError(body);
    if (err != null) return err;
    final r = body['response'] as Map<String, dynamic>?;
    if (r?['status'] == 'complete' || _activeUser(body['client']) != null) return null;
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
      return null;
    }
    return 'Could not reset password';
  }

  Future<void> signOut() async {
    await _send('/client'); // DELETE /client → sign out all sessions
    _clientToken = null;
    await _storage.delete(key: 'clerk_client_token');
  }

  Future<void> deleteAccount() async {
    await _send('/me'); // DELETE /me → delete the current user
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

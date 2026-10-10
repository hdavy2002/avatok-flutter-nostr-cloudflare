import 'dart:convert';

import '../strings.dart';

/// Every non-2xx answer and every network failure becomes one of these.
///
/// The worker answers errors as `{error, message, field?, ...extra}`: `error` is a stable code,
/// `message` is simple English meant for the person, `field` names a form field, and everything
/// else (`retry_after_s`, `attempts_left`, `lane`, `needed`, `resetsAt`, ...) lands in [extra].
/// Show [userMessage]; branch on [code], never on the text.
class ApiError implements Exception {
  const ApiError({
    required this.status,
    required this.code,
    this.message,
    this.field,
    this.extra = const <String, Object?>{},
    this.fromEdge = false,
  });

  /// HTTP status, or 0 when there was no answer (network, timeout).
  final int status;

  /// Stable machine code (`low_balance`, `not_enabled`, `network`, `timeout`, `bad_response`, `http_502`, ...).
  final String code;

  /// The worker's own plain-English message, when it sent one.
  final String? message;

  /// Form field the error belongs to (`code`, `phone`, ...), when the worker named one.
  final String? field;

  /// Every other key of the error body.
  final Map<String, Object?> extra;

  /// True when the body was not JSON: Cloudflare's edge answered, not our worker.
  final bool fromEdge;

  static const String codeNetwork = 'network';
  static const String codeTimeout = 'timeout';
  static const String codeBadResponse = 'bad_response';
  static const String codeNotEnabled = 'not_enabled';
  static const String codeUnauthorized = 'unauthorized';

  factory ApiError.network() => const ApiError(status: 0, code: codeNetwork);

  factory ApiError.timeout() => const ApiError(status: 0, code: codeTimeout);

  factory ApiError.badResponse(int status) => ApiError(status: status, code: codeBadResponse);

  /// Maps a response to an error. [body] is the raw response text.
  factory ApiError.fromResponse(int status, String body) {
    Object? decoded;
    try {
      decoded = body.trim().isEmpty ? null : jsonDecode(body);
    } catch (_) {
      decoded = null;
    }
    if (decoded is Map) {
      final map = Map<String, Object?>.from(decoded);
      var code = '';
      String? message;
      final rawError = map['error'];
      if (rawError is String) {
        code = rawError;
      } else if (rawError is Map) {
        // Tolerate {error: {code, message}}.
        code = (rawError['code'] ?? '').toString();
        message = rawError['message']?.toString();
      }
      message ??= map['message'] is String ? map['message'] as String : null;
      final field = map['field'] is String ? map['field'] as String : null;
      final extra = Map<String, Object?>.of(map)
        ..remove('error')
        ..remove('message')
        ..remove('field');
      if (code.isEmpty) code = status == 401 ? codeUnauthorized : 'http_$status';
      return ApiError(
        status: status,
        code: code,
        message: (message == null || message.trim().isEmpty) ? null : message.trim(),
        field: field,
        extra: extra,
      );
    }
    return ApiError(
      status: status,
      code: status == 401 ? codeUnauthorized : 'http_$status',
      fromEdge: true,
    );
  }

  bool get isNetwork => code == codeNetwork;
  bool get isTimeout => code == codeTimeout;

  /// No answer at all: the phone is offline, the connection dropped or the server was too slow.
  bool get isOffline => isNetwork || isTimeout;

  /// A feature flag is off. A normal state, shown as a calm "Coming soon" panel, never an error.
  bool get isNotEnabled => status == 404 && code == codeNotEnabled;

  bool get isUnauthorized => status == 401;
  bool get isRateLimited => status == 429;

  /// Seconds to wait before retrying, from `retry_after_s` or `resend_after_s`, when sent.
  int? get retryAfterSeconds {
    final v = extra['retry_after_s'] ?? extra['resend_after_s'];
    if (v is num) return v.ceil();
    return null;
  }

  /// What to show the person: the worker's message when there is one, else a per-code fallback.
  String get userMessage {
    final m = message;
    if (m != null && m.isNotEmpty) return m;
    return fallbackMessageFor(code, status);
  }

  /// Per-code fallbacks in simple English. Unknown codes fall back by status.
  static String fallbackMessageFor(String code, int status) {
    final byCode = _fallbacks[code];
    if (byCode != null) return byCode;
    if (status == 401) return Strings.signInAgain;
    if (status == 404) return Strings.notAvailable;
    if (status == 429) return 'Too many tries. Please wait a moment and try again.';
    if (status >= 500) return Strings.somethingWrong;
    return Strings.somethingWrong;
  }

  static const Map<String, String> _fallbacks = <String, String>{
    codeNetwork: Strings.noInternet,
    codeTimeout: Strings.timedOut,
    codeBadResponse: Strings.somethingWrong,
    codeNotEnabled: Strings.comingSoonBody,
    codeUnauthorized: Strings.signInAgain,
    'rate_limited': 'Too many tries. Please wait a moment and try again.',
    'host_unavailable': "This host isn't available right now.",
    'host_declined': "This host isn't available right now.",
    'blocked': "This host isn't available right now.",
    'not_found': Strings.notAvailable,
    'invalid_phone': 'Please enter a valid 10-digit mobile number.',
    'not_on_whatsapp': 'This number is not on WhatsApp. Please use a WhatsApp number.',
    'otp_unavailable': 'We could not send the code right now. Please try again soon.',
    'invalid_code': 'That code is not right. Please check and try again.',
    'wrong_code': 'That code is not right. Please check and try again.',
    'no_code': 'Please enter the code we sent you.',
    'code_expired': 'That code has expired. Please ask for a new one.',
    'too_many_attempts': 'Too many wrong tries. Please ask for a new code.',
    'low_balance': 'Your balance is too low for this call. Please add tokens.',
    'debt_open': 'Please clear what you owe first. Your next purchase clears it.',
    'spend_limit': 'You have reached your spending limit for now.',
    'lane_required': 'Please verify to enter this space.',
    'not_verified': 'Please sign in again with your WhatsApp number.',
    'account_closing': 'This account is being closed.',
    'call_in_progress': 'You already have a call in progress.',
    'call_failed': 'The call could not start. Please try again.',
    'calls_not_ready': 'Calls are not ready right now. Please try again soon.',
    'wallet_busy': 'Please try again in a moment.',
    'locked': 'This is locked while we check your profile.',
    'too_large': 'That file is too large.',
    'invalid_field': 'Please check this field.',
  };

  @override
  String toString() => 'ApiError($status $code${message == null ? '' : ': $message'})';
}

import 'dart:convert';

/// Why a call failed. Screens branch on this, never on message text.
enum ApiFailure {
  /// No answer at all: no network, a dropped connection or a timeout.
  offline,

  /// The server answered with a non-2xx status.
  http,

  /// The server answered 2xx but the body was not what we expected.
  parse,
}

/// The one error type the data layer throws.
///
/// The worker answers errors as `{error, message, field?, ...extra}`; `error` is a stable [code] and
/// `message` is plain English meant for the person.
class ApiException implements Exception {
  const ApiException({
    required this.kind,
    this.status = 0,
    this.code = '',
    this.message,
    this.extra = const <String, Object?>{},
  });

  final ApiFailure kind;

  /// HTTP status, or 0 when there was no answer.
  final int status;

  /// Stable machine code (`low_balance`, `not_enabled`, `network`, `timeout`, `bad_response`, `http_502`...).
  final String code;

  /// The worker's own plain-English message, when it sent one.
  final String? message;

  /// Every other key of the error body (`retry_after_s`, `attempts_left`...).
  final Map<String, Object?> extra;

  /// Shown whenever the phone has no connection. Exact text is a product rule.
  static const String offlineText = 'No internet. Check your connection.';
  static const String genericText = 'Something went wrong. Please try again.';

  factory ApiException.offline({bool timeout = false}) =>
      ApiException(kind: ApiFailure.offline, code: timeout ? 'timeout' : 'network');

  factory ApiException.parse(int status) =>
      ApiException(kind: ApiFailure.parse, status: status, code: 'bad_response');

  /// Maps a non-2xx response ([body] is the raw text) to an error.
  factory ApiException.fromResponse(int status, String body) {
    Object? decoded;
    try {
      decoded = body.trim().isEmpty ? null : jsonDecode(body);
    } catch (_) {
      decoded = null;
    }
    var code = status == 401 ? 'unauthorized' : 'http_$status';
    String? message;
    var extra = const <String, Object?>{};
    if (decoded is Map) {
      final map = Map<String, Object?>.from(decoded);
      final rawError = map['error'];
      if (rawError is String && rawError.isNotEmpty) code = rawError;
      final rawMessage = map['message'];
      if (rawMessage is String && rawMessage.trim().isNotEmpty) message = rawMessage.trim();
      extra = Map<String, Object?>.of(map)
        ..remove('error')
        ..remove('message');
    }
    return ApiException(kind: ApiFailure.http, status: status, code: code, message: message, extra: extra);
  }

  bool get isOffline => kind == ApiFailure.offline;
  bool get isUnauthorized => status == 401;

  /// A feature flag is off: a normal state, not a failure to report.
  bool get isNotEnabled => status == 404 && code == 'not_enabled';

  int? get retryAfterSeconds {
    final v = extra['retry_after_s'] ?? extra['resend_after_s'];
    return v is num ? v.ceil() : null;
  }

  /// What to show the person.
  String get userMessage {
    if (isOffline) return offlineText;
    final m = message;
    if (m != null && m.isNotEmpty) return m;
    return genericText;
  }

  /// [HF-WIRE-20] Heading for a failure panel: says WHICH kind of failure it was (offline, signed out, server side) instead of one
  /// "That did not work" for everything.
  String get failureTitle {
    if (isOffline) return code == 'timeout' ? 'Slow connection' : 'You are offline';
    if (isUnauthorized) return 'Please sign in again';
    if (kind == ApiFailure.parse) return 'Unexpected reply';
    if (status >= 500) return 'Our server had a problem';
    if (status == 429) return 'Too many tries';
    if (status == 404 && !isNotEnabled) return 'Not available right now';
    return 'That did not work';
  }

  /// [HF-WIRE-20] Body of a failure panel, to match [failureTitle].
  String get failureMessage {
    if (isOffline) return code == 'timeout' ? 'The server took too long to answer. Check your connection and try again.' : offlineText;
    if (isUnauthorized) return 'Your sign-in has ended. Sign in again to continue.';
    if (kind == ApiFailure.parse) return 'The app got a reply it could not read. Update the app, then try again.';
    final own = _specificMessage;
    if (status >= 500) return own ?? 'This is a problem on our side, not yours. Please try again in a moment.';
    if (status == 429) return own ?? 'Please wait a few seconds, then try again.';
    if (status == 404 && !isNotEnabled) return own ?? 'This part is not responding yet. Please try again in a little while.';
    return userMessage;
  }

  /// The worker's own sentence when it says something useful; the stock "Something went wrong." / "Not found." lines say nothing.
  String? get _specificMessage {
    final m = message?.trim();
    if (m == null || m.isEmpty) return null;
    final lower = m.toLowerCase();
    if (lower.startsWith('something went wrong') || lower == 'not found.' || lower == 'not found') return null;
    return m;
  }

  /// [HF-WIRE-20] Worth one automatic second try (a dropped connection or a server hiccup), never a refusal such as 4xx.
  bool get isTransient => isOffline || kind == ApiFailure.parse || status >= 500;

  @override
  String toString() => 'ApiException(${kind.name} $status $code${message == null ? '' : ': $message'})';
}

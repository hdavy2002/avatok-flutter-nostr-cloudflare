import 'package:flutter/services.dart';

import '../../../core/api/api_error.dart';
import '../../../core/brand.dart';
import '../../../core/strings.dart';

/// Which request of the sign-in flow failed. Rate limits and "send a code first" answers act differently on each.
enum SignInStage { send, verify }

/// What the screen should do with a failed call, beyond showing [message].
class SignInFailure {
  const SignInFailure({
    required this.reason,
    required this.message,
    this.field,
    this.retryAfterSeconds,
    this.attemptsLeft,
    this.allowResend = false,
  });

  /// Telemetry `reason`: the stable server code (or `network`, `timeout`, `needs_email`, `ticket_redeem`, ...).
  final String reason;

  /// Simple English for the person.
  final String message;

  /// `phone` or `code`: where the message shows.
  final String? field;

  /// A wait the server asked for (30 s gap, a double-submit being finished).
  final int? retryAfterSeconds;
  final int? attemptsLeft;

  /// The code is dead (expired, or too many wrong tries): ask for a new one now, no waiting.
  final bool allowResend;
}

abstract final class AuthCopy {
  static const String invalidPhone = 'Please enter a valid 10-digit mobile number.';
  static const String notOnWhatsapp = 'This number is not on WhatsApp. Please use a number that has WhatsApp.';
  static const String sendFailed = 'We could not send the code on WhatsApp. Please try again.';
  static const String unavailable = 'WhatsApp sign-in is not available right now. Please try again soon.';
  static const String enterCode = 'Enter the 6-digit code we sent you.';
  static const String wrongCode = 'That code is not right. Please check and try again.';
  static const String sendFirst = 'That code is no longer valid. Please ask for a new one.';
  static const String codeExpired = 'That code has expired. Please ask for a new one.';
  static const String tooManyAttempts = 'Too many wrong tries. Please ask for a new code.';
  static const String verifyFailed = 'We could not check the code just now. Please try again.';
  static const String signInFailed = 'We could not sign you in just now. Please try again.';
  static const String signUpFailed = 'We could not create your account just now. Please try again.';
  static const String creating = 'Your account is being created. Please try again in a moment.';
  static const String needsEmail = 'We could not finish sign-up in the app yet. Please try again soon.';
  static const String ticketFailed = 'We could not finish signing you in. Please try again.';
  static const String rateHourly = 'Too many codes asked for. Please try again in an hour.';
  static const String tickRequired = 'Please tick the box to say you are 18 or older.';
  static const String banned =
      'This account cannot sign in. Please write to ${Brand.supportEmail} if you think this is a mistake.';

  static String waitSeconds(int s) => 'Please wait $s ${s == 1 ? 'second' : 'seconds'} before asking for another code.';
  static String triesLeft(int n) => n > 0
      ? 'That code is not right. $n ${n == 1 ? 'try' : 'tries'} left.'
      : 'That code is not right. Please ask for a new code.';
}

/// Maps every error the two WhatsApp calls can answer (worker/src/routes/whatsapp_auth.ts) to a friendly line and
/// to what the screen should do. Unknown codes fall back to the worker's own message, then to a calm default.
SignInFailure mapSignInError(ApiError e, SignInStage stage) {
  // No answer at all.
  if (e.isOffline) {
    return SignInFailure(reason: e.code, message: e.isNetwork ? Strings.noInternet : Strings.timedOut);
  }
  final server = e.message;
  final retry = e.retryAfterSeconds;
  switch (e.code) {
    case 'invalid_phone':
      return SignInFailure(reason: e.code, message: AuthCopy.invalidPhone, field: 'phone');
    case 'not_on_whatsapp':
      return SignInFailure(reason: e.code, message: AuthCopy.notOnWhatsapp, field: 'phone');
    case 'rate_limited':
      if (retry != null && retry > 0) {
        return SignInFailure(
          reason: e.code,
          message: AuthCopy.waitSeconds(retry),
          field: stage == SignInStage.send ? 'phone' : 'code',
          retryAfterSeconds: retry,
        );
      }
      return SignInFailure(
        reason: e.code,
        message: (server != null && server.isNotEmpty) ? server : AuthCopy.rateHourly,
        field: stage == SignInStage.send ? 'phone' : 'code',
      );
    case 'otp_unavailable':
      return SignInFailure(reason: e.code, message: AuthCopy.unavailable, field: 'phone');
    case 'provider_error':
      return SignInFailure(reason: e.code, message: AuthCopy.sendFailed, field: 'phone');
    case 'invalid_code':
      return SignInFailure(reason: e.code, message: AuthCopy.enterCode, field: 'code');
    case 'no_code':
      return SignInFailure(reason: e.code, message: AuthCopy.sendFirst, field: 'code', allowResend: true);
    case 'wrong_code':
      final left = e.extra['attempts_left'];
      final n = left is num ? left.toInt() : null;
      return SignInFailure(
        reason: e.code,
        message: n != null
            ? AuthCopy.triesLeft(n)
            : ((server != null && server.isNotEmpty) ? server : AuthCopy.wrongCode),
        field: 'code',
        attemptsLeft: n,
        allowResend: n == 0,
      );
    case 'code_expired':
      return SignInFailure(reason: e.code, message: AuthCopy.codeExpired, field: 'code', allowResend: true);
    case 'too_many_attempts':
      return SignInFailure(reason: e.code, message: AuthCopy.tooManyAttempts, field: 'code', allowResend: true);
    case 'verify_failed':
      return SignInFailure(reason: e.code, message: AuthCopy.verifyFailed, field: 'code');
    case 'signin_failed':
      return SignInFailure(reason: e.code, message: AuthCopy.signInFailed, field: 'code');
    case 'signup_failed':
      // The server gives the code back: the same code can be tried again.
      return SignInFailure(reason: e.code, message: AuthCopy.signUpFailed, field: 'code');
    case 'signup_in_progress':
      return SignInFailure(
        reason: e.code,
        message: AuthCopy.creating,
        field: 'code',
        retryAfterSeconds: retry,
      );
    case 'banned':
    case 'suspended':
    case 'account_suspended':
    case 'account_closing':
    case 'account_blocked':
      return SignInFailure(reason: e.code, message: AuthCopy.banned, field: 'code');
  }
  if (server != null && server.isNotEmpty) {
    return SignInFailure(reason: e.code, message: server, field: stage == SignInStage.send ? 'phone' : 'code');
  }
  return SignInFailure(
    reason: e.code,
    message: ApiError.fallbackMessageFor(e.code, e.status),
    field: stage == SignInStage.send ? 'phone' : 'code',
  );
}

final RegExp _indianMobile = RegExp(r'^[6-9]\d{9}$');

/// Only the 10 digits of an Indian mobile number: drops spaces, dashes, `+91`, `91` and a leading `0`, so a pasted
/// "+91 98765 43210" works. Never longer than 10 digits.
String normalizeIndianMobile(String raw) {
  var d = raw.replaceAll(RegExp(r'\D'), '');
  // Only a whole pasted number is stripped, so typing an 11th digit never rewrites the first ten.
  if (d.length >= 12 && d.startsWith('91')) d = d.substring(2);
  if (d.length == 11 && d.startsWith('0')) d = d.substring(1);
  return d.length > 10 ? d.substring(0, 10) : d;
}

/// `^[6-9]\d{9}$` (spec 2.2: the app is India only).
bool isValidIndianMobile(String digits) => _indianMobile.hasMatch(digits);

/// `+91XXXXXXXXXX`, the form the worker expects.
String toE164India(String digits) => '+91$digits';

/// Keeps only digits and understands a pasted `+91 ...` number.
class IndianMobileFormatter extends TextInputFormatter {
  const IndianMobileFormatter();

  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) {
    final digits = normalizeIndianMobile(newValue.text);
    return TextEditingValue(text: digits, selection: TextSelection.collapsed(offset: digits.length));
  }
}

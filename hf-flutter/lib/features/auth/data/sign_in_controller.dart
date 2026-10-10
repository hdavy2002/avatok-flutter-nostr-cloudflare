import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_client.dart';
import '../../../core/api/api_error.dart';
import '../../../core/auth/clerk_client.dart';
import '../../../core/strings.dart';
import 'auth_messages.dart';

enum SignInStep { number, code }

/// Telemetry sink. The default is the PostHog wrapper (a no-op until it is ready); tests pass a recorder.
typedef SignInTelemetry = void Function(String event, Map<String, Object> props);

/// Redeems the sign-in ticket: the session controller's `signInWithTicket`.
typedef RedeemTicket = Future<ClerkStep> Function(String ticket, {String? phone});

/// After a good sign-in: record the 18+ tick made on the sign-in screen and send the acceptance to the account.
typedef AfterSignIn = Future<void> Function({required bool tickedNow});

void _defaultTelemetry(String event, Map<String, Object> props) {
  Analytics.capture(event, props);
}

/// The WhatsApp sign-in flow (spec 2.2 and 2.3), as plain logic the screen listens to.
///
///  1. [sendCode]: `POST /api/auth/whatsapp/send {phone, client}` -> code step, resend timer from `resend_after_s`.
///  2. [verify]: `POST /api/auth/whatsapp/verify {phone, code, client, age_confirmed?}` -> `{status:'signed_in', ticket}`.
///  3. The ticket is redeemed through Clerk ([RedeemTicket]); then [AfterSignIn] sends the acceptance.
///
/// Every server answer is mapped to a friendly line by [mapSignInError]. Telemetry: `hf_app_signin_started`,
/// `hf_app_signin_code_sent`, `hf_app_signin_success {is_new}`, `hf_app_signin_failed {reason, step}`.
class SignInController extends ChangeNotifier {
  SignInController({
    required this.api,
    required this.redeem,
    required this.afterSignIn,
    required this.readAcked,
    SignInTelemetry? telemetry,
  }) : _telemetry = telemetry ?? _defaultTelemetry;

  final ApiClient api;
  final RedeemTicket redeem;
  final AfterSignIn afterSignIn;

  /// True when this device already holds the 18+ and safety acceptance (Welcome came first).
  final Future<bool> Function() readAcked;
  final SignInTelemetry _telemetry;

  static const int _fallbackGapSeconds = 30;

  SignInStep step = SignInStep.number;

  /// False until [init] has read the local acceptance.
  bool loaded = false;
  bool ackedBefore = false;
  bool ageTick = false;

  /// The 10 digits after +91.
  String digits = '';
  String? phoneMasked;
  bool sending = false;
  bool verifying = false;

  /// What went wrong, and where it shows (`phone` or `code`).
  String? error;
  String? errorField;

  /// A calm line that is not an error ("A code was just sent...").
  String? notice;
  int resendIn = 0;
  int? attemptsLeft;
  bool signedIn = false;

  Timer? _timer;
  bool _disposed = false;

  /// No acceptance on this device (Welcome was skipped): the number step shows the 18+ tick itself.
  bool get needsTick => loaded && !ackedBefore;

  bool get canSend => loaded && digits.length == 10 && !sending && (!needsTick || ageTick);
  bool get canResend => resendIn == 0 && !sending && !verifying;
  String get e164 => toE164India(digits);

  Future<void> init() async {
    try {
      ackedBefore = await readAcked();
    } catch (_) {
      ackedBefore = false;
    }
    loaded = true;
    _notify();
  }

  void trackStarted(String from) => _track('hf_app_signin_started', {'from': from});

  void setDigits(String value) {
    digits = normalizeIndianMobile(value);
    if (errorField == 'phone') {
      error = null;
      errorField = null;
    }
    _notify();
  }

  void setAgeTick(bool value) {
    ageTick = value;
    if (value && errorField == 'phone') {
      error = null;
      errorField = null;
    }
    _notify();
  }

  /// Back to the number step. The resend timer keeps running: the server's 30 s gap does too.
  void changeNumber() {
    step = SignInStep.number;
    error = null;
    errorField = null;
    notice = null;
    attemptsLeft = null;
    _notify();
  }

  void clearError() {
    if (error == null && notice == null) return;
    error = null;
    errorField = null;
    notice = null;
    _notify();
  }

  // ------------------------------------------------------------------ send

  Future<void> sendCode({bool resend = false}) async {
    if (sending || verifying) return;
    if (!isValidIndianMobile(digits)) {
      _setError(AuthCopy.invalidPhone, 'phone');
      return;
    }
    if (needsTick && !ageTick) {
      _setError(AuthCopy.tickRequired, 'phone');
      return;
    }
    sending = true;
    error = null;
    errorField = null;
    notice = null;
    _notify();
    final sw = Stopwatch()..start();
    try {
      final res = await api.postJson('/api/auth/whatsapp/send',
          body: {'phone': e164, 'client': 'android'}, auth: false);
      final masked = res['phone_masked'];
      phoneMasked = (masked is String && masked.isNotEmpty) ? masked : _localMask();
      final gap = res['resend_after_s'];
      _startTimer(gap is num && gap > 0 ? gap.ceil() : _fallbackGapSeconds);
      step = SignInStep.code;
      attemptsLeft = null;
      _track('hf_app_signin_code_sent', {'outcome': 'ok', 'ms': sw.elapsedMilliseconds, 'resend': resend});
    } on ApiError catch (e) {
      final f = mapSignInError(e, SignInStage.send);
      if (f.reason == 'rate_limited' && f.retryAfterSeconds != null) {
        // The 30 s gap: a code was sent moments ago and is still valid. Go to the code step and count down.
        phoneMasked ??= _localMask();
        step = SignInStep.code;
        _startTimer(f.retryAfterSeconds!);
        notice = f.message;
      } else if (resend && step == SignInStep.code) {
        error = f.message;
        errorField = 'code';
      } else {
        error = f.message;
        errorField = f.field ?? 'phone';
      }
      _track('hf_app_signin_failed', {
        'outcome': 'failed',
        'reason': f.reason,
        'status': e.status,
        'step': 'send',
        'ms': sw.elapsedMilliseconds,
      });
    } catch (_) {
      error = Strings.somethingWrong;
      errorField = (resend && step == SignInStep.code) ? 'code' : 'phone';
      _track('hf_app_signin_failed', {
        'outcome': 'failed',
        'reason': 'unexpected',
        'status': 0,
        'step': 'send',
        'ms': sw.elapsedMilliseconds,
      });
    } finally {
      sending = false;
      _notify();
    }
  }

  Future<void> resend() async {
    if (!canResend) return;
    await sendCode(resend: true);
  }

  // ---------------------------------------------------------------- verify

  /// Verify the code, redeem the ticket and finish. True when the person is signed in.
  Future<bool> verify(String code) async {
    if (verifying || sending) return false;
    final cleaned = code.replaceAll(RegExp(r'\D'), '');
    if (cleaned.length != 6) {
      _setError(AuthCopy.enterCode, 'code');
      return false;
    }
    verifying = true;
    error = null;
    errorField = null;
    notice = null;
    _notify();
    final sw = Stopwatch()..start();
    var stage = 'verify';
    try {
      final res = await api.postJson('/api/auth/whatsapp/verify', body: {
        'phone': e164,
        'code': cleaned,
        'client': 'android',
        if (ackedBefore || ageTick) 'age_confirmed': true,
      }, auth: false);
      final ticket = res['ticket'];
      if (ticket is! String || ticket.isEmpty || res['ok'] == false) {
        // `needs_email` means the number has no account and phone-only sign-up is not open yet: never the
        // email flow from here. Any other answer without a ticket is a server we cannot read.
        final needsEmail = res['status'] == 'needs_email';
        return _fail(
          reason: needsEmail ? 'needs_email' : 'bad_response',
          message: needsEmail ? AuthCopy.needsEmail : Strings.somethingWrong,
          field: 'code',
          status: 200,
          stepName: stage,
          ms: sw.elapsedMilliseconds,
        );
      }
      stage = 'ticket';
      final isNew = res['isNew'] == true;
      final clerk = await redeem(ticket, phone: e164);
      if (!clerk.isComplete) {
        return _fail(
          reason: 'ticket_redeem',
          message: _ticketMessage(clerk.error),
          field: 'code',
          status: 0,
          stepName: stage,
          ms: sw.elapsedMilliseconds,
          extra: {'clerk_error': clerk.error ?? ''},
        );
      }
      try {
        await afterSignIn(tickedNow: !ackedBefore && ageTick);
      } catch (_) {
        // The acceptance is kept on the device and retried later; it never undoes a good sign-in.
      }
      signedIn = true;
      _track('hf_app_signin_success', {'outcome': 'ok', 'is_new': isNew, 'ms': sw.elapsedMilliseconds});
      return true;
    } on ApiError catch (e) {
      final f = mapSignInError(e, SignInStage.verify);
      if (f.allowResend) _startTimer(0);
      if (f.retryAfterSeconds != null && f.reason == 'rate_limited') _startTimer(f.retryAfterSeconds!);
      attemptsLeft = f.attemptsLeft;
      return _fail(
        reason: f.reason,
        message: f.message,
        field: f.field ?? 'code',
        status: e.status,
        stepName: stage,
        ms: sw.elapsedMilliseconds,
      );
    } catch (_) {
      return _fail(
        reason: 'unexpected',
        message: Strings.somethingWrong,
        field: 'code',
        status: 0,
        stepName: stage,
        ms: sw.elapsedMilliseconds,
      );
    } finally {
      verifying = false;
      _notify();
    }
  }

  // --------------------------------------------------------------- helpers

  bool _fail({
    required String reason,
    required String message,
    required String field,
    required int status,
    required String stepName,
    required int ms,
    Map<String, Object> extra = const <String, Object>{},
  }) {
    error = message;
    errorField = field;
    _track('hf_app_signin_failed', {
      'outcome': 'failed',
      'reason': reason,
      'status': status,
      'step': stepName,
      'ms': ms,
      ...extra,
    });
    return false;
  }

  String _ticketMessage(String? clerkError) {
    final e = clerkError ?? '';
    // Clerk's own wording is shown only for the two calm network lines the Clerk client writes itself.
    if (e.startsWith('That took too long') || e.contains('check your connection')) return e;
    return AuthCopy.ticketFailed;
  }

  String _localMask() => '+91 ******${digits.length >= 4 ? digits.substring(digits.length - 4) : digits}';

  void _setError(String message, String field) {
    error = message;
    errorField = field;
    _notify();
  }

  void _startTimer(int seconds) {
    _timer?.cancel();
    _timer = null;
    resendIn = seconds < 0 ? 0 : seconds;
    if (resendIn == 0) return;
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (resendIn > 0) resendIn--;
      if (resendIn <= 0) {
        resendIn = 0;
        t.cancel();
        _timer = null;
      }
      _notify();
    });
  }

  void _track(String event, Map<String, Object> props) {
    try {
      _telemetry(event, props);
    } catch (_) {
      // telemetry never throws into sign-in
    }
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}

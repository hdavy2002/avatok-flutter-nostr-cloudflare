import '../api_client.dart';
import '../intro_store.dart';
import '../models/me.dart';
import '../api_exception.dart';
import '../auth/clerk_client.dart';
import '../telemetry.dart';

/// `POST /api/auth/whatsapp/send` answer.
class CodeSent {
  const CodeSent({this.phoneMasked, this.expiresInSeconds = 600, this.resendAfterSeconds = 30});

  final String? phoneMasked;
  final int expiresInSeconds;
  final int resendAfterSeconds;
}

/// What a successful verify + Clerk sign-in tells the sheet.
class VerifyResult {
  const VerifyResult({required this.isNew, required this.needs18Plus, this.noAccount = false});

  final bool isNew;
  final bool needs18Plus;

  /// [HF-APP-AUTH-WA-ONLY-1] The code was right but no account has this number (log-in only).
  /// Nothing was created and nobody is signed in; the screen offers "Create an account".
  final bool noAccount;
}

/// [HF-APP-AUTH-WA-ONLY-1] What a sign-up carries to the worker: the typed name and the proof
/// the email code step handed back. The account is created only when this and the WhatsApp code are both right.
class SignupDetails {
  const SignupDetails({required this.name, required this.emailProof});

  final String name;
  final String emailProof;
}

/// A plain-English failure that is not an HTTP error (Clerk step failed, sign-up not open).
class AuthFailure implements Exception {
  const AuthFailure(this.message);

  final String message;

  @override
  String toString() => 'AuthFailure($message)';
}

/// Fan sign-up with a WhatsApp code (Specs/HF-NATIVE-AUTH.md):
/// send code -> verify -> Clerk ticket sign-in -> name/email -> 18+ confirmation -> refresh /me.
class AuthRepo {
  AuthRepo({
    required ApiClient api,
    required ClerkApi clerk,
    this.onSignedIn,
    this.refreshMe,
    this.fallbackAckVersion = '2026-10-10',
  })  : _api = api,
        _clerk = clerk;

  final ApiClient _api;
  final ClerkApi _clerk;

  /// Called with the Clerk user once the ticket is redeemed.
  final void Function(ClerkUser user)? onSignedIn;

  /// Reload `/api/hf/me` (and whatever mirrors it).
  final Future<void> Function()? refreshMe;
  final String fallbackAckVersion;

  /// The India number as the worker wants it: `+91` plus ten digits. Null when [raw] is not a mobile number.
  static String? e164(String raw) {
    var d = raw.replaceAll(RegExp(r'\D'), '');
    if (d.length == 12 && d.startsWith('91')) d = d.substring(2);
    if (d.length == 11 && d.startsWith('0')) d = d.substring(1);
    if (d.length != 10 || !RegExp(r'^[6-9]').hasMatch(d)) return null;
    return '+91$d';
  }

  /// Basic shape check: something@something.tld, no spaces.
  static bool validEmail(String raw) => RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]{2,}$').hasMatch(raw.trim());

  /// Same rule as the server: 2 to 40 characters, no digits.
  static String? nameProblem(String raw) {
    final n = raw.trim().replaceAll(RegExp(r'\s+'), ' ');
    if (n.runes.length < 2) return 'Please type your name (at least 2 letters).';
    if (n.runes.length > 40) return 'Your name must be 40 letters or fewer.';
    if (RegExp(r'\d').hasMatch(n)) return "Your name can't have numbers in it.";
    return null;
  }

  Future<CodeSent> sendCode(String phone) async {
    final j = await _api.postJson('/api/auth/whatsapp/send', body: {'phone': phone, 'client': 'android'}, auth: false);
    Telemetry.event('hf_signup_code_sent');
    return CodeSent(
      phoneMasked: j['phone_masked']?.toString(),
      expiresInSeconds: (j['expires_in_s'] as num?)?.toInt() ?? 600,
      resendAfterSeconds: (j['resend_after_s'] as num?)?.toInt() ?? 30,
    );
  }

  /// [HF-APP-AUTH-WA-ONLY-1] Emails a 6-digit code (sign-up only). Throws [ApiException]
  /// (`email_taken` 409, `invalid_email`, `too_soon` / `rate_limited` 429, `send_failed` 502, offline).
  Future<CodeSent> sendEmailCode(String email) async {
    final j = await _api.postJson('/api/auth/signup/email/send', body: {'email': email.trim().toLowerCase()}, auth: false);
    Telemetry.event('hf_signup_email_code_sent');
    return CodeSent(
      expiresInSeconds: (j['expires_in_s'] as num?)?.toInt() ?? 600,
      resendAfterSeconds: (j['resend_after_s'] as num?)?.toInt() ?? 60,
    );
  }

  /// Checks the email code and returns the single-use proof the WhatsApp verify step needs.
  /// Throws [ApiException] (`wrong_code` with `attempts_left`, `code_expired` 410, `too_many_attempts` 429, offline).
  Future<String> verifyEmailCode(String email, String code) async {
    final j = await _api.postJson(
      '/api/auth/signup/email/verify',
      body: {'email': email.trim().toLowerCase(), 'code': code.replaceAll(RegExp(r'\D'), '')},
      auth: false,
    );
    final proof = j['proof']?.toString() ?? '';
    if (proof.isEmpty) throw const AuthFailure('We could not check your email code. Please try again.');
    Telemetry.event('hf_signup_email_verified');
    return proof;
  }

  /// Checks the WhatsApp code and signs this device in. Pass [signup] only on the Create account path;
  /// log-in with a number that has no account answers [VerifyResult.noAccount] and creates nothing.
  /// Throws [ApiException] (wrong/expired code, `email_taken`, `email_proof_invalid`, offline) or [AuthFailure].
  Future<VerifyResult> verifyCode(String phone, String code, {SignupDetails? signup}) async {
    final j = await _api.postJson(
      '/api/auth/whatsapp/verify',
      body: {
        'phone': phone,
        'code': code.replaceAll(RegExp(r'\D'), ''),
        'client': 'android',
        if (signup != null) 'signup': {'name': signup.name.trim(), 'email_proof': signup.emailProof},
      },
      auth: false,
    );
    if (j['status'] == 'no_account') {
      Telemetry.event('hf_login_no_account');
      return const VerifyResult(isNew: false, needs18Plus: false, noAccount: true);
    }
    final ticket = j['ticket']?.toString() ?? '';
    if (j['status'] != 'signed_in' || ticket.isEmpty) {
      throw const AuthFailure('Sign-up with WhatsApp is not open yet. Please try again soon.');
    }
    final step = await _clerk.signInWithTicket(ticket);
    final user = step.user;
    if (user == null) throw AuthFailure(step.error ?? 'We could not finish signing you in. Please try again.');
    await IntroStore.markSeen();
    onSignedIn?.call(user);
    Telemetry.event('hf_signup_verified', {'is_new': j['isNew'] == true});
    return VerifyResult(isNew: j['isNew'] == true, needs18Plus: j['needs18Plus'] == true);
  }

  /// Fresh profile after OTP: a previously created identity may still need its details.
  Future<Me> profileAfterVerification() async => Me.fromJson(await _api.getJson('/api/hf/me'));

  /// Save what the person typed. When the email switch is still off on the server the name is saved alone.
  Future<void> saveProfile({required String name, required String email}) async {
    try {
      await _api.patchJson('/api/hf/me', body: {'displayName': name.trim(), 'email': email.trim()});
    } on ApiException catch (e) {
      if (e.code != 'feature_off') rethrow;
      await _api.patchJson('/api/hf/me', body: {'displayName': name.trim()});
    }
  }

  /// "I am 18 or over" for the current terms version.
  Future<void> confirmAge() async {
    var version = fallbackAckVersion;
    try {
      final cfg = await _api.getJson('/api/config', auth: false);
      final v = cfg['hfAckVersion']?.toString() ?? '';
      if (RegExp(r'^[A-Za-z0-9._-]{1,40}$').hasMatch(v)) version = v;
    } catch (_) {
      // the fallback version is fine
    }
    await _api.postJson('/api/hf/me/ack', body: {'version': version, 'ack18': true, 'client': 'android'});
    Telemetry.event('hf_signup_age_confirmed');
  }

  /// Everything the sheet does after the code is right and the profile is saved.
  Future<void> finish() async => refreshMe?.call();
}

import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';

/// Result of a verification API call.
class VerifyApiResult {
  final bool ok;
  final int status; // HTTP status, or 0 on transport error
  final String? message; // server-provided error message, if any
  const VerifyApiResult(this.ok, this.status, [this.message]);
}

/// Client calls for identity verification that run through the Worker.
///
/// EMAIL OTP ONLY. [AVA-IDGATE-1] `isPhoneVerified()` and `confirmPhone()` were
/// removed on 2026-07-10 along with all phone verification — the Worker route
/// `/api/id/phone/confirm` now returns 410 Gone, so calling them could only fail.
///
/// Identity is established by a Didit liveness check at the first PUBLIC action.
/// See features/identity/public_action_gate.dart and
/// Specs/SPEC-2026-07-10-identity-gating.md
///
/// Backend endpoints required (see core/config.dart):
///   POST {kIdBase}/email/start   {email}        -> 200
///   POST {kIdBase}/email/verify  {email, code}  -> 200 | 400 (bad/expired code)
class VerificationApi {
  static Future<VerifyApiResult> sendEmailOtp(String email) async {
    try {
      final r = await ApiAuth.postJson(kEmailOtpStartUrl, {'email': email.trim().toLowerCase()});
      return VerifyApiResult(r.statusCode == 200, r.statusCode, _msg(r.body));
    } catch (e) {
      return VerifyApiResult(false, 0, e.toString());
    }
  }

  static Future<VerifyApiResult> verifyEmailOtp(String email, String code) async {
    try {
      final r = await ApiAuth.postJson(
          kEmailOtpVerifyUrl, {'email': email.trim().toLowerCase(), 'code': code.trim()});
      return VerifyApiResult(r.statusCode == 200, r.statusCode, _msg(r.body));
    } catch (e) {
      return VerifyApiResult(false, 0, e.toString());
    }
  }

  static String? _msg(String body) {
    try {
      final j = jsonDecode(body);
      if (j is Map && j['error'] != null) return j['error'].toString();
    } catch (_) {}
    return null;
  }
}

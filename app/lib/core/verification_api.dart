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

/// Client calls for identity verification that run through the Worker:
///   - Email OTP: backend generates a code, emails it via Brevo, verifies it.
///   - Phone:     verified client-side via Firebase Auth; we just tell the
///                backend it's confirmed so the directory can mark it.
///
/// Phone OTP itself is handled by Firebase in the verify screen — Firebase sends
/// and checks the SMS code; this class only records the confirmed number.
///
/// Backend endpoints required (see core/config.dart):
///   POST {kIdBase}/email/start   {email}        -> 200
///   POST {kIdBase}/email/verify  {email, code}  -> 200 | 400 (bad/expired code)
///   POST {kIdBase}/phone/confirm {phone}        -> 200
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

  /// Account-keyed phone status. True when THIS account already verified a phone
  /// (so a reinstall / new device can skip the OTP — no wasted SMS). Best-effort.
  static Future<bool> isPhoneVerified() async {
    try {
      final r = await ApiAuth.getSigned(kIdStatusUrl);
      if (r.statusCode != 200) return false;
      final j = jsonDecode(r.body);
      return j is Map && j['phone_verified'] == true;
    } catch (_) {
      return false;
    }
  }

  static Future<VerifyApiResult> confirmPhone(String phoneE164) async {
    try {
      final r = await ApiAuth.postJson(kPhoneConfirmUrl, {'phone': phoneE164.trim()});
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

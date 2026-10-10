import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_client.dart';
import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import 'kyc_models.dart';

/// The page the DigiLocker redirect lands on. It forwards into the app (`<scheme>://hosts/onboarding?step=aadhaar&dl=return`).
/// Worker rule: a same-site path starting with "/", at most 200 characters.
const String kDigiLockerReturnPath = '/hosts/kyc/return?app=1';

/// The worker's selfie limits (hf_host_kyc.ts): 12 MB at most, 20 KB at least.
const int kSelfieMaxBytes = 12 * 1024 * 1024;
const int kSelfieMinBytes = 20 * 1024;

/// True when the worker says "OTP cannot work for this person, use DigiLocker" (`fallback:"digilocker"`).
/// It rides on `503 otp_unavailable`, `422 otp_no_mobile`, `429 too_many` and `429 otp_attempts_exhausted`.
bool kycFallbackOf(ApiError e) => e.extra['fallback'] == 'digilocker';

/// Typed calls for the identity checks, shared by host onboarding and the lane screens.
/// Every method throws [ApiError]. The Aadhaar number is only ever an argument of [aadhaarOtp]: it is not
/// stored, logged or sent to telemetry anywhere.
class KycApi {
  const KycApi(this._api);

  final ApiClient _api;

  /// `POST /api/hosts/kyc/aadhaar/otp`.
  Future<AadhaarOtpOutcome> aadhaarOtp({required String aadhaar, required KycRole role}) async {
    final j = await _api.postJson('/api/hosts/kyc/aadhaar/otp', body: {
      'aadhaar': aadhaar,
      'consent': true,
      'role': role.wire,
    });
    if (j['already_verified'] == true) {
      return AadhaarOtpOutcome.alreadyVerified(AadhaarResult.fromJson(j, alreadyVerified: true));
    }
    final ttl = j['expires_in_s'];
    return AadhaarOtpOutcome.sent(ttl is num ? ttl.toInt() : 600);
  }

  /// `POST /api/hosts/kyc/aadhaar/verify`.
  Future<AadhaarResult> aadhaarVerify(String otp) async {
    final j = await _api.postJson('/api/hosts/kyc/aadhaar/verify', body: {'otp': otp});
    return AadhaarResult.fromJson(j);
  }

  /// `POST /api/hosts/kyc/digilocker/start`.
  Future<DigiLockerStartOutcome> digilockerStart({required KycRole role, String returnPath = kDigiLockerReturnPath}) async {
    final j = await _api.postJson('/api/hosts/kyc/digilocker/start', body: {
      'consent': true,
      'role': role.wire,
      'returnPath': returnPath,
    });
    if (j['already_verified'] == true) {
      return DigiLockerStartOutcome.alreadyVerified(AadhaarResult.fromJson(j, alreadyVerified: true));
    }
    final url = Uri.tryParse((j['url'] ?? '').toString());
    if (url == null || !url.hasScheme) throw ApiError.badResponse(200);
    return DigiLockerStartOutcome.link(url);
  }

  /// `POST /api/hosts/kyc/digilocker/complete`. HTTP 202 arrives here as a normal body with `pending: true`
  /// (the client returns 2xx bodies as they are), so [DigiLockerCompleteOutcome.pending] is not an error.
  Future<DigiLockerCompleteOutcome> digilockerComplete() async {
    final j = await _api.postJson('/api/hosts/kyc/digilocker/complete', body: const <String, Object?>{});
    if (j['pending'] == true || j['ok'] == false) {
      final m = j['message'];
      return DigiLockerCompleteOutcome.pending(m is String && m.isNotEmpty ? m : null);
    }
    return DigiLockerCompleteOutcome.done(AadhaarResult.fromJson(j, viaDigiLocker: true));
  }

  /// `POST /api/hosts/kyc/selfie/code` -> the 4-digit code to say out loud (valid 10 minutes).
  Future<String> selfieCode() async {
    final j = await _api.postJson('/api/hosts/kyc/selfie/code');
    final code = (j['code'] ?? '').toString();
    if (code.isEmpty) throw ApiError.badResponse(200);
    return code;
  }

  /// `POST /api/hosts/kyc/selfie`: the raw video, with the code in `x-selfie-code` (digits only: header values must be ASCII).
  /// Errors: `400 code_expired | code_mismatch | too_small`, `413 too_large`, `415 unsupported_type`, `429 too_many`.
  Future<void> uploadSelfie({
    required Uint8List bytes,
    required String mime,
    required String code,
    void Function(int sent, int total)? onProgress,
  }) async {
    await _api.uploadBytes(
      'POST',
      '/api/hosts/kyc/selfie',
      bytes: bytes,
      contentType: mime,
      headers: {'x-selfie-code': code},
      onProgress: onProgress,
    );
  }

  /// `POST /api/hosts/payout/verify`.
  Future<PayoutResult> payoutVerify({required String upi, required String account, required String ifsc}) async {
    final j = await _api.postJson('/api/hosts/payout/verify', body: {'upi': upi, 'account': account, 'ifsc': ifsc});
    return PayoutResult.fromJson(j);
  }

  /// `GET /api/hosts/kyc/status`.
  Future<KycStatus> status() async => KycStatus.fromJson(await _api.getJson('/api/hosts/kyc/status'));
}

final kycApiProvider = Provider<KycApi>((ref) => KycApi(ref.watch(apiClientProvider)));

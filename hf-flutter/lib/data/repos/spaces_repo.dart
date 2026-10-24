import '../api_client.dart';
import '../api_exception.dart';
import '../models/spaces.dart';

/// [HF-CREATOR-SPACES-1] Women-only and LGBTQ+ channels, from the phone.
///
/// - `GET  /api/hf/lanes/me` (customer) and `GET /api/hf/spaces/me` (creator): [laneStatus] / [creatorStatus].
/// - `POST /api/hf/spaces/creator {kind, declare?, acceptTerms?, publicTagConsent?}`: [chooseCreatorKind].
/// - `POST /api/hosts/kyc/aadhaar/otp {aadhaar, consent:true, role}` then `/verify {otp}`: [aadhaarOtp] / [aadhaarVerify].
///   Errors carry `extra['fallback'] == 'digilocker'` when the screen should offer DigiLocker.
/// - `POST /api/hf/lanes/women/join` and `/lanes/lgbtq/join {declare:true, ack18:true}`: [joinLane].
/// - `POST /api/hosts/kyc/selfie/code` -> `{code, expires_in_s}`, then raw video to `POST /api/hosts/kyc/selfie` with header
///   `x-selfie-code`: [selfieCode] / [uploadSelfie].
///
/// The full Aadhaar number only travels in the body of [aadhaarOtp]; it is never stored or logged here.
class SpacesRepo {
  const SpacesRepo(this._api);

  final ApiClient _api;

  /// A missing endpoint (older server) reads as "not verified" instead of an error.
  Future<SpaceStatus> laneStatus() async {
    try {
      return SpaceStatus.fromLanes(await _api.getJson('/api/hf/lanes/me'));
    } on ApiException catch (e) {
      if (e.isNotEnabled || e.status == 404) return SpaceStatus.empty;
      rethrow;
    }
  }

  Future<SpaceStatus> creatorStatus() async {
    try {
      return SpaceStatus.fromSpaces(await _api.getJson('/api/hf/spaces/me'));
    } on ApiException catch (e) {
      if (e.isNotEnabled || e.status == 404) return SpaceStatus.empty;
      rethrow;
    }
  }

  /// Records the creator type. Throws [ApiException] (`consent_required`, `declare_required`, `not_eligible`).
  Future<void> chooseCreatorKind(String kind, {bool declare = false, bool acceptTerms = false, bool publicTagConsent = false}) async {
    await _api.postJson('/api/hf/spaces/creator', body: {
      'kind': kind,
      if (declare) 'declare': true,
      if (acceptTerms) 'acceptTerms': true,
      if (publicTagConsent) 'publicTagConsent': true,
    });
  }

  /// Sends the Aadhaar code. Returns true when the Aadhaar was already verified (no code needed).
  Future<bool> aadhaarOtp(String aadhaar, {required String role}) async {
    final j = await _api.postJson('/api/hosts/kyc/aadhaar/otp', body: {'aadhaar': aadhaar, 'consent': true, 'role': role});
    return j['already_verified'] == true;
  }

  Future<void> aadhaarVerify(String otp) async {
    await _api.postJson('/api/hosts/kyc/aadhaar/verify', body: {'otp': otp});
  }

  Future<void> joinLane(SpaceLane lane) async {
    await _api.postJson(
      '/api/hf/lanes/${lane.name}/join',
      body: lane == SpaceLane.lgbtq ? {'declare': true, 'ack18': true} : const <String, Object?>{},
    );
  }

  Future<String> selfieCode() async {
    final j = await _api.postJson('/api/hosts/kyc/selfie/code');
    final c = j['code'];
    if (c is! String || c.isEmpty) throw ApiException.parse(200);
    return c;
  }

  Future<void> uploadSelfie(List<int> bytes, {required String code, String contentType = 'video/mp4'}) async {
    await _api.postBytes('/api/hosts/kyc/selfie', bytes, contentType: contentType, headers: {'x-selfie-code': code});
  }
}

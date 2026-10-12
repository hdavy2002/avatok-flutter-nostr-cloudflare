import '../../../core/api/api_client.dart';
import '../../../core/api/api_error.dart';

/// Identity contracts reject partial or unavailable responses. No local value can
/// stand in for verified email, username ownership, or policy acceptance.
class IdentityApi {
  const IdentityApi(this.api);
  final ApiClient api;

  static const policies = ['terms', 'privacy', 'disclaimer', 'community', 'engagement'];

  Future<RegistrationDraft> registration() async => RegistrationDraft.fromJson(
    await api.getJson('/api/hf/me/registration'));

  Future<RegistrationDraft> saveStep(String step, Map<String, Object?> fields) async => RegistrationDraft.fromJson(
    await api.patchJson('/api/hf/me/registration', body: {'step': step, ...fields}));

  Future<int> sendEmail(String email) async {
    final j = await api.postJson(
      '/api/id/email/start',
      body: {'email': email.trim(), 'client': 'android'},
    );
    if (j['ok'] != true) throw ApiError.badResponse(200);
    final seconds = j['resend_after_s'];
    return seconds is num && seconds > 0 ? seconds.ceil() : 30;
  }

  Future<void> verifyEmail(String email, String code) async {
    final j = await api.postJson(
      '/api/id/email/verify',
      body: {'email': email.trim(), 'code': code, 'client': 'android'},
    );
    if (j['ok'] != true || j['verified'] != true) throw ApiError.badResponse(200);
  }

  Future<bool> usernameAvailable(String username) async {
    final j = await api.getJson('/api/hf/me/username?value=${Uri.encodeQueryComponent(username)}');
    if (j['username'] != username || j['available'] is! bool) throw ApiError.badResponse(200);
    return j['available'] == true;
  }

  Future<void> register({required String firstName, required String lastName, required String username,
    required Map<String, String> acceptedPolicyVersions}) async {
    final j = await api.postJson('/api/hf/me/registration', body: {
      'firstName': firstName.trim(), 'lastName': lastName.trim(),
      'username': username, 'acceptedPolicies': policies,
      'acceptedPolicyVersions': acceptedPolicyVersions,
    });
    if (j['ok'] != true || j['registrationComplete'] != true || j['username'] != username) {
      throw ApiError.badResponse(200);
    }
  }
}

class RegistrationDraft {
  const RegistrationDraft({required this.uid, required this.step, required this.complete,
    required this.firstName, required this.lastName, required this.username, required this.kycNow,
    required this.policyVersions, required this.acceptedPolicyVersions, this.email, this.emailExpiresAt});
  final String uid;
  final int step;
  final bool complete;
  final String firstName, lastName, username;
  final bool? kycNow;
  final Map<String, String> policyVersions, acceptedPolicyVersions;
  final String? email;
  final int? emailExpiresAt;

  factory RegistrationDraft.fromJson(Map<String, dynamic> j) {
    final step = j['step'];
    final versions = <String, String>{};
    final accepted = <String, String>{};
    final raw = j['policies'];
    if (j['uid'] is! String || (j['uid'] as String).isEmpty || step is! int || step < 1 || step > 8 || raw is! Map) {
      throw ApiError.badResponse(200);
    }
    for (final field in ['firstName', 'lastName', 'username']) {
      if (j[field] != null && j[field] is! String) throw ApiError.badResponse(200);
    }
    if (j['kycNow'] != null && j['kycNow'] is! bool) throw ApiError.badResponse(200);
    if (j['registrationComplete'] is! bool || (step == 8) != (j['registrationComplete'] == true)) {
      throw ApiError.badResponse(200);
    }
    for (final policy in IdentityApi.policies) {
      final item = raw[policy];
      if (item is! Map || item['version'] is! String || (item['version'] as String).isEmpty) throw ApiError.badResponse(200);
      versions[policy] = item['version'] as String;
      if (j['acceptedPolicyVersions'] is Map && j['acceptedPolicyVersions'][policy] == versions[policy]) {
        accepted[policy] = versions[policy]!;
      }
    }
    final challenge = j['emailChallenge'];
    if (challenge != null && (challenge is! Map || challenge['email'] is! String || challenge['expiresAt'] is! num)) {
      throw ApiError.badResponse(200);
    }
    return RegistrationDraft(uid: j['uid'] as String, step: step, complete: j['registrationComplete'] == true,
      firstName: j['firstName'] as String? ?? '', lastName: j['lastName'] as String? ?? '',
      username: j['username'] as String? ?? '', kycNow: j['kycNow'] as bool?,
      policyVersions: versions, acceptedPolicyVersions: accepted,
      email: challenge is Map ? challenge['email'] as String? : null,
      emailExpiresAt: challenge is Map ? (challenge['expiresAt'] as num?)?.toInt() : null);
  }
}

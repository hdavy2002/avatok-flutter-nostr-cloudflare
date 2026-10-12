import '../../../core/api/api_client.dart';
import '../../../core/api/api_error.dart';

/// Identity contracts reject partial or unavailable responses. No local value can
/// stand in for verified email, username ownership, or policy acceptance.
class IdentityApi {
  const IdentityApi(this.api);
  final ApiClient api;

  static const policies = ['terms', 'privacy', 'disclaimer', 'community', 'engagement'];

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

  Future<void> register({required String firstName, required String lastName, required String username}) async {
    final j = await api.postJson('/api/hf/me/registration', body: {
      'firstName': firstName.trim(), 'lastName': lastName.trim(),
      'username': username, 'acceptedPolicies': policies,
    });
    if (j['ok'] != true || j['registrationComplete'] != true || j['username'] != username) {
      throw ApiError.badResponse(200);
    }
  }
}

import 'dart:typed_data';

import '../api_client.dart';
import '../api_exception.dart';
import '../models/intro_onboarding.dart';

/// [HF-INTRO-A1] The influencer intro-video onboarding, from the phone (Specs/HF-INTRO-VIDEO-1-API.md section 1).
///
/// - `GET  /api/hf/onboarding/categories` (no sign-in) and `GET /api/hf/onboarding/me`: [config] / [me].
/// - `POST /api/hf/onboarding/intro-video` (raw MP4 + `x-duration-ms`, `x-video-width`, `x-video-height`) and
///   `PUT .../intro-video/:id/poster` (raw JPEG): [uploadVideo] / [uploadPoster].
/// - `PUT /api/hosts/me` (name, about, rate) before submit: [saveProfile]. The photo goes through the existing `/inf/photo` screen.
/// - `PUT /api/hosts/me/call-option`: [setCallOption] (best effort; the submit body carries the choice that counts).
/// - `POST /api/hf/onboarding/submit`: [submit].
/// - `GET /api/hf/channels/facebook/start?client=app`: [facebookLoginUrl].
class IntroOnboardingRepo {
  const IntroOnboardingRepo(this._api);

  final ApiClient _api;

  Future<OnbConfig> config() async => OnbConfig.fromJson(await _api.getJson('/api/hf/onboarding/categories', auth: false));

  Future<OnbMe> me() async => OnbMe.fromJson(await _api.getJson('/api/hf/onboarding/me'));

  /// Sends the recorded video. [width] must be smaller than [height] (the server refuses a sideways video with `not_portrait`).
  /// Errors: `too_short`, `too_long`, `not_portrait`, `too_large`, `unsupported_type`, `empty_video`, `store_failed`, `invalid_field`.
  Future<OnbVideo> uploadVideo(
    Uint8List bytes, {
    required int durationMs,
    required int width,
    required int height,
    String? lang,
    String? topic,
    String contentType = 'video/mp4',
  }) async {
    final j = await _api.postBytes(
      '/api/hf/onboarding/intro-video',
      bytes,
      contentType: contentType,
      headers: <String, String>{
        'x-duration-ms': '$durationMs',
        'x-video-width': '$width',
        'x-video-height': '$height',
        if (lang != null && lang.isNotEmpty) 'x-lang': lang,
        if (topic != null && topic.isNotEmpty) 'x-topic': topic,
      },
      uploadTimeout: const Duration(minutes: 3),
    );
    final v = j['video'];
    if (v is! Map) throw ApiException.parse(200);
    return OnbVideo.fromJson(Map<String, dynamic>.from(v));
  }

  Future<void> uploadPoster(String videoId, Uint8List bytes, {String contentType = 'image/jpeg'}) async {
    await _api.putBytes('/api/hf/onboarding/intro-video/${Uri.encodeComponent(videoId)}/poster', bytes, contentType: contentType);
  }

  /// Saves the name, the one-line description and the rate. A live influencer (re-onboarding) can only change the rate: the server
  /// locks the other fields while she is live, so only `pricePerMin` is sent then.
  Future<void> saveProfile({required bool live, required String name, required String about, required int rate}) async {
    final body = <String, Object?>{
      if (!live) 'category': 'influencer',
      if (!live) 'displayName': name,
      if (!live) 'about': about,
      'pricePerMin': rate,
    };
    await _api.putJson('/api/hosts/me', body: body);
  }

  /// `'A'` Bookings only, `'B'` Bookings + live. Never throws: while the flag is off the route answers 404 `not_enabled`, and the
  /// submit call carries the choice anyway.
  Future<void> setCallOption(String option) async {
    try {
      await _api.putJson('/api/hosts/me/call-option', body: <String, Object?>{'option': option, 'surface': 'onboarding'});
    } on ApiException {
      // best effort
    }
  }

  /// Throws [ApiException]: `aadhaar_required`, `women_to_women_requires_female`, `incomplete` (`extra['missing']`),
  /// `already_submitted`, `video_not_found`, `video_not_available`, `invalid_field`.
  Future<OnbApplication> submit({
    required List<String> categories,
    required String lang,
    required String videoId,
    required String callOption,
    String? topic,
  }) async {
    final j = await _api.postJson('/api/hf/onboarding/submit', body: <String, Object?>{
      'categories': categories,
      'lang': lang,
      'intro_video_id': videoId,
      'call_option': callOption,
      if (topic != null && topic.isNotEmpty) 'topic': topic,
    });
    final a = j['application'];
    if (a is! Map) throw ApiException.parse(200);
    return OnbApplication.fromJson(Map<String, dynamic>.from(a));
  }

  /// "Log in with Facebook": the Facebook dialog address to open in the in-app browser. The answer comes back as the deep link
  /// `<scheme>://channels?fb=connected|error&reason=...`. Errors: `not_enabled`, `provider_not_configured`.
  Future<Uri> facebookLoginUrl() async {
    final j = await _api.getJson('/api/hf/channels/facebook/start', query: <String, Object?>{'client': 'app'});
    final u = Uri.tryParse((j['url'] ?? '').toString());
    if (u == null) throw const ApiException(kind: ApiFailure.http, code: 'bad_response', message: ApiException.genericText);
    final host = u.host.toLowerCase();
    if (u.scheme != 'https' || !(host == 'facebook.com' || host.endsWith('.facebook.com'))) {
      throw const ApiException(kind: ApiFailure.http, code: 'bad_response', message: ApiException.genericText);
    }
    return u;
  }
}

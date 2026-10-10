import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_client.dart';
import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import '../../../core/strings.dart';
import '../../call/data/call_api.dart';

/// Review rules, the same ones the worker enforces (`hf_reviews_pure.ts`). The worker is the authority: these
/// only catch the obvious cases on the phone so the person does not wait for a round trip.
abstract final class ReviewRules {
  static const int maxText = 500;
  static const int minText = 3;

  static const String needStars = 'Please tap a star first.';
  static const String tooShort = 'Write a few words, or leave the text empty.';
  static const String tooLong = 'Keep it under $maxText characters.';
  static const String contact =
      'Please remove phone numbers, emails or links from your review. We keep contact details private.';

  /// The text as the worker will see it: whitespace collapsed, trimmed.
  static String clean(String text) => text.replaceAll(RegExp(r'\s+'), ' ').trim();

  /// A message to show, or null when the review can be sent.
  static String? validate({required int stars, required String text}) {
    if (stars < 1 || stars > 5) return needStars;
    final t = clean(text);
    if (t.isEmpty) return null;
    if (t.runes.length > maxText) return tooLong;
    final distinct = t.replaceAll(RegExp(r'\s'), '').runes.toSet().length;
    if (t.runes.length < minText || distinct < 2) return tooShort;
    if (looksLikeContact(t)) return contact;
    return null;
  }

  /// A phone number, an email address, a link or an @handle in the text.
  static bool looksLikeContact(String t) {
    if (RegExp(r'[\w.+-]+@[\w-]+\.[\w.-]+').hasMatch(t)) return true;
    if (RegExp(r'(https?://|www\.)', caseSensitive: false).hasMatch(t)) return true;
    if (RegExp(r'@\w{3,}').hasMatch(t)) return true;
    // Eight or more digits in one run, allowing spaces, dashes, dots and brackets between them.
    if (RegExp(r'(?:\d[\s\-().]*){8,}').hasMatch(t)) return true;
    return false;
  }
}

/// The message for a failed review submit. Contact details get the app's own sentence; everything else is the
/// worker's plain English.
String reviewErrorMessage(ApiError e) {
  if (e.code == 'contact_details') return ReviewRules.contact;
  if (e.isUnauthorized) return Strings.signInAgain;
  return e.userMessage;
}

/// One review as the screen sends it.
class ReviewDraft {
  const ReviewDraft({required this.stars, this.text = '', this.topic});

  final int stars;
  final String text;
  final String? topic;

  Map<String, Object?> toJson() {
    final t = ReviewRules.clean(text);
    return {
      'stars': stars,
      if (t.isNotEmpty) 'text': t,
      if (topic != null && topic!.isNotEmpty) 'topic': topic,
    };
  }
}

/// What the review screen needs to know about the call being rated.
class ReviewTarget {
  const ReviewTarget({
    required this.hostName,
    this.hostSlug,
    this.minutes = 0,
    this.callDate,
    this.alreadyReviewed = false,
    this.canReview = true,
  });

  final String hostName;
  final String? hostSlug;
  final int minutes;

  /// A date the worker wrote (token path only).
  final String? callDate;

  /// The token path says so; the call path derives it from `canReview`.
  final bool alreadyReviewed;
  final bool canReview;

  String get hostFirstName {
    final n = hostName.trim();
    return n.isEmpty ? 'your host' : n.split(RegExp(r'\s+')).first;
  }

  /// `GET /api/hf/review/:token` -> `{hostName, hostSlug, callDate, minutes, alreadyReviewed}`.
  factory ReviewTarget.fromTokenJson(Map<String, dynamic> j) {
    final slug = '${j['hostSlug'] ?? ''}'.trim();
    final date = '${j['callDate'] ?? ''}'.trim();
    return ReviewTarget(
      hostName: '${j['hostName'] ?? ''}'.trim(),
      hostSlug: slug.isEmpty ? null : slug,
      minutes: j['minutes'] is num ? (j['minutes'] as num).toInt() : 0,
      callDate: date.isEmpty ? null : date,
      alreadyReviewed: j['alreadyReviewed'] == true,
    );
  }
}

/// A topic the caller can pick (`slug` goes to the worker, `label` is shown).
class ReviewTopic {
  const ReviewTopic(this.slug, this.label);

  final String slug;
  final String label;
}

/// The review routes (worker `hf_reviews.ts`).
class ReviewApi {
  const ReviewApi(this._api, this._calls);

  final ApiClient _api;
  final CallApi _calls;

  /// `GET /api/hf/review/:token`: no sign-in, the token is the credential.
  Future<ReviewTarget> tokenTarget(String token) async => ReviewTarget.fromTokenJson(
      await _api.getJson('/api/hf/review/${Uri.encodeComponent(token)}', auth: false));

  /// `POST /api/hf/review/:token {stars, text?, topic?}`: no sign-in.
  Future<void> submitToken(String token, ReviewDraft d) async {
    await _api.postJson('/api/hf/review/${Uri.encodeComponent(token)}', body: d.toJson(), auth: false);
  }

  /// The signed-in path starts from the call itself (`GET /api/hf/calls/:id`).
  Future<ReviewTarget> callTarget(String callId) async {
    final info = await _calls.status(callId);
    return ReviewTarget(
      hostName: info.hostName ?? '',
      hostSlug: info.hostSlug,
      minutes: info.billedMinutes,
      canReview: info.canReview,
    );
  }

  /// `POST /api/hf/calls/:id/review {stars, text?, topic?}`: the signed-in caller of a completed call.
  Future<void> submitCall(String callId, ReviewDraft d) async {
    await _api.postJson('/api/hf/calls/${Uri.encodeComponent(callId)}/review', body: d.toJson());
  }
}

final reviewApiProvider =
    Provider<ReviewApi>((ref) => ReviewApi(ref.watch(apiClientProvider), ref.watch(callApiProvider)));

/// Which call is being reviewed: exactly one of the two is set. A record, so it works as a provider key.
typedef ReviewKey = ({String? callId, String? token});

final reviewTargetProvider = FutureProvider.autoDispose.family<ReviewTarget, ReviewKey>(
  retry: (_, __) => null,
  (ref, key) {
  final api = ref.watch(reviewApiProvider);
  final token = key.token;
  if (token != null) return api.tokenTarget(token);
  return api.callTarget(key.callId ?? '');
});

/// The topics a caller can pick for this host: the host's own topics, with their labels from `/api/hf/options`.
/// A picker that cannot load is simply not shown (the topic is optional).
final reviewTopicsProvider = FutureProvider.autoDispose.family<List<ReviewTopic>, String>(
  retry: (_, __) => null,
  (ref, hostSlug) async {
  final api = ref.watch(apiClientProvider);
  try {
    final host = await api.getJson('/api/hosts/public/${Uri.encodeComponent(hostSlug)}', auth: false);
    final opts = await api.getJson('/api/hf/options', auth: false);
    final mine = <String>{
      for (final t in (host['topics'] is List ? host['topics'] as List : const [])) '$t'.toLowerCase(),
    };
    final out = <ReviewTopic>[];
    for (final t in (opts['topics'] is List ? opts['topics'] as List : const [])) {
      if (t is! Map) continue;
      final slug = '${t['slug'] ?? ''}';
      final label = '${t['label'] ?? ''}';
      if (slug.isEmpty || label.isEmpty) continue;
      if (mine.contains(slug.toLowerCase()) || mine.contains(label.toLowerCase())) out.add(ReviewTopic(slug, label));
    }
    return out;
  } catch (_) {
    return const <ReviewTopic>[];
  }
});

/// `hf_app_review_submitted {stars, via}`: `via` is `call` (signed in, from the call screen) or `token` (a
/// WhatsApp or push link). `outcome` is `ok` or `failed` (with the server's code as `reason`).
void reportReviewSubmitted({
  required int stars,
  required String via,
  required bool ok,
  String? reason,
  int? httpStatus,
  int? ms,
}) {
  unawaited(Analytics.capture('hf_app_review_submitted', {
    'stars': stars,
    'via': via,
    'outcome': ok ? 'ok' : 'failed',
    if (reason != null) 'reason': reason,
    if (httpStatus != null) 'status': httpStatus,
    if (ms != null) 'ms': ms,
  }));
}

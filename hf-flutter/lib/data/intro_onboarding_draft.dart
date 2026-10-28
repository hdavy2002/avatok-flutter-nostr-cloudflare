import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// [HF-INTRO-A1] Where a person got to in the influencer onboarding, so she can leave and come back. Saved on the phone under
/// `hf_intro_onb_v1.<account id>`: the account id is part of the key, so a second person on the same phone never sees this draft.
/// Only choices are kept (categories, language, topic, call option, the typed profile fields). The video itself lives on the server
/// (`GET /api/hf/onboarding/me` returns it), so nothing big or private is stored here. Storage that cannot be read or written is fine:
/// the flow then simply starts from the first step.
class IntroOnbDraft {
  const IntroOnbDraft({
    this.step = 'categories',
    this.categories = const <String>[],
    this.lang,
    this.topic,
    this.callOption,
    this.name = '',
    this.about = '',
    this.rate,
    this.retakeN = 0,
    this.socialAsked = false,
  });

  /// The name of the step the person was on (`categories`, `social`, ...).
  final String step;
  final List<String> categories;
  final String? lang;
  final String? topic;

  /// `'A'` or `'B'`, or null until chosen.
  final String? callOption;
  final String name;
  final String about;
  final int? rate;

  /// How many times she pressed Redo (for the `hf_intro_record` event).
  final int retakeN;

  /// She already saw the Social media verification step (so a restored draft does not show it again after Skip).
  final bool socialAsked;

  IntroOnbDraft copyWith({
    String? step,
    List<String>? categories,
    String? lang,
    String? topic,
    String? callOption,
    String? name,
    String? about,
    int? rate,
    int? retakeN,
    bool? socialAsked,
  }) =>
      IntroOnbDraft(
        step: step ?? this.step,
        categories: categories ?? this.categories,
        lang: lang ?? this.lang,
        topic: topic ?? this.topic,
        callOption: callOption ?? this.callOption,
        name: name ?? this.name,
        about: about ?? this.about,
        rate: rate ?? this.rate,
        retakeN: retakeN ?? this.retakeN,
        socialAsked: socialAsked ?? this.socialAsked,
      );

  Map<String, Object?> toJson() => <String, Object?>{
        'step': step,
        'categories': categories,
        if (lang != null) 'lang': lang,
        if (topic != null) 'topic': topic,
        if (callOption != null) 'callOption': callOption,
        'name': name,
        'about': about,
        if (rate != null) 'rate': rate,
        'retakeN': retakeN,
        'socialAsked': socialAsked,
      };

  factory IntroOnbDraft.fromJson(Map<String, dynamic> j) {
    String? s(Object? v) {
      final x = (v ?? '').toString();
      return x.isEmpty ? null : x;
    }

    final cats = j['categories'];
    final rate = j['rate'];
    final retake = j['retakeN'];
    return IntroOnbDraft(
      step: s(j['step']) ?? 'categories',
      categories: cats is List ? [for (final c in cats) c.toString()] : const <String>[],
      lang: s(j['lang']),
      topic: s(j['topic']),
      callOption: s(j['callOption']),
      name: (j['name'] ?? '').toString(),
      about: (j['about'] ?? '').toString(),
      rate: rate is num ? rate.toInt() : null,
      retakeN: retake is num ? retake.toInt() : 0,
      socialAsked: j['socialAsked'] == true,
    );
  }
}

abstract final class IntroOnbDraftStore {
  static const String _base = 'hf_intro_onb_v1';

  static String _keyFor(String accountId) => '$_base.${Uri.encodeComponent(accountId)}';

  /// The saved draft for this account, or null (nothing saved, no account, or storage unavailable).
  static Future<IntroOnbDraft?> load(String? accountId) async {
    if (accountId == null || accountId.isEmpty) return null;
    try {
      final p = await SharedPreferences.getInstance();
      final raw = p.getString(_keyFor(accountId));
      if (raw == null || raw.isEmpty) return null;
      final j = jsonDecode(raw);
      if (j is! Map) return null;
      return IntroOnbDraft.fromJson(Map<String, dynamic>.from(j));
    } catch (_) {
      return null;
    }
  }

  static Future<void> save(String? accountId, IntroOnbDraft draft) async {
    if (accountId == null || accountId.isEmpty) return;
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString(_keyFor(accountId), jsonEncode(draft.toJson()));
    } catch (_) {
      // best effort
    }
  }

  static Future<void> clear(String? accountId) async {
    if (accountId == null || accountId.isEmpty) return;
    try {
      final p = await SharedPreferences.getInstance();
      await p.remove(_keyFor(accountId));
    } catch (_) {
      // best effort
    }
  }
}

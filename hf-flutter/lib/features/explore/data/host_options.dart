import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/session.dart';

/// `GET /api/hf/options` (public, cached 1 h by the server):
/// `{topics:[{slug,label,group}], moodGroups:[{slug,label}], languages:[{code,label}], styles, priceMin, priceMax}`.
/// The app keeps NO copy of these lists: topic labels, mood groups, languages and the price range all come from here.
class HostTopic {
  const HostTopic({required this.slug, required this.label, required this.group});
  final String slug;
  final String label;

  /// The label of the mood group this topic belongs to (matches [MoodGroup.label]).
  final String group;
}

class MoodGroup {
  const MoodGroup({required this.slug, required this.label});
  final String slug;
  final String label;
}

class HostLanguage {
  const HostLanguage({required this.code, required this.label});
  final String code;
  final String label;
}

class HostOptions {
  const HostOptions({
    required this.topics,
    required this.moodGroups,
    required this.languages,
    required this.priceMin,
    required this.priceMax,
  });

  final List<HostTopic> topics;
  final List<MoodGroup> moodGroups;
  final List<HostLanguage> languages;
  final int priceMin;
  final int priceMax;

  /// The label for a topic slug; an unknown slug is shown as readable words.
  String topicLabel(String slug) {
    for (final t in topics) {
      if (t.slug == slug) return t.label;
    }
    return slug.replaceAll('-', ' ');
  }

  /// Topic slug to label, for the cards.
  Map<String, String> get topicLabels => <String, String>{for (final t in topics) t.slug: t.label};

  /// The topic slugs of one mood group (a Home tile opens Explore with these).
  List<String> topicsOfGroup(MoodGroup g) => [for (final t in topics) if (t.group == g.label) t.slug];

  /// The language code for a label ("Hindi" -> "hi"), or null.
  String? languageCode(String label) {
    for (final l in languages) {
      if (l.label.toLowerCase() == label.toLowerCase()) return l.code;
    }
    return null;
  }

  factory HostOptions.fromJson(Object? raw) {
    final j = raw is Map ? Map<String, dynamic>.from(raw) : <String, dynamic>{};
    List<Map<String, dynamic>> maps(Object? v) =>
        v is List ? [for (final e in v) if (e is Map) Map<String, dynamic>.from(e)] : <Map<String, dynamic>>[];
    String s(Object? v) => (v ?? '').toString();
    int n(Object? v, int fallback) => v is num ? v.toInt() : fallback;
    final min = n(j['priceMin'], 5);
    final max = n(j['priceMax'], 100);
    return HostOptions(
      topics: [
        for (final m in maps(j['topics']))
          if (s(m['slug']).isNotEmpty) HostTopic(slug: s(m['slug']), label: s(m['label']), group: s(m['group'])),
      ],
      moodGroups: [
        for (final m in maps(j['moodGroups']))
          if (s(m['label']).isNotEmpty) MoodGroup(slug: s(m['slug']), label: s(m['label'])),
      ],
      languages: [
        for (final m in maps(j['languages']))
          if (s(m['code']).isNotEmpty) HostLanguage(code: s(m['code']), label: s(m['label'])),
      ],
      priceMin: min,
      priceMax: max > min ? max : min + 1,
    );
  }
}

/// The options when they are loaded, else null (screens that only need labels work without them).
HostOptions? optionsOf(AsyncValue<HostOptions> v) => v is AsyncData<HostOptions> ? v.value : null;

const String _optionsCacheKey = 'hf.cache.options.v1';

/// Riverpod 3 retries a failed provider on its own (with timers). Our screens show "Try again" instead,
/// so a failure stays a failure until the person asks again.
Duration? noAutoRetry(int retryCount, Object error) => null;

/// The options, cached on the phone: the fresh answer when the network works, else the saved copy.
/// Errors only when there is neither (the filter sheet then shows "Try again").
final hostOptionsProvider = FutureProvider<HostOptions>(retry: noAutoRetry, (ref) async {
  final api = ref.watch(apiClientProvider);
  final cache = ref.watch(jsonCacheProvider);
  try {
    final json = await api.getJson('/api/hf/options', auth: false);
    final opts = HostOptions.fromJson(json);
    if (opts.topics.isNotEmpty) await cache.write(_optionsCacheKey, json);
    return opts;
  } catch (e) {
    final saved = await cache.read(_optionsCacheKey);
    if (saved != null) return HostOptions.fromJson(saved.data);
    rethrow;
  }
});

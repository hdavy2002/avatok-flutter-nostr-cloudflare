import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_client.dart';
import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import '../../../core/router/routes.dart';
import '../../../core/storage/cache.dart';
import 'host_profile.dart';

/// Profiles are public data, so the saved copy uses the plain (unscoped) cache key.
/// The last [kProfileCacheMax] profiles are kept, newest first.
String hostProfileCacheKey(String slug) => 'hf.cache.host.$slug.v1';
const String kProfileIndexKey = 'hf.cache.host_index.v1';
const int kProfileCacheMax = 20;

String _hostPath(String slug, [String suffix = '']) => '/api/hosts/public/${Uri.encodeComponent(slug)}$suffix';

/// `GET /api/hosts/public/:slug`, public (no token). On success the JSON is saved. When the network
/// fails (or the server errors) the saved copy of the last visit is shown instead, with [HostProfileResult.fromCache].
/// A `404 not_found` is never answered from the saved copy (the host is gone), and it drops that copy.
final hostProfileProvider = FutureProvider.autoDispose.family<HostProfileResult, String>((ref, slug) async {
  final api = ref.watch(apiClientProvider);
  final cache = ref.watch(jsonCacheProvider);
  try {
    final json = await api.getJson(_hostPath(slug), auth: false);
    final profile = HostProfile.fromJson(json);
    unawaited(_remember(cache, slug, json));
    return HostProfileResult(profile: profile);
  } on ApiError catch (e) {
    if (e.isNotEnabled) rethrow;
    if (e.status == 404) {
      unawaited(_forget(cache, slug));
      rethrow;
    }
    final saved = await cache.read(hostProfileCacheKey(slug));
    final data = saved?.data;
    if (data is Map) {
      return HostProfileResult(profile: HostProfile.fromJson(Map<String, dynamic>.from(data)), fromCache: true);
    }
    rethrow;
  }
});

Future<void> _remember(JsonCache cache, String slug, Map<String, dynamic> json) async {
  await cache.write(hostProfileCacheKey(slug), json);
  final entry = await cache.read(kProfileIndexKey);
  final raw = entry?.data;
  final index = <String>[slug, if (raw is List) ...raw.map((e) => '$e').where((e) => e != slug)];
  while (index.length > kProfileCacheMax) {
    await cache.remove(hostProfileCacheKey(index.removeLast()));
  }
  await cache.write(kProfileIndexKey, index);
}

Future<void> _forget(JsonCache cache, String slug) async {
  await cache.remove(hostProfileCacheKey(slug));
  final entry = await cache.read(kProfileIndexKey);
  final raw = entry?.data;
  if (raw is List) {
    await cache.write(kProfileIndexKey, raw.map((e) => '$e').where((e) => e != slug).toList());
  }
}

/// Topic slug to label, from the public `GET /api/hf/options`. Never errors: when it cannot be read the
/// profile shows readable text made from the slug instead ([topicLabel]).
final topicLabelsProvider = FutureProvider<Map<String, String>>((ref) async {
  final api = ref.watch(apiClientProvider);
  try {
    final json = await api.getJson('/api/hf/options', auth: false);
    final topics = json['topics'];
    final out = <String, String>{};
    if (topics is List) {
      for (final t in topics.whereType<Map>()) {
        final slug = '${t['slug'] ?? ''}';
        final label = '${t['label'] ?? ''}'.trim();
        if (slug.isNotEmpty && label.isNotEmpty) out[slug] = label;
      }
    }
    return out;
  } catch (_) {
    // Labels are a nicety: the slug is shown readably instead.
    return const <String, String>{};
  }
});

/// `naye-dost` becomes `Naye dost`.
String topicLabel(Map<String, String> labels, String slug) {
  final known = labels[slug];
  if (known != null) return known;
  final spaced = slug.replaceAll(RegExp(r'[-_]+'), ' ').trim();
  if (spaced.isEmpty) return slug;
  return '${spaced[0].toUpperCase()}${spaced.substring(1)}';
}

/// `GET /api/hf/wallet/estimate?host=<slug>`. Only when signed in; null otherwise, and null on any failure
/// (the estimate is extra detail, the price per minute is always shown).
final hostEstimateProvider = FutureProvider.autoDispose.family<HostEstimate?, String>((ref, slug) async {
  final signedIn = ref.watch(sessionProvider.select((s) => s.isSignedIn));
  if (!signedIn) return null;
  final api = ref.watch(apiClientProvider);
  try {
    final json = await api.getJson('/api/hf/wallet/estimate', query: {'host': slug});
    return HostEstimate.fromJson(json);
  } catch (_) {
    return null;
  }
});

/// `GET /api/hf/hosts/:slug/notify`: am I already subscribed? False when signed out or when it cannot be read.
final notifyStatusProvider = FutureProvider.autoDispose.family<bool, String>((ref, slug) async {
  final signedIn = ref.watch(sessionProvider.select((s) => s.isSignedIn));
  if (!signedIn) return false;
  final api = ref.watch(apiClientProvider);
  try {
    final json = await api.getJson(_notifyPath(slug));
    return json['subscribed'] == true;
  } catch (_) {
    return false;
  }
});

String _notifyPath(String slug) => '/api/hf/hosts/${Uri.encodeComponent(slug)}/notify';

/// Turn Notify me on (`POST`, needs a verified WhatsApp) or off (`DELETE`). Returns the new `subscribed`.
/// Throws [ApiError] (`not_verified`, `own_profile`, `not_found`, ...): show `userMessage`.
Future<bool> setNotifyMe(ApiClient api, String slug, {required bool on}) async {
  final json = on ? await api.postJson(_notifyPath(slug)) : await api.deleteJson(_notifyPath(slug));
  return json['subscribed'] == true;
}

/// Opens the call confirm step for a host. The confirm sheet and call screen belong to HF-NATIVE-5:
/// this is the single seam between the profile and them. The default pushes the call route with the host
/// slug in `host`; NATIVE-5 either reads that, or replaces the opener here with its own builder.
typedef CallConfirmOpener = Future<void> Function(BuildContext context, String slug);

String callConfirmLocation(String slug) => Uri(path: Routes.callOf('new'), queryParameters: {'host': slug}).toString();

final callConfirmOpenerProvider = Provider<CallConfirmOpener>((ref) {
  return (context, slug) async {
    await GoRouter.of(context).push<Object?>(callConfirmLocation(slug));
  };
});

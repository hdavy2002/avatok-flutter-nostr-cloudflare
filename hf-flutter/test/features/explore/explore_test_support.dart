import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/app.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/boot.dart';
import 'package:hf_app/core/storage/cache.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:hf_app/features/explore/widgets/intro_player.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';

/// A JSON cache in memory: no platform channel, and a test can plant an old copy with [seed].
class MemoryJsonCache extends JsonCache {
  MemoryJsonCache();

  final Map<String, CacheEntry> store = <String, CacheEntry>{};

  void seed(String key, Object? data, {DateTime? at}) =>
      store[key] = CacheEntry(at: at ?? DateTime.now(), data: data);

  @override
  Future<CacheEntry?> read(String key, {bool scoped = false}) async => store[key];

  @override
  Future<void> write(String key, Object? data, {bool scoped = false}) async =>
      store[key] = CacheEntry(at: DateTime.now(), data: data);

  @override
  Future<void> remove(String key, {bool scoped = false}) async => store.remove(key);

  @override
  Future<void> clearAll() async => store.clear();
}

/// A speaker that plays nothing and records what it was asked.
class FakeIntroAudio implements IntroAudio {
  final List<String> played = <String>[];
  int pauses = 0;
  int stops = 0;
  final StreamController<void> _done = StreamController<void>.broadcast();

  @override
  Future<void> play(String url) async => played.add(url);

  @override
  Future<void> pause() async => pauses++;

  @override
  Future<void> stop() async => stops++;

  @override
  Stream<void> get onComplete => _done.stream;

  void finish() => _done.add(null);

  @override
  void dispose() => unawaited(_done.close());
}

/// One host row as the server sends it.
Map<String, Object?> hostJson(
  String slug, {
  String? name,
  String status = 'online',
  int price = 10,
  List<String> topics = const <String>['tension-a'],
  List<String> languages = const <String>['Hindi', 'English'],
  double? rating = 4.8,
  int reviews = 12,
  String? intro,
  bool womenOnly = false,
}) =>
    <String, Object?>{
      'slug': slug,
      'displayName': name ?? 'Host $slug',
      'tagline': 'Tagline of $slug',
      'avatarUrl': null,
      'languages': languages,
      'style': 'warm',
      'topics': topics,
      'pricePerMin': price,
      'rating': rating,
      'reviewCount': reviews,
      'talkedTo': 30,
      'regulars': 4,
      'lgbtqFriendly': false,
      'womenOnly': womenOnly,
      'introAudioUrl': intro,
      'introSeconds': intro == null ? null : 12,
      'status': status,
    };

Map<String, Object?> pageJson(List<Map<String, Object?>> items, {int? next, int? total}) =>
    <String, Object?>{'items': items, 'nextOffset': next, 'total': total ?? items.length};

/// `GET /api/hf/options`, small.
Map<String, Object?> optionsJson() => <String, Object?>{
      'topics': [
        {'slug': 'dost-a', 'label': 'Roz baat', 'group': 'Naye dost'},
        {'slug': 'tension-a', 'label': 'Exam tension', 'group': 'Tension'},
      ],
      'moodGroups': [
        {'slug': 'naye-dost', 'label': 'Naye dost'},
        {'slug': 'tension', 'label': 'Tension'},
      ],
      'languages': [
        {'code': 'hi', 'label': 'Hindi'},
        {'code': 'en', 'label': 'English'},
      ],
      'styles': <Object?>[],
      'priceMin': 5,
      'priceMax': 100,
    };

/// A fake API that already answers `/api/hf/options` and `/api/config`.
FakeApiClient fakeApi() => FakeApiClient()
  ..onJson('GET', '/api/hf/options', optionsJson())
  ..onJson('GET', '/api/config', <String, Object?>{});

/// Pumps the whole app at [location] with the fakes in place (cache in memory, speaker fake, animations off so
/// the pulsing online dot lets `pumpAndSettle` finish).
Future<ProviderContainer> pumpScreen(
  WidgetTester tester, {
  required FakeApiClient api,
  SessionState? session,
  String location = '/explore',
  MemoryJsonCache? cache,
  FakeIntroAudio? audio,
  Size size = const Size(360, 800),
}) async {
  tester.view.physicalSize = Size(size.width * 3, size.height * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(disableAnimations: true);
  addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
  final container = ProviderContainer(overrides: [
    sessionProvider.overrideWith(() => StubSession(session ?? signedOutState())),
    apiClientProvider.overrideWithValue(api),
    secureStoreProvider.overrideWithValue(MemoryKeyValueStore()),
    jsonCacheProvider.overrideWithValue(cache ?? MemoryJsonCache()),
    introAudioProvider.overrideWithValue(audio ?? FakeIntroAudio()),
    initialLocationProvider.overrideWithValue(location),
  ]);
  addTearDown(container.dispose);
  await tester.pumpWidget(UncontrolledProviderScope(
    container: container,
    child: const HfApp(listenForLinks: false),
  ));
  await tester.pumpAndSettle();
  return container;
}

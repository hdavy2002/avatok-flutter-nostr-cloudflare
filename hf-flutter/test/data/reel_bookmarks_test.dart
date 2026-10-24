import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/models/reel.dart';
import 'package:hf_app/data/reel_bookmarks.dart';

class FakeApi extends ApiClient {
  FakeApi() : super(origin: 'https://api.test');
  bool available = false;
  final saved = <String>{};
  final failures = <String, ApiException>{};
  final writes = <String>[];
  int blockGet = 0;
  Completer<void>? getStarted;
  Completer<void>? releaseGet;
  @override
  Future<Object?> request(
    String method,
    String path, {
    Map<String, Object?>? query,
    Object? body,
    bool auth = true,
    Map<String, String>? headers,
  }) async {
    if (!available)
      throw const ApiException(
        kind: ApiFailure.http,
        status: 404,
        code: 'not_found',
      );
    final id = path.split('/').last;
    if (method == 'GET' && blockGet > 0 && --blockGet == 0) {
      final snapshot = {
        'items': saved.map((id) => {'id': id}).toList(),
      };
      getStarted!.complete();
      await releaseGet!.future;
      return snapshot;
    }
    if (method != 'GET') {
      writes.add(id);
      if (failures[id] != null) throw failures[id]!;
    }
    if (method == 'PUT') saved.add(id);
    if (method == 'DELETE') saved.remove(id);
    return {
      'items': saved
          .map(
            (id) => {
              'id': id,
              'kind': 'invite',
              'creator': {'platform': 'youtube', 'handle': '@artist'},
              'embedUrl': 'https://www.youtube.com/embed/video',
            },
          )
          .toList(),
    };
  }
}

const reel = FeedReel(
  id: 'hfiv_abcdefgh1234',
  host: ReelHost(slug: '', name: 'Artist'),
  invite: InviteCreator(platform: 'youtube', handle: '@artist'),
  embedUrl: 'https://www.youtube.com/embed/video',
);
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues({}));
  test(
    'saves locally before API deployment, restores invite video, then syncs',
    () async {
      final api = FakeApi();
      final store = ReelBookmarks(api, () => 'account-a');
      await store.toggle(reel);
      expect(store.isSaved(reel.id), isTrue);
      final restored = ReelBookmarks(api, () => 'account-a');
      await restored.load();
      expect(restored.items.single.invite!.handle, '@artist');
      api.available = true;
      await restored.refresh();
      expect(api.saved, {reel.id});
      await restored.toggle(reel);
      expect(restored.items, isEmpty);
      expect(api.saved, isEmpty);
    },
  );
  test('a saved reel keeps its like and comment numbers when restored', () async {
    const counted = FeedReel(
      id: 'hfrl_abcdefgh1234',
      host: ReelHost(slug: 'maya', name: 'Maya'),
      embedUrl: 'https://www.youtube.com/embed/video',
      likeCounts: EngageCount(platform: 10, ours: 2),
      commentCounts: EngageCount(platform: 3, ours: 1),
      likedByMe: true,
    );
    final api = FakeApi();
    await ReelBookmarks(api, () => 'account-a').toggle(counted);
    final restored = ReelBookmarks(api, () => 'account-a');
    await restored.load();
    final r = restored.items.single;
    expect(r.engagementOn, isTrue);
    expect(r.likeCounts!.total, 12);
    expect(r.commentCounts!.ours, 1);
    expect(r.likedByMe, isTrue);
  });
  test(
    'account changes and sign-out never reveal the previous saved list',
    () async {
      String? account = 'a';
      final store = ReelBookmarks(FakeApi(), () => account);
      await store.toggle(reel);
      account = 'b';
      expect(store.items, isEmpty);
      await store.load();
      expect(store.items, isEmpty);
      account = null;
      expect(store.isSaved(reel.id), isFalse);
      account = 'a';
      await store.load();
      expect(store.items.single.id, reel.id);
    },
  );
  test(
    'a delayed stale GET cannot erase a newer save; sync is serialized',
    () async {
      final api = FakeApi()..available = true;
      final store = ReelBookmarks(api, () => 'a');
      await store.load();
      api.blockGet = 2;
      api.getStarted = Completer<void>();
      api.releaseGet = Completer<void>();
      final oldRefresh = store.refresh();
      await api.getStarted!.future;
      final save = store.toggle(reel);
      await Future<void>.delayed(Duration.zero);
      expect(store.isSaved(reel.id), isTrue);
      expect(api.writes, isEmpty); // queued behind the old GET
      api.releaseGet!.complete();
      await Future.wait([oldRefresh, save]);
      expect(store.isSaved(reel.id), isTrue);
      expect(api.saved, {reel.id});
      final restored = ReelBookmarks(api, () => 'a');
      await restored.load();
      expect(restored.isSaved(reel.id), isTrue);
    },
  );
  test('permanent item rejections do not poison later queued saves', () async {
    final api = FakeApi();
    final store = ReelBookmarks(api, () => 'a');
    const gone = FeedReel(
      id: 'hfiv_gone12345678',
      host: ReelHost(slug: '', name: 'Gone'),
    );
    const full = FeedReel(
      id: 'hfiv_full12345678',
      host: ReelHost(slug: '', name: 'Full'),
    );
    await store.toggle(gone);
    await store.toggle(full);
    await store.toggle(reel);
    api.available = true;
    api.failures[gone.id] = const ApiException(
      kind: ApiFailure.http,
      status: 404,
      code: 'not_found',
    );
    api.failures[full.id] = const ApiException(
      kind: ApiFailure.http,
      status: 409,
      code: 'limit_reached',
    );
    await store.refresh();
    expect(api.saved, {reel.id});
    expect(store.items.map((r) => r.id), [reel.id]);
    api.writes.clear();
    await store.refresh();
    expect(api.writes, isEmpty); // rejected operations were durably removed
  });
  test('temporary server failure stays queued and retries later', () async {
    final api = FakeApi();
    final store = ReelBookmarks(api, () => 'a');
    await store.toggle(reel);
    api.available = true;
    api.failures[reel.id] = const ApiException(
      kind: ApiFailure.http,
      status: 503,
      code: 'unavailable',
    );
    await store.refresh();
    expect(store.isSaved(reel.id), isTrue);
    api.failures.clear();
    await store.refresh();
    expect(api.saved, {reel.id});
  });
}

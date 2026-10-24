import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/models/reel.dart';
import 'package:hf_app/data/models/reel_engage.dart';
import 'package:hf_app/data/reel_comments_cache.dart';
import 'package:hf_app/data/reel_engage_store.dart';
import 'package:hf_app/data/repos/reel_engage_repo.dart';
import 'package:hf_app/data/reel_bookmarks.dart';
import 'package:hf_app/data/services.dart';
import 'package:hf_app/data/auth/clerk_client.dart';
import 'package:hf_app/demo/presence_bridge.dart';
import 'package:hf_app/demo/reel_player.dart';
import 'package:hf_app/demo/reels_real.dart';
import 'package:hf_app/demo/screens/feed.dart';
import 'package:hf_app/demo/screens/sheets.dart';
import 'package:hf_app/demo/state.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_reel_bookmarks.dart';

// [HF-REEL-ENGAGE-APP-1] The Like and Comment buttons and the slide-up comment sheet.

class _Repo implements ReelEngageApi {
  final List<ReelComment> existing = [];
  final List<String> sent = [];
  final List<String> likes = [];
  Object? likeError;
  Object? sendError;

  @override
  Future<LikeResult> setLike(String reelId, bool on) async {
    if (likeError != null) throw likeError!;
    likes.add('$reelId:$on');
    return LikeResult(liked: on, likes: EngageCount(platform: 10, ours: on ? 1 : 0));
  }

  @override
  Future<CommentsPage> comments(String reelId, {String? cursor}) async => CommentsPage(items: List.of(existing));

  @override
  Future<SentComment> send(String reelId, String body, {String? parentId}) async {
    if (sendError != null) throw sendError!;
    sent.add(body);
    return SentComment(
      item: ReelComment(id: 'hfrc_${sent.length}', authorName: 'Fan', body: body, mine: true, createdAt: DateTime.now().millisecondsSinceEpoch, parentId: parentId),
      comments: EngageCount(platform: 30, ours: 4 + sent.length),
    );
  }

  @override
  Future<void> delete(String commentId) async {}

  @override
  Future<ReportResult> report(String commentId, String reason) async => const ReportResult(reported: true);
}

FeedReel _reel({bool on = true, String platform = 'youtube', bool liked = false}) => FeedReel.fromJson({
  'id': 'hfrl_abc12345',
  'host': {'slug': 'maya', 'name': 'Maya', 'handle': '@maya', 'ratePaise': 1500, 'followers': 100, 'presence': 'online'},
  'platform': platform,
  'url': platform == 'instagram' ? 'https://www.instagram.com/reel/Cx12345/' : 'https://www.youtube.com/shorts/abc12345',
  'embedUrl': 'https://www.youtube.com/embed/abc12345',
  'caption': 'Hello',
  if (on) ...{
    'likeCounts': {'platform': 1500, 'ours': 500, 'total': 2000},
    'commentCounts': {'platform': 30, 'ours': 4, 'total': 34},
    'likedByMe': liked,
  },
});

Future<void> _pump(WidgetTester tester, FeedReel r, ReelEngageApi repo, {Size size = const Size(900, 2000)}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final router = GoRouter(initialLocation: '/start', routes: [
    GoRoute(
      path: '/start',
      builder: (_, __) => Scaffold(body: ReelPage(reel: demoReelFrom(r), active: true, real: r, engageRepo: repo)),
    ),
  ]);
  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  await tester.pump();
  await tester.pump();
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 12; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

void main() {
  late ReelEngageStore store;
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    PresenceBridge.forceReal = true;
    ReelPlayer.testPlayer = (r, active) => const SizedBox();
    store = ReelEngageStore();
    ReelEngageStore.override = store;
    ReelCommentsCache.override = ReelCommentsCache(() => 'u1');
    ReelBookmarks.override = WidgetBookmarks(ApiClient(origin: 'https://api.test'), () => Services.instance.user?.id);
    Services.instance.user = const ClerkUser(id: 'test_fan');
    demo.applyAccount(name: 'Fan', email: 'f@x.in', whatsapp: '******3210');
  });
  tearDown(() {
    PresenceBridge.forceReal = false;
    ReelPlayer.testPlayer = null;
    ReelEngageStore.override = null;
    ReelCommentsCache.override = null;
    ReelBookmarks.override = null;
    Services.instance.user = null;
    demo.signOut();
  });

  testWidgets('buttons show the totals, Like above Comment above Save, and Save is a bookmark', (tester) async {
    await _pump(tester, _reel(), _Repo());
    expect(find.byKey(const ValueKey('reel-like')), findsOneWidget);
    expect(find.byKey(const ValueKey('reel-comment')), findsOneWidget);
    expect(find.text(compactCount(2000)), findsOneWidget);
    expect(find.text('34'), findsOneWidget);
    expect(find.byIcon(Icons.bookmark_border_rounded), findsOneWidget);
    final like = tester.getTopLeft(find.byKey(const ValueKey('reel-like'))).dy;
    final comment = tester.getTopLeft(find.byKey(const ValueKey('reel-comment'))).dy;
    final save = tester.getTopLeft(find.byIcon(Icons.bookmark_border_rounded)).dy;
    expect(like < comment && comment < save, isTrue);
    final count = tester.widget<Text>(find.byKey(const ValueKey('reel-like-count')));
    expect(count.style!.fontSize, greaterThanOrEqualTo(14));
  });

  testWidgets('no likeCounts from the server: Like and Comment are hidden, nothing is invented', (tester) async {
    await _pump(tester, _reel(on: false), _Repo());
    expect(find.byKey(const ValueKey('reel-like')), findsNothing);
    expect(find.byKey(const ValueKey('reel-comment')), findsNothing);
    expect(find.byIcon(Icons.bookmark_border_rounded), findsOneWidget);
  });

  testWidgets('Like is instant and turns pink; the server count then replaces it', (tester) async {
    final repo = _Repo();
    await _pump(tester, _reel(), repo);
    await tester.tap(find.byIcon(Icons.favorite_border_rounded));
    await tester.pump();
    expect(store.of('hfrl_abc12345')!.liked, isTrue);
    expect(find.byIcon(Icons.favorite_rounded), findsOneWidget);
    await _settle(tester);
    expect(repo.likes, ['hfrl_abc12345:true']);
    expect(store.of('hfrl_abc12345')!.likes.total, 11);
  });

  testWidgets('a failed Like is rolled back with a message', (tester) async {
    final repo = _Repo()..likeError = const ApiException(kind: ApiFailure.offline, code: 'network');
    await _pump(tester, _reel(), repo);
    await tester.tap(find.byIcon(Icons.favorite_border_rounded));
    await _settle(tester);
    expect(store.of('hfrl_abc12345')!.liked, isFalse);
    expect(store.of('hfrl_abc12345')!.likes.total, 2000);
    expect(find.text(ApiException.offlineText), findsOneWidget);
  });

  testWidgets('comment sheet: empty state, breakdown line, send adds a row and bumps the count on the reel', (tester) async {
    final repo = _Repo();
    await _pump(tester, _reel(), repo);
    await tester.tap(find.byKey(const ValueKey('reel-comment')));
    await _settle(tester);
    expect(find.byKey(const ValueKey('comments-empty')), findsOneWidget);
    expect(find.text('34 comments'), findsOneWidget);
    expect(find.textContaining(' on YouTube'), findsNothing); // [HF-REEL-IG-COMMENTS-1] no per-platform count line

    await tester.enterText(find.byKey(const ValueKey('comment-field')), 'Lovely video');
    await tester.tap(find.byKey(const ValueKey('comment-send')));
    await tester.pump();
    expect(find.text('Lovely video'), findsOneWidget); // optimistic
    expect(find.text('35 comments'), findsOneWidget);
    await _settle(tester);
    expect(repo.sent, ['Lovely video']);
    expect(find.byKey(const ValueKey('comments-empty')), findsNothing);
    expect(store.of('hfrl_abc12345')!.comments.total, 35);

    await tester.tap(find.byKey(const ValueKey('comments-close')));
    await _settle(tester);
    expect(find.text('35'), findsOneWidget); // the button under the reel
  });

  testWidgets('a refused comment is taken back, the words return to the box and the reason shows', (tester) async {
    final repo = _Repo()..sendError = const ApiException(kind: ApiFailure.http, status: 422, code: 'no_links');
    await _pump(tester, _reel(), repo);
    await tester.tap(find.byKey(const ValueKey('reel-comment')));
    await _settle(tester);
    await tester.enterText(find.byKey(const ValueKey('comment-field')), 'see example.com');
    await tester.tap(find.byKey(const ValueKey('comment-send')));
    await _settle(tester);
    expect(find.byKey(const ValueKey('comments-notice')), findsOneWidget);
    expect(find.textContaining('Links are not allowed'), findsOneWidget);
    expect(store.of('hfrl_abc12345')!.comments.total, 34);
    expect(find.text('34 comments'), findsOneWidget);
  });

  testWidgets('imported comments carry no source chip (HF-REEL-60) and look like ours, with a Delete menu on mine', (tester) async {
    final repo = _Repo()
      ..existing.addAll([
        const ReelComment(id: 'yt:1', source: 'youtube', authorName: 'Ravi', body: 'From YouTube'),
        const ReelComment(id: 'hfrc_7', authorName: 'Me', body: 'Mine', mine: true),
      ]);
    await _pump(tester, _reel(), repo);
    await tester.tap(find.byKey(const ValueKey('reel-comment')));
    await _settle(tester);
    expect(find.text('From YouTube'), findsOneWidget);
    expect(find.text('YouTube'), findsNothing);
    expect(find.text('Instagram'), findsNothing);
    expect(find.text('Ravi'), findsOneWidget);
    expect(find.byKey(const ValueKey('reply-yt:1')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('more-hfrc_7')));
    await _settle(tester);
    expect(find.text('Delete'), findsOneWidget);
    await tester.tap(find.text('Delete'));
    await _settle(tester);
    expect(find.text('Mine'), findsNothing);
    await tester.tap(find.byKey(const ValueKey('more-yt:1')));
    await _settle(tester);
    expect(find.text('Report'), findsOneWidget);
  });

  testWidgets('Instagram reel: no "stay on Instagram" note and no per-platform count line', (tester) async {
    await _pump(tester, _reel(platform: 'instagram'), _Repo());
    await tester.tap(find.byKey(const ValueKey('reel-comment')));
    await _settle(tester);
    expect(find.textContaining('stay on Instagram'), findsNothing);
    expect(find.textContaining(' on Instagram'), findsNothing);
  });

  testWidgets('a guest who taps Send gets the sign-up sheet and nothing is posted', (tester) async {
    demo.signOut();
    Services.instance.user = null;
    final repo = _Repo();
    await _pump(tester, _reel(), repo);
    await tester.tap(find.byKey(const ValueKey('reel-comment')));
    await _settle(tester);
    await tester.enterText(find.byKey(const ValueKey('comment-field')), 'Hi');
    await tester.tap(find.byKey(const ValueKey('comment-send')));
    await _settle(tester);
    expect(find.byType(SignUpSheet), findsOneWidget);
    expect(repo.sent, isEmpty);
  });

  testWidgets('a guest who taps Like gets the sign-up sheet', (tester) async {
    demo.signOut();
    Services.instance.user = null;
    final repo = _Repo();
    await _pump(tester, _reel(), repo);
    await tester.tap(find.byIcon(Icons.favorite_border_rounded));
    await _settle(tester);
    expect(find.byType(SignUpSheet), findsOneWidget);
    expect(repo.likes, isEmpty);
  });

  testWidgets('a short screen moves Reel information to the bottom-left and nothing shrinks', (tester) async {
    await _pump(tester, _reel(), _Repo(), size: const Size(400, 560));
    expect(find.byKey(const ValueKey('reel-info-left')), findsOneWidget);
    expect(find.byIcon(Icons.info_outline_rounded), findsWidgets);
    expect(find.byType(FittedBox), findsNothing);
    final count = tester.widget<Text>(find.byKey(const ValueKey('reel-like-count')));
    expect(count.style!.fontSize, greaterThanOrEqualTo(14));
  });

  testWidgets('a tall screen keeps Reel information in the column', (tester) async {
    await _pump(tester, _reel(), _Repo());
    expect(find.byKey(const ValueKey('reel-info-left')), findsNothing);
  });

  test('signing out clears the shared like state', () {
    final s = ReelEngageStore();
    s.seed('a', likes: const EngageCount(platform: 1), comments: const EngageCount(), liked: true);
    s.clear();
    expect(s.of('a'), isNull);
  });

  testWidgets('a saved page shows at once even when the server never answers', (tester) async {
    unawaited(ReelCommentsCache.instance.write(
      'hfrl_abc12345',
      const CommentsPage(items: [ReelComment(id: 'c1', source: 'youtube', authorName: 'Ravi', body: 'Cached hello')]),
    ));
    await _pump(tester, _reel(), _NeverRepo());
    await tester.tap(find.byKey(const ValueKey('reel-comment')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Cached hello'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });

  testWidgets('the fresh page replaces the saved one quietly and is saved', (tester) async {
    unawaited(ReelCommentsCache.instance.write('hfrl_abc12345', const CommentsPage(items: [ReelComment(id: 'c1', authorName: 'Ravi', body: 'Old text')])));
    final repo = _Repo()..existing.add(const ReelComment(id: 'c2', authorName: 'Asha', body: 'Fresh text'));
    await _pump(tester, _reel(), repo);
    await tester.tap(find.byKey(const ValueKey('reel-comment')));
    await _settle(tester);
    expect(find.text('Fresh text'), findsOneWidget);
    expect(find.text('Old text'), findsNothing);
    final saved = await ReelCommentsCache.instance.read('hfrl_abc12345');
    expect(saved!.items.single.body, 'Fresh text');
  });

  testWidgets('a failed refresh keeps the saved list and shows nothing scary', (tester) async {
    unawaited(ReelCommentsCache.instance.write('hfrl_abc12345', const CommentsPage(items: [ReelComment(id: 'c1', authorName: 'Ravi', body: 'Cached hello')])));
    final repo = _FailingRepo();
    await _pump(tester, _reel(), repo);
    await tester.tap(find.byKey(const ValueKey('reel-comment')));
    await _settle(tester);
    expect(find.text('Cached hello'), findsOneWidget);
    expect(find.byKey(const ValueKey('comments-retry')), findsNothing);
    expect(find.byKey(const ValueKey('comments-notice')), findsNothing);
  });

  testWidgets('a sent comment is saved so reopening shows it at once', (tester) async {
    final repo = _Repo();
    await _pump(tester, _reel(), repo);
    await tester.tap(find.byKey(const ValueKey('reel-comment')));
    await _settle(tester);
    await tester.enterText(find.byKey(const ValueKey('comment-field')), 'Saved for later');
    await tester.tap(find.byKey(const ValueKey('comment-send')));
    await _settle(tester);
    final saved = await ReelCommentsCache.instance.read('hfrl_abc12345');
    expect(saved!.items.map((c) => c.body), contains('Saved for later'));
  });
}

class _NeverRepo extends _Repo {
  @override
  Future<CommentsPage> comments(String reelId, {String? cursor}) => Completer<CommentsPage>().future;
}

class _FailingRepo extends _Repo {
  @override
  Future<CommentsPage> comments(String reelId, {String? cursor}) async =>
      throw const ApiException(kind: ApiFailure.offline, code: 'network');
}

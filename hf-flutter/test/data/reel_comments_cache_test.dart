import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/models/reel.dart';
import 'package:hf_app/data/models/reel_engage.dart';
import 'package:hf_app/data/reel_comments_cache.dart';
import 'package:shared_preferences/shared_preferences.dart';

// [HF-REEL-COMMENTS-CACHE-1] The saved first page of comments: persisted, per account, capped.

CommentsPage _page(String body, {String? cursor, bool mine = false}) => CommentsPage(
  items: [ReelComment(id: 'c_$body', source: 'youtube', authorName: 'Ravi', body: body, mine: mine, createdAt: 5, replies: [
    ReelComment(id: 'r_$body', authorName: 'Me', body: 'reply', parentId: 'x'),
  ])],
  nextCursor: cursor,
  likes: const EngageCount(platform: 5, ours: 1),
  comments: const EngageCount(platform: 3, ours: 2),
  likedByMe: true,
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('a page survives a restart with items, replies, counts, cursor and likedByMe', () async {
    final a = ReelCommentsCache(() => 'acct-a');
    await a.write('hfrl_1', _page('hello', cursor: 'next1'));
    final fresh = ReelCommentsCache(() => 'acct-a'); // a new run: memory is empty
    expect(fresh.peek('hfrl_1'), isNull);
    final p = (await fresh.read('hfrl_1'))!;
    expect(p.items.single.body, 'hello');
    expect(p.items.single.replies.single.parentId, 'x');
    expect(p.items.single.source, 'youtube');
    expect(p.nextCursor, 'next1');
    expect(p.comments!.total, 5);
    expect(p.likes!.ours, 1);
    expect(p.likedByMe, isTrue);
    expect(fresh.peek('hfrl_1'), isNotNull); // now in memory too
  });

  test('another account never sees this account\'s page, and sign-out forgets memory', () async {
    var account = 'acct-a';
    final c = ReelCommentsCache(() => account);
    await c.write('hfrl_1', _page('mine', mine: true));
    account = 'acct-b';
    expect(c.peek('hfrl_1'), isNull);
    expect(await c.read('hfrl_1'), isNull);
    await c.write('hfrl_1', _page('theirs'));
    account = 'acct-a';
    expect((await c.read('hfrl_1'))!.items.single.body, 'mine');
    expect((await c.read('hfrl_1'))!.items.single.mine, isTrue);
    c.clearMemory();
    expect(c.peek('hfrl_1'), isNull);
    expect((await c.read('hfrl_1'))!.items.single.body, 'mine'); // still saved for its own account
  });

  test('a guest has a slot of its own', () async {
    String? account;
    final c = ReelCommentsCache(() => account);
    await c.write('hfrl_1', _page('guest page'));
    account = 'acct-a';
    expect(await c.read('hfrl_1'), isNull);
    account = null;
    expect((await c.read('hfrl_1'))!.items.single.body, 'guest page');
  });

  test('the saved copy keeps only the newest reels; memory keeps its own limit', () async {
    final c = ReelCommentsCache(() => 'acct-a', memoryCap: 5, diskCap: 3);
    for (var i = 1; i <= 6; i++) {
      await c.write('hfrl_$i', _page('p$i'));
    }
    expect(c.peek('hfrl_1'), isNull); // memory cap 5
    expect(c.peek('hfrl_2'), isNotNull);
    final restarted = ReelCommentsCache(() => 'acct-a', memoryCap: 5, diskCap: 3);
    expect(await restarted.read('hfrl_3'), isNull); // disk cap 3 keeps 4, 5, 6
    expect(await restarted.read('hfrl_4'), isNotNull);
    expect(await restarted.read('hfrl_6'), isNotNull);
  });

  test('reading a reel makes it recently used, so it outlives older ones', () async {
    final c = ReelCommentsCache(() => 'acct-a', memoryCap: 2, diskCap: 2);
    await c.write('a', _page('a'));
    await c.write('b', _page('b'));
    c.peek('a');
    await c.write('c', _page('c'));
    expect(c.peek('a'), isNotNull);
    expect(c.peek('b'), isNull);
  });

  test('writing before the saved copy was read does not lose older reels', () async {
    await ReelCommentsCache(() => 'acct-a').write('old', _page('old'));
    final c = ReelCommentsCache(() => 'acct-a');
    await c.write('new', _page('new'));
    final again = ReelCommentsCache(() => 'acct-a');
    expect(await again.read('old'), isNotNull);
    expect(await again.read('new'), isNotNull);
  });

  test('a damaged saved copy is just a miss', () async {
    SharedPreferences.setMockInitialValues({'hf.reelComments.v1.acct-a': '{not json'});
    expect(await ReelCommentsCache(() => 'acct-a').read('x'), isNull);
  });
}

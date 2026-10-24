import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/models/reel.dart';
import 'package:hf_app/data/models/reel_engage.dart';
import 'package:hf_app/data/reel_engage_store.dart';
import 'package:hf_app/data/repos/reel_engage_repo.dart';
import 'package:hf_app/demo/screens/reel_comments_sheet.dart';

// [HF-REEL-ENGAGE-APP-1] Model parsing, repo paths and the shared like state.

class _Api extends ApiClient {
  _Api(this.handler) : super(origin: 'https://api.test');
  final Object? Function(String method, String path, Map<String, Object?>? query, Object? body) handler;
  final List<String> calls = [];
  @override
  Future<Object?> request(String method, String path,
      {Map<String, Object?>? query, Object? body, bool auth = true, Map<String, String>? headers}) async {
    calls.add('$method $path');
    final out = handler(method, path, query, body);
    if (out is ApiException) throw out;
    return out;
  }
}

Map<String, Object?> _item(Map<String, Object?> extra) => {
  'id': 'hfrl_1',
  'host': {'slug': 'maya', 'name': 'Maya'},
  'likes': 3500,
  'comments': 12,
  ...extra,
};

void main() {
  group('FeedReel engagement fields', () {
    test('reads likeCounts, commentCounts and likedByMe', () {
      final r = FeedReel.fromJson(_item({
        'likeCounts': {'platform': 2000, 'ours': 1500, 'total': 3500},
        'commentCounts': {'platform': 10, 'ours': 2, 'total': 12},
        'likedByMe': true,
      }));
      expect(r.engagementOn, isTrue);
      expect(r.likeCounts!.platform, 2000);
      expect(r.likeCounts!.ours, 1500);
      expect(r.likeCounts!.total, 3500);
      expect(r.commentCounts!.total, 12);
      expect(r.likedByMe, isTrue);
      expect(r.likes, 3500);
    });

    test('absent likeCounts means engagement is off, old flat numbers still read', () {
      final r = FeedReel.fromJson(_item({}));
      expect(r.engagementOn, isFalse);
      expect(r.likeCounts, isNull);
      expect(r.commentCounts, isNull);
      expect(r.likedByMe, isFalse);
      expect(r.likes, 3500);
      expect(r.comments, 12);
    });

    test('total is computed when the server leaves it out; withHost keeps the fields', () {
      final r = FeedReel.fromJson(_item({'likeCounts': {'platform': 5, 'ours': 2}}));
      expect(r.likeCounts!.total, 7);
      expect(r.withHost(r.host).likeCounts!.total, 7);
    });
  });

  group('comments', () {
    test('parses a page with replies, sources and counts', () {
      final p = CommentsPage.fromJson({
        'counts': {
          'likes': {'platform': 1, 'ours': 2, 'total': 3},
          'comments': {'platform': 4, 'ours': 5, 'total': 9},
        },
        'likedByMe': true,
        'nextCursor': 'abc',
        'items': [
          {
            'id': 'yt:1',
            'source': 'youtube',
            'author': {'name': 'Ravi', 'avatar': null, 'url': 'https://youtube.com/@r'},
            'body': 'Nice',
            'likeCount': 4,
            'createdAt': 1700000000000,
            'mine': false,
          },
          {
            'id': 'hfrc_1',
            'source': 'ours',
            'author': {'name': 'Me'},
            'body': 'Hi',
            'createdAt': 1700000001000,
            'mine': true,
            'replies': [
              {'id': 'hfrc_2', 'source': 'ours', 'author': {'name': 'You'}, 'body': 'Re', 'parentId': 'hfrc_1'},
            ],
          },
        ],
      });
      expect(p.nextCursor, 'abc');
      expect(p.likedByMe, isTrue);
      expect(p.comments!.total, 9);
      expect(p.items[0].source, 'youtube');
      expect(p.items[0].likeCount, 4);
      expect(p.items[1].isOurs, isTrue);
      expect(p.items[1].mine, isTrue);
      expect(p.items[1].replies.single.parentId, 'hfrc_1');
    });

    test('an unknown source is treated as ours and a bare page is safe', () {
      expect(ReelComment.fromJson({'id': 'x', 'source': 'tiktok'}).isOurs, isTrue);
      final p = CommentsPage.fromJson({});
      expect(p.items, isEmpty);
      expect(p.likes, isNull);
    });
  });

  group('ReelEngageRepo', () {
    test('like, unlike, comments, send, delete and report use the contract paths', () async {
      final api = _Api((m, p, q, b) {
        if (p.endsWith('/like')) return {'liked': m == 'POST', 'likes': {'platform': 1, 'ours': m == 'POST' ? 1 : 0, 'total': m == 'POST' ? 2 : 1}};
        if (m == 'GET') return {'items': [], 'counts': {}};
        if (m == 'POST' && p.endsWith('/comments')) {
          return {
            'item': {'id': 'hfrc_9', 'author': {'name': 'Me'}, 'body': (b as Map)['body'], 'mine': true, 'parentId': b['parentId']},
            'counts': {'likes': {'platform': 1, 'ours': 0}, 'comments': {'platform': 3, 'ours': 1}},
          };
        }
        if (p.endsWith('/report')) return {'reported': true, 'hidden': true};
        return {'ok': true};
      });
      final repo = ReelEngageRepo(api);
      final on = await repo.setLike('hfrl_1', true);
      expect(on.liked, isTrue);
      expect(on.likes.total, 2);
      expect((await repo.setLike('hfrl_1', false)).liked, isFalse);
      await repo.comments('hfrl_1', cursor: 'c1');
      final c = await repo.send('hfrl_1', 'Hello', parentId: 'hfrc_1');
      expect(c.item.body, 'Hello');
      expect(c.item.parentId, 'hfrc_1');
      expect(c.comments!.total, 4);
      await repo.delete('hfrc_9');
      final rep = await repo.report('hfrc_9', 'spam');
      expect(rep.reported && rep.hidden, isTrue);
      expect(api.calls, [
        'POST /api/hf/reels/hfrl_1/like',
        'DELETE /api/hf/reels/hfrl_1/like',
        'GET /api/hf/reels/hfrl_1/comments',
        'POST /api/hf/reels/hfrl_1/comments',
        'DELETE /api/hf/reels/comments/hfrc_9',
        'POST /api/hf/reels/comments/hfrc_9/report',
      ]);
    });

    test('error codes become plain sentences', () {
      ApiException e(int s, String c) => ApiException(kind: ApiFailure.http, status: s, code: c);
      expect(engageErrorText(e(422, 'no_links')), contains('Links'));
      expect(engageErrorText(e(422, 'too_long')), contains('too long'));
      expect(engageErrorText(e(422, 'empty')), contains('Write something'));
      expect(engageErrorText(e(429, 'http_429')), contains('too fast'));
      expect(engageErrorText(e(401, 'unauthorized')), contains('sign in'));
      expect(engageErrorText(e(422, 'bad_parent')), contains('no longer there'));
      expect(
        engageErrorText(const ApiException(kind: ApiFailure.http, status: 403, code: 'not_verified', message: 'Please verify your WhatsApp number first.')),
        'Please verify your WhatsApp number first.',
      );
      expect(engageErrorText(e(403, 'not_verified')), contains('verify your WhatsApp'));
      expect(engageErrorText(StateError('x'), fallback: 'fb'), 'fb');
    });
  });

  group('store and text helpers', () {
    test('optimistic like moves our side by one and unliking undoes it', () {
      const s = EngageState(likes: EngageCount(platform: 10, ours: 2), comments: EngageCount());
      final on = s.withLiked(true);
      expect(on.likes.ours, 3);
      expect(on.likes.total, 13);
      expect(on.liked, isTrue);
      expect(on.withLiked(false).likes.total, 12);
    });

    test('seed keeps what the phone already knows', () {
      final store = ReelEngageStore();
      store.seed('a', likes: const EngageCount(platform: 1), comments: const EngageCount());
      store.put('a', store.of('a')!.withLiked(true));
      store.seed('a', likes: const EngageCount(platform: 1), comments: const EngageCount());
      expect(store.of('a')!.liked, isTrue);
    });

    test('breakdown line and time ago', () {
      expect(engageBreakdown(const EngageCount(platform: 1500, ours: 500), 'youtube'), contains('2,000 likes · 1,500 on YouTube · 500 on '));
      expect(engageBreakdown(const EngageCount(platform: 1, ours: 0), 'instagram'), startsWith('1 like · 1 on Instagram'));
      final now = DateTime(2026, 10, 24, 12);
      int ago(Duration d) => now.subtract(d).millisecondsSinceEpoch;
      expect(commentTimeAgo(ago(const Duration(seconds: 5)), now: now), 'just now');
      expect(commentTimeAgo(ago(const Duration(minutes: 5)), now: now), '5 min ago');
      expect(commentTimeAgo(ago(const Duration(hours: 3)), now: now), '3 h ago');
      expect(commentTimeAgo(ago(const Duration(days: 2)), now: now), '2 d ago');
    });
  });
}

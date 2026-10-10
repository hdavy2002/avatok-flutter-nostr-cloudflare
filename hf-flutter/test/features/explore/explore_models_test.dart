import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/brand.dart';
import 'package:hf_app/core/widgets/status_pill.dart';
import 'package:hf_app/features/explore/data/host_card.dart';
import 'package:hf_app/features/explore/data/host_filters.dart';
import 'package:hf_app/features/explore/data/host_options.dart';
import 'package:hf_app/features/explore/widgets/host_image.dart';

import 'explore_test_support.dart';

void main() {
  group('HostFilters', () {
    test('no filters: only limit and offset go to the API (same edge-cache key for everyone)', () {
      expect(HostFilters.none.toApiQuery(limit: 24, offset: 0), {'limit': 24, 'offset': 0});
    });

    test('every filter maps to its API parameter', () {
      const f = HostFilters(
        topics: ['a', 'b'],
        languages: ['hi', 'en'],
        minPrice: 10,
        maxPrice: 30,
        online: true,
        lane: HostLane.women,
        sort: HostSort.priceLow,
      );
      expect(f.toApiQuery(limit: 24, offset: 48), {
        'topic': 'a,b',
        'lang': 'hi,en',
        'minPrice': 10,
        'maxPrice': 30,
        'online': '1',
        'lane': 'women',
        'sort': 'price_low',
        'limit': 24,
        'offset': 48,
      });
    });

    test('the route query round-trips, and junk is dropped', () {
      const f = HostFilters(topics: ['a', 'b'], languages: ['hi'], maxPrice: 20, online: true, lane: HostLane.lgbtq);
      final back = HostFilters.fromRouteQuery(f.toRouteQuery());
      expect(back.sameRequest(f), isTrue);
      expect(f.toLocation(), startsWith('/explore?'));
      final junk = HostFilters.fromRouteQuery({'lane': 'both', 'max': 'abc', 'online': 'maybe', 'topics': ' , ,'});
      expect(junk.lane, isNull);
      expect(junk.maxPrice, isNull);
      expect(junk.online, isFalse);
      expect(junk.topics, isEmpty);
      expect(HostFilters.none.toLocation(), '/explore');
    });

    test('the sort is local: the route cannot carry it', () {
      const a = HostFilters(online: true);
      final b = a.copyWith(sort: HostSort.rating);
      expect(a.sameAsRoute(b), isTrue);
      expect(a.sameRequest(b), isFalse);
      expect(b.toRouteQuery().containsKey('sort'), isFalse);
    });

    test('copyWith can clear a price and the lane', () {
      final f = const HostFilters(maxPrice: 20, lane: HostLane.women).copyWith(maxPrice: null, lane: null);
      expect(f.maxPrice, isNull);
      expect(f.lane, isNull);
    });

    test('the badge counts filters, not the lane', () {
      const f = HostFilters(topics: ['a'], languages: ['hi'], maxPrice: 20, online: true, lane: HostLane.women);
      expect(f.activeCount, 4);
      expect(const HostFilters(lane: HostLane.women).activeCount, 0);
      expect(const HostFilters(sort: HostSort.rating).activeCount, 1);
    });

    test('the cache key does not depend on the order of the choices', () {
      const a = HostFilters(topics: ['a', 'b'], languages: ['hi', 'en']);
      const b = HostFilters(topics: ['b', 'a'], languages: ['en', 'hi']);
      expect(a.cacheKey, b.cacheKey);
      expect(a.cacheKey, isNot(const HostFilters(topics: ['a']).cacheKey));
    });
  });

  group('HostCard', () {
    test('parses a card, with status and numbers', () {
      final c = HostCard.tryParse(hostJson('asha', status: 'busy', price: 12, intro: 'https://x/intro.m4a'))!;
      expect(c.slug, 'asha');
      expect(c.status, HostPresence.busy);
      expect(c.priceLabel, '₹12/min');
      expect(c.rating, 4.8);
      expect(c.hasIntro, isTrue);
      expect(c.introSeconds, 12);
    });

    test('a row without a slug is dropped, and a bad status is offline', () {
      expect(HostCard.tryParse({'displayName': 'No slug'}), isNull);
      expect(HostCard.tryParse({'slug': 'x', 'status': 'weird'})!.status, HostPresence.offline);
      final page = HostsPage.fromJson({
        'items': [
          {'slug': 'ok'},
          {'nope': 1},
          'junk',
        ],
        'nextOffset': 24,
        'total': 99,
      });
      expect(page.items.map((c) => c.slug), ['ok']);
      expect(page.nextOffset, 24);
      expect(page.total, 99);
    });

    test('the cache copy parses back the same', () {
      final page = HostsPage.fromJson(pageJson([hostJson('a'), hostJson('b', status: 'offline')], next: 2, total: 5));
      final back = HostsPage.fromJson(page.toJson());
      expect(back.items.map((c) => '${c.slug}:${c.status.name}'), ['a:online', 'b:offline']);
      expect(back.nextOffset, 2);
      expect(back.total, 5);
    });
  });

  group('HostOptions', () {
    final o = HostOptions.fromJson(optionsJson());

    test('labels, groups and languages come from the server answer', () {
      expect(o.topicLabel('tension-a'), 'Exam tension');
      expect(o.topicLabel('some-unknown-slug'), 'some unknown slug');
      expect(o.topicsOfGroup(o.moodGroups.last), ['tension-a']);
      expect(o.languageCode('hindi'), 'hi');
      expect(o.priceMin, 5);
      expect(o.priceMax, 100);
    });

    test('a broken answer gives empty lists, not a crash', () {
      final e = HostOptions.fromJson('nonsense');
      expect(e.topics, isEmpty);
      expect(e.priceMax, greaterThan(e.priceMin));
    });
  });

  group('resizedImageUrl', () {
    const media = '${Brand.mediaOrigin}/hosts/a/photo.jpg';

    test('our own media goes through Cloudflare resizing, width snapped to a size', () {
      final u = resizedImageUrl(media, width: 250);
      expect(u, '${Brand.mediaOrigin}/cdn-cgi/image/format=webp,quality=60,width=256,fit=cover/hosts/a/photo.jpg');
    });

    test('other hosts, queries, private paths, svg and gif are left alone', () {
      expect(resizedImageUrl('https://elsewhere.example/a.jpg', width: 96), 'https://elsewhere.example/a.jpg');
      expect(resizedImageUrl('$media?sig=1', width: 96), '$media?sig=1');
      expect(resizedImageUrl('${Brand.mediaOrigin}/private/a.jpg', width: 96), '${Brand.mediaOrigin}/private/a.jpg');
      expect(resizedImageUrl('${Brand.mediaOrigin}/a.svg', width: 96), '${Brand.mediaOrigin}/a.svg');
      expect(resizedImageUrl('${Brand.mediaOrigin}/a.gif', width: 96), '${Brand.mediaOrigin}/a.gif');
    });

    test('an already transformed URL is not transformed twice', () {
      final once = resizedImageUrl(media, width: 96);
      expect(resizedImageUrl(once, width: 640), once);
    });
  });
}

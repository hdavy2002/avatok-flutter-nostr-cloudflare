// [HF-SEARCH-FILTERS-1] The Search filters: query parameters, the old-build query, and the intro listing answer.
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/models/search.dart';
import 'package:hf_app/data/models/search_filters.dart';
import 'package:hf_app/data/repos/search_repo.dart';
import 'package:hf_app/demo/search_intro_card.dart';

Map<String, Object?> _card(String slug, {String presence = 'offline', String option = 'A', String? mainAction}) => {
      'id': 'hfin_${slug.padRight(20, '0')}',
      'kind': 'intro',
      'videoUrl': 'https://media.test/$slug.mp4',
      'posterUrl': 'https://media.test/$slug.jpg',
      'host': {'slug': slug, 'name': 'Name $slug', 'handle': '@$slug', 'presence': presence, 'ratePaise': 2000},
      'ratePaise': 2000,
      'callOption': option,
      'callState': option == 'A' ? 'appointments' : 'available',
      if (mainAction != null) 'mainAction': mainAction,
      'categories': [
        {'id': 'comedy', 'label': 'Comedy'}
      ],
      'socials': [
        {'platform': 'youtube', 'handle': slug, 'url': 'https://example.com/$slug'}
      ],
      'greenTick': true,
    };

void main() {
  group('SearchFilters', () {
    test('the default has no parameters and is not "narrowed"', () {
      const f = SearchFilters();
      expect(f.toQuery(), isEmpty);
      expect(f.isDefault, isTrue);
      expect(f.narrows, isFalse);
      expect(f.activeCount, 0);
    });

    test('every filter becomes its server parameter, lists sorted', () {
      final f = const SearchFilters().copyWith(
        categories: {'tech', 'astrology'},
        langs: {'hi', 'en'},
        avail: 'online',
        price: kPriceRanges[1],
        verified: {'youtube', 'facebook'},
        women: true,
        sort: 'price_low',
      );
      expect(f.toQuery(), {
        'category': 'astrology,tech',
        'lang': 'en,hi',
        'avail': 'online',
        'priceMin': '10',
        'priceMax': '20',
        'verified': 'facebook,youtube',
        'women': '1',
        'sort': 'price_low',
      });
      expect(f.activeCount, 7);
      expect(f.copyWith(clearPrice: true).price, isNull);
    });

    test('open price ends send only one bound; sort alone does not narrow', () {
      expect(const SearchFilters().copyWith(price: kPriceRanges.first).toQuery(), {'priceMax': '10'});
      expect(const SearchFilters().copyWith(price: kPriceRanges.last).toQuery(), {'priceMin': '40'});
      final s = const SearchFilters().copyWith(sort: 'newest');
      expect(s.narrows, isFalse);
      expect(s.isDefault, isFalse);
    });
  });

  group('SearchRepo.searchQuery', () {
    test('without filters it is exactly what older builds sent; the LGBTQ+ and KYC values are gone', () {
      expect(SearchRepo.searchQuery(' maya ', topic: 'travel-and-food'), {'q': 'maya', 'topic': 'travel-and-food'});
      expect(SearchRepo.searchQuery('', platform: 'youtube', space: 'women'), {'q': '', 'platform': 'youtube', 'space': 'women'});
      expect(SearchRepo.searchQuery('', space: 'lgbtq'), {'q': ''});
      expect(SearchRepo.searchQuery('', space: 'kyc'), {'q': ''});
    });

    test('with filters the new parameters replace the old ones, with a page size and offset', () {
      final f = const SearchFilters().copyWith(women: true);
      expect(SearchRepo.searchQuery('tamil', topic: 'x', filters: f), {'q': 'tamil', 'women': '1', 'limit': '${SearchRepo.kSearchPage}'});
      expect(SearchRepo.searchQuery('', filters: const SearchFilters(), offset: 30), {'q': '', 'limit': '${SearchRepo.kSearchPage}', 'offset': '30'});
    });

    test('options of the catalogue and the language list parse tolerantly', () {
      final cats = SearchRepo.categoriesOf({
        'categories': [
          {'id': 'astrology', 'label': 'Astrology', 'sensitive': false},
          {'id': 'prayer', 'label': 'Prayer', 'sensitive': true},
          {'label': 'no id'},
        ],
      });
      expect(cats.map((c) => c.id), ['astrology', 'prayer']);
      expect(cats.last.sensitive, isTrue);
      expect(SearchRepo.categoriesOf({}), isEmpty);
      expect(SearchRepo.languagesOf({'languages': [{'code': 'hi', 'label': 'Hindi'}]}).single.label, 'Hindi');
    });
  });

  group('SearchResult', () {
    test('an older server answer is not an intro listing', () {
      final r = SearchResult.fromJson({'ok': true, 'online': [{'slug': 'maya', 'name': 'Maya'}], 'offline': <Object?>[], 'notOnNetwork': <Object?>[]});
      expect(r.intro, isFalse);
      expect(r.items, isEmpty);
      expect(r.isEmpty, isFalse);
    });

    test('an intro answer carries cards, total and the next offset; offline ones are listed with "Book a time"', () {
      final r = SearchResult.fromJson({
        'ok': true,
        'intro': true,
        'items': [_card('kabir'), _card('meera', presence: 'online', option: 'B', mainAction: 'call')],
        'total': 5,
        'nextOffset': 2,
        'online': <Object?>[],
        'offline': <Object?>[],
        'notOnNetwork': <Object?>[],
      });
      expect(r.intro, isTrue);
      expect(r.items.map((i) => i.host.slug), ['kabir', 'meera']);
      expect(r.total, 5);
      expect(r.nextOffset, 2);
      expect(r.isEmpty, isFalse);
      expect(SearchIntroCard.actionLabel(r.items[0]), 'Book a time');
      expect(SearchIntroCard.statusLabel(r.items[0]), 'Offline');
      expect(SearchIntroCard.actionLabel(r.items[1]), 'Call now');
      expect(SearchIntroCard.statusLabel(r.items[1]), 'Online now');
      expect(r.items[0].posterUrl, 'https://media.test/kabir.jpg');
      expect(r.items[0].socials.single.platform, 'youtube');
    });

    test('withMore appends the next page and moves the offset', () {
      final a = SearchResult.fromJson({'intro': true, 'items': [_card('a')], 'total': 2, 'nextOffset': 1});
      final b = SearchResult.fromJson({'intro': true, 'items': [_card('b')], 'total': 2});
      final all = a.withMore(b);
      expect(all.items.map((i) => i.host.slug), ['a', 'b']);
      expect(all.nextOffset, isNull);
    });
  });
}

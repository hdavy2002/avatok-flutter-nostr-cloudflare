/// [HF-SEARCH-FILTERS-1] The Search filters of the app (same set and wording as the web Explore chip row) and how they become
/// query parameters of `GET /api/hf/search`. Match worker/src/lib/hf_intro_search.ts. There is no gender filter.
library;

/// One tickable value (a category or a language). [sensitive] categories (Listener, Prayer, Virtual friend, Women-to-Women) are listed last.
class FilterOption {
  const FilterOption(this.id, this.label, {this.sensitive = false});

  final String id;
  final String label;
  final bool sensitive;
}

/// A price chip: whole rupees a minute, inclusive. A null side is open ("Under 10", "40 and more").
class PriceRange {
  const PriceRange(this.label, {this.min, this.max});

  final String label;
  final int? min;
  final int? max;
}

const List<PriceRange> kPriceRanges = [
  PriceRange('Under ₹10', max: 10),
  PriceRange('₹10–20', min: 10, max: 20),
  PriceRange('₹20–40', min: 20, max: 40),
  PriceRange('₹40+', min: 40),
];

/// `avail`: empty = any time.
const List<(String, String)> kAvailOptions = [('', 'Any time'), ('online', 'Online now'), ('bookings', 'Takes bookings')];

/// `verified`: the platform she proved by logging in.
const List<(String, String)> kVerifiedOptions = [('youtube', 'YouTube'), ('instagram', 'Instagram'), ('facebook', 'Facebook')];

const List<(String, String)> kSortOptions = [
  ('recommended', 'Recommended'),
  ('online', 'Online first'),
  ('price_low', 'Price: low to high'),
  ('newest', 'Newest'),
];

/// Shown when the server's own language list cannot be read (codes match worker/src/lib/hf_options.ts).
const List<FilterOption> kFallbackLanguages = [
  FilterOption('hi', 'Hindi'),
  FilterOption('en', 'English'),
  FilterOption('mr', 'Marathi'),
  FilterOption('bn', 'Bengali'),
  FilterOption('ta', 'Tamil'),
  FilterOption('te', 'Telugu'),
  FilterOption('kn', 'Kannada'),
  FilterOption('ml', 'Malayalam'),
  FilterOption('gu', 'Gujarati'),
  FilterOption('pa', 'Punjabi'),
];

/// Immutable filter state. The default value means "no filter, Recommended order".
class SearchFilters {
  const SearchFilters({
    this.categories = const {},
    this.langs = const {},
    this.avail = '',
    this.price,
    this.verified = const {},
    this.women = false,
    this.sort = 'recommended',
  });

  /// Category ids (any-of).
  final Set<String> categories;

  /// Language codes (any-of).
  final Set<String> langs;

  /// `''`, `online` or `bookings`.
  final String avail;
  final PriceRange? price;

  /// `youtube` / `instagram` / `facebook` (any-of).
  final Set<String> verified;
  final bool women;
  final String sort;

  /// Nothing narrows the list (the sort order does not count).
  bool get narrows => categories.isNotEmpty || langs.isNotEmpty || avail.isNotEmpty || price != null || verified.isNotEmpty || women;

  bool get isDefault => !narrows && sort == 'recommended';

  /// How many filter groups are on, for the badge on the Filters button.
  int get activeCount =>
      (categories.isEmpty ? 0 : 1) +
      (langs.isEmpty ? 0 : 1) +
      (avail.isEmpty ? 0 : 1) +
      (price == null ? 0 : 1) +
      (verified.isEmpty ? 0 : 1) +
      (women ? 1 : 0) +
      (sort == 'recommended' ? 0 : 1);

  SearchFilters copyWith({
    Set<String>? categories,
    Set<String>? langs,
    String? avail,
    PriceRange? price,
    bool clearPrice = false,
    Set<String>? verified,
    bool? women,
    String? sort,
  }) =>
      SearchFilters(
        categories: categories ?? this.categories,
        langs: langs ?? this.langs,
        avail: avail ?? this.avail,
        price: clearPrice ? null : (price ?? this.price),
        verified: verified ?? this.verified,
        women: women ?? this.women,
        sort: sort ?? this.sort,
      );

  /// Query parameters of `GET /api/hf/search`; only what is switched on (the default is an empty map).
  Map<String, Object?> toQuery() {
    List<String> sorted(Set<String> s) => (s.toList()..sort());
    return {
      if (categories.isNotEmpty) 'category': sorted(categories).join(','),
      if (langs.isNotEmpty) 'lang': sorted(langs).join(','),
      if (avail.isNotEmpty) 'avail': avail,
      if (price?.min != null) 'priceMin': '${price!.min}',
      if (price?.max != null) 'priceMax': '${price!.max}',
      if (verified.isNotEmpty) 'verified': sorted(verified).join(','),
      if (women) 'women': '1',
      if (sort != 'recommended') 'sort': sort,
    };
  }
}

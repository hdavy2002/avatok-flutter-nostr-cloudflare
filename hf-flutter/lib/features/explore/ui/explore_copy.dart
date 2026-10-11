/// Copy of the Explore screen and its filter sheet (English only; one file so translation can come later).
abstract final class ExploreCopy {
  static const String title = 'Explore';
  static const String filters = 'Filters';
  static const String showResults = 'Show results';
  static const String clearAll = 'Clear all';
  static const String clearFilters = 'Clear filters';

  static const String emptyAll = 'No hosts are live yet. Check back soon.';
  static const String emptyFiltered = 'No one matches. Try fewer filters.';

  static const String laneAll = 'All';
  static const String laneWomen = 'Women-only';
  static const String laneLgbtq = 'LGBTQ+';

  static const String signInLaneTitle = 'Sign in to enter this space';
  static const String signInLaneBody =
      'Women-only and LGBTQ+ spaces are for verified members. Sign in first.';
  static const String signIn = 'Sign in';
  static const String verifyTitle = 'Verify to join';
  static const String verifyBody =
      'A short verification opens this space for you.';
  static const String verifyButton = 'Verify to join';

  static const String loadMoreFailed = 'Could not load more people.';
  static const String endOfList = 'That is everyone for now.';

  static const String sort = 'Sort by';
  static const String mood = 'Mood';
  static const String language = 'Language';
  static const String price = 'Price per minute';
  static const String anyPrice = 'Any price';
  static const String onlineOnly = 'Online now only';
  static const String optionsFailed = 'We could not load the filter choices.';

  // Discover header and list (mockup Main)
  static const String searchHint = 'Mood, language or name';
  static const String segmentEveryone = 'Everyone';
  static const String allMoods = 'All moods';
  static const String listTitle = 'Good listeners for you';
  static String onlineCount(int n) => '$n online';
  static const String searchMatchesNote = 'in the hosts shown';

  // Filter sheet (mockup Explore)
  static const String sheetTitle = 'Find your person';
  static const String feeling = 'How are you feeling?';
  static String moreTopics(int n) => '+$n more';
  static const String fewerTopics = 'Show fewer';
  static String upTo(int rupees) => 'Up to ₹$rupees';
  static const String onlineOnlyBody = 'Hosts you can call this minute';
  static const String showHostsUnknown = 'Show hosts';
  static String showHosts(int n) => n == 1 ? 'Show 1 host' : 'Show $n hosts';

  static String peopleCount(int n) => n == 1 ? '1 person' : '$n people';

  static String priceRange(int lo, int hi) => '₹$lo – ₹$hi per min';
}

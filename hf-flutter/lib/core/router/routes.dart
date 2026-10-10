/// Every route of the app (spec section 3.2), as path templates plus builders.
/// A screen is added by replacing the stub widget in `lib/features/<x>/ui/`: the route already exists.
abstract final class Routes {
  static const String splash = '/splash';
  static const String home = '/';
  static const String welcome = '/welcome';
  static const String signIn = '/sign-in';
  static const String explore = '/explore';
  static const String hostProfile = '/h/:slug';
  static const String call = '/call/:id';
  static const String reviewCall = '/review/call/:id';
  static const String reviewToken = '/review/:token';
  static const String wallet = '/wallet';
  static const String lanes = '/lanes';
  static const String host = '/host';
  static const String hostOnboarding = '/host/onboarding';
  static const String me = '/me';
  static const String meDelete = '/me/delete';

  // Builders: always use these, never string-concatenate a route in a screen.

  /// `/sign-in?next=<route>`. [next] is where to go after signing in.
  static String signInTo([String? next]) {
    if (next == null || !isSafeNext(next)) return signIn;
    return Uri(path: signIn, queryParameters: {'next': next}).toString();
  }

  static String hostProfileOf(String slug) => '/h/${Uri.encodeComponent(slug)}';
  static String callOf(String id) => '/call/${Uri.encodeComponent(id)}';
  static String reviewCallOf(String id) => '/review/call/${Uri.encodeComponent(id)}';
  static String reviewTokenOf(String token) => '/review/${Uri.encodeComponent(token)}';

  /// `/explore` with optional filters: `lane` (women|lgbtq), `topics` (comma list), `lang`, `max` (rupees), `online`.
  static String exploreWith({String? lane, List<String>? topics, String? lang, int? maxPrice, bool? online}) {
    final q = <String, String>{
      if (lane != null && lane.isNotEmpty) 'lane': lane,
      if (topics != null && topics.isNotEmpty) 'topics': topics.join(','),
      if (lang != null && lang.isNotEmpty) 'lang': lang,
      if (maxPrice != null) 'max': '$maxPrice',
      if (online == true) 'online': '1',
    };
    return q.isEmpty ? explore : Uri(path: explore, queryParameters: q).toString();
  }

  static String lanesOf(String? lane) =>
      (lane == null || lane.isEmpty) ? lanes : Uri(path: lanes, queryParameters: {'lane': lane}).toString();

  static String hostOnboardingAt([String? step]) => (step == null || step.isEmpty)
      ? hostOnboarding
      : Uri(path: hostOnboarding, queryParameters: {'step': step}).toString();

  /// Routes that need a signed-in person (spec 3.2). Matched on the path of the current location.
  static bool needsSignIn(String path) {
    if (path == wallet || path == lanes || path == host || path == me) return true;
    if (path.startsWith('$host/')) return true; // /host/onboarding
    if (path.startsWith('$me/')) return true; // /me/delete
    if (path.startsWith('/call/')) return true;
    if (path.startsWith('/review/call/')) return true;
    return false; // /review/:token needs no sign-in (the token is the credential)
  }

  /// `next` must be an app path. Never an absolute URL, never a protocol-relative `//host`, never sign-in itself.
  static bool isSafeNext(String next) =>
      next.startsWith('/') && !next.startsWith('//') && !next.startsWith(signIn) && !next.startsWith(splash);
}

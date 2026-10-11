/// Every route of the app (spec section 3.2), as path templates plus builders.
/// A screen is added by replacing the stub widget in `lib/features/<x>/ui/`: the route already exists.
abstract final class Routes {
  static const String splash = '/splash';
  static const String home = '/';
  static const String welcome = '/welcome';
  static const String signIn = '/sign-in';
  static const String completeProfile = '/register/name';
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

  static String hostProfileOf(String slug, {String? lane}) {
    final path = '/h/${Uri.encodeComponent(slug)}';
    return lane == 'women' || lane == 'lgbtq' ? Uri(path: path, queryParameters: {'lane': lane!}).toString() : path;
  }
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

  static String callConfirmOf(String slug, {String? lane}) => Uri(
        path: '/call/new',
        queryParameters: {'host': slug, if (lane == 'women' || lane == 'lgbtq') 'lane': lane!},
      ).toString();

  static String walletWithNext(String next) => _withNext(wallet, next);
  static String completeProfileTo(String? next) => _withNext(completeProfile, next);
  static String welcomeTo(String? next) => _withNext(welcome, next);
  static String _withNext(String path, String? next) => safeNext(next) == null ? path : Uri(
        path: path, queryParameters: {'next': next!},
      ).toString();

  static String lanesOf(String? lane, {String? next}) => (lane != 'women' && lane != 'lgbtq' && safeNext(next) == null) ? lanes : Uri(
        path: lanes,
        queryParameters: {
          if (lane == 'women' || lane == 'lgbtq') 'lane': lane!,
          if (safeNext(next) != null) 'next': next!,
        },
      ).toString();

  static String hostOnboardingAt([String? step]) => (step == null || step.isEmpty)
      ? hostOnboarding
      : Uri(path: hostOnboarding, queryParameters: {'step': step}).toString();

  /// Routes that need a signed-in person (spec 3.2). Matched on the path of the current location.
  static bool needsSignIn(String path) {
    if (path == completeProfile || path == welcome || path == wallet || path == host || path == me) return true;
    if (path.startsWith('$host/')) return true; // /host/onboarding
    if (path.startsWith('$me/')) return true; // /me/delete
    if (path.startsWith('/call/')) return true;
    if (path.startsWith('/review/call/')) return true;
    return false; // /review/:token needs no sign-in (the token is the credential)
  }

  /// Only known native destinations. Nested detours may contain one final destination;
  /// auth/welcome/splash, external URLs, controls and recursive gates are rejected.
  static String? safeNext(String? next) => next != null && isSafeNext(next) ? next : null;

  static bool isSafeNext(String next) => _safe(next, 0);

  static bool _safe(String next, int depth) {
    if (depth > 1 || next.length > 2048 || !next.startsWith('/') || next.startsWith('//') ||
        next.contains('\\') || RegExp(r'[\x00-\x20]').hasMatch(next)) return false;
    if (RegExp(r'%2e|%2f|%5c', caseSensitive: false).hasMatch(next.split('?').first)) return false;
    final uri = Uri.tryParse(next);
    if (uri == null || uri.hasScheme || uri.hasAuthority || uri.hasFragment) return false;
    final path = uri.path;
    final known = {home, explore, wallet, lanes, host, hostOnboarding, me, meDelete}.contains(path) ||
        RegExp(r'^/h/[^/]+$').hasMatch(path) || RegExp(r'^/call/[^/]+$').hasMatch(path) ||
        RegExp(r'^/review/(call/)?[^/]+$').hasMatch(path);
    if (!known || uri.pathSegments.any((s) => s == '.' || s == '..' || s.contains('\\'))) return false;
    final allowedKeys = switch (path) {
      home || explore => <String>{'lane', 'topics', 'lang', 'max', 'online'},
      wallet => <String>{'next', 'topup'},
      lanes => <String>{'lane', 'next', 'dl'},
      hostOnboarding => <String>{'step', 'dl'},
      '/call/new' => <String>{'host', 'lane'},
      _ => path.startsWith('/h/') ? <String>{'action', 'notify', 'lane'} : <String>{},
    };
    if (uri.queryParameters.keys.any((key) => !allowedKeys.contains(key))) return false;
    if (uri.queryParametersAll.values.any((values) => values.length != 1)) return false;
    if (uri.queryParameters.values.any((value) => RegExp(r'[\x00-\x1f\x7f]').hasMatch(value))) return false;
    if (path == '/call/new' && (uri.queryParameters['host'] ?? '').isEmpty) return false;
    final nested = uri.queryParameters['next'];
    if (nested != null) {
      if (path != wallet && path != lanes) return false;
      final child = Uri.tryParse(nested);
      if (child == null || child.path == wallet || child.path == lanes || !_safe(nested, depth + 1)) return false;
    }
    return true;
  }
}

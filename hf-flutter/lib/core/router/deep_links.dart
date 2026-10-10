import '../brand.dart';
import 'routes.dart';

/// What to do with an incoming link (an App Link, a custom-scheme link, or a push `data.path`).
sealed class DeepLinkTarget {
  const DeepLinkTarget();
}

/// Go to this app route (path plus query).
final class OpenRoute extends DeepLinkTarget {
  const OpenRoute(this.location);
  final String location;

  @override
  String toString() => 'OpenRoute($location)';
}

/// No screen for it: open the site page in a Custom Tab. NEVER as an external intent: that would bounce
/// back into this app through the App Link.
final class OpenCustomTab extends DeepLinkTarget {
  const OpenCustomTab(this.uri);
  final Uri uri;

  @override
  String toString() => 'OpenCustomTab($uri)';
}

/// The DigiLocker return: run `POST /api/hosts/kyc/digilocker/complete` for the pending context (host or
/// lane), then show [location]. Comes from `<scheme>://hosts/onboarding?step=aadhaar&dl=return` and from
/// `/hosts/kyc/return?app=1`.
final class DigiLockerReturn extends DeepLinkTarget {
  const DigiLockerReturn(this.location);
  final String location;

  @override
  String toString() => 'DigiLockerReturn($location)';
}

/// Not ours (another host or scheme, or a path the app never claims). Do nothing.
final class IgnoreLink extends DeepLinkTarget {
  const IgnoreLink(this.reason);
  final String reason;

  @override
  String toString() => 'IgnoreLink($reason)';
}

/// The path-to-screen table (spec section 3.3, Specs/HF-APP-DEEPLINK.md). Pure and unit-tested:
/// `test/core/deep_links_test.dart` has one test per table row.
///
/// Accepts `https://<domain>/...`, `https://www.<domain>/...`, `<scheme>://...` and bare app paths
/// (`/h/<slug>`, from a push `data.path`). Anything else is ignored.
abstract final class DeepLinks {
  /// Resolve a URL string or a bare path.
  static DeepLinkTarget resolve(String input) {
    final text = input.trim();
    if (text.isEmpty) return const IgnoreLink('empty');
    if (text.startsWith('//')) return const IgnoreLink('protocol_relative'); // never a same-site path
    if (text.startsWith('/')) {
      final uri = Uri.tryParse('${Brand.webOrigin}$text');
      return uri == null ? const IgnoreLink('unparseable') : _resolveSite(uri.pathSegments, uri);
    }
    final uri = Uri.tryParse(text);
    if (uri == null) return const IgnoreLink('unparseable');
    return resolveUri(uri);
  }

  static DeepLinkTarget resolveUri(Uri uri) {
    final scheme = uri.scheme.toLowerCase();
    if (scheme == 'https') {
      final host = uri.host.toLowerCase();
      if (host != Brand.domain && host != Brand.wwwHost) return const IgnoreLink('foreign_host');
      return _resolveSite(uri.pathSegments, uri);
    }
    if (scheme == Brand.scheme) {
      // <scheme>://hosts/onboarding?... : the first path segment arrives as the "host".
      final segments = <String>[if (uri.host.isNotEmpty) uri.host, ...uri.pathSegments];
      return _resolveSite(segments, uri);
    }
    return const IgnoreLink('foreign_scheme');
  }

  /// The path of a link with ids, slugs and tokens replaced by `:id`, and no query. For
  /// `hf_app_deeplink_opened {path, source}`: telemetry never carries a slug or a token.
  static String telemetryPath(String input) {
    final text = input.trim();
    Uri? uri;
    if (text.startsWith('/') && !text.startsWith('//')) {
      uri = Uri.tryParse('${Brand.webOrigin}$text');
    } else {
      uri = Uri.tryParse(text);
    }
    if (uri == null) return '/?';
    final segments = _segmentsOf(uri);
    return _templated(segments);
  }

  /// `link` for an https App Link, `scheme` for the custom scheme. (`push` is passed by the push handler.)
  static String sourceOf(Uri uri) => uri.scheme.toLowerCase() == Brand.scheme ? 'scheme' : 'link';

  static List<String> _segmentsOf(Uri uri) {
    final raw = uri.scheme.toLowerCase() == Brand.scheme ? <String>[if (uri.host.isNotEmpty) uri.host, ...uri.pathSegments] : uri.pathSegments;
    return raw.where((s) => s.isNotEmpty).toList();
  }

  static const Set<String> _idParents = {'h', 'people', 'call', 'book', 'watch', 'l', 'c', 'u'};

  static String _templated(List<String> s) {
    if (s.isEmpty) return '/';
    final out = <String>[];
    for (var i = 0; i < s.length; i++) {
      final prev = i == 0 ? '' : s[i - 1];
      final prev2 = i < 2 ? '' : s[i - 2];
      if (i > 0 && _idParents.contains(prev)) {
        out.add(':id');
      } else if (i > 0 && prev == 'review' && s[i] != 'call') {
        out.add(':id');
      } else if (i > 1 && prev == 'call' && prev2 == 'review') {
        out.add(':id');
      } else {
        out.add(s[i]);
      }
    }
    return '/${out.join('/')}';
  }

  static DeepLinkTarget _resolveSite(List<String> rawSegments, Uri uri) {
    final s = rawSegments.where((e) => e.isNotEmpty).toList();
    final q = uri.queryParameters;
    if (s.isEmpty) return const OpenRoute(Routes.home);

    switch (s[0]) {
      case 'marketplace':
      case 'talk':
        if (s.length == 1) return OpenRoute(_exploreFrom(q));
        break;
      case 'women-only':
        if (s.length == 1) return OpenRoute(Routes.exploreWith(lane: 'women'));
        break;
      case 'lgbtq':
        if (s.length == 1) return OpenRoute(Routes.exploreWith(lane: 'lgbtq'));
        break;
      case 'h':
        if (s.length == 2) return OpenRoute(Routes.hostProfileOf(s[1]));
        break;
      case 'people':
        if (s.length == 2) return const OpenRoute(Routes.explore);
        break;
      case 'wallet':
        if (s.length == 1) return OpenRoute(_withQuery(Routes.wallet, uri));
        break;
      case 'dashboard':
        if (s.length == 2 && s[1] == 'wallet') return OpenRoute(_withQuery(Routes.wallet, uri));
        break;
      case 'review':
        if (s.length == 2) return OpenRoute(Routes.reviewTokenOf(s[1]));
        break;
      case 'hosts':
        return _resolveHosts(s, uri);
      case 'verify':
        if (s.length == 2 && s[1] == 'lane') {
          final lane = q['lane'];
          return OpenRoute(Routes.lanesOf(_isLane(lane) ? lane : null));
        }
        break;
      case 'account':
        if (s.length == 2 && s[1] == 'close') return const OpenRoute(Routes.meDelete);
        break;
      case 'sign-in':
      case 'sign-up':
        return const OpenRoute(Routes.signIn);
      case '.well-known':
      case '_astro':
      case 'api':
        return IgnoreLink('not_a_user_link:${s[0]}');
      case 'admin':
        return OpenCustomTab(_siteUri(s, uri)); // admin stays on the web
    }
    // Help, terms, privacy, safety, shop, guides, events...: the site page in a Custom Tab.
    return OpenCustomTab(_siteUri(s, uri));
  }

  static DeepLinkTarget _resolveHosts(List<String> s, Uri uri) {
    final q = uri.queryParameters;
    if (s.length == 2) {
      switch (s[1]) {
        case 'dashboard':
          return const OpenRoute(Routes.host);
        case 'onboarding':
          if (q['dl'] == 'return') {
            return DigiLockerReturn(_digiLockerLocation(q));
          }
          return OpenRoute(Routes.hostOnboardingAt(_nonEmpty(q['step'])));
        case 'join':
        case 'kyc':
          return OpenRoute(Routes.hostOnboardingAt(_nonEmpty(q['step'])));
      }
    }
    if (s.length == 3 && s[1] == 'kyc' && s[2] == 'return') {
      return DigiLockerReturn(_digiLockerLocation(q));
    }
    // /hosts/rules, /rates, /requirements, /agreement, /crisis-script ...: policy pages, no screen.
    return OpenCustomTab(_siteUri(s, uri));
  }

  static String _digiLockerLocation(Map<String, String> q) {
    final step = _nonEmpty(q['step']) ?? 'aadhaar';
    return Uri(path: Routes.hostOnboarding, queryParameters: {'step': step, 'dl': 'return'}).toString();
  }

  static const Set<String> _exploreKeys = {'lane', 'topics', 'lang', 'max', 'online'};

  static String _exploreFrom(Map<String, String> q) {
    final keep = <String, String>{};
    for (final k in _exploreKeys) {
      final v = q[k];
      if (v == null || v.isEmpty) continue;
      if (k == 'lane' && !_isLane(v)) continue;
      keep[k] = v;
    }
    return keep.isEmpty ? Routes.explore : Uri(path: Routes.explore, queryParameters: keep).toString();
  }

  static String _withQuery(String route, Uri uri) =>
      uri.hasQuery ? Uri(path: route, query: uri.query).toString() : route;

  static bool _isLane(String? v) => v == 'women' || v == 'lgbtq';

  static String? _nonEmpty(String? v) => (v == null || v.isEmpty) ? null : v;

  /// The same page on the website (brand host, no matter which host or scheme the link used).
  static Uri _siteUri(List<String> segments, Uri uri) => Uri(
        scheme: 'https',
        host: Brand.domain,
        pathSegments: segments,
        query: uri.hasQuery ? uri.query : null,
      );
}

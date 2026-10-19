import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:go_router/go_router.dart';

import '../data/telemetry.dart';
import 'brand.dart';

/// A link the app understands, as the screen to open plus the anonymised path for telemetry.
class LinkTarget {
  const LinkTarget(this.location, this.telemetryPath);

  /// A go_router location, for example `/profile/meera` or `/reels?reel=abc`.
  final String location;

  /// The path with ids and slugs replaced by `:id`, the query dropped (`/h/:id`).
  final String telemetryPath;
}

/// Maps a tapped link to a screen, or null when the app has no screen for it.
///
/// Accepted: `https://<domain>/...` and `https://www.<domain>/...`, and the custom scheme
/// `<scheme>://<first segment>/...` (both from the generated brand file). Anything else is ignored.
/// Never routes to `/admin/*`.
///
/// - `/h/<slug>`  -> influencer profile
/// - `/r/<id>`    -> the Reels tab, opened on that reel
/// - `/wallet`    -> wallet
LinkTarget? linkTargetFor(Uri uri) {
  final scheme = uri.scheme.toLowerCase();
  final List<String> segs;
  if (scheme == 'https') {
    final host = uri.host.toLowerCase();
    if (host != Brand.domain && host != Brand.wwwHost) return null;
    segs = uri.pathSegments.where((s) => s.isNotEmpty).toList();
  } else if (scheme == Brand.scheme) {
    // hellofraands://h/meera parses as host "h", path "/meera".
    segs = <String>[if (uri.host.isNotEmpty) uri.host, ...uri.pathSegments.where((s) => s.isNotEmpty)];
  } else {
    return null;
  }
  if (segs.isEmpty || segs.first == 'admin') return null;
  if (segs.length == 2 && segs.first == 'h') {
    return LinkTarget('/profile/${Uri.encodeComponent(segs[1])}', '/h/:id');
  }
  if (segs.length == 2 && segs.first == 'r') {
    return LinkTarget('/reels?reel=${Uri.encodeQueryComponent(segs[1])}', '/r/:id');
  }
  if (segs.length == 1 && segs.first == 'wallet') {
    return const LinkTarget('/wallet', '/wallet');
  }
  return null;
}

/// Listens for links (cold start and while running) and opens the matching screen.
/// The splash calls [markReady] when it hands over to the app; a link that arrives earlier waits.
abstract final class DeepLinks {
  static GoRouter? _router;
  static bool _ready = false;
  static LinkTarget? _pending;
  static String? _lastLocation;
  static DateTime _lastAt = DateTime.fromMillisecondsSinceEpoch(0);
  static StreamSubscription<Uri>? _sub;

  static Future<void> start(GoRouter router) async {
    _router = router;
    try {
      final links = AppLinks();
      final initial = await links.getInitialLink();
      if (initial != null) _handle(initial, 'cold');
      await _sub?.cancel();
      _sub = links.uriLinkStream.listen((u) => _handle(u, 'warm'), onError: (Object _) {});
    } catch (_) {
      // links are a convenience; the app works without them
    }
  }

  /// Called by the splash when the first real screen is up.
  static void markReady() {
    _ready = true;
    final p = _pending;
    _pending = null;
    if (p != null) _open(p);
  }

  static void _handle(Uri uri, String launch) {
    final target = linkTargetFor(uri);
    if (target == null) return;
    // The plugin can deliver the launch link twice (initial + stream); open it once.
    final now = DateTime.now();
    if (_lastLocation == target.location && now.difference(_lastAt) < const Duration(seconds: 2)) return;
    _lastLocation = target.location;
    _lastAt = now;
    Telemetry.deepLinkOpened(path: target.telemetryPath, source: uri.scheme == 'https' ? 'link' : 'scheme', launch: launch);
    if (_ready) {
      _open(target);
    } else {
      _pending = target;
    }
  }

  static void _open(LinkTarget target) {
    final r = _router;
    if (r == null) return;
    try {
      if (target.location.startsWith('/reels')) {
        r.go(target.location);
      } else {
        unawaited(r.push<Object?>(target.location));
      }
    } catch (_) {
      // an unknown location must never crash the app
    }
  }
}

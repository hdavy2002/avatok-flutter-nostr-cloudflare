import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:go_router/go_router.dart';

import '../data/models/booking.dart';
import '../data/services.dart';
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
/// - `/wallet/topup/<id>` -> the Payment screen for that top-up (return from the payment page)
/// - `/bookings/<id>` -> [HF-BOOK-APPROVE] one booking: the influencer's Bookings page on that card, a fan's My bookings
/// - `/bookings`, `/inf/bookings`, `/inf/availability`, `/inf/home`, `/inf/status` -> [HF-BOOK-APPROVE-PUSH] those screens
/// - `/dashboard/appointments`, `/host`, `/hosts/dashboard` -> the same influencer screens, for older web-style push paths
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
  // [HF-WIRE-20] hellofraands://wallet/topup/<id>: where the payment return page sends the payer back. Opens the Payment screen for that order.
  if (segs.length == 3 && segs.first == 'wallet' && segs[1] == 'topup' && RegExp(r'^hftop_[A-Za-z0-9]{6,64}$').hasMatch(segs[2])) {
    return LinkTarget('/payment?order=${Uri.encodeQueryComponent(segs[2])}', '/wallet/topup/:id');
  }
  // [HF-BOOK-APPROVE] The push and WhatsApp booking messages link to /bookings/<booking id> (worker lib/hf_booking_approval.ts).
  if (segs.length == 2 && segs.first == 'bookings' && RegExp(r'^[A-Za-z0-9_-]{8,64}$').hasMatch(segs[1])) {
    return LinkTarget('/bookings/${segs[1]}', '/bookings/:id');
  }
  // [HF-MERCH-APP-1] hellofraands://orders/<id>: where the merch payment page sends the buyer back. Opens that order's tracker.
  if (scheme == Brand.scheme && segs.length == 2 && segs.first == 'orders' && RegExp(r'^[A-Za-z0-9_-]{6,64}$').hasMatch(segs[1])) {
    return LinkTarget('/merch/orders/${segs[1]}?src=link&wait=1', '/orders/:id');
  }
  // [HF-BOOK-APPROVE-PUSH] App-friendly push paths, plus the web-style paths older pushes carried.
  if (segs.length == 1 && segs.first == 'bookings') return const LinkTarget('/bookings', '/bookings');
  if (segs.length == 2 && segs.first == 'inf' && const {'bookings', 'availability', 'home', 'status'}.contains(segs[1])) {
    return LinkTarget('/inf/${segs[1]}', '/inf/${segs[1]}');
  }
  if (segs.length == 2 && segs.first == 'dashboard' && segs[1] == 'appointments') return const LinkTarget('/inf/bookings', '/inf/bookings');
  if (segs.length == 1 && segs.first == 'host') return const LinkTarget('/inf/status', '/inf/status');
  if (segs.length == 2 && segs.first == 'hosts' && segs[1] == 'dashboard') return const LinkTarget('/inf/home', '/inf/home');
  return null;
}

/// A push payload `path` (always same-site and relative, for example `/bookings/<id>`) as a screen, or null.
LinkTarget? linkTargetForPath(String path) {
  if (!path.startsWith('/') || path.startsWith('//') || path.contains('\\')) return null;
  final uri = Uri.tryParse('https://${Brand.domain}$path');
  return uri == null ? null : linkTargetFor(uri);
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
    _dispatch(target, uri.scheme == 'https' ? 'link' : 'scheme', launch);
  }

  /// [HF-BOOK-APPROVE-PUSH] A tapped push notification. [path] is the payload's `path`; [state] is `cold` (the tap
  /// started the app), `background` or `foreground` (OPEN on the in-app banner). Telemetry: `hf_app_push_opened`, then
  /// the usual `hf_app_deeplink_opened` with `source = push`.
  static void openPush(String path, {required String state}) {
    final target = linkTargetForPath(path);
    Telemetry.pushOpened(path: target?.telemetryPath ?? '/unmapped', state: state);
    if (target == null) return;
    _dispatch(target, 'push', state == 'cold' ? 'cold' : 'warm');
  }

  static void _dispatch(LinkTarget target, String source, String launch) {
    // The plugin can deliver the launch link twice (initial + stream); open it once.
    final now = DateTime.now();
    if (_lastLocation == target.location && now.difference(_lastAt) < const Duration(seconds: 2)) return;
    _lastLocation = target.location;
    _lastAt = now;
    Telemetry.deepLinkOpened(path: target.telemetryPath, source: source, launch: launch);
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
      if (target.location.startsWith('/bookings/')) {
        // [HF-BOOK-APPROVE] Role decides the screen. The influencer's page is a tab of the influencer shell, so it is
        // opened with go (a second copy of the shell cannot be pushed); a fan's My bookings is a plain pushed screen.
        unawaited(_openBooking(r, target.location.substring('/bookings/'.length)));
      } else if (target.location.startsWith('/reels') || target.location.startsWith('/inf/')) {
        r.go(target.location); // tabs of a shell (Reels, the influencer's pages) are opened with go
      } else {
        unawaited(r.push<Object?>(target.location));
      }
    } catch (_) {
      // an unknown location must never crash the app
    }
  }

  /// [HF-BOOK-APPROVE-PUSH] One booking: the influencer's Bookings page when she is the host of it, else the fan's My
  /// bookings. Asks the server (her pending, upcoming and past lists) instead of guessing from her account, because one
  /// person can be a fan of some bookings and the host of others. When the server cannot be asked, falls back to
  /// [Services.viewerIsInfluencer].
  static Future<void> _openBooking(GoRouter r, String id) async {
    final enc = Uri.encodeQueryComponent(id);
    var host = Services.instance.viewerIsInfluencer;
    try {
      host = await _isHostBooking(id);
    } catch (_) {
      // keep the fallback
    }
    try {
      if (host) {
        r.go('/inf/bookings?booking=$enc');
      } else {
        unawaited(r.push<Object?>('/bookings?booking=$enc'));
      }
    } catch (_) {
      // an unknown location must never crash the app
    }
  }

  static Future<bool> _isHostBooking(String id) async {
    final s = Services.instance;
    if (!s.isSignedIn) return s.viewerIsInfluencer;
    bool? found; // null = the server could not be asked
    Future<void> look(Future<List<AppBooking>> f) async {
      try {
        final list = await f;
        if (list.any((b) => b.id == id)) {
          found = true;
        } else {
          found ??= false;
        }
      } catch (_) {
        // not a host (403), offline: leave it to the other lists / the fallback
      }
    }

    await Future.wait<void>([
      look(s.bookingsRepo.hostBookings(status: 'pending')),
      look(s.bookingsRepo.hostBookings()),
      look(s.bookingsRepo.hostBookings(status: 'past')),
    ]);
    return found ?? s.viewerIsInfluencer;
  }
}

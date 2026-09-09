// [LIST-DETAIL-EMBED-1 2026-09-09, owner decision] The listing DETAILS page in
// the app IS the website's listing page, shown in an in-app WebView.
//
// WHAT THIS REPLACES. The native details screen
// (features/explore/listing_detail.dart, ~2150 lines: five detail templates, a
// hero carousel, a YouTube hero, a CheckoutSheet, a review sheet). It is not
// deleted — `ListingDetailScreen` now dispatches on
// RemoteConfig.listingWebDetailEnabled and still renders it when that flag is
// off, so the flag is a working brake rather than a switch that turns a feature
// on. Nothing else in the app changed: all fourteen call sites (explore, search,
// marketplace browse, my listings, creator channel, avalive discovery, deep
// links, push) keep pushing `ListingDetailScreen`.
//
// WHY. Same reason as [LIST-EMBED-1] for the create form: one surface, not two.
// The details page is where money is asked for, and the two implementations had
// already diverged — the app's own bar reads "Buy ticket · ₹100" and runs the
// native CheckoutSheet, while the pivot
// (Specs/PIVOT-2026-08-27-MARKETPLACE-FIRST-PAID-SESSIONS.md) says payments are
// WEB ONLY and the app is read-only for money. Showing the web page makes the
// app honest about that by construction instead of by a flag nobody flips.
//
// THE PROTOCOL. Two halves, and they are not the same half:
//
//   1. CHROME — the user agent. `kEmbedUserAgentMarker` is appended to the
//      WebView's UA and web/src/layouts/Base.astro drops SiteHeader/SiteFooter
//      when it sees it. It has to be the UA and not `?embed=1`, because
//      `/l/<id>` 301s to `/<handle>/<slug>` the moment both exist and a
//      redirect drops the query string. It also has to be the UA because the
//      buyer NAVIGATES from here — /book/<id>, then Stripe — and a per-URL
//      param would only dress the first page.
//
//   2. AUTH — the `AvatokHost` channel, exactly as listing_web_form.dart uses
//      it (web/src/lib/embed.ts is the page half; the two files are one
//      protocol and change together). The page asks us for a bearer per
//      request; we answer from the same ApiAuth.clerkBearer every native
//      request uses. Nothing is cached: a Clerk session token lives ~60s.
//      Without it the buyer would be an anonymous visitor on their own listing
//      — no heart, no "you own this", and an email-code sign-in prompt at
//      checkout for an account already signed in three inches above.
//
// A MISSING BRIDGE IS NOT FATAL HERE, unlike the create form. That screen is
// useless without auth, so it shows an error at 20s. This one is a PUBLIC page:
// it reads perfectly with no token, and replacing a working page with "could
// not load" because an island failed to hydrate would be the worse bug. The
// watchdog therefore only reports.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:share_plus/share_plus.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';

class ListingWebDetailScreen extends StatefulWidget {
  const ListingWebDetailScreen({
    super.key,
    required this.listingId,
    this.source = 'unknown',
  });

  final String listingId;

  /// Where the buyer came from — carried into every event on this screen so a
  /// drop-off can be attributed to an entry point rather than to "the page".
  final String source;

  @override
  State<ListingWebDetailScreen> createState() => _ListingWebDetailScreenState();
}

class _ListingWebDetailScreenState extends State<ListingWebDetailScreen> {
  late final WebViewController _controller;

  bool _loading = true;
  String? _fatal;
  bool _bridgeReady = false;
  Timer? _bridgeWatchdog;
  final DateTime _openedAt = DateTime.now();

  /// Whether the WebView has anywhere to go back to. Kept in Dart because the
  /// system Back gesture must not pop this screen while the buyer is two pages
  /// deep in checkout — losing a half-filled payment form is the one
  /// unrecoverable mistake this screen can make.
  bool _canGoBack = false;

  static const Duration _bridgeGrace = Duration(seconds: 20);

  @override
  void initState() {
    super.initState();
    Analytics.capture('listing_web_detail_opened', {
      'listing_id': widget.listingId,
      'source': widget.source,
    });
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(AD.bg)
      // The chrome half of the protocol. Appended to the platform default
      // rather than replacing it: a hand-written UA string loses the Android
      // and Chrome tokens that Stripe's 3-D Secure page and Clerk both
      // fingerprint, and both answer a UA they do not recognise with a
      // "browser not supported" wall.
      ..addJavaScriptChannel('AvatokHost', onMessageReceived: _onHostMessage)
      ..setNavigationDelegate(NavigationDelegate(
        onPageFinished: (_) async {
          if (!mounted) return;
          final back = await _controller.canGoBack();
          if (!mounted) return;
          setState(() {
            _loading = false;
            _canGoBack = back;
          });
        },
        onWebResourceError: (e) {
          // A failed image or font is not the page failing, and treating it as
          // fatal would replace a readable listing with an error screen.
          if (e.isForMainFrame != true) return;
          Analytics.capture('listing_web_detail_error', {
            'listing_id': widget.listingId,
            'source': widget.source,
            'code': e.errorCode,
            'description': e.description,
          });
          if (mounted) {
            setState(() {
              _loading = false;
              _fatal = 'Could not load this listing. Check your connection and try again.';
            });
          }
        },
        onNavigationRequest: _onNavigation,
      ));
    _applyUserAgent();
    _bridgeWatchdog = Timer(_bridgeGrace, () {
      if (!mounted || _bridgeReady) return;
      // Reported, never shown: see the header. The page is public and readable
      // without the bridge; what breaks silently is the buyer's identity.
      Analytics.capture('listing_web_detail_bridge_missing', {
        'listing_id': widget.listingId,
        'source': widget.source,
      });
    });
  }

  /// Read the platform UA and append our marker, then load. The load waits for
  /// this: a request that goes out before the UA is set arrives at the site
  /// looking like an ordinary Chrome visit and comes back WITH the site header,
  /// which is precisely the tell this screen exists to remove.
  Future<void> _applyUserAgent() async {
    String? base;
    try {
      final v = await _controller.runJavaScriptReturningResult('navigator.userAgent');
      base = v is String ? v : v.toString();
      // Android returns the value already JSON-quoted; iOS does not.
      if (base.startsWith('"') && base.endsWith('"') && base.length > 1) {
        base = jsonDecode(base) as String;
      }
    } catch (_) {
      base = null;
    }
    try {
      await _controller.setUserAgent(
        base == null || base.isEmpty ? kEmbedUserAgentMarker : '$base $kEmbedUserAgentMarker',
      );
    } catch (e) {
      // Without the marker the page renders with the website's own header and
      // footer — usable, but obviously a web page. Worth knowing about; not
      // worth blocking the listing over.
      Analytics.capture('listing_web_detail_ua_failed', {'error': '$e'});
    }
    if (!mounted) return;
    await _controller.loadRequest(Uri.parse(listingWebDetailUrl(widget.listingId)));
  }

  @override
  void dispose() {
    _bridgeWatchdog?.cancel();
    super.dispose();
  }

  /// Keep the WebView on the hosts the buying journey actually needs, and no
  /// others. Unlike the create form — which is one page and refuses every
  /// navigation — this screen MUST let the buyer move: the details page's Book
  /// button is a real link to /book/<id>, checkout hands off to Stripe, and
  /// Clerk owns the sign-in hop. Anything else (a creator's link in a
  /// description, an ad) would strand them in a chrome-less WebView, so it is
  /// refused rather than opened.
  NavigationDecision _onNavigation(NavigationRequest request) {
    final uri = Uri.tryParse(request.url);
    final host = uri?.host ?? '';
    final ok = uri != null &&
        (uri.scheme == 'https' || uri.scheme == 'about') &&
        (host.isEmpty ||
            host == 'avatok.ai' ||
            host.endsWith('.avatok.ai') ||
            host.endsWith('.clerk.accounts.dev') ||
            host == 'stripe.com' ||
            host.endsWith('.stripe.com'));
    if (ok) return NavigationDecision.navigate;
    Analytics.capture('listing_web_detail_nav_blocked', {
      'listing_id': widget.listingId,
      'url': request.url,
    });
    return NavigationDecision.prevent;
  }

  // ── host protocol ─────────────────────────────────────────────────────────

  void _onHostMessage(JavaScriptMessage message) {
    Map<String, dynamic> msg;
    try {
      final decoded = jsonDecode(message.message);
      if (decoded is! Map<String, dynamic>) return;
      msg = decoded;
    } catch (_) {
      return; // not ours — the channel is namespaced but be strict anyway
    }
    switch (msg['type']) {
      case 'ready':
        // Deduped. `ready` is sent by an inline script in Base.astro's <head>,
        // so it arrives once per DOCUMENT — and this WebView navigates
        // (/l/<id> -> /book/<id> -> back). Only the first one is the number we
        // care about: time from screen open to a page the buyer can read.
        // Counting the rest would quietly turn `bridge_ms` into "how long the
        // last hop took" and make the median look better the more the buyer
        // clicked.
        if (_bridgeReady) break;
        _bridgeWatchdog?.cancel();
        // [SHIP-GATE-1] The success value for this screen, not the arrival of
        // an event: this fires only when OUR page's bridge handshakes, so it
        // proves the WebView loaded avatok.ai rather than a captive portal or
        // a cached error page served with a 200. `bridge_ms` is how long that
        // took from screen open — the number that says whether replacing a
        // native screen with a web one is usable on Indian mobile data.
        Analytics.capture('listing_web_detail_ready', {
          'listing_id': widget.listingId,
          'source': widget.source,
          'bridge_ms': DateTime.now().difference(_openedAt).inMilliseconds,
        });
        if (mounted) setState(() => _bridgeReady = true);
        break;
      case 'token':
        final id = msg['id'];
        if (id is num) unawaited(_answerToken(id.toInt()));
        break;
      case 'log':
        Analytics.capture('listing_web_detail_page_log', {
          'listing_id': widget.listingId,
          'level': msg['level']?.toString() ?? 'warn',
          'message': msg['message']?.toString() ?? '',
        });
        break;
      // 'dirty' and 'submitted' belong to the create wizard. A details page
      // that posted them would be a bug on the page, not something to act on.
    }
  }

  Future<void> _answerToken(int id) async {
    String? token;
    String outcome = 'ok';
    final startedAt = DateTime.now();
    try {
      token = await ApiAuth.clerkBearer?.call();
      // A null token is not an exception — `clerkBearer` returns null when the
      // session has lapsed — and it is the failure that matters here, because
      // its only symptom is a page that quietly treats the owner of a listing
      // as a stranger.
      if (token == null || token.isEmpty) outcome = 'no_session';
    } catch (e) {
      outcome = 'error';
      Analytics.capture('listing_web_detail_token_failed', {'error': '$e'});
    }
    Analytics.capture('listing_web_detail_token', {
      'listing_id': widget.listingId,
      'source': widget.source,
      'outcome': outcome,
      'ms': DateTime.now().difference(startedAt).inMilliseconds,
    });
    if (!mounted) return;
    // jsonEncode both arguments: a null token must reach the page as JS `null`
    // (which it handles) rather than as the bare word null or an unquoted
    // string that breaks the eval.
    final js = 'window.__avatokEmbedToken && window.__avatokEmbedToken(${jsonEncode(id)}, ${jsonEncode(token)});';
    try {
      await _controller.runJavaScript(js);
    } catch (_) {
      /* the page navigated away mid-request — the page's own timeout covers it */
    }
  }

  // ── navigation ────────────────────────────────────────────────────────────

  /// Back inside the WebView first, then out of the screen. Without this, Back
  /// from the checkout page closes the whole listing instead of returning to
  /// it, and the buyer has to find the listing again to retry a payment.
  Future<void> _back() async {
    if (_fatal == null && await _controller.canGoBack()) {
      await _controller.goBack();
      return;
    }
    if (!mounted) return;
    Analytics.capture('listing_web_detail_closed', {
      'listing_id': widget.listingId,
      'source': widget.source,
      'ready': _bridgeReady,
      'ms': DateTime.now().difference(_openedAt).inMilliseconds,
    });
    Navigator.of(context).maybePop();
  }

  Future<void> _share() async {
    Analytics.capture('listing_web_detail_shared', {'listing_id': widget.listingId});
    // The PUBLIC url, not the one this WebView loaded: `?embed=1` in a friend's
    // browser is harmless but meaningless, and a shared link should be the
    // link the site itself would give out.
    await SharePlus.instance.share(ShareParams(
      uri: Uri.parse('https://avatok.ai/l/${Uri.encodeComponent(widget.listingId)}'),
    ));
  }

  void _retry() {
    setState(() {
      _fatal = null;
      _loading = true;
      _bridgeReady = false;
    });
    _bridgeWatchdog?.cancel();
    _bridgeWatchdog = Timer(_bridgeGrace, () {
      if (!mounted || _bridgeReady) return;
      Analytics.capture('listing_web_detail_bridge_missing', {
        'listing_id': widget.listingId,
        'source': widget.source,
      });
    });
    _controller.loadRequest(Uri.parse(listingWebDetailUrl(widget.listingId)));
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      // The system Back gesture must do what the arrow does, or the in-WebView
      // history is decoration — Back is how most people leave a page.
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        unawaited(_back());
      },
      child: Scaffold(
        backgroundColor: AD.bg,
        appBar: AppBar(
          backgroundColor: AD.headerFooter,
          surfaceTintColor: Colors.transparent,
          foregroundColor: AD.onBandCream,
          elevation: 0,
          automaticallyImplyLeading: false,
          leading: IconButton(
            tooltip: _canGoBack ? 'Back' : 'Close',
            onPressed: () => unawaited(_back()),
            icon: PhosphorIcon(PhosphorIcons.arrowLeft(PhosphorIconsStyle.bold), color: AD.onBandCream),
          ),
          // Deliberately NOT the listing title: it is not known until the page
          // has rendered, and a title bar that changes a second after the
          // screen opens is worse than one that never does. The page prints the
          // title itself, in the approved type.
          title: Text('Listing', style: ADText.appTitle(c: AD.onBandCream)),
          actions: [
            IconButton(
              tooltip: 'Share',
              onPressed: () => unawaited(_share()),
              icon: PhosphorIcon(PhosphorIcons.shareNetwork(PhosphorIconsStyle.regular), color: AD.onBandCream),
            ),
          ],
        ),
        body: SafeArea(
          top: false,
          child: _fatal != null
              ? _fatalState(_fatal!)
              : Stack(children: [
                  WebViewWidget(controller: _controller),
                  if (_loading)
                    const ColoredBox(
                      color: AD.bg,
                      child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
                    ),
                ]),
        ),
      ),
    );
  }

  Widget _fatalState(String message) => Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: Msg.s6),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(PhosphorIcons.warningCircle(PhosphorIconsStyle.regular),
                size: 44, color: AD.textTertiary),
            const SizedBox(height: Msg.s4),
            Text(message, textAlign: TextAlign.center, style: ADText.preview()),
            const SizedBox(height: Msg.s4),
            TextButton(onPressed: _retry, child: Text('Try again', style: ADText.rowName())),
          ]),
        ),
      );
}

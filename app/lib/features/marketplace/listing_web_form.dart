// [LIST-EMBED-1 2026-09-05, owner decision] "Create listing" in the app IS the
// web wizard, shown in an in-app WebView.
//
// WHAT THIS REPLACES. The entry point used to open ComposeChatScreen ("List
// with Ava", compose_chat.dart) — an LLM chat that interviewed the seller and
// wrote the listing. That screen is not deleted, but nothing routes to it while
// `listingWebFormEnabled` is on (see ava_shell.dart / shell/v2/shell_destinations.dart).
//
// WHY. There is one listing form and it lives on the web. The server contract
// for a listing keeps growing — listingContentFieldsError, contentAttrsError,
// commercialPolicyError in worker/src/routes/listings.ts — and every field
// added there had to be built twice, in the Astro wizard and in a Flutter
// screen, or the app would quietly create listings that could not be published.
// One form, two shells.
//
// THE PROTOCOL. The page half is web/src/lib/embed.ts; these two files are one
// protocol and change together. Over the `AvatokHost` channel the page sends:
//
//   {type:'ready'}                  — the bridge is installed
//   {type:'token', id}              — needs a bearer; we answer by calling
//                                     window.__avatokEmbedToken(id, token)
//   {type:'dirty', value}           — would closing now lose typed work?
//   {type:'submitted', id}          — the listing went into the review queue
//   {type:'log', level, message}    — surfaced as telemetry, never as UI
//
// Auth is the reason a channel exists at all: the WebView has no Clerk session,
// so the page asks US for one per request and we call the same
// `ApiAuth.clerkBearer` every native request uses. Nothing is cached on either
// side — a Clerk session token lives ~60 seconds and a creator can spend ten
// minutes in this form, so a cached token would 401 on the final submit, after
// all the typing.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import 'my_listings_screen.dart';

class ListingWebFormScreen extends StatefulWidget {
  const ListingWebFormScreen({
    super.key,
    this.listingId,
    this.source = 'menu',
    this.returnOnSubmit = false,
  });

  /// Resume an existing draft (`?id=`), e.g. from an "unfinished listing" row.
  final String? listingId;

  /// [LIST-EDIT-EMBED-1] Set by callers that ARE My listings (the Edit row), so
  /// submitting pops back to the screen they came from instead of pushing a
  /// second copy of My listings on top of the first one — which would leave Back
  /// landing on a stale duplicate showing the pre-edit card.
  final bool returnOnSubmit;

  /// Where the creator came from — carried into every event on this screen so a
  /// drop-off can be attributed to an entry point rather than to "the form".
  final String source;

  @override
  State<ListingWebFormScreen> createState() => _ListingWebFormScreenState();
}

class _ListingWebFormScreenState extends State<ListingWebFormScreen> {
  late final WebViewController _controller;

  bool _loading = true;
  String? _fatal;
  /// Set by the page. Only ever true while there is typed-but-unsaved text —
  /// a draft that reached the server is resumable from My listings and does not
  /// justify an "are you sure".
  bool _dirty = false;
  /// The page said hello. Its absence after [_bridgeGrace] is the one honest
  /// signal that the WebView loaded something that is not our form (a captive
  /// portal, an error page served with a 200, a stale cached shell).
  bool _bridgeReady = false;
  bool _submitted = false;
  Timer? _bridgeWatchdog;
  final DateTime _openedAt = DateTime.now();

  static const Duration _bridgeGrace = Duration(seconds: 20);

  String get _url => widget.listingId == null || widget.listingId!.isEmpty
      ? kListingWebFormUrl
      : '$kListingWebFormUrl&id=${Uri.encodeQueryComponent(widget.listingId!)}';

  @override
  void initState() {
    super.initState();
    Analytics.capture('listing_web_form_opened', {
      'source': widget.source,
      'resumed': widget.listingId != null,
    });
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(AD.bg)
      ..addJavaScriptChannel('AvatokHost', onMessageReceived: _onHostMessage)
      ..setNavigationDelegate(NavigationDelegate(
        onPageFinished: (_) { if (mounted) setState(() => _loading = false); },
        onWebResourceError: (e) {
          // Sub-resource failures (an image, a font) are not the page failing,
          // and treating them as fatal would replace a working form with an
          // error screen. Only the main document counts.
          if (e.isForMainFrame != true) return;
          Analytics.capture('listing_web_form_error', {
            'source': widget.source,
            'code': e.errorCode,
            'description': e.description,
          });
          if (mounted) {
            setState(() {
              _loading = false;
              _fatal = 'Could not load the listing form. Check your connection and try again.';
            });
          }
        },
        onNavigationRequest: _onNavigation,
      ));
    _installAndroidFilePicker();
    _controller.loadRequest(Uri.parse(_url));
    _bridgeWatchdog = Timer(_bridgeGrace, () {
      if (!mounted || _bridgeReady || _fatal != null) return;
      Analytics.capture('listing_web_form_bridge_missing', {'source': widget.source});
      setState(() => _fatal = 'The listing form did not finish loading. Try again in a moment.');
    });
  }

  @override
  void dispose() {
    _bridgeWatchdog?.cancel();
    super.dispose();
  }

  /// The web form's photo step is a plain `<input type="file">`. Android's
  /// WebView does NOT open a picker for one unless the host app supplies a file
  /// selector — with no `setOnShowFileSelector` the tap does nothing at all, no
  /// picker and no error, which reads as a broken button. image_picker is
  /// already a dependency and gives the same sheet the rest of the app uses.
  Future<void> _installAndroidFilePicker() async {
    final platform = _controller.platform;
    if (platform is! AndroidWebViewController) return;
    await platform.setOnShowFileSelector((FileSelectorParams params) async {
      try {
        final picker = ImagePicker();
        if (params.mode == FileSelectorMode.openMultiple) {
          final files = await picker.pickMultiImage();
          return files.map((f) => Uri.file(f.path).toString()).toList();
        }
        final file = await picker.pickImage(source: ImageSource.gallery);
        return file == null ? const <String>[] : [Uri.file(file.path).toString()];
      } catch (e) {
        Analytics.capture('listing_web_form_file_pick_failed', {'error': '$e'});
        return const <String>[];
      }
    });
  }

  /// Keep the WebView on our own form. Anything else the page links to (terms,
  /// a public listing preview, a help page) is a real navigation the creator
  /// cannot come back from inside a chrome-less WebView, so it is refused here
  /// rather than silently stranding them on a page with no back button.
  NavigationDecision _onNavigation(NavigationRequest request) {
    final uri = Uri.tryParse(request.url);
    final ok = uri != null &&
        (uri.scheme == 'https' || uri.scheme == 'about') &&
        (uri.host.isEmpty || uri.host == 'avatok.ai' || uri.host.endsWith('.avatok.ai') || uri.host.endsWith('.clerk.accounts.dev'));
    if (ok) return NavigationDecision.navigate;
    Analytics.capture('listing_web_form_nav_blocked', {'url': request.url});
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
        _bridgeWatchdog?.cancel();
        // [SHIP-GATE-1] The success value for this feature, not just "an event
        // arrived": the WebView loaded OUR form (not a captive portal or a
        // cached error page) and the JS bridge handshook. `bridge_ms` is how
        // long that took from screen open — the number that says whether this
        // is usable on a real Indian phone on mobile data.
        Analytics.capture('listing_web_form_ready', {
          'source': widget.source,
          'bridge_ms': DateTime.now().difference(_openedAt).inMilliseconds,
        });
        if (mounted) setState(() => _bridgeReady = true);
        break;
      case 'token':
        final id = msg['id'];
        if (id is num) unawaited(_answerToken(id.toInt()));
        break;
      case 'dirty':
        _dirty = msg['value'] == true;
        break;
      case 'submitted':
        _onSubmitted(msg['id']?.toString());
        break;
      case 'log':
        Analytics.capture('listing_web_form_page_log', {
          'level': msg['level']?.toString() ?? 'warn',
          'message': msg['message']?.toString() ?? '',
        });
        break;
    }
  }

  Future<void> _answerToken(int id) async {
    String? token;
    String outcome = 'ok';
    final startedAt = DateTime.now();
    try {
      token = await ApiAuth.clerkBearer?.call();
      // [SHIP-GATE-1] A null token is not an exception — `clerkBearer` returns
      // null when the session has lapsed — and it is the failure that matters
      // most here, because the page's only symptom is a form that saves
      // nothing. `outcome` is the assertable success value: `ok` means auth
      // genuinely crossed the bridge, `no_session`/`error` mean it did not.
      if (token == null || token.isEmpty) outcome = 'no_session';
    } catch (e) {
      outcome = 'error';
      Analytics.capture('listing_web_form_token_failed', {'error': '$e'});
    }
    Analytics.capture('listing_web_form_token', {
      'source': widget.source,
      'outcome': outcome,
      'ms': DateTime.now().difference(startedAt).inMilliseconds,
    });
    if (!mounted) return;
    // jsonEncode both arguments: a null token must reach the page as JS `null`
    // (which it handles — it stops and shows a sign-in error) rather than as the
    // bare word null or, worse, an unquoted string that breaks the eval.
    final js = 'window.__avatokEmbedToken && window.__avatokEmbedToken(${jsonEncode(id)}, ${jsonEncode(token)});';
    try {
      await _controller.runJavaScript(js);
    } catch (_) {
      /* the page navigated away mid-request — the page's own timeout covers it */
    }
  }

  void _onSubmitted(String? listingId) {
    if (_submitted || !mounted) return;
    _submitted = true;
    _dirty = false;
    Analytics.capture('listing_web_form_submitted', {
      'source': widget.source,
      'listing_id': listingId ?? '',
      'edited': widget.listingId != null,
    });
    if (widget.returnOnSubmit) {
      Navigator.of(context).pop(true);
      return;
    }
    // Owner's flow: the creator lands on My listings and sees their card with
    // "Review pending" on it. pushReplacement, not push — the half-filled form
    // behind us is finished business and Back from My listings should return to
    // wherever they started, not to a submitted form.
    Navigator.of(context).pushReplacement(MaterialPageRoute(
      builder: (_) => const MyListingsScreen(highlightPendingReview: true),
    ));
  }

  // ── close ─────────────────────────────────────────────────────────────────

  Future<bool> _confirmClose() async {
    if (!_dirty || _submitted) return true;
    final leave = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AD.menu,
        title: Text('Leave without saving?', style: ADText.rowName()),
        content: Text(
          'You have not saved this listing yet. Close now and what you typed is gone.',
          style: ADText.preview(),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text('Keep editing', style: ADText.rowName()),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text('Discard', style: ADText.rowName(c: AD.danger)),
          ),
        ],
      ),
    );
    return leave == true;
  }

  Future<void> _close() async {
    if (!await _confirmClose()) return;
    Analytics.capture('listing_web_form_closed', {
      'source': widget.source,
      'dirty': _dirty,
      'submitted': _submitted,
    });
    if (mounted) Navigator.of(context).maybePop();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      // The system Back gesture must ask the same question the ✕ does, or the
      // confirm is decoration — Back is how most people leave a screen.
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        // Resolve the navigator BEFORE the await — the dialog is an async gap
        // and `context` must not be read across it.
        final nav = Navigator.of(context);
        if (await _confirmClose()) nav.pop();
      },
      child: Scaffold(
        backgroundColor: AD.bg,
        appBar: AppBar(
          backgroundColor: AD.headerFooter,
          surfaceTintColor: Colors.transparent,
          foregroundColor: AD.onBandCream,
          elevation: 0,
          automaticallyImplyLeading: false,
          title: Text('New listing', style: ADText.appTitle(c: AD.onBandCream)),
          actions: [
            IconButton(
              tooltip: 'Close',
              onPressed: _close,
              icon: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold), color: AD.onBandCream),
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
            TextButton(
              onPressed: () {
                setState(() { _fatal = null; _loading = true; _bridgeReady = false; });
                _bridgeWatchdog?.cancel();
                _bridgeWatchdog = Timer(_bridgeGrace, () {
                  if (!mounted || _bridgeReady || _fatal != null) return;
                  setState(() => _fatal = 'The listing form did not finish loading. Try again in a moment.');
                });
                _controller.loadRequest(Uri.parse(_url));
              },
              child: Text('Try again', style: ADText.rowName()),
            ),
          ]),
        ),
      );
}

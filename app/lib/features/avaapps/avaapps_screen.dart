import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/app_icon_cache.dart';
import '../../core/apps_service.dart';
import '../../core/money_api.dart';
import '../../core/paid_feature.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// AvaApps (PREMIUM · Powered by Composio) — browse the full Composio app
/// catalog, connect/disconnect each app with one tap (green dot = connected),
/// then ask Ava to act across them. Connecting + running are premium (top up).
class AvaAppsScreen extends StatefulWidget {
  const AvaAppsScreen({super.key});
  @override
  State<AvaAppsScreen> createState() => _AvaAppsScreenState();
}

class _AvaAppsScreenState extends State<AvaAppsScreen> with WidgetsBindingObserver {
  final _q = TextEditingController();
  final _ask = TextEditingController();
  List<AvaCatalogApp> _all = [];
  Set<String> _connected = {};
  String _filter = '';
  bool _loading = true, _running = false, _premium = false;
  String? _answer;

  /// Memoized logo futures (one per url) so scroll / search rebuilds reuse the
  /// in-flight or cached fetch instead of re-requesting + flashing the fallback.
  final Map<String, Future<Uint8List?>> _iconFutures = {};

  /// True between launching the in-app OAuth tab and the user returning, so we
  /// refresh connection status the moment the app resumes.
  bool _awaitingConnect = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _q.dispose();
    _ask.dispose();
    super.dispose();
  }

  /// When the in-app browser tab closes, the app resumes — pull fresh status so
  /// a just-connected app lights up its green dot without a manual refresh.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _awaitingConnect) {
      _awaitingConnect = false;
      _load();
    }
  }

  Future<void> _load() async {
    final t0 = DateTime.now();
    final results = await Future.wait([
      AppsService.I.catalog(),
      AppsService.I.status(),
      MoneyApi.balance(),
    ]);
    if (!mounted) return;
    final bal = results[2] as Map<String, dynamic>;
    final connected = results[1] as Set<String>;
    setState(() {
      _all = results[0] as List<AvaCatalogApp>;
      _connected = connected;
      _premium = bal['premium'] == 1 || bal['premium'] == true;
      _loading = false;
    });
    // Phase 0 telemetry: screen-open latency + how many apps are connected.
    // ignore: unawaited_futures
    Analytics.capture('avaapps_screen_open', {
      'status_fetch_ms': DateTime.now().difference(t0).inMilliseconds,
      'connected_count': connected.length,
    });
  }

  /// Instant local filter. Matches name OR slug from the first keystroke, and
  /// SORTS so apps whose name/slug START with the query surface first (so typing
  /// "goo" puts the Google apps at the top immediately).
  List<AvaCatalogApp> get _visible {
    if (_filter.isEmpty) return _all;
    final q = _filter.toLowerCase();
    final hits = _all
        .where((a) => a.name.toLowerCase().contains(q) || a.slug.toLowerCase().contains(q))
        .toList();
    int rank(AvaCatalogApp a) {
      final n = a.name.toLowerCase(), s = a.slug.toLowerCase();
      if (n.startsWith(q) || s.startsWith(q)) return 0; // best: starts-with
      return 1;                                         // else: contains
    }
    hits.sort((a, b) {
      final r = rank(a).compareTo(rank(b));
      return r != 0 ? r : a.name.toLowerCase().compareTo(b.name.toLowerCase());
    });
    return hits;
  }

  Future<void> _onTap(AvaCatalogApp app) async {
    final isOn = _connected.contains(app.slug);
    if (isOn) {
      final yes = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          backgroundColor: Zine.card,
          shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(Zine.rSm),
              side: const BorderSide(color: Zine.ink, width: Zine.bw)),
          title: Text('Disconnect ${app.name}?', style: ZineText.cardTitle()),
          content: Text('Ava will no longer be able to act on your ${app.name}. '
              'You can reconnect anytime.', style: ZineText.sub(size: 13.5)),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false),
                child: Text('Cancel', style: ZineText.value(size: 14))),
            TextButton(onPressed: () => Navigator.pop(ctx, true),
                child: Text('Disconnect', style: ZineText.value(size: 14, color: Zine.coral))),
          ],
        ),
      );
      if (yes != true) return;
      final r = await AppsService.I.disconnect(app.slug);
      if (!mounted) return;
      if (r.premium) { _showTopUp(); return; }
      await _load();
      return;
    }
    // Connect (premium).
    final r = await AppsService.I.connectSlug(app.slug);
    if (!mounted) return;
    if (r.premium) { _showTopUp(); return; }
    if (r.url.isNotEmpty) {
      // Open the OAuth flow in an IN-APP browser tab (Android Custom Tabs /
      // iOS SFSafariViewController) so the user stays inside AvaApps and slides
      // right back to this grid when done. We deliberately do NOT use a raw
      // WebView: Google blocks OAuth in embedded webviews (disallowed_useragent).
      // A Custom Tab IS a real browser, so Google sign-in works.
      // ignore: unawaited_futures
      Analytics.capture('avaapps_connect_open', {'slug': app.slug, 'mode': 'in_app_tab'});
      _awaitingConnect = true;
      final uri = Uri.parse(r.url);
      var opened = false;
      try {
        opened = await launchUrl(uri, mode: LaunchMode.inAppBrowserView);
      } catch (_) {/* fall back below */}
      if (!opened) {
        // Custom Tabs unavailable (rare) → external browser still completes it.
        try {
          opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
        } catch (_) {/* surfaced via snackbar below */}
      }
      if (!opened) _awaitingConnect = false;
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(opened
                ? 'Authorize ${app.name} — you’ll come right back here.'
                : 'Couldn’t open the ${app.name} sign-in. Please try again.')));
      }
      if (opened) {
        // ignore: unawaited_futures
        _pollConnected(app);
      }
    } else {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('${app.name} is already connected ✓')));
    }
  }

  /// After launching the OAuth tab, poll status a few times so the green dot
  /// appears as soon as Composio marks the account ACTIVE — covering the case
  /// where it connects while the tab is still open (the resume refresh covers
  /// the rest).
  Future<void> _pollConnected(AvaCatalogApp app) async {
    for (final delay in const [
      Duration(seconds: 2),
      Duration(seconds: 3),
      Duration(seconds: 4),
      Duration(seconds: 6),
    ]) {
      await Future.delayed(delay);
      if (!mounted) return;
      final connected = await AppsService.I.status();
      if (!mounted) return;
      final justConnected =
          connected.contains(app.slug) && !_connected.contains(app.slug);
      if (connected.length != _connected.length || justConnected) {
        setState(() => _connected = connected);
      }
      if (justConnected) {
        // ignore: unawaited_futures
        Analytics.capture('avaapps_connected', {'slug': app.slug});
        return;
      }
    }
  }

  void _showTopUp() =>
      AvaWalletHook.instance.openTopUp(context, suggestedUsd: kMinTopUpUsd);

  Future<void> _run() async {
    final query = _ask.text.trim();
    if (query.isEmpty || _running) return;
    final t0 = DateTime.now();
    // ignore: unawaited_futures
    Analytics.capture('avaapps_query_submitted', {'query_chars': query.length});
    setState(() { _running = true; _answer = null; });
    try {
      final a = await AppsService.I.run(query);
      if (mounted) setState(() => _answer = a);
      // ignore: unawaited_futures
      Analytics.capture('avaapps_result_rendered', {
        'total_ms': DateTime.now().difference(t0).inMilliseconds,
        'answer_len': a.length,
      });
    } finally {
      if (mounted) setState(() => _running = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'AvaApps', markWord: 'Apps'),
      body: RefreshIndicator(
        onRefresh: _load,
        child: CustomScrollView(
          // Always scrollable so pull-to-refresh works even when content is short.
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            // Header (intro, search) — fixed, non-grid content.
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(20, 20, 20, 0),
              sliver: SliverList(delegate: SliverChildListDelegate([
          Row(children: [
            Expanded(child: Text('Connect your apps and let Ava act across them — read '
                'email, find a file, create a doc, check your calendar.',
                style: ZineText.sub(size: 13.5))),
            const SizedBox(width: 8),
            _premiumBadge(),
          ]),
          const SizedBox(height: 6),
          Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(PhosphorIcons.lightning(PhosphorIconsStyle.fill), size: 12, color: Zine.inkMute),
            const SizedBox(width: 4),
            Text('Powered by Composio', style: ZineText.sub(size: 11.5, color: Zine.inkMute)),
          ]),
          const SizedBox(height: 14),
          // Search filter on top.
          Container(
            decoration: BoxDecoration(
              color: Zine.card,
              borderRadius: BorderRadius.circular(Zine.rField),
              border: Border.all(color: Zine.ink, width: 2),
            ),
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold), size: 18, color: Zine.inkSoft),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: _q,
                  style: ZineText.input(size: 15),
                  onChanged: (v) => setState(() => _filter = v.trim()),
                  decoration: InputDecoration(
                    border: InputBorder.none, isDense: true,
                    hintText: 'Search apps…',
                    hintStyle: ZineText.sub(size: 14, color: Zine.placeholder),
                  ),
                ),
              ),
            ]),
          ),
          const SizedBox(height: 14),
          if (_loading)
            const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator())),
          if (!_loading && _visible.isEmpty)
            Padding(padding: const EdgeInsets.all(20),
                child: Center(child: Text('No apps found.', style: ZineText.sub(size: 13)))),
              ])),
            ),
            // The icon grid — a LAZY SliverGrid so only the on-screen tiles build.
            // Previously this was a shrink-wrapped GridView inside a ListView, which
            // forces Flutter to build ALL ~300 tiles at once on every open → every
            // icon's AppIconCache.get() fired each open (looked like a full
            // re-download). As a real sliver it builds ~one screenful, so each open
            // loads only the visible icons (from disk after first fetch).
            if (!_loading && _visible.isNotEmpty)
              SliverPadding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                sliver: SliverGrid(
                  gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: 4,
                    crossAxisSpacing: 10,
                    mainAxisSpacing: 18,
                    childAspectRatio: 0.74,
                  ),
                  delegate: SliverChildBuilderDelegate(
                    (_, i) => _appTile(_visible[i]),
                    childCount: _visible.length,
                  ),
                ),
              ),
            // Trailing content (Ask Ava, answer, tip).
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(20, 24, 20, 20),
              sliver: SliverList(delegate: SliverChildListDelegate([
          Text('ASK AVA', style: ZineText.kicker()),
          const SizedBox(height: 10),
          ZineCard(
            radius: Zine.rSm, padding: const EdgeInsets.all(12), boxShadow: Zine.shadowXs,
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              TextField(
                controller: _ask, minLines: 2, maxLines: 4,
                style: ZineText.input(size: 15), cursorColor: Zine.blueInk,
                decoration: InputDecoration(
                  hintText: 'e.g. "Find me my latest email" · "Create a doc with my notes"',
                  hintStyle: ZineText.input(size: 14).copyWith(color: Zine.placeholder),
                  border: InputBorder.none, isDense: true,
                ),
              ),
              const SizedBox(height: 8),
              ZineButton(
                label: 'Run', onPressed: _running ? null : _run,
                fullWidth: true, fontSize: 15, loading: _running,
                variant: ZineButtonVariant.blue,
                icon: PhosphorIcons.sparkle(PhosphorIconsStyle.bold), trailingIcon: false,
              ),
            ]),
          ),
          if (_answer != null) ...[
            const SizedBox(height: 14),
            ZineCard(
              radius: Zine.rSm, padding: const EdgeInsets.all(14), boxShadow: Zine.shadowXs,
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                ZineIconBadge(icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill), color: Zine.lilac, size: 30),
                const SizedBox(width: 12),
                Expanded(child: SelectableText(_answer!, style: ZineText.value(size: 14.5))),
              ]),
            ),
          ],
          const SizedBox(height: 16),
          Center(child: Text('Tip: from any chat, type "@ava …" to use your apps inline',
              style: ZineText.sub(size: 11.5, color: Zine.inkMute))),
              ])),
            ),
          ],
        ),
      ),
    );
  }

  Widget _appTile(AvaCatalogApp app) {
    final on = _connected.contains(app.slug);
    // Pro/live launch: only allow-listed connectors (Gmail + Outlook) are live;
    // the rest are greyed with a "Soon" badge and tap to a coming-soon notice.
    final enabled = isAppEnabled(app.slug);
    final tile = GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => enabled ? _onTap(app) : _showComingSoon(app),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Stack(clipBehavior: Clip.none, children: [
          Opacity(
            opacity: enabled ? 1 : 0.4,
            child: Container(
              width: 64, height: 64,
              decoration: BoxDecoration(
                color: Colors.white, // white plate makes brand colors pop
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: Zine.ink, width: 2),
                boxShadow: Zine.shadowXs,
              ),
              clipBehavior: Clip.antiAlias,
              padding: const EdgeInsets.all(11),
              child: _appLogo(app),
            ),
          ),
          if (on && enabled)
            Positioned(
              right: -4, top: -4,
              child: Container(
                width: 18, height: 18,
                decoration: BoxDecoration(
                  color: const Color(0xFF22C55E), // green = connected
                  shape: BoxShape.circle,
                  border: Border.all(color: Zine.ink, width: 2),
                ),
                child: const Icon(Icons.check, size: 10, color: Colors.white),
              ),
            ),
          if (!enabled)
            Positioned(
              right: -6, top: -6,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: Zine.inkMute,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: Zine.ink, width: 1.5),
                ),
                child: Text('Soon',
                    style: ZineText.sub(size: 8.5, color: Colors.white)),
              ),
            ),
        ]),
        const SizedBox(height: 6),
        Text(app.name, maxLines: 1, overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: ZineText.sub(size: 11, color: enabled ? Zine.ink : Zine.inkMute)),
      ]),
    );
    return tile;
  }

  /// Greyed connector tapped — tell the user it's on the way (no server call).
  void _showComingSoon(AvaCatalogApp app) {
    Analytics.capture('avaapps_coming_soon', {'slug': app.slug});
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('${app.name} is coming soon. Gmail and Outlook are '
            'available now.')));
  }

  /// The real, colorful brand logo, served local-first from [AppIconCache] so it
  /// is fetched ONCE and then loaded instantly from disk on every later open
  /// (no re-download per app launch). Composio serves logos as SVG
  /// (logos.composio.dev/api/<slug>) or raster — we sniff the bytes and render
  /// the right widget. A colored monogram (never a grey grid icon) shows while
  /// loading or if the logo is missing, so the grid always looks branded.
  Widget _appLogo(AvaCatalogApp app) {
    final url = app.logo.isNotEmpty ? app.logo : _composioLogo(app.slug);
    final mono = _monogram(app);
    // Already in the in-session cache → render synchronously, zero flash.
    final hot = AppIconCache.cached(url);
    if (hot != null) return _bytesLogo(hot, mono);
    return FutureBuilder<Uint8List?>(
      future: _iconFutures[url] ??= AppIconCache.get(url),
      builder: (_, snap) {
        final bytes = snap.data;
        if (bytes == null) return mono; // loading or failed → branded fallback
        return _bytesLogo(bytes, mono);
      },
    );
  }

  Widget _bytesLogo(Uint8List bytes, Widget mono) {
    if (AppIconCache.isSvg(bytes)) {
      return SvgPicture.memory(bytes, fit: BoxFit.contain,
          placeholderBuilder: (_) => mono);
    }
    return Image.memory(bytes, fit: BoxFit.contain,
        errorBuilder: (_, __, ___) => mono);
  }

  String _composioLogo(String slug) => 'https://logos.composio.dev/api/$slug';

  /// Colored first-letter tile — the always-on, never-grey fallback.
  Widget _monogram(AvaCatalogApp app) {
    const palette = [Zine.blue, Zine.lilac, Zine.coral, Zine.mint, Zine.lime];
    final c = palette[app.slug.hashCode.abs() % palette.length];
    final src = app.name.isNotEmpty ? app.name : app.slug;
    final letter = (src.isNotEmpty ? src.substring(0, 1) : '?').toUpperCase();
    return Container(
      decoration: BoxDecoration(color: c, borderRadius: BorderRadius.circular(8)),
      alignment: Alignment.center,
      child: Text(letter,
          style: ZineText.cardTitle(size: 20, color: Zine.ink)),
    );
  }

  /// Top-right status pill. BETA PHASE: server reports all users premium → the
  /// green pill shows for everyone and reads "BETA PHASE". Post-beta it reverts to
  /// the topped-up green pill / ghost "PREMIUM" crown upsell automatically.
  Widget _premiumBadge() {
    if (!_premium) {
      return ZineSticker('PREMIUM', kind: ZineStickerKind.hint,
          icon: PhosphorIcons.crown(PhosphorIconsStyle.fill));
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
      decoration: BoxDecoration(
        color: Zine.mint, // money/success green
        borderRadius: BorderRadius.circular(100),
        border: Border.all(color: Zine.ink, width: Zine.bw),
        boxShadow: Zine.shadowXs,
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(PhosphorIcons.sealCheck(PhosphorIconsStyle.fill), size: 14, color: Zine.mintInk),
        const SizedBox(width: 6),
        Text('BETA-FREE', style: ZineText.tag(size: 12, color: Zine.mintInk)),
      ]),
    );
  }
}

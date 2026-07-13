import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/app_icon_cache.dart';
import '../../core/apps_service.dart';
import '../../core/avaapps_cache.dart';
import '../../core/money_api.dart';
import '../../core/paid_feature.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/ui/avatok_dark.dart';

/// Inline dark v2 page header (AD.headerFooter bar + back button + title).
/// Replaces the light ZineAppBar — the AdBackButton's white glyph would be
/// invisible on a light bar.
class _DarkHeader extends StatelessWidget implements PreferredSizeWidget {
  final String title;
  const _DarkHeader({required this.title});
  @override
  Size get preferredSize => const Size.fromHeight(60);
  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: AD.headerFooter,
        border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
      ),
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(8, 6, 18, 10),
          child: Row(children: [
            const AdBackButton(),
            const SizedBox(width: 6),
            Expanded(
              child: Text(title, style: ADText.appTitle(),
                  maxLines: 1, overflow: TextOverflow.ellipsis),
            ),
          ]),
        ),
      ),
    );
  }
}

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
  /// "as of <time>" label shown while a cached answer is being revalidated
  /// (stale-while-revalidate); cleared once the fresh answer lands.
  String? _answerAsOf;
  /// Live per-step status line during a streaming run ("Checking Gmail…").
  String? _status;

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
    // Phase 5: prefetch — warm the server conn/decl caches for the first query.
    // ignore: unawaited_futures
    AppsService.I.warm();
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
      // Just returned from an OAuth tab → force-refresh past the server cache.
      _load(fresh: true);
    }
  }

  Future<void> _load({bool fresh = false}) async {
    final t0 = DateTime.now();
    // Phase 2: render the last-known connection status INSTANTLY from the
    // per-account device cache (zero awaited network), then refresh in the
    // background (stale-while-revalidate). Skipped on a forced fresh reload.
    if (!fresh && kAvaAppsDeviceCache) {
      final snap = await AvaAppsCache.readStatus();
      if (snap != null && mounted) {
        setState(() {
          _connected = (snap.json as List).map((e) => e.toString()).toSet();
          _loading = false;
        });
        // ignore: unawaited_futures
        Analytics.capture('avaapps_snapshot_render', {
          'kind': 'status', 'age_s': snap.ageSeconds, 'cache': 'hit',
        });
      }
      // …and the CATALOG too. Without this `_all` is empty until the network
      // returns, so the whole icon grid rebuilds from nothing on every open —
      // a blank screen on a slow connection even though every icon's bytes are
      // already on disk. Paint from the snapshot, then revalidate below.
      final cat = await AvaAppsCache.readCatalog();
      if (cat != null && mounted) {
        final apps = (cat.json as List<Map<String, String>>)
            .map((m) => AvaCatalogApp(m['slug'] ?? '', m['name'] ?? '', m['logo'] ?? ''))
            .where((a) => a.slug.isNotEmpty)
            .toList();
        if (apps.isNotEmpty) {
          setState(() {
            _all = apps;
            _loading = false;
          });
          // ignore: unawaited_futures
          Analytics.capture('avaapps_snapshot_render', {
            'kind': 'catalog', 'age_s': cat.ageSeconds, 'cache': 'hit',
            'count': apps.length,
          });
        }
      }
    }
    final results = await Future.wait([
      AppsService.I.catalog(),
      AppsService.I.status(fresh: fresh),
      MoneyApi.balance(),
    ]);
    if (!mounted) return;
    final bal = results[2] as Map<String, dynamic>;
    final connected = results[1] as Set<String>;
    final catalog = results[0] as List<AvaCatalogApp>;
    setState(() {
      // Keep the cached grid if the refresh came back empty (offline / error) —
      // never blank out a working screen.
      if (catalog.isNotEmpty || _all.isEmpty) _all = catalog;
      _connected = connected;
      _premium = bal['premium'] == 1 || bal['premium'] == true;
      _loading = false;
    });
    if (catalog.isNotEmpty) {
      // ignore: unawaited_futures
      AvaAppsCache.writeCatalog([
        for (final a in catalog) {'slug': a.slug, 'name': a.name, 'logo': a.logo},
      ]);
    }
    final ms = DateTime.now().difference(t0).inMilliseconds;
    // Phase 0 telemetry: screen-open latency + how many apps are connected.
    // ignore: unawaited_futures
    Analytics.capture('avaapps_screen_open', {
      'status_fetch_ms': ms, 'connected_count': connected.length,
    });
    // Phase 2: the background revalidation completed.
    // ignore: unawaited_futures
    Analytics.capture('avaapps_bg_refresh_ok', {'kind': 'status', 'ms': ms});
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
          backgroundColor: AD.popover,
          shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(AD.rDialog),
              side: const BorderSide(color: AD.borderControl, width: 1)),
          title: Text('Disconnect ${app.name}?', style: ADText.threadName()),
          content: Text('Ava will no longer be able to act on your ${app.name}. '
              'You can reconnect anytime.', style: ADText.preview()),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false),
                child: Text('Cancel', style: ADText.rowName(c: AD.textSecondary))),
            TextButton(onPressed: () => Navigator.pop(ctx, true),
                child: Text('Disconnect', style: ADText.rowName(c: AD.danger))),
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
      // Post-OAuth poll → bypass the server connection cache each attempt.
      final connected = await AppsService.I.status(fresh: true);
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
    setState(() { _running = true; _answer = null; _answerAsOf = null; _status = null; });
    // Phase 2: stale-while-revalidate — if we have a cached answer for this
    // exact read-only query, show it instantly with an "as of <time>" label,
    // then refresh (below) and replace it with the fresh result.
    if (kAvaAppsDeviceCache) {
      final snap = await AvaAppsCache.readRun(query);
      if (snap != null && mounted) {
        setState(() { _answer = snap.json?.toString(); _answerAsOf = snap.ageLabel; });
        // ignore: unawaited_futures
        Analytics.capture('avaapps_snapshot_render', {
          'kind': 'run_result', 'age_s': snap.ageSeconds, 'cache': 'hit',
        });
      }
    }
    try {
      String a;
      if (kAvaAppsStreaming) {
        // Phase 5: stream the answer live; fall back to non-streaming on any
        // SSE error (automatic — the user never sees the difference).
        try {
          var streamStarted = false;
          a = await AppsService.I.runStreaming(query,
            onStatus: (s) { if (mounted) setState(() => _status = s); },
            onDelta: (d) {
              if (!mounted) return;
              setState(() {
                if (!streamStarted) { streamStarted = true; _answer = ''; _answerAsOf = null; _status = null; }
                _answer = (_answer ?? '') + d;
              });
            });
        } catch (_) {
          // ignore: unawaited_futures
          Analytics.capture('avaapps_run_stream_fallback', {'ms': DateTime.now().difference(t0).inMilliseconds});
          a = await AppsService.I.run(query);
        }
      } else {
        a = await AppsService.I.run(query);
      }
      // Phase 4: server asked to confirm a send/delete before executing.
      final pending = AppsService.I.lastPendingAction;
      if (pending != null && pending['confirm_token'] != null) {
        if (mounted) setState(() { _answer = a; _answerAsOf = null; _status = null; });
        final done = await _confirmPending(pending);
        if (mounted && done != null) setState(() { _answer = done; });
      } else {
        if (mounted) setState(() { _answer = a; _answerAsOf = null; _status = null; });
        // Phase 5: persist streamed read answers so SWR works next time (the
        // non-streaming run() already writes its own; this covers the stream).
        if (kAvaAppsDeviceCache && AppsService.isReadOnly(query)) {
          // ignore: unawaited_futures
          AvaAppsCache.writeRun(query, a);
        }
      }
      // ignore: unawaited_futures
      Analytics.capture('avaapps_result_rendered', {
        'total_ms': DateTime.now().difference(t0).inMilliseconds,
        'answer_len': a.length,
      });
    } catch (_) {
      // ignore: unawaited_futures
      Analytics.capture('avaapps_bg_refresh_error', {'kind': 'run_result', 'ms': DateTime.now().difference(t0).inMilliseconds});
      rethrow;
    } finally {
      if (mounted) setState(() { _running = false; _status = null; });
    }
  }

  /// Phase 4: show a confirm card for a pending send/delete. Returns the result
  /// text if the user confirmed (and it executed), or null if they cancelled.
  Future<String?> _confirmPending(Map<String, dynamic> pending) async {
    final summary = (pending['human_summary'] ?? 'Confirm this action?').toString();
    final token = pending['confirm_token'].toString();
    final yes = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AD.popover,
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AD.rDialog),
            side: const BorderSide(color: AD.borderControl, width: 1)),
        title: Text('Confirm', style: ADText.threadName()),
        content: Text(summary, style: ADText.preview()),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false),
              child: Text('Cancel', style: ADText.rowName(c: AD.textSecondary))),
          TextButton(onPressed: () => Navigator.pop(ctx, true),
              child: Text('Confirm', style: ADText.rowName(c: AD.iconSearch))),
        ],
      ),
    );
    // ignore: unawaited_futures
    Analytics.capture('avaapps_send_confirm_client', {'accepted': yes == true});
    if (yes != true) return 'Okay, I won\'t send it.';
    return AppsService.I.confirmSend(token);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: const _DarkHeader(title: 'AvaApps'),
      body: RefreshIndicator(
        color: AD.iconSearch,
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
                style: ADText.preview())),
            const SizedBox(width: 8),
            _premiumBadge(),
          ]),
          const SizedBox(height: 6),
          Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(PhosphorIcons.lightning(PhosphorIconsStyle.fill), size: 12, color: AD.textTertiary),
            const SizedBox(width: 4),
            Text('Powered by Composio', style: ADText.statCaption(c: AD.textTertiary)),
          ]),
          const SizedBox(height: 14),
          // Search filter on top — white dark-v2 search dock.
          Container(
            decoration: BoxDecoration(
              color: AD.inputField,
              borderRadius: BorderRadius.circular(AD.rInput),
              border: Border.all(color: AD.borderControl, width: 1),
            ),
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold), size: 18, color: AD.iconSearch),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: _q,
                  cursorColor: AD.iconSearch,
                  style: const TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w700,
                      fontSize: 15, color: AD.textOnInput),
                  onChanged: (v) => setState(() => _filter = v.trim()),
                  decoration: const InputDecoration(
                    border: InputBorder.none, isDense: true,
                    hintText: 'Search apps…',
                    hintStyle: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w600,
                        fontSize: 14, color: AD.placeholderOnWhite),
                  ),
                ),
              ),
            ]),
          ),
          const SizedBox(height: 14),
          if (_loading)
            const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator(color: AD.iconSearch))),
          if (!_loading && _visible.isEmpty)
            Padding(padding: const EdgeInsets.all(20),
                child: Center(child: Text('No apps found.', style: ADText.preview(c: AD.textTertiary)))),
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
          Text('ASK AVA', style: ADText.sectionLabel()),
          const SizedBox(height: 10),
          AdCard(
            radius: AD.rListCard, padding: const EdgeInsets.all(12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              TextField(
                controller: _ask, minLines: 2, maxLines: 4,
                cursorColor: AD.iconSearch,
                style: const TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w600,
                    fontSize: 15, color: AD.textPrimary),
                decoration: const InputDecoration(
                  hintText: 'e.g. "Find me my latest email" · "Create a doc with my notes"',
                  hintStyle: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w600,
                      fontSize: 14, color: AD.textTertiary),
                  border: InputBorder.none, isDense: true,
                ),
              ),
              const SizedBox(height: 8),
              AdButton(
                label: 'Run', onPressed: _running ? null : _run,
                fullWidth: true, fontSize: 15, loading: _running,
                variant: AdButtonVariant.teal,
                icon: PhosphorIcons.sparkle(PhosphorIconsStyle.bold), trailingIcon: false,
              ),
            ]),
          ),
          if (_status != null && (_answer == null || _answer!.isEmpty)) ...[
            const SizedBox(height: 14),
            Row(children: [
              const SizedBox(width: 13, height: 13, child: CircularProgressIndicator(strokeWidth: 1.8, color: AD.iconSearch)),
              const SizedBox(width: 8),
              Text(_status!, style: ADText.preview(c: AD.textTertiary)),
            ]),
          ],
          if (_answer != null) ...[
            const SizedBox(height: 14),
            AdCard(
              radius: AD.rListCard, padding: const EdgeInsets.all(14),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                ZineIconBadge(icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill), color: AD.iconVideo, size: 30),
                const SizedBox(width: 12),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  if (_answerAsOf != null) ...[
                    Row(mainAxisSize: MainAxisSize.min, children: [
                      const SizedBox(width: 11, height: 11, child: CircularProgressIndicator(strokeWidth: 1.6, color: AD.textTertiary)),
                      const SizedBox(width: 6),
                      Text('as of $_answerAsOf · refreshing…', style: ADText.preview(c: AD.textTertiary)),
                    ]),
                    const SizedBox(height: 6),
                  ],
                  SelectableText(_answer!, style: ADText.rowName()),
                ])),
              ]),
            ),
          ],
          const SizedBox(height: 16),
          Center(child: Text('Tip: from any chat, type "@ava …" to use your apps inline',
              style: ADText.statCaption(c: AD.textTertiary))),
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
                border: Border.all(color: AD.borderControl, width: 1),
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
                  color: AD.online, // green = connected
                  shape: BoxShape.circle,
                  border: Border.all(color: AD.bg, width: 2),
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
                  color: AD.card,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: AD.borderControl, width: 1),
                ),
                child: Text('Soon',
                    style: ADText.statCaption(c: AD.textSecondary)),
              ),
            ),
        ]),
        const SizedBox(height: 6),
        Text(app.name, maxLines: 1, overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: ADText.preview(c: enabled ? AD.textSecondary : AD.textTertiary)),
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
    const palette = [AD.iconSearch, AD.iconVideo, AD.danger, AD.online, AD.primaryBadge];
    final c = palette[app.slug.hashCode.abs() % palette.length];
    final src = app.name.isNotEmpty ? app.name : app.slug;
    final letter = (src.isNotEmpty ? src.substring(0, 1) : '?').toUpperCase();
    return Container(
      decoration: BoxDecoration(color: c, borderRadius: BorderRadius.circular(8)),
      alignment: Alignment.center,
      child: Text(letter,
          style: const TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w900,
              fontSize: 20, color: AD.textOnInput)),
    );
  }

  /// Top-right status pill. BETA PHASE: server reports all users premium → the
  /// green pill shows for everyone and reads "BETA PHASE". Post-beta it reverts to
  /// the topped-up green pill / ghost "PREMIUM" crown upsell automatically.
  Widget _premiumBadge() {
    if (!_premium) {
      return AdSticker('PREMIUM', kind: AdStickerKind.hint,
          icon: PhosphorIcons.crown(PhosphorIconsStyle.fill));
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
      decoration: BoxDecoration(
        color: AD.online, // money/success green
        borderRadius: BorderRadius.circular(100),
        border: Border.all(color: AD.borderControl, width: 1),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(PhosphorIcons.sealCheck(PhosphorIconsStyle.fill), size: 14, color: Colors.white),
        const SizedBox(width: 6),
        Text('BETA-FREE', style: ADText.sectionLabel(c: Colors.white)),
      ]),
    );
  }
}

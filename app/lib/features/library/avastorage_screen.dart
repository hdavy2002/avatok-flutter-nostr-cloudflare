import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/ava_log.dart';
import '../../core/config.dart';
import '../../core/drive_service.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../sync/sync_hub.dart';
import '../ava_backup/backup_service.dart';
import '../wallet/wallet_screen.dart';

class _CatStyle {
  final String label;
  final Color color;
  const _CatStyle(this.label, this.color);
}

const _catStyles = <String, _CatStyle>{
  'image': _CatStyle('Images', Zine.blue),
  'video': _CatStyle('Videos', Zine.coral),
  'document': _CatStyle('Documents', Zine.lime),
  'audio': _CatStyle('Music', Zine.lilac),
  'other': _CatStyle('Other', Zine.mint),
};

String _fmt(num b) {
  if (b <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  var v = b.toDouble();
  var i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return '${v.toStringAsFixed(v >= 10 || i == 0 ? 0 : 1)} ${u[i]}';
}

/// AvaStorage — the universal per-account storage pool (Phase 4). One quota
/// shared by every AvaVerse app: a flat used-vs-quota meter, stacked
/// per-category bar + ledger (bytes AND counts), a last-6-months trend, and
/// LIVE updates — the server pushes a fresh summary over the single InboxDO
/// socket after any upload/delete in any app, and the graphs animate.
/// Over quota: 20 Tokens/GB/month from the AvaWallet; empty wallet =
/// read-only (files are NEVER deleted).
class AvaStorageScreen extends StatefulWidget {
  const AvaStorageScreen({super.key});
  @override
  State<AvaStorageScreen> createState() => _AvaStorageScreenState();
}

class _AvaStorageScreenState extends State<AvaStorageScreen> {
  Map<String, dynamic>? _data;
  List<Map<String, dynamic>> _trend = const [];
  bool _loading = true;
  StreamSubscription<Map<String, dynamic>>? _live;

  @override
  void initState() {
    super.initState();
    Analytics.capture('storage_viewed');
    _load();
    // Live: any upload from any app pushes {type:'storage', ...summary} over the
    // ONE multiplexed InboxDO socket (no polling); implicit animations repaint.
    _live = SyncHub.I.storage.listen((m) {
      if (mounted) setState(() => _data = {...?_data, ...m});
    });
  }

  @override
  void dispose() {
    _live?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await ApiAuth.getSigned(kStorageSummaryUrl);
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      if (mounted) {
        setState(() {
          _data = j;
          _trend = ((j['trend'] as List?) ?? const [])
              .map((e) => (e as Map).cast<String, dynamic>())
              .toList();
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = _data;
    final total = (d?['used_bytes'] as num?)?.toDouble() ?? 0;
    final quota = (d?['quota_bytes'] as num?)?.toDouble() ?? (5 * 1024 * 1024 * 1024);
    final frac = quota <= 0 ? 0.0 : (total / quota).clamp(0.0, 1.0);
    final state = (d?['state'] ?? 'ok').toString();
    final coinsPerGb = (d?['coins_per_gb_month'] as num?)?.toInt() ?? 20;
    final byCat = ((d?['by_category'] as Map?) ?? const {}).cast<String, dynamic>();
    final gbOver = total > quota ? ((total - quota) / (1024 * 1024 * 1024)).ceil() : 0;

    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(
        title: 'Backup',
        markWord: 'Backup',
        tag: 'Back up & restore',
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
          : RefreshIndicator(
              color: Zine.blueInk,
              onRefresh: _load,
              // Bottom padding includes the device safe-area inset + extra so the
              // last ledger row (e.g. "Other") isn't chopped by the gesture nav bar.
              child: ListView(padding: EdgeInsets.fromLTRB(18, 18, 18, 30 + MediaQuery.of(context).padding.bottom + 32), children: [
                const _DriveSection(),
                const SizedBox(height: 12),
                const _BackupRestoreSection(),
                const SizedBox(height: 20),
                _metricCards(total, quota, frac),
                const SizedBox(height: 16),
                _meterBar(frac, state),
                const SizedBox(height: 10),
                Text('${(frac * 100).toStringAsFixed(frac >= 0.1 ? 0 : 1)}% OF YOUR PLAN USED',
                    style: ZineText.kicker()),
                if (state == 'read_only') _readOnlyCard()
                else if (state == 'over_quota_paying') _warnCard(
                  sticker: 'Over quota',
                  text: 'Over the free quota — ${gbOver * coinsPerGb} Tokens/month ($coinsPerGb coins/GB × $gbOver GB) are charged from your wallet.',
                )
                else if (frac >= 0.8) _warnCard(
                  sticker: 'Heads up',
                  text: 'You\'ve used ${(frac * 100).toStringAsFixed(0)}% of your free ${_fmt(quota)}. Past it, storage costs $coinsPerGb Tokens/GB per month.',
                ),
                const SizedBox(height: 24),
                Text('BY TYPE', style: ZineText.kicker()),
                const SizedBox(height: 10),
                _stackedBar(total, quota, byCat),
                const SizedBox(height: 14),
                for (final e in _catStyles.entries) _ledgerRow(e.key, e.value, byCat, total),
                if (_trend.isNotEmpty) ...[
                  const SizedBox(height: 22),
                  Text('LAST 6 MONTHS', style: ZineText.kicker()),
                  const SizedBox(height: 12),
                  _trendBars(quota),
                ],
              ]),
            ),
    );
  }

  // -- usage stats: two metric cards (§7.11) ----------------------------------
  Widget _metricCards(double total, double quota, double frac) {
    final left = (quota - total).clamp(0, quota).toDouble();
    return Row(children: [
      Expanded(
        child: ZineCard(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ZineIconBadge(icon: PhosphorIcons.database(PhosphorIconsStyle.bold), color: Zine.blue),
            const SizedBox(height: 12),
            FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(_fmt(total), style: ZineText.stat(size: 30)),
            ),
            const SizedBox(height: 6),
            Text('USED OF ${_fmt(quota).toUpperCase()}', style: ZineText.kicker(size: 10.5)),
          ]),
        ),
      ),
      const SizedBox(width: 14),
      Expanded(
        child: ZineCard(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ZineIconBadge(icon: PhosphorIcons.cloudCheck(PhosphorIconsStyle.bold), color: Zine.mint),
            const SizedBox(height: 12),
            FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(_fmt(left), style: ZineText.stat(size: 30, color: Zine.mintInk)),
            ),
            const SizedBox(height: 6),
            Text('STILL FREE', style: ZineText.kicker(size: 10.5)),
          ]),
        ),
      ),
    ]);
  }

  // -- flat fill bar inside an ink-bordered track (no gradients, no donut) -----
  Widget _meterBar(double frac, String state) {
    final fill = state == 'read_only' ? Zine.coral : Zine.mint;
    return Container(
      height: 24,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: Zine.paper2,
        borderRadius: BorderRadius.circular(100),
        border: Zine.border,
        boxShadow: Zine.shadowXs,
      ),
      child: TweenAnimationBuilder<double>(
        tween: Tween(begin: 0, end: frac),
        duration: const Duration(milliseconds: 600),
        curve: Curves.easeOutCubic,
        builder: (_, v, __) => Align(
          alignment: Alignment.centerLeft,
          child: FractionallySizedBox(
            widthFactor: v.clamp(0.0, 1.0),
            heightFactor: 1,
            child: Container(
              decoration: BoxDecoration(
                color: fill,
                border: v > 0.02
                    ? const Border(right: BorderSide(color: Zine.ink, width: 2))
                    : null,
              ),
            ),
          ),
        ),
      ),
    );
  }

  // -- read-only: coral card + the one lime CTA (top up wallet) ----------------
  Widget _readOnlyCard() => Padding(
        padding: const EdgeInsets.only(top: 16),
        child: ZineCard(
          color: Zine.coral,
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              PhosphorIcon(PhosphorIcons.lock(PhosphorIconsStyle.bold), size: 18, color: Colors.white),
              const SizedBox(width: 8),
              Text('READ-ONLY', style: ZineText.tag(size: 12, color: Colors.white)),
            ]),
            const SizedBox(height: 8),
            Text(
              'Over your free quota with an empty AvaWallet. Your files are safe and read-only — top up Tokens to add more.',
              style: ZineText.sub(size: 14, color: Colors.white),
            ),
            const SizedBox(height: 14),
            ZineButton(
              label: 'Top up wallet',
              fullWidth: true,
              fontSize: 17,
              icon: PhosphorIcons.coins(PhosphorIconsStyle.bold),
              onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const WalletScreen())),
            ),
          ]),
        ),
      );

  // -- soft warnings: coral sticker + short line --------------------------------
  Widget _warnCard({required String sticker, required String text}) => Padding(
        padding: const EdgeInsets.only(top: 16),
        child: ZineCard(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ZineSticker(sticker, kind: ZineStickerKind.no),
            const SizedBox(height: 10),
            Text(text, style: ZineText.sub(size: 14)),
          ]),
        ),
      );

  Widget _stackedBar(double total, double quota, Map<String, dynamic> byCat) {
    final segments = <Widget>[];
    for (final e in _catStyles.entries) {
      final v = ((byCat[e.key] as Map?)?['bytes'] as num?)?.toDouble() ?? 0;
      if (v <= 0 || quota <= 0) continue;
      segments.add(Expanded(flex: (v / quota * 10000).round().clamp(1, 10000), child: Container(color: e.value.color)));
    }
    final remaining = (quota - total).clamp(0, quota);
    if (remaining > 0) segments.add(Expanded(flex: (remaining / quota * 10000).round().clamp(1, 10000), child: Container(color: Zine.paper2)));
    return Container(
      height: 20,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(100),
        border: Zine.border,
      ),
      child: Row(children: segments.isEmpty ? [Expanded(child: Container(color: Zine.paper2))] : segments),
    );
  }

  // -- per-type ledger rows (§7.10): label + dotted leader + Nunito 900 value --
  Widget _ledgerRow(String key, _CatStyle style, Map<String, dynamic> byCat, double total) {
    final cat = (byCat[key] as Map?)?.cast<String, dynamic>();
    final bytes = (cat?['bytes'] as num?)?.toDouble() ?? 0;
    final count = (cat?['count'] as num?)?.toInt() ?? 0;
    final pct = total <= 0 ? 0.0 : (bytes / total).clamp(0.0, 1.0);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(children: [
        Container(
          width: 13, height: 13,
          decoration: BoxDecoration(
            color: style.color,
            borderRadius: BorderRadius.circular(4),
            border: Border.all(color: Zine.ink, width: 2),
          ),
        ),
        const SizedBox(width: 10),
        Text('${style.label} · $count', style: ZineText.sub(size: 14.5)),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: CustomPaint(size: const Size(double.infinity, 2), painter: _DotLeaderPainter()),
          ),
        ),
        Text('${_fmt(bytes)} · ${(pct * 100).toStringAsFixed(0)}%',
            style: ZineText.value(size: 14, weight: FontWeight.w900)),
      ]),
    );
  }

  // -- last-6-months mini-bars (storage_snapshots via the summary API) ---------
  Widget _trendBars(double quota) {
    final maxV = _trend.fold<double>(
      1, (m, e) => math.max(m, ((e['used_bytes'] as num?) ?? 0).toDouble()));
    return SizedBox(
      height: 96,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          for (final s in _trend)
            Expanded(
              child: Column(mainAxisAlignment: MainAxisAlignment.end, children: [
                Text(_fmt((s['used_bytes'] as num?) ?? 0),
                    style: ZineText.tag(size: 8.5, color: Zine.inkSoft)),
                const SizedBox(height: 4),
                AnimatedContainer(
                  duration: const Duration(milliseconds: 400),
                  height: (54 * (((s['used_bytes'] as num?) ?? 0) / maxV)).clamp(4, 54).toDouble(),
                  margin: const EdgeInsets.symmetric(horizontal: 6),
                  decoration: BoxDecoration(
                    color: Zine.mint,
                    borderRadius: BorderRadius.circular(4),
                    border: Border.all(color: Zine.ink, width: 2),
                  ),
                ),
                const SizedBox(height: 4),
                Text(_monthLabel((s['month'] ?? '').toString()).toUpperCase(),
                    style: ZineText.tag(size: 9.5, color: Zine.inkSoft)),
              ]),
            ),
        ],
      ),
    );
  }

  static const _months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  String _monthLabel(String yyyyMm) {
    final m = int.tryParse(yyyyMm.length >= 7 ? yyyyMm.substring(5, 7) : '') ?? 0;
    return m >= 1 && m <= 12 ? _months[m] : yyyyMm;
  }
}

/// The dotted "·" leader line between a ledger label and its value (§7.10).
class _DotLeaderPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..color = Zine.inkMute;
    for (double x = 0; x < size.width; x += 7) {
      canvas.drawCircle(Offset(x, size.height / 2), 1.1, p);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter old) => false;
}

/// Google Drive (AvaTOK folder) panel — the user's OWN files (AvaChat
/// attachments, backups, saved media) live in their Google Drive; this shows the
/// connection, AvaTOK usage, and the file list. Shared chat media is NOT here.
class _DriveSection extends StatefulWidget {
  const _DriveSection();
  @override
  State<_DriveSection> createState() => _DriveSectionState();
}

class _DriveSectionState extends State<_DriveSection> {
  DriveStatus _s = const DriveStatus(false, 0, 0, 0);
  List<DriveFile> _files = const [];
  bool _loading = true, _connecting = false;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    final s = await DriveService.I.status();
    final f = s.connected ? await DriveService.I.list() : const <DriveFile>[];
    if (mounted) setState(() { _s = s; _files = f; _loading = false; });
    // Section health: how many users land here connected vs not, and their
    // usage — queryable per user via the email auto-stamped on every event.
    Analytics.capture('drive_status_loaded', {
      'connected': s.connected,
      'avatok_bytes': s.avatokBytes,
      'total_usage': s.totalUsage,
      'total_limit': s.totalLimit,
      'files': f.length,
    });
  }

  Future<void> _connect() async {
    setState(() => _connecting = true);
    // One stopwatch spans the whole flow so connect_ms measures real wall-time
    // from tap → connected (a slow-OAuth signal we can query per user).
    final sw = Stopwatch()..start();
    Analytics.capture('drive_connect_started', const {});
    final url = await DriveService.I.connectUrl();
    var connected = false;
    if (url == null) {
      // The Worker never returned an OAuth URL (config/network). api_error from
      // the HTTP wrapper has the status; this adds the semantic "couldn't even
      // start" signal so the funnel shows where it broke.
      Analytics.capture('drive_connect_url_missing', {'after_ms': sw.elapsedMilliseconds});
      Analytics.error(
          domain: 'storage', code: 'connect_url_null', screen: 'avastorage', action: 'connect');
    } else {
      Analytics.capture('drive_connect_opened', const {'mode': 'web_auth'});
      try {
        // In-app auth sheet (iOS ASWebAuthenticationSession / Android Custom
        // Tabs). It AUTO-CLOSES the instant the Worker redirects to
        // avatokauth://drive-connected — the user authorizes Google and lands
        // right back here without ever leaving the app. A raw WebView is NOT
        // used: Google blocks OAuth in embedded webviews (disallowed_useragent).
        await FlutterWebAuth2.authenticate(url: url, callbackUrlScheme: 'avatokauth');
        // Returned via the deep link → the Worker has stored the token.
        Analytics.capture('drive_connect_returned', const {'mode': 'web_auth'});
        connected = await _refreshAfterAuth();
        // "returned but status still not connected" is the no_refresh / eventual-
        // consistency case — split it out so we can tell a real failure from a
        // user who just cancelled.
        Analytics.capture(connected ? 'drive_connected' : 'drive_connect_unverified',
            {'via': 'web_auth', 'connect_ms': sw.elapsedMilliseconds});
      } on PlatformException catch (e) {
        // CANCELED = user dismissed the sheet (expected, not an error). Any other
        // failure (rare — auth session unavailable) → fall back to an in-app
        // Custom Tab and poll for the connection.
        if (e.code == 'CANCELED' || e.code == 'CANCELLED') {
          Analytics.capture('drive_connect_cancelled',
              {'code': e.code, 'after_ms': sw.elapsedMilliseconds});
        } else {
          AvaLog.I.log('drive', 'web auth failed (${e.code}); falling back to tab');
          Analytics.error(
              domain: 'storage', code: 'web_auth_failed', message: e.code,
              screen: 'avastorage', action: 'connect');
          try {
            final opened = await launchUrl(Uri.parse(url), mode: LaunchMode.inAppBrowserView);
            Analytics.capture('drive_connect_fallback_opened',
                {'mode': 'in_app_tab', 'opened': opened});
            if (opened) _pollConnected(sw);
          } catch (e2) {
            Analytics.error(
                domain: 'storage', code: 'fallback_launch_failed', message: e2.toString(),
                screen: 'avastorage', action: 'connect');
          }
        }
      } catch (e) {
        AvaLog.I.log('drive', 'web auth error: $e');
        Analytics.error(
            domain: 'storage', code: 'web_auth_error', message: e.toString(),
            screen: 'avastorage', action: 'connect');
      }
    }
    if (mounted) {
      setState(() => _connecting = false);
      if (url != null && !connected) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Authorize Google Drive to finish — tap Connect to retry if needed.')));
      }
    }
  }

  /// Pull fresh status + file list after the auth sheet returns and flip the
  /// panel to "connected". Returns whether Drive is now connected. (The
  /// connected/unverified telemetry is emitted by the caller so the stopwatch
  /// timing rides with it.)
  Future<bool> _refreshAfterAuth() async {
    final s = await DriveService.I.status();
    final f = s.connected ? await DriveService.I.list() : const <DriveFile>[];
    if (mounted) setState(() { _s = s; _files = f; });
    return s.connected;
  }

  /// Fallback path only: after launching the OAuth tab, poll status a few times
  /// so the panel flips to "connected" without the user tapping Refresh.
  Future<void> _pollConnected(Stopwatch sw) async {
    for (final delay in const [
      Duration(seconds: 2),
      Duration(seconds: 3),
      Duration(seconds: 4),
      Duration(seconds: 6),
    ]) {
      await Future.delayed(delay);
      if (!mounted) return;
      final s = await DriveService.I.status();
      if (!mounted) return;
      if (s.connected) {
        final f = await DriveService.I.list();
        if (mounted) setState(() { _s = s; _files = f; });
        Analytics.capture('drive_connected',
            {'via': 'fallback_tab', 'connect_ms': sw.elapsedMilliseconds});
        return;
      }
    }
    // Tab opened but the token never landed within the poll window — surfaces
    // a stuck fallback connect for a given user.
    Analytics.capture('drive_connect_poll_timeout',
        {'via': 'fallback_tab', 'after_ms': sw.elapsedMilliseconds});
  }

  @override
  Widget build(BuildContext context) {
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(14),
      boxShadow: Zine.shadowXs,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(icon: PhosphorIcons.googleDriveLogo(PhosphorIconsStyle.fill), color: Zine.mint, size: 34),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Google Drive · AvaTOK', style: ZineText.value(size: 15)),
            const SizedBox(height: 2),
            Text(_s.connected ? '${_fmt(_s.avatokBytes)} in your AvaTOK folder' : 'Store your own files in your Drive',
                style: ZineText.sub(size: 12)),
          ])),
          if (_s.connected)
            ZineSticker('ON', kind: ZineStickerKind.ok, icon: PhosphorIcons.check(PhosphorIconsStyle.bold)),
        ]),
        if (_loading) ...[
          const SizedBox(height: 12),
          const Center(child: SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Zine.blueInk))),
        ] else if (!_s.connected) ...[
          const SizedBox(height: 12),
          ZineButton(
            label: 'Connect Google Drive', onPressed: _connect, fullWidth: true, fontSize: 15,
            loading: _connecting, icon: PhosphorIcons.plugsConnected(PhosphorIconsStyle.bold), trailingIcon: false,
          ),
        ] else ...[
          if (_s.totalLimit > 0) ...[
            const SizedBox(height: 10),
            Text('Drive: ${_fmt(_s.totalUsage)} of ${_fmt(_s.totalLimit)} used', style: ZineText.sub(size: 11.5, color: Zine.inkMute)),
          ],
          const SizedBox(height: 8),
          if (_files.isEmpty)
            Text('No AvaTOK files yet — anything you save to Drive appears here.', style: ZineText.sub(size: 12))
          else
            ...(_files.take(12).map((f) => Padding(
                  padding: const EdgeInsets.symmetric(vertical: 5),
                  child: Row(children: [
                    PhosphorIcon(PhosphorIcons.file(PhosphorIconsStyle.bold), size: 16, color: Zine.inkSoft),
                    const SizedBox(width: 8),
                    Expanded(child: Text(f.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.value(size: 13))),
                    Text(_fmt(f.size), style: ZineText.sub(size: 11, color: Zine.inkMute)),
                  ]),
                ))),
          const SizedBox(height: 6),
          ZineLink('Refresh', fontSize: 13, onTap: () {
            Analytics.capture('drive_refresh_tapped', const {});
            setState(() => _loading = true);
            _load();
          }),
        ],
      ]),
    );
  }
}

/// Back up & restore panel (owner request 2026-06-29) — the single home for
/// backup now that the Settings "Backup" tile is hidden. Wraps [BackupService]'s
/// FREE Google-Drive lane: the on-device SQLite (the source of truth) is
/// CLIENT-SIDE ENCRYPTED (AES-256-GCM, per-account key in secure storage) and
/// uploaded to the user's OWN Google Drive "avatok-backup" folder, so neither
/// AvaTOK nor Google can read it and it survives a reinstall. Restore downloads
/// the blob, decrypts, and overwrites the local DB (the user reopens the app).
/// Drive connection itself is handled by [_DriveSection] above; this panel gates
/// on that connection and points there when not connected yet.
class _BackupRestoreSection extends StatefulWidget {
  const _BackupRestoreSection();
  @override
  State<_BackupRestoreSection> createState() => _BackupRestoreSectionState();
}

class _BackupRestoreSectionState extends State<_BackupRestoreSection> {
  bool? _connected; // null = still checking
  bool _folderReady = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  /// Check Drive connection and, when connected, ensure the avatok-backup folder
  /// exists — the same gate the (now-removed) settings section used.
  Future<void> _refresh() async {
    final st = await DriveService.I.status();
    var folderReady = false;
    if (st.connected) folderReady = await DriveService.I.ensureBackupFolder();
    if (!mounted) return;
    setState(() {
      _connected = st.connected;
      _folderReady = folderReady;
    });
    Analytics.capture('storage_backup_status', {
      'connected': st.connected,
      'folder_ready': folderReady,
    });
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  String _reason(String? r) {
    switch (r) {
      case 'no_token':
        return 'Connect Google Drive first (the panel above) to back up.';
      case 'no_backup':
        return 'No backup found in your Drive yet.';
      case 'empty':
        return 'Nothing to back up yet.';
      case 'drive_upload_failed':
        return 'Upload failed — check your connection and try again.';
      default:
        return 'Backup failed${r != null ? ' ($r)' : ''}.';
    }
  }

  Future<void> _backup() async {
    if (_busy) return;
    setState(() => _busy = true);
    final sw = Stopwatch()..start();
    Analytics.capture('storage_backup_started', const {});
    try {
      final res = await BackupService.I.backupToDrive();
      Analytics.capture('storage_backup_result',
          {'ok': res.ok, if (res.reason != null) 'reason': res.reason!, 'ms': sw.elapsedMilliseconds});
      _snack(res.ok ? 'Backed up to your Google Drive ✓' : _reason(res.reason));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _restore() async {
    if (_busy) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Zine.card,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Zine.r),
          side: const BorderSide(color: Zine.ink, width: Zine.bw),
        ),
        title: Text('Restore from Google Drive?', style: ZineText.cardTitle()),
        content: Text(
          'This replaces the data on this device with your latest Drive backup '
          '(chats and history). Anything newer on this device that has not been '
          'backed up will be overwritten. You will be asked to reopen the app.',
          style: ZineText.sub(size: 14),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text('Cancel', style: ZineText.link(size: 14, color: Zine.inkSoft)),
          ),
          ZineButton(
            label: 'Restore',
            variant: ZineButtonVariant.blue,
            fontSize: 15,
            onPressed: () => Navigator.pop(ctx, true),
          ),
        ],
      ),
    );
    if (ok != true || _busy) return;
    setState(() => _busy = true);
    final sw = Stopwatch()..start();
    Analytics.capture('storage_restore_started', const {});
    try {
      final res = await BackupService.I.restoreFromDrive();
      Analytics.capture('storage_restore_result',
          {'ok': res.ok, if (res.reason != null) 'reason': res.reason!, 'ms': sw.elapsedMilliseconds});
      _snack(res.ok
          ? 'Restored from Drive — please reopen the app to finish.'
          : _reason(res.reason));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(14),
      boxShadow: Zine.shadowXs,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(icon: PhosphorIcons.cloudArrowUp(PhosphorIconsStyle.fill), color: Zine.lime, size: 34),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Back up & restore', style: ZineText.value(size: 15)),
            const SizedBox(height: 2),
            Text('Encrypted backup to your Google Drive', style: ZineText.sub(size: 12)),
          ])),
        ]),
        const SizedBox(height: 10),
        Text(
          'Your chats are encrypted on this device before upload, so neither '
          'AvaTOK nor Google can read them. Survives reinstalling the app.',
          style: ZineText.sub(size: 12),
        ),
        const SizedBox(height: 12),
        _actions(),
      ]),
    );
  }

  Widget _actions() {
    if (_connected == null) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 6),
        child: Row(children: [
          SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2.2, color: Zine.blueInk)),
          SizedBox(width: 10),
          Text('Checking Google Drive…'),
        ]),
      );
    }
    final ready = _connected == true && _folderReady;
    if (!ready) {
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text(
          'Connect Google Drive in the panel above, then come back here to back '
          'up or restore.',
          style: ZineText.sub(size: 12.5, color: Zine.inkMute),
        ),
        const SizedBox(height: 8),
        Center(child: ZineLink("I've connected — refresh", fontSize: 13, onTap: _refresh)),
      ]);
    }
    return Row(children: [
      Expanded(
        child: ZineButton(
          label: 'Back up now',
          variant: ZineButtonVariant.lime,
          fullWidth: true,
          fontSize: 14,
          icon: PhosphorIcons.cloudArrowUp(PhosphorIconsStyle.bold),
          trailingIcon: false,
          loading: _busy,
          onPressed: _busy ? null : _backup,
        ),
      ),
      const SizedBox(width: 10),
      Expanded(
        child: ZineButton(
          label: 'Restore',
          variant: ZineButtonVariant.ghost,
          fullWidth: true,
          fontSize: 14,
          icon: PhosphorIcons.cloudArrowDown(PhosphorIconsStyle.bold),
          trailingIcon: false,
          onPressed: _busy ? null : _restore,
        ),
      ),
    ]);
  }
}

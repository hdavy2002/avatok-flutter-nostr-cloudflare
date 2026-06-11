import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:path_provider/path_provider.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/analytics.dart';
import '../../core/avatar_cache.dart';
import '../../core/remote_config.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'affiliate_api.dart';
import 'link_created_sheet.dart';
import 'subscribers_screen.dart';
import 'widgets.dart' show fmtAffDate;

/// Link Detail — the "give the affiliate as much information as possible"
/// screen: funnel, clicks/earnings timeseries, sources, recent conversions,
/// pause/resume. Data: GET /api/affiliate/links/:id/stats?range=.
class LinkDetailScreen extends StatefulWidget {
  final AffiliateLink link;
  const LinkDetailScreen({super.key, required this.link});
  @override
  State<LinkDetailScreen> createState() => _LinkDetailScreenState();
}

class _LinkDetailScreenState extends State<LinkDetailScreen> {
  static const _ranges = ['7d', '30d', '90d'];
  String _range = '30d';
  AffiliateLinkStats? _stats;
  bool _loading = true;
  bool _failed = false;
  bool _togglingPause = false;
  late String _status = widget.link.status;

  // v2 marketing kit (flag affiliateAssetKitEnabled)
  List<AffiliateAsset> _assets = const [];
  bool _generating = false;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avaaffiliate', 'link_detail');
    _load();
    if (RemoteConfig.affiliateAssetKitEnabled) _loadAssets();
  }

  Future<void> _loadAssets() async {
    final a = await AffiliateApi.listAssets(widget.link.id);
    if (!mounted || a == null) return;
    setState(() => _assets = a);
  }

  Future<void> _generateAssets() async {
    setState(() => _generating = true);
    final res = await AffiliateApi.generateAssets(widget.link.id);
    if (!mounted) return;
    setState(() => _generating = false);
    if (res['ok'] == true) {
      final fresh = (res['assets'] as List?)?.cast<AffiliateAsset>() ?? const [];
      setState(() => _assets = [...fresh, ..._assets]);
      return;
    }
    final status = res['status'] as int? ?? 0;
    final msg = status == 429
        ? 'Daily limit reached — you can generate 3 kits per link per day. Try again tomorrow.'
        : status == 503
            ? 'The marketing kit isn\'t available right now — try again later.'
            : 'Could not generate the kit — try again.';
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _load() async {
    setState(() { _loading = true; _failed = false; });
    Analytics.capture('affiliate_link_stats_viewed',
        {'link_id': widget.link.id, 'range': _range});
    final s = await AffiliateApi.linkStats(widget.link.id, range: _range);
    if (!mounted) return;
    setState(() {
      _stats = s ?? _stats;
      _failed = s == null && _stats == null;
      _loading = false;
    });
  }

  Future<void> _togglePause() async {
    setState(() => _togglingPause = true);
    final s = await AffiliateApi.pauseToggle(widget.link.id);
    if (!mounted) return;
    setState(() => _togglingPause = false);
    if (s == null) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Could not update the link — try again.')));
      return;
    }
    setState(() => _status = s);
    Analytics.capture(s == 'paused' ? 'affiliate_link_paused' : 'affiliate_link_resumed',
        {'link_id': widget.link.id});
  }

  bool get _paused => _status == 'paused';

  /// Phosphor icon + accent + label per promotable app.
  static (IconData, Color, String) _appMeta(String key) => switch (key) {
        'avaconsult' => (PhosphorIcons.videoCamera(PhosphorIconsStyle.bold), Zine.blue, 'AvaConsult'),
        'avavoice' => (PhosphorIcons.microphone(PhosphorIconsStyle.bold), Zine.lilac, 'AvaVoice'),
        _ => (PhosphorIcons.broadcast(PhosphorIconsStyle.bold), Zine.coral, 'AvaLive'),
      };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: widget.link.title,
        tag: 'link analytics',
        actions: [
          ZineBackButton(
            icon: PhosphorIcons.qrCode(PhosphorIconsStyle.bold),
            onTap: () =>
                showLinkCreatedSheet(context, widget.link, justCreated: false),
          ),
        ],
      ),
      body: _loading && _stats == null
          ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
          : _failed
              ? _retry()
              : RefreshIndicator(onRefresh: _load, color: Zine.blueInk, child: _body()),
    );
  }

  Widget _retry() => Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ZineEmptyState(
            icon: PhosphorIcons.chartBar(PhosphorIconsStyle.bold),
            text: 'Could not load analytics.',
          ),
          const SizedBox(height: 14),
          ZineButton(label: 'Retry', variant: ZineButtonVariant.ghost,
              fontSize: 16, onPressed: _load),
        ]),
      );

  Widget _body() {
    final s = _stats!;
    final (appIcon, appAccent, appLabel) = _appMeta(widget.link.app);
    return ListView(
      padding: const EdgeInsets.fromLTRB(18, 14, 18, 32),
      children: [
        Row(children: [
          ZineSticker(appLabel, icon: appIcon),
          const Spacer(),
          // Range chips (§7.4).
          for (final r in _ranges) ...[
            ZineChip(
              label: r,
              active: _range == r,
              onTap: () { if (_range != r) { _range = r; _load(); } },
            ),
            if (r != _ranges.last) const SizedBox(width: 7),
          ],
        ]),
        const SizedBox(height: 20),
        _kicker('Conversion funnel'),
        _funnel(s.funnel, appAccent),
        const SizedBox(height: 22),
        _kicker('Clicks & earnings over time'),
        const SizedBox(height: 10),
        _TimeseriesChart(points: s.timeseries),
        const SizedBox(height: 22),
        _kicker('Top sources'),
        const SizedBox(height: 10),
        _sources(s),
        const SizedBox(height: 22),
        _kicker('Recent conversions'),
        const SizedBox(height: 6),
        if (s.recent.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 16),
            child: Text('No conversions yet — share your link to get started!',
                style: ZineText.sub(size: 13)),
          )
        else
          ...s.recent.map(_conversionRow),
        if (RemoteConfig.affiliateAssetKitEnabled) ...[
          const SizedBox(height: 22),
          _kicker('Marketing kit'),
          const SizedBox(height: 6),
          Text(
            'AI-generated promo images for this listing — story, post and banner. '
            'Tap one to add your QR code and share it.',
            style: ZineText.sub(size: 12.5),
          ),
          const SizedBox(height: 12),
          _marketingKit(),
        ],
        const SizedBox(height: 22),
        ZineButton(
          label: 'View subscribers',
          variant: ZineButtonVariant.blue,
          fullWidth: true,
          fontSize: 17,
          trailingIcon: false,
          icon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
          onPressed: () => Navigator.push(context, MaterialPageRoute(
              builder: (_) => SubscribersScreen(link: widget.link))),
        ),
        const SizedBox(height: 10),
        ZineButton(
          label: _paused ? 'Resume link' : 'Pause link',
          variant: _paused ? ZineButtonVariant.ghost : ZineButtonVariant.coral,
          fullWidth: true,
          fontSize: 17,
          trailingIcon: false,
          loading: _togglingPause,
          icon: _paused
              ? PhosphorIcons.play(PhosphorIconsStyle.bold)
              : PhosphorIcons.pause(PhosphorIconsStyle.bold),
          onPressed: _togglingPause ? null : _togglePause,
        ),
        if (_paused)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Text(
              'Paused links stop binding NEW users. Existing referrals keep earning you commission.',
              textAlign: TextAlign.center,
              style: ZineText.sub(size: 11.5),
            ),
          ),
      ],
    );
  }

  Widget _kicker(String t) => Text(t.toUpperCase(), style: ZineText.kicker(size: 11.5));

  Widget _funnel(AffiliateFunnel f, Color accent) {
    final steps = <(String, int)>[
      ('Clicks', f.clicks),
      ('Installs', f.installs),
      ('Signups', f.binds),
      ('First purchase', f.firstPurchases),
      ('Repeat', f.repeatPurchases),
    ];
    final maxV = steps.fold<int>(1, (m, s) => s.$2 > m ? s.$2 : m);
    return Column(children: [
      const SizedBox(height: 10),
      for (var i = 0; i < steps.length; i++) ...[
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 3.5),
          child: Row(children: [
            SizedBox(width: 96, child: Text(steps[i].$1, style: ZineText.sub(size: 12))),
            Expanded(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(6),
                child: Stack(children: [
                  Container(
                    height: 18,
                    decoration: BoxDecoration(
                      color: Zine.paper2,
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: Zine.ink, width: 1.5),
                    ),
                  ),
                  FractionallySizedBox(
                    widthFactor: (steps[i].$2 / maxV).clamp(0.0, 1.0),
                    child: Container(
                      height: 18,
                      decoration: BoxDecoration(
                        color: Zine.mint,
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(color: Zine.ink, width: 1.5),
                      ),
                    ),
                  ),
                ]),
              ),
            ),
            const SizedBox(width: 8),
            SizedBox(width: 76, child: Text(
              i == 0
                  ? '${steps[i].$2}'
                  : '${steps[i].$2} · ${_pct(steps[i].$2, steps[i - 1].$2)}',
              textAlign: TextAlign.right,
              style: ZineText.value(size: 11.5),
            )),
          ]),
        ),
      ],
    ]);
  }

  String _pct(int v, int prev) =>
      prev <= 0 ? '—' : '${(v * 100 / prev).toStringAsFixed(0)}%';

  Widget _sources(AffiliateLinkStats s) {
    final items = <(String, int, IconData, Color)>[
      ('QR scans', s.srcQr, PhosphorIcons.qrCode(PhosphorIconsStyle.bold), Zine.blue),
      ('Link taps', s.srcLink, PhosphorIcons.linkSimple(PhosphorIconsStyle.bold), Zine.lime),
      ('Shares', s.srcShare, PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold), Zine.lilac),
    ];
    return Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      for (final it in items)
        Expanded(
          child: Padding(
            padding: EdgeInsets.only(right: it == items.last ? 0 : 10),
            // Metric card (§7.11).
            child: ZineCard(
              radius: Zine.rSm,
              padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 8),
              boxShadow: Zine.shadowXs,
              child: Column(children: [
                ZineIconBadge(icon: it.$3, color: it.$4, size: 28),
                const SizedBox(height: 8),
                Text('${it.$2}', style: ZineText.stat(size: 20)),
                const SizedBox(height: 2),
                Text(it.$1.toUpperCase(), maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ZineText.kicker(size: 8.5)),
              ]),
            ),
          ),
        ),
    ]);
  }

  /// Conversion row — ledger style (§7.10): label + dotted leader + mint value.
  Widget _conversionRow(AffiliateConversion c) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
            Flexible(
              child: Text('${c.maskedUser} purchased',
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ZineText.value(size: 13.5, weight: FontWeight.w800)),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: Text('·' * 80, maxLines: 1, overflow: TextOverflow.clip,
                  style: ZineText.sub(size: 13, color: Zine.inkMute)),
            ),
            const SizedBox(width: 6),
            Text('+${affCoinsLabel(c.coins)}',
                style: ZineText.value(size: 13.5, weight: FontWeight.w900, color: Zine.mintInk)),
          ]),
          const SizedBox(height: 2),
          Text(fmtAffDate(c.ts).toUpperCase(),
              style: ZineText.kicker(size: 9, color: Zine.inkMute)),
        ]),
      );

  // ── v2 marketing kit ───────────────────────────────────────────────────────
  Widget _marketingKit() {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (_assets.isNotEmpty) ...[
        SizedBox(
          height: 170,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            itemCount: _assets.length,
            separatorBuilder: (_, __) => const SizedBox(width: 10),
            itemBuilder: (_, i) => _assetCard(_assets[i]),
          ),
        ),
        const SizedBox(height: 12),
      ],
      ZineButton(
        label: _generating
            ? 'Generating your kit… (~30 s)'
            : _assets.isEmpty ? 'Generate marketing kit' : 'Generate a new kit',
        fullWidth: true,
        fontSize: 17,
        loading: _generating,
        trailingIcon: false,
        icon: PhosphorIcons.sparkle(PhosphorIconsStyle.bold),
        onPressed: _generating ? null : _generateAssets,
      ),
    ]);
  }

  static double _assetAspect(String format) => switch (format) {
        'story' => 9 / 16,
        'banner' => 16 / 9,
        _ => 1.0,
      };

  Widget _assetCard(AffiliateAsset a) {
    final w = 150 * _assetAspect(a.format) + (a.format == 'banner' ? -60 : 0);
    return GestureDetector(
      onTap: () => Navigator.push(context, MaterialPageRoute(
          builder: (_) => AssetShareScreen(asset: a, link: widget.link))),
      child: SizedBox(
        width: w.clamp(86.0, 240.0),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Container(
              clipBehavior: Clip.antiAlias,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(Zine.rSm),
                border: Zine.border,
                boxShadow: Zine.shadowXs,
              ),
              // CF-AVIF transformed variant, disk-cached (existing image pipeline).
              child: FutureBuilder<File?>(
                future: AvatarCache.get(a.url, 480),
                builder: (_, snap) => snap.data == null
                    ? Container(color: Zine.paper2,
                        child: const Center(child: SizedBox(width: 18, height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2, color: Zine.blueInk))))
                    : Image.file(snap.data!, fit: BoxFit.cover,
                        width: double.infinity, height: double.infinity),
              ),
            ),
          ),
          const SizedBox(height: 6),
          Text(a.format.toUpperCase(), style: ZineText.kicker(size: 9.5)),
        ]),
      ),
    );
  }
}

/// Share preview — composites the REAL scannable QR (the affiliate link URL)
/// over the clean lower third the prompt reserved in the generated image, then
/// captures the RepaintBoundary as PNG bytes and hands it to the native share
/// sheet. The QR is rendered client-side (qr_flutter) — never by the model.
class AssetShareScreen extends StatefulWidget {
  final AffiliateAsset asset;
  final AffiliateLink link;
  const AssetShareScreen({super.key, required this.asset, required this.link});
  @override
  State<AssetShareScreen> createState() => _AssetShareScreenState();
}

class _AssetShareScreenState extends State<AssetShareScreen> {
  final GlobalKey _boundaryKey = GlobalKey();
  File? _image;
  bool _sharing = false;

  @override
  void initState() {
    super.initState();
    // High-res CF-AVIF variant via the shared disk cache.
    AvatarCache.get(widget.asset.url, 1080).then((f) {
      if (mounted) setState(() => _image = f);
    });
  }

  Future<void> _share() async {
    final boundary =
        _boundaryKey.currentContext?.findRenderObject() as RenderRepaintBoundary?;
    if (boundary == null) return;
    setState(() => _sharing = true);
    try {
      final img = await boundary.toImage(pixelRatio: 3);
      final data = await img.toByteData(format: ui.ImageByteFormat.png);
      if (data == null) throw Exception('capture failed');
      final dir = await getTemporaryDirectory();
      final file = File(
          '${dir.path}/avatok-promo-${widget.asset.format}-${widget.asset.id}.png');
      await file.writeAsBytes(data.buffer.asUint8List(), flush: true);
      Analytics.capture('affiliate_asset_shared',
          {'link_id': widget.link.id, 'format': widget.asset.format});
      await Share.shareXFiles(
        [XFile(file.path, mimeType: 'image/png')],
        text: 'Check out "${widget.link.title}" on AvaTok — ${widget.link.url}',
      );
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Could not share the image — try again.')));
      }
    } finally {
      if (mounted) setState(() => _sharing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final aspect = _LinkDetailScreenState._assetAspect(widget.asset.format);
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: 'Share ${widget.asset.format}',
        tag: 'qr included',
      ),
      body: Column(children: [
        Expanded(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: _image == null
                  ? const CircularProgressIndicator(color: Zine.blueInk)
                  : RepaintBoundary(
                      key: _boundaryKey,
                      child: AspectRatio(
                        aspectRatio: aspect,
                        child: LayoutBuilder(builder: (_, box) {
                          // QR sized to sit comfortably inside the reserved
                          // clean lower third of the artwork.
                          final qrSize =
                              (box.maxHeight * .24).clamp(56.0, box.maxWidth * .4);
                          return Stack(fit: StackFit.expand, children: [
                            Image.file(_image!, fit: BoxFit.cover),
                            Positioned(
                              bottom: box.maxHeight * .04,
                              left: 0, right: 0,
                              child: Center(
                                child: Container(
                                  padding: const EdgeInsets.all(6),
                                  decoration: BoxDecoration(
                                    color: Colors.white,
                                    borderRadius: BorderRadius.circular(10),
                                  ),
                                  child: QrImageView(
                                    data: widget.link.url,
                                    size: qrSize,
                                    backgroundColor: Colors.white,
                                  ),
                                ),
                              ),
                            ),
                          ]);
                        }),
                      ),
                    ),
            ),
          ),
        ),
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(18, 0, 18, 12),
            child: ZineButton(
              label: 'Share with QR',
              fullWidth: true,
              loading: _sharing,
              trailingIcon: false,
              icon: PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold),
              onPressed: _image == null || _sharing ? null : _share,
            ),
          ),
        ),
      ]),
    );
  }
}

/// Simple custom-painter dual-series bar chart: clicks (bars) + earnings
/// (line dots) — no chart package needed. Flat poster fills only.
class _TimeseriesChart extends StatelessWidget {
  final List<AffiliateDayPoint> points;
  const _TimeseriesChart({required this.points});

  @override
  Widget build(BuildContext context) {
    if (points.isEmpty) {
      return Container(
        height: 120, alignment: Alignment.center,
        decoration: BoxDecoration(
            border: Border.all(color: Zine.inkMute, width: 2),
            borderRadius: BorderRadius.circular(Zine.rSm)),
        child: Text('No activity in this period yet', style: ZineText.sub(size: 12.5)),
      );
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      ZineCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.all(10),
        boxShadow: Zine.shadowXs,
        child: SizedBox(
          height: 130,
          width: double.infinity,
          child: CustomPaint(
            size: Size.infinite,
            painter: _BarsPainter(points),
          ),
        ),
      ),
      const SizedBox(height: 8),
      Row(children: [
        _legend(Zine.blue, 'Clicks'),
        const SizedBox(width: 14),
        _legend(Zine.mintInk, 'Earnings'),
      ]),
    ]);
  }

  Widget _legend(Color c, String label) => Row(children: [
        Container(width: 11, height: 11,
            decoration: BoxDecoration(
                color: c,
                border: Border.all(color: Zine.ink, width: 1.5),
                borderRadius: BorderRadius.circular(3))),
        const SizedBox(width: 5),
        Text(label.toUpperCase(), style: ZineText.kicker(size: 9.5)),
      ]);
}

class _BarsPainter extends CustomPainter {
  final List<AffiliateDayPoint> points;
  _BarsPainter(this.points);

  @override
  void paint(Canvas canvas, Size size) {
    if (points.isEmpty || size.width <= 0 || size.height <= 0) return;
    final n = points.length;
    final maxClicks = points.fold<int>(1, (m, p) => p.clicks > m ? p.clicks : m);
    final maxEarn = points.fold<int>(1, (m, p) => p.earnedCoins > m ? p.earnedCoins : m);
    final slot = size.width / n;
    final barW = (slot * .55).clamp(1.0, 14.0);

    final barPaint = Paint()..color = Zine.blue;
    final barEdge = Paint()
      ..color = Zine.ink
      ..strokeWidth = 1
      ..style = PaintingStyle.stroke;
    final linePaint = Paint()
      ..color = Zine.mintInk
      ..strokeWidth = 2
      ..style = PaintingStyle.stroke;
    final dotPaint = Paint()..color = Zine.mintInk;

    // clicks bars
    for (var i = 0; i < n; i++) {
      final h = (points[i].clicks / maxClicks) * (size.height - 4);
      final x = i * slot + (slot - barW) / 2;
      final rr = RRect.fromRectAndRadius(
          Rect.fromLTWH(x, size.height - h, barW, h), const Radius.circular(3));
      canvas.drawRRect(rr, barPaint);
      canvas.drawRRect(rr, barEdge);
    }
    // earnings line
    final path = Path();
    for (var i = 0; i < n; i++) {
      final x = i * slot + slot / 2;
      final y = size.height - (points[i].earnedCoins / maxEarn) * (size.height - 4);
      if (i == 0) {
        path.moveTo(x, y);
      } else {
        path.lineTo(x, y);
      }
    }
    if (n > 1) canvas.drawPath(path, linePaint);
    for (var i = 0; i < n; i++) {
      final x = i * slot + slot / 2;
      final y = size.height - (points[i].earnedCoins / maxEarn) * (size.height - 4);
      canvas.drawCircle(Offset(x, y), 2.5, dotPaint);
    }
  }

  @override
  bool shouldRepaint(_BarsPainter old) => old.points != points;
}

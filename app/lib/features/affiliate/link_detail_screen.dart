import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:path_provider/path_provider.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/analytics.dart';
import '../../core/avatar_cache.dart';
import '../../core/remote_config.dart';
import '../../core/theme.dart';
import 'affiliate_api.dart';
import 'link_created_sheet.dart';
import 'subscribers_screen.dart';
import 'widgets.dart';

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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink,
        title: Text(widget.link.title, maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: [
          IconButton(
            tooltip: 'Share / QR',
            icon: const Icon(Icons.qr_code_2),
            onPressed: () =>
                showLinkCreatedSheet(context, widget.link, justCreated: false),
          ),
        ],
      ),
      body: _loading && _stats == null
          ? const Center(child: CircularProgressIndicator())
          : _failed
              ? _retry()
              : RefreshIndicator(onRefresh: _load, child: _body()),
    );
  }

  Widget _retry() => Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('Could not load analytics.', style: TextStyle(color: AvaColors.sub)),
          const SizedBox(height: 10),
          OutlinedButton(onPressed: _load, child: const Text('Retry')),
        ]),
      );

  Widget _body() {
    final s = _stats!;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
      children: [
        Row(children: [
          AppBadge(appKey: widget.link.app),
          const Spacer(),
          // range selector
          Container(
            decoration: BoxDecoration(color: AvaColors.soft,
                borderRadius: BorderRadius.circular(10)),
            padding: const EdgeInsets.all(3),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              for (final r in _ranges)
                GestureDetector(
                  onTap: () { if (_range != r) { _range = r; _load(); } },
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                    decoration: BoxDecoration(
                      color: _range == r ? Colors.white : Colors.transparent,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(r, style: TextStyle(fontSize: 12,
                        fontWeight: FontWeight.w800,
                        color: _range == r ? kAffiliateOrange : AvaColors.sub)),
                  ),
                ),
            ]),
          ),
        ]),
        const SizedBox(height: 14),
        _sectionTitle('Conversion funnel'),
        _funnel(s.funnel),
        const SizedBox(height: 18),
        _sectionTitle('Clicks & earnings over time'),
        const SizedBox(height: 8),
        _TimeseriesChart(points: s.timeseries),
        const SizedBox(height: 18),
        _sectionTitle('Top sources'),
        const SizedBox(height: 8),
        _sources(s),
        const SizedBox(height: 18),
        _sectionTitle('Recent conversions'),
        const SizedBox(height: 4),
        if (s.recent.isEmpty)
          const Padding(padding: EdgeInsets.symmetric(vertical: 16),
              child: Text('No conversions yet — share your link to get started!',
                  style: TextStyle(color: AvaColors.sub, fontSize: 12.5)))
        else
          ...s.recent.map(_conversionRow),
        if (RemoteConfig.affiliateAssetKitEnabled) ...[
          const SizedBox(height: 18),
          _sectionTitle('Marketing kit'),
          const SizedBox(height: 4),
          const Text(
            'AI-generated promo images for this listing — story, post and banner. '
            'Tap one to add your QR code and share it.',
            style: TextStyle(fontSize: 12, color: AvaColors.sub),
          ),
          const SizedBox(height: 10),
          _marketingKit(),
        ],
        const SizedBox(height: 18),
        OutlinedButton.icon(
          style: OutlinedButton.styleFrom(
              foregroundColor: kAffiliateOrange,
              side: const BorderSide(color: kAffiliateOrange),
              padding: const EdgeInsets.symmetric(vertical: 13)),
          icon: const Icon(Icons.group, size: 18),
          label: const Text('View subscribers'),
          onPressed: () => Navigator.push(context, MaterialPageRoute(
              builder: (_) => SubscribersScreen(link: widget.link))),
        ),
        const SizedBox(height: 8),
        OutlinedButton.icon(
          style: OutlinedButton.styleFrom(
              foregroundColor: _paused ? AvaColors.success : AvaColors.danger,
              side: BorderSide(color: _paused ? AvaColors.success : AvaColors.danger),
              padding: const EdgeInsets.symmetric(vertical: 13)),
          icon: _togglingPause
              ? const SizedBox(width: 16, height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2))
              : Icon(_paused ? Icons.play_arrow : Icons.pause, size: 18),
          label: Text(_paused ? 'Resume link' : 'Pause link'),
          onPressed: _togglingPause ? null : _togglePause,
        ),
        if (_paused)
          const Padding(
            padding: EdgeInsets.only(top: 8),
            child: Text(
              'Paused links stop binding NEW users. Existing referrals keep earning you commission.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 11.5, color: AvaColors.sub),
            ),
          ),
      ],
    );
  }

  Widget _sectionTitle(String t) => Text(t,
      style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15, color: AvaColors.ink));

  Widget _funnel(AffiliateFunnel f) {
    final steps = <(String, int)>[
      ('Clicks', f.clicks),
      ('Installs', f.installs),
      ('Signups', f.binds),
      ('First purchase', f.firstPurchases),
      ('Repeat', f.repeatPurchases),
    ];
    final maxV = steps.fold<int>(1, (m, s) => s.$2 > m ? s.$2 : m);
    return Column(children: [
      const SizedBox(height: 8),
      for (var i = 0; i < steps.length; i++) ...[
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: Row(children: [
            SizedBox(width: 96, child: Text(steps[i].$1,
                style: const TextStyle(fontSize: 12, color: AvaColors.sub,
                    fontWeight: FontWeight.w700))),
            Expanded(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(6),
                child: Stack(children: [
                  Container(height: 18, color: AvaColors.soft),
                  FractionallySizedBox(
                    widthFactor: (steps[i].$2 / maxV).clamp(0.0, 1.0),
                    child: Container(height: 18,
                        decoration: BoxDecoration(
                            gradient: kAffiliateGradient,
                            borderRadius: BorderRadius.circular(6))),
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
              style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w800),
            )),
          ]),
        ),
      ],
    ]);
  }

  String _pct(int v, int prev) =>
      prev <= 0 ? '—' : '${(v * 100 / prev).toStringAsFixed(0)}%';

  Widget _sources(AffiliateLinkStats s) {
    final items = <(String, int, IconData)>[
      ('QR scans', s.srcQr, Icons.qr_code_2),
      ('Link taps', s.srcLink, Icons.link),
      ('Shares', s.srcShare, Icons.ios_share),
    ];
    return Row(children: [
      for (final it in items)
        Expanded(
          child: Container(
            margin: EdgeInsets.only(right: it == items.last ? 0 : 8),
            padding: const EdgeInsets.symmetric(vertical: 12),
            decoration: BoxDecoration(
              border: Border.all(color: AvaColors.line),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Column(children: [
              Icon(it.$3, size: 18, color: kAffiliateOrange),
              const SizedBox(height: 4),
              Text('${it.$2}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
              Text(it.$1, style: const TextStyle(fontSize: 10.5, color: AvaColors.sub)),
            ]),
          ),
        ),
    ]);
  }

  Widget _conversionRow(AffiliateConversion c) => ListTile(
        dense: true,
        contentPadding: EdgeInsets.zero,
        leading: Container(width: 34, height: 34,
            decoration: BoxDecoration(
                color: AvaColors.success.withValues(alpha: .12),
                borderRadius: BorderRadius.circular(10)),
            child: const Icon(Icons.attach_money, size: 18, color: AvaColors.success)),
        title: Text('${c.maskedUser} purchased',
            style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
        subtitle: Text(fmtAffDate(c.ts),
            style: const TextStyle(fontSize: 11, color: AvaColors.sub)),
        trailing: Text('+${affCoinsLabel(c.coins)}',
            style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 13.5,
                color: AvaColors.success)),
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
        const SizedBox(height: 10),
      ],
      FilledButton.icon(
        style: FilledButton.styleFrom(backgroundColor: kAffiliateOrange,
            padding: const EdgeInsets.symmetric(vertical: 13)),
        onPressed: _generating ? null : _generateAssets,
        icon: _generating
            ? const SizedBox(width: 16, height: 16,
                child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
            : const Icon(Icons.auto_awesome, size: 18),
        label: Text(_generating
            ? 'Generating your kit… (~30 s)'
            : _assets.isEmpty ? 'Generate marketing kit' : 'Generate a new kit'),
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
            child: ClipRRect(
              borderRadius: BorderRadius.circular(12),
              // CF-AVIF transformed variant, disk-cached (existing image pipeline).
              child: FutureBuilder<File?>(
                future: AvatarCache.get(a.url, 480),
                builder: (_, snap) => snap.data == null
                    ? Container(color: AvaColors.soft,
                        child: const Center(child: SizedBox(width: 18, height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2))))
                    : Image.file(snap.data!, fit: BoxFit.cover,
                        width: double.infinity, height: double.infinity),
              ),
            ),
          ),
          const SizedBox(height: 4),
          Text(a.format, style: const TextStyle(fontSize: 10.5,
              fontWeight: FontWeight.w700, color: AvaColors.sub)),
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
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink,
        title: Text('Share ${widget.asset.format}'),
      ),
      body: Column(children: [
        Expanded(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: _image == null
                  ? const CircularProgressIndicator()
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
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: FilledButton.icon(
              style: FilledButton.styleFrom(backgroundColor: kAffiliateOrange,
                  minimumSize: const Size.fromHeight(48)),
              onPressed: _image == null || _sharing ? null : _share,
              icon: _sharing
                  ? const SizedBox(width: 16, height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : const Icon(Icons.ios_share, size: 18),
              label: const Text('Share with QR'),
            ),
          ),
        ),
      ]),
    );
  }
}

/// Simple custom-painter dual-series bar chart: clicks (bars) + earnings
/// (line dots) — no chart package needed.
class _TimeseriesChart extends StatelessWidget {
  final List<AffiliateDayPoint> points;
  const _TimeseriesChart({required this.points});

  @override
  Widget build(BuildContext context) {
    if (points.isEmpty) {
      return Container(
        height: 120, alignment: Alignment.center,
        decoration: BoxDecoration(
            border: Border.all(color: AvaColors.line),
            borderRadius: BorderRadius.circular(14)),
        child: const Text('No activity in this period yet',
            style: TextStyle(color: AvaColors.sub, fontSize: 12)),
      );
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Container(
        height: 150,
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
            border: Border.all(color: AvaColors.line),
            borderRadius: BorderRadius.circular(14)),
        child: CustomPaint(
          size: Size.infinite,
          painter: _BarsPainter(points),
        ),
      ),
      const SizedBox(height: 6),
      Row(children: [
        _legend(kAffiliateOrange, 'Clicks'),
        const SizedBox(width: 14),
        _legend(AvaColors.success, 'Earnings'),
      ]),
    ]);
  }

  Widget _legend(Color c, String label) => Row(children: [
        Container(width: 10, height: 10,
            decoration: BoxDecoration(color: c, borderRadius: BorderRadius.circular(3))),
        const SizedBox(width: 5),
        Text(label, style: const TextStyle(fontSize: 11, color: AvaColors.sub,
            fontWeight: FontWeight.w700)),
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

    final barPaint = Paint()..color = kAffiliateOrange.withValues(alpha: .75);
    final linePaint = Paint()
      ..color = AvaColors.success
      ..strokeWidth = 2
      ..style = PaintingStyle.stroke;
    final dotPaint = Paint()..color = AvaColors.success;

    // clicks bars
    for (var i = 0; i < n; i++) {
      final h = (points[i].clicks / maxClicks) * (size.height - 4);
      final x = i * slot + (slot - barW) / 2;
      canvas.drawRRect(
        RRect.fromRectAndRadius(
            Rect.fromLTWH(x, size.height - h, barW, h), const Radius.circular(3)),
        barPaint,
      );
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

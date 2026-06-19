import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/apps_service.dart';
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

class _AvaAppsScreenState extends State<AvaAppsScreen> {
  final _q = TextEditingController();
  final _ask = TextEditingController();
  List<AvaCatalogApp> _all = [];
  Set<String> _connected = {};
  String _filter = '';
  bool _loading = true, _running = false;
  String? _answer;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() { _q.dispose(); _ask.dispose(); super.dispose(); }

  Future<void> _load() async {
    final results = await Future.wait([AppsService.I.catalog(), AppsService.I.status()]);
    if (!mounted) return;
    setState(() {
      _all = results[0] as List<AvaCatalogApp>;
      _connected = results[1] as Set<String>;
      _loading = false;
    });
  }

  List<AvaCatalogApp> get _visible {
    if (_filter.isEmpty) return _all;
    final q = _filter.toLowerCase();
    return _all.where((a) => a.name.toLowerCase().contains(q) || a.slug.contains(q)).toList();
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
      await launchUrl(Uri.parse(r.url), mode: LaunchMode.externalApplication);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Authorize in your browser, then pull to refresh.')));
      }
    } else {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('${app.name} is already connected ✓')));
    }
  }

  void _showTopUp() =>
      AvaWalletHook.instance.openTopUp(context, suggestedUsd: kMinTopUpUsd);

  Future<void> _run() async {
    final query = _ask.text.trim();
    if (query.isEmpty || _running) return;
    setState(() { _running = true; _answer = null; });
    try {
      final a = await AppsService.I.run(query);
      if (mounted) setState(() => _answer = a);
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
        child: ListView(padding: const EdgeInsets.all(20), children: [
          Row(children: [
            Expanded(child: Text('Connect your apps and let Ava act across them — read '
                'email, find a file, create a doc, check your calendar.',
                style: ZineText.sub(size: 13.5))),
            const SizedBox(width: 8),
            ZineSticker('PREMIUM', kind: ZineStickerKind.hint,
                icon: PhosphorIcons.crown(PhosphorIconsStyle.fill)),
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
            const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()))
          else if (_visible.isEmpty)
            Padding(padding: const EdgeInsets.all(20),
                child: Center(child: Text('No apps found.', style: ZineText.sub(size: 13)))),
          if (!_loading && _visible.isNotEmpty)
            Wrap(spacing: 12, runSpacing: 14, children: [for (final a in _visible) _appTile(a)]),
          const SizedBox(height: 24),
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
        ]),
      ),
    );
  }

  Widget _appTile(AvaCatalogApp app) {
    final on = _connected.contains(app.slug);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => _onTap(app),
      child: SizedBox(
        width: 76,
        child: Column(children: [
          Stack(clipBehavior: Clip.none, children: [
            Container(
              width: 56, height: 56,
              decoration: BoxDecoration(
                color: Zine.card,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: Zine.ink, width: 2),
                boxShadow: Zine.shadowXs,
              ),
              clipBehavior: Clip.antiAlias,
              child: app.logo.isNotEmpty
                  ? Image.network(app.logo, fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) => Icon(Icons.apps, color: Zine.inkSoft, size: 26))
                  : Icon(Icons.apps, color: Zine.inkSoft, size: 26),
            ),
            if (on)
              Positioned(
                right: -3, top: -3,
                child: Container(
                  width: 16, height: 16,
                  decoration: BoxDecoration(
                    color: const Color(0xFF22C55E), // green = connected
                    shape: BoxShape.circle,
                    border: Border.all(color: Zine.ink, width: 2),
                  ),
                ),
              ),
          ]),
          const SizedBox(height: 5),
          Text(app.name, maxLines: 1, overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.center, style: ZineText.sub(size: 10.5)),
        ]),
      ),
    );
  }
}

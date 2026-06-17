import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/apps_service.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// AvaApps (PREMIUM) — connect the user's Google apps (Gmail, Docs, Sheets,
/// Drive, Calendar) via Composio, then ask Ava to act across them. The model
/// runs on the user's own Gemini key; Composio executes the tools.
class AvaAppsScreen extends StatefulWidget {
  const AvaAppsScreen({super.key});
  @override
  State<AvaAppsScreen> createState() => _AvaAppsScreenState();
}

class _AvaAppsScreenState extends State<AvaAppsScreen> {
  final _q = TextEditingController();
  bool _connecting = false, _running = false, _aiOn = false, _loading = true;
  Set<String> _connected = {};
  String? _answer;

  @override
  void initState() {
    super.initState();
    _refresh();
    AppsService.I.aiConnected().then((v) { if (mounted) setState(() => _aiOn = v); });
  }

  @override
  void dispose() { _q.dispose(); super.dispose(); }

  Future<void> _refresh() async {
    final c = await AppsService.I.status();
    if (mounted) setState(() { _connected = c; _loading = false; });
  }

  Future<void> _connect() async {
    if (_connecting) return;
    setState(() => _connecting = true);
    try {
      final urls = await AppsService.I.connect();
      if (!mounted) return;
      if (urls.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('All apps already connected ✓')));
      } else {
        for (final url in urls.values) {
          await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
        }
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text('Authorize each app in your browser, then pull to refresh.')));
        }
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Connect failed: $e')));
    } finally {
      if (mounted) setState(() => _connecting = false);
    }
  }

  Future<void> _run() async {
    final query = _q.text.trim();
    if (query.isEmpty || _running) return;
    setState(() { _running = true; _answer = null; });
    try {
      final a = await AppsService.I.run(query);
      if (mounted) setState(() => _answer = a);
    } catch (e) {
      if (mounted) setState(() => _answer = 'Something went wrong: $e');
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
        onRefresh: _refresh,
        child: ListView(padding: const EdgeInsets.all(20), children: [
          Row(children: [
            Expanded(child: Text('Connect your Google apps and let Ava act across them — read '
                'email, find a file, create a doc, check your calendar. The AI runs on your own '
                'free Gemini key.', style: ZineText.sub(size: 13.5))),
            const SizedBox(width: 8),
            ZineSticker('PREMIUM', kind: ZineStickerKind.hint,
                icon: PhosphorIcons.crown(PhosphorIconsStyle.fill)),
          ]),
          const SizedBox(height: 14),
          Text('YOUR APPS', style: ZineText.kicker()),
          const SizedBox(height: 10),
          ZineCard(
            radius: Zine.rSm,
            padding: const EdgeInsets.all(8),
            boxShadow: Zine.shadowXs,
            child: Column(children: [for (final app in kAvaApps) _appRow(app)]),
          ),
          const SizedBox(height: 14),
          ZineButton(
            label: _connected.length >= kAvaApps.length ? 'All connected' : 'Connect apps',
            onPressed: _connected.length >= kAvaApps.length ? null : _connect,
            fullWidth: true, fontSize: 16, loading: _connecting,
            icon: PhosphorIcons.plugsConnected(PhosphorIconsStyle.bold), trailingIcon: false,
          ),
          const SizedBox(height: 24),
          Text('ASK AVA', style: ZineText.kicker()),
          const SizedBox(height: 10),
          if (!_aiOn) ...[
            ZineSticker('Connect Google AI Studio in Settings to enable actions.',
                kind: ZineStickerKind.hint, icon: PhosphorIcons.info(PhosphorIconsStyle.fill)),
            const SizedBox(height: 10),
          ],
          ZineCard(
            radius: Zine.rSm,
            padding: const EdgeInsets.all(12),
            boxShadow: Zine.shadowXs,
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              TextField(
                controller: _q, minLines: 2, maxLines: 4,
                style: ZineText.input(size: 15), cursorColor: Zine.blueInk,
                decoration: InputDecoration(
                  hintText: 'e.g. "Summarize my 5 latest emails" · "Create a doc with my meeting notes"',
                  hintStyle: ZineText.input(size: 14).copyWith(color: Zine.placeholder),
                  border: InputBorder.none, isDense: true,
                ),
              ),
              const SizedBox(height: 8),
              ZineButton(
                label: 'Run', onPressed: _aiOn ? _run : null,
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

  Widget _appRow(AvaApp app) {
    final on = _connected.contains(app.slug);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
      child: Row(children: [
        ZineIconBadge(icon: app.icon, color: app.color, size: 32),
        const SizedBox(width: 12),
        Expanded(child: Text(app.name, style: ZineText.value(size: 14.5))),
        if (_loading)
          Text('…', style: ZineText.sub(size: 13))
        else if (on)
          ZineSticker('CONNECTED', kind: ZineStickerKind.ok, icon: PhosphorIcons.check(PhosphorIconsStyle.bold))
        else
          ZineSticker('OFF', kind: ZineStickerKind.hint, icon: PhosphorIcons.plus(PhosphorIconsStyle.bold)),
      ]),
    );
  }
}

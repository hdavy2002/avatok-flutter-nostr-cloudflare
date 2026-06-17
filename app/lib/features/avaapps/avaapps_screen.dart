import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/apps_service.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// AvaApps — connect the free Google apps (Gmail, Calendar, Drive, Docs, Sheets,
/// Forms, Jobs, Cloud) via Klavis MCP, then ask Ava to do things across them.
/// The model runs on the user's own Gemini key; Klavis executes the tool calls.
class AvaAppsScreen extends StatefulWidget {
  const AvaAppsScreen({super.key});
  @override
  State<AvaAppsScreen> createState() => _AvaAppsScreenState();
}

class _AvaAppsScreenState extends State<AvaAppsScreen> {
  final _q = TextEditingController();
  bool _connecting = false;
  bool _running = false;
  bool _aiOn = false;
  String? _answer;

  @override
  void initState() {
    super.initState();
    AppsService.I.aiConnected().then((v) { if (mounted) setState(() => _aiOn = v); });
  }

  @override
  void dispose() {
    _q.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    if (_connecting) return;
    setState(() => _connecting = true);
    try {
      final r = await AppsService.I.connect();
      if (!mounted) return;
      if (r.oauthUrls.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Your apps are already connected ✓')));
      } else {
        // Open each service's OAuth page so the user authorizes access.
        for (final url in r.oauthUrls.values) {
          await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
        }
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text('Authorize each app in your browser, then come back.')));
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Could not start connect: $e')));
      }
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
      body: ListView(padding: const EdgeInsets.all(20), children: [
        Text('Connect your Google apps and let Ava do things across them — read '
            'email, check your calendar, find a file, update a sheet. The AI runs '
            'on your own free Gemini key.',
            style: ZineText.sub(size: 13.5)),
        const SizedBox(height: 8),
        Text('FREE APPS', style: ZineText.kicker()),
        const SizedBox(height: 10),
        ZineCard(
          radius: Zine.rSm,
          padding: const EdgeInsets.all(8),
          boxShadow: Zine.shadowXs,
          child: Column(children: [
            for (final app in kFreeAvaApps) _appRow(app),
          ]),
        ),
        const SizedBox(height: 14),
        ZineButton(
          label: 'Connect apps',
          onPressed: _connect,
          fullWidth: true,
          fontSize: 16,
          loading: _connecting,
          icon: PhosphorIcons.plugsConnected(PhosphorIconsStyle.bold),
          trailingIcon: false,
        ),
        const SizedBox(height: 24),
        Text('ASK AVA', style: ZineText.kicker()),
        const SizedBox(height: 10),
        if (!_aiOn)
          ZineSticker('Connect Google AI Studio in Settings to enable actions.',
              kind: ZineStickerKind.hint,
              icon: PhosphorIcons.info(PhosphorIconsStyle.fill)),
        if (!_aiOn) const SizedBox(height: 10),
        ZineCard(
          radius: Zine.rSm,
          padding: const EdgeInsets.all(12),
          boxShadow: Zine.shadowXs,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            TextField(
              controller: _q,
              minLines: 2,
              maxLines: 4,
              style: ZineText.input(size: 15),
              cursorColor: Zine.blueInk,
              decoration: InputDecoration(
                hintText: 'e.g. "Summarize my 5 latest emails" or "What\'s on my calendar tomorrow?"',
                hintStyle: ZineText.input(size: 14).copyWith(color: Zine.placeholder),
                border: InputBorder.none,
                isDense: true,
              ),
            ),
            const SizedBox(height: 8),
            ZineButton(
              label: 'Run',
              onPressed: _aiOn ? _run : null,
              fullWidth: true,
              fontSize: 15,
              loading: _running,
              variant: ZineButtonVariant.blue,
              icon: PhosphorIcons.sparkle(PhosphorIconsStyle.bold),
              trailingIcon: false,
            ),
          ]),
        ),
        if (_answer != null) ...[
          const SizedBox(height: 14),
          ZineCard(
            radius: Zine.rSm,
            padding: const EdgeInsets.all(14),
            boxShadow: Zine.shadowXs,
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              ZineIconBadge(
                  icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
                  color: Zine.lilac, size: 30),
              const SizedBox(width: 12),
              Expanded(child: SelectableText(_answer!, style: ZineText.value(size: 14.5))),
            ]),
          ),
        ],
        const SizedBox(height: 24),
        Center(child: Text('MORE APPS COMING — PREMIUM',
            style: ZineText.kicker(size: 10, color: Zine.inkMute))),
      ]),
    );
  }

  Widget _appRow(AvaApp app) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
        child: Row(children: [
          ZineIconBadge(icon: app.icon, color: app.color, size: 32),
          const SizedBox(width: 12),
          Expanded(child: Text(app.name, style: ZineText.value(size: 14.5))),
          ZineSticker('FREE', kind: ZineStickerKind.ok,
              icon: PhosphorIcons.check(PhosphorIconsStyle.bold)),
        ]),
      );
}

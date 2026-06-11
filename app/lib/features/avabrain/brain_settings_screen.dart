import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/brain_api.dart';
import '../../core/brain_consent.dart';
import '../../core/theme.dart';
import '../../core/ui/zine_widgets.dart';

/// AvaBrain control room (Phase 9) — the master switch + per-app guardrail
/// toggles the server ingestion pipeline obeys (default ON, opt-out; the same
/// keys are also surfaced in the main Settings per rulebook §3). Toggling OFF
/// stops new ingestion AND (server flag BRAIN_RETRO_DELETE) deletes the
/// already-indexed items from that source.
class BrainSettingsScreen extends StatefulWidget {
  const BrainSettingsScreen({super.key});
  @override
  State<BrainSettingsScreen> createState() => _BrainSettingsScreenState();
}

class _BrainSettingsScreenState extends State<BrainSettingsScreen> {
  Map<String, bool> _state = {};
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    BrainConsent.pull().then((_) => BrainConsent.all()).then((m) {
      if (mounted) setState(() => _state = m);
    });
  }

  Future<void> _set(String key, bool v) async {
    setState(() => _state[key] = v);
    await BrainConsent.set(key, v);
    if (!v && key != 'master' && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Stopped — anything already remembered from this source is being deleted')));
    }
  }

  Future<void> _deleteAll() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Zine.card,
        title: Text('Delete my AvaBrain data?', style: ZineText.cardTitle()),
        content: Text(
            'This wipes everything AvaBrain has remembered about you — search vectors, voice-note transcripts and the knowledge graph. Your actual messages and files are NOT touched. This cannot be undone.',
            style: ZineText.sub(size: 14)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false),
              child: Text('Keep it', style: ZineText.tag(size: 13, color: Zine.inkSoft))),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: Text('Delete', style: ZineText.tag(size: 13, color: Zine.coral))),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() => _busy = true);
    final done = await BrainApi.purge();
    if (!mounted) return;
    setState(() => _busy = false);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(done ? 'Your AvaBrain data is being deleted' : "Couldn't reach the server — try again")));
  }

  @override
  Widget build(BuildContext context) {
    final masterOn = _state['master'] ?? true;
    return Scaffold(
      appBar: ZineAppBar(
        title: 'AvaBrain',
        markWord: 'Brain',
        tag: 'WHAT YOUR AGENT MAY REMEMBER',
        showBack: Navigator.of(context).canPop(),
      ),
      body: ZinePaper(
        child: ListView(padding: const EdgeInsets.fromLTRB(16, 16, 16, 28), children: [
          // Intro — AI surface, lilac accent.
          ZineCard(
            color: Zine.lilac,
            padding: const EdgeInsets.all(14),
            boxShadow: Zine.shadowSm,
            child: Row(children: [
              ZineIconBadge(icon: PhosphorIcons.brain(PhosphorIconsStyle.fill), color: Zine.card),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  'AvaBrain powers AvaChat. It only ever reads YOUR content, and you control exactly what it may remember.',
                  style: ZineText.sub(size: 13, color: Zine.ink),
                ),
              ),
            ]),
          ),
          const SizedBox(height: 20),
          _section('Sources'),
          ZineCard(
            radius: Zine.rSm,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
            boxShadow: Zine.shadowXs,
            child: Column(children: [
              for (final c in kBrainCapabilities)
                if (c.master || masterOn)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 9),
                    child: Row(children: [
                      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(c.title, style: ZineText.value(size: 14.5,
                            weight: c.master ? FontWeight.w900 : FontWeight.w800)),
                        const SizedBox(height: 2),
                        Text(c.subtitle, style: ZineText.sub(size: 12)),
                      ])),
                      const SizedBox(width: 10),
                      ZineToggle(value: _state[c.key] ?? true, onChanged: (v) => _set(c.key, v)),
                    ]),
                  ),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.only(top: 10, left: 4, right: 4),
            child: Text(
                'Private and end-to-end-encrypted content is only ever read on your device — '
                'AvaBrain never sees your message keys or plaintext on our servers.',
                style: ZineText.sub(size: 11.5, color: Zine.inkMute)),
          ),
          const SizedBox(height: 24),
          _section('Danger zone'),
          ZinePressable(
            onTap: _busy ? null : _deleteAll,
            radius: BorderRadius.circular(Zine.rSm),
            boxShadow: Zine.shadowXs,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            child: Row(children: [
              _busy
                  ? const SizedBox(width: 34, height: 34,
                      child: Center(child: SizedBox(width: 20, height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2.4, color: Zine.coral))))
                  : ZineIconBadge(icon: PhosphorIcons.trash(PhosphorIconsStyle.bold), color: Zine.coral, size: 34),
              const SizedBox(width: 12),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Delete my AvaBrain data', style: ZineText.value(size: 15, color: Zine.coral)),
                const SizedBox(height: 2),
                Text('Wipes vectors, transcripts and the knowledge graph — not your real files',
                    style: ZineText.sub(size: 12)),
              ])),
            ]),
          ),
        ]),
      ),
    );
  }

  Widget _section(String t) => Padding(
        padding: const EdgeInsets.only(bottom: 10, left: 4),
        child: Text(t.toUpperCase(), style: ZineText.kicker()),
      );
}

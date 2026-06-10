import 'package:flutter/material.dart';

import '../../core/brain_api.dart';
import '../../core/brain_consent.dart';
import '../../core/theme.dart';

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
  static const _accent = Color(0xFFA06AF0);
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
        title: const Text('Delete my AvaBrain data?'),
        content: const Text(
            'This wipes everything AvaBrain has remembered about you — search vectors, voice-note transcripts and the knowledge graph. Your actual messages and files are NOT touched. This cannot be undone.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Delete', style: TextStyle(color: AvaColors.danger))),
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
      backgroundColor: AvaColors.bg,
      appBar: AppBar(
        backgroundColor: AvaColors.bg, elevation: 0,
        iconTheme: const IconThemeData(color: AvaColors.ink),
        title: const Text('AvaBrain', style: TextStyle(color: AvaColors.ink, fontWeight: FontWeight.w700)),
      ),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 28), children: [
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: _accent.withValues(alpha: .08),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: _accent.withValues(alpha: .25)),
          ),
          child: const Row(children: [
            Icon(Icons.psychology_outlined, color: _accent),
            SizedBox(width: 10),
            Expanded(
              child: Text(
                'AvaBrain powers AvaChat. It only ever reads YOUR content, and you control exactly what it may remember.',
                style: TextStyle(color: AvaColors.ink, fontSize: 13, height: 1.35),
              ),
            ),
          ]),
        ),
        const SizedBox(height: 12),
        for (final c in kBrainCapabilities)
          if (c.master || masterOn)
            SwitchListTile(
              contentPadding: const EdgeInsets.symmetric(horizontal: 4),
              activeTrackColor: _accent,
              title: Text(c.title,
                  style: TextStyle(
                      color: AvaColors.ink,
                      fontSize: 15,
                      fontWeight: c.master ? FontWeight.w700 : FontWeight.w500)),
              subtitle: Text(c.subtitle, style: const TextStyle(color: AvaColors.sub, fontSize: 12.5)),
              value: _state[c.key] ?? true,
              onChanged: (v) => _set(c.key, v),
            ),
        const SizedBox(height: 18),
        const Divider(color: AvaColors.line),
        ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 4),
          leading: _busy
              ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2, color: AvaColors.danger))
              : const Icon(Icons.delete_forever_outlined, color: AvaColors.danger),
          title: const Text('Delete my AvaBrain data',
              style: TextStyle(color: AvaColors.danger, fontWeight: FontWeight.w600, fontSize: 15)),
          subtitle: const Text('Wipes vectors, transcripts and the knowledge graph — not your real files',
              style: TextStyle(color: AvaColors.sub, fontSize: 12.5)),
          onTap: _busy ? null : _deleteAll,
        ),
      ]),
    );
  }
}

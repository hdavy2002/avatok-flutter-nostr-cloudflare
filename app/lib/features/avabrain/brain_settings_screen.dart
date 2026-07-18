import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/account_storage.dart';
import '../../core/analytics.dart';
import '../../core/brain_api.dart';
import '../../core/brain_consent.dart';
import '../../core/theme.dart';
import '../../core/ui/zine_widgets.dart';

/// AvaBrain control room (One-Brain B0) — the master switch + per-domain
/// guardrail toggles the server ingestion pipeline obeys. The toggle list is
/// GENERATED from the server domain registry (`GET /api/brain/domains`), deduped
/// to one switch per consentKey; it is never hard-coded. All default ON
/// (opt-out). Turning one OFF stops new ingestion AND queues a scoped deletion
/// of what was already indexed from that domain.
class BrainSettingsScreen extends StatefulWidget {
  const BrainSettingsScreen({super.key});
  @override
  State<BrainSettingsScreen> createState() => _BrainSettingsScreenState();
}

class _BrainSettingsScreenState extends State<BrainSettingsScreen> {
  static const _s = FlutterSecureStorage(
    mOptions: MacOsOptions(useDataProtectionKeyChain: false),
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  static const _deletedAtKey = 'brain_deleted_at';

  List<BrainToggle> _toggles = [];
  Map<String, bool> _state = {};
  bool _loading = true;

  // Deletion job UI state.
  bool _deleting = false;
  String? _deleteMessage; // shown under the danger button
  DateTime? _deletedAt; // last successful deletion (persisted, scoped)

  @override
  void initState() {
    super.initState();
    Analytics.capture('brain_settings_opened', {
      if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
    });
    _load();
    _loadDeletedAt();
  }

  Future<void> _load() async {
    // Refresh the registry from the server (falls back to cache/spec offline),
    // and pull server consent, then render both.
    await BrainConsent.refreshDomains();
    await BrainConsent.pull();
    final toggles = await BrainConsent.toggles();
    final state = await BrainConsent.all();
    if (!mounted) return;
    setState(() {
      _toggles = toggles;
      _state = state;
      _loading = false;
    });
  }

  Future<void> _loadDeletedAt() async {
    try {
      final raw = await _s.read(key: scopedKey(_deletedAtKey));
      if (raw != null && raw.isNotEmpty && mounted) {
        setState(() => _deletedAt = DateTime.tryParse(raw));
      }
    } catch (_) {}
  }

  Future<void> _set(String consentKey, bool v) async {
    setState(() => _state[consentKey] = v);
    await BrainConsent.set(consentKey, v);
    Analytics.capture('brain_toggle_changed', {
      'domain': consentKey,
      'value': v,
      if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
    });
    if (!v && consentKey != 'master' && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Stopped — anything already remembered from this source is being deleted')));
    }
  }

  // ── Delete my AvaBrain data (stateful deletion contract, §5.1) ─────────────

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
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: Text('Keep it', style: ZineText.tag(size: 13, color: Zine.inkSoft))),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: Text('Delete', style: ZineText.tag(size: 13, color: Zine.coral))),
        ],
      ),
    );
    if (ok != true || !mounted) return;

    Analytics.capture('brain_delete_requested', {
      if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
    });
    setState(() {
      _deleting = true;
      _deleteMessage = 'Deleting…';
    });

    BrainDeletion job;
    try {
      job = await BrainApi.deleteAll();
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _deleting = false;
        _deleteMessage = "Couldn't reach the server — try again";
      });
      return;
    }

    if (job.id.isEmpty) {
      // Server accepted but returned no job id — can't poll; treat optimistically.
      _finishDeletion(job.isComplete || job.state.isEmpty ? 'complete' : job.state, job);
      return;
    }

    // Poll delete_status until terminal (or we give up waiting).
    var current = job;
    for (var i = 0; i < 40 && !current.isTerminal; i++) {
      await Future<void>.delayed(const Duration(seconds: 2));
      if (!mounted) return;
      try {
        current = await BrainApi.deleteStatus(job.id);
      } catch (_) {
        // Transient poll failure — keep trying within the budget.
      }
    }
    if (!mounted) return;
    _finishDeletion(current.isTerminal ? current.state : 'partial', current);
  }

  void _finishDeletion(String state, BrainDeletion job) {
    Analytics.capture('brain_delete_completed', {
      'state': state,
      if (job.id.isNotEmpty) 'job_id': job.id,
      if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
    });
    if (state == 'complete') {
      final when = job.completedAt ?? DateTime.now();
      _persistDeletedAt(when);
      if (!mounted) return;
      setState(() {
        _deleting = false;
        _deletedAt = when;
        _deleteMessage = 'Your data was deleted on ${_fmtDate(when)}';
      });
    } else if (state == 'partial') {
      if (!mounted) return;
      setState(() {
        _deleting = false;
        _deleteMessage = 'Some data is still being deleted — we\'ll keep trying in the background.';
      });
    } else {
      // failed / unknown
      if (!mounted) return;
      setState(() {
        _deleting = false;
        _deleteMessage = "We couldn't finish deleting just now — please try again.";
      });
    }
  }

  Future<void> _persistDeletedAt(DateTime when) async {
    try {
      await _s.write(key: scopedKey(_deletedAtKey), value: when.toIso8601String());
    } catch (_) {}
  }

  static const _months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];
  String _fmtDate(DateTime d) => '${d.day} ${_months[d.month - 1]} ${d.year}';

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
          _sourcesCard(masterOn),
          Padding(
            padding: const EdgeInsets.only(top: 10, left: 4, right: 4),
            child: Text(
                'Private and end-to-end-encrypted content is only ever read on your device — '
                'AvaBrain never sees your message keys or plaintext on our servers.',
                style: ZineText.sub(size: 11.5, color: Zine.inkMute)),
          ),
          const SizedBox(height: 24),
          _section('Danger zone'),
          _dangerCard(),
        ]),
      ),
    );
  }

  Widget _sourcesCard(bool masterOn) {
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      boxShadow: Zine.shadowXs,
      child: _loading
          ? const Padding(
              padding: EdgeInsets.symmetric(vertical: 22),
              child: Center(
                  child: SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(strokeWidth: 2.4, color: Zine.lilac))),
            )
          : Column(children: [
              // Master switch — always shown.
              _row('master', 'AvaBrain',
                  'Let AvaBrain learn from your activity to help you across apps',
                  value: masterOn, master: true),
              // Per-domain toggles (registry-driven), only when master is on.
              if (masterOn)
                for (final t in _toggles)
                  _row(t.consentKey, t.label, t.description,
                      value: _state[t.consentKey] ?? t.defaultOn),
            ]),
    );
  }

  Widget _row(String key, String title, String sub, {required bool value, bool master = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 9),
      child: Row(children: [
        Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title,
              style: ZineText.value(size: 14.5, weight: master ? FontWeight.w900 : FontWeight.w800)),
          const SizedBox(height: 2),
          Text(sub, style: ZineText.sub(size: 12)),
        ])),
        const SizedBox(width: 10),
        ZineToggle(value: value, onChanged: (v) => _set(key, v)),
      ]),
    );
  }

  Widget _dangerCard() {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      ZinePressable(
        onTap: _deleting ? null : _deleteAll,
        radius: BorderRadius.circular(Zine.rSm),
        boxShadow: Zine.shadowXs,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(children: [
          _deleting
              ? const SizedBox(
                  width: 34,
                  height: 34,
                  child: Center(
                      child: SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2.4, color: Zine.coral))))
              : ZineIconBadge(
                  icon: PhosphorIcons.trash(PhosphorIconsStyle.bold), color: Zine.coral, size: 34),
          const SizedBox(width: 12),
          Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Delete my AvaBrain data', style: ZineText.value(size: 15, color: Zine.coral)),
            const SizedBox(height: 2),
            Text('Wipes vectors, transcripts and the knowledge graph — not your real files',
                style: ZineText.sub(size: 12)),
          ])),
        ]),
      ),
      if (_deleteMessage != null)
        Padding(
          padding: const EdgeInsets.only(top: 10, left: 4, right: 4),
          child: Text(_deleteMessage!, style: ZineText.sub(size: 12, color: Zine.inkSoft)),
        )
      else if (_deletedAt != null)
        Padding(
          padding: const EdgeInsets.only(top: 10, left: 4, right: 4),
          child: Text('Your data was deleted on ${_fmtDate(_deletedAt!)}',
              style: ZineText.sub(size: 12, color: Zine.inkSoft)),
        ),
    ]);
  }

  Widget _section(String t) => Padding(
        padding: const EdgeInsets.only(bottom: 10, left: 4),
        child: Text(t.toUpperCase(), style: ZineText.kicker()),
      );
}

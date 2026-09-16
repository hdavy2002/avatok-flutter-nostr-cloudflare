
import '../../core/localization/ui_text.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/account_storage.dart';
import '../../core/analytics.dart';
import '../../core/brain_api.dart';
import '../../core/brain_consent.dart';
import '../../core/brain_recall.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';

/// Paragraph copy on this screen. `ADText.preview` is the right weight/colour but
/// sits at height 1.2; these are multi-line explanations, so the 1.42 line height
/// the old `ZineText.sub` used is kept to avoid re-flowing every card.
TextStyle _body(double size, [Color c = AD.textSecondary]) =>
    ADText.preview(c: c).copyWith(fontSize: size, height: 1.42);

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
  // §10.1 — legal-basis domains (e.g. Safety records) shown as info disclosures, not switches.
  List<BrainDomain> _disclosures = [];
  Map<String, bool> _state = {};
  bool _loading = true;

  // B-D6 / §6 — per-account "Local-only answers" toggle (default OFF).
  bool _localOnly = false;

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
    final disclosures = await BrainConsent.disclosures();
    final state = await BrainConsent.all();
    final localOnly = await LocalOnlyAnswers.isOn();
    if (!mounted) return;
    setState(() {
      _toggles = toggles;
      _disclosures = disclosures;
      _state = state;
      _localOnly = localOnly;
      _loading = false;
    });
  }

  Future<void> _setLocalOnly(bool v) async {
    setState(() => _localOnly = v);
    await LocalOnlyAnswers.set(v); // persists (scoped) + emits local_only_toggled
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
          content: UiText(UiMessage.m_stopped_anything_already_remembered_from_e5d0ba1210)));
    }
  }

  // ── Delete my AvaBrain data (stateful deletion contract, §5.1) ─────────────

  Future<void> _deleteAll() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AD.popover,
        title: UiText(UiMessage.m_delete_my_avabrain_data_81a8921efa,
            style: ADText.threadName().copyWith(fontSize: 19)),
        content: UiText(
            UiMessage.m_this_wipes_everything_avabrain_has_e7bb2ce174,
            style: _body(14)),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: UiText(UiMessage.m_keep_it_fdce5da2ce, style: ADText.rowName(c: AD.textSecondary).copyWith(fontSize: 13))),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: UiText(UiMessage.m_delete_e2d0a54968, style: ADText.rowName(c: AD.danger).copyWith(fontSize: 13))),
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
    UiLocaleScope.watch(context);
    final masterOn = _state['master'] ?? true;
    return Scaffold(
      appBar: ZineAppBar(
        title: uiCopy(UiMessage.m_avabrain_7012aa07e1),
        markWord: 'Brain',
        tag: 'What your agent may remember',
        showBack: Navigator.of(context).canPop(),
      ),
      body: ZinePaper(
        child: ListView(padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, Msg.s6), children: [
          // Intro. FILL/INK COLLAPSE FIXED: this used to be a pale lilac card with
          // near-black ink and a white icon badge. Mapping the fill straight to a
          // dark lilac would have left a saturated surface carrying a full
          // paragraph. The card is neutral now and the AI accent lives on the
          // brain glyph, which is what the colour was signalling anyway.
          ZineCard(
            padding: const EdgeInsets.all(Msg.s4),
            child: Row(children: [
              ZineIconBadge(icon: PhosphorIcons.brain(PhosphorIconsStyle.fill), color: AD.tabCalls),
              const SizedBox(width: Msg.s3),
              Expanded(
                child: UiText(
                  UiMessage.m_avabrain_powers_avachat_it_only_88578bcf30,
                  style: _body(13, AD.textPrimary),
                ),
              ),
            ]),
          ),
          const SizedBox(height: Msg.s5),
          _section('Sources'),
          _sourcesCard(masterOn),
          Padding(
            padding: const EdgeInsets.only(top: Msg.s3, left: Msg.s1, right: Msg.s1),
            child: UiText(
                UiMessage.m_private_and_end_to_end_7c5308958d,
                style: _body(12, AD.textTertiary)),
          ),
          const SizedBox(height: Msg.s5),
          _section('Privacy'),
          _privacyCard(),
          const SizedBox(height: Msg.s5),
          _section('Danger zone'),
          _dangerCard(),
        ]),
      ),
    );
  }

  Widget _sourcesCard(bool masterOn) {
    return ZineCard(
      radius: Msg.rLg,
      padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s2),
      boxShadow: Msg.none,
      child: _loading
          ? const Padding(
              padding: EdgeInsets.symmetric(vertical: Msg.s5),
              child: Center(
                  child: SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(strokeWidth: 2.4, color: AD.primaryBadge))),
            )
          : Column(children: [
              // Master switch — always shown.
              _row('master', 'AvaBrain',
                  'Let AvaBrain learn from your activity to help you across apps',
                  value: masterOn, master: true),
              // Per-domain toggles (registry-driven), only when master is on.
              // [AVABRAIN-ASSET-1] brain_image_analysis / brain_file_indexing /
              // brain_audio_transcription / brain_sensitive_media (Part VI §40/
              // §47) arrive here automatically once the server registry lists
              // them (worker/src/routes/brain_domains.ts) — this loop needs no
              // per-key special-casing to RENDER them; only the sensitive-media
              // row gets a distinct warning treatment below (§40 requires an
              // EXPLICIT opt-in for sensitive media, unlike every other
              // opt-out-by-default toggle here).
              if (masterOn)
                for (final t in _toggles)
                  t.consentKey == 'brain_sensitive_media'
                      ? _sensitiveRow(t, value: _state[t.consentKey] ?? t.defaultOn)
                      : _row(t.consentKey, t.label, t.description,
                          value: _state[t.consentKey] ?? t.defaultOn),
              // §10.1 legal-basis DISCLOSURES (e.g. Safety records) — always shown, no
              // switch. Safety processing runs on legitimate interest, not consent, so
              // it is not gated by the master switch either.
              for (final d in _disclosures) _disclosureRow(d),
            ]),
    );
  }

  Widget _privacyCard() {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      ZineCard(
        radius: Msg.rLg,
        padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s2),
        boxShadow: Msg.none,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: Msg.s2),
          child: Row(children: [
            Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              UiText(UiMessage.m_local_only_answers_6218eef2dc, style: ADText.rowName()),
              const SizedBox(height: 2),
              UiText(
                  UiMessage.m_when_on_ava_never_sends_d11848ada1,
                  style: _body(12)),
            ])),
            const SizedBox(width: Msg.s3),
            ZineToggle(value: _localOnly, onChanged: _setLocalOnly),
          ]),
        ),
      ),
    ]);
  }

  Widget _row(String key, String title, String sub, {required bool value, bool master = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Msg.s2),
      child: Row(children: [
        Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title,
              style: ADText.rowName()
                  .copyWith(fontWeight: master ? FontWeight.w700 : FontWeight.w600)),
          const SizedBox(height: 2),
          Text(sub, style: _body(12)),
        ])),
        const SizedBox(width: Msg.s3),
        ZineToggle(value: value, onChanged: (v) => _set(key, v)),
      ]),
    );
  }

  // [AVABRAIN-ASSET-1] Part VI §40 — "require an explicit adult-content/privacy
  // setting before indexing sensitive media". Same Switch as [_row] (this IS a
  // real, movable consent toggle, unlike the legal-basis disclosures below —
  // see worker/src/lib/brain_assets.ts's header for why it's a real gate), but
  // with a warning icon + explicit copy so turning it ON is a deliberate act,
  // not a row that looks identical to "remember my contacts".
  Widget _sensitiveRow(BrainToggle t, {required bool value}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Msg.s2),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ZineIconBadge(
            icon: PhosphorIcons.warningCircle(PhosphorIconsStyle.fill), color: AD.destructiveBg, size: 30),
        const SizedBox(width: Msg.s3),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(t.label, style: ADText.rowName()),
            const SizedBox(height: 2),
            Text(t.description, style: _body(12)),
          ]),
        ),
        const SizedBox(width: Msg.s3),
        ZineToggle(value: value, onChanged: (v) => _set(t.consentKey, v)),
      ]),
    );
  }

  // §10.1 — a legal-basis domain rendered as an info DISCLOSURE: an icon + a plain
  // explanation + a "Learn more" affordance opening the explainer dialog. NEVER a
  // Switch (a control the user cannot move would be a consent UI that lies).
  Widget _disclosureRow(BrainDomain d) {
    final label = d.label.isEmpty ? 'Safety records' : d.label;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Msg.s2),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ZineIconBadge(
            icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill), color: AD.tabCalls, size: 30),
        const SizedBox(width: Msg.s3),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(label, style: ADText.rowName()),
            const SizedBox(height: 2),
            GestureDetector(
              onTap: () => _showDisclosure(d),
              behavior: HitTestBehavior.opaque,
              child: Text.rich(TextSpan(style: _body(12), children: [
                 TextSpan(text: uiCopy(UiMessage.m_kept_for_platform_safety_not_11590a1d61)),
                TextSpan(text: uiCopy(UiMessage.m_learn_more_1445799c03), style: _body(12, Msg.accent)),
              ])),
            ),
          ]),
        ),
      ]),
    );
  }

  void _showDisclosure(BrainDomain d) {
    Analytics.capture('brain_disclosure_opened', {
      'domain': d.key,
      if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
    });
    final label = d.label.isEmpty ? 'Safety records' : d.label;
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AD.popover,
        title: Text(label, style: ADText.threadName().copyWith(fontSize: 19)),
        content: UiText(
            UiMessage.m_to_keep_everyone_safe_ava_02d93f221a,
            style: _body(14)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: UiText(UiMessage.m_got_it_5ad3dbd124, style: ADText.rowName(c: AD.textSecondary).copyWith(fontSize: 13)),
          ),
        ],
      ),
    );
  }

  Widget _dangerCard() {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      ZinePressable(
        onTap: _deleting ? null : _deleteAll,
        radius: Msg.brMd,
        boxShadow: Msg.none,
        padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s3),
        child: Row(children: [
          _deleting
              ? const SizedBox(
                  width: 34,
                  height: 34,
                  child: Center(
                      child: SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2.4, color: AD.danger))))
              : ZineIconBadge(
                  icon: PhosphorIcons.trash(PhosphorIconsStyle.bold), color: AD.destructiveBg, size: 34),
          const SizedBox(width: Msg.s3),
          Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            UiText(UiMessage.m_delete_my_avabrain_data_7a7aecfaa4, style: ADText.rowName(c: AD.danger)),
            const SizedBox(height: 2),
            UiText(UiMessage.m_wipes_vectors_transcripts_and_the_060fcd89f6,
                style: _body(12)),
          ])),
        ]),
      ),
      if (_deleteMessage != null)
        Padding(
          padding: const EdgeInsets.only(top: Msg.s3, left: Msg.s1, right: Msg.s1),
          child: Text(_deleteMessage!, style: _body(12)),
        )
      else if (_deletedAt != null)
        Padding(
          padding: const EdgeInsets.only(top: Msg.s3, left: Msg.s1, right: Msg.s1),
          child: UiText(UiMessage.m_your_data_was_deleted_on_7e553ed426, params: {'value1': (_fmtDate(_deletedAt!)).toString()},
              style: _body(12)),
        ),
    ]);
  }

  Widget _section(String t) => Padding(
        padding: const EdgeInsets.only(bottom: Msg.s3, left: Msg.s1),
        child: Text(t, style: ADText.sectionLabel()),
      );
}

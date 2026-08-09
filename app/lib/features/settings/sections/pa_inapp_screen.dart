// [PA-UI-2] "AvaTOK calls" — Ava as your receptionist on AvaTOK↔AvaTOK calls.
//
// The in-app lane screen of the approved receptionist redesign. The hub
// (receptionist_section.dart, [PA-UI-1]) pushes this screen; this screen owns
// the four AvaTOK-lane scenario toggles (recept_avatok_rejected /
// recept_avatok_not_picked_up / recept_avatok_unreachable /
// recept_avatok_redirect_all) plus the entry to Call rules.
//
// No carrier setup exists on this lane — an AvaTOK call is delivered by our own
// push/WS path, so a toggle here works the moment it is saved. That is the one
// structural difference from pa_phone_screen.dart.
//
// Toggles SAVE IMMEDIATELY. The receptionist PUT overwrites every column, so
// each flip re-sends the FULL settings payload loaded in initState with exactly
// one field changed; a failed save reverts the switch and says so.
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/ava_log.dart';
import '../../../core/receptionist_api.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import '../../../core/ui/zine_widgets.dart';
import 'receptionist_rules_screen.dart';

/// Inline dark v2 header band — same pattern as receptionist_rules_screen.dart's
/// `_darkHeader` (private there, hence the copy).
PreferredSizeWidget _paHeader({required String title, String? tag}) {
  return PreferredSize(
    preferredSize: Size.fromHeight(tag == null ? 76 : 92),
    child: Container(
      decoration: const BoxDecoration(
        color: AD.headerFooter,
        border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
      ),
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s3, Msg.s4, Msg.s3),
          child: Row(children: [
            const AdBackButton(),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title,
                      style: ADText.appTitle(),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis),
                  if (tag != null) ...[
                    const SizedBox(height: 2),
                    Text(tag, style: ADText.sectionLabel()),
                  ],
                ],
              ),
            ),
          ]),
        ),
      ),
    ),
  );
}

class PaInAppScreen extends StatefulWidget {
  const PaInAppScreen({super.key});

  @override
  State<PaInAppScreen> createState() => _PaInAppScreenState();
}

class _PaInAppScreenState extends State<PaInAppScreen> {
  /// Server settings loaded once — every immediate save re-sends this payload
  /// with a single field replaced (the PUT overwrites every column).
  ReceptionistSettings? _settings;
  bool _loading = true;
  bool _loadFailed = false;

  /// Which backend field is mid-save (drives the small inline "Saving…" hint).
  String? _savingField;

  bool _rejected = true;
  bool _notPickedUp = true;
  bool _unreachable = false;
  bool _redirectAll = false;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('settings', 'pa_inapp');
    _load();
  }

  Future<void> _load() async {
    final s = await ReceptionistApi.getSettings();
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (s == null) {
        _loadFailed = true;
      } else {
        _settings = s;
        _loadFailed = false;
        _rejected = s.receptAvatokRejected;
        _notPickedUp = s.receptAvatokNotPickedUp;
        _unreachable = s.receptAvatokUnreachable;
        _redirectAll = s.receptAvatokRedirectAll;
      }
    });
  }

  // ── immediate save ─────────────────────────────────────────────────────────

  Future<void> _flip(
    String field,
    bool value,
    void Function(bool) apply,
  ) async {
    final s = _settings;
    if (s == null || _savingField != null) return;
    setState(() {
      apply(value);
      _savingField = field;
    });
    Analytics.uiInteraction('pa_inapp_toggle', 0,
        extra: {'toggle': field, 'value': value});
    final res = await ReceptionistApi.saveSettings(
      // ALWAYS-ON (owner decision 2026-07-07) — see pa_phone_screen.dart.
      enabled: true,
      instructions: s.instructions,
      displayName: s.displayName,
      personaName: s.personaName,
      languageCode: s.languageCode,
      greetingText: s.greetingText,
      customPrompt: s.customPrompt,
      answerAll: s.answerAll,
      statusPreset: s.statusPreset,
      statusCustom: s.statusCustom,
      declineToAva: s.declineToAva,
      statusNote: s.statusNote,
      statusExpiresAt: s.statusExpiresAt,
      answerLang: s.answerLang,
      answerLangSource: s.answerLang.isEmpty ? 'detected' : 'user',
      greetingStyle: s.greetingStyle,
      festivalGreeting: s.festivalGreeting,
      mode: s.mode,
      agentScope: s.agentScope,
      // The PSTN lane passes through untouched.
      receptPstnNotPickedUp: s.receptPstnNotPickedUp,
      receptPstnRejected: s.receptPstnRejected,
      receptPstnUnreachable: s.receptPstnUnreachable,
      receptPstnRedirectAll: s.receptPstnRedirectAll,
      // This lane — the only values this screen owns.
      receptAvatokNotPickedUp: _notPickedUp,
      receptAvatokRejected: _rejected,
      receptAvatokUnreachable: _unreachable,
      receptAvatokRedirectAll: _redirectAll,
    );
    if (!mounted) return;
    setState(() => _savingField = null);
    if (res.ok) {
      Analytics.capture('pa_inapp_toggle_saved', {'toggle': field, 'value': value});
      return;
    }
    setState(() => apply(!value)); // revert — the server did not take it
    AvaLog.I.log('receptionist', 'pa_inapp toggle $field save FAILED (want=$value)');
    Analytics.capture('pa_inapp_toggle_failed', {'toggle': field, 'value': value});
    _toast(res.blocked
        ? 'That needs a premium plan.'
        : 'Couldn’t save — check your connection and try again.');
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  // ── UI ─────────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: _paHeader(title: 'AvaTOK calls', tag: 'Ava PA'),
      body: _loading
          ? const Center(
              child: SizedBox(
                  width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2)))
          : ListView(
              padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s4, Msg.s5, Msg.s6),
              children: [
                _explainer(),
                if (_loadFailed) ...[
                  const SizedBox(height: 16),
                  _loadFailedCard(),
                ],
                const SizedBox(height: 16),
                Text('WHEN SHOULD AVA ANSWER?', style: ADText.sectionLabel()),
                const SizedBox(height: Msg.s2),
                AdCard(
                  padding: const EdgeInsets.symmetric(
                      horizontal: Msg.s4, vertical: Msg.s2),
                  child: Column(children: [
                    _toggleRow(
                      title: 'I decline a call',
                      field: 'recept_avatok_rejected',
                      value: _rejected,
                      apply: (v) => _rejected = v,
                    ),
                    const Divider(height: 1, color: AD.borderHairline),
                    _toggleRow(
                      title: 'I miss a call',
                      field: 'recept_avatok_not_picked_up',
                      value: _notPickedUp,
                      apply: (v) => _notPickedUp = v,
                    ),
                    const Divider(height: 1, color: AD.borderHairline),
                    _toggleRow(
                      title: 'I’m offline',
                      field: 'recept_avatok_unreachable',
                      value: _unreachable,
                      apply: (v) => _unreachable = v,
                    ),
                  ]),
                ),
                const SizedBox(height: 16),
                Text('ADVANCED', style: ADText.sectionLabel()),
                const SizedBox(height: Msg.s2),
                AdCard(
                  padding: const EdgeInsets.symmetric(
                      horizontal: Msg.s4, vertical: Msg.s2),
                  child: _toggleRow(
                    title: 'Send every call to Ava',
                    sub: 'She always answers first',
                    field: 'recept_avatok_redirect_all',
                    value: _redirectAll,
                    apply: (v) => _redirectAll = v,
                  ),
                ),
                const SizedBox(height: 16),
                _rulesRow(),
              ],
            ),
    );
  }

  Widget _explainer() => AdCard(
        padding: const EdgeInsets.all(Msg.s4),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          ZineIconBadge(
              icon: PhosphorIcons.chatCircle(PhosphorIconsStyle.fill),
              color: AD.online,
              size: 36),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              'When you can’t take an AvaTOK call, Ava receives it for you and '
              'leaves the message in your chat.',
              style: ADText.preview(),
            ),
          ),
        ]),
      );

  Widget _loadFailedCard() => AdCard(
        padding: const EdgeInsets.all(Msg.s4),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            PhosphorIcon(PhosphorIcons.warning(PhosphorIconsStyle.fill),
                size: 18, color: AD.primaryBadge),
            const SizedBox(width: 8),
            Expanded(
                child: Text('Couldn’t load your settings',
                    style: ADText.rowName())),
          ]),
          const SizedBox(height: Msg.s1),
          Text(
            'These switches are showing defaults and can’t be changed until '
            'AvaTOK reaches the server.',
            style: ADText.preview(),
          ),
          const SizedBox(height: 12),
          AdButton(
            label: 'Try again',
            variant: AdButtonVariant.ghost,
            fullWidth: true,
            fontSize: 14,
            onPressed: () {
              setState(() => _loading = true);
              _load();
            },
          ),
        ]),
      );

  Widget _rulesRow() => ZinePressable(
        onTap: () {
          Analytics.uiInteraction('pa_inapp_rules_entry', 0);
          Navigator.of(context).push(MaterialPageRoute<void>(
              builder: (_) => const ReceptionistRulesScreen()));
        },
        color: AD.card,
        borderColor: AD.borderControl,
        radius: BorderRadius.circular(AD.rInput),
        boxShadow: const [],
        padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s4),
        child: Row(children: [
          Icon(PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold),
              size: 18, color: AD.textSecondary),
          const SizedBox(width: Msg.s2),
          Expanded(
              child: Text('Call rules — tell Ava what to say',
                  style: ADText.rowName())),
          Icon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
              size: 16, color: AD.textTertiary),
        ]),
      );

  Widget _toggleRow({
    required String title,
    required String field,
    required bool value,
    required void Function(bool) apply,
    String? sub,
  }) {
    final saving = _savingField == field;
    final disabled = _settings == null || (_savingField != null && !saving);
    final line = saving ? 'Saving…' : sub;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Msg.s3),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ADText.rowName()),
            if (line != null) ...[
              const SizedBox(height: 2),
              Text(line, style: ADText.preview()),
            ],
          ]),
        ),
        const SizedBox(width: 8),
        if (saving) ...[
          const SizedBox(
              width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
          const SizedBox(width: 8),
        ],
        _PaToggle(
          value: value,
          onChanged: disabled ? null : (v) => _flip(field, v, apply),
        ),
      ]),
    );
  }
}

/// Dark v2 inline toggle — track [AD.card] off / [AD.online] on, white thumb.
/// Visual copy of receptionist_section.dart's `_AdToggle` (private there, so it
/// cannot be imported). Keep the two identical if either is restyled.
class _PaToggle extends StatelessWidget {
  final bool value;
  final ValueChanged<bool>? onChanged;
  const _PaToggle({required this.value, this.onChanged});
  @override
  Widget build(BuildContext context) {
    final reduce = MediaQuery.of(context).disableAnimations;
    return GestureDetector(
      onTap: onChanged == null ? null : () => onChanged!(!value),
      child: AnimatedContainer(
        duration: reduce ? Duration.zero : Msg.fast,
        width: 52, height: 30,
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(
          color: value ? AD.online : AD.card,
          // Toggle track — a genuine pill.
          borderRadius: Msg.brPill,
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: AnimatedAlign(
          duration: reduce ? Duration.zero : Msg.fast,
          alignment: value ? Alignment.centerRight : Alignment.centerLeft,
          child: Container(
            width: 22, height: 22,
            decoration: const BoxDecoration(shape: BoxShape.circle, color: Colors.white),
          ),
        ),
      ),
    );
  }
}

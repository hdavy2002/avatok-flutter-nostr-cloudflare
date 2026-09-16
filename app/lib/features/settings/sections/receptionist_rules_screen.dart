
import '../../../core/localization/ui_text.dart';

// [DYNW-RULES-UI-1] "Call Rules" — plain-English instructions for Ava.
//
// The owner writes rules in their own words ("If my brother Ramesh calls,
// tell him I'll call back at 6pm", "If it's a sales call, politely decline
// and hang up"). The app only ever sends/receives that raw text — the server
// moderates, compiles and runs it (Specs/DYNW-* — Dynamic Workers). There is
// NO local persistence of the rules text: the server is the only source of
// truth, so the screen always shows a fresh server read on open.
//
// Entry point: "Call Rules" row on the AI receptionist settings card
// (receptionist_section.dart).
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/ava_log.dart';
import '../../../core/receptionist_rules_api.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../../core/ui/messenger_theme.dart';

/// A few starter lines the owner can tap to insert instead of typing from
/// scratch. Deliberately short and concrete — they double as the "what kind
/// of thing goes here" explainer.
const List<String> _kRuleExamples = [
  "If my brother Ramesh calls, tell him I'll call back at 6pm.",
  "If it's a sales call, politely decline and hang up.",
  "If it's urgent or an emergency, tell them to text me instead.",
];

/// Inline dark v2 header band (same pattern as
/// receptionist_analytics_page.dart's `_darkHeader` / wallet_screen.dart).
PreferredSizeWidget _darkHeader({required String title, String? tag}) {
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

class ReceptionistRulesScreen extends StatefulWidget {
  const ReceptionistRulesScreen({super.key});

  @override
  State<ReceptionistRulesScreen> createState() => _ReceptionistRulesScreenState();
}

class _ReceptionistRulesScreenState extends State<ReceptionistRulesScreen> {
  final _rules = TextEditingController();
  bool _loading = true;
  bool _unavailable = false; // feature flag off (server 403) — "coming soon"
  bool _active = false;
  bool _saving = false;
  bool _clearing = false;

  @override
  void initState() {
    super.initState();
    Analytics.capture('recept_rules_opened', {});
    _load();
  }

  @override
  void dispose() {
    _rules.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final status = await ReceptionistRulesApi.getRules();
    if (!mounted) return;
    setState(() {
      _loading = false;
      _unavailable = !status.available;
      if (status.available) {
        _active = status.active;
        _rules.text = status.rulesText;
      }
    });
  }

  void _insertExample(String text) {
    final current = _rules.text;
    final needsNewline = current.isNotEmpty && !current.endsWith('\n');
    final next = current.isEmpty ? text : '$current${needsNewline ? '\n' : ''}$text';
    _rules.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: next.length),
    );
    Analytics.uiInteraction('recept_rules_example_tapped', 0, extra: {'text_len': text.length});
    setState(() {});
  }

  Future<void> _save() async {
    final text = _rules.text.trim();
    if (text.isEmpty) {
      _toast(uiCopy(UiMessage.m_write_at_least_one_rule_c1d7055bd6));
      return;
    }
    setState(() => _saving = true);
    final res = await ReceptionistRulesApi.saveRules(text);
    if (!mounted) return;
    setState(() => _saving = false);
    if (res.ok) {
      setState(() => _active = true);
      Analytics.capture('recept_rules_saved', {'chars': text.length});
      AvaLog.I.log('receptionist', 'call rules saved (code_id=${res.codeId})');
      _toast(uiCopy(UiMessage.m_saved_ava_will_follow_these_0b7070f835));
    } else {
      Analytics.capture('recept_rules_save_failed', {'error': res.error ?? ''});
      AvaLog.I.log('receptionist', 'call rules save FAILED: ${res.error}');
      _toast(res.error ?? uiCopy(UiMessage.m_couldn_t_save_try_again_d1ae454b9f));
    }
  }

  Future<void> _confirmTurnOff() async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AD.popover,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AD.rDialog),
          side: const BorderSide(color: AD.borderControl, width: 1),
        ),
        title: UiText(UiMessage.m_turn_off_call_rules_5596e71a7b, style: ADText.threadName()),
        content: UiText(
          UiMessage.m_ava_will_stop_following_these_9ef6ff3f92,
          style: ADText.preview(),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: UiText(UiMessage.m_cancel_19766ed6cc, style: ADText.rowName()),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: UiText(UiMessage.m_turn_off_06f0e210b2, style: ADText.rowName(c: AD.danger)),
          ),
        ],
      ),
    );
    if (yes != true) return;
    setState(() => _clearing = true);
    final ok = await ReceptionistRulesApi.clearRules();
    if (!mounted) return;
    setState(() => _clearing = false);
    if (ok) {
      setState(() => _active = false);
      Analytics.capture('recept_rules_disabled', {});
      AvaLog.I.log('receptionist', 'call rules turned off');
      _toast(uiCopy(UiMessage.m_call_rules_turned_off_6a9294a86f));
    } else {
      _toast(uiCopy(UiMessage.m_couldn_t_turn_off_rules_1a87203aa9));
    }
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: _darkHeader(title: uiCopy(UiMessage.m_call_rules_eb271868ee), tag: 'receptionist'),
      body: _loading
          ? const Center(
              child: SizedBox(
                  width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2)))
          : _unavailable
              ? _comingSoon()
              : ListView(
                  padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s4, Msg.s5, Msg.s6),
                  children: [
                    _explainerCard(),
                    const SizedBox(height: 16),
                    if (_active) ...[
                      _activeBanner(),
                      const SizedBox(height: 16),
                    ],
                    UiText(UiMessage.m_examples_tap_to_add_ee68902fb9, style: ADText.sectionLabel()),
                    const SizedBox(height: Msg.s2),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        for (final e in _kRuleExamples)
                          AdChip(label: _chipLabel(e), onTap: () => _insertExample(e)),
                      ],
                    ),
                    const SizedBox(height: 16),
                    AdField(
                      controller: _rules,
                      label: uiCopy(UiMessage.m_your_rules_a6b37899e6),
                      hint: uiCopy(UiMessage.m_e_g_if_my_brother_b501a81642),
                      minLines: 6,
                      maxLines: null,
                      maxLength: 4000,
                      textCapitalization: TextCapitalization.sentences,
                      onChanged: (_) => setState(() {}),
                    ),
                    const SizedBox(height: Msg.s1),
                    Align(
                      alignment: Alignment.centerRight,
                      child: Text('${_rules.text.length}/4000', style: ADText.statCaption()),
                    ),
                    const SizedBox(height: Msg.s1),
                    UiText(
                      UiMessage.m_ava_follows_these_rules_word_a4d1d1e8f7,
                      style: ADText.preview(),
                    ),
                    const SizedBox(height: Msg.s4),
                    AdButton(
                      label: _saving ? uiCopy(UiMessage.m_saving_23e39291d6) : uiCopy(UiMessage.m_save_1509f561f2),
                      fullWidth: true,
                      fontSize: 15,
                      loading: _saving,
                      onPressed: _saving ? null : _save,
                    ),
                    if (_active) ...[
                      const SizedBox(height: Msg.s2),
                      AdButton(
                        label: _clearing ? uiCopy(UiMessage.m_turning_off_c62412a208) : uiCopy(UiMessage.m_turn_off_rules_10f0eb200c),
                        variant: AdButtonVariant.ghost,
                        fullWidth: true,
                        fontSize: 14,
                        loading: _clearing,
                        onPressed: _clearing ? null : _confirmTurnOff,
                      ),
                    ],
                  ],
                ),
    );
  }

  String _chipLabel(String example) =>
      example.length > 28 ? '${example.substring(0, 28)}…' : example;

  Widget _explainerCard() => AdCard(
        padding: const EdgeInsets.all(Msg.s4),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          ZineIconBadge(
              icon: PhosphorIcons.pencilSimple(PhosphorIconsStyle.fill),
              color: AD.iconVideo,
              size: 36),
          const SizedBox(width: 12),
          Expanded(
            child: UiText(
              UiMessage.m_tell_ava_exactly_what_to_b1cfd27453,
              style: ADText.preview(c: AD.textPrimary),
            ),
          ),
        ]),
      );

  Widget _activeBanner() => Container(
        padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s3),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: BorderRadius.circular(AD.rInput),
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: Row(children: [
          const AdSticker('Active', kind: AdStickerKind.ok),
          const SizedBox(width: Msg.s2),
          Expanded(
            child: UiText(UiMessage.m_your_rules_are_live_ava_3cfe38dd13,
                style: ADText.preview()),
          ),
        ]),
      );

  Widget _comingSoon() => ListView(
        padding: const EdgeInsets.fromLTRB(Msg.s5, 40, Msg.s5, Msg.s6),
        children: [
          AdCard(
            padding: const EdgeInsets.all(Msg.s5),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              ZineIconBadge(
                  icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
                  color: AD.iconVideo,
                  size: 36),
              const SizedBox(height: Msg.s3),
              UiText(UiMessage.m_call_rules_coming_soon_37c9ed5bd3, style: ADText.rowName()),
              const SizedBox(height: 8),
              UiText(
                UiMessage.m_plain_english_call_rules_for_01a4392ea2,
                style: ADText.preview(),
              ),
            ]),
          ),
        ],
      );
}

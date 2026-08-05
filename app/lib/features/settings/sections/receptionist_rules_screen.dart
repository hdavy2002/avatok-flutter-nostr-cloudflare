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
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
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
      _toast('Write at least one rule before saving.');
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
      _toast('Saved — Ava will follow these rules on your next call.');
    } else {
      Analytics.capture('recept_rules_save_failed', {'error': res.error ?? ''});
      AvaLog.I.log('receptionist', 'call rules save FAILED: ${res.error}');
      _toast(res.error ?? 'Couldn’t save — try again.');
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
        title: Text('Turn off call rules?', style: ADText.threadName()),
        content: Text(
          'Ava will stop following these instructions on your next call. Your '
          'written rules stay here so you can turn them back on later.',
          style: ADText.preview(),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text('Cancel', style: ADText.rowName()),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text('Turn off', style: ADText.rowName(c: AD.danger)),
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
      _toast('Call rules turned off.');
    } else {
      _toast('Couldn’t turn off rules — try again.');
    }
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: _darkHeader(title: 'Call Rules', tag: 'receptionist'),
      body: _loading
          ? const Center(
              child: SizedBox(
                  width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2)))
          : _unavailable
              ? _comingSoon()
              : ListView(
                  padding: const EdgeInsets.fromLTRB(18, 16, 18, 28),
                  children: [
                    _explainerCard(),
                    const SizedBox(height: 16),
                    if (_active) ...[
                      _activeBanner(),
                      const SizedBox(height: 16),
                    ],
                    Text('EXAMPLES · TAP TO ADD', style: ADText.sectionLabel()),
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
                      label: 'Your rules',
                      hint: "e.g. If my brother Ramesh calls, tell him I'll call back "
                          "at 6pm. If it's a sales call, politely decline and hang up.",
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
                    Text(
                      'Ava follows these rules word-for-word — instantly. Write them '
                      'as plain sentences, one instruction at a time.',
                      style: ADText.preview(),
                    ),
                    const SizedBox(height: Msg.s4),
                    AdButton(
                      label: _saving ? 'Saving…' : 'Save',
                      fullWidth: true,
                      fontSize: 15,
                      loading: _saving,
                      onPressed: _saving ? null : _save,
                    ),
                    if (_active) ...[
                      const SizedBox(height: Msg.s2),
                      AdButton(
                        label: _clearing ? 'Turning off…' : 'Turn off rules',
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
        padding: const EdgeInsets.all(14),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          ZineIconBadge(
              icon: PhosphorIcons.pencilSimple(PhosphorIconsStyle.fill),
              color: AD.iconVideo,
              size: 36),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              "Tell Ava exactly what to do on a call, in your own words. She "
              "follows these rules word-for-word — instantly.",
              style: ADText.preview(c: AD.textPrimary),
            ),
          ),
        ]),
      );

  Widget _activeBanner() => Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: BorderRadius.circular(AD.rInput),
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: Row(children: [
          const AdSticker('Active', kind: AdStickerKind.ok),
          const SizedBox(width: Msg.s2),
          Expanded(
            child: Text('Your rules are live — Ava uses them on your next call.',
                style: ADText.preview()),
          ),
        ]),
      );

  Widget _comingSoon() => ListView(
        padding: const EdgeInsets.fromLTRB(18, 40, 18, 28),
        children: [
          AdCard(
            padding: const EdgeInsets.all(20),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              ZineIconBadge(
                  icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
                  color: AD.iconVideo,
                  size: 36),
              const SizedBox(height: Msg.s3),
              Text('Call Rules — coming soon', style: ADText.rowName()),
              const SizedBox(height: 8),
              Text(
                "Plain-English call rules for Ava aren't turned on for your "
                'account yet. Check back soon.',
                style: ADText.preview(),
              ),
            ]),
          ),
        ],
      );
}

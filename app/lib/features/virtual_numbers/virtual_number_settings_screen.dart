
import '../../core/localization/ui_text.dart';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/messenger_theme.dart';
import '../avadial/avadial_theme.dart';
import 'virtual_numbers_api.dart';
import 'virtual_numbers_models.dart';
import 'virtual_numbers_store.dart';
import 'virtual_numbers_widgets.dart';

class VirtualNumberSettingsScreen extends StatefulWidget {
  const VirtualNumberSettingsScreen(
      {super.key, required this.line, required this.api, required this.store});
  final VirtualLine line;
  final VirtualNumbersApi api;
  final VirtualNumbersStore store;
  @override
  State<VirtualNumberSettingsScreen> createState() =>
      _VirtualNumberSettingsScreenState();
}

class _VirtualNumberSettingsScreenState
    extends State<VirtualNumberSettingsScreen> {
  late VirtualLineSettings _settings = VirtualLineSettings(
      label: widget.line.label, colorKey: widget.line.colorKey);
  late final TextEditingController _lineLabel =
      TextEditingController(text: widget.line.label);
  late final TextEditingController _persona =
      TextEditingController(text: 'Ava');
  final _greeting = TextEditingController();
  final _instructions = TextEditingController();
  bool _loading = true;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _lineLabel.dispose();
    _persona.dispose();
    _greeting.dispose();
    _instructions.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final settings = await widget.api.getSettings(widget.line.id);
      if (mounted) {
        setState(() => _settings = settings);
        _lineLabel.text = settings.label;
        _persona.text = settings.personaName;
        _greeting.text = settings.greeting;
        _instructions.text = settings.instructions;
      }
    } catch (_) {
      _greeting.text = _settings.greeting;
      _instructions.text = _settings.instructions;
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      final saved = await widget.api.saveSettings(
          widget.line.id,
          _settings.copyWith(
              greeting: _greeting.text.trim(),
              instructions: _instructions.text.trim()));
      if (mounted) {
        setState(() => _settings = saved);
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: UiText(UiMessage.m_settings_saved_74a7f53bad)));
      }
    } catch (e) {
      if (mounted)
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _release() async {
    final ok = await showDialog<bool>(
            context: context,
            builder: (_) => AlertDialog(
                    title: const UiText(UiMessage.m_release_this_number_40ee68d423),
                    content: const UiText(
                        UiMessage.m_routing_stops_immediately_retained_recordings_fa34c6a99d),
                    actions: [
                      TextButton(
                          onPressed: () => Navigator.pop(context, false),
                          child: const UiText(UiMessage.m_keep_number_4ecd0ab6b6)),
                      FilledButton(
                          onPressed: () => Navigator.pop(context, true),
                          child: const UiText(UiMessage.m_release_e020e3c67b))
                    ])) ??
        false;
    if (!ok) return;
    try {
      await widget.api.release(widget.line.id);
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted)
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  @override
  Widget build(BuildContext context) { UiLocaleScope.watch(context); return VirtualNumbersUi.shell(
      title: uiCopy(UiMessage.m_number_settings_2869fae6ae),
      onBack: () => Navigator.of(context).pop(),
      child: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
              children: [
                  _lineCard(),
                  const SizedBox(height: 12),
                  _receptionistCard(),
                  const SizedBox(height: 12),
                  _callHandlingCard(),
                  const SizedBox(height: 12),
                  _rentalCard(),
                  const SizedBox(height: 18),
                  VirtualNumbersUi.primaryButton(
                      label: uiCopy(UiMessage.m_save_changes_dd0ae7a5cb),
                      onPressed: _save,
                      icon: PhosphorIcons.check(PhosphorIconsStyle.regular),
                      busy: _saving),
                  const SizedBox(height: 12),
                  OutlinedButton.icon(
                      onPressed: _release,
                      icon: Icon(PhosphorIcons.trash(PhosphorIconsStyle.regular)),
                      label: Text(widget.line.isDid
                          ? uiCopy(UiMessage.m_release_this_number_e583fd284f)
                          : uiCopy(UiMessage.m_remove_this_alias_020ef6f126)),
                      style: OutlinedButton.styleFrom(
                          foregroundColor: AvaDialTheme.spam,
                          side: BorderSide(color: AvaDialTheme.spam))),
                ])); }

  Widget _panel(String title, Widget child) => Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
          color: AvaDialTheme.surface,
          borderRadius: BorderRadius.circular(Msg.rMd),
          border: Border.all(color: AvaDialTheme.border)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title, style: AvaDialTheme.value(size: 16)),
        const SizedBox(height: 12),
        child
      ]));

  Widget _lineCard() => _panel(
      'The line',
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        VirtualNumbersUi.sectionLabel('Label'),
        TextField(
            controller: _lineLabel,
            onChanged: (value) => _settings = _settings.copyWith(label: value),
            decoration: InputDecoration(
                hintText: uiCopy(UiMessage.m_line_label_3b8109b6e7), prefixIcon: Icon(PhosphorIcons.tag(PhosphorIconsStyle.regular)))),
        const SizedBox(height: 13),
        VirtualNumbersUi.sectionLabel('Your number · cannot be changed'),
        VirtualNumbersUi.labelValue(
            widget.line.typeLabel, widget.line.displayNumber,
            enabled: false),
        if (widget.line.isDid) ...[
          const SizedBox(height: 13),
          SwitchListTile.adaptive(
              contentPadding: EdgeInsets.zero,
              title: UiText(UiMessage.m_default_outgoing_did_416733fa6f,
                  style: AvaDialTheme.value(size: 14)),
              subtitle: UiText(UiMessage.m_use_this_caller_id_for_514f4c8875,
                  style: AvaDialTheme.sub(size: 12)),
              value: widget.line.isDefaultOutgoing,
              onChanged: (value) async {
                if (value) {
                  await widget.api.setDefaultOutgoing(widget.line.id);
                  await widget.store.saveDefaultDidId(widget.line.id);
                  if (mounted) setState(() {});
                }
              })
        ],
        const SizedBox(height: 12),
        VirtualNumbersUi.sectionLabel('Line color'),
        Wrap(
            spacing: 10,
            children: ['pink', 'blue', 'amber', 'teal', 'ink']
                .map((key) => _colorChoice(key))
                .toList())
      ]));

  Widget _colorChoice(String key) {
    final selected = key == _settings.colorKey;
    return Semantics(
        label: '$key line color',
        selected: selected,
        child: InkWell(
            onTap: () =>
                setState(() => _settings = _settings.copyWith(colorKey: key)),
            borderRadius: BorderRadius.circular(Msg.rSm),
            child: Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                    color: virtualLineColor(key),
                    borderRadius: BorderRadius.circular(Msg.rSm),
                    border: Border.all(
                        color: selected ? Colors.white : AvaDialTheme.border,
                        width: selected ? 3 : 1.5)),
                child: selected
                    ? Icon(PhosphorIcons.check(PhosphorIconsStyle.regular), color: Colors.white, size: 18)
                    : null)));
  }

  Widget _receptionistCard() => _panel(
      'AI receptionist',
      Column(children: [
        VirtualNumbersUi.toggleRow(
            title: uiCopy(UiMessage.m_answer_for_this_line_722ff6edc7),
            subtitle: uiCopy(UiMessage.m_ava_handles_unanswered_calls_with_94d023267e),
            value: _settings.receptionistEnabled,
            onChanged: (value) => setState(() =>
                _settings = _settings.copyWith(receptionistEnabled: value))),
        const Divider(height: 18),
        _fieldLabel('Receptionist name', _persona,
            (value) => _settings = _settings.copyWith(personaName: value)),
        const SizedBox(height: 10),
        Row(children: [
          Expanded(
              child: _dropdown(
                  'Language',
                  _settings.language,
                  ['Auto', 'English', 'Hindi', 'Spanish'],
                  (v) => _settings = _settings.copyWith(language: v))),
          const SizedBox(width: 10),
          Expanded(
              child: _dropdown(
                  'Voice',
                  _settings.voice,
                  ['Warm', 'Clear', 'Bright'],
                  (v) => _settings = _settings.copyWith(voice: v)))
        ]),
        const SizedBox(height: 10),
        _multiline('Greeting', _greeting, 'A friendly greeting for callers'),
        const SizedBox(height: 10),
        _multiline('Instructions', _instructions,
            'What Ava should ask, share or avoid'),
        const SizedBox(height: 10),
        VirtualNumbersUi.sectionLabel('Answer when'),
        SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: 'always', label: UiText(UiMessage.m_always_de9f057a47)),
              ButtonSegment(
                  value: 'after_3_rings', label: UiText(UiMessage.m_after_3_rings_c59600d53c)),
              ButtonSegment(value: 'busy', label: UiText(UiMessage.m_when_busy_5a5c1af7c0))
            ],
            selected: {
              _settings.answerTiming
            },
            onSelectionChanged: (v) => setState(
                () => _settings = _settings.copyWith(answerTiming: v.first))),
        const SizedBox(height: 10),
        DropdownButtonFormField<int>(
            value: _settings.maxConversationMinutes,
            items: [3, 5, 10, 15]
                .map((v) => DropdownMenuItem(
                    value: v, child: UiText(UiMessage.m_maximum_conversation_v_minutes_1ad7eba656, params: {'v': (v).toString()})))
                .toList(),
            onChanged: (v) {
              if (v != null)
                setState(() =>
                    _settings = _settings.copyWith(maxConversationMinutes: v));
            },
            decoration:
                InputDecoration(prefixIcon: Icon(PhosphorIcons.timer(PhosphorIconsStyle.regular))))
      ]));

  Widget _callHandlingCard() => _panel(
      'Call handling',
      Column(children: [
        VirtualNumbersUi.toggleRow(
            title: uiCopy(UiMessage.m_record_calls_4ed3a111aa),
            subtitle: uiCopy(UiMessage.m_saved_to_this_number_s_feb53aaec3),
            value: _settings.recordCalls,
            onChanged: (v) =>
                setState(() => _settings = _settings.copyWith(recordCalls: v))),
        const Divider(height: 1),
        VirtualNumbersUi.toggleRow(
            title: uiCopy(UiMessage.m_transcripts_and_summaries_5496513376),
            subtitle: uiCopy(UiMessage.m_ava_writes_up_calls_when_9790209918),
            value: _settings.transcribeCalls,
            onChanged: (v) => setState(
                () => _settings = _settings.copyWith(transcribeCalls: v))),
        const Divider(height: 1),
        VirtualNumbersUi.toggleRow(
            title: uiCopy(UiMessage.m_block_unknown_callers_53db5f2898),
            subtitle: uiCopy(UiMessage.m_send_unknown_callers_to_the_221ac739b6),
            value: _settings.blockUnknownCallers,
            onChanged: (v) => setState(
                () => _settings = _settings.copyWith(blockUnknownCallers: v)))
      ]));
  Widget _rentalCard() => _panel(
      'Rental and status',
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
              child: Text(
                  widget.line.isDid
                      ? uiCopy(UiMessage.m_600_tokens_30_day_rental_fa75896872)
                      : uiCopy(UiMessage.m_free_avatok_alias_7c26809046),
                  style: AvaDialTheme.value(size: 14))),
          VirtualNumbersUi.statusChip(widget.line)
        ]),
        if (widget.line.nextRenewalAt != null)
          Padding(
              padding: const EdgeInsets.only(top: 7),
              child: UiText(
                  UiMessage.m_renews_value1_value2_value3_427eaed33e, params: {'value1': (widget.line.nextRenewalAt!.day).toString(), 'value2': (widget.line.nextRenewalAt!.month).toString(), 'value3': (widget.line.nextRenewalAt!.year).toString()},
                  style: AvaDialTheme.sub(size: 12))),
        if (widget.line.isDid)
          Padding(
              padding: const EdgeInsets.only(top: 7),
              child: UiText(
                  UiMessage.m_pstn_calls_0_50_tokens_0ba728c3ed,
                  style: AvaDialTheme.sub(size: 12)))
      ]));
  Widget _fieldLabel(String label, TextEditingController controller,
          ValueChanged<String> onChanged) =>
      TextField(
          controller: controller,
          onChanged: onChanged,
          decoration: InputDecoration(labelText: label));
  Widget _multiline(
          String label, TextEditingController controller, String hint) =>
      TextField(
          controller: controller,
          maxLines: 4,
          decoration: InputDecoration(labelText: label, hintText: hint));
  Widget _dropdown(String label, String value, List<String> values,
          ValueChanged<String> onChanged) =>
      DropdownButtonFormField<String>(
          value: values.contains(value) ? value : values.first,
          items: values
              .map((v) => DropdownMenuItem(value: v, child: Text(v)))
              .toList(),
          onChanged: (v) {
            if (v != null) setState(() => onChanged(v));
          },
          decoration: InputDecoration(labelText: label));
}

extension on VirtualLineSettings {
  VirtualLineSettings copyWith(
          {String? label,
          String? colorKey,
          bool? receptionistEnabled,
          String? personaName,
          String? language,
          String? voice,
          String? greeting,
          String? instructions,
          String? answerTiming,
          int? maxConversationMinutes,
          bool? recordCalls,
          bool? transcribeCalls,
          bool? blockUnknownCallers}) =>
      VirtualLineSettings(
          label: label ?? this.label,
          colorKey: colorKey ?? this.colorKey,
          receptionistEnabled: receptionistEnabled ?? this.receptionistEnabled,
          personaName: personaName ?? this.personaName,
          language: language ?? this.language,
          voice: voice ?? this.voice,
          greeting: greeting ?? this.greeting,
          instructions: instructions ?? this.instructions,
          answerTiming: answerTiming ?? this.answerTiming,
          maxConversationMinutes:
              maxConversationMinutes ?? this.maxConversationMinutes,
          recordCalls: recordCalls ?? this.recordCalls,
          transcribeCalls: transcribeCalls ?? this.transcribeCalls,
          blockUnknownCallers: blockUnknownCallers ?? this.blockUnknownCallers);
}

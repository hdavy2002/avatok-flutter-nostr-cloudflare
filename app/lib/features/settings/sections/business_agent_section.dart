
import '../../../core/localization/ui_text.dart';

import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/business_agent_api.dart';
import '../../../core/disk_cache.dart';
import '../../../core/remote_config.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../avatok/my_ai_calls_screen.dart';
import '../settings_registry.dart';

/// Settings → "Ava Business Agent" (Specs/PLAN-2026-07-11-dialpad-business-
/// calls-ava-voice-agent.md §4/§8 Phase C, §12.5, §12.11).
///
/// One screen, two halves:
///   • PRIMARY number (Mode A — always exists, one per account, free): on/off,
///     instructions, docs (RAG), routing, business hours.
///   • SERVICE numbers (Mode B — [RemoteConfig.serviceNumbers] only): a list of
///     caller-pays lines the owner has added, each with its own rate/length/
///     instructions/routing/hours, plus "Add a service".
/// Entirely gated on [RemoteConfig.voiceAgent] — hidden when the flag is off
/// (registered but the builder itself returns an empty card so a stale
/// registration never renders half a screen).
void registerBusinessAgentSection() {
  SettingsSectionRegistry.register(
    SettingsSection(
      id: 'ava_business_agent',
      title: uiCopy(UiMessage.m_ava_business_agent_e8b5730759),
      order: 25, // just below Ava Receptionist (24)
      // [AVA-BIZCALL-12] Hide the row entirely when the feature flag is off —
      // never show a tile that opens a blank page.
      visible: () => RemoteConfig.voiceAgent,
      builder: (context) => const _BusinessAgentCard(),
    ),
  );
}

class _BusinessAgentCard extends StatefulWidget {
  const _BusinessAgentCard();
  @override
  State<_BusinessAgentCard> createState() => _BusinessAgentCardState();
}

class _BusinessAgentCardState extends State<_BusinessAgentCard> {
  static const String _mirrorKey = 'business_agent_settings_mirror';

  bool _loading = true;
  bool _saving = false;
  bool _notAvailable = false; // server route not live yet (404/501)

  BusinessAgentSettings _settings = BusinessAgentSettings.defaults();
  final _instructions = TextEditingController();
  List<BusinessAgentDoc> _docs = const [];
  bool _uploadingDoc = false;

  List<BusinessAgentService> _services = const [];
  bool _loadingServices = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _instructions.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    // 1) Instant paint from the local per-account mirror.
    try {
      final raw = await DiskCache.read(_mirrorKey);
      if (raw != null && mounted) {
        final m = (jsonDecode(raw) as Map).cast<String, dynamic>();
        setState(() {
          _settings = BusinessAgentSettings.fromJson(m);
          _instructions.text = _settings.instructions;
          _loading = false;
        });
      }
    } catch (_) {/* no/invalid mirror — fall through to the server fetch */}

    // 2) Authoritative refresh.
    final s = await BusinessAgentApi.getSettings();
    if (!mounted) return;
    if (s == null) {
      setState(() { _notAvailable = _loading; _loading = false; });
    } else {
      setState(() {
        _settings = s;
        _instructions.text = s.instructions;
        _loading = false;
        _notAvailable = false;
      });
      await _writeMirror();
    }
    if (RemoteConfig.serviceNumbers) _loadServices();
    _loadDocs();
  }

  Future<void> _writeMirror() async {
    try { await DiskCache.write(_mirrorKey, jsonEncode(_settings.toJson())); } catch (_) {/* best-effort */}
  }

  Future<void> _loadDocs() async {
    final docs = await BusinessAgentApi.listDocs();
    if (mounted) setState(() => _docs = docs);
  }

  Future<void> _loadServices() async {
    setState(() => _loadingServices = true);
    final list = await BusinessAgentApi.listServices();
    if (!mounted) return;
    setState(() { _services = list; _loadingServices = false; });
  }

  Future<void> _toggleEnabled(bool v) async {
    setState(() => _settings = _settings.copyWith(enabled: v));
    await _save();
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    _settings = _settings.copyWith(instructions: _instructions.text.trim());
    final ok = await BusinessAgentApi.saveSettings(_settings);
    if (!mounted) return;
    setState(() => _saving = false);
    if (ok) {
      await _writeMirror();
      Analytics.capture('agent_settings_saved', {
        'enabled': _settings.enabled, 'routing': _settings.routing.wire,
        'has_hours': _settings.hours.anyEnabled,
      });
      _toast(_settings.enabled ? uiCopy(UiMessage.m_ava_will_answer_your_primary_dc1634e2fc) : uiCopy(UiMessage.m_saved_b5c120b316));
    } else {
      Analytics.capture('agent_settings_save_failed', {});
      _toast(uiCopy(UiMessage.m_couldn_t_save_check_your_da12340aa9));
    }
  }

  Future<void> _pickAndUploadDoc({String? serviceId}) async {
    final res = await FilePicker.platform.pickFiles(withData: true);
    final f = res?.files.single;
    if (f == null || f.bytes == null) return;
    setState(() => _uploadingDoc = true);
    final doc = await BusinessAgentApi.uploadDoc(f.name, f.bytes!, serviceId: serviceId);
    if (!mounted) return;
    setState(() => _uploadingDoc = false);
    if (doc != null) {
      Analytics.capture('agent_doc_uploaded', {'name': f.name, 'service_id': serviceId ?? ''});
      _loadDocs();
    } else {
      _toast(uiCopy(UiMessage.m_couldn_t_upload_that_document_ceae634da2));
    }
  }

  Future<void> _deleteDoc(BusinessAgentDoc d) async {
    final ok = await BusinessAgentApi.deleteDoc(d.id);
    if (ok) _loadDocs();
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  Future<void> _addService() async {
    final created = await showModalBottomSheet<BusinessAgentService>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet)),
      ),
      builder: (_) => const _AddServiceSheet(),
    );
    if (created == null) return;
    Analytics.capture('agent_service_created', {'rate': created.rate, 'name': created.name});
    _loadServices();
  }

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    if (!RemoteConfig.voiceAgent) {
      // [AVA-BIZCALL-12] The row is hidden when the flag is off (see
      // registerBusinessAgentSection), but if the flag flips while this page
      // is open, show a friendly note — never a blank page.
      return const Padding(
        padding: EdgeInsets.all(24),
        child: Center(
          child: UiText(
            UiMessage.m_ava_business_agent_isn_t_6a59e5646b,
            textAlign: TextAlign.center,
          ),
        ),
      );
    }
    return AdCard(
      padding: const EdgeInsets.all(Msg.s4),
      child: _loading
          ? const Padding(
              padding: EdgeInsets.symmetric(vertical: Msg.s5),
              child: Center(child: SizedBox(
                  width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2))),
            )
          : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              _header(),
              if (_notAvailable) ...[
                const SizedBox(height: Msg.s3),
                UiText(
                  UiMessage.m_ava_business_agent_is_rolling_198cc0b394,
                  style: ADText.preview(c: AD.textTertiary),
                ),
              ] else ...[
                const SizedBox(height: Msg.s3),
                _primarySection(),
                const SizedBox(height: Msg.s4),
                _myAiCallsTile(),
                if (RemoteConfig.serviceNumbers) ...[
                  const SizedBox(height: Msg.s5),
                  const Divider(color: AD.borderHairline),
                  const SizedBox(height: Msg.s3),
                  _servicesSection(),
                ],
              ],
            ]),
    );
  }

  Widget _header() {
    return Row(children: [
      ZineIconBadge(icon: PhosphorIcons.robot(PhosphorIconsStyle.fill), color: AD.iconVideo, size: 36),
      const SizedBox(width: 12),
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          UiText(UiMessage.m_ava_business_agent_e8b5730759, style: ADText.rowName()),
          const SizedBox(height: 2),
          UiText(
            UiMessage.m_a_real_ai_voice_agent_e5085261d6,
            style: ADText.preview(),
          ),
        ]),
      ),
    ]);
  }

  Widget _primarySection() {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            UiText(UiMessage.m_answer_my_calls_47ded1d878, style: ADText.rowName()),
            const SizedBox(height: 2),
            UiText(
              UiMessage.m_6_tokens_min_from_your_4f0a96204b,
              style: ADText.preview(),
            ),
          ]),
        ),
        const SizedBox(width: 8),
        _AdToggle(value: _settings.enabled, onChanged: _saving ? null : _toggleEnabled),
      ]),
      const SizedBox(height: Msg.s3),
      UiText(UiMessage.m_instructions_934652dce4, style: ADText.sectionLabel()),
      const SizedBox(height: Msg.s2),
      AdField(
        controller: _instructions,
        label: uiCopy(UiMessage.m_what_should_ava_do_when_4526d280ae),
        hint: uiCopy(UiMessage.m_e_g_answer_questions_about_08a17882cc),
        minLines: 3,
        maxLines: null,
        textCapitalization: TextCapitalization.sentences,
        onChanged: (_) => setState(() {}),
      ),
      const SizedBox(height: 16),
      UiText(UiMessage.m_knowledge_documents_16f4854a9c, style: ADText.sectionLabel()),
      const SizedBox(height: Msg.s2),
      _docsList(serviceId: null),
      const SizedBox(height: 8),
      AdChip(
        label: _uploadingDoc ? uiCopy(UiMessage.m_uploading_5ce44dd77d) : uiCopy(UiMessage.m_upload_a_document_01e738db94),
        onTap: _uploadingDoc ? null : () => _pickAndUploadDoc(),
      ),
      const SizedBox(height: 16),
      UiText(UiMessage.m_routing_bcba696f3e, style: ADText.sectionLabel()),
      const SizedBox(height: Msg.s2),
      _routingPicker(_settings.routing, (r) => setState(() => _settings = _settings.copyWith(routing: r))),
      const SizedBox(height: 16),
      UiText(UiMessage.m_business_hours_optional_21d0e209be, style: ADText.sectionLabel()),
      const SizedBox(height: Msg.s2),
      _hoursEditor(_settings.hours, (h) => setState(() => _settings = _settings.copyWith(hours: h))),
      const SizedBox(height: 16),
      AdButton(
        label: _saving ? uiCopy(UiMessage.m_saving_23e39291d6) : uiCopy(UiMessage.m_save_1509f561f2),
        fullWidth: true,
        fontSize: 15,
        loading: _saving,
        onPressed: _saving ? null : _save,
      ),
    ]);
  }

  Widget _myAiCallsTile() {
    return ZinePressable(
      onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const MyAiCallsScreen())),
      color: AD.card,
      borderColor: AD.borderControl,
      radius: BorderRadius.circular(AD.rListCard),
      boxShadow: const [],
      padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s4),
      child: Row(children: [
        Icon(PhosphorIcons.clockCounterClockwise(PhosphorIconsStyle.bold), size: 18, color: AD.textSecondary),
        const SizedBox(width: Msg.s2),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            UiText(UiMessage.m_my_ai_calls_f279faed37, style: ADText.rowName()),
            UiText(UiMessage.m_calls_you_made_to_other_901cd383e6, style: ADText.preview()),
          ]),
        ),
        Icon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: AD.textTertiary),
      ]),
    );
  }

  Widget _docsList({required String? serviceId}) {
    final docs = _docs; // primary-only for now; service docs load per-sheet
    if (docs.isEmpty) {
      return UiText(UiMessage.m_no_documents_yet_upload_a_870e18dc79,
          style: ADText.preview());
    }
    return Column(children: [
      for (final d in docs)
        Padding(
          padding: const EdgeInsets.only(bottom: Msg.s2),
          child: Row(children: [
            Icon(PhosphorIcons.fileText(PhosphorIconsStyle.bold), size: 16, color: AD.textSecondary),
            const SizedBox(width: 8),
            Expanded(child: Text(d.name, style: ADText.rowName(), overflow: TextOverflow.ellipsis)),
            if (!d.indexed) UiText(UiMessage.m_indexing_1558519e4a, style: ADText.statCaption(c: AD.textTertiary)),
            IconButton(
              icon: Icon(PhosphorIcons.trash(PhosphorIconsStyle.bold), size: 16, color: AD.danger),
              onPressed: () => _deleteDoc(d),
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
            ),
          ]),
        ),
    ]);
  }

  Widget _routingPicker(AgentRouting value, ValueChanged<AgentRouting> onChanged) {
    return Wrap(spacing: 8, runSpacing: 8, children: [
      AdChip(label: uiCopy(UiMessage.m_auto_after_2_rings_53045b7303), active: value == AgentRouting.auto2Rings,
          onTap: () => onChanged(AgentRouting.auto2Rings)),
      AdChip(label: uiCopy(UiMessage.m_manual_send_to_agent_only_34f972f71b), active: value == AgentRouting.manualOnly,
          onTap: () => onChanged(AgentRouting.manualOnly)),
      AdChip(label: uiCopy(UiMessage.m_off_ca7981b46e), active: value == AgentRouting.off, onTap: () => onChanged(AgentRouting.off)),
    ]);
  }

  Widget _hoursEditor(BusinessHours hours, ValueChanged<BusinessHours> onChanged) {
    const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return Column(children: [
      for (var i = 0; i < 7; i++)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Row(children: [
            SizedBox(width: 40, child: Text(labels[i], style: ADText.rowName())),
            _AdToggle(
              value: hours.days[i].enabled,
              onChanged: (v) {
                final days = List<BusinessHoursDay>.from(hours.days);
                days[i] = days[i].copyWith(enabled: v);
                onChanged(BusinessHours(days));
              },
            ),
            const SizedBox(width: Msg.s2),
            if (hours.days[i].enabled) ...[
              Expanded(
                child: _hourField(hours.days[i].start, (v) {
                  final days = List<BusinessHoursDay>.from(hours.days);
                  days[i] = days[i].copyWith(start: v);
                  onChanged(BusinessHours(days));
                }),
              ),
              const SizedBox(width: Msg.s1),
              Text('–', style: ADText.preview()),
              const SizedBox(width: Msg.s1),
              Expanded(
                child: _hourField(hours.days[i].end, (v) {
                  final days = List<BusinessHoursDay>.from(hours.days);
                  days[i] = days[i].copyWith(end: v);
                  onChanged(BusinessHours(days));
                }),
              ),
            ] else
              Expanded(child: UiText(UiMessage.m_closed_c21ead0614, style: ADText.preview(c: AD.textTertiary))),
          ]),
        ),
      UiText(
        UiMessage.m_leave_every_day_off_for_e59262aae4,
        style: ADText.preview(),
      ),
    ]);
  }

  Widget _hourField(String value, ValueChanged<String> onChanged) {
    return ZinePressable(
      onTap: () async {
        final parts = value.split(':');
        final initial = TimeOfDay(
          hour: int.tryParse(parts.isNotEmpty ? parts[0] : '9') ?? 9,
          minute: int.tryParse(parts.length > 1 ? parts[1] : '0') ?? 0,
        );
        final picked = await showTimePicker(context: context, initialTime: initial);
        if (picked != null) {
          onChanged('${picked.hour.toString().padLeft(2, '0')}:${picked.minute.toString().padLeft(2, '0')}');
        }
      },
      color: AD.card,
      borderColor: AD.borderControl,
      radius: BorderRadius.circular(AD.rListCard),
      boxShadow: const [],
      padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s2),
      child: Text(value, style: ADText.rowName(), textAlign: TextAlign.center),
    );
  }

  Widget _servicesSection() {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Expanded(child: UiText(UiMessage.m_service_numbers_72d60c07e8, style: ADText.rowName())),
        AdChip(label: uiCopy(UiMessage.m_add_a_service_299750f04e), onTap: _addService),
      ]),
      const SizedBox(height: 4),
      UiText(
        UiMessage.m_extra_avatok_numbers_you_advertise_c89c14516c,
        style: ADText.preview(),
      ),
      const SizedBox(height: 12),
      if (_loadingServices)
        const Center(child: Padding(
          padding: EdgeInsets.symmetric(vertical: 12),
          child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)),
        ))
      else if (_services.isEmpty)
        UiText(UiMessage.m_no_service_numbers_yet_c9cc225839, style: ADText.preview(c: AD.textTertiary))
      else
        Column(children: [for (final s in _services) _serviceTile(s)]),
    ]);
  }

  Widget _serviceTile(BusinessAgentService s) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: ZinePressable(
        onTap: () async {
          final updated = await showModalBottomSheet<BusinessAgentService>(
            context: context,
            isScrollControlled: true,
            backgroundColor: AD.overlaySheet,
            shape: const RoundedRectangleBorder(
              borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet)),
            ),
            builder: (_) => _AddServiceSheet(existing: s),
          );
          if (updated != null) _loadServices();
        },
        color: AD.card,
        borderColor: AD.borderControl,
        radius: BorderRadius.circular(AD.rListCard),
        boxShadow: const [],
        padding: const EdgeInsets.all(12),
        child: Row(children: [
          ZineIconBadge(icon: PhosphorIcons.phoneCall(PhosphorIconsStyle.fill), color: AD.online, size: 34),
          const SizedBox(width: Msg.s2),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              UiText(UiMessage.m_value1_by_value2_7488512832, params: {'value1': (s.name).toString(), 'value2': (s.ownerName.isEmpty ? 'you' : s.ownerName).toString()},
                  style: ADText.rowName()),
              const SizedBox(height: 2),
              UiText(UiMessage.m_value1_tokens_min_value2_664348f200, params: {'value1': (s.rate).toString(), 'value2': (s.number.isEmpty ? 'number pending' : s.number).toString()},
                  style: ADText.preview()),
            ]),
          ),
          Icon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: AD.textTertiary),
        ]),
      ),
    );
  }
}

/// "Add a service" bottom sheet (§4 "Multiple service numbers", §12.2/§12.5).
/// Also doubles as the edit sheet when [existing] is passed.
class _AddServiceSheet extends StatefulWidget {
  final BusinessAgentService? existing;
  const _AddServiceSheet({this.existing});
  @override
  State<_AddServiceSheet> createState() => _AddServiceSheetState();
}

class _AddServiceSheetState extends State<_AddServiceSheet> {
  late final _name = TextEditingController(text: widget.existing?.name ?? '');
  late final _instructions = TextEditingController(text: widget.existing?.instructions ?? '');
  late int _rate = widget.existing?.rate ?? kMinServiceRate;
  late List<int> _lengths = List.of(widget.existing?.lengthOptions ?? const [15, 30, 60]);
  late AgentRouting _routing = widget.existing?.routing ?? AgentRouting.auto2Rings;
  late BusinessHours _hours = widget.existing?.hours ?? BusinessHours.defaults();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _instructions.dispose();
    super.dispose();
  }

  void _toggleLength(int m) {
    setState(() {
      if (_lengths.contains(m)) {
        _lengths.remove(m);
      } else {
        _lengths = [..._lengths, m]..sort();
      }
    });
  }

  Future<void> _save() async {
    if (_name.text.trim().isEmpty) { setState(() => _error = 'Give the service a name.'); return; }
    if (_rate < kMinServiceRate) { setState(() => _error = 'Rate must be at least $kMinServiceRate tokens/min.'); return; }
    if (_lengths.isEmpty) { setState(() => _error = 'Add at least one length option.'); return; }
    setState(() { _saving = true; _error = null; });
    final payload = (widget.existing ?? BusinessAgentService.blank()).copyWith(
      name: _name.text.trim(),
      rate: _rate,
      lengthOptions: _lengths,
      instructions: _instructions.text.trim(),
      routing: _routing,
      hours: _hours,
    );
    final result = widget.existing == null
        ? await BusinessAgentApi.createService(payload)
        : (await BusinessAgentApi.updateService(widget.existing!.number, payload) ? payload : null);
    if (!mounted) return;
    setState(() => _saving = false);
    if (result != null) {
      Navigator.of(context).pop(result);
    } else {
      setState(() => _error = 'Couldn’t save — the service line is still rolling out on your account.');
    }
  }

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.86),
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s4, Msg.s5, Msg.s5),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Center(child: Container(width: 40, height: 4,
                  decoration: BoxDecoration(color: AD.borderControl, borderRadius: Msg.brPill))),
              const SizedBox(height: Msg.s3),
              Text(widget.existing == null ? uiCopy(UiMessage.m_add_a_service_066ae41e70) : uiCopy(UiMessage.m_edit_service_3b3ed7a7bf), style: ADText.threadName()),
              const SizedBox(height: 4),
              UiText(
                UiMessage.m_callers_see_value1_by_you_b0f8a3308c, params: {'value1': (_name.text.isEmpty ? 'Your service' : _name.text).toString()},
                style: ADText.preview(),
              ),
              const SizedBox(height: 16),
              AdField(controller: _name, label: uiCopy(UiMessage.m_service_name_1bb8870cc0), hint: uiCopy(UiMessage.m_e_g_us_visa_interview_d435865f3a)),
              const SizedBox(height: Msg.s3),
              UiText(UiMessage.m_rate_tokens_min_caller_pays_4bf98f622f, params: {'kMinServiceRate': (kMinServiceRate).toString()}, style: ADText.sectionLabel()),
              const SizedBox(height: Msg.s2),
              Row(children: [
                Expanded(
                  child: Slider(
                    value: _rate.toDouble().clamp(kMinServiceRate.toDouble(), 200),
                    min: kMinServiceRate.toDouble(),
                    max: 200,
                    divisions: 200 - kMinServiceRate,
                    label: '$_rate',
                    activeColor: AD.primaryBadge,
                    onChanged: (v) => setState(() => _rate = v.round()),
                  ),
                ),
                SizedBox(width: 44, child: Text('$_rate', textAlign: TextAlign.end, style: ADText.rowName())),
              ]),
              UiText(UiMessage.m_you_net_value1_tokens_min_873d6e94ea, params: {'value1': ((_rate - 13).clamp(0, 999)).toString()},
                  style: ADText.preview()),
              const SizedBox(height: Msg.s3),
              UiText(UiMessage.m_length_options_minutes_e5fb327fb8, style: ADText.sectionLabel()),
              const SizedBox(height: Msg.s2),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final m in const [10, 15, 20, 30, 45, 60, 90])
                  AdChip(label: '$m min', active: _lengths.contains(m), onTap: () => _toggleLength(m)),
              ]),
              const SizedBox(height: Msg.s3),
              UiText(UiMessage.m_instructions_934652dce4, style: ADText.sectionLabel()),
              const SizedBox(height: Msg.s2),
              AdField(
                controller: _instructions,
                label: uiCopy(UiMessage.m_what_does_this_service_do_e116f4bf39),
                minLines: 3,
                maxLines: null,
                textCapitalization: TextCapitalization.sentences,
              ),
              const SizedBox(height: Msg.s3),
              UiText(UiMessage.m_routing_bcba696f3e, style: ADText.sectionLabel()),
              const SizedBox(height: Msg.s2),
              Wrap(spacing: 8, runSpacing: 8, children: [
                AdChip(label: uiCopy(UiMessage.m_auto_after_2_rings_53045b7303), active: _routing == AgentRouting.auto2Rings,
                    onTap: () => setState(() => _routing = AgentRouting.auto2Rings)),
                AdChip(label: uiCopy(UiMessage.m_manual_only_be1016ce6d), active: _routing == AgentRouting.manualOnly,
                    onTap: () => setState(() => _routing = AgentRouting.manualOnly)),
                AdChip(label: uiCopy(UiMessage.m_off_ca7981b46e), active: _routing == AgentRouting.off,
                    onTap: () => setState(() => _routing = AgentRouting.off)),
              ]),
              if (widget.existing != null) ...[
                const SizedBox(height: Msg.s3),
                AdChip(
                  label: uiCopy(UiMessage.m_upload_knowledge_document_656ae97d84),
                  onTap: () async {
                    final res = await FilePicker.platform.pickFiles(withData: true);
                    final f = res?.files.single;
                    if (f == null || f.bytes == null) return;
                    await BusinessAgentApi.uploadDoc(f.name, f.bytes!, serviceId: widget.existing!.id);
                  },
                ),
              ],
              if (_error != null) AdErrorMsg(_error!),
              const SizedBox(height: Msg.s4),
              AdButton(
                label: _saving ? uiCopy(UiMessage.m_saving_23e39291d6) : (widget.existing == null ? uiCopy(UiMessage.m_add_service_7d9366fdae) : uiCopy(UiMessage.m_save_changes_dd0ae7a5cb)),
                fullWidth: true,
                loading: _saving,
                onPressed: _saving ? null : _save,
              ),
            ]),
          ),
        ),
      ),
    );
  }
}

/// Dark v2 inline toggle — track [AD.card] off / [AD.online] on, white thumb.
class _AdToggle extends StatelessWidget {
  final bool value;
  final ValueChanged<bool>? onChanged;
  const _AdToggle({required this.value, this.onChanged});
  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
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

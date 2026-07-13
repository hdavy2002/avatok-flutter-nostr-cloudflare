import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/business_agent_api.dart';
import '../../../core/disk_cache.dart';
import '../../../core/remote_config.dart';
import '../../../core/ui/avatok_dark.dart';
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
      title: 'Ava Business Agent',
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
      _toast(_settings.enabled ? 'Ava will answer your primary number' : 'Saved');
    } else {
      Analytics.capture('agent_settings_save_failed', {});
      _toast('Couldn’t save — check your connection and try again.');
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
      _toast('Couldn’t upload that document yet — the knowledge pipeline is still rolling out.');
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
    if (!RemoteConfig.voiceAgent) {
      // [AVA-BIZCALL-12] The row is hidden when the flag is off (see
      // registerBusinessAgentSection), but if the flag flips while this page
      // is open, show a friendly note — never a blank page.
      return const Padding(
        padding: EdgeInsets.all(24),
        child: Center(
          child: Text(
            'Ava Business Agent isn’t enabled on this account yet.',
            textAlign: TextAlign.center,
          ),
        ),
      );
    }
    return AdCard(
      padding: const EdgeInsets.all(14),
      child: _loading
          ? const Padding(
              padding: EdgeInsets.symmetric(vertical: 18),
              child: Center(child: SizedBox(
                  width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2))),
            )
          : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              _header(),
              if (_notAvailable) ...[
                const SizedBox(height: 14),
                Text(
                  'Ava Business Agent is rolling out — not available on your account yet.',
                  style: ADText.preview(c: AD.textTertiary),
                ),
              ] else ...[
                const SizedBox(height: 14),
                _primarySection(),
                const SizedBox(height: 18),
                _myAiCallsTile(),
                if (RemoteConfig.serviceNumbers) ...[
                  const SizedBox(height: 22),
                  const Divider(color: AD.borderHairline),
                  const SizedBox(height: 14),
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
          Text('Ava Business Agent', style: ADText.rowName()),
          const SizedBox(height: 2),
          Text(
            'A real AI voice agent that answers your AvaTOK number, uses your '
            'documents, and can take a booking — paid from your wallet, minute '
            'by minute.',
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
            Text('Answer my calls', style: ADText.rowName()),
            const SizedBox(height: 2),
            Text(
              '6 tokens/min from your wallet, up to a 5-minute call. Turns off '
              'automatically if your wallet runs out.',
              style: ADText.preview(),
            ),
          ]),
        ),
        const SizedBox(width: 8),
        _AdToggle(value: _settings.enabled, onChanged: _saving ? null : _toggleEnabled),
      ]),
      const SizedBox(height: 14),
      Text('INSTRUCTIONS', style: ADText.sectionLabel()),
      const SizedBox(height: 9),
      AdField(
        controller: _instructions,
        label: 'What should Ava do when you can’t answer?',
        hint: 'e.g. Answer questions about our opening hours and menu. If a '
            'caller wants to book a table, take their name, party size and '
            'time, and email me the details.',
        minLines: 3,
        maxLines: null,
        textCapitalization: TextCapitalization.sentences,
        onChanged: (_) => setState(() {}),
      ),
      const SizedBox(height: 16),
      Text('KNOWLEDGE (DOCUMENTS)', style: ADText.sectionLabel()),
      const SizedBox(height: 9),
      _docsList(serviceId: null),
      const SizedBox(height: 8),
      AdChip(
        label: _uploadingDoc ? 'Uploading…' : 'Upload a document',
        onTap: _uploadingDoc ? null : () => _pickAndUploadDoc(),
      ),
      const SizedBox(height: 16),
      Text('ROUTING', style: ADText.sectionLabel()),
      const SizedBox(height: 9),
      _routingPicker(_settings.routing, (r) => setState(() => _settings = _settings.copyWith(routing: r))),
      const SizedBox(height: 16),
      Text('BUSINESS HOURS (OPTIONAL)', style: ADText.sectionLabel()),
      const SizedBox(height: 9),
      _hoursEditor(_settings.hours, (h) => setState(() => _settings = _settings.copyWith(hours: h))),
      const SizedBox(height: 16),
      AdButton(
        label: _saving ? 'Saving…' : 'Save',
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
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
      child: Row(children: [
        Icon(PhosphorIcons.clockCounterClockwise(PhosphorIconsStyle.bold), size: 18, color: AD.textSecondary),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('My AI calls', style: ADText.rowName()),
            Text('Calls YOU made to other people’s Ava AI agents.', style: ADText.preview()),
          ]),
        ),
        Icon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: AD.textTertiary),
      ]),
    );
  }

  Widget _docsList({required String? serviceId}) {
    final docs = _docs; // primary-only for now; service docs load per-sheet
    if (docs.isEmpty) {
      return Text('No documents yet. Upload a menu, FAQ or price list for Ava to answer from.',
          style: ADText.preview());
    }
    return Column(children: [
      for (final d in docs)
        Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Row(children: [
            Icon(PhosphorIcons.fileText(PhosphorIconsStyle.bold), size: 16, color: AD.textSecondary),
            const SizedBox(width: 8),
            Expanded(child: Text(d.name, style: ADText.rowName(), overflow: TextOverflow.ellipsis)),
            if (!d.indexed) Text('indexing…', style: ADText.statCaption(c: AD.textTertiary)),
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
      AdChip(label: 'Auto after 2 rings', active: value == AgentRouting.auto2Rings,
          onTap: () => onChanged(AgentRouting.auto2Rings)),
      AdChip(label: 'Manual — “Send to Agent” only', active: value == AgentRouting.manualOnly,
          onTap: () => onChanged(AgentRouting.manualOnly)),
      AdChip(label: 'Off', active: value == AgentRouting.off, onTap: () => onChanged(AgentRouting.off)),
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
            const SizedBox(width: 10),
            if (hours.days[i].enabled) ...[
              Expanded(
                child: _hourField(hours.days[i].start, (v) {
                  final days = List<BusinessHoursDay>.from(hours.days);
                  days[i] = days[i].copyWith(start: v);
                  onChanged(BusinessHours(days));
                }),
              ),
              const SizedBox(width: 6),
              Text('–', style: ADText.preview()),
              const SizedBox(width: 6),
              Expanded(
                child: _hourField(hours.days[i].end, (v) {
                  final days = List<BusinessHoursDay>.from(hours.days);
                  days[i] = days[i].copyWith(end: v);
                  onChanged(BusinessHours(days));
                }),
              ),
            ] else
              Expanded(child: Text('Closed', style: ADText.preview(c: AD.textTertiary))),
          ]),
        ),
      Text(
        'Leave every day off for no hours restriction — Ava routes the same '
        'way around the clock.',
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
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      child: Text(value, style: ADText.rowName(), textAlign: TextAlign.center),
    );
  }

  Widget _servicesSection() {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Expanded(child: Text('Service numbers', style: ADText.rowName())),
        AdChip(label: '+ Add a service', onTap: _addService),
      ]),
      const SizedBox(height: 4),
      Text(
        'Extra AvaTOK numbers you advertise for paid calls (e.g. visa-interview '
        'practice). The caller pays; you set the rate and length options.',
        style: ADText.preview(),
      ),
      const SizedBox(height: 12),
      if (_loadingServices)
        const Center(child: Padding(
          padding: EdgeInsets.symmetric(vertical: 12),
          child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)),
        ))
      else if (_services.isEmpty)
        Text('No service numbers yet.', style: ADText.preview(c: AD.textTertiary))
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
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${s.name} by ${s.ownerName.isEmpty ? 'you' : s.ownerName}',
                  style: ADText.rowName()),
              const SizedBox(height: 2),
              Text('${s.rate} tokens/min · ${s.number.isEmpty ? 'number pending' : s.number}',
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
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.86),
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(18, 14, 18, 24),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Center(child: Container(width: 40, height: 4,
                  decoration: BoxDecoration(color: AD.borderControl, borderRadius: BorderRadius.circular(100)))),
              const SizedBox(height: 14),
              Text(widget.existing == null ? 'Add a service' : 'Edit service', style: ADText.threadName()),
              const SizedBox(height: 4),
              Text(
                'Callers see “${_name.text.isEmpty ? 'Your service' : _name.text} by you” '
                'before they pay — a service number never shows as your personal line.',
                style: ADText.preview(),
              ),
              const SizedBox(height: 16),
              AdField(controller: _name, label: 'Service name', hint: 'e.g. US visa interview practice'),
              const SizedBox(height: 14),
              Text('RATE (TOKENS / MIN, CALLER PAYS — MIN $kMinServiceRate)', style: ADText.sectionLabel()),
              const SizedBox(height: 9),
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
              Text('You net ${(_rate - 13).clamp(0, 999)} tokens/min after platform + line fees.',
                  style: ADText.preview()),
              const SizedBox(height: 14),
              Text('LENGTH OPTIONS (MINUTES)', style: ADText.sectionLabel()),
              const SizedBox(height: 9),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final m in const [10, 15, 20, 30, 45, 60, 90])
                  AdChip(label: '$m min', active: _lengths.contains(m), onTap: () => _toggleLength(m)),
              ]),
              const SizedBox(height: 14),
              Text('INSTRUCTIONS', style: ADText.sectionLabel()),
              const SizedBox(height: 9),
              AdField(
                controller: _instructions,
                label: 'What does this service do?',
                minLines: 3,
                maxLines: null,
                textCapitalization: TextCapitalization.sentences,
              ),
              const SizedBox(height: 14),
              Text('ROUTING', style: ADText.sectionLabel()),
              const SizedBox(height: 9),
              Wrap(spacing: 8, runSpacing: 8, children: [
                AdChip(label: 'Auto after 2 rings', active: _routing == AgentRouting.auto2Rings,
                    onTap: () => setState(() => _routing = AgentRouting.auto2Rings)),
                AdChip(label: 'Manual only', active: _routing == AgentRouting.manualOnly,
                    onTap: () => setState(() => _routing = AgentRouting.manualOnly)),
                AdChip(label: 'Off', active: _routing == AgentRouting.off,
                    onTap: () => setState(() => _routing = AgentRouting.off)),
              ]),
              if (widget.existing != null) ...[
                const SizedBox(height: 14),
                AdChip(
                  label: 'Upload knowledge document',
                  onTap: () async {
                    final res = await FilePicker.platform.pickFiles(withData: true);
                    final f = res?.files.single;
                    if (f == null || f.bytes == null) return;
                    await BusinessAgentApi.uploadDoc(f.name, f.bytes!, serviceId: widget.existing!.id);
                  },
                ),
              ],
              if (_error != null) AdErrorMsg(_error!),
              const SizedBox(height: 18),
              AdButton(
                label: _saving ? 'Saving…' : (widget.existing == null ? 'Add service' : 'Save changes'),
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
    final reduce = MediaQuery.of(context).disableAnimations;
    return GestureDetector(
      onTap: onChanged == null ? null : () => onChanged!(!value),
      child: AnimatedContainer(
        duration: reduce ? Duration.zero : const Duration(milliseconds: 120),
        width: 52, height: 30,
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(
          color: value ? AD.online : AD.card,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: AnimatedAlign(
          duration: reduce ? Duration.zero : const Duration(milliseconds: 120),
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

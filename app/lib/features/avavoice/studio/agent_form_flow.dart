
import '../../../core/localization/ui_text.dart';

import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import '../../../core/analytics.dart';
import '../../../core/api_auth.dart';
import '../../../core/avavoice_api.dart';
import '../../../core/config.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../explore/widgets.dart' show CoverImage;
import 'voice_picker.dart';

/// Create / edit an AI voice agent — a friendly 4-step wizard:
///   1. Who is your agent?     (name, role, personality / system profile)
///   2. Pick a voice           (Gemini Live voice catalog, tap to preview)
///   3. Teach it               (knowledge files = the agent's brain)
///   4. Pricing & publish      (rate w/ live "you earn" math, payer mode,
///                              session length, vision toggle)
class AgentFormFlow extends StatefulWidget {
  final VoiceAgent? existing;
  const AgentFormFlow({super.key, this.existing});
  @override
  State<AgentFormFlow> createState() => _AgentFormFlowState();
}

class _AgentFormFlowState extends State<AgentFormFlow> {
  int _step = 0;
  bool _working = false;
  String? _agentId;

  // Step 1 — identity
  late final _name = TextEditingController(text: widget.existing?.name ?? '');
  late final _role = TextEditingController(text: widget.existing?.role ?? '');
  late final _profile = TextEditingController(text: widget.existing?.systemProfile ?? '');

  // Step 1 — listing photos (1–5; at least one required to publish)
  late final List<String> _images = List.of(widget.existing?.images ?? const []);
  bool _imgUploading = false;

  // Step 2 — voice
  late String _voice = widget.existing?.voiceName ?? 'Puck';

  // Step 3 — brain files
  late List<AgentBrainFile> _files = List.of(widget.existing?.files ?? const []);
  bool _uploading = false;

  // Step 4 — pricing
  late final _rate = TextEditingController(
      text: widget.existing == null || widget.existing!.ratePerHourTokens == 0
          ? '2000'
          : widget.existing!.ratePerHourTokens.toString());
  late String _payerMode = widget.existing?.payerMode ?? 'user_pays';
  late int _sessionLimit = widget.existing?.sessionLimitMin ?? 30;
  late bool _vision = widget.existing?.visionEnabled ?? false;

  static const _titles = ['Who is your agent?', 'Pick a voice', 'Teach your agent', 'Pricing & publish'];

  @override
  void initState() {
    super.initState();
    _agentId = widget.existing?.id;
    Analytics.screenViewed('avavoice', 'studio_wizard');
    Analytics.capture('avavoice_wizard_started',
        {'mode': widget.existing == null ? 'create' : 'edit'});
  }

  @override
  void dispose() {
    _name.dispose(); _role.dispose(); _profile.dispose(); _rate.dispose();
    super.dispose();
  }

  int get _rateTokens => (double.tryParse(_rate.text.trim()) ?? 0).round();

  Map<String, dynamic> get _fields => {
        'name': _name.text.trim(),
        'role': _role.text.trim(),
        'system_profile': _profile.text.trim(),
        'voice_name': _voice,
        'images': _images,
        'rate_per_hour': _payerMode == 'creator_pays' ? 0 : _rateTokens,
        'payer_mode': _payerMode,
        'session_limit_min': _sessionLimit,
        'vision_enabled': _vision,
      };

  void _snack(String m) {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  bool _validStep() {
    switch (_step) {
      case 0:
        if (_name.text.trim().length < 2) { _snack(uiCopy(UiMessage.m_give_your_agent_a_name_850617a06b)); return false; }
        if (_role.text.trim().isEmpty) { _snack(uiCopy(UiMessage.m_describe_the_role_e_g_5fb4f6585d)); return false; }
        if (_profile.text.trim().length < 30) {
          _snack(uiCopy(UiMessage.m_tell_your_agent_who_it_e7b0e2867f));
          return false;
        }
      case 3:
        if (_payerMode == 'user_pays' && _rateTokens < 100) {
          _snack(uiCopy(UiMessage.m_set_a_rate_of_at_5894a21440));
          return false;
        }
    }
    return true;
  }

  /// Persist the draft (created lazily after step 1 so file uploads have an id).
  Future<bool> _save() async {
    setState(() => _working = true);
    bool ok;
    if (_agentId == null) {
      _agentId = await AvaVoiceApi.createAgent(_fields);
      ok = _agentId != null;
    } else {
      ok = await AvaVoiceApi.updateAgent(_agentId!, _fields);
    }
    if (mounted) setState(() => _working = false);
    if (!ok) _snack(uiCopy(UiMessage.m_could_not_save_check_your_5242516260));
    return ok;
  }

  Future<void> _next() async {
    if (!_validStep() || _working) return;
    if (!await _save() || !mounted) return;
    Analytics.capture('avavoice_wizard_step_completed', {
      'step': _step + 1, 'agent': _agentId ?? '',
      if (_step == 1) 'voice': _voice,
      if (_step == 3) 'payer_mode': _payerMode,
    });
    if (_step < 3) {
      setState(() => _step++);
    } else {
      Analytics.capture('avavoice_agent_saved_draft', {'agent': _agentId ?? ''});
      Navigator.pop(context, true); // saved as draft
    }
  }

  Future<void> _pickImage() async {
    if (_images.length >= 5 || _imgUploading) return;
    final x = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 1600, imageQuality: 85);
    if (x == null) return;
    setState(() => _imgUploading = true);
    try {
      final bytes = await x.readAsBytes();
      final res = await ApiAuth.postBytes(kUploadPublicUrl, bytes,
          extraHeaders: {'x-content-type': 'image/jpeg'}, timeout: const Duration(seconds: 60));
      if (res.statusCode == 200) {
        final url = (jsonDecode(res.body) as Map)['url']?.toString();
        if (url != null && url.isNotEmpty && mounted) setState(() => _images.add(url));
      }
      Analytics.capture('avavoice_listing_photo_upload',
          {'agent': _agentId ?? '', 'ok': res.statusCode == 200, 'count': _images.length});
    } catch (_) {/* keep UI responsive */}
    if (mounted) setState(() => _imgUploading = false);
  }

  Future<void> _publish() async {
    if (!_validStep() || _working) return;
    if (_images.isEmpty) {
      setState(() => _step = 0);
      _snack(uiCopy(UiMessage.m_add_at_least_one_photo_c380b74411));
      return;
    }
    if (!await _save()) return;
    setState(() => _working = true);
    final r = await AvaVoiceApi.publish(_agentId!);
    if (!mounted) return;
    setState(() => _working = false);
    Analytics.capture('avavoice_publish_result', {
      'agent': _agentId ?? '', 'ok': r.isEmpty, 'payer_mode': _payerMode,
      'rate_coins': _payerMode == 'creator_pays' ? 0 : _rateTokens,
      'session_limit': _sessionLimit, 'vision': _vision, 'files': _files.length,
      'voice': _voice,
    });
    if (r.isEmpty) {
      showDialog(context: context, builder: (d) => AlertDialog(
        backgroundColor: AD.card,
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Msg.rLg),
            side: const BorderSide(color: AD.borderControl, width: 1)),
        titleTextStyle: ADText.threadName().copyWith(fontSize: 20, height: 1.1, letterSpacing: -0.2),
        contentTextStyle: ADText.preview().copyWith(fontSize: 14, height: 1.42),
        title: const UiText(UiMessage.m_your_agent_is_live_13f5b67b76),
        content: UiText(UiMessage.m_value1_is_now_in_the_2501b8019a, params: {'value1': (_name.text.trim()).toString()}),
        actions: [TextButton(
            onPressed: () { Navigator.pop(d); Navigator.pop(context, true); },
            child: const UiText(UiMessage.m_done_11a6767d56))],
      ));
    } else {
      _snack(r['detail']?.toString() ?? r['error']?.toString() ?? uiCopy(UiMessage.m_publish_failed_saved_as_draft_5d39c9070f));
    }
  }

  Future<void> _addFile() async {
    if (_agentId == null && !await _save()) return;
    final picked = await FilePicker.platform.pickFiles(withData: true, type: FileType.custom,
        allowedExtensions: ['pdf', 'doc', 'docx', 'txt', 'md', 'csv', 'json', 'html', 'xlsx', 'pptx']);
    final f = picked?.files.firstOrNull;
    if (f == null || f.bytes == null) return;
    if (f.size > 25 * 1024 * 1024) { _snack(uiCopy(UiMessage.m_max_file_size_is_25_d926f55369)); return; }
    setState(() => _uploading = true);
    final rec = await AvaVoiceApi.uploadBrainFile(_agentId!, f.name, f.bytes!);
    if (!mounted) return;
    setState(() {
      _uploading = false;
      if (rec != null) _files.add(rec);
    });
    Analytics.capture('avavoice_brain_file_upload', {
      'agent': _agentId ?? '', 'ok': rec != null, 'size': f.size,
      'indexed': rec?.indexed ?? false,
    });
    if (rec == null) _snack(uiCopy(UiMessage.m_upload_failed_try_again_d0fe713dbc));
  }

  Future<void> _removeFile(AgentBrainFile f) async {
    if (_agentId == null) return;
    if (await AvaVoiceApi.deleteBrainFile(_agentId!, f.id)) {
      setState(() => _files.removeWhere((x) => x.id == f.id));
    }
  }

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: ZineAppBar(
        title: widget.existing == null ? uiCopy(UiMessage.m_new_voice_agent_af78024f19) : uiCopy(UiMessage.m_edit_value1_b3cfc66057, {'value1': (widget.existing!.name).toString()}),
        markWord: 'voice',
        tag: 'creator studio · ${_step + 1} / 4',
      ),
      body: ZinePaper(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s5, Msg.s5, Msg.s6),
          children: [
            for (var i = 0; i < 4; i++) _stepBlock(i),
          ],
        ),
      ),
    );
  }

  // ---- zine stepper chrome (ink rail + numbered dots) ----------------------

  Widget _stepBlock(int i) {
    final state = i == _step ? _WizState.active : (i < _step ? _WizState.done : _WizState.todo);
    final last = i == 3;
    return IntrinsicHeight(
      child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        // rail: numbered dot + connector line
        SizedBox(
          width: 36,
          child: Column(children: [
            _stepDot(i, state),
            if (!last)
              Expanded(
                child: Container(width: 2.5, color: AD.borderHairline,
                    margin: const EdgeInsets.symmetric(vertical: 4)),
              ),
          ]),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Padding(
            padding: EdgeInsets.only(bottom: last ? 0 : 18),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              GestureDetector(
                // can only jump to current or already-reached steps
                onTap: state == _WizState.todo || _working
                    ? null
                    : () => setState(() => _step = i),
                behavior: HitTestBehavior.opaque,
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: Msg.s2),
                  child: Text(_titles[i],
                      style: ADText.threadName(c: state == _WizState.todo ? AD.textTertiary : AD.textPrimary).copyWith(fontSize: 19, height: 1.1, letterSpacing: -0.2)),
                ),
              ),
              if (state == _WizState.active) ...[
                const SizedBox(height: 8),
                ZineCard(
                  padding: const EdgeInsets.all(16),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    _stepBody(i),
                    const SizedBox(height: 16),
                    Row(children: [
                      Expanded(
                        child: i == 3
                            ? ZineButton(
                                label: uiCopy(UiMessage.m_publish_859390eb49),
                                icon: PhosphorIcons.rocketLaunch(PhosphorIconsStyle.bold),
                                fullWidth: true,
                                fontSize: 18,
                                loading: _working,
                                onPressed: _working ? null : _publish,
                              )
                            : ZineButton(
                                label: uiCopy(UiMessage.m_continue_31fbef1625),
                                icon: PhosphorIcons.arrowRight(PhosphorIconsStyle.bold),
                                fullWidth: true,
                                fontSize: 18,
                                loading: _working,
                                onPressed: _working ? null : _next,
                              ),
                      ),
                      const SizedBox(width: 12),
                      ZineLink(
                        i == 0 ? 'cancel' : 'back',
                        fontSize: 14,
                        onTap: _working
                            ? null
                            : () {
                                if (i == 0) {
                                  Navigator.pop(context);
                                } else {
                                  setState(() => _step--);
                                }
                              },
                      ),
                    ]),
                    if (i == 3) ...[
                      const SizedBox(height: Msg.s3),
                      Center(
                        child: ZineLink('save as draft', fontSize: 13,
                            onTap: _working ? null : _next),
                      ),
                    ],
                  ]),
                ),
              ],
            ]),
          ),
        ),
      ]),
    );
  }

  Widget _stepDot(int i, _WizState state) {
    final (fill, fg) = switch (state) {
      _WizState.active => (AD.primaryBadge, Colors.white),
      _WizState.done => (AD.online, Colors.white),
      _WizState.todo => (AD.card, AD.textTertiary),
    };
    return Container(
      width: 34, height: 34,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: fill,
        border: Border.all(color: state == _WizState.todo ? AD.borderHairline : AD.borderControl, width: 1),
        boxShadow: state == _WizState.active ? Msg.none : null,
      ),
      child: Center(
        child: state == _WizState.done
            ? PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), size: 16, color: fg)
            : Text('${i + 1}',
                style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w600,
                    fontSize: 16, color: fg)),
      ),
    );
  }

  Widget _stepBody(int i) => switch (i) {
        0 => _stepIdentity(),
        1 => _stepVoice(),
        2 => _stepBrain(),
        _ => _stepPricing(),
      };

  // ── Step 1: identity ──────────────────────────────────────────────────
  Widget _stepIdentity() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ZineField(
          controller: _name,
          label: uiCopy(UiMessage.m_agent_name_b274a9b897),
          labelIcon: PhosphorIcons.robot(PhosphorIconsStyle.bold),
          hint: uiCopy(UiMessage.m_e_g_ava_the_interview_225f7ac34c),
          maxLength: 40,
          textCapitalization: TextCapitalization.words,
        ),
        const SizedBox(height: 16),
        ZineField(
          controller: _role,
          label: uiCopy(UiMessage.m_role_it_plays_469c3b23b8),
          labelIcon: PhosphorIcons.identificationBadge(PhosphorIconsStyle.bold),
          hint: uiCopy(UiMessage.m_e_g_mock_us_visa_4dd8053d49),
          maxLength: 80,
          textCapitalization: TextCapitalization.sentences,
        ),
        const SizedBox(height: 16),
        ZineField(
          controller: _profile,
          label: uiCopy(UiMessage.m_system_profile_who_is_this_ffff5fbae7),
          labelIcon: PhosphorIcons.brain(PhosphorIconsStyle.bold),
          hint: uiCopy(UiMessage.m_you_are_a_friendly_but_f8238e4355),
          maxLines: 7,
          maxLength: 4000,
          textCapitalization: TextCapitalization.sentences,
        ),
        const SizedBox(height: 8),
        UiText(
          UiMessage.m_the_better_you_describe_the_79cefe9019,
          style: ADText.preview().copyWith(fontSize: 12, height: 1.42),
        ),
        const SizedBox(height: 16),
        UiText(UiMessage.m_listing_photos_1_5_3aea2c80ae, style: ADText.sectionLabel(c: AD.textSecondary).copyWith(fontSize: 11, letterSpacing: 0.88)),
        const SizedBox(height: Msg.s2),
        Wrap(spacing: 12, runSpacing: 12, children: [
          for (var i = 0; i < _images.length; i++)
            Stack(clipBehavior: Clip.none, children: [
              Container(
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(Msg.rLg),
                  border: Border.all(color: AD.borderControl, width: 1),
                  boxShadow: Msg.none,
                ),
                clipBehavior: Clip.antiAlias,
                child: CoverImage(url: _images[i], seed: i, width: 88, height: 88),
              ),
              Positioned(
                right: -7, top: -7,
                child: GestureDetector(
                  onTap: () => setState(() => _images.removeAt(i)),
                  child: Container(
                    width: 26, height: 26,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle, color: AD.danger,
                      border: Border.all(color: AD.borderControl, width: 1),
                    ),
                    child: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold), size: 14, color: Colors.white),
                  ),
                ),
              ),
            ]),
          if (_images.length < 5)
            GestureDetector(
              onTap: _pickImage,
              child: Container(
                width: 88, height: 88,
                decoration: BoxDecoration(
                  color: AD.card,
                  borderRadius: BorderRadius.circular(Msg.rLg),
                  border: Border.all(color: AD.borderControl, width: 1),
                ),
                child: _imgUploading
                    ? const Center(child: SizedBox(width: 20, height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2, color: AD.tabGroups)))
                    : PhosphorIcon(PhosphorIcons.cameraPlus(PhosphorIconsStyle.bold),
                        size: 26, color: AD.textSecondary),
              ),
            ),
        ]),
        const SizedBox(height: 8),
        UiText(UiMessage.m_at_least_one_photo_is_9487a29f3d,
            style: ADText.preview().copyWith(fontSize: 12, height: 1.42)),
      ]);

  // ── Step 2: voice ─────────────────────────────────────────────────────
  Widget _stepVoice() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(
              icon: PhosphorIcons.waveform(PhosphorIconsStyle.bold),
              color: AD.tabCalls, size: 30),
          const SizedBox(width: Msg.s2),
          Expanded(
            child: UiText(UiMessage.m_choose_how_your_agent_sounds_d20a0175d9,
                style: ADText.preview().copyWith(fontSize: 13, height: 1.42)),
          ),
        ]),
        const SizedBox(height: Msg.s3),
        VoicePicker(selected: _voice, onSelected: (v) => setState(() => _voice = v)),
      ]);

  // ── Step 3: brain files ───────────────────────────────────────────────
  Widget _stepBrain() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        UiText(
          UiMessage.m_upload_documents_your_agent_should_7ae7a9b7c1,
          style: ADText.preview().copyWith(fontSize: 13, height: 1.42),
        ),
        const SizedBox(height: 16),
        ZineButton(
          label: _uploading ? uiCopy(UiMessage.m_uploading_5ce44dd77d) : uiCopy(UiMessage.m_add_knowledge_file_b739f6061d),
          variant: ZineButtonVariant.blue,
          icon: PhosphorIcons.uploadSimple(PhosphorIconsStyle.bold),
          trailingIcon: false,
          fontSize: 16,
          loading: _uploading,
          onPressed: _uploading ? null : _addFile,
        ),
        const SizedBox(height: Msg.s3),
        if (_files.isEmpty)
          UiText(UiMessage.m_no_files_yet_that_s_6ec7c3742a,
              style: ADText.preview().copyWith(fontSize: 12, height: 1.42))
        else
          for (final f in _files)
            Padding(
              padding: const EdgeInsets.only(bottom: Msg.s3),
              child: Container(
                padding: const EdgeInsets.fromLTRB(Msg.s3, Msg.s3, Msg.s3, Msg.s3),
                decoration: BoxDecoration(
                  color: AD.card,
                  borderRadius: BorderRadius.circular(Msg.rLg),
                  border: Border.all(color: AD.borderControl, width: 1),
                  boxShadow: Msg.none,
                ),
                child: Row(children: [
                  ZineIconBadge(
                      icon: PhosphorIcons.fileText(PhosphorIconsStyle.bold),
                      color: AD.tabCalls, size: 30),
                  const SizedBox(width: Msg.s2),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(f.filename, maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: ADText.rowName().copyWith(fontSize: 14, height: 1.3)),
                      const SizedBox(height: 2),
                      Text(f.indexed ? uiCopy(UiMessage.m_indexed_ready_28799259d7) : uiCopy(UiMessage.m_indexing_740c08d6b6),
                          style: ADText.tabLabel(c: f.indexed ? AD.online : AD.textSecondary).copyWith(fontSize: 10, letterSpacing: 0.4)),
                    ]),
                  ),
                  const SizedBox(width: 8),
                  GestureDetector(
                    onTap: () => _removeFile(f),
                    child: Container(
                      width: 28, height: 28,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: AD.card,
                        border: Border.all(color: AD.borderControl, width: 1),
                      ),
                      child: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold),
                          size: 13, color: AD.textPrimary),
                    ),
                  ),
                ]),
              ),
            ),
      ]);

  // ── Step 4: pricing & publish ─────────────────────────────────────────
  Widget _stepPricing() {
    final userPays = _payerMode == 'user_pays';
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      UiText(UiMessage.m_who_pays_for_calls_628c468eeb, style: ADText.sectionLabel(c: AD.textSecondary).copyWith(fontSize: 11, letterSpacing: 0.88)),
      const SizedBox(height: Msg.s2),
      _payerCard('user_pays', 'Callers pay you',
          'You set an hourly rate. Callers are billed per minute; you earn 50% after the platform fee.'),
      const SizedBox(height: Msg.s2),
      _payerCard('creator_pays', 'You cover the calls (free for callers)',
          'Great for business agents — receptionists, support lines. You pay a flat ${fmtTokens(kCreatorPaysRateTokensPerHour)}/hour of talk time from your AvaWallet.'),
      const SizedBox(height: Msg.s4),
      if (userPays) ...[
        ZineField(
          controller: _rate,
          label: uiCopy(UiMessage.m_your_hourly_rate_b6b0aa94a2),
          labelIcon: PhosphorIcons.coins(PhosphorIconsStyle.bold),
          leadText: '₹',
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: Msg.s2),
        // "You earn" math — mint (money accent).
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: AD.card,
            borderRadius: BorderRadius.circular(Msg.rLg),
            border: Border.all(color: AD.borderControl, width: 1),
            boxShadow: Msg.none,
          ),
          child: Row(children: [
            PhosphorIcon(PhosphorIcons.wallet(PhosphorIconsStyle.regular),
                size: 18, color: AD.online),
            const SizedBox(width: Msg.s2),
            Expanded(
              child: Text(
                _rateTokens >= 100
                    ? uiCopy(UiMessage.m_callers_pay_value1_min_you_74b8eaa39b, {'value1': (fmtTokens(perMinuteTokens(_rateTokens))).toString(), 'value2': (fmtTokens(creatorNetPerHour(_rateTokens))).toString()})
                    : uiCopy(UiMessage.m_enter_your_hourly_rate_to_2973edb9bf),
                style: ADText.rowName().copyWith(fontSize: 13, height: 1.3),
              ),
            ),
          ]),
        ),
        const SizedBox(height: Msg.s4),
      ],
      UiText(UiMessage.m_maximum_session_length_3c0cab50c4, style: ADText.sectionLabel(c: AD.textSecondary).copyWith(fontSize: 11, letterSpacing: 0.88)),
      const SizedBox(height: 4),
      UiText(UiMessage.m_your_agent_works_toward_a_81f4899a7d,
          style: ADText.preview().copyWith(fontSize: 12, height: 1.42)),
      const SizedBox(height: Msg.s2),
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (final m in kSessionLimitChoices)
          ZineChip(
            label: m == 60 ? uiCopy(UiMessage.m_1_hour_f8b8883f0c) : uiCopy(UiMessage.m_m_min_b8b9f90dff, {'m': (m).toString()}),
            active: m == _sessionLimit,
            onTap: () => setState(() => _sessionLimit = m),
          ),
      ]),
      const SizedBox(height: Msg.s4),
      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            UiText(UiMessage.m_vision_screen_camera_b2704fa9ce, style: ADText.rowName().copyWith(fontSize: 15, height: 1.3)),
            const SizedBox(height: Msg.s1),
            UiText(
                UiMessage.m_let_callers_share_their_screen_85e9b862f3,
                style: ADText.preview().copyWith(fontSize: 12, height: 1.42)),
          ]),
        ),
        const SizedBox(width: Msg.s2),
        ZineToggle(value: _vision, onChanged: (v) => setState(() => _vision = v)),
      ]),
    ]);
  }

  Widget _payerCard(String mode, String title, String body) {
    final sel = _payerMode == mode;
    return ZinePressable(
      onTap: () => setState(() => _payerMode = mode),
      color: sel ? AD.tabGroups : AD.card,
      radius: BorderRadius.circular(Msg.rLg),
      boxShadow: Msg.none,
      padding: const EdgeInsets.all(Msg.s4),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          width: 22, height: 22,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: AD.card,
            border: Border.all(color: AD.borderControl, width: 1),
          ),
          child: sel
              ? Center(
                  child: Container(width: 9, height: 9,
                      decoration: const BoxDecoration(shape: BoxShape.circle, color: AD.primaryBadge)))
              : null,
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ADText.threadName().copyWith(fontSize: 16, height: 1.1, letterSpacing: -0.2)),
            const SizedBox(height: Msg.s1),
            Text(body, style: ADText.preview(c: sel ? AD.textPrimary : AD.textSecondary).copyWith(fontSize: 12, height: 1.42)),
          ]),
        ),
      ]),
    );
  }
}

enum _WizState { active, done, todo }


import '../../../core/localization/ui_text.dart';

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import '../../../core/analytics.dart';
import '../../../core/api_auth.dart';
import '../../../core/avavision_api.dart';
import '../../../core/config.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../explore/widgets.dart' show CoverImage;
import '../widgets.dart';
import 'template_picker.dart';
import 'voice_picker.dart';

// NOTE (Phase 3 dependency): the live overlay engine + camera preview is
// `VisionPreviewPane(capability:, overlayStyle:)` owned by Phase 3
// (app/lib/features/avavision/session/**). Until that lands we render the local
// [_VisionPreviewPlaceholder] below so this file compiles standalone. Phase Z
// swaps the placeholder for the real widget. See Specs/avavision-build/glue/PHASE-2-GLUE.md.

/// Create / edit an AI VISION agent — a template-first 5-step wizard:
///   0. Pick a template      (category → use-case; prefills the camera setup)
///   1. Who is your agent?    (name, role, system profile, 1–5 listing photos)
///   2. Pick a voice          (Gemini Live voice catalog, tap to preview)
///   3. Vision options        (overlay, live score, "Analyze my form" snapshot)
///   4. Pricing & publish     (rate w/ live "you earn" math, payer mode, length)
class AgentFormFlow extends StatefulWidget {
  final VisionAgent? existing;
  const AgentFormFlow({super.key, this.existing});
  @override
  State<AgentFormFlow> createState() => _AgentFormFlowState();
}

class _AgentFormFlowState extends State<AgentFormFlow> {
  static const _stepCount = 5;
  static const _lastStep = 4;

  int _step = 0;
  bool _working = false;
  String? _agentId;

  // Step 0 — template
  String _templateId = '';
  String _templateName = '';

  // Step 1 — identity
  late final _name = TextEditingController(text: widget.existing?.name ?? '');
  late final _role = TextEditingController(text: widget.existing?.role ?? '');
  late final _profile = TextEditingController(text: widget.existing?.systemProfile ?? '');
  late final List<String> _images = List.of(widget.existing?.images ?? const []);
  bool _imgUploading = false;

  // Step 2 — voice
  late String _voice = widget.existing?.voiceName ?? 'Puck';

  // Step 3 — vision options
  String _capability = 'gemini_only';
  String? _mediapipeSolution;
  String? _engineDefault;
  bool _overlayEnabled = false;
  String _overlayStyle = 'none';
  String _scoringMode = 'none';
  late final _scoreLabel = TextEditingController(text: widget.existing?.scoreLabel ?? '');
  bool _agenticSnapshot = false;
  int _freeSnapshots = 3;
  bool _saveSnapshots = false;
  List<String> _safetyNotes = const [];

  // Step 4 — pricing
  late final _rate = TextEditingController(
      text: widget.existing == null || widget.existing!.ratePerHourTokens == 0
          ? '2000'
          : widget.existing!.ratePerHourTokens.toString());
  late String _payerMode = widget.existing?.payerMode ?? 'user_pays';
  late int _sessionLimit = widget.existing?.sessionLimitMin ?? 30;

  static const _titles = [
    'Pick a template',
    'Who is your agent?',
    'Pick a voice',
    'Vision options',
    'Pricing & publish',
  ];

  static const _freeSnapshotChoices = [0, 3, 5, 8];

  @override
  void initState() {
    super.initState();
    _agentId = widget.existing?.id;
    final e = widget.existing;
    if (e != null) {
      _templateId = e.templateId;
      _capability = e.capability;
      _mediapipeSolution = e.mediapipeSolution;
      _engineDefault = e.engineDefault;
      _overlayEnabled = e.overlayEnabled;
      _overlayStyle = e.overlayStyle;
      _scoringMode = e.scoringMode;
      _agenticSnapshot = e.agenticSnapshotEnabled;
      _freeSnapshots = e.freeSnapshotsPerSession > 0 ? e.freeSnapshotsPerSession : 3;
      _saveSnapshots = e.saveSnapshots;
    }
    Analytics.screenViewed('avavision', 'studio_wizard');
    Analytics.capture('avavision_wizard_started', {'mode': e == null ? 'create' : 'edit'});
  }

  @override
  void dispose() {
    _name.dispose();
    _role.dispose();
    _profile.dispose();
    _rate.dispose();
    _scoreLabel.dispose();
    super.dispose();
  }

  int get _rateTokens => (double.tryParse(_rate.text.trim()) ?? 0).round();

  // Live always runs; "both" when the deep snapshot is also enabled.
  String get _visionMode => _agenticSnapshot ? 'both' : 'live';

  Map<String, dynamic> get _fields => {
        'template_id': _templateId,
        'name': _name.text.trim(),
        'role': _role.text.trim(),
        'system_profile': _profile.text.trim(),
        'voice_name': _voice,
        'images': _images,
        'rate_per_hour': _payerMode == 'creator_pays' ? 0 : _rateTokens,
        'payer_mode': _payerMode,
        'session_limit_min': _sessionLimit,
        // vision
        'capability': _capability,
        'mediapipe_solution': _mediapipeSolution,
        'engine_default': _engineDefault,
        'overlay_enabled': _overlayEnabled,
        'overlay_style': _overlayEnabled ? _overlayStyle : 'none',
        'scoring_mode': _scoringMode,
        'score_label': _scoringMode == 'none' ? null : _scoreLabel.text.trim(),
        'vision_mode': _visionMode,
        'agentic_snapshot_enabled': _agenticSnapshot,
        'free_snapshots_per_session': _agenticSnapshot ? _freeSnapshots : 0,
        'media_resolution': 'LOW',
        'save_snapshots': _saveSnapshots,
        'platforms': {'android': true, 'ios': _capSupportsIos(_capability), 'web': true},
      };

  // Capability → default overlay style (master §6 overlay enum).
  String _overlayStyleFor(String cap) => switch (cap) {
        'pose' || 'holistic' => 'skeleton',
        'hand' => 'hand_mesh',
        'face_landmark' => 'face_mesh',
        'face_detect' || 'object' => 'bounding_box',
        'segmentation' => 'segmentation_mask',
        _ => 'none',
      };

  bool _capSupportsOverlay(String cap) => _overlayStyleFor(cap) != 'none';

  // Engine policy (master §3/§6): face_landmark/segmentation/holistic have no
  // free iOS engine → Android/Web only.
  bool _capSupportsIos(String cap) =>
      !(cap == 'face_landmark' || cap == 'segmentation' || cap == 'holistic');

  List<String> _scoringOptionsFor(String cap) =>
      cap == 'gemini_only' ? const ['gemini_qualitative', 'none'] : const ['geometry', 'gemini_qualitative', 'hybrid', 'none'];

  String _scoringLabel(String m) => switch (m) {
        'geometry' => 'On-device geometry',
        'gemini_qualitative' => 'AI judges technique',
        'hybrid' => 'Hybrid (both)',
        _ => 'No score',
      };

  void _applyTemplate(VisionTemplate t) {
    setState(() {
      _templateId = t.id;
      _templateName = t.name;
      _capability = t.capability;
      _mediapipeSolution = t.mediapipeSolution;
      _engineDefault = t.engineDefault;
      _overlayEnabled = t.hasOverlay;
      _overlayStyle = t.overlayStyle == 'none' ? _overlayStyleFor(t.capability) : t.overlayStyle;
      _scoringMode = t.scoringMode;
      if (_scoreLabel.text.trim().isEmpty) _scoreLabel.text = t.scoreLabel ?? '';
      _agenticSnapshot = t.agenticSnapshotEnabled;
      _freeSnapshots = t.freeSnapshotsPerSession > 0 ? t.freeSnapshotsPerSession : 3;
      _safetyNotes = t.safetyNotes;
      // Seed identity from the template so the creator just edits text.
      if (_role.text.trim().isEmpty) _role.text = t.name;
      if (_profile.text.trim().isEmpty) _profile.text = t.starterPrompt;
    });
  }

  Future<void> _chooseTemplate() async {
    final t = await Navigator.push<VisionTemplate>(
        context, MaterialPageRoute(builder: (_) => const TemplatePickerScreen()));
    if (t != null) _applyTemplate(t);
  }

  void _snack(String m) {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  bool _validStep() {
    switch (_step) {
      case 0:
        if (_templateId.isEmpty) {
          _snack(uiCopy(UiMessage.m_pick_a_template_to_start_cac9b998c7));
          return false;
        }
      case 1:
        if (_name.text.trim().length < 2) {
          _snack(uiCopy(UiMessage.m_give_your_agent_a_name_850617a06b));
          return false;
        }
        if (_role.text.trim().isEmpty) {
          _snack(uiCopy(UiMessage.m_describe_the_role_e_g_4ecbb001d7));
          return false;
        }
        if (_profile.text.trim().length < 30) {
          _snack(uiCopy(UiMessage.m_tell_your_agent_who_it_2b46da5fa8));
          return false;
        }
      case 3:
        if (_scoringMode != 'none' && _scoreLabel.text.trim().isEmpty) {
          _snack(uiCopy(UiMessage.m_name_the_on_screen_score_43e41e2270));
          return false;
        }
      case 4:
        if (_payerMode == 'user_pays' && _rateTokens < 100) {
          _snack(uiCopy(UiMessage.m_set_a_rate_of_at_5894a21440));
          return false;
        }
    }
    return true;
  }

  Future<bool> _save() async {
    setState(() => _working = true);
    bool ok;
    if (_agentId == null) {
      _agentId = await AvaVisionApi.createAgent(_fields);
      ok = _agentId != null;
    } else {
      ok = await AvaVisionApi.updateAgent(_agentId!, _fields);
    }
    if (mounted) setState(() => _working = false);
    if (!ok) _snack(uiCopy(UiMessage.m_could_not_save_check_your_5242516260));
    return ok;
  }

  Future<void> _next() async {
    if (!_validStep() || _working) return;
    // _save() creates the draft on the first call (step 0, once a template is
    // chosen) and updates it thereafter, so file uploads have an agent id.
    if (!await _save() || !mounted) return;
    Analytics.capture('avavision_wizard_step_completed', {
      'step': _step + 1,
      'agent': _agentId ?? '',
      if (_step == 0) 'template': _templateId,
      if (_step == 2) 'voice': _voice,
      if (_step == 4) 'payer_mode': _payerMode,
    });
    if (_step < _lastStep) {
      setState(() => _step++);
    } else {
      Analytics.capture('avavision_agent_saved_draft', {'agent': _agentId ?? ''});
      Navigator.pop(context, true);
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
      Analytics.capture('avavision_listing_photo_upload',
          {'agent': _agentId ?? '', 'ok': res.statusCode == 200, 'count': _images.length});
    } catch (_) {/* keep UI responsive */}
    if (mounted) setState(() => _imgUploading = false);
  }

  Future<void> _publish() async {
    if (!_validStep() || _working) return;
    if (_images.isEmpty) {
      setState(() => _step = 1);
      _snack(uiCopy(UiMessage.m_add_at_least_one_photo_c380b74411));
      return;
    }
    if (!await _save()) return;
    setState(() => _working = true);
    final r = await AvaVisionApi.publish(_agentId!);
    if (!mounted) return;
    setState(() => _working = false);
    Analytics.capture('avavision_publish_result', {
      'agent': _agentId ?? '',
      'ok': r.isEmpty,
      'payer_mode': _payerMode,
      'rate_coins': _payerMode == 'creator_pays' ? 0 : _rateTokens,
      'session_limit': _sessionLimit,
      'capability': _capability,
      'overlay': _overlayEnabled ? _overlayStyle : 'none',
      'scoring': _scoringMode,
      'snapshot': _agenticSnapshot,
      'voice': _voice,
    });
    if (r.isEmpty) {
      showDialog(
          context: context,
          builder: (d) => AlertDialog(
                backgroundColor: AD.card,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(Msg.rLg),
                    side: const BorderSide(color: AD.borderControl, width: 1)),
                titleTextStyle: ADText.threadName().copyWith(fontSize: 20, height: 1.1, letterSpacing: -0.2),
                contentTextStyle: ADText.preview().copyWith(fontSize: 14, height: 1.42),
                title: const UiText(UiMessage.m_your_vision_agent_is_live_c60db58c45),
                content: UiText(UiMessage.m_value1_is_now_in_the_40a44bce01, params: {'value1': (_name.text.trim()).toString()}),
                actions: [
                  TextButton(
                      onPressed: () {
                        Navigator.pop(d);
                        Navigator.pop(context, true);
                      },
                      child: const UiText(UiMessage.m_done_11a6767d56))
                ],
              ));
    } else {
      // Server returns {error:'Validation', field, detail} — surface the detail.
      _snack(r['detail']?.toString() ?? r['error']?.toString() ?? uiCopy(UiMessage.m_publish_failed_saved_as_draft_5d39c9070f));
    }
  }

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: ZineAppBar(
        title: widget.existing == null ? uiCopy(UiMessage.m_new_vision_agent_49fc1a1b3b) : uiCopy(UiMessage.m_edit_value1_b3cfc66057, {'value1': (widget.existing!.name).toString()}),
        markWord: 'vision',
        tag: 'creator studio · ${_step + 1} / $_stepCount',
      ),
      body: ZinePaper(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s5, Msg.s5, Msg.s6),
          children: [for (var i = 0; i < _stepCount; i++) _stepBlock(i)],
        ),
      ),
    );
  }

  // ---- zine stepper chrome (ink rail + numbered dots) ----------------------
  Widget _stepBlock(int i) {
    final state = i == _step ? _WizState.active : (i < _step ? _WizState.done : _WizState.todo);
    final last = i == _lastStep;
    return IntrinsicHeight(
      child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SizedBox(
          width: 36,
          child: Column(children: [
            _stepDot(i, state),
            if (!last)
              Expanded(
                child: Container(
                    width: 2.5,
                    color: AD.borderHairline,
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
                onTap: state == _WizState.todo || _working ? null : () => setState(() => _step = i),
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
                        child: i == _lastStep
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
                    if (i == _lastStep) ...[
                      const SizedBox(height: Msg.s3),
                      Center(child: ZineLink('save as draft', fontSize: 13, onTap: _working ? null : _next)),
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
      width: 34,
      height: 34,
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
                style: TextStyle(
                    fontFamily: ADText.family, fontWeight: FontWeight.w600, fontSize: 16, color: fg)),
      ),
    );
  }

  Widget _stepBody(int i) => switch (i) {
        0 => _stepTemplate(),
        1 => _stepIdentity(),
        2 => _stepVoice(),
        3 => _stepVision(),
        _ => _stepPricing(),
      };

  // ── Step 0: template ──────────────────────────────────────────────────
  Widget _stepTemplate() {
    if (_templateId.isEmpty) {
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        UiText(UiMessage.m_every_vision_agent_starts_from_9934977a0b,
            style: ADText.preview().copyWith(fontSize: 13, height: 1.42)),
        const SizedBox(height: 16),
        ZineButton(
          label: uiCopy(UiMessage.m_choose_a_template_329a8ef36e),
          variant: ZineButtonVariant.blue,
          icon: PhosphorIcons.squaresFour(PhosphorIconsStyle.bold),
          trailingIcon: false,
          fontSize: 16,
          onPressed: _chooseTemplate,
        ),
      ]);
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Container(
        padding: const EdgeInsets.all(Msg.s4),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: BorderRadius.circular(Msg.rLg),
          border: Border.all(color: AD.borderControl, width: 1),
          boxShadow: Msg.none,
        ),
        child: Row(children: [
          ZineIconBadge(icon: PhosphorIcons.eye(PhosphorIconsStyle.bold), color: AD.tabCalls, size: 40),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(_templateName.isEmpty ? _templateId : _templateName, style: ADText.threadName().copyWith(fontSize: 16, height: 1.1, letterSpacing: -0.2)),
              const SizedBox(height: Msg.s1),
              Wrap(spacing: Msg.s1, runSpacing: Msg.s1, children: [
                CapabilityBadge(_capability),
                if (_overlayEnabled) OverlayBadge(_overlayStyle),
                if (_scoringMode != 'none' && _scoreLabel.text.trim().isNotEmpty)
                  ScoreBadge(_scoreLabel.text.trim()),
              ]),
            ]),
          ),
        ]),
      ),
      const SizedBox(height: Msg.s2),
      ZineLink('change template', onTap: _chooseTemplate),
    ]);
  }

  // ── Step 1: identity ──────────────────────────────────────────────────
  Widget _stepIdentity() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ZineField(
          controller: _name,
          label: uiCopy(UiMessage.m_agent_name_b274a9b897),
          labelIcon: PhosphorIcons.eye(PhosphorIconsStyle.bold),
          hint: uiCopy(UiMessage.m_e_g_coach_vega_squat_76d34229bf),
          maxLength: 40,
          textCapitalization: TextCapitalization.words,
        ),
        const SizedBox(height: 16),
        ZineField(
          controller: _role,
          label: uiCopy(UiMessage.m_role_it_plays_469c3b23b8),
          labelIcon: PhosphorIcons.identificationBadge(PhosphorIconsStyle.bold),
          hint: uiCopy(UiMessage.m_e_g_squat_deadlift_form_d91defa8f7),
          maxLength: 80,
          textCapitalization: TextCapitalization.sentences,
        ),
        const SizedBox(height: 16),
        ZineField(
          controller: _profile,
          label: uiCopy(UiMessage.m_system_profile_how_should_it_49a3b88e14),
          labelIcon: PhosphorIcons.brain(PhosphorIconsStyle.bold),
          hint: uiCopy(UiMessage.m_seeded_from_your_template_edit_259ba4e77d),
          maxLines: 8,
          maxLength: 4000,
          textCapitalization: TextCapitalization.sentences,
        ),
        const SizedBox(height: 8),
        UiText(
          UiMessage.m_platform_safety_rules_technique_only_f6d36b5091,
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
                right: -7,
                top: -7,
                child: GestureDetector(
                  onTap: () => setState(() => _images.removeAt(i)),
                  child: Container(
                    width: 26,
                    height: 26,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: AD.danger,
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
                width: 88,
                height: 88,
                decoration: BoxDecoration(
                  color: AD.card,
                  borderRadius: BorderRadius.circular(Msg.rLg),
                  border: Border.all(color: AD.borderControl, width: 1),
                ),
                child: _imgUploading
                    ? const Center(
                        child: SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2, color: AD.tabGroups)))
                    : PhosphorIcon(PhosphorIcons.cameraPlus(PhosphorIconsStyle.bold), size: 26, color: AD.textSecondary),
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
          ZineIconBadge(icon: PhosphorIcons.waveform(PhosphorIconsStyle.bold), color: AD.tabCalls, size: 30),
          const SizedBox(width: Msg.s2),
          Expanded(child: UiText(UiMessage.m_choose_how_your_coach_sounds_2949a4aa99, style: ADText.preview().copyWith(fontSize: 13, height: 1.42))),
        ]),
        const SizedBox(height: Msg.s3),
        VoicePicker(selected: _voice, onSelected: (v) => setState(() => _voice = v)),
      ]);

  // ── Step 3: vision options ────────────────────────────────────────────
  Widget _stepVision() {
    final canOverlay = _capSupportsOverlay(_capability);
    final scoringOpts = _scoringOptionsFor(_capability);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      // Live preview pane (placeholder until Phase 3's VisionPreviewPane lands).
      _VisionPreviewPlaceholder(
        capability: _capability,
        overlayStyle: _overlayEnabled ? _overlayStyle : 'none',
        scoreLabel: _scoringMode == 'none' ? null : _scoreLabel.text.trim(),
      ),
      const SizedBox(height: 16),

      // Overlay
      if (canOverlay) ...[
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              UiText(UiMessage.m_show_the_value1_overlay_2087888fa6, params: {'value1': (overlayLabel(_overlayStyle).toLowerCase()).toString()}, style: ADText.rowName().copyWith(fontSize: 15, height: 1.3)),
              const SizedBox(height: Msg.s1),
              UiText(UiMessage.m_draws_a_live_value1_on_1c90cdfe71, params: {'value1': (overlayLabel(_overlayStyle).toLowerCase()).toString()},
                  style: ADText.preview().copyWith(fontSize: 12, height: 1.42)),
            ]),
          ),
          const SizedBox(width: Msg.s2),
          ZineToggle(value: _overlayEnabled, onChanged: (v) => setState(() => _overlayEnabled = v)),
        ]),
        const SizedBox(height: Msg.s4),
      ] else
        Padding(
          padding: const EdgeInsets.only(bottom: Msg.s5),
          child: UiText(UiMessage.m_this_capability_reads_the_whole_519b261e3b,
              style: ADText.preview().copyWith(fontSize: 13, height: 1.42)),
        ),

      // Scoring
      UiText(UiMessage.m_live_score_e340d62781, style: ADText.sectionLabel(c: AD.textSecondary).copyWith(fontSize: 11, letterSpacing: 0.88)),
      const SizedBox(height: Msg.s2),
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (final m in scoringOpts)
          ZineChip(label: _scoringLabel(m), active: m == _scoringMode, onTap: () => setState(() => _scoringMode = m)),
      ]),
      if (_scoringMode != 'none') ...[
        const SizedBox(height: 12),
        ZineField(
          controller: _scoreLabel,
          label: uiCopy(UiMessage.m_score_label_31047751dd),
          labelIcon: PhosphorIcons.gauge(PhosphorIconsStyle.bold),
          hint: uiCopy(UiMessage.m_e_g_formscore_ddc470f010),
          maxLength: 20,
          onChanged: (_) => setState(() {}),
        ),
      ],
      const SizedBox(height: Msg.s4),

      // Agentic snapshot
      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            UiText(UiMessage.m_analyze_my_form_deep_snapshot_8860fe9d65, style: ADText.rowName().copyWith(fontSize: 15, height: 1.3)),
            const SizedBox(height: Msg.s1),
            UiText(UiMessage.m_lets_the_user_tap_once_775aba540f,
                style: ADText.preview().copyWith(fontSize: 12, height: 1.42)),
          ]),
        ),
        const SizedBox(width: Msg.s2),
        ZineToggle(value: _agenticSnapshot, onChanged: (v) => setState(() => _agenticSnapshot = v)),
      ]),
      if (_agenticSnapshot) ...[
        const SizedBox(height: 12),
        UiText(UiMessage.m_free_snapshots_per_session_ca119fbcee, style: ADText.sectionLabel(c: AD.textSecondary).copyWith(fontSize: 11, letterSpacing: 0.88)),
        const SizedBox(height: Msg.s2),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final n in _freeSnapshotChoices)
            ZineChip(label: '$n', active: n == _freeSnapshots, onTap: () => setState(() => _freeSnapshots = n)),
        ]),
      ],
      const SizedBox(height: Msg.s4),

      // Save snapshots — OFF by default (master §10 / platform safety default).
      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            UiText(UiMessage.m_save_snapshots_to_the_agent_a6930b00a6, style: ADText.rowName().copyWith(fontSize: 15, height: 1.3)),
            const SizedBox(height: Msg.s1),
            UiText(UiMessage.m_off_by_default_snapshots_are_3b36c04b1e,
                style: ADText.preview().copyWith(fontSize: 12, height: 1.42)),
          ]),
        ),
        const SizedBox(width: Msg.s2),
        ZineToggle(value: _saveSnapshots, onChanged: (v) => setState(() => _saveSnapshots = v)),
      ]),

      // Platform-enforced safety notes (read-only).
      if (_safetyNotes.isNotEmpty) ...[
        const SizedBox(height: Msg.s4),
        UiText(UiMessage.m_platform_safety_enforced_825fa8e0ff, style: ADText.sectionLabel(c: AD.textSecondary).copyWith(fontSize: 11, letterSpacing: 0.88)),
        const SizedBox(height: Msg.s2),
        Wrap(spacing: Msg.s1, runSpacing: Msg.s1, children: [
          for (final s in _safetyNotes)
            MiniPill(s.replaceAll('_', ' '),
                fill: AD.card, fg: AD.textSecondary, icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold), shadow: false),
        ]),
      ],
      // Platform availability for the chosen capability.
      const SizedBox(height: Msg.s3),
      Row(children: [
        PhosphorIcon(PhosphorIcons.monitor(PhosphorIconsStyle.bold), size: 16, color: AD.textSecondary),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            _capSupportsIos(_capability)
                ? uiCopy(UiMessage.m_runs_on_android_ios_and_6d3ec130fe)
                : uiCopy(UiMessage.m_runs_on_android_and_web_70e759f1e9),
            style: ADText.preview().copyWith(fontSize: 12, height: 1.42),
          ),
        ),
      ]),
    ]);
  }

  // ── Step 4: pricing & publish ─────────────────────────────────────────
  Widget _stepPricing() {
    final userPays = _payerMode == 'user_pays';
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      UiText(UiMessage.m_who_pays_for_sessions_67fa852793, style: ADText.sectionLabel(c: AD.textSecondary).copyWith(fontSize: 11, letterSpacing: 0.88)),
      const SizedBox(height: Msg.s2),
      _payerCard('user_pays', 'Users pay you',
          'You set an hourly rate. Users are billed per minute; you earn 50% after the platform fee.'),
      const SizedBox(height: Msg.s2),
      _payerCard('creator_pays', 'You cover the sessions (free for users)',
          'Great for brand/clinic coaches. You pay a flat ${fmtTokens(kCreatorPaysRateTokensPerHour)}/hour of session time from your AvaWallet. Snapshots are bundled in.'),
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
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: AD.card,
            borderRadius: BorderRadius.circular(Msg.rLg),
            border: Border.all(color: AD.borderControl, width: 1),
            boxShadow: Msg.none,
          ),
          child: Row(children: [
            PhosphorIcon(PhosphorIcons.wallet(PhosphorIconsStyle.regular), size: 18, color: AD.online),
            const SizedBox(width: Msg.s2),
            Expanded(
              child: Text(
                _rateTokens >= 100
                    ? uiCopy(UiMessage.m_users_pay_value1_min_you_c2677afbbf, {'value1': (fmtTokens(perMinuteTokens(_rateTokens))).toString(), 'value2': (fmtTokens(creatorNetPerHour(_rateTokens))).toString()})
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
          ZineChip(label: m == 60 ? uiCopy(UiMessage.m_1_hour_f8b8883f0c) : uiCopy(UiMessage.m_m_min_b8b9f90dff, {'m': (m).toString()}), active: m == _sessionLimit, onTap: () => setState(() => _sessionLimit = m)),
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
          width: 22,
          height: 22,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: AD.card,
            border: Border.all(color: AD.borderControl, width: 1),
          ),
          child: sel
              ? Center(
                  child: Container(
                      width: 9, height: 9, decoration: const BoxDecoration(shape: BoxShape.circle, color: AD.primaryBadge)))
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

/// Local stand-in for Phase 3's `VisionPreviewPane(capability:, overlayStyle:)`.
/// Shows what the overlay/score will look like so the wizard compiles and gives
/// the creator a sense of the result before publishing. Phase Z replaces this
/// with the real on-device preview.
class _VisionPreviewPlaceholder extends StatelessWidget {
  final String capability;
  final String overlayStyle;
  final String? scoreLabel;
  const _VisionPreviewPlaceholder({required this.capability, required this.overlayStyle, this.scoreLabel});

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return Container(
      height: 168,
      decoration: BoxDecoration(
        color: AD.card,
        borderRadius: BorderRadius.circular(Msg.rLg),
        border: Border.all(color: AD.borderControl, width: 1),
        boxShadow: Msg.none,
      ),
      clipBehavior: Clip.antiAlias,
      child: Stack(children: [
        Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(PhosphorIcons.videoCamera(PhosphorIconsStyle.regular), size: 34, color: AD.textSecondary),
            const SizedBox(height: 8),
            UiText(UiMessage.m_live_camera_preview_c72d4eebf1, style: ADText.tabLabel(c: AD.textSecondary).copyWith(fontSize: 11, letterSpacing: 0.44)),
            const SizedBox(height: 2),
            Text(overlayStyle == 'none' ? capabilityLabel(capability) : '${overlayLabel(overlayStyle)} · ${capabilityLabel(capability)}',
                style: ADText.preview(c: AD.textTertiary).copyWith(fontSize: 12, height: 1.42)),
          ]),
        ),
        if (scoreLabel != null && scoreLabel!.isNotEmpty)
          Positioned(
            left: 10,
            top: 10,
            child: MiniPill('${scoreLabel!}  88', fill: AD.online, fg: Colors.white),
          ),
        Positioned(
          right: 10,
          bottom: 10,
          child: MiniPill('preview', fill: AD.tabCalls, fg: Colors.white, icon: PhosphorIcons.eye(PhosphorIconsStyle.regular)),
        ),
      ]),
    );
  }
}

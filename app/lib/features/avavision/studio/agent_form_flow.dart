import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/api_auth.dart';
import '../../../core/avavision_api.dart';
import '../../../core/config.dart';
import '../../../core/ui/zine.dart';
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
      text: widget.existing == null || widget.existing!.ratePerHourCoins == 0
          ? '20'
          : (widget.existing!.ratePerHourCoins / 100)
              .toStringAsFixed(widget.existing!.ratePerHourCoins % 100 == 0 ? 0 : 2));
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

  int get _rateCoins => ((double.tryParse(_rate.text.trim()) ?? 0) * 100).round();

  // Live always runs; "both" when the deep snapshot is also enabled.
  String get _visionMode => _agenticSnapshot ? 'both' : 'live';

  Map<String, dynamic> get _fields => {
        'template_id': _templateId,
        'name': _name.text.trim(),
        'role': _role.text.trim(),
        'system_profile': _profile.text.trim(),
        'voice_name': _voice,
        'images': _images,
        'rate_per_hour': _payerMode == 'creator_pays' ? 0 : _rateCoins,
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
          _snack('Pick a template to start your vision agent.');
          return false;
        }
      case 1:
        if (_name.text.trim().length < 2) {
          _snack('Give your agent a name.');
          return false;
        }
        if (_role.text.trim().isEmpty) {
          _snack('Describe the role (e.g. "Squat form coach").');
          return false;
        }
        if (_profile.text.trim().length < 30) {
          _snack('Tell your agent who it is and how to coach — at least a few sentences.');
          return false;
        }
      case 3:
        if (_scoringMode != 'none' && _scoreLabel.text.trim().isEmpty) {
          _snack('Name the on-screen score (e.g. "FormScore") or turn scoring off.');
          return false;
        }
      case 4:
        if (_payerMode == 'user_pays' && _rateCoins < 100) {
          _snack('Set a rate of at least \$1/hour.');
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
    if (!ok) _snack('Could not save — check your connection and try again.');
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
      _snack('Add at least one photo (up to 5) before publishing.');
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
      'rate_coins': _payerMode == 'creator_pays' ? 0 : _rateCoins,
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
                backgroundColor: Zine.card,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(18),
                    side: const BorderSide(color: Zine.ink, width: Zine.bw)),
                titleTextStyle: ZineText.cardTitle(size: 20),
                contentTextStyle: ZineText.sub(size: 14),
                title: const Text('🎉 Your vision agent is live!'),
                content: Text('${_name.text.trim()} is now in the AvaVision marketplace. '
                    'Check your dashboard each morning for sessions, scores and earnings.'),
                actions: [
                  TextButton(
                      onPressed: () {
                        Navigator.pop(d);
                        Navigator.pop(context, true);
                      },
                      child: const Text('Done'))
                ],
              ));
    } else {
      // Server returns {error:'VALIDATION', field, detail} — surface the detail.
      _snack(r['detail']?.toString() ?? r['error']?.toString() ?? 'Publish failed — saved as draft.');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: widget.existing == null ? 'New vision agent' : 'Edit ${widget.existing!.name}',
        markWord: 'vision',
        tag: 'creator studio · ${_step + 1} / $_stepCount',
      ),
      body: ZinePaper(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 18, 18, 32),
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
                    color: Zine.ink.withValues(alpha: 0.25),
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
                  padding: const EdgeInsets.symmetric(vertical: 5),
                  child: Text(_titles[i],
                      style: ZineText.cardTitle(color: state == _WizState.todo ? Zine.inkMute : Zine.ink)),
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
                                label: 'Publish',
                                icon: PhosphorIcons.rocketLaunch(PhosphorIconsStyle.bold),
                                fullWidth: true,
                                fontSize: 18,
                                loading: _working,
                                onPressed: _working ? null : _publish,
                              )
                            : ZineButton(
                                label: 'Continue',
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
                      const SizedBox(height: 14),
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
      _WizState.active => (Zine.lime, Zine.ink),
      _WizState.done => (Zine.ink, Zine.paper),
      _WizState.todo => (Zine.card, Zine.inkMute),
    };
    return Container(
      width: 34,
      height: 34,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: fill,
        border: Border.all(color: state == _WizState.todo ? Zine.inkMute : Zine.ink, width: Zine.bw),
        boxShadow: state == _WizState.active ? Zine.shadowXs : null,
      ),
      child: Center(
        child: state == _WizState.done
            ? PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), size: 16, color: fg)
            : Text('${i + 1}',
                style: TextStyle(
                    fontFamily: ZineText.display, fontWeight: FontWeight.w600, fontSize: 16, color: fg)),
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
        Text('Every vision agent starts from a use-case template — it sets the camera capability, '
            'the on-screen overlay and the score so you don\'t have to.',
            style: ZineText.sub(size: 13)),
        const SizedBox(height: 16),
        ZineButton(
          label: 'Choose a template',
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
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: Zine.paper2,
          borderRadius: BorderRadius.circular(Zine.rSm),
          border: Zine.border,
          boxShadow: Zine.shadowXs,
        ),
        child: Row(children: [
          ZineIconBadge(icon: PhosphorIcons.eye(PhosphorIconsStyle.bold), color: Zine.lilac, size: 40),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(_templateName.isEmpty ? _templateId : _templateName, style: ZineText.cardTitle(size: 16)),
              const SizedBox(height: 6),
              Wrap(spacing: 6, runSpacing: 6, children: [
                CapabilityBadge(_capability),
                if (_overlayEnabled) OverlayBadge(_overlayStyle),
                if (_scoringMode != 'none' && _scoreLabel.text.trim().isNotEmpty)
                  ScoreBadge(_scoreLabel.text.trim()),
              ]),
            ]),
          ),
        ]),
      ),
      const SizedBox(height: 10),
      ZineLink('change template', onTap: _chooseTemplate),
    ]);
  }

  // ── Step 1: identity ──────────────────────────────────────────────────
  Widget _stepIdentity() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ZineField(
          controller: _name,
          label: 'agent name',
          labelIcon: PhosphorIcons.eye(PhosphorIconsStyle.bold),
          hint: 'e.g. Coach Vega · Squat Form Pro',
          maxLength: 40,
          textCapitalization: TextCapitalization.words,
        ),
        const SizedBox(height: 16),
        ZineField(
          controller: _role,
          label: 'role it plays',
          labelIcon: PhosphorIcons.identificationBadge(PhosphorIconsStyle.bold),
          hint: 'e.g. Squat & deadlift form checker',
          maxLength: 80,
          textCapitalization: TextCapitalization.sentences,
        ),
        const SizedBox(height: 16),
        ZineField(
          controller: _profile,
          label: 'system profile — how should it coach?',
          labelIcon: PhosphorIcons.brain(PhosphorIconsStyle.bold),
          hint: 'Seeded from your template — edit the tone, the cues it gives, what to watch for…',
          maxLines: 8,
          maxLength: 4000,
          textCapitalization: TextCapitalization.sentences,
        ),
        const SizedBox(height: 8),
        Text(
          '💡 Platform safety rules (technique-only, no appearance scoring, camera consent) are added '
          'automatically and can\'t be edited. Time-keeping and polite wrap-up are handled for you.',
          style: ZineText.sub(size: 12),
        ),
        const SizedBox(height: 16),
        Text('LISTING PHOTOS (1–5)', style: ZineText.kicker()),
        const SizedBox(height: 9),
        Wrap(spacing: 12, runSpacing: 12, children: [
          for (var i = 0; i < _images.length; i++)
            Stack(clipBehavior: Clip.none, children: [
              Container(
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(Zine.rSm),
                  border: Zine.border,
                  boxShadow: Zine.shadowXs,
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
                      color: Zine.coral,
                      border: Border.all(color: Zine.ink, width: 2),
                    ),
                    child: const Icon(Icons.close, size: 14, color: Colors.white),
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
                  color: Zine.paper2,
                  borderRadius: BorderRadius.circular(Zine.rSm),
                  border: Border.all(color: Zine.ink.withValues(alpha: 0.45), width: 2),
                ),
                child: _imgUploading
                    ? const Center(
                        child: SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2, color: Zine.blueInk)))
                    : PhosphorIcon(PhosphorIcons.cameraPlus(PhosphorIconsStyle.bold), size: 26, color: Zine.inkSoft),
              ),
            ),
        ]),
        const SizedBox(height: 8),
        Text('At least one photo is required to publish. Shown on your marketplace card and agent page.',
            style: ZineText.sub(size: 11.5)),
      ]);

  // ── Step 2: voice ─────────────────────────────────────────────────────
  Widget _stepVoice() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(icon: PhosphorIcons.waveform(PhosphorIconsStyle.bold), color: Zine.lilac, size: 30),
          const SizedBox(width: 10),
          Expanded(child: Text('Choose how your coach sounds. Tap ▶ to hear a sample.', style: ZineText.sub(size: 13))),
        ]),
        const SizedBox(height: 14),
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
              Text('Show the ${overlayLabel(_overlayStyle).toLowerCase()} overlay', style: ZineText.value(size: 14.5)),
              const SizedBox(height: 3),
              Text('Draws a live ${overlayLabel(_overlayStyle).toLowerCase()} on the user\'s camera so they see exactly what to fix.',
                  style: ZineText.sub(size: 12)),
            ]),
          ),
          const SizedBox(width: 10),
          ZineToggle(value: _overlayEnabled, onChanged: (v) => setState(() => _overlayEnabled = v)),
        ]),
        const SizedBox(height: 18),
      ] else
        Padding(
          padding: const EdgeInsets.only(bottom: 18),
          child: Text('This capability reads the whole frame with AI — there\'s no on-screen overlay.',
              style: ZineText.sub(size: 12.5)),
        ),

      // Scoring
      Text('LIVE SCORE', style: ZineText.kicker()),
      const SizedBox(height: 9),
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (final m in scoringOpts)
          ZineChip(label: _scoringLabel(m), active: m == _scoringMode, onTap: () => setState(() => _scoringMode = m)),
      ]),
      if (_scoringMode != 'none') ...[
        const SizedBox(height: 12),
        ZineField(
          controller: _scoreLabel,
          label: 'score label',
          labelIcon: PhosphorIcons.gauge(PhosphorIconsStyle.bold),
          hint: 'e.g. FormScore',
          maxLength: 20,
          onChanged: (_) => setState(() {}),
        ),
      ],
      const SizedBox(height: 18),

      // Agentic snapshot
      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('"Analyze my form" deep snapshot', style: ZineText.value(size: 14.5)),
            const SizedBox(height: 3),
            Text('Lets the user tap once for a precise, pixel-grounded breakdown of a single hi-res frame. '
                'Bundled into the session cost.',
                style: ZineText.sub(size: 12)),
          ]),
        ),
        const SizedBox(width: 10),
        ZineToggle(value: _agenticSnapshot, onChanged: (v) => setState(() => _agenticSnapshot = v)),
      ]),
      if (_agenticSnapshot) ...[
        const SizedBox(height: 12),
        Text('FREE SNAPSHOTS PER SESSION', style: ZineText.kicker()),
        const SizedBox(height: 9),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final n in _freeSnapshotChoices)
            ZineChip(label: '$n', active: n == _freeSnapshots, onTap: () => setState(() => _freeSnapshots = n)),
        ]),
      ],
      const SizedBox(height: 18),

      // Save snapshots — OFF by default (master §10 / platform safety default).
      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Save snapshots to the agent', style: ZineText.value(size: 14.5)),
            const SizedBox(height: 3),
            Text('Off by default. Snapshots are analyzed and discarded unless you keep them. Keep off unless you have a clear reason.',
                style: ZineText.sub(size: 12)),
          ]),
        ),
        const SizedBox(width: 10),
        ZineToggle(value: _saveSnapshots, onChanged: (v) => setState(() => _saveSnapshots = v)),
      ]),

      // Platform-enforced safety notes (read-only).
      if (_safetyNotes.isNotEmpty) ...[
        const SizedBox(height: 18),
        Text('PLATFORM SAFETY (ENFORCED)', style: ZineText.kicker()),
        const SizedBox(height: 9),
        Wrap(spacing: 6, runSpacing: 6, children: [
          for (final s in _safetyNotes)
            MiniPill(s.replaceAll('_', ' '),
                fill: Zine.paper2, fg: Zine.inkSoft, icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold), shadow: false),
        ]),
      ],
      // Platform availability for the chosen capability.
      const SizedBox(height: 14),
      Row(children: [
        PhosphorIcon(PhosphorIcons.monitor(PhosphorIconsStyle.bold), size: 16, color: Zine.inkSoft),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            _capSupportsIos(_capability)
                ? 'Runs on Android, iOS and Web.'
                : 'Runs on Android and Web (no free iOS engine for this capability yet).',
            style: ZineText.sub(size: 12),
          ),
        ),
      ]),
    ]);
  }

  // ── Step 4: pricing & publish ─────────────────────────────────────────
  Widget _stepPricing() {
    final userPays = _payerMode == 'user_pays';
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('WHO PAYS FOR SESSIONS?', style: ZineText.kicker()),
      const SizedBox(height: 9),
      _payerCard('user_pays', 'Users pay you',
          'You set an hourly rate. Users are billed per minute; you earn 50% after the platform fee.'),
      const SizedBox(height: 10),
      _payerCard('creator_pays', 'You cover the sessions (free for users)',
          'Great for brand/clinic coaches. You pay a flat ${fmtCoins(kCreatorPaysRateCoinsPerHour)}/hour of session time from your AvaWallet. Snapshots are bundled in.'),
      const SizedBox(height: 18),
      if (userPays) ...[
        ZineField(
          controller: _rate,
          label: 'your hourly rate (usd)',
          labelIcon: PhosphorIcons.coins(PhosphorIconsStyle.bold),
          leadText: r'$',
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 10),
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Zine.mint,
            borderRadius: BorderRadius.circular(Zine.rSm),
            border: Zine.border,
            boxShadow: Zine.shadowXs,
          ),
          child: Row(children: [
            PhosphorIcon(PhosphorIcons.wallet(PhosphorIconsStyle.bold), size: 18, color: Zine.ink),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                _rateCoins >= 100
                    ? 'Users pay ${fmtCoins(perMinuteCoins(_rateCoins))}/min · You earn ${fmtCoins(creatorNetPerHour(_rateCoins))}/hr after the 50% platform fee'
                    : 'Enter your hourly rate to see what you\'ll earn',
                style: ZineText.value(size: 12.5),
              ),
            ),
          ]),
        ),
        const SizedBox(height: 18),
      ],
      Text('MAXIMUM SESSION LENGTH', style: ZineText.kicker()),
      const SizedBox(height: 4),
      Text('Your agent works toward a polite close as this limit approaches. 1 hour is the platform maximum.',
          style: ZineText.sub(size: 12)),
      const SizedBox(height: 9),
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (final m in kSessionLimitChoices)
          ZineChip(label: m == 60 ? '1 hour' : '$m min', active: m == _sessionLimit, onTap: () => setState(() => _sessionLimit = m)),
      ]),
    ]);
  }

  Widget _payerCard(String mode, String title, String body) {
    final sel = _payerMode == mode;
    return ZinePressable(
      onTap: () => setState(() => _payerMode = mode),
      color: sel ? Zine.blue : Zine.card,
      radius: BorderRadius.circular(Zine.rSm),
      boxShadow: sel ? Zine.shadowSm : const <BoxShadow>[],
      padding: const EdgeInsets.all(14),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          width: 22,
          height: 22,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: Zine.card,
            border: Border.all(color: Zine.ink, width: Zine.bw),
          ),
          child: sel
              ? Center(
                  child: Container(
                      width: 9, height: 9, decoration: const BoxDecoration(shape: BoxShape.circle, color: Zine.ink)))
              : null,
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ZineText.cardTitle(size: 15.5)),
            const SizedBox(height: 3),
            Text(body, style: ZineText.sub(size: 12, color: sel ? Zine.ink : Zine.inkSoft)),
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
    return Container(
      height: 168,
      decoration: BoxDecoration(
        color: Zine.ink,
        borderRadius: BorderRadius.circular(Zine.rSm),
        border: Zine.border,
        boxShadow: Zine.shadowXs,
      ),
      clipBehavior: Clip.antiAlias,
      child: Stack(children: [
        Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(PhosphorIcons.videoCamera(PhosphorIconsStyle.bold), size: 34, color: Zine.paper2),
            const SizedBox(height: 8),
            Text('LIVE CAMERA PREVIEW', style: ZineText.tag(size: 10.5, color: Zine.paper2)),
            const SizedBox(height: 2),
            Text(overlayStyle == 'none' ? capabilityLabel(capability) : '${overlayLabel(overlayStyle)} · ${capabilityLabel(capability)}',
                style: ZineText.sub(size: 11.5, color: Zine.inkMute)),
          ]),
        ),
        if (scoreLabel != null && scoreLabel!.isNotEmpty)
          Positioned(
            left: 10,
            top: 10,
            child: MiniPill('${scoreLabel!}  88', fill: Zine.mint, fg: Zine.ink),
          ),
        Positioned(
          right: 10,
          bottom: 10,
          child: MiniPill('preview', fill: Zine.lilac, fg: Zine.ink, icon: PhosphorIcons.eye(PhosphorIconsStyle.bold)),
        ),
      ]),
    );
  }
}

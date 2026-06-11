import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/api_auth.dart';
import '../../../core/avavoice_api.dart';
import '../../../core/config.dart';
import '../../../core/ui/zine.dart';
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
      text: widget.existing == null || widget.existing!.ratePerHourCoins == 0
          ? '20'
          : (widget.existing!.ratePerHourCoins / 100).toStringAsFixed(
              widget.existing!.ratePerHourCoins % 100 == 0 ? 0 : 2));
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

  int get _rateCoins => ((double.tryParse(_rate.text.trim()) ?? 0) * 100).round();

  Map<String, dynamic> get _fields => {
        'name': _name.text.trim(),
        'role': _role.text.trim(),
        'system_profile': _profile.text.trim(),
        'voice_name': _voice,
        'images': _images,
        'rate_per_hour': _payerMode == 'creator_pays' ? 0 : _rateCoins,
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
        if (_name.text.trim().length < 2) { _snack('Give your agent a name.'); return false; }
        if (_role.text.trim().isEmpty) { _snack('Describe the role (e.g. "Mock job interviewer").'); return false; }
        if (_profile.text.trim().length < 30) {
          _snack('Tell your agent who it is and what\'s expected — at least a few sentences.');
          return false;
        }
      case 3:
        if (_payerMode == 'user_pays' && _rateCoins < 100) {
          _snack('Set a rate of at least \$1/hour.');
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
    if (!ok) _snack('Could not save — check your connection and try again.');
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
      _snack('Add at least one photo (up to 5) before publishing.');
      return;
    }
    if (!await _save()) return;
    setState(() => _working = true);
    final r = await AvaVoiceApi.publish(_agentId!);
    if (!mounted) return;
    setState(() => _working = false);
    Analytics.capture('avavoice_publish_result', {
      'agent': _agentId ?? '', 'ok': r.isEmpty, 'payer_mode': _payerMode,
      'rate_coins': _payerMode == 'creator_pays' ? 0 : _rateCoins,
      'session_limit': _sessionLimit, 'vision': _vision, 'files': _files.length,
      'voice': _voice,
    });
    if (r.isEmpty) {
      showDialog(context: context, builder: (d) => AlertDialog(
        backgroundColor: Zine.card,
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(18),
            side: const BorderSide(color: Zine.ink, width: Zine.bw)),
        titleTextStyle: ZineText.cardTitle(size: 20),
        contentTextStyle: ZineText.sub(size: 14),
        title: const Text('🎉 Your agent is live!'),
        content: Text('${_name.text.trim()} is now in the AvaVoice marketplace. '
            'Check your dashboard each morning for bookings, calls and earnings.'),
        actions: [TextButton(
            onPressed: () { Navigator.pop(d); Navigator.pop(context, true); },
            child: const Text('Done'))],
      ));
    } else {
      _snack(r['detail']?.toString() ?? r['error']?.toString() ?? 'Publish failed — saved as draft.');
    }
  }

  Future<void> _addFile() async {
    if (_agentId == null && !await _save()) return;
    final picked = await FilePicker.platform.pickFiles(withData: true, type: FileType.custom,
        allowedExtensions: ['pdf', 'doc', 'docx', 'txt', 'md', 'csv', 'json', 'html', 'xlsx', 'pptx']);
    final f = picked?.files.firstOrNull;
    if (f == null || f.bytes == null) return;
    if (f.size > 25 * 1024 * 1024) { _snack('Max file size is 25 MB.'); return; }
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
    if (rec == null) _snack('Upload failed — try again.');
  }

  Future<void> _removeFile(AgentBrainFile f) async {
    if (_agentId == null) return;
    if (await AvaVoiceApi.deleteBrainFile(_agentId!, f.id)) {
      setState(() => _files.removeWhere((x) => x.id == f.id));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: widget.existing == null ? 'New voice agent' : 'Edit ${widget.existing!.name}',
        markWord: 'voice',
        tag: 'creator studio · ${_step + 1} / 4',
      ),
      body: ZinePaper(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 18, 18, 32),
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
                child: Container(width: 2.5, color: Zine.ink.withValues(alpha: 0.25),
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
                  padding: const EdgeInsets.symmetric(vertical: 5),
                  child: Text(_titles[i],
                      style: ZineText.cardTitle(
                          color: state == _WizState.todo ? Zine.inkMute : Zine.ink)),
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
                    if (i == 3) ...[
                      const SizedBox(height: 14),
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
      _WizState.active => (Zine.lime, Zine.ink),
      _WizState.done => (Zine.ink, Zine.paper),
      _WizState.todo => (Zine.card, Zine.inkMute),
    };
    return Container(
      width: 34, height: 34,
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
                style: TextStyle(fontFamily: ZineText.display, fontWeight: FontWeight.w600,
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
          label: 'agent name',
          labelIcon: PhosphorIcons.robot(PhosphorIconsStyle.bold),
          hint: 'e.g. Ava the Interview Coach',
          maxLength: 40,
          textCapitalization: TextCapitalization.words,
        ),
        const SizedBox(height: 16),
        ZineField(
          controller: _role,
          label: 'role it plays',
          labelIcon: PhosphorIcons.identificationBadge(PhosphorIconsStyle.bold),
          hint: 'e.g. Mock US-visa interviewer · Tech support',
          maxLength: 80,
          textCapitalization: TextCapitalization.sentences,
        ),
        const SizedBox(height: 16),
        ZineField(
          controller: _profile,
          label: 'system profile — who is this agent?',
          labelIcon: PhosphorIcons.brain(PhosphorIconsStyle.bold),
          hint: 'You are a friendly but rigorous job-interview coach. Greet the caller, ask about the role they\'re applying for, then run a realistic mock interview with follow-up questions. End with constructive feedback…',
          maxLines: 7,
          maxLength: 4000,
          textCapitalization: TextCapitalization.sentences,
        ),
        const SizedBox(height: 8),
        Text(
          '💡 The better you describe the personality, tone and tasks, the better your agent performs. Time-keeping and polite wrap-up are handled automatically by the platform.',
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
                right: -7, top: -7,
                child: GestureDetector(
                  onTap: () => setState(() => _images.removeAt(i)),
                  child: Container(
                    width: 26, height: 26,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle, color: Zine.coral,
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
                width: 88, height: 88,
                decoration: BoxDecoration(
                  color: Zine.paper2,
                  borderRadius: BorderRadius.circular(Zine.rSm),
                  border: Border.all(color: Zine.ink.withValues(alpha: 0.45), width: 2),
                ),
                child: _imgUploading
                    ? const Center(child: SizedBox(width: 20, height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Zine.blueInk)))
                    : PhosphorIcon(PhosphorIcons.cameraPlus(PhosphorIconsStyle.bold),
                        size: 26, color: Zine.inkSoft),
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
          ZineIconBadge(
              icon: PhosphorIcons.waveform(PhosphorIconsStyle.bold),
              color: Zine.lilac, size: 30),
          const SizedBox(width: 10),
          Expanded(
            child: Text('Choose how your agent sounds. Tap ▶ to hear a sample.',
                style: ZineText.sub(size: 13)),
          ),
        ]),
        const SizedBox(height: 14),
        VoicePicker(selected: _voice, onSelected: (v) => setState(() => _voice = v)),
      ]);

  // ── Step 3: brain files ───────────────────────────────────────────────
  Widget _stepBrain() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(
          'Upload documents your agent should know — FAQs, scripts, product info, schedules. During calls it consults these files to answer accurately instead of guessing.',
          style: ZineText.sub(size: 13),
        ),
        const SizedBox(height: 16),
        ZineButton(
          label: _uploading ? 'Uploading…' : 'Add knowledge file',
          variant: ZineButtonVariant.blue,
          icon: PhosphorIcons.uploadSimple(PhosphorIconsStyle.bold),
          trailingIcon: false,
          fontSize: 16,
          loading: _uploading,
          onPressed: _uploading ? null : _addFile,
        ),
        const SizedBox(height: 14),
        if (_files.isEmpty)
          Text('No files yet — that\'s OK, you can add them anytime. Agents work without files too.',
              style: ZineText.sub(size: 12))
        else
          for (final f in _files)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Container(
                padding: const EdgeInsets.fromLTRB(12, 10, 10, 10),
                decoration: BoxDecoration(
                  color: Zine.card,
                  borderRadius: BorderRadius.circular(Zine.rSm),
                  border: Zine.border,
                  boxShadow: Zine.shadowXs,
                ),
                child: Row(children: [
                  ZineIconBadge(
                      icon: PhosphorIcons.fileText(PhosphorIconsStyle.bold),
                      color: Zine.lilac, size: 30),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(f.filename, maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: ZineText.value(size: 13.5)),
                      const SizedBox(height: 2),
                      Text(f.indexed ? 'INDEXED — READY' : 'INDEXING…',
                          style: ZineText.tag(size: 10,
                              color: f.indexed ? Zine.mintInk : Zine.inkSoft)),
                    ]),
                  ),
                  const SizedBox(width: 8),
                  GestureDetector(
                    onTap: () => _removeFile(f),
                    child: Container(
                      width: 28, height: 28,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: Zine.card,
                        border: Border.all(color: Zine.ink, width: 2),
                      ),
                      child: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold),
                          size: 13, color: Zine.ink),
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
      Text('WHO PAYS FOR CALLS?', style: ZineText.kicker()),
      const SizedBox(height: 9),
      _payerCard('user_pays', 'Callers pay you',
          'You set an hourly rate. Callers are billed per minute; you earn 50% after the platform fee.'),
      const SizedBox(height: 10),
      _payerCard('creator_pays', 'You cover the calls (free for callers)',
          'Great for business agents — receptionists, support lines. You pay a flat ${fmtCoins(kCreatorPaysRateCoinsPerHour)}/hour of talk time from your AvaWallet.'),
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
        // "You earn" math — mint (money accent).
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Zine.mint,
            borderRadius: BorderRadius.circular(Zine.rSm),
            border: Zine.border,
            boxShadow: Zine.shadowXs,
          ),
          child: Row(children: [
            PhosphorIcon(PhosphorIcons.wallet(PhosphorIconsStyle.bold),
                size: 18, color: Zine.ink),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                _rateCoins >= 100
                    ? 'Callers pay ${fmtCoins(perMinuteCoins(_rateCoins))}/min · You earn ${fmtCoins(creatorNetPerHour(_rateCoins))}/hr after the 50% platform fee'
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
          ZineChip(
            label: m == 60 ? '1 hour' : '$m min',
            active: m == _sessionLimit,
            onTap: () => setState(() => _sessionLimit = m),
          ),
      ]),
      const SizedBox(height: 18),
      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Vision (screen & camera)', style: ZineText.value(size: 14.5)),
            const SizedBox(height: 3),
            Text(
                'Let callers share their screen or camera so the agent can see and help — e.g. step-by-step tech support.',
                style: ZineText.sub(size: 12)),
          ]),
        ),
        const SizedBox(width: 10),
        ZineToggle(value: _vision, onChanged: (v) => setState(() => _vision = v)),
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
          width: 22, height: 22,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: Zine.card,
            border: Border.all(color: Zine.ink, width: Zine.bw),
          ),
          child: sel
              ? Center(
                  child: Container(width: 9, height: 9,
                      decoration: const BoxDecoration(shape: BoxShape.circle, color: Zine.ink)))
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

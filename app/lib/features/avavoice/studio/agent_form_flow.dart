import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../../../core/avavoice_api.dart';
import '../../../core/theme.dart';
import '../widgets.dart';
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
    if (_step < 3) {
      setState(() => _step++);
    } else {
      Navigator.pop(context, true); // saved as draft
    }
  }

  Future<void> _publish() async {
    if (!_validStep() || _working) return;
    if (!await _save()) return;
    setState(() => _working = true);
    final r = await AvaVoiceApi.publish(_agentId!);
    if (!mounted) return;
    setState(() => _working = false);
    if (r.isEmpty) {
      showDialog(context: context, builder: (d) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
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
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink,
        title: Text(widget.existing == null ? 'New voice agent' : 'Edit ${widget.existing!.name}'),
      ),
      body: Column(children: [
        // Step header.
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: List.generate(4, (i) => Expanded(
              child: Container(
                height: 4,
                margin: EdgeInsets.only(right: i < 3 ? 6 : 0),
                decoration: BoxDecoration(
                    color: i <= _step ? kAvaVoicePurple : AvaColors.line,
                    borderRadius: BorderRadius.circular(4)),
              ),
            ))),
            const SizedBox(height: 14),
            Text('Step ${_step + 1} of 4',
                style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: AvaColors.sub)),
            const SizedBox(height: 2),
            Text(_titles[_step],
                style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 19)),
          ]),
        ),
        Expanded(child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
          child: switch (_step) {
            0 => _stepIdentity(),
            1 => _stepVoice(),
            2 => _stepBrain(),
            _ => _stepPricing(),
          },
        )),
        _footer(),
      ]),
    );
  }

  // ── Step 1: identity ──────────────────────────────────────────────────
  Widget _stepIdentity() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _label('Agent name'),
        TextField(controller: _name, maxLength: 40,
            decoration: _dec('e.g. Ava the Interview Coach')),
        const SizedBox(height: 8),
        _label('Role it plays'),
        TextField(controller: _role, maxLength: 80,
            decoration: _dec('e.g. Mock US-visa interviewer · Tech support · Receptionist')),
        const SizedBox(height: 8),
        _label('System profile — who is this agent and what\'s expected?'),
        TextField(
          controller: _profile, minLines: 6, maxLines: 12, maxLength: 4000,
          decoration: _dec(
              'You are a friendly but rigorous job-interview coach. Greet the caller, ask about the role they\'re applying for, then run a realistic mock interview with follow-up questions. End with constructive feedback…'),
        ),
        const SizedBox(height: 4),
        const Text(
          '💡 The better you describe the personality, tone and tasks, the better your agent performs. Time-keeping and polite wrap-up are handled automatically by the platform.',
          style: TextStyle(fontSize: 12, color: AvaColors.sub, height: 1.4),
        ),
      ]);

  // ── Step 2: voice ─────────────────────────────────────────────────────
  Widget _stepVoice() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text('Choose how your agent sounds. Tap ▶ to hear a sample.',
            style: TextStyle(fontSize: 13, color: AvaColors.sub)),
        const SizedBox(height: 14),
        VoicePicker(selected: _voice, onSelected: (v) => setState(() => _voice = v)),
      ]);

  // ── Step 3: brain files ───────────────────────────────────────────────
  Widget _stepBrain() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text(
          'Upload documents your agent should know — FAQs, scripts, product info, schedules. During calls it consults these files to answer accurately instead of guessing.',
          style: TextStyle(fontSize: 13, color: AvaColors.sub, height: 1.45),
        ),
        const SizedBox(height: 16),
        OutlinedButton.icon(
          style: OutlinedButton.styleFrom(
            foregroundColor: kAvaVoicePurple,
            side: const BorderSide(color: kAvaVoicePurple),
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          ),
          onPressed: _uploading ? null : _addFile,
          icon: _uploading
              ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
              : const Icon(Icons.upload_file),
          label: Text(_uploading ? 'Uploading…' : 'Add knowledge file',
              style: const TextStyle(fontWeight: FontWeight.w800)),
        ),
        const SizedBox(height: 14),
        if (_files.isEmpty)
          const Text('No files yet — that\'s OK, you can add them anytime. Agents work without files too.',
              style: TextStyle(fontSize: 12, color: AvaColors.sub))
        else
          ..._files.map((f) => ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.description_outlined, color: kAvaVoicePurple),
                title: Text(f.filename, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5)),
                subtitle: Text(
                    f.indexed ? 'Indexed — ready' : 'Indexing…',
                    style: TextStyle(fontSize: 11.5,
                        color: f.indexed ? AvaColors.success : AvaColors.sub)),
                trailing: IconButton(icon: const Icon(Icons.close, size: 18),
                    onPressed: () => _removeFile(f)),
              )),
      ]);

  // ── Step 4: pricing & publish ─────────────────────────────────────────
  Widget _stepPricing() {
    final userPays = _payerMode == 'user_pays';
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _label('Who pays for calls?'),
      _payerCard('user_pays', 'Callers pay you',
          'You set an hourly rate. Callers are billed per minute; you earn 50% after the platform fee.'),
      const SizedBox(height: 8),
      _payerCard('creator_pays', 'You cover the calls (free for callers)',
          'Great for business agents — receptionists, support lines. You pay a flat ${fmtCoins(kCreatorPaysRateCoinsPerHour)}/hour of talk time from your AvaWallet.'),
      const SizedBox(height: 18),
      if (userPays) ...[
        _label('Your hourly rate (USD)'),
        TextField(
          controller: _rate,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: _dec('20').copyWith(prefixText: '\$ ', suffixText: '/hour'),
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 6),
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
              color: AvaColors.soft, borderRadius: BorderRadius.circular(12)),
          child: Row(children: [
            const Icon(Icons.account_balance_wallet_outlined, size: 18, color: kAvaVoicePurple),
            const SizedBox(width: 10),
            Expanded(child: Text(
              _rateCoins >= 100
                  ? 'Callers pay ${fmtCoins(perMinuteCoins(_rateCoins))}/min · You earn ${fmtCoins(creatorNetPerHour(_rateCoins))}/hr after the 50% platform fee'
                  : 'Enter your hourly rate to see what you\'ll earn',
              style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700),
            )),
          ]),
        ),
        const SizedBox(height: 18),
      ],
      _label('Maximum session length'),
      const Text('Your agent works toward a polite close as this limit approaches. 1 hour is the platform maximum.',
          style: TextStyle(fontSize: 12, color: AvaColors.sub)),
      const SizedBox(height: 8),
      Wrap(spacing: 8, children: kSessionLimitChoices.map((m) {
        final sel = m == _sessionLimit;
        return ChoiceChip(
          label: Text(m == 60 ? '1 hour' : '$m min'),
          selected: sel,
          selectedColor: kAvaVoicePurple.withValues(alpha: .15),
          labelStyle: TextStyle(fontWeight: FontWeight.w800,
              color: sel ? kAvaVoicePurple : AvaColors.sub),
          onSelected: (_) => setState(() => _sessionLimit = m),
        );
      }).toList()),
      const SizedBox(height: 18),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        activeTrackColor: kAvaVoicePurple,
        title: const Text('Vision (screen & camera)',
            style: TextStyle(fontWeight: FontWeight.w800, fontSize: 14)),
        subtitle: const Text(
            'Let callers share their screen or camera so the agent can see and help — e.g. step-by-step tech support.',
            style: TextStyle(fontSize: 12, color: AvaColors.sub)),
        value: _vision,
        onChanged: (v) => setState(() => _vision = v),
      ),
    ]);
  }

  Widget _payerCard(String mode, String title, String body) {
    final sel = _payerMode == mode;
    return InkWell(
      onTap: () => setState(() => _payerMode = mode),
      borderRadius: BorderRadius.circular(14),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          border: Border.all(color: sel ? kAvaVoicePurple : AvaColors.line, width: sel ? 2 : 1),
          borderRadius: BorderRadius.circular(14),
          color: sel ? kAvaVoicePurple.withValues(alpha: .05) : null,
        ),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(sel ? Icons.radio_button_checked : Icons.radio_button_off,
              color: sel ? kAvaVoicePurple : AvaColors.sub, size: 20),
          const SizedBox(width: 10),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14)),
            const SizedBox(height: 3),
            Text(body, style: const TextStyle(fontSize: 12, color: AvaColors.sub, height: 1.4)),
          ])),
        ]),
      ),
    );
  }

  Widget _footer() => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
          child: Row(children: [
            if (_step > 0)
              TextButton(
                onPressed: _working ? null : () => setState(() => _step--),
                child: const Text('Back', style: TextStyle(fontWeight: FontWeight.w800)),
              ),
            const Spacer(),
            if (_step == 3) ...[
              OutlinedButton(
                style: OutlinedButton.styleFrom(
                  foregroundColor: kAvaVoicePurple,
                  side: const BorderSide(color: kAvaVoicePurple),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                ),
                onPressed: _working ? null : _next,
                child: const Text('Save draft', style: TextStyle(fontWeight: FontWeight.w800)),
              ),
              const SizedBox(width: 10),
              FilledButton.icon(
                style: FilledButton.styleFrom(
                    backgroundColor: kAvaVoicePurple,
                    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12)),
                onPressed: _working ? null : _publish,
                icon: _working
                    ? const SizedBox(width: 16, height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : const Icon(Icons.rocket_launch_outlined, size: 18),
                label: const Text('Publish', style: TextStyle(fontWeight: FontWeight.w800)),
              ),
            ] else
              FilledButton(
                style: FilledButton.styleFrom(
                    backgroundColor: kAvaVoicePurple,
                    padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 12)),
                onPressed: _working ? null : _next,
                child: _working
                    ? const SizedBox(width: 16, height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : const Text('Continue', style: TextStyle(fontWeight: FontWeight.w800)),
              ),
          ]),
        ),
      );

  Widget _label(String t) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text(t, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 13.5)),
      );

  InputDecoration _dec(String hint) => InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(fontSize: 13, color: AvaColors.sub),
        filled: true, fillColor: AvaColors.soft,
        border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
      );
}

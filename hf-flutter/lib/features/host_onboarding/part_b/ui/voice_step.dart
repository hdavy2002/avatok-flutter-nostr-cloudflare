import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/api_error.dart';
import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';
import '../../../kyc/kyc.dart';
import '../../flow/onboarding_context.dart';
import '../data/edit_lock.dart';
import '../data/host_setup_api.dart';
import '../data/part_b_rules.dart';
import '../data/part_b_telemetry.dart';
import '../data/voice_audio.dart';
import '../data/voice_scripts.dart';
import 'part_b_copy.dart';
import 'part_b_widgets.dart';
import 'voice_recorder_panel.dart';

/// Step `voice`: the host records their OWN introduction, 30 seconds to 5 minutes (about a minute is suggested).
/// No voice copying and no AI voice. A person on our team listens before it plays on the card and the profile.
///
/// - Hindi and English example scripts, tips and the "please do not say" note (copied from the website).
/// - The recorder is wrapped in `PermissionGate` for the microphone (explainer, Android prompt, "Open settings").
/// - Too short and too long are blocked on the phone; the worker's message shows if it refuses anyway.
/// - After saving, the review state shows kindly: waiting for our team, approved, or "please record it again"
///   (our team found something to fix: for example a phone number said out loud). A live host may record again.
class VoiceStep extends ConsumerStatefulWidget {
  const VoiceStep({super.key, required this.ctx});

  final OnboardingStepContext ctx;

  @override
  ConsumerState<VoiceStep> createState() => _VoiceStepState();
}

class _VoiceStepState extends ConsumerState<VoiceStep> {
  bool _replacing = false;
  late bool _consent;
  String? _localPath;
  bool _busy = false;

  OnboardingStepContext get ctx => widget.ctx;

  int get _savedSeconds {
    final n = ctx.state.hostMap('voice')['seconds'];
    return n is num ? n.toInt() : 0;
  }

  String? get _savedStatus {
    final s = (ctx.state.hostMap('voice')['status'] ?? '').toString();
    return s.isEmpty ? null : s;
  }

  bool get _hasSaved => _savedSeconds > 0;

  @override
  void initState() {
    super.initState();
    _consent = _hasSaved;
  }

  Future<void> _onSaved(VoiceClip clip, VoiceSaved saved) async {
    _localPath = clip.path;
    try {
      await ctx.refresh();
    } on ApiError {
      // saved on the server; Continue reads it again
    }
    if (!mounted) return;
    setState(() => _replacing = false);
  }

  Future<void> _continue() async {
    if (_busy) return;
    setState(() => _busy = true);
    OnboardingTelemetry.step('voice', 'ok');
    await ctx.next();
    if (mounted) setState(() => _busy = false);
  }

  String _statusText(String? status) {
    switch (status) {
      case 'approved':
        return PartBCopy.voiceStatusApproved;
      case 'rejected':
        return PartBCopy.voiceStatusRejected;
      default:
        return PartBCopy.voiceStatusPending;
    }
  }

  @override
  Widget build(BuildContext context) {
    final lock = EditLock.of(ctx.state.hostStatus);
    final locked = lock.voiceLocked;
    final banner = lock.banner(editableWhenLive: true);
    final status = _savedStatus;
    final showSaved = _hasSaved && !_replacing;
    final rejected = status == 'rejected';
    final canContinue = (_hasSaved && !_replacing && !rejected) || locked;
    return PartBStep(
      title: PartBCopy.voiceTitle,
      lead: PartBCopy.voiceLead,
      bottom: [
        const SizedBox(height: 4),
        HfButton(
          key: const ValueKey<String>('voice-continue'),
          label: PartBCopy.continueLabel,
          loading: _busy,
          onPressed: canContinue ? _continue : null,
        ),
      ],
      children: [
        if (banner != null) LockBanner(banner),
        const _IdeasCard(),
        const SizedBox(height: 16),
        if (showSaved) _savedCard(status, locked) else if (!locked) _recorderCard(),
        const SizedBox(height: 12),
        ConsentRow(
          key: const ValueKey<String>('voice-consent'),
          value: _consent,
          text: PartBCopy.voiceConsent,
          onChanged: locked ? null : (v) => setState(() => _consent = v),
        ),
      ],
    );
  }

  Widget _savedCard(String? status, bool locked) {
    final fetcher = ref.read(ownVoiceFetcherProvider);
    final local = _localPath;
    final Future<String?> Function() load = local != null ? () async => local : fetcher.fetchToFile;
    return HfCard(
      key: const ValueKey<String>('voice-saved'),
      color: HfColors.lilac,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const DoneRow(PartBCopy.voiceSavedTitle),
          const SizedBox(height: 10),
          Text(_statusText(status), key: const ValueKey<String>('voice-status'), style: HfText.bodyText),
          const SizedBox(height: 6),
          const Text(PartBCopy.voiceChecked, style: HfText.note),
          const SizedBox(height: 6),
          Text(PartBCopy.voiceLength(mmss(_savedSeconds)), style: HfText.note),
          const SizedBox(height: 12),
          ClipPlayerBar(
            loadPath: load,
            knownSeconds: _savedSeconds,
          ),
          if (!locked) ...[
            const SizedBox(height: 12),
            HfButton(
              key: const ValueKey<String>('voice-record-again'),
              label: PartBCopy.voiceRecordAgain,
              kind: HfButtonKind.secondary,
              onPressed: () => setState(() => _replacing = true),
            ),
          ],
        ],
      ),
    );
  }

  Widget _recorderCard() {
    return HfCard(
      key: const ValueKey<String>('voice-recorder'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          PermissionGate(
            permissions: const <HfPermission>[HfPermission.mic],
            icon: Icons.mic_rounded,
            title: KycCopy.micTitle,
            body: KycCopy.micWhy,
            child: VoiceRecorderPanel(consent: _consent, onSaved: _onSaved),
          ),
          if (_hasSaved && _replacing)
            HfButton(
              key: const ValueKey<String>('voice-keep-saved'),
              label: PartBCopy.voiceKeepSaved,
              kind: HfButtonKind.text,
              onPressed: () => setState(() => _replacing = false),
            ),
        ],
      ),
    );
  }
}

/// "What can I say?": Hindi and English example scripts, tips and what not to say.
class _IdeasCard extends StatefulWidget {
  const _IdeasCard();

  @override
  State<_IdeasCard> createState() => _IdeasCardState();
}

class _IdeasCardState extends State<_IdeasCard> {
  String _lang = 'hi';

  @override
  Widget build(BuildContext context) {
    final set = kVoiceScripts.firstWhere((s) => s.code == _lang, orElse: () => kVoiceScripts.first);
    return HfCard(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Theme(
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          key: const ValueKey<String>('voice-ideas'),
          title: const Text(PartBCopy.voiceIdeasTitle, style: HfText.subtitle),
          tilePadding: const EdgeInsets.symmetric(horizontal: 8),
          childrenPadding: const EdgeInsets.fromLTRB(8, 0, 8, 12),
          expandedCrossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Wrap(
              spacing: 8,
              children: [
                for (final s in kVoiceScripts)
                  HfChip(
                    key: ValueKey<String>('voice-lang-${s.code}'),
                    label: s.label,
                    selected: _lang == s.code,
                    onTap: () => setState(() => _lang = s.code),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            for (final t in set.items)
              Container(
                width: double.infinity,
                margin: const EdgeInsets.only(bottom: 10),
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(color: HfColors.butter, borderRadius: BorderRadius.circular(HfRadius.card)),
                child: Text(t, style: HfText.bodyText),
              ),
            const SizedBox(height: 4),
            const Text(PartBCopy.voiceTips, style: HfText.bodyStrong),
            const SizedBox(height: 4),
            for (final tip in PartBCopy.voiceTipItems)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Padding(
                      padding: EdgeInsets.only(top: 3, right: 8),
                      child: Icon(Icons.check_rounded, size: 20, color: HfColors.orchid),
                    ),
                    Expanded(child: Text(tip, style: HfText.bodyText)),
                  ],
                ),
              ),
            const SizedBox(height: 8),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(color: HfColors.blush, borderRadius: BorderRadius.circular(HfRadius.card)),
              child: Text.rich(
                TextSpan(
                  children: [
                    TextSpan(text: '${PartBCopy.voiceDontsTitle}: ', style: HfText.bodyStrong),
                    const TextSpan(text: PartBCopy.voiceDonts, style: HfText.bodyText),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

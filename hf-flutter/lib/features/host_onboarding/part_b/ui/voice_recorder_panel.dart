import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/api_error.dart';
import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';
import '../../../kyc/kyc.dart';
import '../data/host_setup_api.dart';
import '../data/part_b_rules.dart';
import '../data/part_b_telemetry.dart';
import '../data/voice_audio.dart';
import 'part_b_copy.dart';
import 'part_b_widgets.dart';

/// The recorder of the voice step. The microphone is already allowed (the step wraps this in `PermissionGate`).
///
/// idle -> recording -> review -> uploading:
/// - **recording**: a live timer, a level meter and a length bar. Stop stays off until 30 s are recorded
///   ([kVoiceMinSeconds]); at 5:00 ([kVoiceMaxSeconds]) it stops by itself. "Start over" throws it away.
/// - **review**: the clip is measured on the phone and checked again (a clip under 30 s or over 5 min is refused
///   here and never uploaded). The host listens to it, then saves it or records again.
/// - **uploading**: `PUT /api/hosts/me/voice` with a progress bar. The worker's message shows if it refuses.
class VoiceRecorderPanel extends ConsumerStatefulWidget {
  const VoiceRecorderPanel({super.key, required this.consent, required this.onSaved});

  /// "This is my own voice" is ticked. Saving needs it.
  final bool consent;

  /// Called after the worker accepted the recording.
  final Future<void> Function(VoiceClip clip, VoiceSaved saved) onSaved;

  @override
  ConsumerState<VoiceRecorderPanel> createState() => _VoiceRecorderPanelState();
}

enum _Phase { idle, starting, recording, review, uploading }

class _VoiceRecorderPanelState extends ConsumerState<VoiceRecorderPanel> {
  _Phase _phase = _Phase.idle;
  VoiceRecorder? _recorder;
  StreamSubscription<double>? _levelSub;
  Timer? _timer;
  int _elapsed = 0;
  double _level = 0;
  double _progress = 0;
  VoiceClip? _clip;
  String? _error;

  @override
  void dispose() {
    _timer?.cancel();
    unawaited(_levelSub?.cancel());
    final rec = _recorder;
    if (rec != null) {
      unawaited(() async {
        await rec.cancel();
        await rec.dispose();
      }());
    }
    super.dispose();
  }

  Future<void> _start() async {
    if (_phase != _Phase.idle) return;
    setState(() {
      _phase = _Phase.starting;
      _error = null;
    });
    final rec = ref.read(voiceRecorderFactoryProvider)();
    try {
      await rec.start();
    } on VoiceRecorderException catch (e) {
      await rec.dispose();
      OnboardingTelemetry.step('voice', 'error', reason: 'mic_${e.code}');
      if (!mounted) return;
      setState(() {
        _phase = _Phase.idle;
        _error = PartBCopy.voiceMicFailed;
      });
      return;
    }
    if (!mounted) {
      await rec.cancel();
      await rec.dispose();
      return;
    }
    _recorder = rec;
    _levelSub = rec.levels.listen((v) {
      if (mounted) setState(() => _level = v);
    });
    _elapsed = 0;
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() => _elapsed += 1);
      if (_elapsed >= kVoiceMaxSeconds) unawaited(_stop(auto: true));
    });
    setState(() {
      _phase = _Phase.recording;
      _level = 0;
    });
  }

  Future<void> _stop({bool auto = false}) async {
    final rec = _recorder;
    if (rec == null || _phase != _Phase.recording) return;
    _timer?.cancel();
    _timer = null;
    _recorder = null;
    unawaited(_levelSub?.cancel());
    _levelSub = null;
    VoiceClip? clip;
    String? error;
    try {
      clip = await rec.stop();
    } on VoiceRecorderException {
      error = PartBCopy.voiceMicFailed;
    } finally {
      await rec.dispose();
    }
    if (!mounted) return;
    if (clip == null) {
      OnboardingTelemetry.step('voice', 'error', reason: 'record_failed');
      setState(() {
        _phase = _Phase.idle;
        _error = error;
      });
      return;
    }
    final VoiceClip kept = clip;
    // Stopping by itself at 5:00 can land a moment late: one second of slack, never more.
    var seconds = kept.seconds;
    if (auto && seconds > kVoiceMaxSeconds && seconds <= kVoiceMaxSeconds + 1) seconds = kVoiceMaxSeconds;
    switch (checkVoiceSeconds(seconds)) {
      case VoiceLength.tooShort:
        OnboardingTelemetry.step('voice', 'blocked', reason: 'too_short');
        setState(() {
          _phase = _Phase.idle;
          _error = PartBCopy.voiceTooShort(seconds);
        });
      case VoiceLength.tooLong:
        OnboardingTelemetry.step('voice', 'blocked', reason: 'too_long');
        setState(() {
          _phase = _Phase.idle;
          _error = PartBCopy.voiceTooLong;
        });
      case VoiceLength.ok:
        setState(() {
          _clip = kept.withSeconds(seconds);
          _phase = _Phase.review;
          _error = null;
        });
    }
  }

  Future<void> _cancelRecording() async {
    final rec = _recorder;
    _timer?.cancel();
    _timer = null;
    _recorder = null;
    unawaited(_levelSub?.cancel());
    _levelSub = null;
    if (rec != null) {
      await rec.cancel();
      await rec.dispose();
    }
    if (!mounted) return;
    setState(() {
      _phase = _Phase.idle;
      _elapsed = 0;
      _error = null;
    });
  }

  void _recordAgain() => setState(() {
        _clip = null;
        _phase = _Phase.idle;
        _elapsed = 0;
        _progress = 0;
        _error = null;
      });

  Future<void> _save() async {
    final clip = _clip;
    if (clip == null || _phase != _Phase.review || !widget.consent) return;
    setState(() {
      _phase = _Phase.uploading;
      _progress = 0;
      _error = null;
    });
    try {
      final saved = await ref.read(hostSetupApiProvider).uploadVoice(
            bytes: clip.bytes,
            mime: clip.mime,
            seconds: clip.seconds,
            onProgress: (sent, total) {
              if (mounted) setState(() => _progress = total <= 0 ? 0 : sent / total);
            },
          );
      OnboardingTelemetry.voiceRecorded(saved.seconds);
      OnboardingTelemetry.step('voice', 'saved');
      await widget.onSaved(clip, saved);
    } on ApiError catch (e) {
      OnboardingTelemetry.step('voice', 'error', reason: e.code, status: e.status);
      if (!mounted) return;
      setState(() {
        _phase = _Phase.review;
        _error = e.userMessage;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    switch (_phase) {
      case _Phase.idle:
      case _Phase.starting:
        return _idle();
      case _Phase.recording:
        return _recording();
      case _Phase.review:
      case _Phase.uploading:
        return _review();
    }
  }

  Widget _idle() {
    final starting = _phase == _Phase.starting;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        const Text(PartBCopy.voiceTapMic, style: HfText.bodyStrong, textAlign: TextAlign.center),
        const SizedBox(height: 16),
        SizedBox(
          width: 88,
          height: 88,
          child: starting
              ? const Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator(strokeWidth: 3))
              : IconButton.filled(
                  key: const ValueKey<String>('voice-record'),
                  tooltip: PartBCopy.voiceTapMic,
                  iconSize: 44,
                  onPressed: _start,
                  icon: const Icon(Icons.mic_rounded),
                ),
        ),
        if (_error != null) Align(alignment: Alignment.centerLeft, child: InlineError(_error!)),
      ],
    );
  }

  Widget _recording() {
    final tooShort = _elapsed < kVoiceMinSeconds;
    final hint = tooShort
        ? PartBCopy.voiceKeepGoing
        : (_elapsed < kVoiceSuggestSeconds ? PartBCopy.voiceNiceStop : PartBCopy.voiceCanStop);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          liveRegion: true,
          child: Text(
            '${PartBCopy.voiceRecording} ${mmss(_elapsed)}',
            key: const ValueKey<String>('voice-timer'),
            style: HfText.title,
            textAlign: TextAlign.center,
          ),
        ),
        const SizedBox(height: 14),
        ClipRRect(
          borderRadius: BorderRadius.circular(6),
          child: LinearProgressIndicator(
            key: const ValueKey<String>('voice-length'),
            value: (_elapsed / kVoiceMaxSeconds).clamp(0.0, 1.0).toDouble(),
            minHeight: 10,
            backgroundColor: HfColors.lilac,
            color: HfColors.orchid,
          ),
        ),
        const SizedBox(height: 10),
        ClipRRect(
          borderRadius: BorderRadius.circular(6),
          child: LinearProgressIndicator(
            key: const ValueKey<String>('voice-level'),
            value: _level.clamp(0.0, 1.0).toDouble(),
            minHeight: 10,
            backgroundColor: HfColors.blush,
            color: HfColors.rose,
          ),
        ),
        const SizedBox(height: 10),
        Text('$hint ${PartBCopy.voiceAutoStop}', key: const ValueKey<String>('voice-hint'), style: HfText.note, textAlign: TextAlign.center),
        const SizedBox(height: 16),
        HfButton(
          key: const ValueKey<String>('voice-stop'),
          label: PartBCopy.voiceStop,
          icon: Icons.stop_rounded,
          onPressed: tooShort ? null : () => unawaited(_stop()),
        ),
        HfButton(
          key: const ValueKey<String>('voice-cancel'),
          label: PartBCopy.voiceStartOver,
          kind: HfButtonKind.text,
          onPressed: () => unawaited(_cancelRecording()),
        ),
      ],
    );
  }

  Widget _review() {
    final clip = _clip!;
    final uploading = _phase == _Phase.uploading;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          '${PartBCopy.voiceListenFirst} (${mmss(clip.seconds)})',
          key: const ValueKey<String>('voice-review-title'),
          style: HfText.subtitle,
        ),
        const SizedBox(height: 10),
        ClipPlayerBar(loadPath: () async => clip.path, knownSeconds: clip.seconds),
        const SizedBox(height: 14),
        if (uploading) ...[
          const Text(PartBCopy.voiceUploading, style: HfText.note),
          const SizedBox(height: 6),
          ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: LinearProgressIndicator(
              key: const ValueKey<String>('voice-progress'),
              value: _progress.clamp(0.0, 1.0).toDouble(),
              minHeight: 10,
              backgroundColor: HfColors.lilac,
              color: HfColors.orchid,
            ),
          ),
          const SizedBox(height: 14),
        ],
        HfButton(
          key: const ValueKey<String>('voice-save'),
          label: PartBCopy.voiceSave,
          loading: uploading,
          onPressed: widget.consent ? () => unawaited(_save()) : null,
        ),
        if (!widget.consent) const Padding(padding: EdgeInsets.only(top: 6), child: Text(PartBCopy.voiceNeedConsent, style: HfText.note)),
        HfButton(
          key: const ValueKey<String>('voice-rerecord'),
          label: PartBCopy.voiceRecordAgain,
          kind: HfButtonKind.secondary,
          onPressed: uploading ? null : _recordAgain,
        ),
        if (_error != null) InlineError(_error!),
      ],
    );
  }
}

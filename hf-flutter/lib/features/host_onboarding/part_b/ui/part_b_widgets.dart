import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';
import '../../../kyc/kyc.dart';
import '../../ui/widgets/step_page.dart';
import '../data/part_b_rules.dart';
import '../data/voice_audio.dart';
import 'part_b_copy.dart';

/// A step page with the main button pinned under the scrolling content, so Continue is always in reach
/// (long lists such as topics and avatars, small phones, the keyboard open).
class PartBStep extends StatelessWidget {
  const PartBStep({super.key, this.title, this.lead, required this.children, this.bottom = const <Widget>[]});

  final String? title;
  final String? lead;
  final List<Widget> children;

  /// Widgets pinned at the bottom (usually an error line and the button).
  final List<Widget> bottom;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(child: OnboardingStepPage(title: title, lead: lead, children: children)),
        if (bottom.isNotEmpty) PinnedBar(children: bottom),
      ],
    );
  }
}

/// The bar under a step: cream, a thin line on top, 20 dp sides.
class PinnedBar extends StatelessWidget {
  const PinnedBar({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(HfSpacing.page, 10, HfSpacing.page, 12),
      decoration: const BoxDecoration(
        color: HfColors.cream,
        border: Border(top: BorderSide(color: HfColors.line)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: children,
      ),
    );
  }
}

/// The calm note at the top of a step that cannot be edited now (profile with the team, or live).
class LockBanner extends StatelessWidget {
  const LockBanner(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Semantics(
        liveRegion: true,
        child: Container(
          key: const ValueKey<String>('lock-banner'),
          width: double.infinity,
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(color: HfColors.butter, borderRadius: BorderRadius.circular(HfRadius.card)),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.lock_outline_rounded, size: 22, color: HfColors.plum),
              const SizedBox(width: 10),
              Expanded(child: Text(text, style: HfText.bodyText)),
            ],
          ),
        ),
      ),
    );
  }
}

/// A big choice with a title and a line of help (conversation style, topics): at least 56 dp high, the whole
/// card taps. The selected one has an orchid border and a tick, never green.
class ChoiceTile extends StatelessWidget {
  const ChoiceTile({super.key, required this.title, this.help, required this.selected, required this.onTap});

  final String title;
  final String? help;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(HfRadius.card);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Semantics(
        button: true,
        selected: selected,
        enabled: onTap != null,
        label: help == null ? title : '$title. $help',
        excludeSemantics: true,
        child: Material(
          color: selected ? HfColors.lilac : HfColors.white,
          borderRadius: radius,
          child: InkWell(
            borderRadius: radius,
            onTap: onTap,
            child: Container(
              constraints: const BoxConstraints(minHeight: 56),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(
                borderRadius: radius,
                border: Border.all(color: selected ? HfColors.orchid : HfColors.line, width: selected ? 2 : 1.5),
              ),
              child: Row(
                children: [
                  Icon(
                    selected ? Icons.check_circle_rounded : Icons.circle_outlined,
                    size: 26,
                    color: selected ? HfColors.orchid : HfColors.mauve,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(title, style: HfText.bodyStrong),
                        if (help != null) ...[
                          const SizedBox(height: 2),
                          Text(help!, style: HfText.note),
                        ],
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A heading above a group of controls.
class GroupLegend extends StatelessWidget {
  const GroupLegend(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 8, bottom: 8),
      child: Semantics(header: true, child: Text(text, style: HfText.subtitle)),
    );
  }
}

enum _ClipPhase { idle, loading, playing, paused }

/// Play, pause and a bar you can drag, for one audio file on the phone. [loadPath] runs on the first tap (it
/// returns the file's path, or null when there is nothing to play). The player is made on that first tap.
class ClipPlayerBar extends ConsumerStatefulWidget {
  const ClipPlayerBar({super.key, required this.loadPath, this.knownSeconds, this.recordedByYou = true});

  final Future<String?> Function() loadPath;

  /// Shown until the player reports the real length.
  final int? knownSeconds;
  final bool recordedByYou;

  @override
  ConsumerState<ClipPlayerBar> createState() => _ClipPlayerBarState();
}

class _ClipPlayerBarState extends ConsumerState<ClipPlayerBar> {
  ClipPlayer? _player;
  final List<StreamSubscription<Object?>> _subs = <StreamSubscription<Object?>>[];
  _ClipPhase _phase = _ClipPhase.idle;
  bool _started = false;
  Duration _position = Duration.zero;
  Duration? _length;
  double? _drag;
  String? _error;

  ClipPlayer _ensure() {
    final existing = _player;
    if (existing != null) return existing;
    final p = ref.read(clipPlayerFactoryProvider)();
    _subs
      ..add(p.states.listen(_onState))
      ..add(p.positions.listen((d) {
        if (mounted) setState(() => _position = d);
      }))
      ..add(p.durations.listen((d) {
        if (mounted && d > Duration.zero) setState(() => _length = d);
      }));
    return _player = p;
  }

  void _onState(ClipPlayerState s) {
    if (!mounted) return;
    setState(() {
      switch (s) {
        case ClipPlayerState.playing:
          _phase = _ClipPhase.playing;
        case ClipPlayerState.paused:
          _phase = _ClipPhase.paused;
        case ClipPlayerState.stopped:
          _phase = _ClipPhase.idle;
        case ClipPlayerState.completed:
          _phase = _ClipPhase.idle;
          _started = false;
          _position = Duration.zero;
      }
    });
  }

  Future<void> _toggle() async {
    try {
      if (_phase == _ClipPhase.playing) {
        await _ensure().pause();
        return;
      }
      setState(() => _error = null);
      if (_started) {
        await _ensure().resume();
        return;
      }
      setState(() => _phase = _ClipPhase.loading);
      final path = await widget.loadPath();
      if (!mounted) return;
      if (path == null) {
        setState(() {
          _phase = _ClipPhase.idle;
          _error = PartBCopy.voicePlayFailed;
        });
        return;
      }
      await _ensure().playFile(path);
      _started = true;
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _phase = _ClipPhase.idle;
        _started = false;
        _error = PartBCopy.voicePlayFailed;
      });
    }
  }

  Future<void> _seekTo(double seconds) async {
    final p = _player;
    final to = Duration(milliseconds: (seconds * 1000).round());
    setState(() {
      _drag = null;
      _position = to;
    });
    if (p == null || !_started) return;
    try {
      await p.seek(to);
    } catch (_) {
      // a failed seek leaves playback where it was
    }
  }

  @override
  void dispose() {
    for (final s in _subs) {
      unawaited(s.cancel());
    }
    final p = _player;
    if (p != null) unawaited(p.dispose());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final totalSeconds = (_length?.inMilliseconds ?? ((widget.knownSeconds ?? 0) * 1000)) / 1000.0;
    final max = totalSeconds > 0 ? totalSeconds : 1.0;
    final shown = (_drag ?? _position.inMilliseconds / 1000.0).clamp(0.0, max).toDouble();
    final playing = _phase == _ClipPhase.playing;
    final loading = _phase == _ClipPhase.loading;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            SizedBox(
              width: 56,
              height: 56,
              child: loading
                  ? const Padding(padding: EdgeInsets.all(14), child: CircularProgressIndicator(strokeWidth: 3))
                  : IconButton.filled(
                      key: const ValueKey<String>('clip-play'),
                      tooltip: playing ? PartBCopy.voicePause : PartBCopy.voicePlay,
                      iconSize: 30,
                      onPressed: _toggle,
                      icon: Icon(playing ? Icons.pause_rounded : Icons.play_arrow_rounded),
                    ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Slider(
                value: shown,
                max: max,
                onChanged: _started ? (v) => setState(() => _drag = v) : null,
                onChangeEnd: _started ? _seekTo : null,
              ),
            ),
          ],
        ),
        Padding(
          padding: const EdgeInsets.only(left: 64),
          child: Text(
            totalSeconds > 0 ? '${mmss(shown.round())} / ${mmss(totalSeconds.round())}' : mmss(shown.round()),
            style: HfText.note,
          ),
        ),
        if (_error != null) InlineError(_error!),
        if (widget.recordedByYou) ...[
          const SizedBox(height: 10),
          const Align(alignment: Alignment.centerLeft, child: _RecordedChip()),
        ],
      ],
    );
  }
}

class _RecordedChip extends StatelessWidget {
  const _RecordedChip();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(color: HfColors.lilac, borderRadius: BorderRadius.circular(HfRadius.pill)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.mic_rounded, size: 16, color: HfColors.orchid),
          const SizedBox(width: 6),
          Flexible(child: Text(PartBCopy.voiceRecorded, style: HfText.badge.copyWith(color: HfColors.orchid))),
        ],
      ),
    );
  }
}

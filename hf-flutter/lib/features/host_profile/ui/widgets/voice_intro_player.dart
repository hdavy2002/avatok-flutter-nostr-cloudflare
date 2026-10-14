import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/strings.dart';
import '../../../../core/theme/hf_theme.dart';
import '../../../../core/widgets/widgets.dart';
import '../../data/intro_player.dart';
import '../../host_profile_strings.dart';
import 'profile_common.dart';

/// Compact m:ss ("0:07"), so the label leaves the waveform its room.
String _mss(int seconds) =>
    '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';

enum _Phase { idle, loading, playing, paused }

/// Waveform bar heights (percent) from the Profile mockup.
const List<int> _kWave = [
  30,
  55,
  40,
  75,
  50,
  90,
  60,
  35,
  70,
  45,
  85,
  55,
  40,
  65,
  100,
  70,
  45,
  60,
  35,
  50,
  80,
  40,
  65,
  30,
  55,
  75,
  45,
  25,
];

/// The host's own voice introduction in the peach "Hear {name} first" card: the "Recorded by the host" chip and an
/// [HfVoiceBar] bound to the real player (position, length, play / pause). The audio player is made on the first
/// tap, not when the profile opens.
class VoiceIntroPlayer extends ConsumerStatefulWidget {
  const VoiceIntroPlayer({
    super.key,
    required this.url,
    required this.name,
    this.introSeconds,
  });

  final String url;
  final String name;

  /// From the profile card. Used until the player reports the real length.
  final int? introSeconds;

  @override
  ConsumerState<VoiceIntroPlayer> createState() => _VoiceIntroPlayerState();
}

class _VoiceIntroPlayerState extends ConsumerState<VoiceIntroPlayer> {
  static const Duration _previewLimit = Duration(seconds: 20);

  IntroPlayer? _player;
  Timer? _previewTimer;
  final List<StreamSubscription<Object?>> _subs =
      <StreamSubscription<Object?>>[];
  _Phase _phase = _Phase.idle;
  bool _started = false;
  Duration _position = Duration.zero;
  Duration? _length;
  String? _error;

  IntroPlayer _ensurePlayer() {
    final existing = _player;
    if (existing != null) return existing;
    final p = ref.read(introPlayerFactoryProvider)();
    _subs
      ..add(p.states.listen(_onState))
      ..add(
        p.positions.listen((d) {
          if (mounted) setState(() => _position = d);
        }),
      )
      ..add(
        p.durations.listen((d) {
          if (mounted && d > Duration.zero) setState(() => _length = d);
        }),
      );
    return _player = p;
  }

  void _onState(IntroPlayerState s) {
    if (!mounted) return;
    if (s != IntroPlayerState.playing) _previewTimer?.cancel();
    setState(() {
      switch (s) {
        case IntroPlayerState.playing:
          _phase = _Phase.playing;
        case IntroPlayerState.paused:
          _phase = _Phase.paused;
        case IntroPlayerState.stopped:
          _phase = _Phase.idle;
        case IntroPlayerState.completed:
          _phase = _Phase.idle;
          _started = false;
          _position = Duration.zero;
      }
    });
  }

  void _startPreviewDeadline(IntroPlayer player) {
    _previewTimer?.cancel();
    final remaining = _previewLimit - _position;
    _previewTimer = Timer(
      remaining > Duration.zero ? remaining : Duration.zero,
      () {
        unawaited(player.pause());
        unawaited(player.seek(Duration.zero));
        if (!mounted) return;
        setState(() {
          _phase = _Phase.idle;
          _started = false;
          _position = Duration.zero;
        });
      },
    );
  }

  Future<void> _toggle() async {
    if (_phase == _Phase.loading) return;
    final p = _ensurePlayer();
    try {
      if (_phase == _Phase.playing) {
        _previewTimer?.cancel();
        await p.pause();
        return;
      }
      setState(() => _error = null);
      if (_started) {
        await p.resume();
        _startPreviewDeadline(p);
      } else {
        setState(() => _phase = _Phase.loading);
        await p.play(widget.url);
        _started = true;
        _startPreviewDeadline(p);
      }
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.idle;
        _started = false;
        _error = HostProfileStrings.introFailed;
      });
    }
  }

  @override
  void dispose() {
    _previewTimer?.cancel();
    for (final s in _subs) {
      unawaited(s.cancel());
    }
    final p = _player;
    if (p != null) unawaited(p.dispose());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final reportedLength = _length ??
        Duration(
          seconds: (widget.introSeconds ?? 20).clamp(1, 20).toInt(),
        );
    final totalSeconds = reportedLength > _previewLimit
        ? _previewLimit.inSeconds.toDouble()
        : reportedLength.inMilliseconds / 1000.0;
    final max = totalSeconds > 0 ? totalSeconds : 1.0;
    final shown = (_position.inMilliseconds / 1000.0)
        .clamp(0.0, max)
        .toDouble();
    final playing = _phase == _Phase.playing;
    final ink = dark ? HfColors.peachLight : HfColors.peachInk;
    final tight = profileBigText(context, 1.4);
    final label = totalSeconds > 0 && !tight
        ? '${_mss(shown.round())} / ${_mss(totalSeconds.round())}'
        : _mss(shown.round());
    final tooltip = playing
        ? HostProfileStrings.pauseIntro
        : HostProfileStrings.playIntro;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: HfSurfaces.card(context, radius: 26),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: HfSpacing.sm,
            runSpacing: HfSpacing.sm,
            children: [
              Semantics(
                header: true,
                child: Text(
                  HostProfileStrings.introHeading(widget.name),
                  style: HfText.subsection.copyWith(color: ink),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 5,
                ),
                decoration: BoxDecoration(
                  color: dark
                      ? HfColors.darkCard
                      : HfColors.white.withValues(alpha: 0.7),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Text(
                  Strings.recordedByHost,
                  style: HfText.badge.copyWith(color: ink),
                ),
              ),
            ],
          ),
          const SizedBox(height: HfSpacing.lg),
          LayoutBuilder(
            builder: (context, c) {
              const heights = _kWave;
              return Semantics(
                button: true,
                label: tooltip,
                excludeSemantics: true,
                onTap: _toggle,
                child: Tooltip(
                  message: tooltip,
                  excludeFromSemantics: true,
                  child: HfVoiceBar(
                    title: '',
                    durationLabel: label,
                    heights: heights,
                    progress: totalSeconds > 0 ? shown / max : 0,
                    playing: playing,
                    onTap: _toggle,
                  ),
                ),
              );
            },
          ),
          if (_error != null) ...[
            const SizedBox(height: HfSpacing.sm),
            Semantics(
              liveRegion: true,
              child: Text(
                _error!,
                style: HfText.note.copyWith(
                  color: dark ? HfColors.blushLight : HfColors.accent,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

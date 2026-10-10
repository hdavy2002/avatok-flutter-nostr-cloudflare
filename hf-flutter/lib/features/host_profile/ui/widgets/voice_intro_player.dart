import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/format/money.dart';
import '../../../../core/strings.dart';
import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';
import '../../data/intro_player.dart';
import '../../host_profile_strings.dart';

enum _Phase { idle, loading, playing, paused }

/// The host's own voice introduction: play / pause, a progress bar you can drag, the time, and the label
/// "Recorded by the host". The audio player is made on the first tap, not when the profile opens.
class VoiceIntroPlayer extends ConsumerStatefulWidget {
  const VoiceIntroPlayer({super.key, required this.url, this.introSeconds});

  final String url;

  /// From the profile card. Used until the player reports the real length.
  final int? introSeconds;

  @override
  ConsumerState<VoiceIntroPlayer> createState() => _VoiceIntroPlayerState();
}

class _VoiceIntroPlayerState extends ConsumerState<VoiceIntroPlayer> {
  IntroPlayer? _player;
  final List<StreamSubscription<Object?>> _subs = <StreamSubscription<Object?>>[];
  _Phase _phase = _Phase.idle;
  bool _started = false;
  Duration _position = Duration.zero;
  Duration? _length;
  double? _dragSeconds;
  String? _error;

  IntroPlayer _ensurePlayer() {
    final existing = _player;
    if (existing != null) return existing;
    final p = ref.read(introPlayerFactoryProvider)();
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

  void _onState(IntroPlayerState s) {
    if (!mounted) return;
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

  Future<void> _toggle() async {
    final p = _ensurePlayer();
    try {
      if (_phase == _Phase.playing) {
        await p.pause();
        return;
      }
      setState(() => _error = null);
      if (_started) {
        await p.resume();
      } else {
        setState(() => _phase = _Phase.loading);
        await p.play(widget.url);
        _started = true;
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

  Future<void> _seekTo(double seconds) async {
    final p = _player;
    setState(() {
      _dragSeconds = null;
      _position = Duration(milliseconds: (seconds * 1000).round());
    });
    if (p == null || !_started) return;
    try {
      await p.seek(Duration(milliseconds: (seconds * 1000).round()));
    } catch (_) {
      // A failed seek leaves playback where it was.
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
    final totalSeconds = (_length?.inMilliseconds ?? ((widget.introSeconds ?? 0) * 1000)) / 1000.0;
    final max = totalSeconds > 0 ? totalSeconds : 1.0;
    final shown = (_dragSeconds ?? _position.inMilliseconds / 1000.0).clamp(0.0, max).toDouble();
    final playing = _phase == _Phase.playing;
    final loading = _phase == _Phase.loading;
    return HfCard(
      color: HfColors.lilac,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(HostProfileStrings.introTitle, style: HfText.subtitle),
          const SizedBox(height: 8),
          Row(
            children: [
              SizedBox(
                width: 56,
                height: 56,
                child: loading
                    ? const Padding(padding: EdgeInsets.all(14), child: CircularProgressIndicator(strokeWidth: 3))
                    : IconButton.filled(
                        tooltip: playing ? HostProfileStrings.pauseIntro : HostProfileStrings.playIntro,
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
                  onChanged: _started ? (v) => setState(() => _dragSeconds = v) : null,
                  onChangeEnd: _started ? _seekTo : null,
                ),
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(left: 64),
            child: Text(
              totalSeconds > 0
                  ? '${Money.clock(shown.round())} / ${Money.clock(totalSeconds.round())}'
                  : Money.clock(shown.round()),
              style: HfText.note,
            ),
          ),
          if (_error != null) ...[
            const SizedBox(height: 8),
            Semantics(liveRegion: true, child: Text(_error!, style: HfText.note.copyWith(color: HfColors.accent))),
          ],
          const SizedBox(height: 12),
          const Align(alignment: Alignment.centerLeft, child: _RecordedChip()),
        ],
      ),
    );
  }
}

class _RecordedChip extends StatelessWidget {
  const _RecordedChip();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(color: HfColors.white, borderRadius: BorderRadius.circular(HfRadius.pill)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.mic_rounded, size: 16, color: HfColors.orchid),
          const SizedBox(width: 6),
          Flexible(child: Text(Strings.recordedByHost, style: HfText.badge.copyWith(color: HfColors.orchid))),
        ],
      ),
    );
  }
}

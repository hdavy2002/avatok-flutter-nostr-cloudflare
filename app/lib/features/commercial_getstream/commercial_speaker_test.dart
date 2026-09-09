import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';

abstract interface class CommercialSpeakerOutput {
  Future<void> play();
  Future<void> stop();
  Future<void> dispose();
}

class _LocalSpeakerOutput implements CommercialSpeakerOutput {
  AudioPlayer? _player;
  @override
  Future<void> play() async {
    final player = _player ??= AudioPlayer();
    // Do not steal audio focus from the existing backstage call.
    await player.setAudioContext(AudioContext(
      android: const AudioContextAndroid(audioFocus: AndroidAudioFocus.none),
      iOS: AudioContextIOS(
        category: AVAudioSessionCategory.playAndRecord,
        options: const {AVAudioSessionOptions.mixWithOthers},
      ),
    ));
    await player.play(BytesSource(commercialSpeakerTone()));
  }
  @override
  Future<void> stop() async { await _player?.stop(); }
  @override
  Future<void> dispose() async { await _player?.dispose(); _player = null; }
}

class CommercialSpeakerTestState {
  const CommercialSpeakerTestState({this.playing = false, this.tested = false, this.error});
  final bool playing, tested;
  final String? error;
}

/// Serializes native operations: a late play cannot outlive a requested stop.
/// The test tone is generated locally; it contains no captured microphone data.
class CommercialSpeakerTestController {
  CommercialSpeakerTestController({CommercialSpeakerOutput? output, this.onEvent})
      : _output = output ?? _LocalSpeakerOutput();
  final CommercialSpeakerOutput _output;
  final void Function(String)? onEvent;
  final state = ValueNotifier(const CommercialSpeakerTestState());
  Future<void> _tail = Future<void>.value();
  Timer? _timer;
  int _generation = 0;
  bool _closed = false;

  Future<void> _enqueue(Future<void> Function() action) {
    final next = _tail.then((_) => action());
    _tail = next.catchError((Object _) {});
    return next;
  }

  void _event(String result) {
    if (onEvent != null) { onEvent!(result); return; }
    Analytics.capture('commercial_speaker_test', {'result': result});
  }

  Future<void> play() async {
    if (_closed || state.value.playing) return;
    final generation = ++_generation;
    state.value = const CommercialSpeakerTestState(playing: true);
    _event('started');
    try {
      await _enqueue(() async {
        if (_closed || generation != _generation) return;
        await _output.play();
      });
      if (_closed || generation != _generation) return;
      _timer = Timer(const Duration(milliseconds: 900), () { unawaited(stop()); });
    } catch (_) {
      if (!_closed && generation == _generation) {
        state.value = const CommercialSpeakerTestState(error: 'Could not play the test sound. Check your audio output and try again.');
        _event('failed');
      }
      try { await _enqueue(_output.stop); } catch (_) {}
    }
  }

  Future<void> stop() async {
    ++_generation;
    _timer?.cancel();
    _timer = null;
    if (!_closed && state.value.playing) {
      state.value = const CommercialSpeakerTestState(tested: true);
      _event('stopped');
    }
    try { await _enqueue(_output.stop); } catch (_) {}
  }

  Future<void> dispose() async {
    if (_closed) return;
    _closed = true;
    await stop();
    try { await _enqueue(_output.dispose); } catch (_) {}
    state.dispose();
  }
}

class CommercialSpeakerTestButton extends StatelessWidget {
  const CommercialSpeakerTestButton({super.key, required this.controller, this.enabled = true});
  final CommercialSpeakerTestController controller;
  final bool enabled;
  @override
  Widget build(BuildContext context) => ValueListenableBuilder<CommercialSpeakerTestState>(
    valueListenable: controller.state,
    builder: (context, state, _) => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        OutlinedButton.icon(
          onPressed: !enabled ? null : () => unawaited(state.playing ? controller.stop() : controller.play()),
          icon: Icon(PhosphorIcons.speakerHigh(PhosphorIconsStyle.bold)),
          label: Text(state.playing ? 'Stop test' : 'Test speaker'),
        ),
        if (state.playing || state.tested)
          Text('Did you hear the sound? Check your volume and connected headphones.', style: ADText.preview()),
        if (state.error != null)
          Padding(padding: const EdgeInsets.only(top: Msg.s2), child: Text(state.error!, style: ADText.preview(c: AD.danger))),
      ],
    ),
  );
}

Uint8List commercialSpeakerTone() {
  const sampleRate = 16000, samples = 9600;
  final data = ByteData(44 + samples * 2);
  void ascii(int offset, String text) {
    for (var i = 0; i < text.length; i++) { data.setUint8(offset + i, text.codeUnitAt(i)); }
  }
  ascii(0, 'RIFF'); data.setUint32(4, 36 + samples * 2, Endian.little);
  ascii(8, 'WAVE'); ascii(12, 'fmt '); data.setUint32(16, 16, Endian.little);
  data.setUint16(20, 1, Endian.little); data.setUint16(22, 1, Endian.little);
  data.setUint32(24, sampleRate, Endian.little); data.setUint32(28, sampleRate * 2, Endian.little);
  data.setUint16(32, 2, Endian.little); data.setUint16(34, 16, Endian.little);
  ascii(36, 'data'); data.setUint32(40, samples * 2, Endian.little);
  for (var i = 0; i < samples; i++) {
    final envelope = math.min(1.0, math.min(i / 400, (samples - i) / 400));
    data.setInt16(44 + i * 2, (math.sin(2 * math.pi * 660 * i / sampleRate) * 7000 * envelope).round(), Endian.little);
  }
  return data.buffer.asUint8List();
}

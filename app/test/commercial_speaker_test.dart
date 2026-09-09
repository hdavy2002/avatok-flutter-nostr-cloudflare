import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:avatok_call/features/commercial_getstream/commercial_speaker_test.dart';

class FakeOutput implements CommercialSpeakerOutput {
  Completer<void>? pending;
  bool fail = false;
  final calls = <String>[];
  @override Future<void> play() async {
    calls.add('play');
    await pending?.future;
    if (fail) throw StateError('output unavailable');
  }
  @override Future<void> stop() async { calls.add('stop'); }
  @override Future<void> dispose() async { calls.add('dispose'); }
}

void main() {
  test('stop waits for a pending native play and releases it', () async {
    final output = FakeOutput()..pending = Completer<void>();
    final controller = CommercialSpeakerTestController(output: output, onEvent: (_) {});
    final playing = controller.play();
    await Future<void>.delayed(Duration.zero);
    final stopping = controller.stop();
    output.pending!.complete();
    await playing; await stopping;
    expect(output.calls, ['play', 'stop']);
    expect(controller.state.value.playing, false);
    await controller.dispose();
  });
  test('dispose blocks late playback and releases resources once', () async {
    final output = FakeOutput()..pending = Completer<void>();
    final controller = CommercialSpeakerTestController(output: output, onEvent: (_) {});
    final playing = controller.play();
    await Future<void>.delayed(Duration.zero);
    final closing = controller.dispose(); output.pending!.complete();
    await playing; await closing; await controller.play(); await controller.dispose();
    expect(output.calls, ['play', 'stop', 'dispose']);
  });
  test('failed output can be retried without poisoning cleanup queue', () async {
    final output = FakeOutput()..fail = true;
    final controller = CommercialSpeakerTestController(output: output, onEvent: (_) {});
    await controller.play(); expect(controller.state.value.error, isNotNull);
    output.fail = false; await controller.play();
    expect(controller.state.value.playing, true);
    await controller.stop(); await controller.dispose();
    expect(output.calls.where((v) => v == 'play').length, 2);
  });
  test('speaker WAV is bounded and has correct PCM header', () {
    final tone = commercialSpeakerTone();
    expect(String.fromCharCodes(tone.take(4)), 'RIFF');
    expect(String.fromCharCodes(tone.sublist(8, 12)), 'WAVE');
    expect(tone.length, 44 + 9600 * 2);
  });
}

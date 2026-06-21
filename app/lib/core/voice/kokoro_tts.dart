/// KokoroTts — turns text into a playable WAV using on-device Kokoro (sherpa-onnx),
/// in the user's chosen language + voice ([KokoroVoicePref]).
///
/// Used in two places:
///   • wired into [AvaVoice.synthesizer] so the existing "Listen" affordance in
///     companion chats works, and
///   • directly by the hands-free Voice Call (which streams PCM instead — see
///     SherpaVoiceEngine.synthesize / VoiceCallController).
///
/// [speakToFile] returns a local .wav path (or null if the voice model isn't ready
/// / synthesis failed) so callers can play it via audioplayers.
library;

import 'dart:io';
import 'dart:typed_data';

import 'package:path_provider/path_provider.dart';

import '../kokoro_voice.dart';
import 'sherpa_voice_engine.dart';

class KokoroTts {
  KokoroTts._();

  /// Synthesize [text] in the current Kokoro selection and return a .wav path.
  static Future<String?> speakToFile(String text) async {
    if (text.trim().isEmpty) return null;
    final sel = KokoroVoicePref.current;
    final audio = await SherpaVoiceEngine.I.synthesize(text, sid: sel.sid);
    if (audio == null) return null;
    try {
      final dir = await getTemporaryDirectory();
      final path = '${dir.path}/ava_tts_${DateTime.now().millisecondsSinceEpoch}.wav';
      await File(path).writeAsBytes(
        wavBytes(audio.pcm16, audio.sampleRate),
        flush: true,
      );
      return path;
    } catch (_) {
      return null;
    }
  }

  /// Wrap PCM16 mono samples in a WAV container.
  static Uint8List wavBytes(Int16List samples, int sampleRate) {
    const channels = 1;
    const bits = 16;
    final byteRate = sampleRate * channels * bits ~/ 8;
    final blockAlign = channels * bits ~/ 8;
    final data = samples.buffer.asUint8List(samples.offsetInBytes, samples.lengthInBytes);
    final dataLen = data.length;
    final buf = BytesBuilder();
    void s(String x) => buf.add(x.codeUnits);
    void u32(int v) => buf.add(Uint8List(4)..buffer.asByteData().setUint32(0, v, Endian.little));
    void u16(int v) => buf.add(Uint8List(2)..buffer.asByteData().setUint16(0, v, Endian.little));
    s('RIFF'); u32(36 + dataLen); s('WAVE');
    s('fmt '); u32(16); u16(1); u16(channels); u32(sampleRate); u32(byteRate); u16(blockAlign); u16(bits);
    s('data'); u32(dataLen); buf.add(data);
    return buf.toBytes();
  }
}

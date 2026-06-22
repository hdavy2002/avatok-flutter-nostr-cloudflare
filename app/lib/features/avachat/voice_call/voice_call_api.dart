/// Shared surface for a hands-free Ava voice call, so [VoiceCallScreen] can drive
/// either implementation interchangeably:
///   • VoiceCallController  — PRIVATE, on-device (Silero VAD → Whisper → Gemini → Supertonic)
///   • LiveVoiceController   — FAST, online (Gemini Live native audio, ~sub-second)
/// The user picks between them with the VoiceCallMode toggle.
library;

import 'package:flutter/foundation.dart';

enum CallState { preparing, listening, thinking, speaking, error, ended }

abstract class VoiceCallApi {
  ValueNotifier<CallState> get state;
  ValueNotifier<String> get status;
  ValueNotifier<String> get userCaption;
  ValueNotifier<String> get avaCaption;
  /// True while Ava is the active talker (drives the orb animation).
  ValueNotifier<bool> get avaSpeaking;

  /// Begin the call. Returns false if it could not start.
  Future<bool> start();

  /// Tear down (mic, sockets, native models). Safe to call once.
  Future<void> dispose();
}

import 'dart:typed_data';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// A finished selfie video, in memory (about 10 s at medium quality is well under the worker's 12 MB limit).
class SelfieClip {
  const SelfieClip({required this.bytes, required this.mime, required this.seconds});

  final Uint8List bytes;

  /// One of the worker's accepted types: `video/mp4`, `video/webm`, `video/quicktime`.
  final String mime;
  final int seconds;
}

/// Why the camera could not be used. [code]: `denied` (permission), `no_camera`, `failed`.
class SelfieRecorderException implements Exception {
  const SelfieRecorderException(this.code, [this.detail]);

  final String code;
  final String? detail;

  bool get isDenied => code == 'denied';

  @override
  String toString() => 'SelfieRecorderException($code${detail == null ? '' : ': $detail'})';
}

/// The camera, behind a small interface so widget tests use a fake (`FakeSelfieRecorder`).
/// One instance records one session: [open], [start], [stop], [dispose].
abstract class SelfieRecorder {
  /// Opens the FRONT camera at medium quality, with sound. Throws [SelfieRecorderException].
  Future<void> open();

  /// The live preview. Only valid after [open].
  Widget buildPreview(BuildContext context);

  Future<void> start();

  /// Stops and returns the whole video.
  Future<SelfieClip> stop();

  Future<void> dispose();
}

typedef SelfieRecorderFactory = SelfieRecorder Function();

/// Tests override this with a factory that returns a fake.
final selfieRecorderFactoryProvider = Provider<SelfieRecorderFactory>((ref) => CameraSelfieRecorder.new);

/// The real recorder, on the `camera` package (CameraX on Android records MP4).
class CameraSelfieRecorder implements SelfieRecorder {
  CameraController? _controller;
  DateTime? _startedAt;

  static bool _isDeniedCode(String code) => code.contains('AccessDenied') || code.contains('AccessRestricted');

  @override
  Future<void> open() async {
    try {
      final cameras = await availableCameras();
      if (cameras.isEmpty) throw const SelfieRecorderException('no_camera');
      final front = cameras.firstWhere(
        (c) => c.lensDirection == CameraLensDirection.front,
        orElse: () => cameras.first,
      );
      final controller = CameraController(front, ResolutionPreset.medium, enableAudio: true);
      _controller = controller;
      await controller.initialize();
    } on CameraException catch (e) {
      throw SelfieRecorderException(_isDeniedCode(e.code) ? 'denied' : 'failed', e.description ?? e.code);
    }
  }

  @override
  Widget buildPreview(BuildContext context) {
    final c = _controller;
    if (c == null || !c.value.isInitialized) return const SizedBox.shrink();
    return CameraPreview(c);
  }

  @override
  Future<void> start() async {
    final c = _controller;
    if (c == null) throw const SelfieRecorderException('failed', 'not open');
    try {
      await c.startVideoRecording();
      _startedAt = DateTime.now();
    } on CameraException catch (e) {
      throw SelfieRecorderException(_isDeniedCode(e.code) ? 'denied' : 'failed', e.description ?? e.code);
    }
  }

  @override
  Future<SelfieClip> stop() async {
    final c = _controller;
    if (c == null) throw const SelfieRecorderException('failed', 'not open');
    try {
      final file = await c.stopVideoRecording();
      final bytes = await file.readAsBytes();
      final started = _startedAt;
      final seconds = started == null ? 0 : DateTime.now().difference(started).inSeconds;
      final m = file.mimeType;
      final mime = (m == 'video/webm' || m == 'video/quicktime') ? m! : 'video/mp4';
      return SelfieClip(bytes: bytes, mime: mime, seconds: seconds);
    } on CameraException catch (e) {
      throw SelfieRecorderException('failed', e.description ?? e.code);
    }
  }

  @override
  Future<void> dispose() async {
    final c = _controller;
    _controller = null;
    try {
      await c?.dispose();
    } catch (_) {
      // already released
    }
  }
}

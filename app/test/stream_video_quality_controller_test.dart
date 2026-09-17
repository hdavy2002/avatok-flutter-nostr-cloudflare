import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:avatok_call/core/calls/stream_video_quality_controller.dart';
import 'package:avatok_call/core/calls/video_quality_policy.dart';
import 'package:avatok_call/identity/identity.dart' show AccountScope;

class _Port implements StreamVideoQualityPort {
  @override
  bool connected = true;
  @override
  bool cameraEnabled = true;
  @override
  VideoQualityRung capabilityCeiling = VideoQualityRung.p2160;
  final captures = <VideoQualityRung>[];
  final receives = <VideoQualityRung>[];
  final cameras = <bool>[];
  final rejected = <VideoQualityRung>{};
  bool rejectIncoming = false;
  Completer<bool>? captureGate;

  @override
  Future<bool> requestCameraResolution(VideoQualityRung rung) async {
    captures.add(rung);
    final gate = captureGate;
    if (gate != null) return gate.future;
    return !rejected.contains(rung);
  }

  @override
  Future<bool> requestIncomingResolution(VideoQualityRung rung) async {
    receives.add(rung);
    return !rejectIncoming;
  }

  @override
  Future<bool> setCameraEnabled(bool enabled) async {
    cameras.add(enabled);
    cameraEnabled = enabled;
    return true;
  }

  @override
  Future<bool> flipCamera() async => cameraEnabled;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    AccountScope.id = 'quality-account';
    SharedPreferences.setMockInitialValues({});
  });
  tearDown(() => AccountScope.id = null);

  StreamVideoQualityController controller(_Port port, {bool publish = true, bool video = true}) {
    final quality = StreamVideoQualityController(port: port,
      videoAllowed: video, canPublish: publish);
    addTearDown(() async { await quality.close(); quality.dispose(); });
    return quality;
  }

  test('camera-off and receive-only viewers never capture or enable camera', () async {
    for (final publish in [true, false]) {
      final port = _Port()..cameraEnabled = false;
      final quality = controller(port, publish: publish);
      await quality.start();
      await quality.setMode(VideoQualityMode.best);
      expect(port.captures, isEmpty);
      expect(port.cameras, isEmpty);
      expect(port.receives.last, VideoQualityRung.p2160);
    }
  });

  test('audio calls never enable incoming video or publish', () async {
    final port = _Port()..cameraEnabled = false;
    final quality = controller(port, publish: false, video: false);
    await quality.start();
    await quality.setMode(VideoQualityMode.best);
    expect(port.receives, [VideoQualityRung.audioOnly]);
    expect(port.captures, isEmpty);
    expect(port.cameras, isEmpty);
  });

  test('unsupported resolutions fall down the ladder once per session', () async {
    final port = _Port()..rejected.addAll([VideoQualityRung.p2160, VideoQualityRung.p1440]);
    final quality = controller(port);
    await quality.start();
    await quality.setMode(VideoQualityMode.best);
    expect(port.captures, [VideoQualityRung.p720, VideoQualityRung.p2160,
      VideoQualityRung.p1440, VideoQualityRung.p1080]);
    await quality.setMode(VideoQualityMode.dataSaver);
    await quality.setMode(VideoQualityMode.best);
    expect(port.captures.last, VideoQualityRung.p1080);
    expect(port.captures.where((r) => r == VideoQualityRung.p2160).length, 1);
    expect(quality.actualSendResolution, isNull);
    expect(quality.telemetry['video_quality_actual_send'], 'unknown');
  });

  test('audio fallback never automatically re-enables the camera', () async {
    final port = _Port();
    final quality = controller(port);
    await quality.start();
    await quality.setMode(VideoQualityMode.dataSaver);
    final epoch = DateTime.utc(2026);
    quality.policy.observe(VideoQualitySample(at: epoch, poorConnection: true));
    quality.policy.observe(VideoQualitySample(at: epoch.add(const Duration(seconds: 3)), poorConnection: true));
    await quality.refresh();
    expect(port.cameras, [false]);
    expect(quality.incomingPaused, isTrue);
    await quality.setMode(VideoQualityMode.auto);
    expect(port.receives.last, VideoQualityRung.p720);
    expect(port.cameras, [false]);
    expect(quality.cameraPausedForQuality, isTrue);
    expect(await quality.setCameraEnabled(true), isTrue);
    expect(port.cameras, [false, true]);
  });

  test('reconnect reapplies preferences without opening camera', () async {
    final port = _Port()..cameraEnabled = false;
    final quality = controller(port);
    await quality.start();
    port.connected = false;
    await quality.refresh();
    port.connected = true;
    await quality.refresh();
    expect(port.receives, [VideoQualityRung.p720, VideoQualityRung.p720]);
    expect(port.cameras, isEmpty);
  });

  test('subscriber failure cannot block audio-saving camera pause', () async {
    final port = _Port();
    final quality = controller(port);
    await quality.start();
    await quality.setMode(VideoQualityMode.dataSaver);
    port.rejectIncoming = true;
    final epoch = DateTime.utc(2026);
    quality.policy.observe(VideoQualitySample(at: epoch, poorConnection: true));
    quality.policy.observe(VideoQualitySample(at: epoch.add(const Duration(seconds: 3)), poorConnection: true));
    await quality.refresh();
    expect(port.cameras, [false]);
    expect(quality.incomingPaused, isFalse); // request was not acknowledged
    expect(quality.requested, VideoQualityRung.audioOnly);
  });

  test('camera-off is serialized behind capture recreation', () async {
    final port = _Port();
    final quality = controller(port);
    await quality.start();
    final gate = Completer<bool>();
    port.captureGate = gate;
    final changing = quality.setMode(VideoQualityMode.best);
    await Future<void>.delayed(Duration.zero);
    final disabling = quality.setCameraEnabled(false);
    expect(port.cameras, isEmpty);
    gate.complete(true);
    await changing;
    await disabling;
    expect(port.cameras, [false]);
    expect(port.cameraEnabled, isFalse);
  });

  test('closing during capture drains it and prevents further media requests', () async {
    final port = _Port();
    final quality = controller(port);
    await quality.start();
    final gate = Completer<bool>();
    port.captureGate = gate;
    final changing = quality.setMode(VideoQualityMode.best);
    await Future<void>.delayed(Duration.zero);
    var closed = false;
    final closing = quality.close().then((_) => closed = true);
    await Future<void>.delayed(Duration.zero);
    expect(closed, isFalse);
    gate.complete(true);
    await changing;
    await closing;
    final before = port.receives.length;
    await quality.setMode(VideoQualityMode.dataSaver);
    expect(port.receives.length, before);
  });

  test('account switch prevents a stale controller from mutating media', () async {
    final port = _Port();
    final quality = controller(port);
    await quality.start();
    AccountScope.id = 'another-account';
    await quality.setMode(VideoQualityMode.best);
    await quality.refresh();
    expect(port.captures, [VideoQualityRung.p720]);
  });
}

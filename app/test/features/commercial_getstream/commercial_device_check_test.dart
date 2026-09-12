import 'dart:typed_data';
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:stream_video_flutter/stream_video_flutter.dart';

import 'package:avatok_call/features/commercial_getstream/commercial_device_check.dart';

class _FakeRecorder implements CommercialPcmRecorder {
  _FakeRecorder({this.failStart = false, this.pending});
  final bool failStart;
  final Completer<Stream<Uint8List>>? pending;
  bool stopped = false, disposed = false;
  @override
  Future<Stream<Uint8List>> startPcm() {
    if (failStart) return Future.error(StateError('denied'));
    return pending?.future ?? Future.value(const Stream<Uint8List>.empty());
  }
  @override Future<void> stop() async { stopped = true; }
  @override Future<void> dispose() async { disposed = true; }
}

class _FakeRecordFactory implements CommercialRecordFactory {
  _FakeRecordFactory(this.recorders);
  final List<_FakeRecorder> recorders;
  @override CommercialPcmRecorder create() => recorders.removeAt(0);
}

class _FakeCamera implements RtcLocalCameraTrack {
  int stops = 0;
  @override Future<void> stop() async { stops++; }
  @override dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
class _PendingCameraFactory implements CommercialDeviceTrackFactory {
  final pending = Completer<RtcLocalCameraTrack>();
  @override Future<RtcLocalCameraTrack> camera() => pending.future;
}

/// [AV-AUDIO-ONLY-1] A desktop/phone with no usable camera: `RtcLocalTrack
/// .camera()` rejects instead of returning a track.
class _NoCameraFactory implements CommercialDeviceTrackFactory {
  int attempts = 0;
  @override Future<RtcLocalCameraTrack> camera() {
    attempts++;
    return Future.error(StateError('no camera on this device'));
  }
}

void main() {
  testWidgets('device checks fit a small screen and never animate a missing level', (tester) async {
    tester.view.physicalSize = const Size(320, 480);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final controller = CommercialDeviceCheckController();
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(
      child: CommercialDeviceCheckPanel(controller: controller, cameraEnabled: false,
        microphoneEnabled: false, onCameraChanged: (_) {}, onMicrophoneChanged: (_) {}),
    ))));
    await tester.pump();
    expect(find.text('Camera on when I join'), findsOneWidget);
    expect(tester.widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator)).value, 0);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await controller.dispose();
  });

  test('late camera acquisition is stopped after disposal and cannot resume', () async {
    final factory = _PendingCameraFactory(); final camera = _FakeCamera();
    final controller = CommercialDeviceCheckController(trackFactory: factory);
    final opening = controller.setCameraEnabled(true);
    await Future<void>.delayed(Duration.zero);
    final closing = controller.dispose();
    factory.pending.complete(camera);
    await opening; await closing;
    expect(camera.stops, 1); expect(controller.cameraTrack, isNull);
    controller.resume(); await controller.setCameraEnabled(true);
    expect(controller.cameraTrack, isNull);
  });

  group('commercialDeviceCheckReady', () {
    test('cannot join while the network probe is pending', () {
      expect(commercialDeviceCheckReady(
        enabled: true,
        checking: true,
        cameraOn: false,
        microphoneOn: false,
        cameraGranted: false,
        microphoneGranted: false,
        networkVerdict: 'green',
      ), isFalse);
    });

    test('requires a completed non-red probe and enabled-device permissions', () {
      final base = <String, Object?>{
        'enabled': true,
        'checking': false,
        'cameraOn': true,
        'microphoneOn': true,
        'cameraGranted': true,
        'microphoneGranted': true,
      };
      bool ready(String? verdict) => commercialDeviceCheckReady(
            enabled: base['enabled']! as bool,
            checking: base['checking']! as bool,
            cameraOn: base['cameraOn']! as bool,
            microphoneOn: base['microphoneOn']! as bool,
            cameraGranted: base['cameraGranted']! as bool,
            microphoneGranted: base['microphoneGranted']! as bool,
            networkVerdict: verdict,
          );

      expect(ready(null), isFalse);
      expect(ready('unknown'), isFalse);
      expect(ready('red'), isFalse);
      expect(ready('yellow'), isTrue);
      expect(ready('green'), isTrue);
      expect(commercialDeviceCheckReady(
        enabled: true,
        checking: false,
        cameraOn: true,
        microphoneOn: false,
        cameraGranted: false,
        microphoneGranted: false,
        networkVerdict: 'green',
      ), isFalse);
    });

    test('[AV-AUDIO-ONLY-1] a missing camera never blocks join', () {
      // Camera ON, camera permission granted, but the device has no camera:
      // the customer still has a working mic and still sees the creator, so
      // this must be joinable (RULEBOOK-PAID-SESSIONS.md §3).
      expect(commercialDeviceCheckReady(
        enabled: true,
        checking: false,
        cameraOn: true,
        microphoneOn: true,
        cameraGranted: false,
        microphoneGranted: true,
        networkVerdict: 'green',
        cameraAvailable: false,
      ), isTrue);
      // The microphone is the device that still matters: no mic permission
      // while the mic is on is still not ready.
      expect(commercialDeviceCheckReady(
        enabled: true,
        checking: false,
        cameraOn: true,
        microphoneOn: true,
        cameraGranted: false,
        microphoneGranted: false,
        networkVerdict: 'green',
        cameraAvailable: false,
      ), isFalse);
      // Default stays strict: a camera that IS available still needs its
      // permission before the screen reports ready.
      expect(commercialDeviceCheckReady(
        enabled: true,
        checking: false,
        cameraOn: true,
        microphoneOn: true,
        cameraGranted: false,
        microphoneGranted: true,
        networkVerdict: 'green',
      ), isFalse);
    });

    test('receive-only choice does not require disabled device permission', () {
      expect(commercialDeviceCheckReady(
        enabled: true,
        checking: false,
        cameraOn: false,
        microphoneOn: false,
        cameraGranted: false,
        microphoneGranted: false,
        networkVerdict: 'green',
      ), isTrue);
    });
  });

  test('[AV-AUDIO-ONLY-1] a broken camera is reported, not thrown, and the mic still starts', () async {
    final camera = _NoCameraFactory();
    final recorder = _FakeRecorder();
    final controller = CommercialDeviceCheckController(
      trackFactory: camera,
      recorderFactory: _FakeRecordFactory([recorder]),
    );
    // Must NOT throw: throwing here used to abort the prejoin sync before the
    // microphone was ever started, killing the meter AND the Join button.
    await controller.setCameraEnabled(true);
    expect(camera.attempts, 1);
    expect(controller.cameraTrack, isNull);
    expect(controller.cameraUnavailable, isTrue);
    await controller.setMicrophoneEnabled(true);
    await controller.release();
    expect(recorder.stopped, isTrue);
    // An explicit retry re-probes rather than staying latched forever.
    controller.clearCameraUnavailable();
    expect(controller.cameraUnavailable, isFalse);
    controller.resume();
    await controller.setCameraEnabled(true);
    expect(camera.attempts, 2);
    expect(controller.cameraUnavailable, isTrue);
    await controller.dispose();
  });

  test('PCM meter reports actual sample energy and ignores incomplete bytes', () {
    expect(commercialPcm16Rms(Uint8List.fromList([0, 0, 0])), 0);
    final quiet = commercialPcm16Rms(Uint8List.fromList([0, 0, 0, 0]));
    final loud = commercialPcm16Rms(Uint8List.fromList([0xff, 0x7f, 0x01, 0x80]));
    expect(quiet, 0);
    expect(loud, greaterThan(.9));
  });

  test('failed recorder start does not poison later release and retry', () async {
    final failed = _FakeRecorder(failStart: true);
    final working = _FakeRecorder();
    final controller = CommercialDeviceCheckController(recorderFactory: _FakeRecordFactory([failed, working]));
    await expectLater(controller.setMicrophoneEnabled(true), throwsStateError);
    await controller.release();
    expect(failed.stopped, isTrue); // failed startup is still explicitly cleaned up
    expect(failed.disposed, isTrue);
    controller.resume();
    await controller.setMicrophoneEnabled(true);
    await controller.release();
    expect(working.stopped, isTrue);
    expect(working.disposed, isTrue);
  });

  test('release waits for pending mic startup and blocks late reacquisition', () async {
    final started = Completer<Stream<Uint8List>>();
    final recorder = _FakeRecorder(pending: started);
    final controller = CommercialDeviceCheckController(recorderFactory: _FakeRecordFactory([recorder]));
    final enabling = controller.setMicrophoneEnabled(true);
    await Future<void>.delayed(Duration.zero);
    final releasing = controller.release();
    started.complete(const Stream<Uint8List>.empty());
    await enabling;
    await releasing;
    expect(recorder.stopped, isTrue);
    expect(recorder.disposed, isTrue);
    expect(controller.microphoneLevel, isNull);
  });
}

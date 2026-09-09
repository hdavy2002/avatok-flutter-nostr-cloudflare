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

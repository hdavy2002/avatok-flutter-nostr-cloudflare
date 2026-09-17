import 'package:flutter_test/flutter_test.dart';
import 'package:avatok_call/core/calls/video_quality_policy.dart';

void main() {
  final epoch = DateTime.utc(2026);
  VideoQualitySample sample(int seconds, {bool poor = false, double? bandwidth}) =>
      VideoQualitySample(at: epoch.add(Duration(seconds: seconds)),
        poorConnection: poor, availableBitrate: bandwidth);

  test('complete ladder is ordered and supports portrait dimensions', () {
    expect(VideoQualityRung.values.map((r) => r.height), [0, 480, 720, 1080, 1440, 2160]);
    expect(VideoQualityRung.forDimensions(2160, 3840), VideoQualityRung.p2160);
    expect(VideoQualityRung.forDimensions(960, 540), VideoQualityRung.p480);
    expect(VideoQualityRung.forDimensions(-1, 0), VideoQualityRung.audioOnly);
  });

  test('unknown capability is conservative; best respects known ceiling', () {
    expect(VideoQualityPolicy(mode: VideoQualityMode.best).requested, VideoQualityRung.p720);
    final policy = VideoQualityPolicy(mode: VideoQualityMode.best,
      capabilityCeiling: VideoQualityRung.p2160);
    expect(policy.requested, VideoQualityRung.p2160);
    policy.setMode(VideoQualityMode.dataSaver);
    expect(policy.requested, VideoQualityRung.p480);
    policy.setMode(VideoQualityMode.auto);
    expect(policy.requested, VideoQualityRung.p720);
  });

  test('brief bad sample does not downgrade; sustained bad samples do', () {
    final policy = VideoQualityPolicy();
    policy.observe(sample(0, poor: true));
    expect(policy.observe(sample(2, poor: true)), VideoQualityRung.p720);
    expect(policy.observe(sample(3, poor: true)), VideoQualityRung.p480);
    policy.observe(sample(4, poor: true));
    expect(policy.observe(sample(7, poor: true)), VideoQualityRung.p480);
    expect(policy.observe(sample(11, poor: true)), VideoQualityRung.audioOnly);
  });

  test('upgrade needs twenty seconds of fresh evidence and one rung at a time', () {
    final policy = VideoQualityPolicy(capabilityCeiling: VideoQualityRung.p2160);
    for (var second = 0; second < 20; second += 5) {
      expect(policy.observe(sample(second, bandwidth: 20000000)), VideoQualityRung.p720);
    }
    expect(policy.observe(sample(20, bandwidth: 20000000)), VideoQualityRung.p1080);
  });

  test('missing, stale and out-of-order samples cannot promote quality', () {
    final policy = VideoQualityPolicy(capabilityCeiling: VideoQualityRung.p2160);
    policy.observe(sample(0, bandwidth: 20000000));
    expect(policy.observe(sample(30, bandwidth: 20000000)), VideoQualityRung.p720);
    expect(policy.observe(sample(25, bandwidth: 20000000)), VideoQualityRung.p720);
    policy.observe(sample(35));
    expect(policy.observe(sample(40, bandwidth: 20000000)), VideoQualityRung.p720);
  });

  test('rejection lowers session ceiling and mode changes cannot retry it', () {
    final policy = VideoQualityPolicy(mode: VideoQualityMode.best,
      capabilityCeiling: VideoQualityRung.p2160);
    policy.reject(VideoQualityRung.p2160);
    expect(policy.requested, VideoQualityRung.p1440);
    policy.setMode(VideoQualityMode.dataSaver);
    policy.setMode(VideoQualityMode.best);
    expect(policy.requested, VideoQualityRung.p1440);
  });

  test('data saver cannot climb above 480p, even with abundant bandwidth', () {
    final policy = VideoQualityPolicy(mode: VideoQualityMode.dataSaver,
      capabilityCeiling: VideoQualityRung.p2160);
    for (var second = 0; second <= 120; second += 5) {
      policy.observe(sample(second, bandwidth: 20000000));
    }
    expect(policy.requested, VideoQualityRung.p480);
  });

  test('zero bandwidth reaches audio only and stable recovery returns to video', () {
    final policy = VideoQualityPolicy(mode: VideoQualityMode.dataSaver);
    policy.observe(sample(0, bandwidth: 0));
    expect(policy.observe(sample(3, bandwidth: 0)), VideoQualityRung.audioOnly);
    for (var second = 4; second <= 24; second += 5) {
      policy.observe(sample(second, bandwidth: 2000000));
    }
    expect(policy.requested, VideoQualityRung.p480);
  });

  test('unknown stored modes safely use Auto', () {
    expect(VideoQualityMode.fromStored('unexpected'), VideoQualityMode.auto);
    expect(VideoQualityMode.fromStored(null), VideoQualityMode.auto);
  });
}

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('media job lifecycle envelopes render only through their durable card', () {
    final inbound = File(
      'lib/features/avatok/chat_thread/inbound.dart',
    ).readAsStringSync();
    final media = File(
      'lib/features/avatok/chat_thread/media.dart',
    ).readAsStringSync();

    // Both DM and group ingest must suppress the live Ava lifecycle envelope
    // and hydrate the canonical card. This prevents one provider job from
    // becoming a READY card plus a second legacy Ava bubble.
    expect(
      RegExp(r'if \(!isMediaJobEnvelope\) _msgs\.add\(')
          .allMatches(inbound)
          .length,
      2,
      reason: 'DM and group paths must both treat media-job envelopes as non-visual',
    );
    expect(
      RegExp(r'if \(isMediaJobEnvelope\) unawaited\(_hydrateAiJobFromEnvelope\(extra\)\);')
          .allMatches(inbound)
          .length,
      2,
      reason: 'DM and group paths must both resolve their durable job card',
    );

    // Replays can contain a prior-format Ava envelope. The upsert must retire
    // it by job id, without sweeping unrelated Ava messages.
    expect(media, contains("m.special != 'ava' && m.special != 'ava_private'"));
    expect(media, contains("(meta['job_id'] ?? '').toString() == job.jobId"));
  });
}

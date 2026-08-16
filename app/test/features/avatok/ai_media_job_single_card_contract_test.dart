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

  test('legacy image status never renders a second compact placeholder', () {
    final specialContent = File(
      'lib/features/avatok/chat_thread/special_content.dart',
    ).readAsStringSync();

    // `ava_status` is emitted before an image job has an id and may arrive
    // after its tagged lifecycle envelope. Current clients must keep that
    // fallback signal non-visual and render only the durable full-size card.
    expect(specialContent, contains('if (isImage) return const SizedBox.shrink();'));
    expect(specialContent, isNot(contains('Widget _imageGeneratingCard(')));
    expect(specialContent, isNot(contains('width: 240,\n        height: 200,')));

    final card = File(
      'lib/features/avatok/widgets/ai_media_job_card.dart',
    ).readAsStringSync();
    expect(card, contains('this.width = double.infinity'));
    expect(card, contains('final previewSize = constraints.maxWidth.isFinite'));
  });

  test('video cards play and seek inline with generated share metadata', () {
    final card = File('lib/features/avatok/widgets/ai_media_job_card.dart').readAsStringSync();
    final media = File('lib/features/avatok/chat_thread/media.dart').readAsStringSync();
    expect(card, contains("job.kind == AiMediaJobKind.videoGenerate"));
    expect(card, contains("Made on AvaTOK AI"));
    expect(card, contains('job.videoTitle'));
    expect(card, contains('job.videoDescription'));
    expect(media, contains('createVideoShareLink'));
    expect(media, contains('job.thumbnailUrl'));
    expect(media, contains('_AiVideoJobPreview('));
    expect(media, contains('VideoProgressIndicator('));
    expect(media, contains('allowScrubbing: true'));
    expect(media, contains("'generated_video_inline_play'"));
    expect(media, contains('succeeded && !isVideo'));
    expect(media, contains("if (m.contains('mp4')) return 'mp4';"));
  });
}

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
      RegExp(
        r'if \(isMediaJobEnvelope\) \{\s*unawaited\(_hydrateAiJobFromEnvelope\(extra, timelineTs: m\.createdAt\)\);\s*\}',
      )
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
    //
    // [AVA-WORKING-DOTS-1] (2026-08-17) re-implemented this guarantee more
    // strongly, and the old assertion broke because it named an IMPLEMENTATION,
    // not the contract. It required the literal
    // `if (isImage) return const SizedBox.shrink();` inside `_avaStatusChip` —
    // an image-only early-return inside a per-message-row renderer. That whole
    // renderer is now gone: `ava_status` no longer renders as a message row for
    // ANY source, and the "Ava is working…" indicator is a single state-driven
    // synthetic list item (`_avaWorking`), so it cannot be duplicated per
    // message by construction. Asserting the deleted line would mean restoring
    // dead code to satisfy a test, so this now asserts the invariant itself:
    // no ava_status message-row renderer, and the row excluded from the list.
    //
    // The point of the original test is preserved exactly — an `ava_status`
    // frame must never paint a second, smaller placeholder next to the durable
    // `ai_job` card. Both assertions below fail if that regresses.
    expect(specialContent, isNot(contains('Widget _avaStatusChip(')),
        reason: 'ava_status must not have a per-message-row renderer — that is '
            'what produced a second compact placeholder beside the job card.');
    final thread = File(
      'lib/features/avatok/chat_thread.dart',
    ).readAsStringSync();
    expect(thread, contains("m.special != 'ava_status'"),
        reason: 'ava_status rows must stay excluded from the rendered message '
            'list; the working indicator is drawn once from _avaWorking state.');
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

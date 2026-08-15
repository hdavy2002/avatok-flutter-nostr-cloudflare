import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('ready music jobs use the shared player with seek and file sharing', () {
    final media = File(
      'lib/features/avatok/chat_thread/media.dart',
    ).readAsStringSync();
    final musicPreview = media.substring(
      media.indexOf('class _AiMusicJobPreview'),
      media.indexOf('class _AiMusicCoverImage'),
    );

    expect(media, contains('class _AiMusicJobPreview extends StatelessWidget'));
    expect(media, contains('AudioPlaybackService.I.state'));
    expect(media, contains('AudioPlaybackService.I.seek'));
    expect(media, contains('AudioPlaybackService.I.pause()'));
    expect(media, contains('AudioPlaybackService.I.resume()'));
    expect(media, contains(r"tooltip: 'Share $title'"));
    expect(media, contains("return 'Ava original';"));
    expect(media, contains("final songTitle = (job.songTitle ?? '').trim();"));
    expect(media, contains("job.songDescription!.trim()"));
    expect(media, contains('class _AiMusicCoverImage extends StatefulWidget'));
    expect(media, contains('onResult: (ok) => unawaited(_onResult(ok))'));
    expect(media, contains("'image/webp' => 'webp'"));
    expect(media, contains('Artwork is optional.'));
    expect(musicPreview, contains('AspectRatio('));
    expect(musicPreview, contains('aspectRatio: 1'));
    expect(musicPreview, contains('LayoutBuilder('));
    expect(musicPreview, contains('width: constraints.maxWidth'));
    expect(musicPreview, isNot(contains('height: width')));
    expect(musicPreview, isNot(contains('required this.width')));
    expect(media, contains('style: ADText.threadName(c: Colors.black)'));
    expect(media, isNot(contains("'AVATOK ORIGINAL'")));
    expect(media, contains('createSongShareLink(fresh.jobId)'));
    expect(media, contains("'share_kind': 'song_link'"));
    expect(media, contains("text: '\$title\\n\$description'"));
    expect(media, contains("'with_cover': files.length > 1"));
  });
}

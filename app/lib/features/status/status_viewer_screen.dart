import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../../core/avatar.dart';
import '../../core/status_store.dart';
import '../../core/ui/avatok_dark.dart';
import '../../identity/identity.dart';
import '../avatok/contact_profile_screen.dart';
import '../avatok/media.dart';
import '../avatok/video_player_screen.dart';

/// [STATUS-FANOUT-1] Full-screen status playback for ONE author — owner spec
/// 2026-07-15:
///
///   "when they click on his profile icon. It will show the status of the person
///    as a video play back. give a back button in the header, when clicked the
///    video or image screen dissapears and he is back to the chat threads. now
///    inside the video or image slideshow screen, put the users profile icon
///    without any animated circle. when user clicks on that profile icon, he can
///    [see] all the details about the user, like his email, his qr code, avatok
///    number etc."
///
/// The avatar in THIS header is deliberately plain — no ring. The ring means
/// "there's a status to see"; you are already looking at it, so repeating it here
/// would be noise, and the icon has a different job now (open the profile).
class StatusViewerScreen extends StatefulWidget {
  /// This author's live statuses, newest first.
  final List<StatusPost> posts;
  final String authorName;
  final String authorUid;
  final String? authorAvatarUrl;
  final Identity? me;
  const StatusViewerScreen({
    super.key,
    required this.posts,
    required this.authorName,
    required this.authorUid,
    this.authorAvatarUrl,
    this.me,
  });

  @override
  State<StatusViewerScreen> createState() => _StatusViewerScreenState();
}

class _StatusViewerScreenState extends State<StatusViewerScreen> {
  int _i = 0;

  StatusPost get _post => widget.posts[_i];

  void _next() {
    // Last one → back to the chat threads, which is where the user came from.
    if (_i >= widget.posts.length - 1) {
      Navigator.of(context).maybePop();
      return;
    }
    setState(() => _i++);
  }

  void _prev() {
    if (_i > 0) setState(() => _i--);
  }

  void _openProfile() {
    Navigator.push(
      context,
      MaterialPageRoute<void>(
        builder: (_) => ContactProfileScreen(
          name: widget.authorName,
          uid: widget.authorUid,
          me: widget.me,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = _post;
    return Scaffold(
      backgroundColor: Colors.black,
      body: SafeArea(
        child: Stack(children: [
          // Tap left third = previous, right two-thirds = next (story convention).
          Positioned.fill(
            child: Row(children: [
              Expanded(flex: 1, child: GestureDetector(
                  behavior: HitTestBehavior.opaque, onTap: _prev, child: const SizedBox.expand())),
              Expanded(flex: 2, child: GestureDetector(
                  behavior: HitTestBehavior.opaque, onTap: _next, child: const SizedBox.expand())),
            ]),
          ),
          Positioned.fill(child: IgnorePointer(child: Center(child: _media(p)))),
          Positioned(top: 0, left: 0, right: 0, child: _header()),
        ]),
      ),
    );
  }

  Widget _media(StatusPost p) {
    if (p.media == null) {
      return Padding(
        padding: const EdgeInsets.all(28),
        child: Text(p.text ?? '',
            textAlign: TextAlign.center,
            style: ADText.bubbleBody().copyWith(fontSize: 20)),
      );
    }
    final media = ChatMedia.fromEnvelope(p.media!);
    if (p.kind == 'video') {
      // Reuse the shared player rather than a second video stack. It is pushed
      // (not embedded) so its own controls/lifecycle stay intact; `bytes: null`
      // lets it run its usual download+decrypt.
      return _VideoTapThrough(media: media);
    }
    return FutureBuilder<Uint8List>(
      future: MediaService.downloadAndDecrypt(media),
      builder: (_, s) => s.hasData
          ? Image.memory(s.data!, fit: BoxFit.contain)
          : const CircularProgressIndicator(color: AD.iconSearch),
    );
  }

  Widget _header() => Container(
        padding: const EdgeInsets.fromLTRB(6, 8, 14, 10),
        decoration: const BoxDecoration(
          // Scrim: white glyphs must stay legible over a bright photo.
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Color(0xCC000000), Color(0x00000000)],
          ),
        ),
        child: Row(children: [
          // Owner spec: back button in the header → straight back to the threads.
          AdBackButton(onTap: () => Navigator.of(context).maybePop()),
          const SizedBox(width: 6),
          // PLAIN avatar — no animated ring in here, on purpose (see class doc).
          GestureDetector(
            onTap: _openProfile,
            child: Avatar(
              seed: widget.authorUid,
              name: widget.authorName,
              size: 34,
              avatarUrl: (widget.authorAvatarUrl ?? '').isEmpty ? null : widget.authorAvatarUrl,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: GestureDetector(
              onTap: _openProfile,
              child: Text(widget.authorName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: ADText.threadName()),
            ),
          ),
          if (widget.posts.length > 1)
            Text('${_i + 1}/${widget.posts.length}',
                style: ADText.statCaption(c: AD.textSecondary)),
        ]),
      );
}

/// Plays a video status inline by handing off to the shared [VideoPlayerScreen]
/// on first frame. Kept separate so the viewer's tap-zones don't fight the
/// player's own gesture handling.
class _VideoTapThrough extends StatefulWidget {
  final ChatMedia media;
  const _VideoTapThrough({required this.media});
  @override
  State<_VideoTapThrough> createState() => _VideoTapThroughState();
}

class _VideoTapThroughState extends State<_VideoTapThrough> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      Navigator.push(
        context,
        MaterialPageRoute<void>(builder: (_) => VideoPlayerScreen(media: widget.media)),
      ).then((_) {
        // Player dismissed → leave the viewer too, so one back-press from the
        // video lands the user on the chat threads rather than a blank shell.
        if (mounted) Navigator.of(context).maybePop();
      });
    });
  }

  @override
  Widget build(BuildContext context) =>
      const Center(child: CircularProgressIndicator(color: AD.iconSearch));
}

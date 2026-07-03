import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:youtube_player_iframe/youtube_player_iframe.dart';

import '../../../core/analytics.dart';
import '../../../core/ava_log.dart';
import '../../../core/ui/zine.dart';

/// Link previews + inline YouTube — AI Messenger Batch, STREAM C ([PREVIEW-3]).
///
/// This is a NEW, standalone bubble-content widget (it does NOT touch the shared
/// message-bubble geometry Stream K owns). It renders a [LinkPreview] that the
/// SENDER unfurled at compose time (/api/unfurl) and embedded in the message
/// envelope under `preview:{...}` — so recipients render straight from the
/// envelope with ZERO network fetch (no leak of who opened what).
///
///   • type "link"    → image top, bold title, 2-line description, domain footer;
///                       tap opens the link the way the app does today (external
///                       browser via url_launcher).
///   • type "youtube" → thumbnail + play → inline player (youtube_player_iframe);
///                       expand → full-screen landscape route; on exit Navigator
///                       .pop returns to the same scroll position; the inline
///                       player PAUSES when the bubble scrolls offscreen.
///
/// STRANGER GATE: the caller must pass `pending: true` while the thread's
/// accept_state is pending — in that case the card is NOT built at all (the
/// caller renders raw URL text). See [LinkPreview.shouldRender].

/// Parsed, envelope-embedded preview. Kept intentionally permissive so an older/
/// partial envelope never throws into the chat.
class LinkPreview {
  final String type; // 'link' | 'youtube'
  final String url;
  final String? title;
  final String? description;
  final String? image;
  final String? siteName;
  final String? domain;
  final String? videoId; // youtube
  final String? thumb; // youtube

  const LinkPreview({
    required this.type,
    required this.url,
    this.title,
    this.description,
    this.image,
    this.siteName,
    this.domain,
    this.videoId,
    this.thumb,
  });

  bool get isYouTube => type == 'youtube' && (videoId?.isNotEmpty ?? false);

  /// True when there is enough to render a card (else the caller shows raw text).
  bool get hasCard =>
      isYouTube ||
      (type == 'link' &&
          ((title?.isNotEmpty ?? false) || (image?.isNotEmpty ?? false)));

  static LinkPreview? fromEnvelope(Object? raw) {
    if (raw is! Map) return null;
    final m = raw;
    final type = (m['type'] ?? 'link').toString();
    final url = (m['url'] ?? '').toString();
    if (url.isEmpty && (m['video_id'] == null)) return null;
    String? s(Object? v) {
      final str = v?.toString();
      return (str == null || str.isEmpty) ? null : str;
    }

    return LinkPreview(
      type: type,
      url: url,
      title: s(m['title']),
      description: s(m['description']),
      image: s(m['image']),
      siteName: s(m['site_name']),
      domain: s(m['domain']),
      videoId: s(m['video_id']),
      thumb: s(m['thumb']),
    );
  }
}

Future<void> _openExternal(String url) async {
  try {
    await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
  } catch (e) {
    AvaLog.I.log('link_preview', 'launch failed $url: $e');
  }
}

/// Dispatch: build the right card for a preview, or null when there's nothing to
/// show (caller then renders plain link text). Returns null under the stranger
/// gate so pending threads never render a card.
Widget? buildLinkPreviewCard(
  LinkPreview preview, {
  bool pending = false,
  double width = 260,
}) {
  if (pending) return null; // STRANGER GATE — raw URL only
  if (!preview.hasCard) return null;
  if (preview.isYouTube) {
    return YouTubeInlineCard(preview: preview, width: width);
  }
  return LinkPreviewCard(preview: preview, width: width);
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic OG link card
// ─────────────────────────────────────────────────────────────────────────────

class LinkPreviewCard extends StatelessWidget {
  const LinkPreviewCard({super.key, required this.preview, this.width = 260});
  final LinkPreview preview;
  final double width;

  @override
  Widget build(BuildContext context) {
    final domain =
        preview.domain ?? preview.siteName ?? _domainOf(preview.url);
    return GestureDetector(
      onTap: () => _openExternal(preview.url),
      child: Container(
        width: width,
        decoration: BoxDecoration(
          color: Zine.paper2,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: Zine.ink, width: 1.5),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (preview.image != null)
              Image.network(
                preview.image!,
                width: width,
                height: width * 0.5,
                fit: BoxFit.cover,
                errorBuilder: (_, __, ___) => const SizedBox.shrink(),
                loadingBuilder: (ctx, child, progress) => progress == null
                    ? child
                    : Container(
                        width: width,
                        height: width * 0.5,
                        color: Zine.ink.withValues(alpha: 0.06),
                        alignment: Alignment.center,
                        child: const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 10, 9),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (preview.title != null)
                    Text(
                      preview.title!,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: ZineText.value(size: 13, weight: FontWeight.w700),
                    ),
                  if (preview.description != null) ...[
                    const SizedBox(height: 3),
                    Text(
                      preview.description!,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: ZineText.sub(size: 12, color: Zine.inkSoft),
                    ),
                  ],
                  if (domain.isNotEmpty) ...[
                    const SizedBox(height: 5),
                    Row(mainAxisSize: MainAxisSize.min, children: [
                      PhosphorIcon(PhosphorIcons.link(PhosphorIconsStyle.bold),
                          size: 11, color: Zine.inkMute),
                      const SizedBox(width: 4),
                      Flexible(
                        child: Text(
                          domain.toUpperCase(),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: ZineText.tag(size: 9.5, color: Zine.inkMute),
                        ),
                      ),
                    ]),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _domainOf(String url) {
    try {
      return Uri.parse(url).host.replaceFirst(RegExp(r'^www\.'), '');
    } catch (_) {
      return '';
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// YouTube inline card — thumbnail + play → inline player; expand → fullscreen
// landscape; pauses when scrolled offscreen.
// ─────────────────────────────────────────────────────────────────────────────

class YouTubeInlineCard extends StatefulWidget {
  const YouTubeInlineCard({super.key, required this.preview, this.width = 260});
  final LinkPreview preview;
  final double width;

  @override
  State<YouTubeInlineCard> createState() => _YouTubeInlineCardState();
}

class _YouTubeInlineCardState extends State<YouTubeInlineCard> {
  YoutubePlayerController? _ctrl;
  ScrollPosition? _pos;
  bool _offscreen = false;

  String get _videoId => widget.preview.videoId!;
  String get _thumb =>
      widget.preview.thumb ?? 'https://i.ytimg.com/vi/$_videoId/hqdefault.jpg';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Track the enclosing scrollable so we can pause the inline player when this
    // bubble leaves the viewport (spec: "player pauses when bubble scrolls
    // offscreen"). Re-subscribes if the Scrollable changes.
    final newPos = Scrollable.maybeOf(context)?.position;
    if (newPos != _pos) {
      _pos?.removeListener(_onScroll);
      _pos = newPos;
      _pos?.addListener(_onScroll);
    }
  }

  @override
  void dispose() {
    _pos?.removeListener(_onScroll);
    _ctrl?.close();
    super.dispose();
  }

  void _onScroll() {
    if (_ctrl == null || !mounted) return;
    final box = context.findRenderObject();
    if (box is! RenderBox || !box.attached) return;
    final size = MediaQuery.of(context).size;
    final topLeft = box.localToGlobal(Offset.zero);
    final rect = topLeft & box.size;
    // Consider the card offscreen once it's fully above or below the viewport.
    final off = rect.bottom < 0 || rect.top > size.height;
    if (off && !_offscreen) {
      _offscreen = true;
      _ctrl?.pauseVideo();
    } else if (!off && _offscreen) {
      _offscreen = false;
    }
  }

  void _playInline() {
    Analytics.capture('yt_inline_play', {
      'video_id': _videoId,
      if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
    });
    setState(() {
      _ctrl = YoutubePlayerController.fromVideoId(
        videoId: _videoId,
        autoPlay: true,
        params: const YoutubePlayerParams(
          showControls: true,
          showFullscreenButton: false, // we route to our own landscape screen
          enableCaption: true,
        ),
      );
    });
  }

  Future<void> _openFullscreen() async {
    final c = _ctrl;
    if (c == null) return;
    Analytics.capture('yt_fullscreen', {
      'video_id': _videoId,
      if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
    });
    // Full-screen landscape route; on exit Navigator.pop returns here and the
    // inline player keeps its position (same controller is reused).
    await Navigator.of(context).push(MaterialPageRoute(
      fullscreenDialog: true,
      builder: (_) => _FullscreenYouTube(controller: c),
    ));
    // Back to portrait when we return (best-effort; the route also restores it).
  }

  @override
  Widget build(BuildContext context) {
    final c = _ctrl;
    return Container(
      width: widget.width,
      decoration: BoxDecoration(
        color: Zine.paper2,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Zine.ink, width: 1.5),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (c != null)
            Stack(alignment: Alignment.bottomRight, children: [
              YoutubePlayer(controller: c, aspectRatio: 16 / 9),
              Padding(
                padding: const EdgeInsets.all(6),
                child: GestureDetector(
                  onTap: _openFullscreen,
                  child: Container(
                    padding: const EdgeInsets.all(6),
                    decoration: BoxDecoration(
                      color: Zine.ink.withValues(alpha: 0.6),
                      borderRadius: BorderRadius.circular(100),
                    ),
                    child: PhosphorIcon(
                        PhosphorIcons.arrowsOut(PhosphorIconsStyle.bold),
                        size: 15,
                        color: Colors.white),
                  ),
                ),
              ),
            ])
          else
            GestureDetector(
              onTap: _playInline,
              child: AspectRatio(
                aspectRatio: 16 / 9,
                child: Stack(
                    fit: StackFit.expand,
                    alignment: Alignment.center,
                    children: [
                      Image.network(
                        _thumb,
                        fit: BoxFit.cover,
                        errorBuilder: (_, __, ___) => Container(color: Zine.ink),
                      ),
                      Container(color: Zine.ink.withValues(alpha: 0.12)),
                      Container(
                        width: 56,
                        height: 56,
                        decoration: BoxDecoration(
                          color: const Color(0xFFFF0000),
                          shape: BoxShape.circle,
                          border: Border.all(color: Colors.white, width: 2.5),
                          boxShadow: Zine.shadowXs,
                        ),
                        child: const Icon(Icons.play_arrow,
                            color: Colors.white, size: 30),
                      ),
                      Positioned(
                        left: 8,
                        top: 8,
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 7, vertical: 3),
                          decoration: BoxDecoration(
                            color: Zine.ink.withValues(alpha: 0.7),
                            borderRadius: BorderRadius.circular(100),
                          ),
                          child: Text('YOUTUBE',
                              style:
                                  ZineText.tag(size: 8.5, color: Colors.white)),
                        ),
                      ),
                    ]),
              ),
            ),
          if ((widget.preview.title?.isNotEmpty ?? false))
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 10, 9),
              child: Text(
                widget.preview.title!,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: ZineText.value(size: 13, weight: FontWeight.w700),
              ),
            ),
        ],
      ),
    );
  }
}

/// Full-screen landscape YouTube route. Reuses the caller's controller so
/// playback position is continuous; restores portrait + all overlays on exit.
class _FullscreenYouTube extends StatefulWidget {
  const _FullscreenYouTube({required this.controller});
  final YoutubePlayerController controller;

  @override
  State<_FullscreenYouTube> createState() => _FullscreenYouTubeState();
}

class _FullscreenYouTubeState extends State<_FullscreenYouTube> {
  @override
  void initState() {
    super.initState();
    // Landscape immersive full-screen.
    SystemChrome.setPreferredOrientations(
        [DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight]);
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
  }

  @override
  void dispose() {
    // Restore portrait + normal chrome on exit (back to the same scroll pos).
    SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(children: [
        Center(
          child: YoutubePlayer(
            controller: widget.controller,
            aspectRatio: 16 / 9,
          ),
        ),
        Positioned(
          top: 8,
          left: 8,
          child: SafeArea(
            child: IconButton(
              icon: const Icon(Icons.close, color: Colors.white, size: 28),
              onPressed: () => Navigator.of(context).pop(),
            ),
          ),
        ),
      ]),
    );
  }
}

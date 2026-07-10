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
  final bool isVideo; // paint a play badge over the thumbnail
  final int? duration; // seconds → duration pill
  final int? imageWidth; // intrinsic thumb size (og:image:width/height)
  final int? imageHeight;

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
    this.isVideo = false,
    this.duration,
    this.imageWidth,
    this.imageHeight,
  });

  /// The thumbnail's true aspect ratio when the server told us the dimensions.
  /// Null → the card measures the decoded image itself.
  double? get imageAspect =>
      (imageWidth != null && imageHeight != null && imageHeight! > 0)
          ? imageWidth! / imageHeight!
          : null;

  /// A YouTube Short's `oardefault.jpg` occasionally 404s; fall back to the
  /// always-present (letterboxed) hqdefault rather than showing a grey box.
  String? get fallbackImage =>
      isYouTube ? 'https://i.ytimg.com/vi/$videoId/hqdefault.jpg' : null;

  bool get isYouTube => type == 'youtube' && (videoId?.isNotEmpty ?? false);

  /// The best available image for the card (youtube thumb or og:image).
  String? get displayImage => isYouTube
      ? (thumb ?? 'https://i.ytimg.com/vi/$videoId/hqdefault.jpg')
      : image;

  /// Host without `www.`, lowercase — the WhatsApp footer text.
  String get displayDomain {
    if (domain != null && domain!.isNotEmpty) return domain!.toLowerCase();
    try {
      return Uri.parse(url).host.replaceFirst(RegExp(r'^www\.'), '').toLowerCase();
    } catch (_) {
      return siteName?.toLowerCase() ?? '';
    }
  }

  /// Favicon for the footer row (WhatsApp shows the site's own mark).
  String? get faviconUrl {
    final d = displayDomain;
    if (d.isEmpty) return null;
    return 'https://www.google.com/s2/favicons?sz=64&domain=$d';
  }

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

    final dur = int.tryParse((m['duration'] ?? '').toString());
    final iw = int.tryParse((m['image_width'] ?? '').toString());
    final ih = int.tryParse((m['image_height'] ?? '').toString());
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
      isVideo: m['is_video'] == true || type == 'youtube',
      duration: (dur != null && dur > 0) ? dur : null,
      imageWidth: (iw != null && iw > 0) ? iw : null,
      imageHeight: (ih != null && ih > 0) ? ih : null,
    );
  }
}

/// Aspect-ratio bounds. A thumbnail is shown at its TRUE ratio, clamped so a
/// freak 1:5 banner can't eat the whole thread. 9:16 = full vertical reel/Short.
const double _kMinAspect = 9 / 16; // tallest we'll go (portrait video)
const double _kMaxAspect = 1.91;   // widest (the standard OG hero)
double _clampAspect(double a) => a.clamp(_kMinAspect, _kMaxAspect);

/// An image that renders at its own aspect ratio. If the server supplied
/// og:image:width/height we use that immediately (no layout jump); otherwise we
/// start at [fallbackAspect] and snap to the true ratio once the image decodes.
class _AutoAspectImage extends StatefulWidget {
  const _AutoAspectImage({
    required this.url,
    this.fallbackUrl,
    this.knownAspect,
    this.fallbackAspect = 1.91,
    this.overlay = const [],
  });

  final String url;
  final String? fallbackUrl;
  final double? knownAspect;
  final double fallbackAspect;
  final List<Widget> overlay;

  @override
  State<_AutoAspectImage> createState() => _AutoAspectImageState();
}

class _AutoAspectImageState extends State<_AutoAspectImage> {
  double? _measured;
  ImageStream? _stream;
  ImageStreamListener? _listener;
  bool _errored = false;

  double get _aspect =>
      _clampAspect(widget.knownAspect ?? _measured ?? widget.fallbackAspect);

  String get _src => (_errored && widget.fallbackUrl != null)
      ? widget.fallbackUrl!
      : widget.url;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (widget.knownAspect == null) _resolve();
  }

  void _resolve() {
    _detach();
    final provider = NetworkImage(_src);
    _stream = provider.resolve(createLocalImageConfiguration(context));
    _listener = ImageStreamListener((info, _) {
      final w = info.image.width.toDouble();
      final h = info.image.height.toDouble();
      if (!mounted || h <= 0) return;
      final a = w / h;
      if (_measured != a) setState(() => _measured = a);
    }, onError: (_, __) {
      if (mounted && !_errored && widget.fallbackUrl != null) {
        setState(() => _errored = true);
      }
    });
    _stream!.addListener(_listener!);
  }

  void _detach() {
    if (_stream != null && _listener != null) _stream!.removeListener(_listener!);
    _stream = null;
    _listener = null;
  }

  @override
  void dispose() {
    _detach();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AspectRatio(
      aspectRatio: _aspect,
      child: Stack(fit: StackFit.expand, children: [
        Image.network(
          _src,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) {
            if (!_errored && widget.fallbackUrl != null) {
              WidgetsBinding.instance.addPostFrameCallback((_) {
                if (mounted) setState(() => _errored = true);
              });
            }
            return Container(color: Zine.ink.withValues(alpha: 0.06));
          },
          loadingBuilder: (ctx, child, progress) => progress == null
              ? child
              : Container(
                  color: Zine.ink.withValues(alpha: 0.06),
                  alignment: Alignment.center,
                  child: const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                ),
        ),
        ...widget.overlay,
      ]),
    );
  }
}

String _fmtDuration(int secs) {
  final h = secs ~/ 3600;
  final m = (secs % 3600) ~/ 60;
  final s = secs % 60;
  final two = (int n) => n.toString().padLeft(2, '0');
  return h > 0 ? '$h:${two(m)}:${two(s)}' : '$m:${two(s)}';
}

/// The dark translucent play badge WhatsApp/Instagram paint over a video
/// thumbnail (replaces the old oversized red YouTube disc).
///
/// Nothing here is a fixed pixel size: the badge is a fraction of whatever box
/// it lands in (clamped so it stays tappable on a tiny compose thumb and doesn't
/// balloon on a tablet), so it scales with the card, which scales with the
/// bubble, which scales with the viewport.
class _PlayBadge extends StatelessWidget {
  const _PlayBadge({this.size, this.fraction = 0.18});

  /// Explicit size — only used by the tiny compose thumbnail. Otherwise null.
  final double? size;

  /// Badge diameter as a fraction of the shortest side of the parent box.
  final double fraction;

  @override
  Widget build(BuildContext context) {
    if (size != null) return _disc(size!);
    return LayoutBuilder(builder: (ctx, cons) {
      final short = (cons.maxWidth.isFinite && cons.maxHeight.isFinite)
          ? (cons.maxWidth < cons.maxHeight ? cons.maxWidth : cons.maxHeight)
          : (cons.maxWidth.isFinite ? cons.maxWidth : 240.0);
      return _disc((short * fraction).clamp(34.0, 72.0));
    });
  }

  Widget _disc(double d) => Container(
        width: d,
        height: d,
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.55),
          shape: BoxShape.circle,
          border: Border.all(color: Colors.white.withValues(alpha: 0.9), width: 1.5),
        ),
        child: Icon(Icons.play_arrow_rounded, color: Colors.white, size: d * 0.62),
      );
}

/// Bottom-left "0:56" pill.
class _DurationPill extends StatelessWidget {
  const _DurationPill({required this.seconds});
  final int seconds;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.65),
          borderRadius: BorderRadius.circular(4),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          const Icon(Icons.videocam_rounded, size: 11, color: Colors.white),
          const SizedBox(width: 3),
          Text(_fmtDuration(seconds),
              style: ZineText.tag(size: 9.5, color: Colors.white)),
        ]),
      );
}

/// Footer: favicon + lowercase domain (WhatsApp parity).
class _DomainFooter extends StatelessWidget {
  const _DomainFooter({required this.preview, this.padding =
      const EdgeInsets.fromLTRB(10, 0, 10, 9)});
  final LinkPreview preview;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    final d = preview.displayDomain;
    if (d.isEmpty) return const SizedBox.shrink();
    final fav = preview.faviconUrl;
    return Padding(
      padding: padding,
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (fav != null)
          ClipRRect(
            borderRadius: BorderRadius.circular(3),
            child: Image.network(fav, width: 13, height: 13,
                errorBuilder: (_, __, ___) => PhosphorIcon(
                    PhosphorIcons.link(PhosphorIconsStyle.bold),
                    size: 11, color: Zine.inkMute)),
          )
        else
          PhosphorIcon(PhosphorIcons.link(PhosphorIconsStyle.bold),
              size: 11, color: Zine.inkMute),
        const SizedBox(width: 5),
        Flexible(
          child: Text(d,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: ZineText.tag(size: 10, color: Zine.inkMute)),
        ),
      ]),
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
  double? width,
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
  const LinkPreviewCard({super.key, required this.preview, this.width});
  final LinkPreview preview;

  /// null → the card fills the bubble edge to edge (the default).
  final double? width;

  @override
  Widget build(BuildContext context) {
    final img = preview.displayImage;
    return GestureDetector(
      onTap: () => _openExternal(preview.url),
      child: Container(
        width: width ?? double.infinity,
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
            if (img != null)
              // Render at the media's TRUE aspect ratio: a vertical reel stays
              // vertical, a wide article hero stays wide. (Hard-coding 2:1 / 4:3
              // is what squashed Shorts and reels into letterboxed strips.)
              _AutoAspectImage(
                url: img,
                fallbackUrl: preview.fallbackImage,
                knownAspect: preview.imageAspect,
                fallbackAspect: preview.isVideo ? 1.0 : 1.91,
                overlay: [
                  if (preview.isVideo) ...[
                    const Center(child: _PlayBadge()),
                    if (preview.duration != null)
                      Positioned(
                        left: 8,
                        bottom: 8,
                        child: _DurationPill(seconds: preview.duration!),
                      ),
                  ],
                ],
              ),
            if (preview.title != null)
              Padding(
                padding: EdgeInsets.fromLTRB(
                    10, 8, 10, preview.description != null ? 0 : 6),
                child: Text(
                  preview.title!,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: ZineText.value(size: 13, weight: FontWeight.w700),
                ),
              ),
            if (preview.description != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(10, 3, 10, 6),
                child: Text(
                  preview.description!,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: ZineText.sub(size: 12, color: Zine.inkSoft),
                ),
              ),
            _DomainFooter(preview: preview),
          ],
        ),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compose-time preview (WhatsApp: the little card that pops above the keyboard
// the moment you paste a link, with an ✕ to dismiss it).
// ─────────────────────────────────────────────────────────────────────────────

class ComposeLinkPreview extends StatelessWidget {
  const ComposeLinkPreview({
    super.key,
    required this.preview,
    required this.onDismiss,
    this.loading = false,
  });

  final LinkPreview? preview;
  final VoidCallback onDismiss;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    final p = preview;
    return Container(
      margin: const EdgeInsets.fromLTRB(10, 8, 10, 2),
      decoration: BoxDecoration(
        color: Zine.card,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Zine.ink, width: 1.5),
      ),
      clipBehavior: Clip.antiAlias,
      child: Row(children: [
        SizedBox(
          width: 60,
          height: 60,
          child: loading || p?.displayImage == null
              ? Container(
                  color: Zine.ink.withValues(alpha: 0.06),
                  alignment: Alignment.center,
                  child: loading
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2))
                      : PhosphorIcon(PhosphorIcons.link(PhosphorIconsStyle.bold),
                          size: 18, color: Zine.inkMute),
                )
              : Stack(fit: StackFit.expand, children: [
                  Image.network(p!.displayImage!,
                      fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) =>
                          Container(color: Zine.ink.withValues(alpha: 0.06))),
                  if (p.isVideo) const Center(child: _PlayBadge(size: 24)),
                ]),
        ),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  loading
                      ? 'Fetching preview…'
                      : (p?.title ?? p?.displayDomain ?? 'Link'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: ZineText.value(size: 12.5, weight: FontWeight.w700),
                ),
                if (!loading && p != null) ...[
                  const SizedBox(height: 2),
                  Text(p.displayDomain,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ZineText.tag(size: 10, color: Zine.inkMute)),
                ],
              ],
            ),
          ),
        ),
        IconButton(
          visualDensity: VisualDensity.compact,
          icon: const Icon(Icons.close_rounded, size: 18),
          color: Zine.inkMute,
          onPressed: onDismiss,
          tooltip: 'Remove preview',
        ),
      ]),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// YouTube inline card — thumbnail + play → inline player; expand → fullscreen
// landscape; pauses when scrolled offscreen.
// ─────────────────────────────────────────────────────────────────────────────

class YouTubeInlineCard extends StatefulWidget {
  const YouTubeInlineCard({super.key, required this.preview, this.width});
  final LinkPreview preview;

  /// null → fills the bubble edge to edge.
  final double? width;

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
    // Shorts play vertically; regular videos stay 16:9.
    final playerAspect = _clampAspect(widget.preview.imageAspect ?? 16 / 9);
    return Container(
      width: widget.width ?? double.infinity,
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
              YoutubePlayer(controller: c, aspectRatio: playerAspect),
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
              child: _AutoAspectImage(
                url: _thumb,
                fallbackUrl: widget.preview.fallbackImage,
                knownAspect: widget.preview.imageAspect,
                fallbackAspect: 16 / 9,
                overlay: [
                  Container(color: Zine.ink.withValues(alpha: 0.10)),
                  const Center(child: _PlayBadge()),
                  if (widget.preview.duration != null)
                    Positioned(
                      left: 8,
                      bottom: 8,
                      child: _DurationPill(seconds: widget.preview.duration!),
                    ),
                ],
              ),
            ),
          if ((widget.preview.title?.isNotEmpty ?? false))
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 10, 6),
              child: Text(
                widget.preview.title!,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: ZineText.value(size: 13, weight: FontWeight.w700),
              ),
            ),
          _DomainFooter(preview: widget.preview),
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

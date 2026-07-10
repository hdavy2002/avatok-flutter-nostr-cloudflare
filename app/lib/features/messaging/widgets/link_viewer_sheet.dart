import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';
import 'package:youtube_player_iframe/youtube_player_iframe.dart';

import '../../../core/analytics.dart';
import '../../../core/ava_log.dart';
import '../../../core/ui/zine.dart';
import 'link_preview_card.dart';

/// In-app link viewer — the "draggable sheet + mini player" experience.
///
///   • Tap a preview card's thumbnail → the viewer slides up over the chat and
///     starts playing.
///   • Drag it DOWN → it shrinks to a mini player parked above the composer and
///     KEEPS PLAYING. The chat behind it is fully live: scroll, read, reply.
///   • Drag/tap the mini player → it expands back, at the same playback position.
///   • Swipe the mini player down (or tap ✕) → closes.
///
/// Why an Overlay and not a route: a route would cover the chat and freeze it.
/// The overlay lets the mini state hit-test as a small box, so every pixel
/// outside it still belongs to the thread underneath.
///
/// Why ONE viewer, never one-per-bubble: each embedded player is a full browser
/// engine (platform view). Stacking several inside a scrolling ListView is what
/// makes chat apps stutter and get OOM-killed on low-end Androids — so we host
/// exactly one, outside the list.
///
/// Only the THUMBNAIL opens this. Tapping a card's title/description/domain
/// deep-links out to the native YouTube/Instagram/Facebook app (owner decision
/// 2026-07-10) — see [buildLinkPreviewCard].

class LinkViewer {
  LinkViewer._();

  static OverlayEntry? _entry;
  static final GlobalKey<_LinkViewerHostState> _hostKey = GlobalKey();

  /// True while a viewer (expanded or mini) is on screen.
  static bool get isOpen => _entry != null;

  /// Hosts that must open in their OWN native app, never in our viewer (owner
  /// decision 2026-07-10). Meta and X don't serve real playback to embeds
  /// anyway — an in-app webview would just show a poster and a login wall, so
  /// deep-linking out is both the honest and the better experience.
  static const _nativeOnlyHosts = [
    'instagram.com',
    'facebook.com',
    'fb.watch',
    'fb.com',
    'threads.net',
    'threads.com',
    'twitter.com',
    'x.com',
    't.co',
  ];

  static bool _isNativeOnly(LinkPreview p) {
    final d = p.displayDomain;
    return _nativeOnlyHosts.any((h) => d == h || d.endsWith('.$h'));
  }

  /// Open (or swap the content of) the in-app viewer for [preview].
  static void open(BuildContext context, LinkPreview preview) {
    // Instagram / Facebook / Threads / X → straight to the native app.
    if (_isNativeOnly(preview)) {
      Analytics.capture('link_opened_native', {
        'domain': preview.displayDomain,
        if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
      });
      _openExternal(preview.url);
      return;
    }

    final overlay = Overlay.maybeOf(context, rootOverlay: true);
    if (overlay == null) {
      // No overlay (shouldn't happen inside MaterialApp) → don't lose the tap.
      _openExternal(preview.url);
      return;
    }

    Analytics.capture('link_viewer_opened', {
      'kind': _kindOf(preview),
      'domain': preview.displayDomain,
      if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
    });

    // Already showing this exact URL → just expand it again.
    final host = _hostKey.currentState;
    if (_entry != null && host != null && host.url == preview.url) {
      host.expand();
      return;
    }
    close(); // different link → tear the old one down first

    _entry = OverlayEntry(
      builder: (_) => _LinkViewerHost(key: _hostKey, preview: preview),
    );
    overlay.insert(_entry!);
  }

  static void close() {
    _entry?.remove();
    _entry = null;
  }

  static String _kindOf(LinkPreview p) {
    if (p.isYouTube) return 'youtube';
    final d = p.displayDomain;
    if (d.contains('instagram')) return 'instagram';
    if (d.contains('facebook') || d.contains('fb.watch')) return 'facebook';
    return p.isVideo ? 'video' : 'article';
  }
}

Future<void> _openExternal(String url) async {
  try {
    await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
  } catch (e) {
    AvaLog.I.log('link_viewer', 'launch failed $url: $e');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Host: owns the expanded ⇄ mini geometry. The CONTENT widget is built exactly
// once and reparented between states, so playback never restarts.
// ─────────────────────────────────────────────────────────────────────────────

const _kMiniWidth = 176.0;
const _kMiniMargin = 12.0;
const _kComposerGap = 96.0; // keep the mini player clear of the input bar

class _LinkViewerHost extends StatefulWidget {
  const _LinkViewerHost({super.key, required this.preview});
  final LinkPreview preview;

  @override
  State<_LinkViewerHost> createState() => _LinkViewerHostState();
}

class _LinkViewerHostState extends State<_LinkViewerHost>
    with SingleTickerProviderStateMixin {
  bool _mini = false;
  double _dragDy = 0; // live drag offset while the user's finger is down

  /// The player lives under a GlobalKey. Expanded and mini are structurally
  /// DIFFERENT subtrees, so without this Flutter tears the old element down and
  /// builds a fresh one — a brand-new WebView/controller, i.e. a black box with
  /// nothing playing. A GlobalKey lets the SAME State (and its platform view)
  /// be reparented between the two layouts, so playback continues uninterrupted.
  final GlobalKey _contentKey = GlobalKey();
  late final Widget _content; // built ONCE — never rebuilt across states

  String get url => widget.preview.url;

  /// The player's natural aspect ratio (vertical for a Short/reel).
  double get _aspect {
    final a = widget.preview.imageAspect;
    if (a == null) return 16 / 9;
    return a.clamp(9 / 16, 1.91);
  }

  @override
  void initState() {
    super.initState();
    _content = _ViewerContent(key: _contentKey, preview: widget.preview);
  }

  void expand() => setState(() {
        _mini = false;
        _dragDy = 0;
      });

  void _toMini() {
    Analytics.capture('link_viewer_minimized', {
      if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
    });
    setState(() {
      _mini = true;
      _dragDy = 0;
    });
  }

  void _onDragUpdate(DragUpdateDetails d) => setState(() => _dragDy += d.delta.dy);

  void _onDragEnd(DragEndDetails d) {
    final fling = d.velocity.pixelsPerSecond.dy;
    if (!_mini) {
      // Expanded: a decisive downward drag/fling parks it as a mini player.
      if (_dragDy > 90 || fling > 700) {
        _toMini();
      } else {
        setState(() => _dragDy = 0);
      }
      return;
    }
    // Mini: down = dismiss, up = expand.
    if (_dragDy > 60 || fling > 600) {
      LinkViewer.close();
    } else if (_dragDy < -40 || fling < -500) {
      expand();
    } else {
      setState(() => _dragDy = 0);
    }
  }

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    final size = media.size;

    if (_mini) {
      final w = _kMiniWidth;
      final h = (w / _aspect).clamp(90.0, 300.0);
      return Positioned(
        right: _kMiniMargin,
        bottom: _kComposerGap + media.padding.bottom - _dragDy.clamp(-200.0, 400.0),
        width: w,
        height: h,
        child: GestureDetector(
          onTap: expand,
          onVerticalDragUpdate: _onDragUpdate,
          onVerticalDragEnd: _onDragEnd,
          child: Material(
            color: Colors.black,
            elevation: 8,
            borderRadius: BorderRadius.circular(10),
            clipBehavior: Clip.antiAlias,
            child: Stack(children: [
              // While mini, the player must NOT eat pointer events: the whole
              // tile is one big "expand me" button (and a drag handle). The
              // video keeps playing underneath — IgnorePointer only blocks hit
              // testing, never rendering or playback.
              Positioned.fill(child: IgnorePointer(child: _content)),
              Positioned(
                top: 2,
                right: 2,
                child: _RoundIconButton(
                  icon: Icons.close_rounded,
                  size: 26,
                  onTap: LinkViewer.close,
                ),
              ),
            ]),
          ),
        ),
      );
    }

    // Expanded: a sheet over the chat. The scrim only covers the area ABOVE the
    // sheet, and tapping it parks the player rather than killing it.
    final sheetH = size.height * 0.86;
    final dy = _dragDy.clamp(0.0, sheetH);
    return Positioned.fill(
      child: Stack(children: [
        Positioned.fill(
          child: GestureDetector(
            onTap: _toMini,
            child: Container(color: Colors.black.withValues(alpha: 0.55)),
          ),
        ),
        Positioned(
          left: 0,
          right: 0,
          bottom: -dy,
          height: sheetH,
          child: Material(
            color: Zine.paper2,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(18)),
            clipBehavior: Clip.antiAlias,
            child: Column(children: [
              // Grab handle + actions. Dragging anywhere on this bar moves the
              // sheet; dragging on the player itself would fight the controls.
              GestureDetector(
                onVerticalDragUpdate: _onDragUpdate,
                onVerticalDragEnd: _onDragEnd,
                behavior: HitTestBehavior.opaque,
                child: Container(
                  padding: const EdgeInsets.fromLTRB(8, 8, 8, 6),
                  child: Row(children: [
                    _RoundIconButton(
                      icon: Icons.keyboard_arrow_down_rounded,
                      onTap: _toMini,
                      tooltip: 'Minimize',
                      dark: false,
                    ),
                    Expanded(
                      child: Center(
                        child: Container(
                          width: 44,
                          height: 4,
                          decoration: BoxDecoration(
                            color: Zine.inkMute,
                            borderRadius: BorderRadius.circular(100),
                          ),
                        ),
                      ),
                    ),
                    _RoundIconButton(
                      icon: Icons.open_in_new_rounded,
                      onTap: () => _openExternal(url),
                      tooltip: 'Open in app',
                      dark: false,
                    ),
                    const SizedBox(width: 4),
                    _RoundIconButton(
                      icon: Icons.close_rounded,
                      onTap: LinkViewer.close,
                      tooltip: 'Close',
                      dark: false,
                    ),
                  ]),
                ),
              ),
              Expanded(child: _content),
            ]),
          ),
        ),
      ]),
    );
  }
}

class _RoundIconButton extends StatelessWidget {
  const _RoundIconButton({
    required this.icon,
    required this.onTap,
    this.size = 32,
    this.tooltip,
    this.dark = true,
  });

  final IconData icon;
  final VoidCallback onTap;
  final double size;
  final String? tooltip;
  final bool dark;

  @override
  Widget build(BuildContext context) {
    final btn = GestureDetector(
      onTap: onTap,
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          color: dark ? Colors.black.withValues(alpha: 0.5) : Colors.transparent,
          shape: BoxShape.circle,
        ),
        child: Icon(icon,
            size: size * 0.62, color: dark ? Colors.white : Zine.ink),
      ),
    );
    return tooltip == null ? btn : Tooltip(message: tooltip!, child: btn);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Content: a real YouTube player for YouTube, a WebView for everything else.
// ─────────────────────────────────────────────────────────────────────────────

class _ViewerContent extends StatefulWidget {
  const _ViewerContent({super.key, required this.preview});
  final LinkPreview preview;

  @override
  State<_ViewerContent> createState() => _ViewerContentState();
}

class _ViewerContentState extends State<_ViewerContent> {
  YoutubePlayerController? _yt;
  WebViewController? _web;

  /// Latched so the hand-off to the YouTube app fires exactly once — the error
  /// value can rebuild the builder several times.
  bool _handedOff = false;

  /// The video refused to embed (uploader disabled off-site playback). Try it in
  /// AvaTOK, and the moment YouTube says no, hand the user straight to the
  /// YouTube app rather than parking them on a dead-end card (owner decision
  /// 2026-07-10). The card below stays behind as the landing state, so if the
  /// launch fails there's still a button to tap.
  void _handOffToYouTube() {
    if (_handedOff) return;
    _handedOff = true;
    Analytics.capture('link_viewer_embed_blocked_handoff', {
      'video_id': widget.preview.videoId ?? '',
      if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
    });
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      // Close the sheet first: returning from the YouTube app shouldn't dump the
      // user back onto a black player they can't use.
      LinkViewer.close();
      await _openExternal(widget.preview.url);
    });
  }

  @override
  void initState() {
    super.initState();
    if (widget.preview.isYouTube) {
      _yt = YoutubePlayerController.fromVideoId(
        videoId: widget.preview.videoId!,
        autoPlay: true,
        params: const YoutubePlayerParams(
          showControls: true,
          showFullscreenButton: true,
          enableCaption: true,
          playsInline: true,
          // NOTE (pinned version): youtube_player_iframe 5.2.0 has NO
          // `privacyEnhancedMode` field and no nocookie host — it always serves
          // youtube.com, and `origin` already defaults to this exact value. It's
          // stated explicitly so nobody "helpfully" removes it later.
          //
          // Nothing here rescues a video whose uploader disabled embedding
          // (YouTube codes 101/150/152). In 5.2.0's enum, 152 isn't listed and
          // therefore parses to YoutubeError.unknown — but `hasError` is still
          // true, which is what the fallback below keys off. Don't switch that
          // check to a specific enum member.
          origin: 'https://www.youtube.com',
        ),
      );
    } else {
      _web = _buildWebView(_embedUrl(widget.preview));
    }
  }

  WebViewController _buildWebView(String url) {
    final c = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(Colors.black)
      ..setNavigationDelegate(NavigationDelegate(
        onWebResourceError: (e) =>
            AvaLog.I.log('link_viewer', 'web error ${e.errorCode}: ${e.description}'),
      ))
      ..loadRequest(Uri.parse(url));
    // Android: let embedded <video> autoplay without a second tap (the user
    // already tapped the card). No-op on iOS, where playsInline covers it.
    final platform = c.platform;
    if (platform is AndroidWebViewController) {
      platform.setMediaPlaybackRequiresUserGesture(false);
    }
    return c;
  }

  /// Map a share URL to the host's official EMBED endpoint where one exists.
  /// Facebook's video plugin renders public videos; Instagram's /embed route
  /// renders the post but will show a poster + "View on Instagram" for reels
  /// (Meta does not serve reel playback to unauthenticated embeds). Anything
  /// else just loads the page.
  static String _embedUrl(LinkPreview p) {
    final d = p.displayDomain;
    final enc = Uri.encodeComponent(p.url);
    if (d.contains('facebook') || d.contains('fb.watch')) {
      return 'https://www.facebook.com/plugins/video.php'
          '?href=$enc&show_text=false&autoplay=true&mute=false';
    }
    if (d.contains('instagram')) {
      final m = RegExp(r'/(reel|reels|p|tv)/([A-Za-z0-9_-]+)').firstMatch(p.url);
      if (m != null) {
        final kind = m.group(1) == 'reels' ? 'reel' : m.group(1);
        return 'https://www.instagram.com/$kind/${m.group(2)}/embed/captioned/';
      }
    }
    return p.url;
  }

  @override
  void dispose() {
    _yt?.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final yt = _yt;
    if (yt != null) {
      return Container(
        color: Colors.black,
        alignment: Alignment.center,
        child: YoutubeValueBuilder(
          controller: yt,
          builder: (context, value) {
            if (value.hasError) {
              // Plays fine → we never get here. Doesn't → straight to YouTube.
              _handOffToYouTube();
              return _EmbedBlocked(preview: widget.preview);
            }
            return YoutubePlayer(
              controller: yt,
              aspectRatio: widget.preview.imageAspect?.clamp(9 / 16, 1.91) ??
                  16 / 9,
              // The player's own vertical-drag-to-fullscreen gesture would eat
              // our drag-down-to-mini-player gesture. Ours wins.
              enableFullScreenOnVerticalDrag: false,
              // Belt-and-braces with the GlobalKey: keep the platform view alive
              // when the widget is moved between the expanded and mini subtrees.
              keepAlive: true,
            );
          },
        ),
      );
    }
    return WebViewWidget(controller: _web!);
  }
}

/// Shown when YouTube refuses the embed (errors 101 / 150 / 152: the uploader
/// disabled playback on other sites). Previously this surfaced as an opaque
/// black rectangle with YouTube's own "Error code: 152-4" text.
class _EmbedBlocked extends StatelessWidget {
  const _EmbedBlocked({required this.preview});
  final LinkPreview preview;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.black,
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          PhosphorIcon(PhosphorIcons.lockKey(PhosphorIconsStyle.bold),
              size: 34, color: Colors.white70),
          const SizedBox(height: 12),
          Text(
            "This video can't be played here",
            textAlign: TextAlign.center,
            style: ZineText.value(size: 15, weight: FontWeight.w700)
                .copyWith(color: Colors.white),
          ),
          const SizedBox(height: 6),
          Text(
            'The uploader turned off playback outside YouTube.',
            textAlign: TextAlign.center,
            style: ZineText.sub(size: 12.5, color: Colors.white60),
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: () {
              Analytics.capture('link_viewer_embed_blocked_opened', {
                'video_id': preview.videoId ?? '',
                if (Analytics.currentEmail != null)
                  'email': Analytics.currentEmail!,
              });
              _openExternal(preview.url);
            },
            icon: const Icon(Icons.open_in_new_rounded, size: 17),
            label: const Text('Watch on YouTube'),
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFFFF0000),
              foregroundColor: Colors.white,
            ),
          ),
        ],
      ),
    );
  }
}

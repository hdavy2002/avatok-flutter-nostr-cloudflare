import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import '../data/models/reel.dart';
import 'theme.dart';

/// Plays one real reel (HF-WIRE-4): a direct file with `video_player` when the provider gave one, otherwise the
/// official embed (YouTube / Instagram) in a WebView. A direct file that fails (Instagram links expire) falls back to
/// the embed. The thumbnail shows until the video is ready. [active] plays; a page with [preload] only gets ready.
class ReelPlayer extends StatefulWidget {
  const ReelPlayer({super.key, required this.reel, required this.active, this.preload = false, this.sound = true});

  final FeedReel reel;
  final bool active;

  /// The next page: get the video ready but keep it paused.
  final bool preload;
  final bool sound;

  /// Tests replace the platform players with a stub. Receives the reel and whether it should be playing.
  @visibleForTesting
  static Widget Function(FeedReel reel, bool active)? override;

  /// The URL the embed WebView loads: autoplay, inline, no chrome, looping.
  @visibleForTesting
  static Uri embedUri(String embed) {
    final u = Uri.tryParse(embed);
    if (u == null) return Uri.parse('about:blank');
    final yt = RegExp(r'^/embed/([A-Za-z0-9_-]{6,20})$').firstMatch(u.path);
    if (u.host.contains('youtube') && yt != null) {
      return u.replace(queryParameters: {
        ...u.queryParameters,
        'autoplay': '1',
        'playsinline': '1',
        'controls': '0',
        'loop': '1',
        'rel': '0',
        'modestbranding': '1',
        'playlist': yt.group(1)!,
      });
    }
    return u;
  }

  @override
  State<ReelPlayer> createState() => _ReelPlayerState();
}

class _ReelPlayerState extends State<ReelPlayer> {
  VideoPlayerController? _video;
  bool _failed = false;
  bool _ready = false;
  WebViewController? _web;
  String? _webFor;

  bool get _wantVideo => widget.reel.videoUrl != null && !_failed;
  bool get _wantEmbed => !_wantVideo && widget.reel.embedUrl != null;
  bool get _needLive => widget.active || widget.preload;

  @override
  void initState() {
    super.initState();
    _sync();
  }

  @override
  void didUpdateWidget(covariant ReelPlayer old) {
    super.didUpdateWidget(old);
    _sync();
  }

  @override
  void dispose() {
    _video?.removeListener(_onVideo);
    _video?.dispose();
    super.dispose();
  }

  void _sync() {
    if (ReelPlayer.override != null) return;
    if (_wantVideo) {
      if (_needLive) {
        _startVideo();
      } else {
        _stopVideo();
      }
    } else {
      _stopVideo();
    }
    if (_wantEmbed && widget.active) {
      _startWeb();
    } else if (_web != null && !widget.active) {
      _web = null;
      _webFor = null;
    }
  }

  void _startVideo() {
    final c = _video;
    if (c == null) {
      final ctrl = VideoPlayerController.networkUrl(Uri.parse(widget.reel.videoUrl!));
      _video = ctrl;
      ctrl.addListener(_onVideo);
      ctrl.initialize().then((_) {
        if (!mounted || _video != ctrl) return;
        ctrl.setLooping(true);
        ctrl.setVolume(widget.sound ? 1 : 0);
        setState(() => _ready = true);
        if (widget.active) ctrl.play();
      }).catchError((Object _) {
        if (mounted && _video == ctrl) _fail();
      });
    } else if (_ready) {
      if (widget.active) {
        c.play();
      } else {
        c.pause();
      }
    }
  }

  void _stopVideo() {
    final c = _video;
    if (c == null) return;
    c.removeListener(_onVideo);
    c.dispose();
    _video = null;
    _ready = false;
  }

  void _onVideo() {
    final c = _video;
    if (c != null && c.value.hasError && !_failed) _fail();
  }

  void _fail() {
    _stopVideo();
    if (mounted) setState(() => _failed = true);
    _sync();
  }

  void _startWeb() {
    final embed = widget.reel.embedUrl!;
    if (_web != null && _webFor == embed) return;
    final c = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFF000000))
      ..setNavigationDelegate(NavigationDelegate(
        // The embed stays on its own page: no tapping out to other sites.
        onNavigationRequest: (r) => r.isMainFrame && r.url != ReelPlayer.embedUri(embed).toString() && !r.url.startsWith('https://www.youtube.com/embed/') && !r.url.startsWith('https://www.instagram.com/reel/')
            ? NavigationDecision.prevent
            : NavigationDecision.navigate,
      ));
    final p = c.platform;
    if (p is AndroidWebViewController) {
      p.setMediaPlaybackRequiresUserGesture(false); // lets the embed autoplay
    }
    c.loadRequest(ReelPlayer.embedUri(embed));
    _web = c;
    _webFor = embed;
  }

  Widget _thumb() {
    final t = widget.reel.thumbUrl;
    if (t == null) return const ColoredBox(color: C.cinema);
    return Image.network(t, fit: BoxFit.cover, errorBuilder: (_, __, ___) => const ColoredBox(color: C.cinema));
  }

  @override
  Widget build(BuildContext context) {
    final o = ReelPlayer.override;
    if (o != null) return o(widget.reel, widget.active);
    final v = _video;
    return Stack(
      fit: StackFit.expand,
      children: [
        _thumb(),
        if (_wantVideo && v != null && _ready)
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => v.value.isPlaying ? v.pause() : v.play(),
            child: FittedBox(fit: BoxFit.cover, clipBehavior: Clip.hardEdge, child: SizedBox(width: v.value.size.width, height: v.value.size.height, child: VideoPlayer(v))),
          ),
        if (_wantEmbed && widget.active && _web != null) WebViewWidget(controller: _web!),
      ],
    );
  }
}

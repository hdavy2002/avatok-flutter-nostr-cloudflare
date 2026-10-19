import 'dart:convert' show HtmlEscape, HtmlEscapeMode;

import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import '../core/brand.dart';
import '../data/models/reel.dart';
import 'theme.dart';

/// Plays one real reel. EMBEDS ONLY (HF-REEL-32, HF-WIRE-14): we never download or host a video file. YouTube plays
/// in the official YouTube player (its own controls and branding stay visible); Instagram plays in its official embed.
/// The thumbnail shows until the player is up. [active] plays; a page with [preload] is only kept ready.
class ReelPlayer extends StatefulWidget {
  const ReelPlayer({super.key, required this.reel, required this.active, this.preload = false, this.sound = true});

  final FeedReel reel;
  final bool active;

  /// The next page: keep it ready but do not start the player.
  final bool preload;
  final bool sound;

  /// Tests replace the platform players with a stub. Receives the reel and whether it should be playing.
  @visibleForTesting
  static Widget Function(FeedReel reel, bool active)? testPlayer;

  /// The URL of the embed. YouTube: autoplay, inline, loop, related videos limited to the same channel.
  /// No `controls=0` and no `modestbranding`: the official player and its branding stay as YouTube ships them.
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
        'loop': '1',
        'rel': '0',
        'origin': Brand.webOrigin,
        'playlist': yt.group(1)!,
      });
    }
    return u;
  }

  /// A small page holding the official YouTube iframe. YouTube needs to know who embeds it (a page origin), so the page
  /// is loaded with the site as its base URL instead of opening the embed address bare. Null for a non-YouTube embed.
  @visibleForTesting
  static String? youtubeHtml(String embed) {
    final u = Uri.tryParse(embed);
    if (u == null || !u.host.contains('youtube') || !RegExp(r'^/embed/[A-Za-z0-9_-]{6,20}$').hasMatch(u.path)) return null;
    final src = const HtmlEscape(HtmlEscapeMode.attribute).convert(embedUri(embed).toString());
    return '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}iframe{position:absolute;inset:0;width:100%;height:100%;border:0}</style></head>'
        '<body><iframe src="$src" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></body></html>';
  }

  @override
  State<ReelPlayer> createState() => _ReelPlayerState();
}

class _ReelPlayerState extends State<ReelPlayer> {
  WebViewController? _web;
  String? _webFor;

  bool get _wantEmbed => widget.reel.embedUrl != null;

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

  void _sync() {
    if (ReelPlayer.testPlayer != null) return;
    if (_wantEmbed && widget.active) {
      _startWeb();
    } else if (_web != null && !widget.active) {
      _web = null;
      _webFor = null;
    }
  }

  void _startWeb() {
    final embed = widget.reel.embedUrl!;
    if (_web != null && _webFor == embed) return;
    final c = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFF000000))
      ..setNavigationDelegate(NavigationDelegate(
        // The embed stays on its own page: no tapping out to other sites. Only YouTube / Instagram embeds and the
        // first page itself may load (about:blank and the site base URL belong to the small page that holds the iframe).
        onNavigationRequest: (r) {
          if (!r.isMainFrame) return NavigationDecision.navigate;
          final ok = r.url == 'about:blank' ||
              r.url == ReelPlayer.embedUri(embed).toString() ||
              r.url.startsWith('${Brand.webOrigin}/') ||
              r.url.startsWith('https://www.youtube.com/embed/') ||
              r.url.startsWith('https://www.instagram.com/reel/');
          return ok ? NavigationDecision.navigate : NavigationDecision.prevent;
        },
      ));
    final p = c.platform;
    if (p is AndroidWebViewController) {
      p.setMediaPlaybackRequiresUserGesture(false); // lets the embed autoplay
    }
    final html = ReelPlayer.youtubeHtml(embed);
    if (html != null) {
      c.loadHtmlString(html, baseUrl: Brand.webOrigin);
    } else {
      c.loadRequest(ReelPlayer.embedUri(embed));
    }
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
    final o = ReelPlayer.testPlayer;
    if (o != null) return o(widget.reel, widget.active);
    return Stack(
      fit: StackFit.expand,
      children: [
        _thumb(),
        if (_wantEmbed && widget.active && _web != null) WebViewWidget(controller: _web!),
      ],
    );
  }
}

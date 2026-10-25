import 'dart:async';
import 'dart:convert' show HtmlEscape, HtmlEscapeMode;

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import '../core/brand.dart';
import '../data/models/reel.dart';
import '../data/telemetry.dart';
import '../data/unplayable_reels.dart';
import '../ui/net_image.dart';
import 'theme.dart';

/// Whether the main Reels feed is on screen. The Reels tab stays alive offstage (indexed stack), so the feed must be told
/// when to stop: visible = the main shell is mounted AND its current tab is Reels AND no page, dialog or sheet is pushed above it.
/// Without a [MainShell] (tests, previews) it stays true. App background/foreground is handled by each [ReelPlayer].
class ReelGate {
  ReelGate._();

  static final ValueNotifier<bool> visible = ValueNotifier<bool>(true);
  static bool _managed = false;
  static ModalRoute<dynamic>? _shellRoute;
  static int _branch = 0;
  static final List<Route<dynamic>> _pages = [];

  /// Watches the root navigator for pages and modal overlays, including info and booking sheets.
  static final NavigatorObserver observer = _GateObserver();

  static void attachShell(ModalRoute<dynamic>? route) {
    _managed = true;
    _shellRoute = route;
    _recompute();
  }

  static void detachShell() {
    _shellRoute = null;
    WidgetsBinding.instance.addPostFrameCallback((_) => _recompute());
  }

  static void setBranch(int i) {
    if (_branch == i) return;
    _branch = i;
    _recompute();
  }

  static void _recompute() {
    final top = _pages.isEmpty ? null : _pages.last;
    final v =
        !_managed ||
        (_shellRoute != null &&
            _branch == 0 &&
            (top == null || identical(top, _shellRoute)));
    if (visible.value != v) visible.value = v;
  }
}

class _GateObserver extends NavigatorObserver {
  void _after(void Function() f) {
    f();
    // Navigator observers can fire during a build, so listeners are told after the frame, never synchronously.
    WidgetsBinding.instance.addPostFrameCallback((_) => ReelGate._recompute());
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) =>
      _after(() {
        if (route is ModalRoute) ReelGate._pages.add(route);
      });

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) =>
      _after(() => ReelGate._pages.remove(route));

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) =>
      _after(() => ReelGate._pages.remove(route));

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) =>
      _after(() {
        final i = oldRoute == null ? -1 : ReelGate._pages.indexOf(oldRoute);
        if (i >= 0) {
          if (newRoute is ModalRoute) {
            ReelGate._pages[i] = newRoute;
          } else {
            ReelGate._pages.removeAt(i);
          }
        } else if (newRoute is ModalRoute) {
          ReelGate._pages.add(newRoute);
        }
      });
}

/// Plays one real reel. EMBEDS ONLY (HF-REEL-32, HF-WIRE-14): we never download or host a video file. Every reel plays
/// from the official YouTube / Instagram embed, loaded in a WebView that WE control: a transparent tap layer sits on top
/// and passes play / pause down to the video through JavaScript (owner decision 2026-10-20, [HF-REEL-PLAYER-2]).
/// Instagram's own header / footer are pushed out of view (the video fills the page) and an "Open in Instagram" chip is
/// our own attribution. When a video cannot be started the card shows the poster with a "Watch on …" button.
/// The thumbnail shows until the player is up. [active] plays; a page with [preload] is only kept ready.
class ReelPlayer extends StatefulWidget {
  const ReelPlayer({
    super.key,
    required this.reel,
    required this.active,
    this.preload = false,
    this.sound = true,
    this.onUnplayable,
  });

  /// [HF-REEL-SKIP-1] Called with the reason when the reel can never play inside the app; the feed then removes it and
  /// reports it to the server ([HF-REEL-SKIP-2]).
  final void Function(String reason)? onUnplayable;

  final FeedReel reel;
  final bool active;

  /// The next page: keep it ready but do not start the player.
  final bool preload;
  final bool sound;

  /// Tests replace the platform players with a stub. Receives the reel and whether it should be playing.
  @visibleForTesting
  static Widget Function(FeedReel reel, bool active)? testPlayer;

  /// Tests: when set, no WebView is built but the tap layer, glyph and fallback card are, and every JavaScript call the
  /// player would make is handed to this function instead.
  @visibleForTesting
  static void Function(String js)? testRunJs;

  /// Tests: messages the page would send over the `HFPlayer` channel (`playing`, `paused`, `error:101` ...). Only read
  /// while [testRunJs] is set.
  @visibleForTesting
  static StreamController<String>? testMessages;

  /// Tests: stands in for opening the reel in the YouTube / Instagram app.
  @visibleForTesting
  static void Function(Uri url)? testLaunch;

  /// A phone Chrome user agent for Instagram's embed page (the default WebView one says it is an embedded browser).
  static const String mobileUserAgent =
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

  /// The page origin YouTube sees: sent as the Referer through the base URL and as the `origin` player parameter (stops
  /// embed errors 152 / 153). [HF-REEL-YT-ORIGIN-1] It is our real website: with the app's package id as a made-up
  /// https host, YouTube answered error 150 for every video, so every YouTube reel was dropped from the feed.
  static String get youtubeOrigin => 'https://${Brand.domain}';

  /// Accept the original public link when the feed has no separate embed URL.
  /// Only official provider hosts can become a player source.
  static String? sourceFor(FeedReel reel) {
    for (final value in [reel.embedUrl, reel.url]) {
      final u = Uri.tryParse(value ?? '');
      if (u == null || u.scheme != 'https') continue;
      final host = u.host.toLowerCase();
      if (host == 'youtu.be' ||
          host == 'youtube.com' ||
          host == 'www.youtube.com' ||
          host == 'm.youtube.com' ||
          host == 'www.youtube-nocookie.com') {
        final parts = u.pathSegments;
        final id = host == 'youtu.be'
            ? (parts.isEmpty ? null : parts.first)
            : u.queryParameters['v'] ??
                  (parts.length > 1 &&
                          ['embed', 'shorts', 'live'].contains(parts.first)
                      ? parts[1]
                      : null);
        if (id != null && RegExp(r'^[A-Za-z0-9_-]{6,20}$').hasMatch(id)) {
          return 'https://www.youtube.com/embed/$id';
        }
      }
      if (host == 'instagram.com' || host == 'www.instagram.com') {
        final parts = u.pathSegments;
        if (parts.length > 1 &&
            ['reel', 'reels', 'p', 'tv'].contains(parts.first) &&
            RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(parts[1])) {
          return 'https://www.instagram.com/reel/${parts[1]}/embed/';
        }
      }
    }
    return null;
  }

  /// The URL of the embed. YouTube: autoplay, inline, loop, related videos limited to the same channel.
  @visibleForTesting
  static Uri embedUri(String embed) {
    final u = Uri.tryParse(embed);
    if (u == null) return Uri.parse('about:blank');
    final yt = RegExp(r'^/embed/([A-Za-z0-9_-]{6,20})$').firstMatch(u.path);
    if (u.host.contains('youtube') && yt != null) {
      return u.replace(
        queryParameters: {
          ...u.queryParameters,
          'autoplay': '1',
          'playsinline': '1',
          'loop': '1',
          'rel': '0',
          'origin': Brand.webOrigin,
          'playlist': yt.group(1)!,
        },
      );
    }
    return u;
  }

  /// The Instagram page we open as the top-level page: `https://www.instagram.com/reel/<code>/embed/`. Anything that does
  /// not look like an Instagram post address is returned as it is.
  @visibleForTesting
  static Uri instagramUri(String embed) {
    final u = Uri.tryParse(embed);
    if (u == null || !u.host.contains('instagram')) return embedUri(embed);
    final m = RegExp(
      r'^/(?:reel|reels|p|tv)/([A-Za-z0-9_-]+)',
    ).firstMatch(u.path);
    if (m == null) return u;
    return Uri.parse('https://www.instagram.com/reel/${m.group(1)}/embed/');
  }

  /// The YouTube video id of an embed address, or null when it is not a YouTube embed.
  @visibleForTesting
  static String? youtubeId(String embed) {
    final u = Uri.tryParse(embed);
    if (u == null || !u.host.contains('youtube')) return null;
    return RegExp(
      r'^/embed/([A-Za-z0-9_-]{6,20})$',
    ).firstMatch(u.path)?.group(1);
  }

  /// [HF-REEL-BLUR-2] HF-REEL-48: heights in CSS px of YouTube's own top bar and bottom strip. The page blurs them only
  /// while YouTube is showing them (see [youtubeChromeMs]); the video is not zoomed or moved. The page never scrolls.
  @visibleForTesting
  static const int youtubeHideTop = 60;

  /// How long YouTube keeps its top / bottom bars after it starts playing (they fade on their own; our blur follows).
  @visibleForTesting
  static const int youtubeChromeMs = 4000;
  @visibleForTesting
  static const int youtubeHideBottom = 84;

  /// A small page that runs the YouTube IFrame Player API. It is loaded with the app id as its base URL so YouTube gets a
  /// Referer and origin. The tap layer in Flutter calls `hfSet(bool)` / `hfToggle()`; state and errors come back over the
  /// `HFPlayer` channel (`ready`, `playing`, `paused`, `error:<code>`). Null for a non-YouTube embed.
  @visibleForTesting
  static String? youtubeHtml(
    String embed, {
    bool sound = true,
    bool start = true,
  }) {
    final id = youtubeId(embed);
    if (id == null) return null;
    final origin = const HtmlEscape(
      HtmlEscapeMode.attribute,
    ).convert(youtubeOrigin);
    return '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<style>html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden;position:fixed;inset:0;touch-action:none}'
        '#p{position:absolute;top:0;left:0;width:100%;height:100%;border:0;transform-origin:50% 50%}'
        // [HF-REEL-BLUR-2] frosted strips over YouTube's own top bar (channel / title) and bottom strip, shown only while
        // YouTube shows them: from load until a few seconds after it starts playing, all the time it is paused or
        // buffering, and again for a few seconds after every play. The video stays full size and centred.
        '.hfb{position:fixed;pointer-events:none;z-index:2;-webkit-backdrop-filter:blur(16px) saturate(1.1);backdrop-filter:blur(16px) saturate(1.1);background:rgba(10,4,16,.18);opacity:0;transition:opacity .3s}body.c .hfb{opacity:1}'
        '#bt{left:0;right:0;top:0;height:${youtubeHideTop}px;-webkit-mask-image:linear-gradient(#000 65%,transparent);mask-image:linear-gradient(#000 65%,transparent)}'
        '#bb{left:0;right:0;bottom:0;height:${youtubeHideBottom}px;-webkit-mask-image:linear-gradient(transparent,#000 30%);mask-image:linear-gradient(transparent,#000 30%)}'
        // [HF-REEL-YT-CENTER-1] YouTube's own previous / pause / next buttons appear in the middle at the same moments as its
        // top bar; a soft frosted oval covers them while that chrome is showing (owner: "YouTube buttons briefly showed").
        // [HF-REEL-YT-CENTER-2] only while paused: at the start it blurred faces in the middle of the video.
        '#bc{opacity:0!important}body.p #bc{opacity:1!important}'
        '#bc{left:50%;top:50%;width:72%;max-width:340px;height:120px;transform:translate(-50%,-50%);border-radius:60px;-webkit-mask-image:radial-gradient(ellipse at center,#000 55%,transparent 75%);mask-image:radial-gradient(ellipse at center,#000 55%,transparent 75%)}'
        '</style></head>'
        '<body class="c"><div id="p"></div><div class="hfb" id="bt"></div><div class="hfb" id="bc"></div><div class="hfb" id="bb"></div><script>'
        // [HF-REEL-FILL-1] a 9:16 reel on a taller phone screen leaves black bands above and below it; scale the player
        // (centred) just enough that the video reaches the top and the bottom, as Instagram reels do
        'function fit(){var e=document.getElementById("p");if(!e)return;var W=window.innerWidth,H=window.innerHeight,v=W*16/9;'
        'e.style.transform="scale("+(H>v?H/v:1)+")"}window.addEventListener("resize",fit);'
        'var ht=null;function chrome(ms){document.body.classList.add("c");clearTimeout(ht);if(ms)ht=setTimeout(function(){document.body.classList.remove("c")},ms)}'
        'window.addEventListener("scroll",function(){window.scrollTo(0,0)});'
        'var pl=null,ready=false,want=$start,SOUND=$sound,MUTED=${!start};'
        'function post(m){try{HFPlayer.postMessage(m)}catch(e){}}'
        'function apply(){if(!ready)return;try{if(want)pl.playVideo();else pl.pauseVideo()}catch(e){}}'
        'window.hfSet=function(b){want=!!b;apply()};'
        'window.hfToggle=function(){if(!ready)return;try{want=pl.getPlayerState()!==1;apply()}catch(e){}};'
        'function mute(){try{if(MUTED||!SOUND)pl.mute();else pl.unMute()}catch(e){}}'
        'window.hfMute=function(m){MUTED=!!m;if(ready)mute()};'
        'window.hfRestart=function(){want=true;if(!ready)return;try{pl.seekTo(0,true)}catch(e){}apply()};'
        'function onYouTubeIframeAPIReady(){pl=new YT.Player("p",{videoId:"$id",width:"100%",height:"100%",host:"https://www.youtube.com",'
        'playerVars:{autoplay:${start ? 1 : 0},playsinline:1,controls:0,rel:0,modestbranding:1,loop:1,playlist:"$id",enablejsapi:1,origin:"$origin",fs:0,disablekb:1,iv_load_policy:3},'
        'events:{onReady:function(){fit();ready=true;mute();post("ready");apply()},'
        'onAutoplayBlocked:function(){try{pl.mute();pl.playVideo()}catch(e){}},'
        'onStateChange:function(e){document.body.classList.toggle("p",e.data===2);if(e.data===1)chrome($youtubeChromeMs);else chrome(0);if(e.data===1)post("playing");else if(e.data===2)post("paused");else if(e.data===0){try{pl.playVideo()}catch(x){}}},'
        'onError:function(e){post("error:"+e.data)}}})}'
        '</script><script src="https://www.youtube.com/iframe_api"></script></body></html>';
  }

  /// JavaScript run once Instagram's embed page has loaded. It finds the `<video>` (waits up to 6 s, clicking the embed's
  /// own play control to make it appear), makes it fill the page (object-fit: cover) with everything else hidden, and exposes
  /// `hfSet(bool)` / `hfToggle()`. It reports `ready`, `playing`, `paused` and `error:novideo|blocked|media` over `HFPlayer`.
  @visibleForTesting
  static String instagramScript({bool sound = true, bool start = true}) =>
      '''
(function(){
if(window.__hfInit)return;window.__hfInit=true;
var SOUND=$sound,MUTED=${!start},want=$start,vid=null,started=Date.now(),clicks=0,tick=0;
function post(m){try{HFPlayer.postMessage(m)}catch(e){}}
var st=document.createElement('style');
st.textContent='html,body{background:#000!important;margin:0!important;padding:0!important;overflow:hidden!important}'
+'body{visibility:hidden!important}video{visibility:visible!important}'
+'video{position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;object-fit:cover!important;z-index:2147483647!important;background:#000!important;transform:none!important;margin:0!important}';
(document.head||document.documentElement).appendChild(st);
function isolate(v){
  var n=v;
  while(n&&n!==document.body&&n.parentElement){
    var p=n.parentElement;
    for(var i=0;i<p.children.length;i++){var s=p.children[i];
      if(s!==n&&s.tagName!=='STYLE'&&s.tagName!=='SCRIPT'&&s.tagName!=='LINK'){s.style.setProperty('display','none','important');}}
    ['transform','filter','perspective','contain','will-change','backdrop-filter'].forEach(function(k){p.style.setProperty(k,'none','important');});
    n=p;
  }
}
function apply(){
  if(!vid)return;
  if(want){var r=vid.play();
    if(r&&r.catch)r.catch(function(){vid.muted=true;var q=vid.play();if(q&&q.catch)q.catch(function(){post('error:blocked');});});
  }else{vid.pause();}
}
function bind(v){
  vid=v;v.setAttribute('playsinline','');v.setAttribute('webkit-playsinline','');
  v.playsInline=true;v.loop=true;v.controls=false;v.removeAttribute('controls');v.muted=MUTED||!SOUND;
  v.addEventListener('playing',function(){post('playing');});
  v.addEventListener('pause',function(){post('paused');});
  v.addEventListener('error',function(){post('error:media');});
  isolate(v);post('ready');apply();
}
function clickPlay(){
  var sels=['[aria-label*="lay" i]','button[class*="lay" i]','[role="button"][class*="lay" i]','[class*="PlayButton"]','[data-testid*="play" i]'];
  for(var i=0;i<sels.length;i++){var el=document.querySelector(sels[i]);if(el){el.click();return;}}
  document.body.style.setProperty('visibility','visible','important');
  var c=document.elementFromPoint(window.innerWidth/2,window.innerHeight/2);
  document.body.style.removeProperty('visibility');if(c)c.click();
}
window.hfSet=function(b){want=!!b;apply();};
window.hfToggle=function(){want=vid?vid.paused:true;apply();};
window.hfMute=function(m){MUTED=!!m;if(vid)vid.muted=MUTED||!SOUND;};
window.hfRestart=function(){want=true;if(vid){try{vid.currentTime=0;}catch(e){}}apply();};
var iv=setInterval(function(){
  tick++;var t=Date.now()-started;
  if(vid&&!vid.isConnected){vid=null;started=Date.now();clicks=0;}
  var v=document.querySelector('video');
  if(v&&v!==vid)bind(v);
  if(vid){if(tick%4===0)isolate(vid);return;}
  if(t>2500&&/watch this reel in the app/i.test((document.body&&document.body.textContent)||'')){clearInterval(iv);post('error:appOnly');return;}
  if((t>1500&&clicks===0)||(t>3500&&clicks===1)){clicks++;clickPlay();}
  if(t>6000){clearInterval(iv);post('error:novideo');}
},250);
})();
''';

  @override
  State<ReelPlayer> createState() => _ReelPlayerState();
}

class _ReelPlayerState extends State<ReelPlayer> with WidgetsBindingObserver {
  WebViewController? _web;
  String? _webFor;

  /// False while the app is in the background: the embed is torn down so audio stops, and rebuilt on resume.
  bool _fg = true;

  /// Why the video could not start; set means the poster card with "Watch on …" is shown.
  String? _failReason;
  bool _played = false;

  /// [HF-REEL-WARM-1] Started early, muted, and paused at its first frame so it plays the instant it comes on screen.
  bool _warmed = false;

  /// Has this reel been on screen since it was warmed (then a return keeps its place instead of restarting).
  bool _seenActive = false;
  bool _isPlaying = true;
  Timer? _watchdog;
  StreamSubscription<String>? _testSub;

  String? get _source => ReelPlayer.sourceFor(widget.reel);
  bool get _wantEmbed => _source != null;
  bool get _isIg =>
      (Uri.tryParse(_source ?? '')?.host ?? '').contains('instagram');
  String get _platform => _isIg ? 'instagram' : 'youtube';
  bool get _engine => ReelPlayer.testRunJs != null || _web != null;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _fg =
        (WidgetsBinding.instance.lifecycleState ?? AppLifecycleState.resumed) ==
        AppLifecycleState.resumed;
    if (ReelPlayer.testRunJs != null)
      _testSub = ReelPlayer.testMessages?.stream.listen(_onMessage);
    _sync();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _watchdog?.cancel();
    _testSub?.cancel();
    _drop();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final fg = state == AppLifecycleState.resumed;
    if (fg == _fg) return;
    setState(() {
      _fg = fg;
      if (!fg) _drop();
      _sync();
    });
  }

  @override
  void didUpdateWidget(covariant ReelPlayer old) {
    super.didUpdateWidget(old);
    if (old.reel.id != widget.reel.id ||
        ReelPlayer.sourceFor(old.reel) != _source) {
      _drop();
      _failReason = null;
      _played = false;
      _warmed = false;
      _seenActive = false;
    }
    _sync();
    // Leaving the page pauses the video in place (the PageView drops far-away pages, so memory stays at one or two views).
    if (old.active != widget.active && _engine) {
      if (widget.active) {
        _run('window.hfMute&&window.hfMute(false)');
        // a warmed reel starts from the top the first time it is shown; after that it carries on where it was
        _run(
          _warmed && !_seenActive
              ? 'window.hfRestart&&window.hfRestart()'
              : 'window.hfSet&&window.hfSet(true)',
        );
        _seenActive = true;
        if (!_played) _armWatchdog();
      } else {
        _run('window.hfSet&&window.hfSet(false)');
      }
    }
  }

  void _drop() {
    _watchdog?.cancel();
    _run('window.hfSet&&window.hfSet(false)');
    _web = null;
    _webFor = null;
  }

  void _sync() {
    if (ReelPlayer.testPlayer != null || ReelPlayer.testRunJs != null) return;
    if (_failReason == null &&
        _wantEmbed &&
        _fg &&
        (widget.active || widget.preload))
      _startWeb();
  }

  void _run(String js) {
    final t = ReelPlayer.testRunJs;
    if (t != null) {
      t(js);
      return;
    }
    _web?.runJavaScript(js).catchError((Object _) {});
  }

  void _startWeb() {
    final embed = _source!;
    if (_web != null && _webFor == embed) return;
    final ig = _isIg;
    final c = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(Colors.black)
      ..addJavaScriptChannel(
        'HFPlayer',
        onMessageReceived: (m) => _onMessage(m.message),
      )
      ..setNavigationDelegate(
        NavigationDelegate(
          // The embed stays on its own page: no tapping out to other sites. Only YouTube / Instagram embeds and the
          // first page itself may load (about:blank and the app base URL belong to the small page that holds the player).
          onNavigationRequest: (r) {
            if (!r.isMainFrame) return NavigationDecision.navigate;
            final ok =
                r.url == 'about:blank' ||
                r.url == ReelPlayer.embedUri(embed).toString() ||
                r.url == ReelPlayer.instagramUri(embed).toString() ||
                r.url.startsWith('${ReelPlayer.youtubeOrigin}/') ||
                r.url.startsWith('${Brand.webOrigin}/') ||
                r.url.startsWith('https://www.youtube.com/embed/') ||
                r.url.startsWith('https://www.instagram.com/reel/');
            return ok
                ? NavigationDecision.navigate
                : NavigationDecision.prevent;
          },
          onPageFinished: (_) {
            if (!mounted || _webFor != embed) return;
            if (ig)
              _run(
                ReelPlayer.instagramScript(
                  sound: widget.sound,
                  start: widget.active,
                ),
              );
            _run('window.hfSet&&window.hfSet(${widget.active})');
          },
          onWebResourceError: (e) {
            if (e.isForMainFrame == true) _fail('load');
          },
        ),
      );
    if (ig) unawaited(c.setUserAgent(ReelPlayer.mobileUserAgent));
    final p = c.platform;
    if (p is AndroidWebViewController) {
      unawaited(
        p.setMediaPlaybackRequiresUserGesture(false),
      ); // lets the embed autoplay
      try {
        final cm = WebViewCookieManager().platform;
        if (cm is AndroidWebViewCookieManager)
          unawaited(cm.setAcceptThirdPartyCookies(p, true));
      } catch (_) {
        // cookies are a nicety: the embed still plays without them
      }
    }
    final html = ReelPlayer.youtubeHtml(
      embed,
      sound: widget.sound,
      start: widget.active,
    );
    if (html != null) {
      c.loadHtmlString(html, baseUrl: ReelPlayer.youtubeOrigin);
    } else if (ig) {
      c.loadRequest(ReelPlayer.instagramUri(embed));
    } else {
      c.loadRequest(ReelPlayer.embedUri(embed));
    }
    _web = c;
    _webFor = embed;
    if (widget.active) {
      _seenActive = true;
      _armWatchdog();
    }
  }

  void _armWatchdog() {
    _watchdog?.cancel();
    _watchdog = Timer(const Duration(seconds: 9), () {
      if (mounted && widget.active && !_played) _fail('timeout');
    });
  }

  void _onMessage(String m) {
    if (!mounted) return;
    if (m == 'ready') {
      if (widget.active && _fg) {
        _run('window.hfMute&&window.hfMute(false)');
        _run('window.hfSet&&window.hfSet(true)');
      } else if (_fg && widget.preload && !_warmed) {
        // warm up: play muted until the first frame, then stop (below) — the reel is buffered and ready
        _run('window.hfMute&&window.hfMute(true)');
        _run('window.hfSet&&window.hfSet(true)');
      } else {
        _run('window.hfSet&&window.hfSet(false)');
      }
    } else if (m == 'playing') {
      if (!widget.active || !_fg) {
        _run('window.hfSet&&window.hfSet(false)');
        _warmed = true;
      }
      _watchdog?.cancel();
      if (!_played) setState(() => _played = true);
      if (!_isPlaying) setState(() => _isPlaying = true);
    } else if (m == 'paused') {
      if (_isPlaying) setState(() => _isPlaying = false);
    } else if (m.startsWith('error:')) {
      if (_played && m == 'error:media')
        return; // a hiccup after it was already playing
      _fail(m.substring(6));
    }
  }

  void _fail(String reason) {
    if (!mounted || _failReason != null) return;
    Telemetry.event('hf_reel_play_fail', {
      'platform': _platform,
      'reason': reason,
    });
    setState(() {
      _failReason = reason;
      _drop();
    });
    if (UnplayableReels.permanentReasons.contains(reason)) {
      unawaited(UnplayableReels.mark(widget.reel.id));
      widget.onUnplayable?.call(reason);
    }
  }

  void _toggle() {
    _run('window.hfToggle&&window.hfToggle()');
    setState(() {
      _isPlaying = !_isPlaying;
    });
  }

  Uri? get _reelUri =>
      Uri.tryParse(widget.reel.url ?? widget.reel.embedUrl ?? '');

  void _openExternal() {
    final u = _reelUri;
    if (u == null) return;
    final t = ReelPlayer.testLaunch;
    if (t != null) {
      t(u);
      return;
    }
    unawaited(
      launchUrl(
        u,
        mode: LaunchMode.externalApplication,
      ).catchError((Object _) => false),
    );
  }

  Widget _thumb() {
    final t = widget.reel.thumbUrl;
    if (t == null) return const ColoredBox(color: C.cinema);
    return NetImage(
      t,
      fit: BoxFit.cover,
      fallback: const ColoredBox(color: C.cinema),
    );
  }

  Widget _fallback() {
    final name = _isIg ? 'Instagram' : 'YouTube';
    return Stack(
      key: const ValueKey('reel-fallback'),
      fit: StackFit.expand,
      children: [
        _thumb(),
        ColoredBox(color: C.cinema.withValues(alpha: 0.55)),
        Center(
          child: Semantics(
            button: true,
            label: 'Watch on $name',
            child: GestureDetector(
              key: const ValueKey('reel-fallback-open'),
              onTap: _openExternal,
              child: Container(
                constraints: const BoxConstraints(minHeight: 48),
                padding: const EdgeInsets.symmetric(
                  horizontal: 22,
                  vertical: 12,
                ),
                decoration: BoxDecoration(
                  color: C.marigold,
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(
                      Icons.play_arrow_rounded,
                      color: C.deep,
                      size: 24,
                    ),
                    const SizedBox(width: 6),
                    Text('Watch on $name', style: t(16, color: C.deep)),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final o = ReelPlayer.testPlayer;
    if (o != null) return o(widget.reel, widget.active);
    if (_wantEmbed && _failReason != null) return _fallback();
    return Stack(
      fit: StackFit.expand,
      children: [
        _thumb(),
        if (_web != null && _fg)
          Positioned(
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            // [HF-REEL-CLEAN-1] never focusable: a warmed player taking focus made the feed scroll to it by itself
            child: ExcludeFocus(child: WebViewWidget(controller: _web!)),
          ),
        // [HF-REEL-WARM-1] the poster stays on top until the video has really started, so the viewer never sees the
        // embed page loading (Instagram's header / likes / comments, YouTube's spinner) or a black flash while scrolling
        if (_web != null && _fg && !_played)
          Positioned.fill(child: IgnorePointer(child: _thumb())),
        // The transparent layer with our control: a tap goes to the video underneath as play / pause. Only taps are taken,
        // so a vertical swipe still reaches the PageView.
        if (_wantEmbed && _engine && _fg)
          Positioned.fill(
            child: GestureDetector(
              key: const ValueKey('reel-tap'),
              behavior: HitTestBehavior.opaque,
              onTap: _toggle,
              child: const SizedBox.expand(),
            ),
          ),
        // [HF-REEL-NOIG-1] no "Open in Instagram" chip on the video (owner 2026-10-22); the link is in the reel's info sheet
      ],
    );
  }
}

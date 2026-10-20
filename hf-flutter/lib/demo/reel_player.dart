import 'dart:async';
import 'dart:convert' show HtmlEscape, HtmlEscapeMode;

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import '../core/brand.dart';
import '../data/models/reel.dart';
import '../data/telemetry.dart';
import '../ui/net_image.dart';
import 'theme.dart';

/// Whether the main Reels feed is on screen. The Reels tab stays alive offstage (indexed stack), so the feed must be told
/// when to stop: visible = the main shell is mounted AND its current tab is Reels AND no page route is pushed above it.
/// Without a [MainShell] (tests, previews) it stays true. App background/foreground is handled by each [ReelPlayer].
class ReelGate {
  ReelGate._();

  static final ValueNotifier<bool> visible = ValueNotifier<bool>(true);
  static bool _managed = false;
  static ModalRoute<dynamic>? _shellRoute;
  static int _branch = 0;
  static final List<Route<dynamic>> _pages = [];

  /// Watches the root navigator for pushed pages (dialogs and sheets do not count).
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
    final v = !_managed || (_shellRoute != null && _branch == 0 && (top == null || identical(top, _shellRoute)));
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
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) => _after(() {
        if (route is PageRoute) ReelGate._pages.add(route);
      });

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) => _after(() => ReelGate._pages.remove(route));

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) => _after(() => ReelGate._pages.remove(route));

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) => _after(() {
        final i = oldRoute == null ? -1 : ReelGate._pages.indexOf(oldRoute);
        if (i >= 0) {
          if (newRoute is PageRoute) {
            ReelGate._pages[i] = newRoute;
          } else {
            ReelGate._pages.removeAt(i);
          }
        } else if (newRoute is PageRoute) {
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
  const ReelPlayer({super.key, required this.reel, required this.active, this.preload = false, this.sound = true});

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

  /// The page origin YouTube sees (an Android app's package id, as YouTube's embed rules expect): sent as the Referer
  /// through the base URL and as the `origin` player parameter, which is what stops embed errors 152 / 153.
  static String get youtubeOrigin => 'https://${Brand.hfPlayPackageId}';

  /// The URL of the embed. YouTube: autoplay, inline, loop, related videos limited to the same channel.
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

  /// The Instagram page we open as the top-level page: `https://www.instagram.com/reel/<code>/embed/`. Anything that does
  /// not look like an Instagram post address is returned as it is.
  @visibleForTesting
  static Uri instagramUri(String embed) {
    final u = Uri.tryParse(embed);
    if (u == null || !u.host.contains('instagram')) return embedUri(embed);
    final m = RegExp(r'^/(?:reel|reels|p|tv)/([A-Za-z0-9_-]+)').firstMatch(u.path);
    if (m == null) return u;
    return Uri.parse('https://www.instagram.com/reel/${m.group(1)}/embed/');
  }

  /// The YouTube video id of an embed address, or null when it is not a YouTube embed.
  @visibleForTesting
  static String? youtubeId(String embed) {
    final u = Uri.tryParse(embed);
    if (u == null || !u.host.contains('youtube')) return null;
    return RegExp(r'^/embed/([A-Za-z0-9_-]{6,20})$').firstMatch(u.path)?.group(1);
  }

  /// A small page that runs the YouTube IFrame Player API. It is loaded with the app id as its base URL so YouTube gets a
  /// Referer and origin. The tap layer in Flutter calls `hfSet(bool)` / `hfToggle()`; state and errors come back over the
  /// `HFPlayer` channel (`ready`, `playing`, `paused`, `error:<code>`). Null for a non-YouTube embed.
  @visibleForTesting
  static String? youtubeHtml(String embed, {bool sound = true}) {
    final id = youtubeId(embed);
    if (id == null) return null;
    final origin = const HtmlEscape(HtmlEscapeMode.attribute).convert(youtubeOrigin);
    return '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#p{position:absolute;top:0;left:0;width:100%;height:100%;border:0}</style></head>'
        '<body><div id="p"></div><script>'
        'var pl=null,ready=false,want=true,SOUND=$sound;'
        'function post(m){try{HFPlayer.postMessage(m)}catch(e){}}'
        'function apply(){if(!ready)return;try{if(want)pl.playVideo();else pl.pauseVideo()}catch(e){}}'
        'window.hfSet=function(b){want=!!b;apply()};'
        'window.hfToggle=function(){if(!ready)return;try{want=pl.getPlayerState()!==1;apply()}catch(e){}};'
        'function onYouTubeIframeAPIReady(){pl=new YT.Player("p",{videoId:"$id",width:"100%",height:"100%",host:"https://www.youtube.com",'
        'playerVars:{autoplay:1,playsinline:1,controls:0,rel:0,modestbranding:1,loop:1,playlist:"$id",enablejsapi:1,origin:"$origin",fs:0,disablekb:1,iv_load_policy:3},'
        'events:{onReady:function(){ready=true;if(!SOUND){try{pl.mute()}catch(e){}}post("ready");apply()},'
        'onAutoplayBlocked:function(){try{pl.mute();pl.playVideo()}catch(e){}},'
        'onStateChange:function(e){if(e.data===1)post("playing");else if(e.data===2)post("paused");else if(e.data===0){try{pl.playVideo()}catch(x){}}},'
        'onError:function(e){post("error:"+e.data)}}})}'
        '</script><script src="https://www.youtube.com/iframe_api"></script></body></html>';
  }

  /// JavaScript run once Instagram's embed page has loaded. It finds the `<video>` (waits up to 6 s, clicking the embed's
  /// own play control to make it appear), makes it fill the page (object-fit: cover) with everything else hidden, and exposes
  /// `hfSet(bool)` / `hfToggle()`. It reports `ready`, `playing`, `paused` and `error:novideo|blocked|media` over `HFPlayer`.
  @visibleForTesting
  static String instagramScript({bool sound = true}) => '''
(function(){
if(window.__hfInit)return;window.__hfInit=true;
var SOUND=$sound,want=true,vid=null,started=Date.now(),clicks=0,tick=0;
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
  v.playsInline=true;v.loop=true;v.controls=false;v.removeAttribute('controls');v.muted=!SOUND;
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
  bool _isPlaying = true;
  bool _glyph = false;
  Timer? _glyphTimer;
  Timer? _watchdog;
  StreamSubscription<String>? _testSub;

  bool get _wantEmbed => widget.reel.embedUrl != null;
  bool get _isIg => (Uri.tryParse(widget.reel.embedUrl ?? '')?.host ?? '').contains('instagram');
  String get _platform => _isIg ? 'instagram' : 'youtube';
  bool get _engine => ReelPlayer.testRunJs != null || _web != null;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _fg = (WidgetsBinding.instance.lifecycleState ?? AppLifecycleState.resumed) == AppLifecycleState.resumed;
    if (ReelPlayer.testRunJs != null) _testSub = ReelPlayer.testMessages?.stream.listen(_onMessage);
    _sync();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _glyphTimer?.cancel();
    _watchdog?.cancel();
    _testSub?.cancel();
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
    if (old.reel.id != widget.reel.id || old.reel.embedUrl != widget.reel.embedUrl) {
      _drop();
      _failReason = null;
      _played = false;
    }
    _sync();
    // Leaving the page pauses the video in place (the PageView drops far-away pages, so memory stays at one or two views).
    if (old.active != widget.active && _engine) _run('window.hfSet&&window.hfSet(${widget.active})');
  }

  void _drop() {
    _watchdog?.cancel();
    _web = null;
    _webFor = null;
  }

  void _sync() {
    if (ReelPlayer.testPlayer != null || ReelPlayer.testRunJs != null) return;
    if (_failReason == null && _wantEmbed && _fg && widget.active) _startWeb();
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
    final embed = widget.reel.embedUrl!;
    if (_web != null && _webFor == embed) return;
    final ig = _isIg;
    final c = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(C.cinema)
      ..addJavaScriptChannel('HFPlayer', onMessageReceived: (m) => _onMessage(m.message))
      ..setNavigationDelegate(NavigationDelegate(
        // The embed stays on its own page: no tapping out to other sites. Only YouTube / Instagram embeds and the
        // first page itself may load (about:blank and the app base URL belong to the small page that holds the player).
        onNavigationRequest: (r) {
          if (!r.isMainFrame) return NavigationDecision.navigate;
          final ok = r.url == 'about:blank' ||
              r.url == ReelPlayer.embedUri(embed).toString() ||
              r.url == ReelPlayer.instagramUri(embed).toString() ||
              r.url.startsWith('${ReelPlayer.youtubeOrigin}/') ||
              r.url.startsWith('${Brand.webOrigin}/') ||
              r.url.startsWith('https://www.youtube.com/embed/') ||
              r.url.startsWith('https://www.instagram.com/reel/');
          return ok ? NavigationDecision.navigate : NavigationDecision.prevent;
        },
        onPageFinished: (_) {
          if (!mounted || _webFor != embed) return;
          if (ig) _run(ReelPlayer.instagramScript(sound: widget.sound));
          _run('window.hfSet&&window.hfSet(${widget.active})');
        },
        onWebResourceError: (e) {
          if (e.isForMainFrame == true) _fail('load');
        },
      ));
    if (ig) unawaited(c.setUserAgent(ReelPlayer.mobileUserAgent));
    final p = c.platform;
    if (p is AndroidWebViewController) {
      unawaited(p.setMediaPlaybackRequiresUserGesture(false)); // lets the embed autoplay
      try {
        final cm = WebViewCookieManager().platform;
        if (cm is AndroidWebViewCookieManager) unawaited(cm.setAcceptThirdPartyCookies(p, true));
      } catch (_) {
        // cookies are a nicety: the embed still plays without them
      }
    }
    final html = ReelPlayer.youtubeHtml(embed, sound: widget.sound);
    if (html != null) {
      c.loadHtmlString(html, baseUrl: ReelPlayer.youtubeOrigin);
    } else if (ig) {
      c.loadRequest(ReelPlayer.instagramUri(embed));
    } else {
      c.loadRequest(ReelPlayer.embedUri(embed));
    }
    _web = c;
    _webFor = embed;
    _watchdog?.cancel();
    _watchdog = Timer(const Duration(seconds: 9), () {
      if (mounted && widget.active && !_played) _fail('timeout');
    });
  }

  void _onMessage(String m) {
    if (!mounted) return;
    if (m == 'playing') {
      _watchdog?.cancel();
      _played = true;
      if (!_isPlaying) setState(() => _isPlaying = true);
    } else if (m == 'paused') {
      if (_isPlaying) setState(() => _isPlaying = false);
    } else if (m.startsWith('error:')) {
      if (_played && m == 'error:media') return; // a hiccup after it was already playing
      _fail(m.substring(6));
    }
  }

  void _fail(String reason) {
    if (!mounted || _failReason != null) return;
    Telemetry.event('hf_reel_play_fail', {'platform': _platform, 'reason': reason});
    setState(() {
      _failReason = reason;
      _drop();
    });
  }

  void _toggle() {
    _run('window.hfToggle&&window.hfToggle()');
    setState(() {
      _isPlaying = !_isPlaying;
      _glyph = _isIg; // YouTube: nothing is drawn over the player, the tap only toggles
    });
    _glyphTimer?.cancel();
    _glyphTimer = Timer(const Duration(milliseconds: 600), () {
      if (mounted) setState(() => _glyph = false);
    });
  }

  Uri? get _reelUri => Uri.tryParse(widget.reel.url ?? widget.reel.embedUrl ?? '');

  void _openExternal() {
    final u = _reelUri;
    if (u == null) return;
    final t = ReelPlayer.testLaunch;
    if (t != null) {
      t(u);
      return;
    }
    unawaited(launchUrl(u, mode: LaunchMode.externalApplication).catchError((Object _) => false));
  }

  Widget _thumb() {
    final t = widget.reel.thumbUrl;
    if (t == null) return const ColoredBox(color: C.cinema);
    return NetImage(t, fit: BoxFit.cover, fallback: const ColoredBox(color: C.cinema));
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
                padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 12),
                decoration: BoxDecoration(color: C.marigold, borderRadius: BorderRadius.circular(999)),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.play_arrow_rounded, color: C.deep, size: 24),
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
    // The embed stays below the system status bar: nothing of it is ever drawn under it.
    final top = MediaQuery.paddingOf(context).top;
    return Stack(
      fit: StackFit.expand,
      children: [
        _thumb(),
        if (_web != null && _fg) Positioned(left: 0, right: 0, top: top, bottom: 0, child: WebViewWidget(controller: _web!)),
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
        if (_isIg && _engine && _fg) ...[
          Positioned.fill(
            child: IgnorePointer(
              child: Center(
                child: AnimatedOpacity(
                  key: const ValueKey('reel-glyph'),
                  opacity: _glyph ? 1 : 0,
                  duration: const Duration(milliseconds: 200),
                  child: Container(
                    width: 72,
                    height: 72,
                    decoration: BoxDecoration(shape: BoxShape.circle, color: C.cinema.withValues(alpha: 0.6)),
                    child: Icon(_isPlaying ? Icons.pause_rounded : Icons.play_arrow_rounded, color: C.ivory, size: 44),
                  ),
                ),
              ),
            ),
          ),
          Positioned(
            top: top + 50,
            left: 28,
            child: Semantics(
              button: true,
              label: 'Open in Instagram',
              child: GestureDetector(
                key: const ValueKey('reel-open-ig'),
                onTap: _openExternal,
                child: Container(
                  constraints: const BoxConstraints(minHeight: 48),
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  decoration: BoxDecoration(color: C.cinema.withValues(alpha: 0.6), borderRadius: BorderRadius.circular(999)),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.open_in_new_rounded, color: C.ivory, size: 18),
                      const SizedBox(width: 6),
                      Text('Open in Instagram', style: t(14, color: C.ivory)),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ],
    );
  }
}

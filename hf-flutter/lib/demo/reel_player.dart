import 'dart:async';
import 'dart:convert' show HtmlEscape, HtmlEscapeMode;

import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import '../core/brand.dart';
import '../data/models/reel.dart';
import '../data/telemetry.dart';
import '../data/unplayable_reels.dart';
import '../ui/net_image.dart';
import 'screens/original_post_page.dart';
import 'theme.dart';

/// [HF-REEL-RAW-APP-1] Where the video is on the player's page, in CSS px (`rect`), and the page's own size (`view`) when it
/// said so.
typedef PageRect = ({Rect rect, Size? view});

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
/// [HF-REEL-OVERLAY-APP-1] (owner 2026-10-26) YouTube is shown as it is (our tap layer leaves a hole over its mute icon);
/// Instagram's card is hidden and the video fills the page. Links that still load open in the app (never in their apps). When a video cannot be started the card shows the poster with a "Watch on …" button.
/// The thumbnail shows until the player is up. [active] plays; a page with [preload] is only kept ready.
class ReelPlayer extends StatefulWidget {
  const ReelPlayer({
    super.key,
    required this.reel,
    required this.active,
    this.preload = false,
    this.sound = true,
    this.muted = false,
    this.onUnplayable,
    this.onOpenLink,
  });

  /// [HF-REEL-RAW-APP-1] A link the viewer tapped inside the player (YouTube title / channel / logo, Instagram profile ...).
  /// The player never lets it load; the feed decides how to show it (with its Call / Invite bar). Without it the plain
  /// in-app page opens. The reel is paused while the returned future runs.
  final Future<void> Function(Uri url)? onOpenLink;

  /// [HF-REEL-CALL-2] The profile preview's mute toggle: flipping it silences / restores the playing video in place.
  final bool muted;

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

  /// [HF-REEL-RAW-APP-1] Is [reel] an Instagram reel (its player is the stock Instagram embed page)?
  static bool isInstagram(FeedReel reel) =>
      (Uri.tryParse(sourceFor(reel) ?? '')?.host ?? '').contains('instagram');

  /// [HF-REEL-RAW-APP-1] The page posts `rect:<left>,<top>,<width>,<height>[,<viewW>,<viewH>]` (CSS px) over the `HFPlayer`
  /// channel: where the video is on the page. Null for anything else or a rectangle that makes no sense.
  @visibleForTesting
  static PageRect? parseRect(String message) {
    if (!message.startsWith('rect:')) return null;
    final n = message
        .substring(5)
        .split(',')
        .map((s) => double.tryParse(s.trim()))
        .toList();
    if (n.length != 4 && n.length != 6) return null;
    if (n.any((v) => v == null || !v.isFinite)) return null;
    final v = n.cast<double>();
    if (v[2] <= 0 || v[3] <= 0) return null;
    Size? view;
    if (n.length == 6 && v[4] > 0 && v[5] > 0) view = Size(v[4], v[5]);
    return (rect: Rect.fromLTWH(v[0], v[1], v[2], v[3]), view: view);
  }

  /// [HF-REEL-OVERLAY-APP-1] The YouTube player box in the WebView's logical px ([box] is the WebView's size): the
  /// rectangle the page posted (scaled from CSS px), or the whole WebView until the page has said, or when it makes no sense.
  @visibleForTesting
  static Rect playerBox(PageRect? page, Size box) {
    final whole = Offset.zero & box;
    if (page == null || box.isEmpty) return whole;
    var r = page.rect;
    final v = page.view;
    if (v != null && v.width > 0 && v.height > 0) {
      final sx = box.width / v.width;
      final sy = box.height / v.height;
      r = Rect.fromLTWH(r.left * sx, r.top * sy, r.width * sx, r.height * sy);
    }
    r = r.intersect(whole);
    if (r.width < 40 || r.height < 40) return whole;
    return r;
  }

  /// [HF-REEL-OVERLAY-APP-1] The tiles of our transparent tap layer over a YouTube player at [box]: the whole box EXCEPT a
  /// hole over YouTube's own sound icon (top right: from 165 to 62 px left of the right edge, 2 to 46 px down; covers both the Shorts
  /// layout, icon about 73 px from the right, and the desktop layout, about 145 px), so the
  /// viewer uses YouTube's sound button. The menu further right stays covered. Tiles do not overlap; empty ones are left out.
  @visibleForTesting
  static List<Rect> youtubeTapTiles(Rect box) {
    final hole = Rect.fromLTRB(box.right - 165, box.top + 2, box.right - 62, box.top + 46).intersect(box);
    if (hole.isEmpty) return [box];
    final tiles = <Rect>[
      Rect.fromLTRB(box.left, box.top, box.right, hole.top),
      Rect.fromLTRB(box.left, hole.top, hole.left, hole.bottom),
      Rect.fromLTRB(hole.right, hole.top, box.right, hole.bottom),
      Rect.fromLTRB(box.left, hole.bottom, box.right, box.bottom),
    ];
    return tiles.where((t) => t.width > 0 && t.height > 0).toList();
  }

  /// [HF-REEL-RAW-APP-1] True when a main-frame address is the player itself (or the small page that holds it), which may
  /// load inside the WebView. Everything else is a link the viewer tapped.
  @visibleForTesting
  static bool isEmbedLoad(String url, String embed) {
    if (url == 'about:blank') return true;
    if (url == embedUri(embed).toString() ||
        url == instagramUri(embed).toString()) {
      return true;
    }
    if (url.startsWith('$youtubeOrigin/') ||
        url.startsWith('${Brand.webOrigin}/')) {
      return true;
    }
    final u = Uri.tryParse(url);
    if (u == null || u.scheme != 'https') return false;
    final h = u.host.toLowerCase();
    if (h == 'www.youtube.com' && u.path.startsWith('/embed/')) return true;
    if (h == 'www.instagram.com' && u.pathSegments.contains('embed')) {
      return true;
    }
    return false;
  }

  /// [HF-REEL-RAW-APP-1] The in-app address to open for a link the viewer tapped inside the player (YouTube title, channel,
  /// logo; Instagram profile, "View more on Instagram"), or null: the player itself, another site, or an app scheme
  /// (`intent:`, `vnd.youtube:`, `instagram:`), none of which may open. The caller prevents the navigation either way.
  @visibleForTesting
  static Uri? externalLink(Uri u, String embed) {
    if (u.scheme != 'https' && u.scheme != 'http') return null;
    final h = u.host.toLowerCase();
    bool on(String d) => h == d || h.endsWith('.$d');
    if (!(on('youtube.com') || h == 'youtu.be' || on('instagram.com'))) {
      return null;
    }
    final https = u.scheme == 'https' ? u : u.replace(scheme: 'https');
    if (isEmbedLoad(https.toString(), embed)) return null;
    return https;
  }

  /// A small page that runs the YouTube IFrame Player API, loaded with our website as its base URL so YouTube gets a
  /// Referer and origin. [HF-REEL-RAW-APP-1] The player is shown as it is (no cropping, no blur): YouTube's own title
  /// bar and logo stay visible and tappable. The tap layer in Flutter calls `hfSet(bool)` / `hfToggle()`; state and errors
  /// come back over the `HFPlayer` channel (`ready`, `playing`, `paused`, `error:<code>`, `rect:<l>,<t>,<w>,<h>,<vw>,<vh>`).
  /// Null for a non-YouTube embed.
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
        // [HF-REEL-INSTANT-1] warm the YouTube hosts before the player script asks for them
        '<link rel="preconnect" href="https://www.youtube.com"><link rel="preconnect" href="https://i.ytimg.com">'
        '<link rel="preconnect" href="https://www.google.com"><link rel="dns-prefetch" href="https://googlevideo.com">'
        '<style>html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden;position:fixed;inset:0;touch-action:none}'
        '#p{position:absolute;top:0;left:0;width:100%;height:100%;border:0}'
        '</style></head>'
        '<body><div id="p"></div><script>'
        'window.addEventListener("scroll",function(){window.scrollTo(0,0)});'
        'var pl=null,ready=false,want=$start,SOUND=$sound,MUTED=${!start},lastRect="";'
        'function post(m){try{HFPlayer.postMessage(m)}catch(e){}}'
        // [HF-REEL-RAW-APP-1] tell Flutter where the player is, so its tap layer can leave YouTube's title bar and logo alone
        'function rect(){var e=document.getElementById("p");if(!e)return;var r=e.getBoundingClientRect();'
        'var m="rect:"+[r.left,r.top,r.width,r.height,window.innerWidth,window.innerHeight].map(function(n){return Math.round(n*10)/10}).join(",");'
        'if(m!==lastRect){lastRect=m;post(m)}}window.addEventListener("resize",rect);'
        'function apply(){if(!ready)return;try{if(want)pl.playVideo();else pl.pauseVideo()}catch(e){}}'
        'window.hfSet=function(b){want=!!b;apply()};'
        'window.hfToggle=function(){if(!ready)return;try{want=pl.getPlayerState()!==1;apply()}catch(e){}};'
        'function mute(){try{if(MUTED||!SOUND)pl.mute();else pl.unMute()}catch(e){}}'
        'window.hfMute=function(m){MUTED=!!m;if(ready)mute()};'
        'window.hfRestart=function(){want=true;if(!ready)return;try{if(pl.getCurrentTime()>1)pl.seekTo(0,true)}catch(e){}apply()};'
        'function onYouTubeIframeAPIReady(){pl=new YT.Player("p",{videoId:"$id",width:"100%",height:"100%",host:"https://www.youtube.com",'
        'playerVars:{autoplay:${start ? 1 : 0},playsinline:1,controls:1,rel:0,modestbranding:1,loop:1,playlist:"$id",enablejsapi:1,origin:"$origin",fs:0,disablekb:1,iv_load_policy:3},'
        'events:{onReady:function(){ready=true;mute();rect();post("ready");apply()},'
        'onAutoplayBlocked:function(){try{pl.mute();pl.playVideo()}catch(e){}},'
        'onStateChange:function(e){if(e.data===1)post("playing");else if(e.data===2)post("paused");else if(e.data===0){try{pl.playVideo()}catch(x){}}},'
        'onError:function(e){post("error:"+e.data)}}})}'
        '</script><script src="https://www.youtube.com/iframe_api"></script></body></html>';
  }

  /// [HF-REEL-OVERLAY-APP-1] (owner 2026-10-26) Instagram's white card is hidden again: only the `<video>` shows and it fills the page.
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

  /// [HF-REEL-YT-POSTER-1] owner: on YouTube the poster stays on top until YouTube's own buttons (previous / pause /
  /// next, channel bar) have faded, the first time a reel plays on screen after it is shown.
  /// [HF-REEL-INSTANT-1] owner 2026-10-25: Duration.zero. The 3.6 s cover hid a video that was already playing, so the
  /// viewer saw a still photo with the sound running ("photo and audio, then the video a few seconds later"). The frosted
  /// strips in the page still cover YouTube's top / bottom bars while they show. Put 3600 back to restore the old cover.
  static const Duration youtubeChromeCover = Duration.zero;
  bool _chromeCover = false;
  bool _coverArmed = true;
  Timer? _coverTimer;

  /// [HF-REEL-WARM-1] Started early, muted, and paused at its first frame so it plays the instant it comes on screen.
  bool _warmed = false;

  /// Has this reel been on screen since it was warmed (then a return keeps its place instead of restarting).
  bool _seenActive = false;
  bool _isPlaying = true;
  Timer? _watchdog;

  /// [HF-REEL-INSTANT-1] When this reel came on screen, for the `hf_reel_start` time-to-play event.
  DateTime? _shownAt;
  bool _shownWarm = false;
  StreamSubscription<String>? _testSub;

  /// [HF-REEL-RAW-APP-1] Where the page says its video is; null until the first `rect:` message.
  PageRect? _page;
  bool _linkBusy = false;

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
    _coverTimer?.cancel();
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
      _page = null;
    }
    _sync();
    if (old.muted != widget.muted && _engine) _run('window.hfMute&&window.hfMute(${widget.muted})'); // [HF-REEL-CALL-2]
    // Leaving the page pauses the video in place (the PageView drops far-away pages, so memory stays at one or two views).
    if (old.active != widget.active && _engine) {
      if (widget.active) {
        _coverArmed = true; // [HF-REEL-YT-POSTER-1]
        _shownAt = DateTime.now(); // [HF-REEL-INSTANT-1]
        _shownWarm = _warmed;
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
    _page = null;
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
          // [HF-REEL-RAW-APP-1] The player stays on its own page. A YouTube / Instagram page the viewer tapped (title,
          // channel, logo, profile, "View more on Instagram") is stopped here and opens in the app instead; app schemes
          // (intent:, vnd.youtube:, instagram:) and other sites are simply stopped.
          onNavigationRequest: (r) {
            if (!r.isMainFrame) return NavigationDecision.navigate;
            if (ReelPlayer.isEmbedLoad(r.url, embed)) {
              return NavigationDecision.navigate;
            }
            final u = Uri.tryParse(r.url);
            final link = u == null ? null : ReelPlayer.externalLink(u, embed);
            if (link != null) unawaited(_openLink(link));
            return NavigationDecision.prevent;
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
      _shownAt = DateTime.now(); // [HF-REEL-INSTANT-1] cold start: the player is only being created now
      _shownWarm = false;
      _armWatchdog();
    }
  }

  /// [HF-REEL-RAW-APP-1] Opens a link from inside the player in the app, with the reel paused behind it.
  Future<void> _openLink(Uri uri) async {
    if (_linkBusy || !mounted) return;
    _linkBusy = true;
    Telemetry.event('hf_reel_link_open', {
      'platform': _platform,
      'host': uri.host,
    });
    _run('window.hfSet&&window.hfSet(false)');
    try {
      final open = widget.onOpenLink;
      if (open != null) {
        await open(uri);
      } else {
        await OriginalPostPage.open(context, uri);
      }
    } finally {
      _linkBusy = false;
      if (mounted && widget.active && _fg && ReelGate.visible.value) {
        _run('window.hfSet&&window.hfSet(true)');
      }
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
    if (m.startsWith('rect:')) {
      final p = ReelPlayer.parseRect(m);
      if (p != null && p != _page) setState(() => _page = p);
      return;
    }
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
      final shown = _shownAt;
      if (shown != null && widget.active && _fg) {
        _shownAt = null;
        Telemetry.event('hf_reel_start', {
          'platform': _platform,
          'ms': DateTime.now().difference(shown).inMilliseconds,
          'warmed': _shownWarm,
        });
      }
      // [HF-REEL-YT-POSTER-1] first on-screen play of a YouTube reel: keep the poster up while YouTube shows its buttons
      if (!_isIg && widget.active && _fg && _coverArmed && youtubeChromeCover > Duration.zero) {
        _coverArmed = false;
        _coverTimer?.cancel();
        setState(() => _chromeCover = true);
        _coverTimer = Timer(youtubeChromeCover, () {
          if (mounted) setState(() => _chromeCover = false);
        });
      }
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

  Widget _thumb() {
    final t = widget.reel.thumbUrl;
    if (t == null) return const ColoredBox(color: C.cinema);
    return NetImage(
      t,
      fit: BoxFit.cover,
      fallback: const ColoredBox(color: C.cinema),
    );
  }

  /// [HF-REEL-OWN-1] owner: viewers are never sent to YouTube / Instagram. A reel that cannot play here shows its poster
  /// with a plain note; the feed drops it and moves on.
  Widget _fallback() {
    return Stack(
      key: const ValueKey('reel-fallback'),
      fit: StackFit.expand,
      children: [
        _thumb(),
        ColoredBox(color: C.cinema.withValues(alpha: 0.55)),
        Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Text(
              'This video cannot play here. Swipe up for the next one.',
              textAlign: TextAlign.center,
              style: t(17, color: C.ivory, w: FontWeight.w800, h: 1.35),
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
        if (_web != null && _fg && (!_played || _chromeCover))
          Positioned.fill(child: IgnorePointer(child: _thumb())),
        // The transparent layer with our control: a tap goes to the video underneath as play / pause. [HF-REEL-OVERLAY-APP-1]
        // Instagram: the whole player (its own controls are hidden). YouTube: the whole player except a hole over YouTube's own
        // mute icon, so YouTube's title, channel, menu, like and share are visible but not tappable. Only taps are taken, so a
        // vertical swipe still reaches the PageView.
        if (_wantEmbed && _engine && _fg)
          LayoutBuilder(
            builder: (context, box) {
              final tiles = _isIg
                  ? [Offset.zero & box.biggest]
                  : ReelPlayer.youtubeTapTiles(ReelPlayer.playerBox(_page, box.biggest));
              var big = 0;
              for (var i = 1; i < tiles.length; i++) {
                if (tiles[i].width * tiles[i].height > tiles[big].width * tiles[big].height) big = i;
              }
              return Stack(
                fit: StackFit.expand,
                children: [
                  for (var i = 0; i < tiles.length; i++)
                    Positioned.fromRect(
                      rect: tiles[i],
                      child: GestureDetector(
                        key: i == big ? const ValueKey('reel-tap') : null,
                        behavior: HitTestBehavior.opaque,
                        onTap: _toggle,
                        child: const SizedBox.expand(),
                      ),
                    ),
                ],
              );
            },
          ),
        // Instagram's own play control is hidden, so this is the ONE paused symbol the viewer sees (YouTube draws its own).
        if (_isIg && _engine && _fg && !_isPlaying)
          Positioned.fill(
            child: IgnorePointer(
              child: Center(
                child: Icon(
                  Icons.play_arrow_rounded,
                  key: const ValueKey('reel-glyph'),
                  size: 84,
                  color: C.white,
                  shadows: [Shadow(color: C.cinema.withValues(alpha: 0.9), blurRadius: 12)],
                ),
              ),
            ),
          ),
        // [HF-REEL-NOIG-1] no "Open in Instagram" chip on the video (owner 2026-10-22); the link is in the reel's info sheet
      ],
    );
  }
}

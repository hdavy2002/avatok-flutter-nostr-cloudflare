import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../../core/brand.dart';
import '../../data/api_exception.dart';
import '../../data/facebook_login.dart'; // [HF-INTRO-A3]
import '../../data/instagram_login.dart';
import '../../data/intro_flags.dart'; // [HF-INTRO-A3]
import '../../data/models/channel.dart';
import '../../data/repos/channels_repo.dart';
import '../../data/services.dart';
import '../../data/social_states.dart'; // [HF-SOCIAL-STATES]
import '../../data/telemetry.dart';
import '../../data/youtube_sign_in.dart';
import '../../ui/async_view.dart';
import '../theme.dart';
import '../widgets.dart';
import '../channel_kit.dart';
import '../desi.dart';

// Influencer Channels (HF-WIRE-3, handover section 6). YouTube connects by signing in with Google (HF-REEL-33, HF-WIRE-14: no code);
// Instagram keeps the handle + bio code and says "coming soon" while the provider is not switched on. Facebook says "coming soon" until hfFacebookLoginEnabled
// is on, then it is "Log in with Facebook" (Specs/HF-FACEBOOK-LOGIN-1.md). [HF-INTRO-A3] The screens are called "Social media verification" (D3).
// Routes: /inf/channels, /inf/channels/add, /inf/channels/add/:platform, /inf/channels/:id/checking.
// `?from=join` keeps the person inside "Join as influencer" (step 2 of 3) instead of the dashboard.

String _fromQuery(String? from) => (from == null || from.isEmpty) ? '' : '?from=$from';

/// [HF-IG-LOGIN-1] Whether "Log in with Instagram" is offered. `probe` asks the public config (`hfInstagramLoginEnabled`; what the app uses);
/// tests pass `on`. `off` (the default) keeps the bio-code form only.
enum IgLoginMode { off, probe, on }

/// [HF-REEL-61] Shown on Channels for an Instagram channel that was added by bio code.
const String kInstagramBioCodeBanner = 'Log in with Instagram to bring your comments and likes.';
const String kInstagramReconnectBanner = 'Your Instagram login has expired. Log in again to keep bringing in comments and likes.';

String channelChipLabel(Channel c, int minFollowers) => switch (c.state) {
      ChannelState.checking => 'Checking…',
      ChannelState.approved => 'Approved',
      ChannelState.needsFollowers => 'Needs $minFollowers+ followers',
      ChannelState.needsViews => 'Needs more views',
      ChannelState.disconnected => 'Disconnected',
    };

String _count(int n) {
  final s = n.toString();
  final b = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) b.write(',');
    b.write(s[i]);
  }
  return b.toString();
}

String _ago(int? ms) {
  if (ms == null) return 'Not checked yet';
  final d = DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(ms));
  if (d.inMinutes < 2) return 'Checked just now';
  if (d.inMinutes < 60) return 'Checked ${d.inMinutes} min ago';
  if (d.inHours < 24) return 'Checked ${d.inHours} h ago';
  return 'Checked ${d.inDays} days ago';
}

IconData _platformIcon(String platform) => platform == 'instagram' ? Icons.camera_alt_rounded : (platform == 'facebook' ? Icons.facebook_rounded : Icons.smart_display_rounded);

// ---------------------------------------------------------------------------------------------- Card

/// One connected channel: platform, @handle, followers, status chip, last check, and its buttons.
class ChannelCard extends StatelessWidget {
  const ChannelCard({super.key, required this.channel, required this.minFollowers, this.minViews = ChannelsList.defaultMinViews, this.onResync, this.onRemove, this.onFinish, this.resyncLabel = 'RESYNC'});

  final Channel channel;
  final int minFollowers;

  /// [HF-SOCIAL-STATES] For the "what it needs" line of a YouTube channel below the minimum.
  final int minViews;

  /// [HF-SOCIAL-STATES] A Facebook Page has no stored login to re-read: its button says LOG IN AGAIN.
  final String resyncLabel;
  final VoidCallback? onResync;
  final VoidCallback? onRemove;

  /// "Finish checking" for a channel still waiting for its code.
  final VoidCallback? onFinish;

  /// [HF-APP-DESI-13] approved channel card.
  @override
  Widget build(BuildContext context) {
    final c = channel;
    final (Color bg, Color fg, IconData? chipIcon, Color edge) = switch (c.state) {
      ChannelState.approved => (C.teatint, const Color(0xFF0B5F66), Icons.check_rounded, const Color(0xFFF8C4D9)),
      ChannelState.checking => (C.goldtint, C.amber, Icons.hourglass_top_rounded, const Color(0xFFF3DFB3)),
      ChannelState.needsFollowers => (const Color(0xFFF3EEF2), C.ruby, null, const Color(0xFFDDD2FB)),
      ChannelState.needsViews => (const Color(0xFFF3EEF2), C.ruby, null, const Color(0xFFDDD2FB)),
      ChannelState.disconnected => (const Color(0xFFF3EEF2), C.muted, null, C.line),
    };
    final live = c.state != ChannelState.disconnected;
    return Semantics(
      container: true,
      label: '${c.platformName} ${socialAccountName(c.platform, c.handle, c.displayHandle)}, ${channelChipLabel(c, minFollowers)}',
      child: Container(
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: C.white,
          borderRadius: BorderRadius.circular(22),
          border: Border.all(color: edge, width: 2),
          boxShadow: const [BoxShadow(color: Color(0x404A1747), offset: Offset(0, 8), blurRadius: 18, spreadRadius: -12)],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                PlatformSquare(platform: c.platform, icon: _platformIcon(c.platform)),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(socialAccountName(c.platform, c.handle, c.displayHandle), style: t(18, color: C.deep, w: FontWeight.w900), overflow: TextOverflow.ellipsis),
                      Text('${_count(c.followers)} ${c.followersWord} · ${c.platformName}', style: t(14, color: C.muted, w: FontWeight.w700)),
                    ],
                  ),
                ),
                const SizedBox(width: 6),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    if (chipIcon != null) ...[Icon(chipIcon, size: 15, color: fg), const SizedBox(width: 4)],
                    Text(channelChipLabel(c, minFollowers), style: t(14, color: fg, w: FontWeight.w800)),
                  ]),
                ),
              ],
            ),
            // [HF-SOCIAL-STATES] connected (she proved it is hers) but below the minimum: say so, and what still counts
            if (c.belowMinimum) ...[
              const SizedBox(height: 8),
              Text(
                '${c.isFacebook ? 'Facebook Page' : (c.isInstagram ? 'Instagram account' : 'YouTube channel')} connected. ${socialBelowNeed(SocialAccount(id: c.id, platform: c.platform, handle: c.handle, displayHandle: c.displayHandle, followers: c.followers, views: c.views, need: c.need ?? (c.state == ChannelState.needsViews ? 'views' : 'followers')), minFollowers, minViews)}',
                style: t(14, color: C.deep, w: FontWeight.w700, h: 1.35),
              ),
            ],
            const SizedBox(height: 8),
            Text(c.needsCode ? 'Waiting for your code' : _ago(c.lastSyncAt), style: t(14, color: C.muted, w: FontWeight.w700)),
            if (live) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  if (c.needsCode && onFinish != null)
                    Expanded(child: ChannelPill(label: 'FINISH CHECKING', gold: true, onTap: onFinish))
                  else if (onResync != null)
                    Expanded(child: ChannelPill(label: resyncLabel, onTap: onResync)),
                  if (onRemove != null) ...[
                    const SizedBox(width: 8),
                    Expanded(child: ChannelPill(label: 'REMOVE', onTap: onRemove)),
                  ],
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------- List

/// `/inf/channels`: every channel with its status, Resync and Remove, and "+ Add a channel".
class ChannelsListScreen extends StatefulWidget {
  const ChannelsListScreen({super.key, this.repo, this.ig, this.fb, this.reason, this.result, this.igLogin = IgLoginMode.off});

  final ChannelsRepo? repo;

  /// [HF-IG-LOGIN-1] What the Instagram login redirect said: `connected` or `error` (+ [reason], [result]); null when she just opened the list.
  final String? ig;

  /// [HF-INTRO-A3] What the Facebook login redirect said: `connected` or `error` (+ [reason], [result]).
  final String? fb;
  final String? reason;
  final String? result;
  final IgLoginMode igLogin;

  @override
  State<ChannelsListScreen> createState() => _ChannelsListScreenState();
}

class _ChannelsListScreenState extends State<ChannelsListScreen> {
  late final ChannelsRepo _repo = widget.repo ?? Services.instance.channelsRepo;
  int _key = 0;
  bool _igOn = false;
  String? _handledIg;
  String? _handledFb;

  @override
  void initState() {
    super.initState();
    Telemetry.event('hf_channels_open');
    _igOn = widget.igLogin == IgLoginMode.on;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _handleIgResult();
      _handleFbResult();
    });
  }

  @override
  void didUpdateWidget(ChannelsListScreen old) {
    super.didUpdateWidget(old);
    if (old.ig != widget.ig || old.fb != widget.fb || old.reason != widget.reason || old.result != widget.result) {
      _handleIgResult();
      _handleFbResult();
      _reload();
    }
  }

  Future<ChannelsList> _load() async {
    final l = await _repo.list();
    if (widget.igLogin == IgLoginMode.probe) _igOn = await _repo.instagramLoginEnabled();
    return l;
  }

  /// [HF-IG-LOGIN-1] The answer of the Instagram login (deep link `<scheme>://channels?ig=...`): connected -> a toast, a personal account -> the
  /// "Switch to a Creator account" guide, cancelled -> a toast. The list reloads on its own.
  void _handleIgResult() {
    final ig = widget.ig;
    if (!mounted || ig == null) return;
    final stamp = '$ig/${widget.reason}/${widget.result}';
    if (_handledIg == stamp) return;
    _handledIg = stamp;
    final reason = widget.reason ?? '';
    Telemetry.event('hf_ig_login_result', {'ig': ig, if (reason.isNotEmpty) 'reason': reason, if (widget.result != null) 'result': widget.result});
    if (ig == 'connected') {
      toast(context, widget.result == 'needs_followers' ? socialConnectedText('instagram', widget.result) : 'Instagram connected. Your comments and likes will come in.');
      return;
    }
    switch (reason) {
      case 'not_professional':
      case 'personal':
        unawaited(context.push('/inf/channels/instagram-guide'));
      case 'cancelled':
        toast(context, 'Login cancelled. You can try again anytime.');
      case 'claimed':
        toast(context, 'That Instagram account is already connected to another person.');
      case 'limit_reached':
        toast(context, 'You can connect up to 5 social accounts. Remove one first.');
      default:
        toast(context, 'Instagram login did not work. Please try again.');
    }
  }

  /// [HF-INTRO-A3] The answer of the Facebook login (deep link `<scheme>://channels?fb=...`): connected -> a toast, anything else -> a plain reason.
  void _handleFbResult() {
    final fb = widget.fb;
    if (!mounted || fb == null) return;
    final stamp = '$fb/${widget.reason}/${widget.result}';
    if (_handledFb == stamp) return;
    _handledFb = stamp;
    final reason = widget.reason ?? '';
    Telemetry.event('hf_fb_login_result', {'fb': fb, if (reason.isNotEmpty) 'reason': reason, if (widget.result != null) 'result': widget.result});
    if (fb == 'connected') {
      // [HF-SOCIAL-STATES] result=needs_followers: connected, but it does not count yet (the card below shows the Page and what it needs)
      toast(context, socialConnectedText('facebook', widget.result));
      return;
    }
    toast(context, socialReasonText('facebook', reason));
  }

  /// [HF-REEL-61] A bio-code Instagram channel (or a login that expired) gets a banner asking her to log in.
  List<Widget> _igBanners(ChannelsList v) {
    if (!_igOn) return const [];
    final reconnect = v.active.any((c) => c.isInstagram && c.needsReconnect);
    if (!reconnect && !v.active.any((c) => c.isInstagramBioCode)) return const [];
    return [
      IgLoginBanner(
        text: reconnect ? kInstagramReconnectBanner : kInstagramBioCodeBanner,
        button: reconnect ? 'LOG IN AGAIN' : 'LOG IN WITH INSTAGRAM',
        onTap: () async {
          Telemetry.event('hf_ig_banner_tap', {'kind': reconnect ? 'reconnect' : 'bio_code'});
          await context.push('/inf/channels/add/instagram');
          _reload();
        },
      ),
      const SizedBox(height: 14),
    ];
  }

  void _reload() {
    if (mounted) setState(() => _key++);
  }

  Future<void> _add() async {
    await context.push('/inf/channels/add');
    _reload();
  }

  Future<void> _resync(Channel c) async {
    try {
      final r = await _repo.resync(c.id);
      if (mounted) toast(context, r.message.isEmpty ? 'Updated.' : r.message);
    } on ApiException catch (e) {
      if (mounted) toast(context, e.userMessage);
    }
    _reload();
  }

  Future<void> _remove(Channel c) async {
    final ok = await hfConfirm(
      context,
      title: 'Remove this account?',
      body: 'Fans will no longer see reels from ${socialAccountName(c.platform, c.handle, c.displayHandle)}.',
      confirmLabel: 'REMOVE',
      cancelLabel: 'KEEP IT',
      destructive: true,
    );
    if (ok != true) return;
    try {
      await _repo.remove(c.id);
    } on ApiException catch (e) {
      if (mounted) toast(context, e.userMessage);
    }
    _reload();
  }

  @override
  Widget build(BuildContext context) {
    final addButton = DashedAddButton(label: '+ ADD SOCIAL MEDIA', onTap: _add);
    // [HF-APP-DESI-13] approved Channels list
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(
          children: [
            const ChannelHeader('Social media verification'),
            Expanded(
              child: AsyncLoader<ChannelsList>(
                load: _load,
                reloadKey: _key,
                isEmpty: (v) => v.active.isEmpty,
                loadingLabel: 'Loading your social media…',
                emptyTitle: 'Nothing verified yet',
                emptyMessage: 'Add your Instagram, YouTube or Facebook so fans can see your reels.',
                emptyAction: SizedBox(width: 280, child: addButton),
                builder: (context, v) => ListView(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                  children: [
                    const DesiHero(eyebrow: 'Verification', title: 'Social media verification', sub: 'Where fans see your reels.', ghost: 'Reels', tone: DesiTone.lav, minHeight: 110),
                    const SizedBox(height: 12),
                    Text(
                      v.qualified
                          ? 'You are approved. Keep at least one channel with ${v.minFollowers}+ followers or subscribers.'
                          : 'We need at least ${v.minFollowers} followers or subscribers on one YouTube, Instagram or Facebook account, and ${v.minViews} total views on YouTube. An account under that is shown here but does not count yet: add another one, or do the Aadhaar check / video KYC.',
                      style: t(15, color: C.muted, w: FontWeight.w700, h: 1.4),
                    ),
                    const SizedBox(height: 14),
                    ..._igBanners(v),
                    for (final c in v.active)
                      ChannelCard(
                        channel: c,
                        minFollowers: v.minFollowers,
                        minViews: v.minViews,
                        resyncLabel: c.isFacebook ? 'LOG IN AGAIN' : 'RESYNC',
                        onResync: c.isFacebook ? () => unawaited(context.push('/inf/channels/add/facebook').then((_) => _reload())) : () => unawaited(_resync(c)),
                        onRemove: () => unawaited(_remove(c)),
                        onFinish: () => unawaited(context.push('/inf/channels/${c.id}/checking').then((_) => _reload())),
                      ),
                    const SizedBox(height: 4),
                    addButton,
                    const SizedBox(height: 14),
                    const DesiMogra(),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------- Pick a platform

/// `/inf/channels/add`: Instagram, YouTube, and Facebook ("coming soon" until `hfFacebookLoginEnabled`).
class ChannelPlatformScreen extends StatelessWidget {
  const ChannelPlatformScreen({super.key, this.from});

  final String? from;

  /// [HF-APP-DESI-13] approved "Add a channel" layout. [HF-INTRO-A3] Facebook is a real tile once `hfFacebookLoginEnabled` is on.
  @override
  Widget build(BuildContext context) {
    return FutureBuilder<void>(
      future: IntroFlags.ensureLoaded(),
      builder: (context, _) => _page(context),
    );
  }

  Widget _page(BuildContext context) {
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(
          children: [
            const ChannelHeader('Add social media'),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                children: [
                  const DesiHero(eyebrow: 'Add social media', title: 'Where are your reels?', sub: 'Pick one. You can add more later.', tone: DesiTone.gold, minHeight: 110),
                  const SizedBox(height: 12),
                  _tile(context, icon: Icons.camera_alt_rounded, name: 'Instagram', sub: 'Your reels and public videos', platform: 'instagram'),
                  _tile(context, icon: Icons.smart_display_rounded, name: 'YouTube', sub: 'Sign in with YouTube. Your public videos', platform: 'youtube'),
                  _tile(
                    context,
                    icon: Icons.facebook_rounded,
                    name: 'Facebook',
                    sub: IntroFlags.facebookLogin ? 'Log in with Facebook. Your Page' : 'Coming soon',
                    platform: IntroFlags.facebookLogin ? 'facebook' : null,
                  ),
                  const SizedBox(height: 8),
                  const DesiMogra(),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _tile(BuildContext context, {required IconData icon, required String name, required String sub, required String? platform}) {
    final on = platform != null;
    return Semantics(
      button: true,
      enabled: on,
      label: on ? name : '$name, coming soon',
      child: Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Material(
          color: on ? C.white : const Color(0xFFF7F1F5),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(22), side: BorderSide(color: on ? const Color(0xFFF8C4D9) : C.line, width: 2)),
          child: InkWell(
            borderRadius: BorderRadius.circular(22),
            onTap: on ? () => context.push('/inf/channels/add/$platform${_fromQuery(from)}') : null,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  PlatformSquare(platform: platform ?? name.toLowerCase(), icon: icon, size: 52, off: !on),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(name, style: t(20, color: on ? C.deep : C.muted, w: FontWeight.w900)),
                        Text(sub, style: t(14, color: C.muted, w: FontWeight.w700)),
                      ],
                    ),
                  ),
                  if (on) const Icon(Icons.chevron_right_rounded, color: C.maroon, size: 30),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------- Consent + code

/// `/inf/channels/add/:platform`: the @handle, four tick boxes, CONNECT, then the one-time code to put in the bio.
class ChannelConsentScreen extends StatefulWidget {
  const ChannelConsentScreen({super.key, required this.platform, this.from, this.repo, this.signIn, this.igLogin = IgLoginMode.off, this.instagramLogin, this.facebookLogin});

  final String platform;
  final String? from;
  final ChannelsRepo? repo;

  /// [HF-IG-LOGIN-1] Offer "Log in with Instagram" ([IgLoginMode]); [instagramLogin] opens the browser tab (tests pass a fake).
  final IgLoginMode igLogin;
  final InstagramLogin? instagramLogin;

  /// [HF-INTRO-A3] Opens the Facebook login tab for `platform == 'facebook'` (tests pass a fake).
  final FacebookLogin? facebookLogin;

  /// Google sign-in for YouTube. Tests pass a fake.
  final YoutubeSignIn? signIn;

  @override
  State<ChannelConsentScreen> createState() => _ChannelConsentScreenState();
}

class _ChannelConsentScreenState extends State<ChannelConsentScreen> {
  late final ChannelsRepo _repo = widget.repo ?? Services.instance.channelsRepo;
  YoutubeSignIn get _signIn => widget.signIn ?? Services.instance.youtubeSignIn;
  final _handle = TextEditingController();
  final List<bool> _ticks = [false, false, false, false];
  bool _ytTick = false;
  bool _busy = false;
  String? _error;
  AddedChannel? _added;

  // [HF-IG-LOGIN-1] null = still asking the config whether Instagram login is on.
  bool? _igOn;
  bool _igTick = false;
  bool _codeInstead = false;
  bool _igWaiting = false;
  InstagramLogin get _login => widget.instagramLogin ?? const UrlLauncherInstagramLogin();

  // [HF-INTRO-A3] Log in with Facebook: shown once the flag has been read and is true.
  bool _fbReady = false;
  bool _fbTick = false;
  bool _fbWaiting = false;
  FacebookLogin get _fbLogin => widget.facebookLogin ?? const UrlLauncherFacebookLogin();

  @override
  void initState() {
    super.initState();
    if (widget.platform == 'facebook') {
      unawaited(IntroFlags.ensureLoaded().then((_) {
        if (mounted) setState(() => _fbReady = true);
      }));
    }
    if (widget.platform != 'instagram' || widget.igLogin == IgLoginMode.off) {
      _igOn = false;
    } else if (widget.igLogin == IgLoginMode.on) {
      _igOn = true;
    } else {
      unawaited(_probe());
    }
  }

  Future<void> _probe() async {
    final on = await _repo.instagramLoginEnabled();
    if (mounted) setState(() => _igOn = on);
  }

  /// [HF-INTRO-A3] Asks the server for the Facebook login page and opens it in an in-app browser tab. The answer comes back as a deep link.
  Future<void> _loginFacebook() async {
    if (!_fbTick) {
      setState(() => _error = 'Please tick the box so we can show your reels.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    Telemetry.event('hf_channel_add_start', {'platform': 'facebook', 'via': 'login'});
    try {
      final url = await _repo.facebookLoginUrl();
      final ok = await _fbLogin.open(url);
      Telemetry.event('hf_fb_login_open', {'ok': ok});
      if (!mounted) return;
      setState(() {
        _busy = false;
        _fbWaiting = ok;
        _error = ok ? null : 'We could not open Facebook. Please try again.';
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.userMessage;
      });
    }
  }

  /// [HF-IG-LOGIN-1] Asks the server for the Instagram login page and opens it in an in-app browser tab. The answer comes back as a deep link.
  Future<void> _loginInstagram() async {
    if (!_igTick) {
      setState(() => _error = 'Please tick the box so we can show your reels.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    Telemetry.event('hf_channel_add_start', {'platform': 'instagram', 'via': 'login'});
    try {
      final url = await _repo.instagramLoginUrl();
      final ok = await _login.open(url);
      Telemetry.event('hf_ig_login_open', {'ok': ok});
      if (!mounted) return;
      setState(() {
        _busy = false;
        _igWaiting = ok;
        _error = ok ? null : 'We could not open Instagram. Please try again.';
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.userMessage;
      });
    }
  }

  static const _labels = [
    'Show my public videos from this channel as embeds in the Reels feed and on my profile.',
    'Show my follower, like, comment and video counts.',
    'I choose which of my videos go on the feed, and I can remove any video.',
    'This channel is mine.',
  ];

  bool get _supported => widget.platform == 'instagram' || widget.platform == 'youtube';
  bool get _ig => widget.platform == 'instagram';
  bool get _fb => widget.platform == 'facebook'; // [HF-INTRO-A3]
  String get _name => _ig ? 'Instagram' : (_fb ? 'Facebook' : 'YouTube');

  @override
  void dispose() {
    _handle.dispose();
    super.dispose();
  }

  /// YouTube: Google sign-in proves the channel is hers; the server approves and brings in her public videos.
  Future<void> _connectYoutube() async {
    if (!_ytTick) {
      setState(() => _error = 'Please tick the box so we can show your videos.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    Telemetry.event('hf_channel_add_start', {'platform': 'youtube', 'via': 'signin'});
    try {
      final token = await _signIn.accessToken();
      final r = await _repo.connectYoutube(token);
      await _signIn.signOut();
      if (!mounted) return;
      context.pushReplacement('/inf/channels/${r.channel.id}/checking${_fromQuery(widget.from)}', extra: r);
    } on YoutubeSignInCancelled {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = 'Sign-in was cancelled. Tap the button to try again.';
      });
    } on YoutubeSignInFailed catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.message;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.userMessage;
      });
    }
  }

  Future<void> _connect() async {
    if (_handle.text.trim().isEmpty) {
      setState(() => _error = _ig ? 'Type your Instagram @username.' : 'Type your @handle or paste your channel link.');
      return;
    }
    if (_ticks.contains(false)) {
      setState(() => _error = 'Please tick all four boxes so we can show your reels.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    Telemetry.event('hf_channel_add_start', {'platform': widget.platform});
    try {
      final a = await _repo.add(platform: widget.platform, handleOrUrl: _handle.text);
      if (!mounted) return;
      setState(() {
        _added = a;
        _busy = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        // The Instagram provider is not switched on yet: a friendly, honest answer instead of an error.
        _error = e.code == 'provider_not_configured' && _ig ? 'Instagram is coming soon. Please connect YouTube for now.' : e.userMessage;
        _busy = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    // [HF-APP-DESI-13] approved "Connect + code" layout
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(
          children: [
            ChannelHeader(_supported || _fb ? 'Connect $_name' : 'Add social media'),
            Expanded(
              child: _fb
                  ? (!_fbReady ? const Center(child: CircularProgressIndicator()) : (IntroFlags.facebookLogin ? _facebookForm() : Center(child: Padding(padding: const EdgeInsets.all(28), child: Text('Facebook is coming soon. Please use Instagram or YouTube for now.', textAlign: TextAlign.center, style: t(18, color: C.deep, h: 1.35))))))
                  : !_supported
                  ? Center(child: Padding(padding: const EdgeInsets.all(28), child: Text('That social media type is coming soon. Please use Instagram or YouTube for now.', textAlign: TextAlign.center, style: t(18, color: C.deep, h: 1.35))))
                  : !_ig
                      ? _youtubeForm()
                      : _igOn == null
                          ? const Center(child: CircularProgressIndicator())
                          : (_igOn! && !_codeInstead && _added == null)
                              ? _instagramLoginForm()
                              : _added == null
                                  ? _form()
                                  : _codeStep(_added!),
            ),
          ],
        ),
      ),
    );
  }

  static final String _ytLabel =
      'I allow ${Brand.name} to read my YouTube channel (read only) and show my public videos with the official YouTube player. This channel is mine.';

  Widget _youtubeForm() => ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
        children: [
          const DesiHero(eyebrow: 'YouTube', title: 'Sign in with YouTube', tone: DesiTone.rani, minHeight: 100),
          const SizedBox(height: 12),
          Text(
            'Sign in with the Google account of your YouTube channel. That is how we know the channel is yours. We only read your channel and public videos: we never post, change or download anything.',
            style: t(16, w: FontWeight.w700, h: 1.4),
          ),
          const SizedBox(height: 8),
          Text('All your public videos are shown by default. You can hide any video later.', style: t(15, color: C.muted, w: FontWeight.w700, h: 1.4)),
          const SizedBox(height: 16),
          KeyedSubtree(
            key: const ValueKey('yt-consent'),
            child: ConsentTick(label: _ytLabel, value: _ytTick, onTap: _busy ? null : () => setState(() => _ytTick = !_ytTick)),
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: t(15, color: C.ruby, h: 1.35)),
          ],
          const SizedBox(height: 14),
          ChannelBigButton(label: _busy ? 'CHECKING…' : 'SIGN IN WITH YOUTUBE', onTap: _busy ? null : () => unawaited(_connectYoutube())),
          const SizedBox(height: 14),
          const DesiMogra(),
        ],
      );

  static final String _fbLabel =
      'I allow ${Brand.name} to read my Facebook Page name, link and follower count (read only) to show it is mine. This Page is mine.';

  /// [HF-INTRO-A3] Log in with Facebook (Specs/HF-FACEBOOK-LOGIN-1.md): proves she owns a public Facebook Page. There is no bio-code route.
  Widget _facebookForm() => ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
        children: [
          const DesiHero(eyebrow: 'Facebook', title: 'Log in with Facebook', tone: DesiTone.rani, minHeight: 100),
          const SizedBox(height: 12),
          Text(
            'Log in with the Facebook account that manages your Page. That is how we know the Page is yours. We only read your Page name, link and follower count: we never post, change or download anything.',
            style: t(16, w: FontWeight.w700, h: 1.4),
          ),
          const SizedBox(height: 16),
          KeyedSubtree(
            key: const ValueKey('fb-consent'),
            child: ConsentTick(label: _fbLabel, value: _fbTick, onTap: _busy ? null : () => setState(() => _fbTick = !_fbTick)),
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: t(15, color: C.ruby, h: 1.35)),
          ] else if (_fbWaiting) ...[
            const SizedBox(height: 10),
            Text('Finish logging in on Facebook. You will come back here on your own.', style: t(15, color: C.muted, w: FontWeight.w700, h: 1.35)),
          ],
          const SizedBox(height: 14),
          ChannelBigButton(label: _busy ? 'OPENING…' : 'LOG IN WITH FACEBOOK', onTap: _busy ? null : () => unawaited(_loginFacebook())),
          const SizedBox(height: 14),
          const DesiMogra(),
        ],
      );

  static final String _igLabel =
      'I allow ${Brand.name} to read my Instagram reels, comments and likes (read only) and show my reels in the Reels feed. This account is mine.';

  /// [HF-IG-LOGIN-1] HF-REEL-58: log in with Instagram (Creator / Business account). Bio code stays as a small fallback.
  Widget _instagramLoginForm() => ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
        children: [
          const DesiHero(eyebrow: 'Instagram', title: 'Log in with Instagram', tone: DesiTone.rani, minHeight: 100),
          const SizedBox(height: 12),
          Text(
            'Log in with the Instagram account that posts your reels. That is how we know it is yours, and it lets us bring your comments and likes into ${Brand.name}. We only read: we never post, change or download anything.',
            style: t(16, w: FontWeight.w700, h: 1.4),
          ),
          const SizedBox(height: 8),
          Text('It needs a Creator or Business account. Have a personal account? We will show you how to switch. It is free and takes about a minute.', style: t(15, color: C.muted, w: FontWeight.w700, h: 1.4)),
          const SizedBox(height: 16),
          KeyedSubtree(
            key: const ValueKey('ig-consent'),
            child: ConsentTick(label: _igLabel, value: _igTick, onTap: _busy ? null : () => setState(() => _igTick = !_igTick)),
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: t(15, color: C.ruby, h: 1.35)),
          ] else if (_igWaiting) ...[
            const SizedBox(height: 10),
            Text('Finish logging in on Instagram. You will come back here on your own.', style: t(15, color: C.muted, w: FontWeight.w700, h: 1.35)),
          ],
          const SizedBox(height: 14),
          ChannelBigButton(label: _busy ? 'OPENING…' : 'LOG IN WITH INSTAGRAM', onTap: _busy ? null : () => unawaited(_loginInstagram())),
          const SizedBox(height: 6),
          Semantics(
            button: true,
            label: "Can't log in? Verify with a code instead",
            child: InkWell(
              key: const ValueKey('ig-code-link'),
              onTap: _busy
                  ? null
                  : () => setState(() {
                        _codeInstead = true;
                        _error = null;
                      }),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 48),
                child: Center(
                  child: Text("Can't log in? Verify with a code instead", textAlign: TextAlign.center, style: t(15, color: C.maroon, w: FontWeight.w800).copyWith(decoration: TextDecoration.underline)),
                ),
              ),
            ),
          ),
          const SizedBox(height: 8),
          const DesiMogra(),
        ],
      );

  Widget _form() => ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
        children: [
          if (_ig && _igOn == true) ...[
            Text('A code only proves the account is yours. To bring in your comments and likes, log in with Instagram instead.', style: t(15, color: C.muted, w: FontWeight.w700, h: 1.4)),
            const SizedBox(height: 10),
          ],
          DesiField(
            label: _ig ? 'Your Instagram @username' : 'Your YouTube @handle or channel link',
            field: TextField(
              controller: _handle,
              keyboardType: _ig ? TextInputType.text : TextInputType.url,
              autocorrect: false,
              enabled: !_busy,
              style: t(18, w: FontWeight.w800),
              decoration: InputDecoration(hintText: _ig ? '@yourname' : '@yourchannel'),
            ),
          ),
          const SizedBox(height: 12),
          for (var i = 0; i < _labels.length; i++) _check(i),
          if (_error != null) ...[
            const SizedBox(height: 4),
            Text(_error!, style: t(15, color: C.ruby, h: 1.35)),
          ],
          const SizedBox(height: 14),
          ChannelBigButton(label: _busy ? 'CHECKING…' : 'CONNECT', onTap: _busy ? null : () => unawaited(_connect())),
          const SizedBox(height: 14),
          const DesiMogra(),
        ],
      );

  Widget _check(int i) {
    final v = _ticks[i];
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: ConsentTick(label: _labels[i], value: v, onTap: _busy ? null : () => setState(() => _ticks[i] = !v)),
    );
  }

  Widget _codeStep(AddedChannel a) {
    final where = _ig ? 'Instagram bio' : 'YouTube channel description';
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      children: [
        CodeStepCard(
          message: 'We found ${a.channel.handle.startsWith('@') ? a.channel.handle : '@${a.channel.handle}'}. To show it is yours, add this code to your $where.',
          code: CodeBox(code: a.verifyCode),
          line: a.instructions.isEmpty ? 'Save it, then tap the button below. You can remove the code after we confirm.' : a.instructions,
        ),
        const SizedBox(height: 16),
        ChannelBigButton(
          label: "I'VE ADDED IT, CHECK NOW",
          onTap: () => context.pushReplacement('/inf/channels/${a.channel.id}/checking${_fromQuery(widget.from)}'),
        ),
        const SizedBox(height: 14),
        const DesiMogra(),
      ],
    );
  }
}

/// The ownership code in big letters with a copy button.
class CodeBox extends StatelessWidget {
  const CodeBox({super.key, required this.code});

  final String code;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
      decoration: BoxDecoration(color: C.goldtint, borderRadius: BorderRadius.circular(18), border: Border.all(color: C.marigold, width: 2)),
      child: Row(
        children: [
          Expanded(child: SelectableText(code, style: t(32, color: C.deep, w: FontWeight.w900, ls: 0.1))),
          Semantics(
            button: true,
            label: 'Copy the code',
            child: IconButton(
              iconSize: 22,
              style: IconButton.styleFrom(backgroundColor: C.maroon, foregroundColor: C.lemon, minimumSize: const Size(48, 48)),
              icon: const Icon(Icons.copy_rounded),
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: code));
                if (context.mounted) toast(context, 'Code copied');
              },
            ),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------- Checking + result

/// `/inf/channels/:id/checking`: asks the server to re-read the bio and shows the result.
class ChannelCheckingScreen extends StatefulWidget {
  const ChannelCheckingScreen({super.key, required this.id, this.from, this.repo, this.onApprovedDone, this.initial});

  final String id;

  /// The answer of "Sign in with YouTube": already checked by the server, so show it instead of asking again.
  final ChannelCheck? initial;
  final String? from;
  final ChannelsRepo? repo;

  /// Tests replace "refresh /me and go to the dashboard".
  final VoidCallback? onApprovedDone;

  @override
  State<ChannelCheckingScreen> createState() => _ChannelCheckingScreenState();
}

class _ChannelCheckingScreenState extends State<ChannelCheckingScreen> {
  late final ChannelsRepo _repo = widget.repo ?? Services.instance.channelsRepo;
  AsyncState<ChannelCheck> _state = const AsyncLoading<ChannelCheck>();
  int _run = 0;

  bool get _join => widget.from == 'join';

  @override
  void initState() {
    super.initState();
    final first = widget.initial;
    if (first != null) {
      _state = AsyncData<ChannelCheck>(first);
    } else {
      unawaited(_go());
    }
  }

  Future<void> _go() async {
    final run = ++_run;
    if (run > 1) setState(() => _state = const AsyncLoading<ChannelCheck>());
    Telemetry.event('hf_channel_check_tap');
    AsyncState<ChannelCheck> next;
    try {
      final checked = await _repo.check(widget.id);
      Telemetry.event('hf_channel_threshold', {'result': checked.result.name, 'followers': checked.channel.followers, 'views': checked.channel.views}); // [HF-CREATOR-SPACES-1]
      next = AsyncData<ChannelCheck>(checked);
    } catch (e) {
      next = AsyncFailure<ChannelCheck>(e);
    }
    if (!mounted || run != _run) return;
    setState(() => _state = next);
  }

  void _leave() {
    if (_join) {
      context.go('/influencer/join?step=1');
    } else if (context.canPop()) {
      context.pop();
    } else {
      context.go('/inf/channels');
    }
  }

  Future<void> _approvedDone() async {
    final cb = widget.onApprovedDone;
    if (cb != null) {
      cb();
      return;
    }
    try {
      await Services.instance.refreshMe();
    } catch (_) {}
    if (!mounted) return;
    // [HF-INFLUENCER-GATE-1] Connecting an account never makes anyone an influencer: go back to where she came from.
    if (_join) {
      context.go('/influencer/join?step=2');
    } else if (context.canPop()) {
      context.pop();
    } else {
      context.go('/inf/channels');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(
          children: [
            const ChannelHeader('Checking your channel'),
            Expanded(
              child: _body(),
            ),
          ],
        ),
      ),
    );
  }

  /// [HF-CHANNEL-CHECK-20S-1] Loading shows the 20-second countdown; a timeout shows "Still checking" instead of "Slow connection".
  Widget _body() {
    final s = _state;
    if (s is AsyncLoading<ChannelCheck>) return const _CheckWaiting();
    if (s is AsyncFailure<ChannelCheck>) {
      final e = s.error;
      if (e is ApiException && e.isOffline && e.code == 'timeout') {
        return _StillChecking(onAgain: () => unawaited(_go()));
      }
    }
    return AsyncView<ChannelCheck>(
      state: _state,
      onRetry: () => unawaited(_go()),
      loadingLabel: 'Checking your channel…',
      builder: _result,
    );
  }

  /// [HF-APP-DESI-13] approved result card.
  Widget _result(BuildContext context, ChannelCheck r) {
    final ch = r.channel;
    switch (r.result) {
      case CheckResult.approved:
        return _panel(
          card: ResultCard(happy: true, art: 'influencer/online-mode.webp', title: "You're in!", message: r.message.isEmpty ? 'Your channel is confirmed.' : r.message),
          buttons: [ChannelBigButton(label: _join ? 'NEXT: YOUR WHATSAPP' : 'GO TO MY DASHBOARD', onTap: () => unawaited(_approvedDone()))],
        );
      case CheckResult.needsFollowers:
        return _panel(
          card: ResultCard(
            art: 'influencer/offline-mode.webp',
            title: 'Not yet',
            message: 'We need at least ${r.minFollowers} followers or subscribers on YouTube or Instagram. ${ch.handle.isEmpty ? '' : '${ch.handle} has ${_count(ch.followers)}.'}'.trim(),
          ),
          buttons: [
            ChannelBigButton(label: 'TRY ANOTHER CHANNEL', onTap: () => context.go('/inf/channels/add${_fromQuery(widget.from)}')),
            ChannelBigButton(label: 'CHECK AGAIN LATER', ghost: true, onTap: _leave),
          ],
        );
      case CheckResult.needsViews:
        return _panel(
          card: ResultCard(
            art: 'influencer/offline-mode.webp',
            title: 'Not yet',
            message: r.message.isEmpty ? 'We need at least ${r.minViews} total views on your YouTube channel.' : r.message,
          ),
          buttons: [
            ChannelBigButton(label: 'TRY ANOTHER CHANNEL', onTap: () => context.go('/inf/channels/add${_fromQuery(widget.from)}')),
            ChannelBigButton(label: 'CHECK AGAIN LATER', ghost: true, onTap: _leave),
          ],
        );
      case CheckResult.codeMissing:
        return _panel(
          card: ResultCard(
            title: 'We could not see the code yet',
            message: r.message.isEmpty ? 'It can take a minute to show. Check it is saved, then try again.' : r.message,
            extra: ch.verifyCode == null ? null : CodeBox(code: ch.verifyCode!),
          ),
          buttons: [
            ChannelBigButton(label: 'CHECK AGAIN', onTap: () => unawaited(_go())),
            ChannelBigButton(label: 'DO IT LATER', ghost: true, onTap: _leave),
          ],
        );
      case CheckResult.notFound:
      case CheckResult.private:
      case CheckResult.hiddenCount:
      case CheckResult.unknown:
        return _panel(
          card: ResultCard(title: 'We could not finish', message: r.message.isEmpty ? ApiException.genericText : r.message),
          buttons: [
            ChannelBigButton(label: 'CHECK AGAIN', onTap: () => unawaited(_go())),
            ChannelBigButton(label: 'BACK', ghost: true, onTap: _leave),
          ],
        );
    }
  }

  Widget _panel({required Widget card, required List<Widget> buttons}) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      children: [
        card,
        const SizedBox(height: 18),
        for (final b in buttons) Padding(padding: const EdgeInsets.only(bottom: 12), child: b),
        const DesiMogra(),
      ],
    );
  }
}

// ---------------------------------------------------------------------------------------------- Instagram login helpers

/// [HF-REEL-61] A soft banner on Channels asking her to log in with Instagram (bio-code channel, or a login that expired).
class IgLoginBanner extends StatelessWidget {
  const IgLoginBanner({super.key, required this.text, required this.button, required this.onTap});

  final String text;
  final String button;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      label: text,
      child: Container(
        key: const ValueKey('ig-login-banner'),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: C.goldtint, borderRadius: BorderRadius.circular(20), border: Border.all(color: C.marigold, width: 2)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(text, style: t(16, w: FontWeight.w800, h: 1.35)),
            const SizedBox(height: 12),
            ChannelBigButton(label: button, onTap: onTap),
          ],
        ),
      ),
    );
  }
}

/// `/inf/channels/instagram-guide`: Instagram only lets Creator and Business accounts log in. Plain steps to switch, then Try again.
class InstagramSwitchGuideScreen extends StatefulWidget {
  const InstagramSwitchGuideScreen({super.key});

  static const List<String> steps = [
    'Open Instagram and go to your profile.',
    'Tap the menu, then Settings and activity.',
    'Tap Account type and tools.',
    'Tap Switch to professional account.',
    'Choose Creator.',
    'Come back here and tap Try again.',
  ];

  @override
  State<InstagramSwitchGuideScreen> createState() => _InstagramSwitchGuideScreenState();
}

class _InstagramSwitchGuideScreenState extends State<InstagramSwitchGuideScreen> {
  @override
  void initState() {
    super.initState();
    Telemetry.event('hf_ig_guide_open');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(
          children: [
            const ChannelHeader('Switch to a Creator account'),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                children: [
                  const DesiHero(eyebrow: 'Instagram', title: 'One quick switch', sub: 'Instagram only lets Creator or Business accounts log in here.', tone: DesiTone.gold, minHeight: 110),
                  const SizedBox(height: 12),
                  Text('Your reels, followers and posts stay exactly as they are. It is free and takes about a minute.', style: t(16, w: FontWeight.w700, h: 1.4)),
                  const SizedBox(height: 14),
                  for (var i = 0; i < InstagramSwitchGuideScreen.steps.length; i++)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Container(
                            width: 32,
                            height: 32,
                            alignment: Alignment.center,
                            decoration: const BoxDecoration(color: C.maroon, shape: BoxShape.circle),
                            child: Text('${i + 1}', style: t(16, color: C.white, w: FontWeight.w900)),
                          ),
                          const SizedBox(width: 12),
                          Expanded(child: Padding(padding: const EdgeInsets.only(top: 4), child: Text(InstagramSwitchGuideScreen.steps[i], style: t(17, w: FontWeight.w800, h: 1.3)))),
                        ],
                      ),
                    ),
                  const SizedBox(height: 12),
                  ChannelBigButton(
                    label: 'TRY AGAIN',
                    onTap: () {
                      Telemetry.event('hf_ig_guide_try_again');
                      context.pushReplacement('/inf/channels/add/instagram');
                    },
                  ),
                  const SizedBox(height: 12),
                  ChannelBigButton(label: 'BACK', ghost: true, onTap: () => context.canPop() ? context.pop() : context.go('/inf/channels')),
                  const SizedBox(height: 14),
                  const DesiMogra(),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------- Join step 2

/// Step 2 of "Join as influencer": the person's channels and an "Add a channel" button. [onLoaded] tells the join
/// screen whether she is already approved so NEXT can let her through.
class ChannelsStep extends StatefulWidget {
  const ChannelsStep({super.key, this.repo, this.onLoaded, this.signedIn});

  final ChannelsRepo? repo;
  final ValueChanged<ChannelsList>? onLoaded;

  /// Tests pass `() => true`; the app asks the session.
  final bool Function()? signedIn;

  @override
  State<ChannelsStep> createState() => _ChannelsStepState();
}

class _ChannelsStepState extends State<ChannelsStep> {
  ChannelsRepo? _repoCache;
  ChannelsRepo get _repo => _repoCache ??= widget.repo ?? Services.instance.channelsRepo;
  int _key = 0;

  bool get _signedIn => widget.signedIn != null ? widget.signedIn!() : Services.instance.isSignedIn;

  Future<ChannelsList> _load() async {
    final l = await _repo.list();
    widget.onLoaded?.call(l);
    return l;
  }

  Future<void> _add() async {
    await context.push('/inf/channels/add?from=join');
    if (mounted) setState(() => _key++);
  }

  @override
  Widget build(BuildContext context) {
    if (!_signedIn) {
      return Column(
        children: [
          Text('Please sign in first so we can save your social media.', style: t(16, w: FontWeight.w700, h: 1.4)),
          const SizedBox(height: 14),
          ChannelBigButton(label: 'SIGN IN', onTap: () => unawaited(requireAccount(context, () => setState(() => _key++)))),
        ],
      );
    }
    final add = DashedAddButton(label: '+ ADD SOCIAL MEDIA', onTap: () => unawaited(_add()));
    return AsyncLoader<ChannelsList>(
      load: _load,
      reloadKey: _key,
      isEmpty: (v) => v.active.isEmpty,
      loadingLabel: 'Loading your social media…',
      emptyTitle: 'Nothing verified yet',
      emptyMessage: 'Add your Instagram, YouTube or Facebook so fans can see your reels.',
      emptyAction: SizedBox(width: 280, child: add),
      builder: (context, v) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('We need at least ${v.minFollowers} followers or subscribers on one YouTube or Instagram channel, and ${v.minViews} total views on YouTube (Instagram is checked on followers only).', style: t(15, color: C.muted, w: FontWeight.w700, h: 1.4)),
          const SizedBox(height: 12),
          for (final c in v.active)
            ChannelCard(
              channel: c,
              minFollowers: v.minFollowers,
              onFinish: () => unawaited(context.push('/inf/channels/${c.id}/checking?from=join').then((_) {
                    if (mounted) setState(() => _key++);
                  })),
            ),
          add,
        ],
      ),
    );
  }
}


/// [HF-CHANNEL-CHECK-20S-1] Shown while the server asks Instagram or YouTube. Counts down from [kChannelCheckSeconds] once a second and,
/// after [kChannelSlowAfterSeconds], says Instagram is slow today. The timer is cancelled in [dispose].
const int kChannelSlowAfterSeconds = 8;
const String kChannelCheckingText = 'Checking your channel… This can take up to $kChannelCheckSeconds seconds.';
const String kChannelSlowText = 'Instagram is answering slowly today. Please keep this screen open.';
const String kChannelStillCheckingTitle = 'Still checking';
const String kChannelStillCheckingText = 'Instagram took longer than $kChannelCheckSeconds seconds. Your check may still finish — tap Check again in a moment.';

class _CheckWaiting extends StatefulWidget {
  const _CheckWaiting();

  @override
  State<_CheckWaiting> createState() => _CheckWaitingState();
}

class _CheckWaitingState extends State<_CheckWaiting> {
  Timer? _timer;
  int _elapsed = 0;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() => _elapsed++);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _timer = null;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final left = (kChannelCheckSeconds - _elapsed).clamp(0, kChannelCheckSeconds);
    final slow = _elapsed >= kChannelSlowAfterSeconds;
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 24),
        child: Semantics(
          label: kChannelCheckingText,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SizedBox(width: 44, height: 44, child: CircularProgressIndicator(color: C.maroon, strokeWidth: 5)),
              const SizedBox(height: 18),
              Text(kChannelCheckingText, textAlign: TextAlign.center, style: t(16, color: C.deep, w: FontWeight.w700, h: 1.4)),
              const SizedBox(height: 14),
              ExcludeSemantics(child: Text('$left', key: const ValueKey('channel-countdown'), style: t(64, color: C.maroon, w: FontWeight.w900, h: 1.0))),
              if (slow) ...[
                const SizedBox(height: 14),
                Text(kChannelSlowText, key: const ValueKey('channel-slow-line'), textAlign: TextAlign.center, style: t(16, color: C.tan, w: FontWeight.w700, h: 1.4)),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _StillChecking extends StatelessWidget {
  const _StillChecking({required this.onAgain});

  final VoidCallback onAgain;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.hourglass_top_rounded, size: 56, color: C.violet),
            const SizedBox(height: 14),
            Text(kChannelStillCheckingTitle, textAlign: TextAlign.center, style: t(22, color: C.maroon)),
            const SizedBox(height: 8),
            Text(kChannelStillCheckingText, textAlign: TextAlign.center, style: t(16, color: C.deep, w: FontWeight.w700, h: 1.35)),
            const SizedBox(height: 20),
            ChannelBigButton(label: 'CHECK AGAIN', onTap: onAgain),
          ],
        ),
      ),
    );
  }
}

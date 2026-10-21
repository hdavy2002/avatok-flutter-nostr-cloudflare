import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../../ui/motion.dart';

import '../../core/brand.dart';
import '../../data/api_exception.dart';
import '../../data/models/channel.dart';
import '../../data/repos/channels_repo.dart';
import '../../data/services.dart';
import '../../data/telemetry.dart';
import '../../data/youtube_sign_in.dart';
import '../../ui/async_view.dart';
import '../theme.dart';
import '../widgets.dart';

// Influencer Channels (HF-WIRE-3, handover section 6). YouTube connects by signing in with Google (HF-REEL-33, HF-WIRE-14: no code);
// Instagram keeps the handle + bio code and says "coming soon" while the provider is not switched on. Facebook says "coming soon".
// Routes: /inf/channels, /inf/channels/add, /inf/channels/add/:platform, /inf/channels/:id/checking.
// `?from=join` keeps the person inside "Join as influencer" (step 2 of 3) instead of the dashboard.

String _fromQuery(String? from) => (from == null || from.isEmpty) ? '' : '?from=$from';

String channelChipLabel(Channel c, int minFollowers) => switch (c.state) {
      ChannelState.checking => 'Checking…',
      ChannelState.approved => 'Approved',
      ChannelState.needsFollowers => 'Needs $minFollowers+ followers',
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

IconData _platformIcon(String platform) => platform == 'instagram' ? Icons.camera_alt_rounded : Icons.smart_display_rounded;

// ---------------------------------------------------------------------------------------------- Card

/// One connected channel: platform, @handle, followers, status chip, last check, and its buttons.
class ChannelCard extends StatelessWidget {
  const ChannelCard({super.key, required this.channel, required this.minFollowers, this.onResync, this.onRemove, this.onFinish});

  final Channel channel;
  final int minFollowers;
  final VoidCallback? onResync;
  final VoidCallback? onRemove;

  /// "Finish checking" for a channel still waiting for its code.
  final VoidCallback? onFinish;

  @override
  Widget build(BuildContext context) {
    final c = channel;
    final (Color bg, Color fg) = switch (c.state) {
      ChannelState.approved => (C.maroon, C.white),
      ChannelState.checking => (C.marigold, C.deep),
      ChannelState.needsFollowers => (C.sand, C.ruby),
      ChannelState.disconnected => (C.cream, C.muted),
    };
    final live = c.state != ChannelState.disconnected;
    return Semantics(
      container: true,
      label: '${c.platformName} ${c.handle}, ${channelChipLabel(c, minFollowers)}',
      child: Container(
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: C.paper, borderRadius: BorderRadius.circular(16), border: Border.all(color: C.sandLine, width: 2)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(_platformIcon(c.platform), color: C.maroon, size: 30),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(c.handle.startsWith('@') ? c.handle : '@${c.handle}', style: t(18, color: C.deep), overflow: TextOverflow.ellipsis),
                      Text('${_count(c.followers)} ${c.followersWord} · ${c.platformName}', style: t(14, color: C.muted, w: FontWeight.w700)),
                    ],
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
                  child: Text(channelChipLabel(c, minFollowers), style: t(14, color: fg)),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(c.needsCode ? 'Waiting for your code' : _ago(c.lastSyncAt), style: t(14, color: C.muted, w: FontWeight.w700)),
            if (live) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  if (c.needsCode && onFinish != null)
                    Expanded(child: ChunkyButton(label: 'FINISH CHECKING', height: 48, onTap: onFinish))
                  else if (onResync != null)
                    Expanded(child: ChunkyButton(label: 'RESYNC', height: 48, filled: false, onTap: onResync)),
                  if (onRemove != null) ...[
                    const SizedBox(width: 10),
                    Expanded(child: ChunkyButton(label: 'REMOVE', height: 48, filled: false, onTap: onRemove)),
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
  const ChannelsListScreen({super.key, this.repo});

  final ChannelsRepo? repo;

  @override
  State<ChannelsListScreen> createState() => _ChannelsListScreenState();
}

class _ChannelsListScreenState extends State<ChannelsListScreen> {
  late final ChannelsRepo _repo = widget.repo ?? Services.instance.channelsRepo;
  int _key = 0;

  @override
  void initState() {
    super.initState();
    Telemetry.event('hf_channels_open');
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
      title: 'Remove this channel?',
      body: 'Fans will no longer see reels from ${c.handle}.',
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
    final addButton = TicketButton(label: '+ ADD A CHANNEL', maroon: true, onTap: _add);
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const PageHeader(title: 'Channels'),
            Expanded(
              child: AsyncLoader<ChannelsList>(
                load: _repo.list,
                reloadKey: _key,
                isEmpty: (v) => v.active.isEmpty,
                loadingLabel: 'Loading your channels…',
                emptyTitle: 'No channels yet',
                emptyMessage: 'Add your Instagram or YouTube so fans can see your reels.',
                emptyAction: SizedBox(width: 280, child: addButton),
                builder: (context, v) => ListView(
                  padding: const EdgeInsets.fromLTRB(22, 8, 22, 24),
                  children: [
                    Text(
                      v.qualified
                          ? 'You are approved. Keep at least one channel with ${v.minFollowers}+ followers or subscribers.'
                          : 'We need at least ${v.minFollowers} followers or subscribers on one YouTube or Instagram channel.',
                      style: t(15, color: C.muted, w: FontWeight.w700, h: 1.4),
                    ),
                    const SizedBox(height: 14),
                    for (final c in v.active)
                      ChannelCard(
                        channel: c,
                        minFollowers: v.minFollowers,
                        onResync: () => unawaited(_resync(c)),
                        onRemove: () => unawaited(_remove(c)),
                        onFinish: () => unawaited(context.push('/inf/channels/${c.id}/checking').then((_) => _reload())),
                      ),
                    const SizedBox(height: 8),
                    addButton,
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

/// `/inf/channels/add`: Instagram, YouTube, and Facebook marked "coming soon".
class ChannelPlatformScreen extends StatelessWidget {
  const ChannelPlatformScreen({super.key, this.from});

  final String? from;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const PageHeader(title: 'Add a channel'),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(22, 8, 22, 24),
                children: [
                  Text('Where are your reels?', style: t(26, color: C.maroon)),
                  const SizedBox(height: 6),
                  Text('Pick one. You can add more later.', style: t(16, color: C.muted, w: FontWeight.w700)),
                  const SizedBox(height: 16),
                  _tile(context, icon: Icons.camera_alt_rounded, name: 'Instagram', sub: 'Your reels and public videos', platform: 'instagram'),
                  _tile(context, icon: Icons.smart_display_rounded, name: 'YouTube', sub: 'Sign in with YouTube. Your public videos', platform: 'youtube'),
                  _tile(context, icon: Icons.facebook_rounded, name: 'Facebook', sub: 'Coming soon', platform: null),
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
          color: on ? C.paper : C.cream,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: BorderSide(color: on ? C.maroon : C.sandLine, width: 3)),
          child: InkWell(
            borderRadius: BorderRadius.circular(16),
            onTap: on ? () => context.push('/inf/channels/add/$platform${_fromQuery(from)}') : null,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
              child: Row(
                children: [
                  Icon(icon, color: on ? C.maroon : C.muted, size: 34),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(name, style: t(22, color: on ? C.deep : C.muted)),
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
  const ChannelConsentScreen({super.key, required this.platform, this.from, this.repo, this.signIn});

  final String platform;
  final String? from;
  final ChannelsRepo? repo;

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

  static const _labels = [
    'Show my public videos from this channel as embeds in the Reels feed and on my profile.',
    'Show my follower, like, comment and video counts.',
    'I choose which of my videos go on the feed, and I can remove any video.',
    'This channel is mine.',
  ];

  bool get _supported => widget.platform == 'instagram' || widget.platform == 'youtube';
  bool get _ig => widget.platform == 'instagram';
  String get _name => _ig ? 'Instagram' : 'YouTube';

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
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            PageHeader(title: _supported ? 'Connect $_name' : 'Add a channel'),
            Expanded(
              child: !_supported
                  ? Center(child: Padding(padding: const EdgeInsets.all(28), child: Text('That channel type is coming soon. Please use Instagram or YouTube for now.', textAlign: TextAlign.center, style: t(18, color: C.deep, h: 1.35))))
                  : !_ig
                      ? _youtubeForm()
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
        padding: const EdgeInsets.fromLTRB(22, 8, 22, 24),
        children: [
          Text('Sign in with YouTube', style: t(26, color: C.maroon)),
          const SizedBox(height: 8),
          Text(
            'Sign in with the Google account of your YouTube channel. That is how we know the channel is yours. We only read your channel and public videos: we never post, change or download anything.',
            style: t(16, w: FontWeight.w700, h: 1.4),
          ),
          const SizedBox(height: 8),
          Text('All your public videos are shown by default. You can hide any video later.', style: t(15, color: C.muted, w: FontWeight.w700, h: 1.4)),
          const SizedBox(height: 16),
          Semantics(
            checked: _ytTick,
            label: _ytLabel,
            child: InkWell(
              key: const ValueKey('yt-consent'),
              onTap: _busy ? null : () => setState(() => _ytTick = !_ytTick),
              child: Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: _ytTick ? C.butter : C.paper, borderRadius: BorderRadius.circular(14), border: Border.all(color: _ytTick ? C.marigold : C.sand, width: 2)),
                child: Row(
                  children: [
                    Icon(_ytTick ? Icons.check_box_rounded : Icons.check_box_outline_blank_rounded, color: C.maroon, size: 28),
                    const SizedBox(width: 10),
                    Expanded(child: Text(_ytLabel, style: t(15, h: 1.35))),
                  ],
                ),
              ),
            ),
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: t(15, color: C.ruby, h: 1.35)),
          ],
          const SizedBox(height: 14),
          TicketButton(label: _busy ? 'CHECKING…' : 'SIGN IN WITH YOUTUBE', maroon: true, enabled: !_busy, stubIcon: Icons.arrow_forward_rounded, onTap: () => unawaited(_connectYoutube())),
        ],
      );

  Widget _form() => ListView(
        padding: const EdgeInsets.fromLTRB(22, 8, 22, 24),
        children: [
          Text(_ig ? 'Your Instagram @username' : 'Your YouTube @handle or channel link', style: t(16)),
          const SizedBox(height: 8),
          TextField(
            controller: _handle,
            keyboardType: _ig ? TextInputType.text : TextInputType.url,
            autocorrect: false,
            enabled: !_busy,
            style: t(17, w: FontWeight.w700),
            decoration: InputDecoration(hintText: _ig ? '@yourname' : '@yourchannel'),
          ),
          const SizedBox(height: 16),
          for (var i = 0; i < _labels.length; i++) _check(i),
          if (_error != null) ...[
            const SizedBox(height: 4),
            Text(_error!, style: t(15, color: C.ruby, h: 1.35)),
          ],
          const SizedBox(height: 14),
          TicketButton(label: _busy ? 'CHECKING…' : 'CONNECT', maroon: true, enabled: !_busy, stubIcon: Icons.arrow_forward_rounded, onTap: () => unawaited(_connect())),
        ],
      );

  Widget _check(int i) {
    final v = _ticks[i];
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Semantics(
        checked: v,
        label: _labels[i],
        child: InkWell(
          onTap: _busy ? null : () => setState(() => _ticks[i] = !v),
          child: HfAnimatedContainer(
            duration: HfMotion.duration(context, HfMotion.quick),
            curve: HfMotion.curve,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: v ? C.butter : C.paper, borderRadius: BorderRadius.circular(14), border: Border.all(color: v ? C.marigold : C.sand, width: 2)),
            child: Row(
              children: [
                Icon(v ? Icons.check_box_rounded : Icons.check_box_outline_blank_rounded, color: C.maroon, size: 28),
                const SizedBox(width: 10),
                Expanded(child: Text(_labels[i], style: t(15, h: 1.35))),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _codeStep(AddedChannel a) {
    final where = _ig ? 'Instagram bio' : 'YouTube channel description';
    return ListView(
      padding: const EdgeInsets.fromLTRB(22, 8, 22, 24),
      children: [
        Text('One last step', style: t(28, color: C.maroon)),
        const SizedBox(height: 8),
        Text('We found ${a.channel.handle.startsWith('@') ? a.channel.handle : '@${a.channel.handle}'}. To show it is yours, add this code to your $where.', style: t(16, w: FontWeight.w700, h: 1.4)),
        const SizedBox(height: 16),
        CodeBox(code: a.verifyCode),
        const SizedBox(height: 12),
        Text(a.instructions.isEmpty ? 'Save it, then tap the button below. You can remove the code after we confirm.' : a.instructions, style: t(15, color: C.muted, w: FontWeight.w700, h: 1.4)),
        const SizedBox(height: 20),
        TicketButton(
          label: "I'VE ADDED IT, CHECK NOW",
          maroon: true,
          labelSize: 17,
          onTap: () => context.pushReplacement('/inf/channels/${a.channel.id}/checking${_fromQuery(widget.from)}'),
        ),
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
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(color: C.butter, borderRadius: BorderRadius.circular(16), border: Border.all(color: C.marigold, width: 3)),
      child: Row(
        children: [
          Expanded(child: SelectableText(code, style: t(32, color: C.deep, ls: 0.08))),
          Semantics(
            button: true,
            label: 'Copy the code',
            child: IconButton(
              iconSize: 30,
              color: C.maroon,
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
      next = AsyncData<ChannelCheck>(await _repo.check(widget.id));
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
    context.go(_join ? '/influencer/join?step=2' : '/inf/home');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const PageHeader(title: 'Checking your channel'),
            Expanded(
              child: AsyncView<ChannelCheck>(
                state: _state,
                onRetry: () => unawaited(_go()),
                loadingLabel: 'Checking your channel… This takes a minute.',
                builder: _result,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _result(BuildContext context, ChannelCheck r) {
    final ch = r.channel;
    switch (r.result) {
      case CheckResult.approved:
        return _panel(
          art: const ArtMoment('influencer/online-mode.webp', label: 'Approved', size: 190),
          title: "You're in!",
          message: r.message.isEmpty ? 'Your channel is confirmed.' : r.message,
          buttons: [TicketButton(label: _join ? 'NEXT: YOUR WHATSAPP' : 'GO TO MY DASHBOARD', maroon: true, labelSize: 18, onTap: () => unawaited(_approvedDone()))],
        );
      case CheckResult.needsFollowers:
        return _panel(
          art: const ArtMoment('influencer/offline-mode.webp', label: 'Not yet', size: 190),
          title: 'Not yet',
          message: 'We need at least ${r.minFollowers} followers or subscribers on YouTube or Instagram. ${ch.handle.isEmpty ? '' : '${ch.handle} has ${_count(ch.followers)}.'}'.trim(),
          buttons: [
            TicketButton(label: 'TRY ANOTHER CHANNEL', maroon: true, labelSize: 18, onTap: () => context.go('/inf/channels/add${_fromQuery(widget.from)}')),
            ChunkyButton(label: 'CHECK AGAIN LATER', filled: false, onTap: _leave),
          ],
        );
      case CheckResult.codeMissing:
        return _panel(
          title: 'We could not see the code yet',
          message: r.message.isEmpty ? 'It can take a minute to show. Check it is saved, then try again.' : r.message,
          extra: ch.verifyCode == null ? null : CodeBox(code: ch.verifyCode!),
          buttons: [
            TicketButton(label: 'CHECK AGAIN', maroon: true, labelSize: 18, onTap: () => unawaited(_go())),
            ChunkyButton(label: 'DO IT LATER', filled: false, onTap: _leave),
          ],
        );
      case CheckResult.notFound:
      case CheckResult.private:
      case CheckResult.hiddenCount:
      case CheckResult.unknown:
        return _panel(
          title: 'We could not finish',
          message: r.message.isEmpty ? ApiException.genericText : r.message,
          buttons: [
            TicketButton(label: 'CHECK AGAIN', maroon: true, labelSize: 18, onTap: () => unawaited(_go())),
            ChunkyButton(label: 'BACK', filled: false, onTap: _leave),
          ],
        );
    }
  }

  Widget _panel({Widget? art, required String title, required String message, Widget? extra, required List<Widget> buttons}) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(22, 16, 22, 24),
      children: [
        if (art != null) Center(child: art),
        const SizedBox(height: 8),
        HfReveal(trigger: title, child: Text(title, textAlign: TextAlign.center, style: t(28, color: C.maroon))),
        const SizedBox(height: 10),
        Text(message, textAlign: TextAlign.center, style: t(16, w: FontWeight.w700, h: 1.4)),
        if (extra != null) ...[const SizedBox(height: 16), extra],
        const SizedBox(height: 22),
        for (final b in buttons) Padding(padding: const EdgeInsets.only(bottom: 12), child: b),
      ],
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
          Text('Please sign in first so we can save your channels.', style: t(16, w: FontWeight.w700, h: 1.4)),
          const SizedBox(height: 14),
          ChunkyButton(label: 'SIGN IN', onTap: () => unawaited(requireAccount(context, () => setState(() => _key++)))),
        ],
      );
    }
    final add = TicketButton(label: '+ ADD A CHANNEL', maroon: true, onTap: () => unawaited(_add()));
    return AsyncLoader<ChannelsList>(
      load: _load,
      reloadKey: _key,
      isEmpty: (v) => v.active.isEmpty,
      loadingLabel: 'Loading your channels…',
      emptyTitle: 'No channels yet',
      emptyMessage: 'Add your Instagram or YouTube so fans can see your reels.',
      emptyAction: SizedBox(width: 280, child: add),
      builder: (context, v) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('We need at least ${v.minFollowers} followers or subscribers on one YouTube or Instagram channel.', style: t(15, color: C.muted, w: FontWeight.w700, h: 1.4)),
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

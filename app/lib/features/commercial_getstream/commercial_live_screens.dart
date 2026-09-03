// Phase 2E — commercial live product flow.
//
// This file is deliberately independent from the legacy AvaLive/Cloudflare
// player and Messenger calls. A creator moves through readiness → backstage →
// broadcast; a ticket holder moves through waiting → active → ended.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:stream_video_flutter/stream_video_flutter.dart';
import 'package:stream_chat_flutter/stream_chat_flutter.dart';

import '../../core/analytics.dart';
import '../../core/listings_api.dart';
import '../../core/remote_config.dart';
import '../../core/session_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import 'commercial_getstream_handoff.dart';
import 'commercial_getstream_screens.dart';
import 'commercial_live_gateway.dart';

class LiveReadinessScreen extends StatefulWidget {
  const LiveReadinessScreen({
    super.key,
    required this.listingId,
    required this.title,
    this.gateway = const AuthenticatedCommercialLiveGateway(),
    this.connector = const ServerAuthorizedCommercialGetStreamConnector(),
    this.flags,
  });

  final String listingId;
  final String title;
  final CommercialLiveGateway gateway;
  final CommercialGetStreamConnector connector;
  final CommercialGetStreamJoinFlags? flags;

  @override
  State<LiveReadinessScreen> createState() => _LiveReadinessScreenState();
}

class _LiveReadinessScreenState extends State<LiveReadinessScreen> {
  PermissionStatus? _camera;
  PermissionStatus? _microphone;
  NetProbe? _network;
  bool _checking = true;
  bool _opening = false;
  String? _error;

  bool get _enabled =>
      (widget.flags ?? CommercialGetStreamJoinFlags.fromRemoteConfig())
          .liveJoinEnabled;

  bool get _ready =>
      _enabled &&
      _camera?.isGranted == true &&
      _microphone?.isGranted == true &&
      _network != null &&
      _network!.verdict != 'red';

  @override
  void initState() {
    super.initState();
    _check();
  }

  Future<void> _check() async {
    if (!_enabled) {
      if (mounted) setState(() => _checking = false);
      return;
    }
    setState(() {
      _checking = true;
      _error = null;
    });
    try {
      final permissions =
          await [Permission.camera, Permission.microphone].request();
      final network = await SessionApi.probe();
      if (mounted) {
        setState(() {
          _camera = permissions[Permission.camera];
          _microphone = permissions[Permission.microphone];
          _network = network;
          _checking = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _checking = false;
          _error =
              'Could not finish the device check. Try again on a stable connection.';
        });
      }
    }
  }

  Future<void> _openBackstage() async {
    if (!_ready || _opening) return;
    setState(() {
      _opening = true;
      _error = null;
    });
    try {
      final grant = await widget.gateway.prepareHost(widget.listingId);
      final session = await widget.connector.connect(grant.handoff);
      if (!mounted) {
        await session.leave();
        return;
      }
      await Navigator.of(context).pushReplacement(MaterialPageRoute<void>(
        builder: (_) => LiveBackstageScreen(
          listingId: widget.listingId,
          title: widget.title,
          gateway: widget.gateway,
          handoff: grant.handoff,
          session: session,
          capabilities: const CommercialLiveCapabilities(),
        ),
      ));
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: AD.bg,
        appBar: AppBar(
          backgroundColor: AD.headerFooter,
          foregroundColor: AD.onBand(AD.headerFooter),
          title: const Text('Live readiness'),
        ),
        body: ListView(
          padding: const EdgeInsets.all(Msg.s5),
          children: [
            Text(widget.title, style: ADText.appTitle()),
            const SizedBox(height: Msg.s2),
            Text(
              'Check your setup before opening the private GetStream backstage room.',
              style: ADText.preview(c: AD.textSecondary),
            ),
            const SizedBox(height: Msg.s5),
            _ReadinessRow(
              icon: PhosphorIcons.videoCamera(PhosphorIconsStyle.bold),
              label: 'Camera',
              detail:
                  _camera?.isGranted == true ? 'Ready' : 'Permission required',
              good: _camera?.isGranted == true,
            ),
            _ReadinessRow(
              icon: PhosphorIcons.microphone(PhosphorIconsStyle.bold),
              label: 'Microphone',
              detail: _microphone?.isGranted == true
                  ? 'Ready'
                  : 'Permission required',
              good: _microphone?.isGranted == true,
            ),
            _ReadinessRow(
              icon: PhosphorIcons.wifiHigh(PhosphorIconsStyle.bold),
              label: 'Connection',
              detail: _network == null
                  ? 'Checking…'
                  : '${_network!.tip} · ${_network!.rttMs} ms',
              good: _network?.verdict == 'green',
              warning: _network?.verdict == 'yellow',
            ),
            const SizedBox(height: Msg.s4),
            if (!_enabled)
              _ReadinessNotice(
                icon: PhosphorIcons.prohibit(PhosphorIconsStyle.bold),
                text: 'Commercial live joining is not enabled yet.',
              )
            else if (_checking)
              const Center(child: CircularProgressIndicator())
            else if (!_ready)
              _ReadinessNotice(
                icon: PhosphorIcons.warning(PhosphorIconsStyle.bold),
                text: 'Complete the checks above before opening backstage.',
              ),
            if (_error != null) ...[
              const SizedBox(height: Msg.s3),
              Text(_error!, style: ADText.preview(c: AD.danger)),
            ],
            const SizedBox(height: Msg.s4),
            FilledButton.icon(
              onPressed: _ready && !_opening ? _openBackstage : null,
              icon: _opening
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Icon(PhosphorIcons.broadcast(PhosphorIconsStyle.bold)),
              label: Text(_opening ? 'Opening backstage…' : 'Open backstage'),
            ),
            TextButton.icon(
              onPressed: _checking ? null : _check,
              icon: Icon(
                  PhosphorIcons.arrowClockwise(PhosphorIconsStyle.regular)),
              label: const Text('Run checks again'),
            ),
          ],
        ),
      );
}

class LiveBackstageScreen extends StatefulWidget {
  const LiveBackstageScreen({
    super.key,
    required this.listingId,
    required this.title,
    required this.gateway,
    required this.handoff,
    required this.session,
    this.capabilities = const CommercialLiveCapabilities(),
  });

  final String listingId;
  final String title;
  final CommercialLiveGateway gateway;
  final CommercialGetStreamJoinHandoff handoff;
  final CommercialGetStreamSession session;
  final CommercialLiveCapabilities capabilities;

  @override
  State<LiveBackstageScreen> createState() => _LiveBackstageScreenState();
}

class _LiveBackstageScreenState extends State<LiveBackstageScreen> {
  bool _starting = false;
  String? _error;

  Future<void> _start() async {
    if (_starting) return;
    final confirm = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: AD.card,
        title: const Text('Start the live event?'),
        content: const Text(
          'You are not live yet. Confirm only when your camera, microphone and presentation are ready. Ticket holders will be able to join after the server confirms the broadcast.',
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Not yet')),
          FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('Start live')),
        ],
      ),
    );
    if (confirm != true) return;
    setState(() {
      _starting = true;
      _error = null;
    });
    try {
      await widget.gateway.start(widget.listingId);
      if (!mounted) return;
      await Navigator.of(context).pushReplacement(MaterialPageRoute<void>(
        builder: (_) => LiveBroadcastScreen(
          listingId: widget.listingId,
          title: widget.title,
          gateway: widget.gateway,
          handoff: widget.handoff,
          session: widget.session,
          capabilities: widget.capabilities,
        ),
      ));
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: AD.bg,
        appBar: AppBar(
          backgroundColor: AD.headerFooter,
          foregroundColor: AD.onBand(AD.headerFooter),
          title: const Text('Backstage'),
        ),
        body: Padding(
          padding: const EdgeInsets.all(Msg.s5),
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const _LiveStatusBadge(label: 'NOT LIVE', color: AD.danger),
            const SizedBox(height: Msg.s4),
            Text(widget.title, style: ADText.appTitle()),
            const SizedBox(height: Msg.s2),
            const Text(
              'This is private backstage. Ticket holders cannot watch until you confirm Start live.',
            ),
            const SizedBox(height: Msg.s5),
            Expanded(
              child: Container(
                decoration: BoxDecoration(
                  color: Colors.black,
                  borderRadius: BorderRadius.circular(Msg.rLg),
                ),
                child: Center(
                  child: Builder(builder: (_) {
                    final local =
                        widget.session.call.state.value.localParticipant;
                    if (local == null) {
                      return Text(
                        'Camera is initializing\nBackstage only',
                        textAlign: TextAlign.center,
                        style: ADText.preview(c: Colors.white),
                      );
                    }
                    return StreamVideoRenderer(
                      call: widget.session.call,
                      participant: local,
                      videoTrackType: SfuTrackType.video,
                    );
                  }),
                ),
              ),
            ),
            const SizedBox(height: Msg.s4),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: Msg.s3),
                child: Text(_error!, style: ADText.preview(c: AD.danger)),
              ),
            FilledButton.icon(
              onPressed: _starting ? null : _start,
              icon: _starting
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Icon(PhosphorIcons.broadcast(PhosphorIconsStyle.bold)),
              label: Text(_starting ? 'Starting…' : 'Start live'),
            ),
          ]),
        ),
      );
}

class LiveBroadcastScreen extends StatefulWidget {
  const LiveBroadcastScreen({
    super.key,
    required this.listingId,
    required this.title,
    required this.gateway,
    required this.handoff,
    required this.session,
    this.capabilities = const CommercialLiveCapabilities(),
  });

  final String listingId;
  final String title;
  final CommercialLiveGateway gateway;
  final CommercialGetStreamJoinHandoff handoff;
  final CommercialGetStreamSession session;
  final CommercialLiveCapabilities capabilities;

  @override
  State<LiveBroadcastScreen> createState() => _LiveBroadcastScreenState();
}

class _LiveBroadcastScreenState extends State<LiveBroadcastScreen> {
  Timer? _poll;
  StreamSubscription<CallState>? _callState;
  LiveServerState _serverState = LiveServerState.starting;
  bool _muted = false;
  bool _cameraOff = false;
  bool _leaving = false;
  String? _error;

  Call get _call => widget.session.call;

  @override
  void initState() {
    super.initState();
    _callState = _call.state.valueStream.listen((_) {
      if (mounted) setState(() {});
    });
    _poll = Timer.periodic(const Duration(seconds: 3), (_) => _refreshState());
    _refreshState();
  }

  Future<void> _refreshState() async {
    try {
      final state = await widget.gateway.state(widget.listingId);
      if (!mounted) return;
      setState(() => _serverState = state.state);
      if (state.state == LiveServerState.ended) await _finish();
    } catch (e) {
      if (mounted)
        setState(() => _error = 'Live status is temporarily unavailable.');
    }
  }

  Future<void> _finish() async {
    if (_leaving) return;
    _leaving = true;
    _poll?.cancel();
    await widget.session.leave();
    if (!mounted) return;
    await Navigator.of(context).pushReplacement(MaterialPageRoute<void>(
      builder: (_) => LiveSummaryScreen(
        title: widget.title,
        sessionId: widget.handoff.sessionId,
        gateway: widget.gateway,
        creator: true,
      ),
    ));
  }

  Future<void> _end() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: AD.card,
        title: const Text('End the live event?'),
        content: const Text(
            'Ticket holders will no longer be able to join the live room.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Keep live')),
          FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('End event')),
        ],
      ),
    );
    if (confirm != true) return;
    try {
      setState(() => _serverState = LiveServerState.ending);
      await widget.gateway.end(widget.listingId);
      await _refreshState();
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Future<void> _toggleMute() async {
    final result = await _call.setMicrophoneEnabled(enabled: _muted);
    if (mounted && result.isSuccess) setState(() => _muted = !_muted);
  }

  Future<void> _toggleCamera() async {
    final result = await _call.setCameraEnabled(enabled: _cameraOff);
    if (mounted && result.isSuccess) setState(() => _cameraOff = !_cameraOff);
  }

  Future<void> _report() async {
    final ok =
        await ListingsApi.report('listing', widget.listingId, 'live_event');
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(ok ? 'Report submitted.' : 'Could not submit report.'),
      ));
    }
  }

  @override
  void dispose() {
    _poll?.cancel();
    _callState?.cancel();
    if (!_leaving) unawaited(widget.session.leave());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final others = _call.state.value.otherParticipants.toList();
    final chatClient = widget.session.chatClient;
    final chatChannel = widget.session.chatChannel;
    final hasChat = chatClient != null && chatChannel != null;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) unawaited(_end());
      },
      child: Scaffold(
        backgroundColor: AD.bg,
        appBar: AppBar(
          backgroundColor: AD.headerFooter,
          foregroundColor: AD.onBand(AD.headerFooter),
          title: Text(widget.title),
          actions: [
            IconButton(
              tooltip: 'Report a problem',
              onPressed: _report,
              icon: Icon(PhosphorIcons.flag(PhosphorIconsStyle.bold)),
            ),
          ],
        ),
        body: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s3, Msg.s4, 0),
            child: Row(children: [
              _LiveStatusBadge(label: _healthLabel, color: _healthColor),
              const Spacer(),
              Text('Audience count unavailable', style: ADText.sectionLabel()),
            ]),
          ),
          Expanded(
            child: Row(
              children: [
                Expanded(
                  flex: hasChat ? 3 : 4,
                  child: others.isEmpty
                      ? Center(
                          child: Text(
                              'Your camera is ready. Audience media will appear here when available.',
                              textAlign: TextAlign.center,
                              style: ADText.preview()))
                      : GridView.builder(
                          padding: const EdgeInsets.all(Msg.s3),
                          gridDelegate:
                              const SliverGridDelegateWithFixedCrossAxisCount(
                            crossAxisCount: 2,
                            crossAxisSpacing: Msg.s3,
                            mainAxisSpacing: Msg.s3,
                            childAspectRatio: .8,
                          ),
                          itemCount: others.length,
                          itemBuilder: (_, index) {
                            final p = others[index];
                            return ClipRRect(
                              borderRadius: BorderRadius.circular(Msg.rLg),
                              child: Container(
                                color: AD.card,
                                child: p.publishedTracks
                                        .containsKey(SfuTrackType.video)
                                    ? StreamVideoRenderer(
                                        call: _call,
                                        participant: p,
                                        videoTrackType: SfuTrackType.video)
                                    : Center(
                                        child: Icon(
                                            PhosphorIcons.userCircle(
                                                PhosphorIconsStyle.regular),
                                            size: 48,
                                            color: AD.textTertiary)),
                              ),
                            );
                          },
                        ),
                ),
                if (hasChat)
                  Expanded(
                    flex: 2,
                    child: Padding(
                      padding:
                          const EdgeInsets.fromLTRB(Msg.s4, 0, Msg.s4, Msg.s4),
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(Msg.rLg),
                        child: StreamChat(
                          client: chatClient!,
                          child: StreamChannel(
                            channel: chatChannel!,
                            child: const Column(
                              children: [
                                Padding(
                                  padding: EdgeInsets.all(Msg.s3),
                                  child: Align(
                                    alignment: Alignment.centerLeft,
                                    child: Text('Live chat'),
                                  ),
                                ),
                                Expanded(child: StreamMessageListView()),
                                StreamMessageInput(),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          if (widget.capabilities.captions)
            const Text('Captions available', style: TextStyle(fontSize: 12)),
          if (widget.capabilities.qualityControls)
            const Text('Quality controls available',
                style: TextStyle(fontSize: 12)),
          if (_error != null)
            Text(_error!, style: ADText.preview(c: AD.danger)),
          CommercialGetStreamRoomControls(
            canPublish: true,
            muted: _muted,
            cameraOff: _cameraOff,
            onToggleMute: _toggleMute,
            onToggleCamera: _toggleCamera,
            onLeave: _end,
          ),
        ]),
      ),
    );
  }

  String get _healthLabel => switch (_serverState) {
        LiveServerState.live => 'Live and connected',
        LiveServerState.ending => 'Ending live event',
        LiveServerState.ended => 'Ended',
        _ => 'Starting broadcast',
      };

  Color get _healthColor =>
      _serverState == LiveServerState.live ? AD.online : AD.primaryBadge;
}

class LiveViewerScreen extends StatefulWidget {
  const LiveViewerScreen({
    super.key,
    required this.listingId,
    required this.title,
    this.gateway = const AuthenticatedCommercialLiveGateway(),
    this.connector = const ServerAuthorizedCommercialGetStreamConnector(),
    this.flags,
    this.capabilities = const CommercialLiveCapabilities(),
  });

  final String listingId;
  final String title;
  final CommercialLiveGateway gateway;
  final CommercialGetStreamConnector connector;
  final CommercialGetStreamJoinFlags? flags;
  final CommercialLiveCapabilities capabilities;

  @override
  State<LiveViewerScreen> createState() => _LiveViewerScreenState();
}

class _LiveViewerScreenState extends State<LiveViewerScreen> {
  CommercialGetStreamSession? _session;
  Timer? _poll;
  LiveServerState _serverState = LiveServerState.scheduled;
  bool _loading = true;
  bool _leaving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _join();
    _poll = Timer.periodic(const Duration(seconds: 3), (_) => _refreshState());
  }

  Future<void> _join() async {
    final enabled =
        (widget.flags ?? CommercialGetStreamJoinFlags.fromRemoteConfig())
            .liveJoinEnabled;
    if (!enabled) {
      setState(() {
        _loading = false;
        _error = 'Commercial live joining is not enabled yet.';
      });
      return;
    }
    try {
      final grant = await widget.gateway.joinViewer(widget.listingId);
      final session = await widget.connector.connect(grant.handoff);
      if (!mounted) {
        await session.leave();
        return;
      }
      setState(() {
        _session = session;
        _serverState = grant.state.state;
        _loading = false;
      });
      Analytics.capture(
          'commercial_live_viewer_joined', {'listing_id': widget.listingId});
    } catch (e) {
      if (mounted)
        setState(() {
          _loading = false;
          _error = e.toString();
        });
    }
  }

  Future<void> _refreshState() async {
    if (_session == null || _leaving) return;
    try {
      final state = await widget.gateway.state(widget.listingId);
      if (!mounted) return;
      setState(() => _serverState = state.state);
      if (state.state == LiveServerState.ended) await _leave();
    } catch (_) {
      // Keep the last honest server state; do not turn a polling failure into
      // a fabricated viewer count or active-state claim.
    }
  }

  Future<void> _leave() async {
    if (_leaving) return;
    _leaving = true;
    _poll?.cancel();
    await _session?.leave();
    if (mounted) setState(() {});
  }

  Future<void> _report() async {
    final ok =
        await ListingsApi.report('listing', widget.listingId, 'live_event');
    if (mounted)
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content:
              Text(ok ? 'Report submitted.' : 'Could not submit report.')));
  }

  @override
  void dispose() {
    _poll?.cancel();
    final session = _session;
    if (!_leaving && session != null) unawaited(session.leave());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading)
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    if (_error != null) return _stateScaffold('Unable to join', _error!);
    if (_leaving || _serverState == LiveServerState.ended) {
      return _stateScaffold(
          'Live event ended', 'This ticket no longer opens a live room.');
    }
    final active = _serverState == LiveServerState.live;
    final session = _session;
    final others = session?.call.state.value.otherParticipants.toList() ??
        const <CallParticipantState>[];
    final chatClient = session?.chatClient;
    final chatChannel = session?.chatChannel;
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: AppBar(
        backgroundColor: AD.headerFooter,
        foregroundColor: AD.onBand(AD.headerFooter),
        title: Text(widget.title),
        actions: [
          IconButton(
            tooltip: 'Report a problem',
            onPressed: _report,
            icon: Icon(PhosphorIcons.flag(PhosphorIconsStyle.bold)),
          ),
        ],
      ),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.all(Msg.s4),
          child: _LiveStatusBadge(
            label: active ? 'LIVE' : 'WAITING FOR CREATOR',
            color: active ? AD.danger : AD.primaryBadge,
          ),
        ),
        Expanded(
          child: Row(
            children: [
              Expanded(
                flex: chatClient != null && chatChannel != null ? 3 : 4,
                child: !active
                    ? Center(
                        child: Text(
                            'The creator has not started yet.\nKeep this screen open to join when the event begins.',
                            textAlign: TextAlign.center,
                            style: ADText.preview()))
                    : others.isEmpty
                        ? Center(
                            child: Text(
                                'Live is on. Waiting for the creator’s camera…',
                                style: ADText.preview()))
                        : GridView.builder(
                            padding: const EdgeInsets.all(Msg.s3),
                            gridDelegate:
                                const SliverGridDelegateWithFixedCrossAxisCount(
                                    crossAxisCount: 1, childAspectRatio: 1.35),
                            itemCount: others.length,
                            itemBuilder: (_, index) {
                              final p = others[index];
                              return ClipRRect(
                                borderRadius: BorderRadius.circular(Msg.rLg),
                                child: Container(
                                  color: Colors.black,
                                  child: p.publishedTracks
                                          .containsKey(SfuTrackType.video)
                                      ? StreamVideoRenderer(
                                          call: session!.call,
                                          participant: p,
                                          videoTrackType: SfuTrackType.video)
                                      : Center(
                                          child: Icon(
                                              PhosphorIcons.userCircle(
                                                  PhosphorIconsStyle.regular),
                                              size: 64,
                                              // [DESIGN-GUARD-DEBT-1] Was
                                              // Colors.white54. NOT AD.textTertiary
                                              // despite what the guard's fix hint
                                              // says — that token is ink-on-cream and
                                              // this icon sits on the Colors.black
                                              // tile above, where it would vanish.
                                              color: AD.onMediaFaint)),
                                ),
                              );
                            },
                          ),
              ),
              if (chatClient != null && chatChannel != null)
                Expanded(
                  flex: 2,
                  child: Padding(
                    padding:
                        const EdgeInsets.fromLTRB(Msg.s4, 0, Msg.s4, Msg.s4),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(Msg.rLg),
                      child: StreamChat(
                        client: chatClient!,
                        child: StreamChannel(
                          channel: chatChannel!,
                          child: const Column(
                            children: [
                              Padding(
                                padding: EdgeInsets.all(Msg.s3),
                                child: Align(
                                  alignment: Alignment.centerLeft,
                                  child: Text('Live chat'),
                                ),
                              ),
                              Expanded(child: StreamMessageListView()),
                              StreamMessageInput(),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
        if (widget.capabilities.captions)
          const Text('Captions available', style: TextStyle(fontSize: 12)),
        TextButton.icon(
            onPressed: _leave,
            icon: Icon(PhosphorIcons.x(PhosphorIconsStyle.regular)),
            label: const Text('Leave live event')),
      ]),
    );
  }

  Widget _stateScaffold(String heading, String detail) => Scaffold(
      backgroundColor: AD.bg,
      appBar: AppBar(
        backgroundColor: AD.headerFooter,
        foregroundColor: AD.onBand(AD.headerFooter),
        title: Text(widget.title),
      ),
      body: Center(
          child: Padding(
              padding: const EdgeInsets.all(Msg.s5),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Icon(PhosphorIcons.broadcast(PhosphorIconsStyle.bold),
                    size: 48, color: AD.textTertiary),
                const SizedBox(height: Msg.s3),
                Text(heading,
                    style: ADText.appTitle(), textAlign: TextAlign.center),
                const SizedBox(height: Msg.s2),
                Text(detail,
                    style: ADText.preview(), textAlign: TextAlign.center),
              ]))));
}

class LiveSummaryScreen extends StatefulWidget {
  const LiveSummaryScreen({
    super.key,
    required this.title,
    required this.sessionId,
    required this.gateway,
    required this.creator,
  });

  final String title;
  final String sessionId;
  final CommercialLiveGateway gateway;
  final bool creator;

  @override
  State<LiveSummaryScreen> createState() => _LiveSummaryScreenState();
}

class _LiveSummaryScreenState extends State<LiveSummaryScreen> {
  CommercialReceiptResponse? _receipt;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (!widget.creator) {
      if (mounted) setState(() => _loading = false);
      return;
    }
    final receipt = await widget.gateway.receipt(widget.sessionId);
    if (mounted)
      setState(() {
        _receipt = receipt;
        _loading = false;
      });
  }

  @override
  Widget build(BuildContext context) {
    final rows = _receipt?.receipts ?? const <CommercialReceipt>[];
    final summary = CommercialReceiptSummary.fromReceipts(rows);
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: AppBar(
        backgroundColor: AD.headerFooter,
        foregroundColor: AD.onBand(AD.headerFooter),
        title: const Text('Live summary'),
      ),
      body: ListView(padding: const EdgeInsets.all(Msg.s5), children: [
        Text(widget.title, style: ADText.appTitle()),
        const SizedBox(height: Msg.s2),
        const Text('The live event has ended.'),
        const SizedBox(height: Msg.s5),
        if (_loading)
          const Center(child: CircularProgressIndicator())
        else if (!widget.creator)
          _ReadinessNotice(
              icon: PhosphorIcons.checkCircle(PhosphorIconsStyle.bold),
              text: 'Thanks for watching.')
        else if (summary.settledReceipts.isEmpty)
          _ReadinessNotice(
            icon: PhosphorIcons.receipt(PhosphorIconsStyle.bold),
            text:
                'Settlement is still being finalized. Earnings are not estimated from tickets or viewer counts.',
          )
        else ...[
          const Text('Settled receipts'),
          const SizedBox(height: Msg.s2),
          for (final receipt in summary.settledReceipts)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(PhosphorIcons.receipt(PhosphorIconsStyle.bold),
                  color: AD.online),
              title: Text('${receipt.creatorAmount} ${receipt.currency}'),
              subtitle: Text('Receipt ${receipt.receiptId}'),
            ),
        ],
      ]),
    );
  }
}

class _ReadinessRow extends StatelessWidget {
  const _ReadinessRow(
      {required this.icon,
      required this.label,
      required this.detail,
      required this.good,
      this.warning = false});
  final IconData icon;
  final String label;
  final String detail;
  final bool good;
  final bool warning;

  @override
  Widget build(BuildContext context) => ListTile(
        contentPadding: EdgeInsets.zero,
        leading: Icon(icon,
            color: good
                ? AD.online
                : warning
                    ? AD.primaryBadge
                    : AD.danger),
        title: Text(label),
        subtitle: Text(detail),
        trailing: Icon(
            good
                ? PhosphorIcons.checkCircle(PhosphorIconsStyle.fill)
                : PhosphorIcons.warningCircle(PhosphorIconsStyle.regular),
            color: good ? AD.online : AD.primaryBadge),
      );
}

class _ReadinessNotice extends StatelessWidget {
  const _ReadinessNotice({required this.icon, required this.text});
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) => Card(
        color: AD.card,
        child: Padding(
          padding: const EdgeInsets.all(Msg.s4),
          child: Row(children: [
            Icon(icon, color: AD.primaryBadge),
            const SizedBox(width: Msg.s3),
            Expanded(child: Text(text)),
          ]),
        ),
      );
}

class _LiveStatusBadge extends StatelessWidget {
  const _LiveStatusBadge({required this.label, required this.color});
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
        padding:
            const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s2),
        decoration: BoxDecoration(color: color, borderRadius: Msg.brPill),
        child: Text(label,
            style: TextStyle(
                color: AD.onBand(color), fontWeight: FontWeight.w700)),
      );
}

// Phase 2D — GetStream-only commercial rooms.
//
// These routes are intentionally separate from AvaTalk, AvaLive's old
// viewer, and AvaConsult's Cloudflare/P2P room. They accept a server-minted
// handoff only and stay closed when the matching join switch is off.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:stream_video_flutter/stream_video_flutter.dart';

import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import 'commercial_getstream_handoff.dart';
import 'commercial_live_gateway.dart';
import 'commercial_consult_screens.dart';

typedef CommercialGetStreamRoomBuilder = Widget Function(
  BuildContext context,
  CommercialGetStreamSession session,
  CommercialGetStreamJoinHandoff handoff,
);

class CommercialLiveViewerScreen extends StatelessWidget {
  const CommercialLiveViewerScreen({
    super.key,
    required this.listingId,
    required this.entitlementId,
    required this.title,
    required this.gateway,
    this.flags,
    this.connector = const ServerAuthorizedCommercialGetStreamConnector(),
  });

  final String listingId;
  final String entitlementId;
  final String title;
  final CommercialGetStreamJoinGateway gateway;
  final CommercialGetStreamJoinFlags? flags;
  final CommercialGetStreamConnector connector;

  @override
  Widget build(BuildContext context) => CommercialGetStreamEntryScreen(
        title: title,
        request: CommercialGetStreamJoinRequest(
          listingId: listingId,
          product: CommercialGetStreamProduct.liveEvent,
          entitlementId: entitlementId,
        ),
        expectedProduct: CommercialGetStreamProduct.liveEvent,
        expectedRole: CommercialGetStreamRole.viewer,
        gateway: gateway,
        flags: flags,
        connector: connector,
        roomBuilder: (context, session, handoff) =>
            CommercialGetStreamRoomScreen(
          title: title,
          product: handoff.product,
          role: handoff.role,
          session: session,
        ),
      );
}

class CommercialLiveBackstageScreen extends StatelessWidget {
  const CommercialLiveBackstageScreen({
    super.key,
    required this.listingId,
    required this.title,
    required this.gateway,
    this.flags,
    this.connector = const ServerAuthorizedCommercialGetStreamConnector(),
  });

  final String listingId;
  final String title;
  final CommercialGetStreamJoinGateway gateway;
  final CommercialGetStreamJoinFlags? flags;
  final CommercialGetStreamConnector connector;

  @override
  Widget build(BuildContext context) => CommercialGetStreamEntryScreen(
        title: title,
        request: CommercialGetStreamJoinRequest(
          listingId: listingId,
          product: CommercialGetStreamProduct.liveEvent,
        ),
        expectedProduct: CommercialGetStreamProduct.liveEvent,
        expectedRole: CommercialGetStreamRole.host,
        gateway: gateway,
        flags: flags,
        connector: connector,
        roomBuilder: (context, session, handoff) =>
            CommercialGetStreamRoomScreen(
          title: title,
          product: handoff.product,
          role: handoff.role,
          session: session,
        ),
      );
}

class CommercialConsultationPrejoinScreen extends StatelessWidget {
  const CommercialConsultationPrejoinScreen({
    super.key,
    required this.listingId,
    required this.bookingId,
    required this.title,
    this.gateway = const AuthenticatedCommercialConsultGateway(),
    this.isCreator = false,
    this.flags,
    this.connector = const ServerAuthorizedCommercialGetStreamConnector(),
  });

  final String listingId;
  final String bookingId;
  final String title;
  final CommercialConsultGateway gateway;
  final bool isCreator;
  final CommercialGetStreamJoinFlags? flags;
  final CommercialGetStreamConnector connector;

  @override
  Widget build(BuildContext context) => CommercialConsultationPrejoinFlow(
        listingId: listingId,
        bookingId: bookingId,
        title: title,
        gateway: gateway,
        isCreator: isCreator,
        flags: flags,
        connector: connector,
      );
}

class CommercialGetStreamEntryScreen extends StatefulWidget {
  const CommercialGetStreamEntryScreen({
    super.key,
    required this.title,
    required this.request,
    required this.expectedProduct,
    required this.expectedRole,
    required this.gateway,
    required this.roomBuilder,
    this.flags,
    this.connector = const ServerAuthorizedCommercialGetStreamConnector(),
    this.consultationPrejoin = false,
  });

  final String title;
  final CommercialGetStreamJoinRequest request;
  final CommercialGetStreamProduct expectedProduct;
  final CommercialGetStreamRole expectedRole;
  final CommercialGetStreamJoinGateway gateway;
  final CommercialGetStreamJoinFlags? flags;
  final CommercialGetStreamConnector connector;
  final bool consultationPrejoin;
  final CommercialGetStreamRoomBuilder roomBuilder;

  @override
  State<CommercialGetStreamEntryScreen> createState() =>
      _CommercialGetStreamEntryScreenState();
}

class _CommercialGetStreamEntryScreenState
    extends State<CommercialGetStreamEntryScreen> {
  bool _joining = false;
  String? _error;

  CommercialGetStreamJoinFlags get _flags =>
      widget.flags ?? CommercialGetStreamJoinFlags.fromRemoteConfig();

  Future<void> _join() async {
    if (_joining || !_flags.allows(widget.expectedProduct)) return;
    setState(() {
      _joining = true;
      _error = null;
    });
    try {
      final handoff = await widget.gateway.authorize(widget.request);
      if (handoff.product != widget.expectedProduct ||
          handoff.role != widget.expectedRole) {
        throw const FormatException(
            'Server authorization does not match this route');
      }
      final session = await widget.connector.connect(handoff);
      if (!mounted) {
        await session.leave();
        return;
      }
      await Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (context) => widget.roomBuilder(context, session, handoff),
      ));
    } catch (e) {
      if (mounted) setState(() => _error = _friendlyError(e));
    } finally {
      if (mounted) setState(() => _joining = false);
    }
  }

  String _friendlyError(Object error) {
    if (error is FormatException || error is StateError) {
      return error.toString().replaceFirst('FormatException: ', '');
    }
    return 'This secure room could not be opened. Please try again.';
  }

  @override
  Widget build(BuildContext context) {
    final enabled = _flags.allows(widget.expectedProduct);
    final consultation = widget.consultationPrejoin;
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: AppBar(
        backgroundColor: AD.headerFooter,
        foregroundColor: AD.onBand(AD.headerFooter),
        title: Text(widget.title),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(Msg.s5),
          children: [
            Icon(
              consultation
                  ? PhosphorIcons.videoCamera(PhosphorIconsStyle.bold)
                  : PhosphorIcons.broadcast(PhosphorIconsStyle.bold),
              size: 48,
              color: consultation ? AD.tabCalls : AD.primaryBadge,
            ),
            const SizedBox(height: Msg.s4),
            Text(
              consultation
                  ? 'Private 1:1 consultation'
                  : 'GetStream live event',
              textAlign: TextAlign.center,
              style: ADText.appTitle(c: AD.textPrimary),
            ),
            const SizedBox(height: Msg.s2),
            Text(
              consultation
                  ? 'Your booking unlocks a private room for you and the creator.'
                  : 'Your ticket unlocks this live room. Watching the public page does not grant access.',
              textAlign: TextAlign.center,
              style: ADText.preview(c: AD.textSecondary),
            ),
            const SizedBox(height: Msg.s5),
            _InfoCard(
              icon: PhosphorIcons.lockKey(PhosphorIconsStyle.regular),
              text: consultation
                  ? 'The room uses the account-bound booking returned by the server.'
                  : 'The room uses the account-bound ticket returned by the server.',
            ),
            if (consultation) ...[
              const SizedBox(height: Msg.s3),
              _InfoCard(
                icon: PhosphorIcons.microphone(PhosphorIconsStyle.regular),
                text: 'Check your camera and microphone before joining.',
              ),
            ],
            const SizedBox(height: Msg.s5),
            if (!enabled)
              _InfoCard(
                icon: PhosphorIcons.prohibit(PhosphorIconsStyle.regular),
                text: 'This commercial room is not available yet.',
              )
            else
              FilledButton.icon(
                onPressed: _joining ? null : _join,
                icon: _joining
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Icon(PhosphorIcons.arrowRight(PhosphorIconsStyle.bold)),
                label: Text(_joining
                    ? 'Authorizing securely…'
                    : consultation
                        ? 'Check setup and join'
                        : 'Join live event'),
              ),
            if (_error != null) ...[
              const SizedBox(height: Msg.s3),
              Text(_error!,
                  textAlign: TextAlign.center,
                  style: ADText.preview(c: AD.danger)),
            ],
          ],
        ),
      ),
    );
  }
}

class _InfoCard extends StatelessWidget {
  const _InfoCard({required this.icon, required this.text});
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
            Expanded(
                child: Text(text, style: ADText.preview(c: AD.textPrimary))),
          ]),
        ),
      );
}

class CommercialGetStreamRoomScreen extends StatefulWidget {
  const CommercialGetStreamRoomScreen({
    super.key,
    required this.title,
    required this.product,
    required this.role,
    required this.session,
  });

  final String title;
  final CommercialGetStreamProduct product;
  final CommercialGetStreamRole role;
  final CommercialGetStreamSession session;

  @override
  State<CommercialGetStreamRoomScreen> createState() =>
      _CommercialGetStreamRoomScreenState();
}

class _CommercialGetStreamRoomScreenState
    extends State<CommercialGetStreamRoomScreen> {
  StreamSubscription<CallState>? _stateSub;
  bool _muted = false;
  bool _cameraOff = false;
  bool _leaving = false;

  Call get _call => widget.session.call;
  bool get _live => widget.product == CommercialGetStreamProduct.liveEvent;
  bool get _canPublish => widget.role != CommercialGetStreamRole.viewer;

  @override
  void initState() {
    super.initState();
    _stateSub = _call.state.valueStream.listen((_) {
      if (mounted) setState(() {});
    });
  }

  Future<void> _leave() async {
    if (_leaving) return;
    setState(() => _leaving = true);
    await widget.session.leave();
    if (mounted) Navigator.of(context).pop();
  }

  Future<void> _toggleMute() async {
    if (!_canPublish) return;
    final result = await _call.setMicrophoneEnabled(enabled: _muted);
    if (mounted && result.isSuccess) setState(() => _muted = !_muted);
  }

  Future<void> _toggleCamera() async {
    if (!_canPublish) return;
    final result = await _call.setCameraEnabled(enabled: _cameraOff);
    if (mounted && result.isSuccess) setState(() => _cameraOff = !_cameraOff);
  }

  @override
  void dispose() {
    _stateSub?.cancel();
    // The explicit leave path owns the session lifecycle. If a host pops the
    // route through a parent navigator, still close the server-owned room.
    if (!_leaving) unawaited(widget.session.leave());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final others = _call.state.value.otherParticipants.toList();
    final local = _call.state.value.localParticipant;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) unawaited(_leave());
      },
      child: Scaffold(
        backgroundColor: AD.bg,
        appBar: AppBar(
          backgroundColor: AD.headerFooter,
          foregroundColor: AD.onBand(AD.headerFooter),
          title: Text(_live
              ? (_roleLabel == 'Creator' ? 'Backstage' : 'Live event')
              : widget.title),
          actions: [
            if (_live)
              Padding(
                padding: const EdgeInsets.only(right: Msg.s4),
                child: Center(child: Text('${others.length + 1} here')),
              ),
          ],
        ),
        body: Column(children: [
          Expanded(
            child: others.isEmpty ? _emptyRoom() : _participantGrid(others),
          ),
          if (local != null && !_live)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Msg.s4),
              child: Text(
                _cameraOff ? 'Camera off' : 'Camera on',
                style: ADText.preview(c: AD.textSecondary),
              ),
            ),
          CommercialGetStreamRoomControls(
            canPublish: _canPublish,
            muted: _muted,
            cameraOff: _cameraOff,
            onToggleMute: _toggleMute,
            onToggleCamera: _toggleCamera,
            onLeave: _leave,
          ),
        ]),
      ),
    );
  }

  String get _roleLabel => switch (widget.role) {
        CommercialGetStreamRole.host => 'Creator',
        CommercialGetStreamRole.creator => 'Creator',
        CommercialGetStreamRole.buyer => 'Customer',
        CommercialGetStreamRole.viewer => 'Viewer',
      };

  Widget _emptyRoom() => Center(
        child: Padding(
          padding: const EdgeInsets.all(Msg.s5),
          child: Text(
            _live && widget.role == CommercialGetStreamRole.host
                ? 'Backstage is ready. Your audience will appear here when they join.'
                : 'Waiting for the creator to join…',
            textAlign: TextAlign.center,
            style: ADText.preview(c: AD.textSecondary),
          ),
        ),
      );

  Widget _participantGrid(List<CallParticipantState> others) =>
      GridView.builder(
        padding: const EdgeInsets.all(Msg.s3),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 2,
          crossAxisSpacing: Msg.s3,
          mainAxisSpacing: Msg.s3,
          childAspectRatio: .8,
        ),
        itemCount: others.length,
        itemBuilder: (context, index) {
          final participant = others[index];
          final hasVideo =
              participant.publishedTracks.containsKey(SfuTrackType.video);
          return ClipRRect(
            borderRadius: BorderRadius.circular(Msg.rLg),
            child: Container(
              color: AD.card,
              child: hasVideo
                  ? StreamVideoRenderer(
                      call: _call,
                      participant: participant,
                      videoTrackType: SfuTrackType.video,
                    )
                  : Center(
                      child: Icon(
                          PhosphorIcons.userCircle(PhosphorIconsStyle.regular),
                          size: 54,
                          color: AD.textTertiary),
                    ),
            ),
          );
        },
      );
}

/// Controls are separate from the media renderer so receive-only viewers can
/// be covered by a widget test and cannot accidentally grow publish affordances.
class CommercialGetStreamRoomControls extends StatelessWidget {
  const CommercialGetStreamRoomControls({
    super.key,
    required this.canPublish,
    required this.muted,
    required this.cameraOff,
    required this.onToggleMute,
    required this.onToggleCamera,
    required this.onLeave,
  });

  final bool canPublish;
  final bool muted;
  final bool cameraOff;
  final Future<void> Function() onToggleMute;
  final Future<void> Function() onToggleCamera;
  final Future<void> Function() onLeave;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s3, Msg.s4, Msg.s5),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
          children: [
            if (canPublish)
              _Control(
                icon: muted
                    ? PhosphorIcons.microphoneSlash(PhosphorIconsStyle.bold)
                    : PhosphorIcons.microphone(PhosphorIconsStyle.bold),
                label: muted ? 'Unmute' : 'Mute',
                onTap: onToggleMute,
              ),
            if (canPublish)
              _Control(
                icon: cameraOff
                    ? PhosphorIcons.videoCameraSlash(PhosphorIconsStyle.bold)
                    : PhosphorIcons.videoCamera(PhosphorIconsStyle.bold),
                label: cameraOff ? 'Camera on' : 'Camera off',
                onTap: onToggleCamera,
              ),
            _Control(
              danger: true,
              icon: PhosphorIcons.phoneDisconnect(PhosphorIconsStyle.bold),
              label: 'Leave',
              onTap: onLeave,
            ),
          ],
        ),
      );
}

class _Control extends StatelessWidget {
  const _Control(
      {required this.icon,
      required this.label,
      required this.onTap,
      this.danger = false});
  final IconData icon;
  final String label;
  final Future<void> Function() onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) => Column(children: [
        IconButton.filled(
          onPressed: () => unawaited(onTap()),
          style: IconButton.styleFrom(
            backgroundColor: danger ? AD.danger : AD.card,
            foregroundColor: danger ? AD.onBand(AD.danger) : AD.textPrimary,
          ),
          icon: Icon(icon),
        ),
        Text(label, style: ADText.navLabel(c: AD.textSecondary)),
      ]);
}

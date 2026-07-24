// [CF-CALL-003] Cloudflare Realtime A/V group-call screen — the Cloudflare
// counterpart to `conference_screen.dart` (LiveKit). Reuses the same Zine UI
// conventions (paper chrome, bordered circle controls, lime speaking border,
// grid/paginated-grid tiles) so switching provider is visually seamless; all
// media/session logic lives in `CloudflareConferenceController`.
//
// Reached only when RemoteConfig.cloudflareConferenceEnabled is true AND the
// server ticket's provider is 'cloudflare_realtime' (see the chat_thread.dart
// launch-site branch). The LiveKit ConferenceScreen is untouched and remains
// the path when the flag is off or the ticket says otherwise.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart' as webrtc;
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'cloudflare_conference_controller.dart';

class CloudflareConferenceScreen extends StatefulWidget {
  final String gid;
  final String title;
  final bool video;
  final bool starter;
  const CloudflareConferenceScreen({
    super.key,
    required this.gid,
    required this.title,
    required this.video,
    required this.starter,
  });

  @override
  State<CloudflareConferenceScreen> createState() => _CloudflareConferenceScreenState();
}

class _CloudflareConferenceScreenState extends State<CloudflareConferenceScreen> with WidgetsBindingObserver {
  late final CloudflareConferenceController _ctrl;
  static const _perPage = 8;
  int _page = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _ctrl = CloudflareConferenceController(gid: widget.gid, wantVideo: widget.video, starter: widget.starter);
    _ctrl.addListener(_onChanged);
    unawaited(_ctrl.connect());
  }

  void _onChanged() {
    if (mounted) setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _ctrl.onForegroundResume();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _ctrl.removeListener(_onChanged);
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _leave() async {
    await _ctrl.leave(reason: 'voluntary');
    if (mounted) Navigator.of(context).maybePop();
  }

  @override
  Widget build(BuildContext context) {
    if (_ctrl.state == CfConnState.failed) {
      return Scaffold(
        backgroundColor: Zine.paper,
        body: ZinePaper(
          child: SafeArea(
            child: Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
              ZineEmptyState(icon: PhosphorIcons.warning(PhosphorIconsStyle.bold), text: _ctrl.statusText),
              const SizedBox(height: 16),
              ZineButton(label: 'Close', variant: ZineButtonVariant.ghost, fontSize: 16,
                  onPressed: () => Navigator.pop(context)),
            ])),
          ),
        ),
      );
    }
    if (_ctrl.state == CfConnState.connecting) {
      return const Scaffold(
        backgroundColor: Zine.paper,
        body: Center(child: CircularProgressIndicator(color: Zine.blueInk)),
      );
    }

    final members = _ctrl.roster;
    // Report currently-visible uids to the controller so it can apply the
    // viewport-aware video subscription policy (CF-CALL-004).
    final int pages = members.isEmpty ? 1 : ((members.length + _perPage - 1) ~/ _perPage);
    final int page = _page < 0 ? 0 : (_page >= pages ? pages - 1 : _page);
    final start = page * _perPage;
    final end = (start + _perPage) > members.length ? members.length : start + _perPage;
    final visible = members.sublist(start, end);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _ctrl.setVisibleTiles(visible.map((p) => p.uid).toSet());
    });

    return PopScope(
      canPop: true,
      child: Scaffold(
        backgroundColor: Zine.paper,
        body: ZinePaper(
          child: SafeArea(
            child: Column(children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
                child: Row(children: [
                  ZineBackButton(icon: PhosphorIcons.caretDown(PhosphorIconsStyle.bold), onTap: () => Navigator.pop(context)),
                  const SizedBox(width: 12),
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(widget.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.cardTitle(size: 18)),
                    Text('${members.length + 1} IN CALL · CLOUDFLARE', style: ZineText.kicker(size: 10.5)),
                  ])),
                ]),
              ),
              Expanded(
                child: pages == 1
                    ? _grid([_LocalTile(_ctrl), ...visible.map((p) => _RemoteTile(_ctrl, p))])
                    : Column(children: [
                        Expanded(
                          child: PageView.builder(
                            itemCount: pages,
                            onPageChanged: (i) => setState(() => _page = i),
                            itemBuilder: (_, i) {
                              final s = i * _perPage;
                              final e = (s + _perPage) > members.length ? members.length : s + _perPage;
                              final tiles = <Widget>[
                                if (i == 0) _LocalTile(_ctrl),
                                ...members.sublist(s, e).map((p) => _RemoteTile(_ctrl, p)),
                              ];
                              return _grid(tiles);
                            },
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                            for (var i = 0; i < pages; i++)
                              Container(
                                width: 8, height: 8, margin: const EdgeInsets.symmetric(horizontal: 3),
                                decoration: BoxDecoration(
                                    shape: BoxShape.circle,
                                    color: i == page ? Zine.coral : Zine.card,
                                    border: Border.all(color: Zine.ink, width: 2)),
                              ),
                          ]),
                        ),
                      ]),
              ),
              Container(
                decoration: const BoxDecoration(
                  color: Zine.paper2,
                  border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
                ),
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
                  _ctl(_ctrl.muted ? PhosphorIcons.microphoneSlash(PhosphorIconsStyle.bold) : PhosphorIcons.microphone(PhosphorIconsStyle.bold),
                      _ctrl.muted ? 'Unmute' : 'Mute', _ctrl.toggleMute, active: !_ctrl.muted),
                  if (widget.video)
                    _ctl(_ctrl.cameraOn ? PhosphorIcons.videoCamera(PhosphorIconsStyle.bold) : PhosphorIcons.videoCameraSlash(PhosphorIconsStyle.bold),
                        'Camera', _ctrl.toggleCamera, active: _ctrl.cameraOn),
                  if (widget.video && _ctrl.cameraOn)
                    _ctl(PhosphorIcons.cameraRotate(PhosphorIconsStyle.bold), 'Flip', _ctrl.flipCamera, active: true),
                  _ctl(_ctrl.speakerOn ? PhosphorIcons.speakerHigh(PhosphorIconsStyle.bold) : PhosphorIcons.ear(PhosphorIconsStyle.bold),
                      'Speaker', _ctrl.toggleSpeaker, active: _ctrl.speakerOn),
                  GestureDetector(
                    onTap: _leave,
                    child: Container(
                      width: 56, height: 56,
                      decoration: BoxDecoration(
                        color: Zine.coral, shape: BoxShape.circle,
                        border: Border.all(color: Zine.ink, width: Zine.bw), boxShadow: Zine.shadowSm,
                      ),
                      child: PhosphorIcon(PhosphorIcons.phoneX(PhosphorIconsStyle.fill), color: Colors.white, size: 24),
                    ),
                  ),
                ]),
              ),
            ]),
          ),
        ),
      ),
    );
  }

  Widget _ctl(IconData icon, String tip, VoidCallback onTap, {required bool active}) => Tooltip(
        message: tip,
        child: GestureDetector(
          onTap: onTap,
          child: Container(
            width: 48, height: 48,
            decoration: BoxDecoration(
              color: active ? Zine.card : Zine.coral,
              shape: BoxShape.circle,
              border: Border.all(color: Zine.ink, width: Zine.bw),
              boxShadow: Zine.shadowXs,
            ),
            child: Icon(icon, color: active ? Zine.ink : Colors.white, size: 22),
          ),
        ),
      );

  Widget _grid(List<Widget> tiles) {
    final cols = tiles.length <= 1 ? 1 : (tiles.length <= 4 ? 2 : 2);
    final rows = (tiles.length / cols).ceil().clamp(1, 100);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: LayoutBuilder(builder: (ctx, c) {
        final tileH = (c.maxHeight - (rows - 1) * 8) / rows;
        final tileW = (c.maxWidth - (cols - 1) * 8) / cols;
        return GridView.builder(
          physics: const NeverScrollableScrollPhysics(),
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: cols, mainAxisSpacing: 8, crossAxisSpacing: 8,
              childAspectRatio: tileW / (tileH <= 0 ? 1 : tileH)),
          itemCount: tiles.length,
          itemBuilder: (_, i) => tiles[i],
        );
      }),
    );
  }
}

class _LocalTile extends StatelessWidget {
  final CloudflareConferenceController ctrl;
  const _LocalTile(this.ctrl);

  @override
  Widget build(BuildContext context) {
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(color: Zine.paper2, borderRadius: BorderRadius.circular(14), border: Border.all(color: Zine.ink, width: 2)),
      child: Stack(fit: StackFit.expand, children: [
        if (ctrl.cameraOn)
          webrtc.RTCVideoView(ctrl.localRenderer, mirror: true, objectFit: webrtc.RTCVideoViewObjectFit.RTCVideoViewObjectFitCover)
        else
          const Center(child: Icon(Icons.person, color: Colors.white54, size: 48)),
        Positioned(left: 6, bottom: 6, child: _namePill('You', muted: ctrl.muted)),
      ]),
    );
  }
}

class _RemoteTile extends StatelessWidget {
  final CloudflareConferenceController ctrl;
  final CfParticipant p;
  const _RemoteTile(this.ctrl, this.p);

  @override
  Widget build(BuildContext context) {
    final renderer = ctrl.rendererFor(p.uid);
    final speaking = ctrl.dominantSpeakerUid == p.uid;
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: Zine.paper2,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: speaking ? Zine.lime : Zine.ink, width: speaking ? Zine.bw : 2),
      ),
      child: Stack(fit: StackFit.expand, children: [
        if (p.videoEnabled && renderer != null)
          webrtc.RTCVideoView(renderer, objectFit: webrtc.RTCVideoViewObjectFit.RTCVideoViewObjectFitCover)
        else
          Center(child: Avatar(seed: p.uid, name: p.uid, size: 56)),
        Positioned(left: 6, bottom: 6, child: _namePill(p.uid, muted: p.audioTrack == null)),
      ]),
    );
  }
}

Widget _namePill(String name, {required bool muted}) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(color: Zine.ink.withValues(alpha: 0.55), borderRadius: BorderRadius.circular(100)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Flexible(child: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis,
            style: ZineText.value(size: 11.5, color: Colors.white, weight: FontWeight.w700))),
        if (muted) ...[
          const SizedBox(width: 4),
          PhosphorIcon(PhosphorIcons.microphoneSlash(PhosphorIconsStyle.bold), color: Colors.white, size: 12),
        ],
      ]),
    );

// [CF-CALL-003/007] Cloudflare Realtime A/V group-call screen — the ONLY
// group-call screen as of CF-CALL-007 (the prior `conference_screen.dart`
// provider was removed). Zine UI conventions (paper chrome, bordered circle
// controls, lime speaking border, grid/paginated-grid tiles); all
// media/session logic lives in `CloudflareConferenceController`.
//
// Reached only when RemoteConfig.cloudflareConferenceEnabled is true (see the
// chat_thread.dart launch-site branch). When the flag is off, group calls are
// simply unavailable — there is no other transport to fall back to.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart' as webrtc;
import 'package:permission_handler/permission_handler.dart' show openAppSettings;
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
    _ctrl = CloudflareConferenceController(
        gid: widget.gid, title: widget.title, wantVideo: widget.video, starter: widget.starter);
    _ctrl.addListener(_onChanged);
    unawaited(_ctrl.connect());
  }

  void _onChanged() {
    if (mounted) setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // [GCALL-W2-HOLD] Lifecycle handling was resume-only, so backgrounding
    // neither survived nor left cleanly. `paused` now keeps the call (the
    // foreground service holds the process) and merely records it; `detached`
    // is the process actually going away, which must leave properly rather
    // than let the DO discover it 45-60s later via the zombie sweep.
    switch (state) {
      case AppLifecycleState.resumed:
        _ctrl.onForegroundResume();
      case AppLifecycleState.paused:
        _ctrl.onBackgrounded();
      case AppLifecycleState.detached:
        unawaited(_ctrl.leave(reason: 'app_detached'));
      case AppLifecycleState.inactive:
      case AppLifecycleState.hidden:
        break;
    }
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
              // `statusText` now carries the server's real message (or a
              // permission-specific one) instead of one generic line for every
              // possible cause.
              ZineEmptyState(icon: PhosphorIcons.warning(PhosphorIconsStyle.bold), text: _ctrl.statusText),
              const SizedBox(height: 16),
              // A permission refusal is the one failure the user can fix on the
              // spot — give them the door instead of a dead end.
              if (_ctrl.permissionDenied) ...[
                ZineButton(label: 'Open settings', fontSize: 16, onPressed: openAppSettings),
                const SizedBox(height: 8),
              ],
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
                    Text(
                      // A reconnect used to render as a completely frozen call:
                      // `reconnecting` had no UI at all, so the only visible
                      // difference between recovering and dead was neither.
                      _ctrl.state == CfConnState.reconnecting
                          ? 'RECONNECTING…'
                          : '${members.length + 1} IN CALL · CLOUDFLARE',
                      style: ZineText.kicker(size: 10.5),
                    ),
                  ])),
                ]),
              ),
              if (_ctrl.notice != null) _noticeBar(_ctrl.notice!),
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
                  // Camera controls follow the EFFECTIVE media mode, not
                  // `widget.video` (the request). A video call that downgraded
                  // to audio — camera permission denied, or the call itself is
                  // audio-only — used to keep showing a camera button that
                  // could never do anything.
                  if (_ctrl.effectiveVideo)
                    _ctl(_ctrl.cameraOn ? PhosphorIcons.videoCamera(PhosphorIconsStyle.bold) : PhosphorIcons.videoCameraSlash(PhosphorIconsStyle.bold),
                        'Camera', _ctrl.toggleCamera, active: _ctrl.cameraOn),
                  if (_ctrl.effectiveVideo && _ctrl.cameraOn)
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

  /// Non-fatal condition worth stating plainly: an audio downgrade, or a
  /// degraded TURN relay. Dismissible — it never blocks the call.
  Widget _noticeBar(String text) => Container(
        width: double.infinity,
        decoration: const BoxDecoration(
          color: Zine.card,
          border: Border(bottom: BorderSide(color: Zine.ink, width: 2)),
        ),
        padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
        child: Row(children: [
          PhosphorIcon(PhosphorIcons.info(PhosphorIconsStyle.bold), size: 16, color: Zine.ink),
          const SizedBox(width: 8),
          Expanded(child: Text(text, style: ZineText.value(size: 12.5))),
          GestureDetector(
            onTap: () => setState(() => _ctrl.notice = null),
            child: Padding(
              padding: const EdgeInsets.all(4),
              child: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold), size: 14, color: Zine.ink),
            ),
          ),
        ]),
      );

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
        // [GCALL-W4-MUTE] Real mute state from the roster. This was
        // `p.audioTrack == null`, which is only true BEFORE someone's first
        // publish — so the mic-slash never appeared for anyone who had actually
        // muted, and vanished for good once they published.
        Positioned(left: 6, bottom: 6,
            child: _namePill(p.uid, muted: p.muted || p.audioTrack == null)),
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

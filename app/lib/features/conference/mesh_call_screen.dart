// Free-tier P2P MESH group call (≤5 participants). Each device holds a direct
// WebRTC PeerConnection to every other participant (full mesh); media never
// touches our servers (ICE via Cloudflare STUN/TURN). Signaling rides the
// MeshRoom DO over the same welcome/offer/answer/candidate protocol the 1:1
// CallScreen uses — generalized here to N peers.
//
// Mesh role rule (avoids glare): the NEWCOMER offers to each existing peer (the
// `welcome.peers` list); existing peers only answer. Paid tiers use the
// Cloudflare Realtime A/V CloudflareConferenceScreen instead — this screen is
// the Free path.
//
// Chrome: AD dark tokens (near-black surfaces, hairline borders); participant
// tiles are hairline-bordered cards; the control bar is a header-footer band of
// circular buttons (leave = danger).
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:stream_webrtc_flutter/stream_webrtc_flutter.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:uuid/uuid.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/ava_log.dart';
import '../../core/ice_cache.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import 'mesh_api.dart';

/// One remote participant in the mesh: its PeerConnection, video renderer, and
/// the candidate queue used before the remote description is set.
class _Peer {
  final String id;
  RTCPeerConnection? pc;
  final RTCVideoRenderer renderer = RTCVideoRenderer();
  bool remoteSet = false;
  final List<RTCIceCandidate> pending = [];
  bool hasVideo = false;
  _Peer(this.id);
}

class MeshCallScreen extends StatefulWidget {
  final String gid;
  final String title;
  final bool video;

  /// True when this device started the call (first in the room). Informational
  /// only — mesh has no "end for all"; each peer leaves independently.
  final bool starter;

  const MeshCallScreen({
    super.key,
    required this.gid,
    required this.title,
    required this.video,
    this.starter = false,
  });

  @override
  State<MeshCallScreen> createState() => _MeshCallScreenState();
}

class _MeshCallScreenState extends State<MeshCallScreen> {
  final String _myId = const Uuid().v4().substring(0, 12);
  final RTCVideoRenderer _local = RTCVideoRenderer();
  final Map<String, _Peer> _peers = {};

  MediaStream? _stream;
  WebSocketChannel? _ws;
  List<Map<String, dynamic>> _ice = const [];

  bool _mic = true;
  bool _cam = true;
  bool _speaker = true;
  bool _left = false;
  String? _error;
  int? _joinedAt;
  int _peak = 1;

  bool get _video => widget.video;

  @override
  void initState() {
    super.initState();
    _cam = widget.video;
    _start();
  }

  Future<void> _start() async {
    try {
      await _local.initialize();
      _ice = await IceCache.get();
      _stream = await navigator.mediaDevices.getUserMedia({
        'audio': true,
        'video': _video ? {'facingMode': 'user'} : false,
      });
    } catch (e) {
      Analytics.error(
        domain: 'mesh_call', code: 'media_denied', message: e.toString(),
        extra: {'gid': widget.gid, 'video': _video, 'transport_mode': 'p2p_mesh'},
      );
      if (mounted) setState(() => _error = 'Microphone permission is needed for a call');
      return;
    }
    _local.srcObject = _stream;
    try { await Helper.setSpeakerphoneOn(_speaker); } catch (_) {}

    final url = MeshApi.wsUrl(widget.gid, _myId);
    AvaLog.I.log('mesh', 'join ${widget.gid} as $_myId');
    _ws = WebSocketChannel.connect(Uri.parse(url));
    _ws!.stream.listen(_onSignal, onError: (_) => _onSocketLost(), onDone: _onSocketLost);

    _joinedAt = DateTime.now().millisecondsSinceEpoch;
    Analytics.capture('mesh_call_joined', {
      'gid': widget.gid, 'video': _video, 'starter': widget.starter,
      'transport_mode': 'p2p_mesh',
    });
    if (mounted) setState(() {});
  }

  void _onSocketLost() {
    if (_left) return;
    // Losing signaling doesn't necessarily drop established P2P media, but a mesh
    // can't admit/repair peers without it — treat as call end.
    _leave(reason: 'socket_lost');
  }

  void _send(Map<String, dynamic> o) => _ws?.sink.add(jsonEncode(o));

  // ── signaling ────────────────────────────────────────────────────────────────
  Future<void> _onSignal(dynamic raw) async {
    Map<String, dynamic> d;
    try { d = jsonDecode(raw as String) as Map<String, dynamic>; } catch (_) { return; }
    switch (d['type']) {
      case 'welcome':
        // We are the newcomer → offer to each peer already in the room.
        final peers = ((d['peers'] as List?) ?? const []).cast<String>();
        for (final id in peers) {
          await _connectTo(id, initiator: true);
        }
        break;
      case 'peer-joined':
        // A newcomer arrived; they will offer to us. Nothing to do yet.
        break;
      case 'offer':
        final from = d['from'] as String?;
        if (from == null) break;
        final peer = await _connectTo(from, initiator: false);
        final pc = peer.pc;
        if (pc == null) break;
        await pc.setRemoteDescription(
            RTCSessionDescription(d['sdp']['sdp'] as String, d['sdp']['type'] as String));
        peer.remoteSet = true;
        await _flush(peer);
        final ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        _send({'type': 'answer', 'to': from, 'sdp': ans.toMap()});
        break;
      case 'answer':
        final from = d['from'] as String?;
        final peer = from == null ? null : _peers[from];
        if (peer?.pc == null) break;
        await peer!.pc!.setRemoteDescription(
            RTCSessionDescription(d['sdp']['sdp'] as String, d['sdp']['type'] as String));
        peer.remoteSet = true;
        await _flush(peer);
        break;
      case 'candidate':
        final from = d['from'] as String?;
        final peer = from == null ? null : _peers[from];
        if (peer == null) break;
        final m = d['candidate'] as Map<String, dynamic>;
        final cand = RTCIceCandidate(
            m['candidate'] as String?, m['sdpMid'] as String?, (m['sdpMLineIndex'] as num?)?.toInt());
        if (peer.remoteSet && peer.pc != null) {
          try { await peer.pc!.addCandidate(cand); } catch (_) {}
        } else {
          peer.pending.add(cand);
        }
        break;
      case 'peer-left':
      case 'bye':
        final id = (d['id'] ?? d['from']) as String?;
        if (id != null) _dropPeer(id);
        break;
      case 'full':
        if (mounted) setState(() => _error = 'This call is full (max ${MeshApi.maxMesh})');
        _teardownMedia();
        break;
    }
    if (mounted) setState(() {});
  }

  Future<_Peer> _connectTo(String peerId, {required bool initiator}) async {
    final existing = _peers[peerId];
    if (existing != null && existing.pc != null) return existing;
    final peer = existing ?? _Peer(peerId);
    _peers[peerId] = peer;
    await peer.renderer.initialize();

    final pc = await createPeerConnection({'iceServers': _ice});
    peer.pc = pc;
    _stream?.getTracks().forEach((t) => pc.addTrack(t, _stream!));

    pc.onIceCandidate = (c) {
      if (c.candidate == null) return;
      _send({'type': 'candidate', 'to': peerId, 'candidate': c.toMap()});
    };
    pc.onTrack = (e) {
      if (e.streams.isNotEmpty) {
        peer.renderer.srcObject = e.streams[0];
        peer.hasVideo = e.track.kind == 'video';
        if (mounted) setState(() {});
      }
    };
    pc.onConnectionState = (s) {
      if (s == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
          s == RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
        _dropPeer(peerId);
      }
    };

    final n = _peers.length + 1;
    if (n > _peak) _peak = n;

    if (initiator) {
      final offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      _send({'type': 'offer', 'to': peerId, 'sdp': offer.toMap()});
    }
    return peer;
  }

  Future<void> _flush(_Peer peer) async {
    final pc = peer.pc;
    if (pc == null) return;
    final pending = List<RTCIceCandidate>.of(peer.pending);
    peer.pending.clear();
    for (final c in pending) {
      try { await pc.addCandidate(c); } catch (_) {}
    }
  }

  void _dropPeer(String id) {
    final peer = _peers.remove(id);
    if (peer == null) return;
    try { peer.renderer.srcObject = null; } catch (_) {}
    try { peer.renderer.dispose(); } catch (_) {}
    try { peer.pc?.close(); } catch (_) {}
    if (mounted) setState(() {});
  }

  // ── controls ─────────────────────────────────────────────────────────────────
  void _toggleMic() {
    _mic = !_mic;
    for (final t in _stream?.getAudioTracks() ?? const []) { t.enabled = _mic; }
    if (mounted) setState(() {});
  }

  void _toggleCam() {
    _cam = !_cam;
    for (final t in _stream?.getVideoTracks() ?? const []) { t.enabled = _cam; }
    if (mounted) setState(() {});
  }

  Future<void> _flipCam() async {
    for (final t in _stream?.getVideoTracks() ?? const []) {
      try { await Helper.switchCamera(t); } catch (_) {}
      return;
    }
  }

  Future<void> _toggleSpeaker() async {
    _speaker = !_speaker;
    try { await Helper.setSpeakerphoneOn(_speaker); } catch (_) {}
    if (mounted) setState(() {});
  }

  Future<void> _leave({String reason = 'leave'}) async {
    if (_left) return;
    _left = true;
    try { _send({'type': 'bye'}); } catch (_) {}
    final dur = _joinedAt == null
        ? 0
        : ((DateTime.now().millisecondsSinceEpoch - _joinedAt!) / 1000).round();
    Analytics.capture('mesh_call_left', {
      'gid': widget.gid, 'reason': reason, 'duration_s': dur,
      'peak_participants': _peak, 'video': _video, 'transport_mode': 'p2p_mesh',
    });
    _teardownMedia();
    // CALL-UI-DEAD-1: direct pop — maybePop() is vetoed by this screen's own
    // PopScope(canPop:false), which made Leave look dead.
    if (mounted) {
      final nav = Navigator.of(context);
      if (nav.canPop()) nav.pop();
    }
  }

  void _teardownMedia() {
    try { _ws?.sink.close(); } catch (_) {}
    for (final p in _peers.values) {
      try { p.renderer.srcObject = null; } catch (_) {}
      try { p.renderer.dispose(); } catch (_) {}
      try { p.pc?.close(); } catch (_) {}
    }
    _peers.clear();
    try { _local.srcObject = null; } catch (_) {}
    for (final t in _stream?.getTracks() ?? const []) { try { t.stop(); } catch (_) {} }
    try { _stream?.dispose(); } catch (_) {}
    _stream = null;
  }

  @override
  void dispose() {
    if (!_left) {
      _left = true;
      _teardownMedia();
    }
    try { _local.dispose(); } catch (_) {}
    super.dispose();
  }

  // ── UI ───────────────────────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return Scaffold(
        backgroundColor: AD.bg,
        body: ZinePaper(
          child: SafeArea(
            child: Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
              ZineEmptyState(icon: PhosphorIcons.warning(PhosphorIconsStyle.regular), text: _error!),
              const SizedBox(height: Msg.s4),
              ZineButton(label: 'Close', variant: ZineButtonVariant.ghost, fontSize: 16,
                  onPressed: () => Navigator.of(context).maybePop()),
            ])),
          ),
        ),
      );
    }

    final tiles = <Widget>[
      _tile(name: 'You', renderer: _local, mirror: true, showVideo: _video && _cam),
      for (final p in _peers.values)
        _tile(name: 'In call', renderer: p.renderer, mirror: false, showVideo: _video && p.hasVideo),
    ];
    final n = tiles.length;
    final cols = n <= 1 ? 1 : 2;

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) { if (!didPop) _leave(); },
      child: Scaffold(
        backgroundColor: AD.bg,
        body: ZinePaper(
          child: SafeArea(
            child: Column(children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(Msg.s3, Msg.s2, Msg.s3, Msg.s2),
                child: Row(children: [
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(widget.title, maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: ADText.threadName()),
                    Text('$n in call · Free · max ${MeshApi.maxMesh}',
                        style: ADText.sectionLabel()),
                  ])),
                ]),
              ),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: Msg.s2),
                  child: GridView.count(
                    crossAxisCount: cols,
                    mainAxisSpacing: Msg.s2,
                    crossAxisSpacing: Msg.s2,
                    childAspectRatio: 0.78,
                    children: tiles,
                  ),
                ),
              ),
              Container(
                decoration: const BoxDecoration(
                  color: AD.headerFooter,
                  border: Border(top: Msg.hairline),
                ),
                padding: const EdgeInsets.symmetric(vertical: Msg.s3),
                child: Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
                  _ctl(_mic ? PhosphorIcons.microphone(PhosphorIconsStyle.regular)
                            : PhosphorIcons.microphoneSlash(PhosphorIconsStyle.regular),
                      _mic ? 'Mute' : 'Unmute', _toggleMic, active: _mic),
                  if (_video)
                    _ctl(_cam ? PhosphorIcons.videoCamera(PhosphorIconsStyle.regular)
                              : PhosphorIcons.videoCameraSlash(PhosphorIconsStyle.regular),
                        'Camera', _toggleCam, active: _cam),
                  if (_video && _cam)
                    _ctl(PhosphorIcons.cameraRotate(PhosphorIconsStyle.regular), 'Flip', _flipCam, active: true),
                  _ctl(_speaker ? PhosphorIcons.speakerHigh(PhosphorIconsStyle.regular)
                                : PhosphorIcons.ear(PhosphorIconsStyle.regular),
                      'Speaker', _toggleSpeaker, active: _speaker),
                  GestureDetector(
                    onTap: _leave,
                    child: Container(
                      width: 56, height: 56,
                      decoration: BoxDecoration(
                        color: AD.danger, shape: BoxShape.circle,
                        border: Border.all(color: AD.borderControl, width: 1),
                        boxShadow: Msg.lift,
                      ),
                      child: PhosphorIcon(PhosphorIcons.phoneX(PhosphorIconsStyle.bold),
                          color: AD.destructiveInk, size: 24),
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
              color: active ? AD.card : AD.danger, shape: BoxShape.circle,
              border: Border.all(color: AD.borderControl, width: 1),
            ),
            child: Icon(icon, color: active ? AD.iconNeutral : AD.destructiveInk, size: 22),
          ),
        ),
      );

  Widget _tile({required String name, required RTCVideoRenderer renderer, required bool mirror, required bool showVideo}) {
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: AD.card,
        borderRadius: Msg.brMd,
        border: Border.all(color: AD.borderControl, width: 1),
      ),
      child: Stack(fit: StackFit.expand, children: [
        if (showVideo && renderer.srcObject != null)
          RTCVideoView(renderer, mirror: mirror, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover)
        else
          Center(child: Avatar(seed: name, name: name, size: 64)),
        Positioned(
          left: 6, bottom: 6,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: Msg.s2, vertical: 2),
            decoration: BoxDecoration(
              color: AD.scrim,
              // Name tag over a video tile — a genuine pill.
              borderRadius: Msg.brPill,
            ),
            child: Text(name, style: ADText.bubbleMeta(c: AD.textPrimary)),
          ),
        ),
      ]),
    );
  }
}

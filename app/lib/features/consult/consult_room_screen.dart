// Phase 7 — AvaConsult room. 1:1 = P2P over the CallRoom-DO signaling pattern
// (same protocol as the AvaTok call screen; 2-peer cap reused). Group (≤10/20)
// = Cloudflare Realtime SFU via the Worker proxy + the SAME flutter_webrtc —
// no RealtimeKit/Dyte SDK (perf budget §1).
//
// Both sides: time-remaining countdown, 5-min warning toast, auto-end at slot
// end (+2 min grace), "Send file" → the existing AvaTok thread (files flow
// through the normal media pipeline → AvaLibrary for both parties — zero new
// infrastructure). Host extras: waiting-room indicator ("waiting for buyer…
// 12:43 left of 20:00 wait" — feeds refund rule R2), extend-session offer
// (calendar-checked), mark-complete on leave. Post-session: rate → review.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:uuid/uuid.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../../core/config.dart';
import '../../core/analytics.dart';
import '../../core/listings_api.dart';
import '../../core/session_api.dart';
import '../../core/theme.dart';
import '../avatok/chat_thread.dart';
import '../avatok/data.dart';
import '../translation/translate_overlay.dart';

const _kWaitWindowMs = 20 * 60_000;   // R2 wait window shown to the host

class ConsultRoomScreen extends StatefulWidget {
  final String bookingId;
  final Map<String, dynamic> join;     // /api/consult/:id/join response
  final MediaStream? localStream;      // handed over from the pre-join screen
  const ConsultRoomScreen({super.key, required this.bookingId, required this.join, this.localStream});
  @override
  State<ConsultRoomScreen> createState() => _ConsultRoomScreenState();
}

class _Peer {
  final String uid;
  final String name;
  final RTCVideoRenderer renderer = RTCVideoRenderer();
  bool ready = false;
  _Peer(this.uid, this.name) { renderer.initialize(); }
  void dispose() => renderer.dispose();
}

class _ConsultRoomScreenState extends State<ConsultRoomScreen> {
  final _localRenderer = RTCVideoRenderer();
  MediaStream? _local;
  RoomChannel? _room;                  // session DO WS (presence/countdown/tracks)
  Timer? _tick;
  bool _warned5 = false;
  bool _ended = false;

  // P2P (1:1)
  WebSocketChannel? _sig;
  RTCPeerConnection? _pc;
  String? _remoteId;
  bool _remoteSet = false;
  final List<RTCIceCandidate> _pendingCand = [];
  final _myPeerId = 'consult-${const Uuid().v4().substring(0, 8)}';

  // SFU (group)
  RTCPeerConnection? _sfuPc;
  String? _sfuSession;
  final Map<String, _Peer> _peers = {};          // uid → peer (remote)
  final Set<String> _pulled = {};                // remote track ids already pulled
  bool _waitingRoom = true;                      // host: nobody here yet
  int _participants = 0;

  bool get _group => widget.join['mode'] == 'sfu';
  int get _startsAt => (widget.join['starts_at'] as num?)?.toInt() ?? 0;
  int get _endsAt => (widget.join['ends_at'] as num?)?.toInt() ?? 0;
  String get _title => widget.join['title']?.toString() ?? 'Session';
  String get _token => widget.join['room_token']?.toString() ?? '';

  bool _micOn = true, _camOn = true, _speakerOn = true;

  @override
  void initState() {
    super.initState();
    _localRenderer.initialize();
    _setup();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => _onTick());
  }

  Future<void> _setup() async {
    _local = widget.localStream ??
        await navigator.mediaDevices.getUserMedia({'audio': true, 'video': {'facingMode': 'user'}});
    _localRenderer.srcObject = _local;
    try { await Helper.setSpeakerphoneOn(true); } catch (_) {}
    _openRoom();
    if (_group) {
      await _sfuConnect();
    } else {
      _p2pConnect();
    }
    Analytics.capture('consult_room_entered', {'mode': _group ? 'sfu' : 'p2p'});
  }

  void _onTick() {
    if (!mounted) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    final remaining = _endsAt - now;
    if (!_warned5 && remaining <= 5 * 60_000 && remaining > 0) {
      _warned5 = true;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('⏰ 5 minutes remaining')));
    }
    if (remaining <= -2 * 60_000 && !_ended) _leave(auto: true); // grace 2 min
    setState(() {});
  }

  // ---------------------------------------------------------------------------
  // Session-room WS: presence (waiting room), SFU track announcements.
  // ---------------------------------------------------------------------------
  void _openRoom() {
    _room = RoomChannel(SessionApi.consultRoomWs(widget.bookingId, _token), (e) {
      if (!mounted) return;
      switch (e['type']) {
        case 'presence':
          final role = e['role']?.toString();
          final joined = e['joined'] == true;
          if (role == 'attendee' && joined) setState(() => _waitingRoom = false);
          setState(() => _participants += joined ? 1 : -1);
        case 'welcome':
          // roster arrives via 'state' polling if needed; presence covers live changes
          break;
        case 'track':
          if (_group) _pullTrack(e);
        case 'session_ended':
          if (!_ended) _leave(auto: true);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 1:1 — P2P via the CallRoom DO (newcomer offers; candidates relayed).
  // ---------------------------------------------------------------------------
  void _p2pConnect() {
    final room = widget.join['room']?.toString() ?? 'consult-${widget.bookingId}';
    final ch = WebSocketChannel.connect(Uri.parse('wss://$kSignalingHost/room/$room?id=$_myPeerId'));
    _sig = ch;
    ch.stream.listen((raw) async {
      final m = jsonDecode(raw as String) as Map<String, dynamic>;
      switch (m['type']) {
        case 'welcome':
          final peers = (m['peers'] as List? ?? const []).cast<String>();
          if (peers.isNotEmpty) {
            _remoteId = peers.first;
            final pc = await _newP2pPc();
            final offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            _sigSend({'type': 'offer', 'to': _remoteId, 'sdp': offer.toMap()});
          }
        case 'peer-joined':
          _remoteId = m['id']?.toString();
          setState(() => _waitingRoom = false);
        case 'offer':
          _remoteId = m['from']?.toString();
          final pc = await _newP2pPc();
          await pc.setRemoteDescription(_desc(m['sdp']));
          await _flushCand();
          final ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          _sigSend({'type': 'answer', 'to': _remoteId, 'sdp': ans.toMap()});
          setState(() => _waitingRoom = false);
        case 'answer':
          await _pc?.setRemoteDescription(_desc(m['sdp']));
          await _flushCand();
        case 'candidate':
          final c = m['candidate'] as Map<String, dynamic>?;
          if (c != null) {
            final cand = RTCIceCandidate(c['candidate'], c['sdpMid'], c['sdpMLineIndex']);
            if (_remoteSet) { try { await _pc?.addCandidate(cand); } catch (_) {} } else { _pendingCand.add(cand); }
          }
        case 'peer-left':
          setState(() { _peers.removeWhere((k, p) { p.dispose(); return true; }); _waitingRoom = true; });
        case 'busy':
          if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Room is full (1:1).')));
      }
    }, onError: (_) {}, onDone: () {});
  }

  RTCSessionDescription _desc(dynamic sdp) =>
      RTCSessionDescription((sdp as Map)['sdp'] as String, sdp['type'] as String);

  void _sigSend(Map<String, dynamic> o) { try { _sig?.sink.add(jsonEncode(o)); } catch (_) {} }

  Future<RTCPeerConnection> _newP2pPc() async {
    await _pc?.close();
    _remoteSet = false;
    final pc = await createPeerConnection({
      'iceServers': [{'urls': 'stun:stun.cloudflare.com:3478'}],
    });
    for (final t in _local!.getTracks()) {
      await pc.addTrack(t, _local!);
    }
    pc.onIceCandidate = (c) { if (_remoteId != null) _sigSend({'type': 'candidate', 'to': _remoteId, 'candidate': c.toMap()}); };
    pc.onTrack = (e) {
      if (e.streams.isEmpty) return;
      final p = _peers.putIfAbsent('peer', () => _Peer('peer', widget.join['peer_name']?.toString() ?? 'Partner'));
      p.renderer.srcObject = e.streams[0];
      p.ready = true;
      if (mounted) setState(() => _waitingRoom = false);
    };
    _pc = pc;
    return pc;
  }

  Future<void> _flushCand() async {
    _remoteSet = true;
    for (final c in List.of(_pendingCand)) { try { await _pc?.addCandidate(c); } catch (_) {} }
    _pendingCand.clear();
  }

  // ---------------------------------------------------------------------------
  // Group — Cloudflare Realtime SFU (push local tracks; pull announced ones).
  // ---------------------------------------------------------------------------
  Future<void> _sfuConnect() async {
    try {
      final s = await SessionApi.sfu(widget.bookingId, _token, '/sessions/new');
      _sfuSession = s['sessionId']?.toString();
      final pc = await createPeerConnection({
        'iceServers': [{'urls': 'stun:stun.cloudflare.com:3478'}],
        'bundlePolicy': 'max-bundle',
      });
      _sfuPc = pc;
      final transceivers = <RTCRtpTransceiver>[];
      for (final t in _local!.getTracks()) {
        transceivers.add(await pc.addTransceiver(
          track: t,
          init: RTCRtpTransceiverInit(direction: TransceiverDirection.SendOnly, streams: [_local!]),
        ));
      }
      pc.onTrack = _onSfuTrack;
      final offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      final tracks = <Map<String, dynamic>>[];
      for (final tr in transceivers) {
        tracks.add({'location': 'local', 'mid': tr.mid, 'trackName': tr.sender.track?.id ?? const Uuid().v4()});
      }
      final r = await SessionApi.sfu(widget.bookingId, _token, '/sessions/$_sfuSession/tracks/new', body: {
        'sessionDescription': {'type': 'offer', 'sdp': offer.sdp},
        'tracks': tracks,
      });
      final ans = r['sessionDescription'] as Map<String, dynamic>?;
      if (ans != null) await pc.setRemoteDescription(RTCSessionDescription(ans['sdp'] as String, ans['type'] as String));
      // Announce my published tracks to the room so others pull them.
      for (final t in tracks) {
        _room?.send({'type': 'track', 'track': t['trackName'], 'session': _sfuSession});
      }
    } on SessionApiError catch (e) {
      if (mounted) setState(() => _ended = false);
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Group room unavailable: ${e.message}')));
    }
  }

  void _onSfuTrack(RTCTrackEvent e) {
    if (e.streams.isEmpty) return;
    final sid = e.streams[0].id;
    final p = _peers.putIfAbsent(sid, () => _Peer(sid, 'Participant ${_peers.length + 1}'));
    p.renderer.srcObject = e.streams[0];
    p.ready = true;
    if (mounted) setState(() => _waitingRoom = false);
  }

  Future<void> _pullTrack(Map<String, dynamic> e) async {
    final remoteSession = e['session']?.toString();
    final trackName = e['track']?.toString();
    if (remoteSession == null || trackName == null || remoteSession == _sfuSession) return;
    final key = '$remoteSession/$trackName';
    if (_pulled.contains(key) || _sfuSession == null || _sfuPc == null) return;
    _pulled.add(key);
    try {
      final r = await SessionApi.sfu(widget.bookingId, _token, '/sessions/$_sfuSession/tracks/new', body: {
        'tracks': [{'location': 'remote', 'sessionId': remoteSession, 'trackName': trackName}],
      });
      if (r['requiresImmediateRenegotiation'] == true) {
        final offer = r['sessionDescription'] as Map<String, dynamic>;
        await _sfuPc!.setRemoteDescription(RTCSessionDescription(offer['sdp'] as String, offer['type'] as String));
        final answer = await _sfuPc!.createAnswer();
        await _sfuPc!.setLocalDescription(answer);
        await SessionApi.sfu(widget.bookingId, _token, '/sessions/$_sfuSession/renegotiate',
            body: {'sessionDescription': {'type': 'answer', 'sdp': answer.sdp}}, method: 'PUT');
      }
    } catch (_) { _pulled.remove(key); }
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  void _toggleMic() { _micOn = !_micOn; _local?.getAudioTracks().forEach((t) => t.enabled = _micOn); setState(() {}); }
  void _toggleCam() { _camOn = !_camOn; _local?.getVideoTracks().forEach((t) => t.enabled = _camOn); setState(() {}); }
  void _flip() { final v = _local?.getVideoTracks(); if (v != null && v.isNotEmpty) Helper.switchCamera(v.first); }
  void _toggleSpeaker() { _speakerOn = !_speakerOn; Helper.setSpeakerphoneOn(_speakerOn); setState(() {}); }

  /// "Send file" — opens the existing AvaTok thread with the other party; files
  /// sent there ride the normal media pipeline and land in BOTH AvaLibraries.
  void _sendFile() {
    final peer = widget.join['thread_peer']?.toString() ?? widget.join['peer']?.toString();
    if (peer == null) return;
    final chat = Chat(name: widget.join['peer_name']?.toString() ?? 'Session partner', seed: peer, last: '', time: '');
    Navigator.push(context, MaterialPageRoute(builder: (_) => ChatThreadScreen(chat: chat)));
  }

  Future<void> _extend() async {
    try {
      final r = await SessionApi.consultExtend(widget.bookingId);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Extended by 15 minutes ✅')));
      widget.join['ends_at'] = r['ends_at'];
      _warned5 = false;
    } on SessionApiError catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e.status == 409 ? 'Your next slot is booked — cannot extend.' : e.message)));
      }
    }
  }

  bool get _hostRole {
    // the join payload's peer is "the other side": for the host that's the buyer.
    return widget.join['host_id'] != null && widget.join['peer']?.toString() != widget.join['host_id']?.toString();
  }

  Future<void> _leave({bool auto = false}) async {
    if (_ended) return;
    _ended = true;
    if (_hostRole) {
      try { await SessionApi.consultComplete(widget.bookingId); } catch (_) {}
    }
    if (!mounted) return;
    // Post-session rating (both sides) → Phase 6 review.
    final listingId = widget.join['listing_id']?.toString();
    if (listingId != null && !_hostRole) await _rateSheet(listingId);
    if (mounted) Navigator.pop(context);
  }

  Future<void> _rateSheet(String listingId) async {
    int rating = 0;
    final body = TextEditingController();
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheetCtx) => Padding(
        padding: EdgeInsets.fromLTRB(24, 16, 24, MediaQuery.of(sheetCtx).viewInsets.bottom + 24),
        child: StatefulBuilder(builder: (_, setSheet) {
          return Column(mainAxisSize: MainAxisSize.min, children: [
            const Text('Rate this session', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
            const SizedBox(height: 12),
            Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              for (var i = 1; i <= 5; i++)
                IconButton(
                  icon: Icon(i <= rating ? Icons.star : Icons.star_border, color: Colors.amber, size: 32),
                  onPressed: () => setSheet(() => rating = i),
                ),
            ]),
            TextField(controller: body, decoration: const InputDecoration(hintText: 'Anything to add? (optional)')),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: () async {
                if (rating > 0) { try { await ListingsApi.review(listingId, rating, body.text.trim()); } catch (_) {} }
                if (sheetCtx.mounted) Navigator.pop(sheetCtx);
              },
              child: const Text('Done'),
            ),
          ]);
        }),
      ),
    );
  }

  @override
  void dispose() {
    _tick?.cancel();
    _room?.close();
    try { _sig?.sink.close(); } catch (_) {}
    _pc?.close();
    _sfuPc?.close();
    for (final p in _peers.values) { p.dispose(); }
    _local?.getTracks().forEach((t) => t.stop());
    _local?.dispose();
    _localRenderer.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now().millisecondsSinceEpoch;
    final remaining = (_endsAt - now).clamp(0, 1 << 62);
    final waitLeft = (_startsAt + _kWaitWindowMs - now).clamp(0, _kWaitWindowMs);
    final ready = _peers.values.where((p) => p.ready).toList();

    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(fit: StackFit.expand, children: [
        // remote grid (1 = full bleed; 2-8 grid)
        if (ready.isEmpty)
          Center(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              const CircularProgressIndicator(color: Colors.white54),
              const SizedBox(height: 16),
              Text(
                _waitingRoom
                    ? (_hostRole
                        ? 'Waiting for ${widget.join['peer_name'] ?? 'the buyer'}… ${fmtMmSs(waitLeft)} left of ${fmtMmSs(_kWaitWindowMs)} wait'
                        : 'Waiting for the host to join…')
                    : 'Connecting…',
                style: const TextStyle(color: Colors.white70), textAlign: TextAlign.center,
              ),
              if (_hostRole && _waitingRoom)
                const Padding(
                  padding: EdgeInsets.only(top: 8),
                  child: Text('If they never show up, the no-show rule pays your wait automatically.',
                      style: TextStyle(color: Colors.white38, fontSize: 12)),
                ),
            ]),
          )
        else if (ready.length == 1)
          RTCVideoView(ready.first.renderer, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover)
        else
          GridView.count(
            crossAxisCount: ready.length <= 4 ? 2 : 3,
            children: [
              for (final p in ready)
                Container(
                  margin: const EdgeInsets.all(2),
                  child: RTCVideoView(p.renderer, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover),
                ),
            ],
          ),
        // local preview
        Positioned(
          right: 16, top: 90, width: 100, height: 150,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(12),
            child: RTCVideoView(_localRenderer, mirror: true, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover),
          ),
        ),
        // top bar: title + countdown
        Positioned(
          left: 0, right: 0, top: 0,
          child: SafeArea(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Row(children: [
                Expanded(child: Text(_title, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800))),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                  decoration: BoxDecoration(
                    color: remaining < 5 * 60_000 ? AvaColors.coral : Colors.black45,
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    const Icon(Icons.timer_outlined, color: Colors.white, size: 14),
                    const SizedBox(width: 4),
                    Text(fmtMmSs(remaining), style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800)),
                  ]),
                ),
              ]),
            ),
          ),
        ),
        // Live voice translation — transparent "Translate" menu (both sides;
        // the listener pays: $3/h in AvaCoins, never shared with the creator).
        TranslateOverlay(context: 'consult', refId: widget.bookingId),
        // bottom controls
        Positioned(
          left: 0, right: 0, bottom: 16,
          child: SafeArea(
            top: false,
            child: Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
              _ctl(_micOn ? Icons.mic : Icons.mic_off, _toggleMic),
              _ctl(_camOn ? Icons.videocam : Icons.videocam_off, _toggleCam),
              _ctl(Icons.cameraswitch, _flip),
              _ctl(_speakerOn ? Icons.volume_up : Icons.hearing, _toggleSpeaker),
              _ctl(Icons.attach_file, _sendFile, tooltip: 'Send file (opens your AvaTok thread)'),
              if (_hostRole) _ctl(Icons.more_time, _extend, tooltip: 'Extend +15 min'),
              FloatingActionButton(
                heroTag: 'hangup',
                backgroundColor: AvaColors.coral,
                onPressed: () => _leave(),
                child: const Icon(Icons.call_end, color: Colors.white),
              ),
            ]),
          ),
        ),
      ]),
    );
  }

  Widget _ctl(IconData ic, VoidCallback onTap, {String? tooltip}) => Material(
        color: Colors.white12, shape: const CircleBorder(),
        child: IconButton(icon: Icon(ic, color: Colors.white), onPressed: onTap, tooltip: tooltip),
      );
}

String fmtMmSs(int ms) {
  final s = (ms / 1000).floor();
  return '${(s ~/ 60).toString().padLeft(2, '0')}:${(s % 60).toString().padLeft(2, '0')}';
}

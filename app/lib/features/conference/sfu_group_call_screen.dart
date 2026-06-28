// CF Realtime SFU group-AUDIO room (Specs/CF-REALTIME-SFU-GROUP-AUDIO-BUILD.md).
// Audio-only, ≤32, NO time limit, ACTIVE-SPEAKER pull: each device pulls only the
// few loudest talkers (from the GroupCallRoom DO's `speakers` event) instead of
// all 31, which is what makes 32-person audio cheap. The SFU carries the media;
// this screen does the WebRTC + signalling against routes/groupcall.ts.
//
// Reached from chat_thread._groupCall(audio) ONLY when RemoteConfig
// .groupAudioSfuEnabled is ON (dormant by default; LiveKit/mesh stay the live
// path until then). NOT yet device-tested — flip the flag only after CI + a real
// multi-device pass (see the build spec's regression list).
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:uuid/uuid.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../../core/audio_tuning.dart';
import '../../core/ava_log.dart';
import 'sfu_group_call_api.dart';

class SfuGroupCallScreen extends StatefulWidget {
  final String gid;
  final String title;
  final bool starter;
  const SfuGroupCallScreen({super.key, required this.gid, required this.title, this.starter = false});

  @override
  State<SfuGroupCallScreen> createState() => _SfuGroupCallScreenState();
}

class _RemotePull {
  final String mid;
  _RemotePull(this.mid);
}

class _SfuGroupCallScreenState extends State<SfuGroupCallScreen> {
  final String _myId = const Uuid().v4().substring(0, 12);
  RTCPeerConnection? _pc;
  MediaStream? _stream;
  WebSocketChannel? _ws;
  String? _sessionId;
  String _myTrack = '';

  // roster: peerId -> {session, track}
  final Map<String, Map<String, String?>> _roster = {};
  // peerId -> the pulled track's mid (so we can close it when they go quiet)
  final Map<String, _RemotePull> _pulled = {};
  List<String> _speakers = const [];

  Timer? _levelTimer;
  bool _muted = false;
  bool _speaker = true; // audio call defaults to loudspeaker
  bool _connected = false;
  bool _ended = false;
  String _status = 'Connecting…';

  @override
  void initState() {
    super.initState();
    _connect();
  }

  Future<void> _connect() async {
    try {
      final join = await SfuGroupCallApi.join(widget.gid);
      _sessionId = join.sessionId;

      _pc = await createPeerConnection({
        'iceServers': join.iceServers,
        'sdpSemantics': 'unified-plan',
      });
      _pc!.onConnectionState = (s) {
        if (s == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
          if (mounted) setState(() { _connected = true; _status = 'Connected'; });
        } else if (s == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
            s == RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
          if (!_ended) _leave();
        }
      };
      // Remote audio plays automatically once tracks arrive (mobile default out).
      _pc!.onTrack = (RTCTrackEvent e) {
        AvaLog.I.log('groupcall', 'remote track ${e.track.kind}');
      };

      // Mic with shared AEC/NS/AGC constraints; audio-only (no video — bandwidth).
      _stream = await navigator.mediaDevices.getUserMedia({
        'audio': avaMicConstraints(),
        'video': false,
      });
      for (final t in _stream!.getAudioTracks()) {
        await _pc!.addTrack(t, _stream!);
      }
      try { await Helper.setSpeakerphoneOn(_speaker); } catch (_) {}

      // Publish the mic: tuned offer → SFU answer.
      final offer = await _pc!.createOffer();
      final tuned = RTCSessionDescription(tuneOpusSdp(offer.sdp), offer.type);
      await _pc!.setLocalDescription(tuned);
      final pub = await SfuGroupCallApi.publish(widget.gid, _sessionId!, tuned.sdp ?? '');
      final ans = pub['answer'] as Map<String, dynamic>?;
      if (ans != null) {
        await _pc!.setRemoteDescription(RTCSessionDescription(ans['sdp'].toString(), ans['type'].toString()));
      }
      final tracks = (pub['tracks'] as List?) ?? const [];
      if (tracks.isNotEmpty && tracks.first is Map && tracks.first['trackName'] != null) {
        _myTrack = tracks.first['trackName'].toString();
      }

      _openWs(join);
      _startLevelReporting();
      if (mounted) setState(() => _status = 'Connected');
    } catch (e) {
      AvaLog.I.log('groupcall', 'connect failed: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Could not join the group call')));
        Navigator.of(context).maybePop();
      }
    }
  }

  void _openWs(SfuJoin join) {
    final url = SfuGroupCallApi.wsUrl(widget.gid, _myId, _sessionId!);
    _ws = WebSocketChannel.connect(Uri.parse(url));
    _ws!.stream.listen(_onWs, onError: (_) {}, onDone: () { if (!_ended) _leave(); });
    _send({'t': 'hello', 'session': _sessionId});
    if (_myTrack.isNotEmpty) _send({'t': 'published', 'track': _myTrack});
  }

  void _send(Map<String, dynamic> m) {
    try { _ws?.sink.add(jsonEncode(m)); } catch (_) {}
  }

  Future<void> _onWs(dynamic raw) async {
    if (raw is! String) return;
    Map<String, dynamic> d;
    try { d = jsonDecode(raw) as Map<String, dynamic>; } catch (_) { return; }
    switch (d['t']) {
      case 'welcome':
      case 'roster':
        _applyRoster((d['roster'] as List?) ?? const []);
        break;
      case 'speakers':
        await _applySpeakers(((d['uids'] as List?) ?? const []).map((e) => e.toString()).toList());
        break;
      case 'left':
        final uid = d['uid']?.toString();
        if (uid != null) { _roster.remove(uid); await _closePeer(uid); if (mounted) setState(() {}); }
        break;
      case 'full':
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text(d['reason']?.toString() ?? 'Call is full')));
          _leave();
        }
        break;
    }
  }

  void _applyRoster(List<dynamic> roster) {
    _roster.clear();
    for (final r in roster) {
      if (r is Map && r['uid'] != null) {
        _roster[r['uid'].toString()] = {
          'session': r['session']?.toString(),
          'track': r['track']?.toString(),
        };
      }
    }
    if (mounted) setState(() {});
  }

  /// Pull the active speakers we aren't already pulling; close those that left
  /// the active set. This is the core bandwidth saver — we only ever hold a few
  /// remote audio streams, never all 31.
  Future<void> _applySpeakers(List<String> uids) async {
    _speakers = uids;
    // Close speakers that dropped out.
    final toClose = _pulled.keys.where((u) => !uids.contains(u)).toList();
    for (final u in toClose) await _closePeer(u);
    // Pull newly-active speakers (skip self + already-pulled).
    for (final u in uids) {
      if (u == _myId || _pulled.containsKey(u)) continue;
      final entry = _roster[u];
      final session = entry?['session'];
      final track = entry?['track'];
      if (session == null || track == null || track.isEmpty) continue;
      await _pullPeer(u, session, track);
    }
    if (mounted) setState(() {});
  }

  Future<void> _pullPeer(String uid, String remoteSession, String track) async {
    if (_pc == null || _sessionId == null) return;
    try {
      final res = await SfuGroupCallApi.pull(widget.gid, _sessionId!, remoteSession, track);
      final offer = res['offer'] as Map<String, dynamic>?;
      final tracks = (res['tracks'] as List?) ?? const [];
      if (offer != null && res['renegotiate'] == true) {
        await _pc!.setRemoteDescription(
            RTCSessionDescription(offer['sdp'].toString(), offer['type'].toString()));
        final answer = await _pc!.createAnswer();
        await _pc!.setLocalDescription(answer);
        await SfuGroupCallApi.renegotiate(widget.gid, _sessionId!, answer.sdp ?? '');
      }
      final mid = tracks.isNotEmpty && tracks.first is Map ? tracks.first['mid']?.toString() : null;
      if (mid != null) _pulled[uid] = _RemotePull(mid);
    } catch (e) {
      AvaLog.I.log('groupcall', 'pull $uid failed: $e');
    }
  }

  Future<void> _closePeer(String uid) async {
    final p = _pulled.remove(uid);
    if (p == null || _sessionId == null) return;
    await SfuGroupCallApi.close(widget.gid, _sessionId!, [p.mid]);
  }

  // Report our smoothed mic level ~4×/sec so the DO can pick active speakers.
  void _startLevelReporting() {
    _levelTimer?.cancel();
    _levelTimer = Timer.periodic(const Duration(milliseconds: 250), (_) async {
      if (_pc == null || _muted) { _send({'t': 'level', 'v': 0}); return; }
      try {
        final stats = await _pc!.getStats();
        double level = 0;
        for (final r in stats) {
          final v = r.values['audioLevel'];
          if (v is num && r.type == 'media-source') level = v.toDouble();
        }
        _send({'t': 'level', 'v': level});
      } catch (_) {/* ignore a sampling miss */}
    });
  }

  Future<void> _toggleMute() async {
    _muted = !_muted;
    for (final t in _stream?.getAudioTracks() ?? const <MediaStreamTrack>[]) {
      t.enabled = !_muted;
    }
    if (mounted) setState(() {});
  }

  Future<void> _toggleSpeaker() async {
    _speaker = !_speaker;
    try { await Helper.setSpeakerphoneOn(_speaker); } catch (_) {}
    if (mounted) setState(() {});
  }

  Future<void> _leave() async {
    if (_ended) return;
    _ended = true;
    _levelTimer?.cancel();
    try { _ws?.sink.close(); } catch (_) {}
    try {
      for (final t in _stream?.getTracks() ?? const <MediaStreamTrack>[]) { await t.stop(); }
    } catch (_) {}
    try { await _stream?.dispose(); } catch (_) {}
    try { await _pc?.close(); } catch (_) {}
    if (mounted) Navigator.of(context).maybePop();
  }

  @override
  void dispose() {
    _ended = true;
    _levelTimer?.cancel();
    try { _ws?.sink.close(); } catch (_) {}
    try { _pc?.close(); } catch (_) {}
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final members = _roster.keys.toList();
    return Scaffold(
      backgroundColor: const Color(0xFF0E1116),
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        title: Text(widget.title, style: const TextStyle(color: Colors.white)),
        iconTheme: const IconThemeData(color: Colors.white),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 14),
            child: Center(child: Text('${members.isNotEmpty ? members.length : 1}/32',
                style: const TextStyle(color: Colors.white70))),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Text(_connected ? 'Group audio · active-speaker' : _status,
                style: const TextStyle(color: Colors.white54, fontSize: 13)),
          ),
          Expanded(
            child: members.isEmpty
                ? const Center(child: Text('Waiting for others…', style: TextStyle(color: Colors.white38)))
                : GridView.count(
                    crossAxisCount: 3,
                    padding: const EdgeInsets.all(16),
                    children: [
                      for (final id in members) _avatarTile(id, speaking: _speakers.contains(id)),
                    ],
                  ),
          ),
          Container(
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 28),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
              children: [
                _ctrl(_muted ? Icons.mic_off : Icons.mic, _muted ? 'Unmute' : 'Mute',
                    _toggleMute, active: !_muted),
                _ctrl(Icons.call_end, 'Leave', _leave, danger: true),
                _ctrl(_speaker ? Icons.volume_up : Icons.hearing, 'Speaker',
                    _toggleSpeaker, active: _speaker),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _avatarTile(String id, {required bool speaking}) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 64, height: 64,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: const Color(0xFF1B2330),
            border: Border.all(color: speaking ? const Color(0xFF08C4C4) : Colors.transparent, width: 3),
          ),
          child: const Icon(Icons.person, color: Colors.white54, size: 30),
        ),
        const SizedBox(height: 6),
        Text(id == _myId ? 'You' : id, overflow: TextOverflow.ellipsis,
            style: const TextStyle(color: Colors.white60, fontSize: 11)),
      ],
    );
  }

  Widget _ctrl(IconData icon, String label, VoidCallback onTap, {bool active = false, bool danger = false}) {
    final bg = danger ? Colors.redAccent : (active ? const Color(0xFF08C4C4) : const Color(0xFF1B2330));
    return GestureDetector(
      onTap: onTap,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Container(
          width: 58, height: 58,
          decoration: BoxDecoration(color: bg, shape: BoxShape.circle),
          child: Icon(icon, color: Colors.white, size: 26),
        ),
        const SizedBox(height: 6),
        Text(label, style: const TextStyle(color: Colors.white54, fontSize: 12)),
      ]),
    );
  }
}

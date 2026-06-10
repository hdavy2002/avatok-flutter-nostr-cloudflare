// Phase 7 — AvaLive CREATOR broadcast HUD. Go-live publishes via WHIP from the
// phone (shared flutter_webrtc). HUD: watching-now, elapsed + time remaining,
// earnings-so-far chip (ticket revenue + live donations ticking up),
// donation/reaction feed, pinned-message + slow-mode controls, long-press chat
// → Mute / Ban / Report (A1), publish-health indicator + auto-reconnect loop
// (A4), end-stream → settlement-pending.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;
import 'package:permission_handler/permission_handler.dart';

import '../../core/analytics.dart';
import '../../core/session_api.dart';
import '../../core/theme.dart';
import 'live_room_widgets.dart';

class LiveHostScreen extends StatefulWidget {
  final String listingId;
  final String title;
  const LiveHostScreen({super.key, required this.listingId, this.title = 'AvaLive'});
  @override
  State<LiveHostScreen> createState() => _LiveHostScreenState();
}

class _LiveHostScreenState extends State<LiveHostScreen> {
  final _renderer = RTCVideoRenderer();
  RTCPeerConnection? _pc;
  MediaStream? _stream;
  RoomChannel? _room;
  Timer? _tick;
  Timer? _statsTimer;
  String? _whip;

  String _status = 'preparing…';
  bool _live = false;
  bool _ended = false;
  bool _reconnecting = false;
  int _reconnectIn = 0;
  int _startsAt = 0, _endsAt = 0, _wentLiveAt = 0;
  int _watching = 0;
  int _ticketGross = 0, _joined = 0;
  int _donationsTotal = 0;
  int _bitrateKbps = 0;
  int _lastBytes = 0;
  int _slowSec = 0;
  String? _pinned;

  final List<ChatLine> _feed = [];
  final List<({String uid, String name})> _feedMeta = [];

  @override
  void initState() {
    super.initState();
    _renderer.initialize();
    _start();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) { if (mounted) setState(() {}); });
  }

  Future<void> _start() async {
    try {
      final s = await [Permission.camera, Permission.microphone].request();
      if (!s.values.every((x) => x.isGranted)) throw 'Camera & mic permission required';
      final j = await SessionApi.liveStart(widget.listingId);
      _whip = j['whip']?.toString();
      _startsAt = (j['starts_at'] as num?)?.toInt() ?? 0;
      _endsAt = (j['ends_at'] as num?)?.toInt() ?? 0;
      if (_whip == null) throw 'No WHIP URL (Stream not ready)';
      _openRoom(j['room_token'].toString());
      await _publish();
      Analytics.capture('live_host_started', {'listing_id': widget.listingId});
      _refreshEarnings();
    } on SessionApiError catch (e) {
      setState(() => _status = e.status == 503 ? 'Streaming is not configured yet (server creds missing).' : 'error: ${e.message}');
    } catch (e) {
      setState(() => _status = 'error: $e');
    }
  }

  Future<void> _publish() async {
    await _pc?.close();
    setState(() => _status = 'connecting…');
    _stream ??= await navigator.mediaDevices.getUserMedia({'audio': true, 'video': {'facingMode': 'user'}});
    _renderer.srcObject = _stream;
    final pc = await createPeerConnection({
      'iceServers': [{'urls': 'stun:stun.cloudflare.com:3478'}],
    });
    _pc = pc;
    for (final t in _stream!.getTracks()) {
      await pc.addTrack(t, _stream!);
    }
    pc.onConnectionState = (st) {
      final s = st.toString().split('.').last;
      if (!mounted) return;
      if (s == 'RTCPeerConnectionStateConnected') {
        setState(() { _live = true; _reconnecting = false; _status = 'LIVE'; _wentLiveAt = _wentLiveAt == 0 ? DateTime.now().millisecondsSinceEpoch : _wentLiveAt; });
      } else if (s == 'RTCPeerConnectionStateFailed' || s == 'RTCPeerConnectionStateDisconnected') {
        _autoReconnect();
      }
    };
    final offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    final res = await http.post(Uri.parse(_whip!), headers: {'Content-Type': 'application/sdp'}, body: offer.sdp);
    if (res.statusCode >= 300) throw 'WHIP ${res.statusCode}';
    await pc.setRemoteDescription(RTCSessionDescription(res.body, 'answer'));
    _statsTimer?.cancel();
    _statsTimer = Timer.periodic(const Duration(seconds: 2), (_) => _sampleStats());
  }

  /// Publisher drop → on-screen countdown + reconnect loop (A4).
  void _autoReconnect() {
    if (_ended || _reconnecting) return;
    setState(() { _reconnecting = true; _live = false; _reconnectIn = 3; _status = 'reconnecting…'; });
    Timer.periodic(const Duration(seconds: 1), (t) async {
      if (!mounted || _ended || !_reconnecting) { t.cancel(); return; }
      if (_reconnectIn > 1) { setState(() => _reconnectIn--); return; }
      t.cancel();
      try { await _publish(); } catch (_) { _autoReconnect(); }
    });
  }

  Future<void> _sampleStats() async {
    try {
      final stats = await _pc?.getStats();
      if (stats == null) return;
      for (final r in stats) {
        if (r.type == 'outbound-rtp' && (r.values['kind'] == 'video' || r.values['mediaType'] == 'video')) {
          final bytes = (r.values['bytesSent'] as num?)?.toInt() ?? 0;
          if (_lastBytes > 0) _bitrateKbps = ((bytes - _lastBytes) * 8 / 2000).round();
          _lastBytes = bytes;
        }
      }
      if (mounted) setState(() {});
    } catch (_) {/* stats are advisory */}
  }

  Future<void> _refreshEarnings() async {
    try {
      final s = await SessionApi.liveState(widget.listingId);
      if (!mounted) return;
      setState(() {
        _donationsTotal = (s['donations_total'] as num?)?.toInt() ?? _donationsTotal;
        final o = s['orders'] as Map<String, dynamic>?;
        if (o != null) { _joined = (o['joined'] as num?)?.toInt() ?? _joined; _ticketGross = (o['gross'] as num?)?.toInt() ?? _ticketGross; }
      });
    } catch (_) {}
  }

  void _openRoom(String token) {
    _room = RoomChannel(SessionApi.liveRoomWs(widget.listingId, token), (e) {
      if (!mounted) return;
      switch (e['type']) {
        case 'viewers':
          setState(() => _watching = (e['n'] as num?)?.toInt() ?? _watching);
        case 'welcome':
          setState(() {
            _watching = (e['watching'] as num?)?.toInt() ?? _watching;
            _donationsTotal = (e['donations_total'] as num?)?.toInt() ?? _donationsTotal;
            _slowSec = (e['slow_mode_sec'] as num?)?.toInt() ?? 0;
            _pinned = e['pinned']?.toString();
          });
        case 'chat':
        case 'fly':
          setState(() {
            _feed.add(ChatLine(e['from']?.toString() ?? '?', e['text']?.toString() ?? ''));
            _feedMeta.add((uid: e['uid']?.toString() ?? '', name: e['from']?.toString() ?? '?'));
            if (_feed.length > 80) { _feed.removeAt(0); _feedMeta.removeAt(0); }
          });
        case 'reaction':
          setState(() { _feed.add(ChatLine(e['from']?.toString() ?? '?', e['emoji']?.toString() ?? '❤️')); _feedMeta.add((uid: '', name: '')); });
        case 'donation':
          setState(() {
            _donationsTotal += (e['amount'] as num?)?.toInt() ?? 0;
            _feed.add(ChatLine('💰 ${e['name']}', 'donated \$${(((e['amount'] as num?)?.toInt() ?? 0) / 100).toStringAsFixed(2)}'));
            _feedMeta.add((uid: '', name: ''));
          });
          _refreshEarnings();
      }
    });
  }

  // ---- moderation (A1) ------------------------------------------------------

  void _modSheet(String uid, String name) {
    if (uid.isEmpty) return;
    showModalBottomSheet<void>(
      context: context,
      builder: (sheetCtx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(title: Text(name, style: const TextStyle(fontWeight: FontWeight.w800))),
          ListTile(
            leading: const Icon(Icons.volume_off), title: const Text('Mute'),
            subtitle: const Text('No more messages — can keep watching'),
            onTap: () { Navigator.pop(sheetCtx); SessionApi.mod(widget.listingId, 'mute', target: uid); },
          ),
          ListTile(
            leading: const Icon(Icons.block, color: Colors.red), title: const Text('Ban'),
            subtitle: const Text('Kicked — join token revoked, no re-entry'),
            onTap: () { Navigator.pop(sheetCtx); SessionApi.mod(widget.listingId, 'ban', target: uid); },
          ),
          ListTile(
            leading: const Icon(Icons.flag), title: const Text('Report'),
            onTap: () { Navigator.pop(sheetCtx); SessionApi.mod(widget.listingId, 'ban', target: uid); },
          ),
        ]),
      ),
    );
  }

  Future<void> _pinDialog() async {
    final ctl = TextEditingController(text: _pinned ?? '');
    final t = await showDialog<String>(
      context: context,
      builder: (dCtx) => AlertDialog(
        title: const Text('Pin a message'),
        content: TextField(controller: ctl, maxLength: 200),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dCtx, ''), child: const Text('Unpin')),
          FilledButton(onPressed: () => Navigator.pop(dCtx, ctl.text.trim()), child: const Text('Pin')),
        ],
      ),
    );
    if (t == null) return;
    setState(() => _pinned = t.isEmpty ? null : t);
    await SessionApi.mod(widget.listingId, 'pin', text: t);
  }

  Future<void> _end() async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (dCtx) => AlertDialog(
        title: const Text('End stream?'),
        content: const Text('The event moves to settlement — your 80% lands in the wallet after the rules pass.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dCtx, false), child: const Text('Keep going')),
          FilledButton(onPressed: () => Navigator.pop(dCtx, true), child: const Text('End stream')),
        ],
      ),
    );
    if (sure != true) return;
    _ended = true;
    try { await SessionApi.liveStop(widget.listingId); } catch (_) {}
    Analytics.capture('live_host_ended', {'listing_id': widget.listingId});
    if (mounted) setState(() { _live = false; _status = 'settlement pending'; });
  }

  @override
  void dispose() {
    _tick?.cancel();
    _statsTimer?.cancel();
    _room?.close();
    _pc?.close();
    _stream?.getTracks().forEach((t) => t.stop());
    _stream?.dispose();
    _renderer.dispose();
    super.dispose();
  }

  Color get _healthColor => !_live ? Colors.red : (_bitrateKbps > 800 ? Colors.green : (_bitrateKbps > 250 ? Colors.amber : Colors.red));

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now().millisecondsSinceEpoch;
    final elapsed = _wentLiveAt > 0 ? now - _wentLiveAt : 0;
    final remaining = _endsAt > 0 ? (_endsAt - now).clamp(0, 1 << 62) : 0;
    final earnings = (_ticketGross * 0.8).round() + (_donationsTotal * 0.8).round();
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(fit: StackFit.expand, children: [
        RTCVideoView(_renderer, mirror: true, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover),
        if (_reconnecting)
          Container(
            color: Colors.black54, alignment: Alignment.center,
            child: Text('Reconnecting in $_reconnectIn…', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800)),
          ),
        // feed (doubles as moderation surface — long-press a line)
        Positioned(
          left: 12, right: 12, bottom: 76, height: 170,
          child: ChatOverlay(lines: _feed, meta: _feedMeta, onLongPress: _modSheet),
        ),
        // top HUD
        Positioned(
          left: 0, right: 0, top: 0,
          child: SafeArea(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Column(children: [
                Row(children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(color: _live ? AvaColors.coral : Colors.grey, borderRadius: BorderRadius.circular(6)),
                    child: Text(_live ? 'LIVE' : _status.toUpperCase(), style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 11)),
                  ),
                  const SizedBox(width: 8),
                  _pill(Icons.visibility, '$_watching watching · $_joined joined'),
                  const Spacer(),
                  Icon(Icons.circle, size: 10, color: _healthColor),
                  const SizedBox(width: 4),
                  Text('$_bitrateKbps kbps', style: const TextStyle(color: Colors.white70, fontSize: 11)),
                ]),
                const SizedBox(height: 6),
                Row(children: [
                  _pill(Icons.timer, '${fmtClock(elapsed)} · ${fmtClock(remaining)} left'),
                  const SizedBox(width: 8),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    decoration: BoxDecoration(color: AvaColors.brand, borderRadius: BorderRadius.circular(12)),
                    child: Text('~\$${(earnings / 100).toStringAsFixed(2)} so far',
                        style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w800)),
                  ),
                ]),
              ]),
            ),
          ),
        ),
        // bottom toolbar
        Positioned(
          left: 12, right: 12, bottom: 12,
          child: SafeArea(
            top: false,
            child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
              IconButton(
                icon: const Icon(Icons.cameraswitch, color: Colors.white),
                onPressed: () {
                  final v = _stream?.getVideoTracks();
                  if (v != null && v.isNotEmpty) Helper.switchCamera(v.first);
                },
              ),
              IconButton(icon: const Icon(Icons.push_pin, color: Colors.white), tooltip: 'Pin message', onPressed: _pinDialog),
              PopupMenuButton<int>(
                icon: Icon(Icons.speed, color: _slowSec > 0 ? Colors.amber : Colors.white),
                tooltip: 'Slow mode',
                onSelected: (s) { setState(() => _slowSec = s); SessionApi.mod(widget.listingId, 'slow', sec: s); },
                itemBuilder: (_) => const [
                  PopupMenuItem(value: 0, child: Text('Slow mode off')),
                  PopupMenuItem(value: 5, child: Text('1 msg / 5 s')),
                  PopupMenuItem(value: 30, child: Text('1 msg / 30 s')),
                ],
              ),
              FilledButton.icon(
                style: FilledButton.styleFrom(backgroundColor: AvaColors.coral),
                icon: const Icon(Icons.stop_circle),
                label: Text(_ended ? 'Ended' : 'End stream'),
                onPressed: _ended ? null : _end,
              ),
            ]),
          ),
        ),
      ]),
    );
  }

  Widget _pill(IconData ic, String t) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        decoration: BoxDecoration(color: Colors.black38, borderRadius: BorderRadius.circular(12)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(ic, color: Colors.white, size: 13),
          const SizedBox(width: 4),
          Text(t, style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w700)),
        ]),
      );
}

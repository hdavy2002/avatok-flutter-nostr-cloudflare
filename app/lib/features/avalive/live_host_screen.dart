// Phase 7 — AvaLive CREATOR broadcast HUD. Go-live publishes via WHIP from the
// phone (shared flutter_webrtc). HUD: watching-now, elapsed + time remaining,
// earnings-so-far chip (ticket revenue + live donations ticking up),
// donation/reaction feed, pinned-message + slow-mode controls, long-press chat
// → Mute / Ban / Report (A1), publish-health indicator + auto-reconnect loop
// (A4), end-stream → settlement-pending.
//
// Zine: pre-live setup + ended/settlement states are full paper screens; the
// live HUD chrome is flat ink-alpha bands + bordered circle buttons over the
// video (the video itself is content and stays full-bleed).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;
import 'package:permission_handler/permission_handler.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/session_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
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
  bool _ready = false;       // pre-live setup done, waiting on "Go live"
  bool _started = false;     // host tapped "Go live"
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
    _prepare();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) { if (mounted) setState(() {}); });
  }

  /// Pre-live setup: permissions, session creation, room socket, camera
  /// preview. Publishing waits for the explicit "Go live" tap.
  Future<void> _prepare() async {
    try {
      final s = await [Permission.camera, Permission.microphone].request();
      if (!s.values.every((x) => x.isGranted)) throw 'Camera & mic permission required';
      final j = await SessionApi.liveStart(widget.listingId);
      _whip = j['whip']?.toString();
      _startsAt = (j['starts_at'] as num?)?.toInt() ?? 0;
      _endsAt = (j['ends_at'] as num?)?.toInt() ?? 0;
      if (_whip == null) throw 'No WHIP URL (Stream not ready)';
      _openRoom(j['room_token'].toString());
      _stream ??= await navigator.mediaDevices.getUserMedia({'audio': true, 'video': {'facingMode': 'user'}});
      _renderer.srcObject = _stream;
      if (mounted) setState(() { _ready = true; _status = 'ready'; });
    } on SessionApiError catch (e) {
      setState(() => _status = e.status == 503 ? 'Streaming is not configured yet (server creds missing).' : 'error: ${e.message}');
    } catch (e) {
      setState(() => _status = 'error: $e');
    }
  }

  Future<void> _goLive() async {
    setState(() => _started = true);
    try {
      await _publish();
      Analytics.capture('live_host_started', {'listing_id': widget.listingId});
      _refreshEarnings();
    } catch (e) {
      if (mounted) setState(() { _started = false; _status = 'error: $e'; });
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
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Zine.r))),
      builder: (sheetCtx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(title: Text(name, style: ZineText.cardTitle(size: 17))),
          ListTile(
            leading: PhosphorIcon(PhosphorIcons.bellSlash(PhosphorIconsStyle.bold), color: Zine.ink),
            title: Text('Mute', style: ZineText.value(size: 15)),
            subtitle: Text('No more messages — can keep watching', style: ZineText.sub(size: 13)),
            onTap: () { Navigator.pop(sheetCtx); SessionApi.mod(widget.listingId, 'mute', target: uid); },
          ),
          ListTile(
            leading: PhosphorIcon(PhosphorIcons.prohibit(PhosphorIconsStyle.bold), color: Zine.coral),
            title: Text('Ban', style: ZineText.value(size: 15, color: Zine.coral)),
            subtitle: Text('Kicked — join token revoked, no re-entry', style: ZineText.sub(size: 13)),
            onTap: () { Navigator.pop(sheetCtx); SessionApi.mod(widget.listingId, 'ban', target: uid); },
          ),
          ListTile(
            leading: PhosphorIcon(PhosphorIcons.flag(PhosphorIconsStyle.bold), color: Zine.ink),
            title: Text('Report', style: ZineText.value(size: 15)),
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
        backgroundColor: Zine.paper,
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Zine.r),
            side: const BorderSide(color: Zine.ink, width: Zine.bw)),
        title: Text('Pin a message', style: ZineText.cardTitle()),
        content: ZineField(controller: ctl, maxLength: 200, hint: 'Say it loud…'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dCtx, ''),
              child: Text('UNPIN', style: ZineText.tag(size: 12, color: Zine.inkSoft))),
          ZineButton(label: 'Pin', fontSize: 16, onPressed: () => Navigator.pop(dCtx, ctl.text.trim())),
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
        backgroundColor: Zine.paper,
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Zine.r),
            side: const BorderSide(color: Zine.ink, width: Zine.bw)),
        title: Text('End stream?', style: ZineText.cardTitle()),
        content: Text('The event moves to settlement — your 80% lands in the wallet after the rules pass.',
            style: ZineText.sub(size: 14.5)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dCtx, false),
              child: Text('KEEP GOING', style: ZineText.tag(size: 12, color: Zine.inkSoft))),
          ZineButton(label: 'End stream', fontSize: 16, variant: ZineButtonVariant.coral,
              onPressed: () => Navigator.pop(dCtx, true)),
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

  Color get _healthColor => !_live ? Zine.coral : (_bitrateKbps > 800 ? Zine.lime : (_bitrateKbps > 250 ? Zine.blue : Zine.coral));

  @override
  Widget build(BuildContext context) {
    if (_ended) return _settlementScreen();
    if (!_started) return _preLiveScreen();

    final now = DateTime.now().millisecondsSinceEpoch;
    final elapsed = _wentLiveAt > 0 ? now - _wentLiveAt : 0;
    final remaining = _endsAt > 0 ? (_endsAt - now).clamp(0, 1 << 62) : 0;
    final earnings = (_ticketGross * 0.8).round() + (_donationsTotal * 0.8).round();
    return Scaffold(
      backgroundColor: Zine.ink,
      body: Stack(fit: StackFit.expand, children: [
        RTCVideoView(_renderer, mirror: true, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover),
        if (_reconnecting)
          Container(
            color: kInkScrimHeavy, alignment: Alignment.center,
            child: Text('Reconnecting in $_reconnectIn…', style: ZineText.value(size: 15, color: Colors.white)),
          ),
        // feed (doubles as moderation surface — long-press a line)
        Positioned(
          left: 12, right: 12, bottom: 86, height: 170,
          child: ChatOverlay(lines: _feed, meta: _feedMeta, onLongPress: _modSheet),
        ),
        // top HUD — one flat ink-alpha band
        Positioned(
          left: 0, right: 0, top: 0,
          child: Container(
            color: kInkScrim,
            child: SafeArea(
              bottom: false,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                child: Column(children: [
                  Row(children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                      decoration: BoxDecoration(
                        color: _live ? Zine.coral : Zine.paper2,
                        borderRadius: BorderRadius.circular(100),
                        border: Border.all(color: Zine.ink, width: 2),
                      ),
                      child: Text(_live ? 'LIVE' : _status.toUpperCase(),
                          style: ZineText.tag(size: 11, color: _live ? Colors.white : Zine.ink)),
                    ),
                    const SizedBox(width: 8),
                    Flexible(child: LiveInkPill('$_watching watching · $_joined joined', icon: PhosphorIcons.eye(PhosphorIconsStyle.bold))),
                    const Spacer(),
                    Container(
                      width: 10, height: 10,
                      decoration: BoxDecoration(shape: BoxShape.circle, color: _healthColor),
                    ),
                    const SizedBox(width: 4),
                    Text('$_bitrateKbps KBPS', style: ZineText.tag(size: 10.5, color: Colors.white)),
                  ]),
                  const SizedBox(height: 6),
                  Row(children: [
                    LiveInkPill('${fmtClock(elapsed)} · ${fmtClock(remaining)} left', icon: PhosphorIcons.timer(PhosphorIconsStyle.bold)),
                    const SizedBox(width: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      decoration: BoxDecoration(
                        color: Zine.mint,
                        borderRadius: BorderRadius.circular(100),
                        border: Border.all(color: Zine.ink, width: 2),
                      ),
                      child: Text('~\$${(earnings / 100).toStringAsFixed(2)} SO FAR',
                          style: ZineText.tag(size: 11, color: Zine.ink)),
                    ),
                  ]),
                ]),
              ),
            ),
          ),
        ),
        // bottom toolbar — bordered circle buttons (end = coral)
        Positioned(
          left: 12, right: 12, bottom: 12,
          child: SafeArea(
            top: false,
            child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
              LiveCircleButton(
                icon: PhosphorIcons.cameraRotate(PhosphorIconsStyle.bold),
                tooltip: 'Flip camera',
                onTap: () {
                  final v = _stream?.getVideoTracks();
                  if (v != null && v.isNotEmpty) Helper.switchCamera(v.first);
                },
              ),
              LiveCircleButton(
                icon: PhosphorIcons.pushPin(PhosphorIconsStyle.bold),
                tooltip: 'Pin message',
                onTap: _pinDialog,
              ),
              PopupMenuButton<int>(
                tooltip: 'Slow mode',
                color: Zine.paper,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(Zine.rSm),
                    side: const BorderSide(color: Zine.ink, width: 2)),
                onSelected: (s) { setState(() => _slowSec = s); SessionApi.mod(widget.listingId, 'slow', sec: s); },
                itemBuilder: (_) => [
                  PopupMenuItem(value: 0, child: Text('Slow mode off', style: ZineText.value(size: 14))),
                  PopupMenuItem(value: 5, child: Text('1 msg / 5 s', style: ZineText.value(size: 14))),
                  PopupMenuItem(value: 30, child: Text('1 msg / 30 s', style: ZineText.value(size: 14))),
                ],
                child: Container(
                  width: 46, height: 46,
                  decoration: BoxDecoration(
                    color: _slowSec > 0 ? Zine.lime : Zine.card,
                    shape: BoxShape.circle,
                    border: Border.all(color: Zine.ink, width: Zine.bw),
                    boxShadow: Zine.shadowXs,
                  ),
                  child: PhosphorIcon(PhosphorIcons.timer(PhosphorIconsStyle.bold), size: 21, color: Zine.ink),
                ),
              ),
              LiveCircleButton(
                icon: PhosphorIcons.stopCircle(PhosphorIconsStyle.fill),
                fill: Zine.coral,
                size: 54,
                tooltip: 'End stream',
                onTap: _end,
              ),
            ]),
          ),
        ),
      ]),
    );
  }

  /// Pre-live setup — full zine paper screen with the camera preview in an
  /// ink-bordered tile and the lime "Go live" action.
  Widget _preLiveScreen() {
    final isError = _status.startsWith('error') || _status.startsWith('Streaming');
    return Scaffold(
      backgroundColor: Zine.paper,
      body: ZinePaper(
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Row(children: [
                ZineBackButton(onTap: () => Navigator.of(context).maybePop()),
                const SizedBox(width: 14),
                Expanded(child: ZineMarkTitle(pre: 'Go ', mark: 'live', fontSize: 30, textAlign: TextAlign.left)),
                const ZineSticker('AVALIVE', kind: ZineStickerKind.hint),
              ]),
              const SizedBox(height: 6),
              Text(widget.title, style: ZineText.sub(), maxLines: 1, overflow: TextOverflow.ellipsis),
              const SizedBox(height: 14),
              Expanded(
                child: Container(
                  clipBehavior: Clip.antiAlias,
                  decoration: BoxDecoration(
                    color: Zine.paper2,
                    borderRadius: BorderRadius.circular(Zine.r),
                    border: Zine.border,
                    boxShadow: Zine.shadowSm,
                  ),
                  child: _ready
                      ? RTCVideoView(_renderer, mirror: true, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover)
                      : Center(
                          child: isError
                              ? Padding(
                                  padding: const EdgeInsets.all(20),
                                  child: ZineEmptyState(
                                      icon: PhosphorIcons.warning(PhosphorIconsStyle.bold), text: _status),
                                )
                              : const CircularProgressIndicator(color: Zine.blueInk),
                        ),
                ),
              ),
              const SizedBox(height: 14),
              Center(child: ZineSticker(_status, kind: isError ? ZineStickerKind.no : ZineStickerKind.hint)),
              const SizedBox(height: 14),
              ZineButton(
                label: "Go live",
                fullWidth: true,
                fontSize: 21,
                icon: PhosphorIcons.broadcast(PhosphorIconsStyle.bold),
                onPressed: _ready ? _goLive : null,
              ),
              const SizedBox(height: 10),
              Center(child: Text('YOUR 80% · STRAIGHT TO YOUR WALLET', style: ZineText.kicker(size: 10.5))),
            ]),
          ),
        ),
      ),
    );
  }

  /// Ended — settlement pending, full zine paper screen.
  Widget _settlementScreen() {
    return Scaffold(
      backgroundColor: Zine.paper,
      body: ZineSuccessOverlay(
        icon: Icons.check_rounded,
        headline: "That's a wrap",
        accentLine: 'SETTLEMENT PENDING',
        sub: 'Your 80% lands in the wallet after the rules pass.',
        ctaLabel: 'Back to AvaLive',
        onCta: () => Navigator.of(context).maybePop(),
      ),
    );
  }
}

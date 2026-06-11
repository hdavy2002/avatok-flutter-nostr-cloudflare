// Phase 7 — AvaLive VIEWER. Full-bleed player (WHEP over the shared
// flutter_webrtc — no second engine), overlay: scrolling chat, flying messages,
// tap-burst reactions, sticker sends, Donate. Top bar: creator chip, LIVE
// badge, viewer count, time remaining. Join requires a paid order (the worker
// refuses non-payers); leave/rejoin within the entitlement always works.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/money_api.dart';
import '../../core/session_api.dart';
import '../../core/theme.dart';
import '../explore/creator_channel.dart';
import '../translation/translate_overlay.dart';
import 'live_room_widgets.dart';

class LiveViewerScreen extends StatefulWidget {
  final String listingId;
  const LiveViewerScreen({super.key, required this.listingId});
  @override
  State<LiveViewerScreen> createState() => _LiveViewerScreenState();
}

class _LiveViewerScreenState extends State<LiveViewerScreen> {
  final _renderer = RTCVideoRenderer();
  RTCPeerConnection? _pc;
  RoomChannel? _room;
  Timer? _tick;
  final _chatCtl = TextEditingController();

  String _status = 'joining…';
  String? _error;
  String _title = '';
  String? _creatorId;
  bool _live = false;
  bool _hostLive = true;
  int _watching = 0;
  int _endsAt = 0;
  String? _pinned;

  final List<ChatLine> _chat = [];
  final List<({String uid, String name})> _chatMeta = [];
  final List<FlyMsg> _fly = [];
  final List<ReactionBurst> _bursts = [];
  DonationBanner? _banner;
  Timer? _bannerTimer;

  @override
  void initState() {
    super.initState();
    _renderer.initialize();
    _join();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      _fly.removeWhere((m) => DateTime.now().millisecondsSinceEpoch - m.bornAt > 7500);
      _bursts.removeWhere((b) => DateTime.now().millisecondsSinceEpoch - b.bornAt > 2000);
      setState(() {});
    });
  }

  Future<void> _join() async {
    try {
      final j = await SessionApi.liveJoin(widget.listingId);
      if (!mounted) return;
      setState(() {
        _title = j['title']?.toString() ?? 'Live';
        _creatorId = j['creator_id']?.toString();
        _live = j['live'] == true;
        _endsAt = (j['ends_at'] as num?)?.toInt() ?? 0;
        _status = _live ? 'connecting…' : 'waiting for the creator…';
      });
      Analytics.capture('live_viewer_joined', {'listing_id': widget.listingId});
      _openRoom(j['room_token'].toString());
      final whep = j['whep']?.toString();
      if (whep != null && _live) await _play(whep);
    } on SessionApiError catch (e) {
      setState(() => _error = e.status == 403 ? 'This is a paid event — book it from the event page first.' : e.message);
    } catch (e) {
      setState(() => _error = '$e');
    }
  }

  Future<void> _play(String whep) async {
    await _pc?.close();
    final pc = await createPeerConnection({
      'iceServers': [{'urls': 'stun:stun.cloudflare.com:3478'}],
    });
    _pc = pc;
    pc.onTrack = (e) {
      if (e.streams.isNotEmpty) {
        _renderer.srcObject = e.streams[0];
        if (mounted) setState(() => _status = 'watching');
      }
    };
    await pc.addTransceiver(kind: RTCRtpMediaType.RTCRtpMediaTypeAudio, init: RTCRtpTransceiverInit(direction: TransceiverDirection.RecvOnly));
    await pc.addTransceiver(kind: RTCRtpMediaType.RTCRtpMediaTypeVideo, init: RTCRtpTransceiverInit(direction: TransceiverDirection.RecvOnly));
    final offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    final res = await http.post(Uri.parse(whep), headers: {'Content-Type': 'application/sdp'}, body: offer.sdp);
    if (res.statusCode >= 300) throw 'WHEP ${res.statusCode}';
    await pc.setRemoteDescription(RTCSessionDescription(res.body, 'answer'));
  }

  void _openRoom(String token) {
    _room = RoomChannel(SessionApi.liveRoomWs(widget.listingId, token), (e) {
      if (!mounted) return;
      switch (e['type']) {
        case 'welcome':
          setState(() {
            _watching = (e['watching'] as num?)?.toInt() ?? _watching;
            _pinned = e['pinned']?.toString();
            _hostLive = e['host_live'] != false;
            _endsAt = (e['ends_at'] as num?)?.toInt() ?? _endsAt;
          });
        case 'viewers':
          setState(() => _watching = (e['n'] as num?)?.toInt() ?? _watching);
        case 'chat':
          setState(() {
            _chat.add(ChatLine(e['from']?.toString() ?? '?', e['text']?.toString() ?? ''));
            _chatMeta.add((uid: e['uid']?.toString() ?? '', name: e['from']?.toString() ?? '?'));
            if (_chat.length > 80) { _chat.removeAt(0); _chatMeta.removeAt(0); }
          });
        case 'fly':
          setState(() => _fly.add(FlyMsg('${e['from']}: ${e['text']}')));
        case 'reaction':
          setState(() => _bursts.add(ReactionBurst(e['emoji']?.toString() ?? '❤️')));
        case 'sticker':
          setState(() => _bursts.add(ReactionBurst(e['id']?.toString() ?? '🔥')));
        case 'donation':
          setState(() => _banner = DonationBanner(e['name']?.toString() ?? '?', (e['amount'] as num?)?.toInt() ?? 0));
          _bannerTimer?.cancel();
          _bannerTimer = Timer(const Duration(seconds: 5), () { if (mounted) setState(() => _banner = null); });
        case 'pinned':
          setState(() => _pinned = e['text']?.toString());
        case 'host_reconnecting':
          setState(() => _hostLive = false);
        case 'host_connected':
          setState(() => _hostLive = true);
          // Player auto-resume: renegotiate WHEP if the track died.
          if (_status != 'watching') _join();
        case 'session_ended':
          setState(() { _live = false; _status = 'stream ended'; });
        case 'warn':
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e['reason']?.toString() ?? 'blocked')));
        case 'mod':
          if (e['action'] == 'ban') setState(() {});
      }
    });
  }

  // ---- actions --------------------------------------------------------------

  void _sendChat() {
    final t = _chatCtl.text.trim();
    if (t.isEmpty) return;
    _room?.send({'type': 'chat', 'text': t});
    _chatCtl.clear();
  }

  Future<void> _donateSheet() async {
    final bal = ((await MoneyApi.balance())['balance'] as num?)?.toInt() ?? 0;
    if (!mounted) return;
    final amounts = [100, 200, 500, 1000, 2000, 5000];
    await showModalBottomSheet<void>(
      context: context,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (sheetCtx) => Padding(
        padding: const EdgeInsets.all(24),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Send a donation 💰', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
          const SizedBox(height: 4),
          Text('Balance: \$${(bal / 100).toStringAsFixed(2)} · goes to the creator instantly',
              style: TextStyle(color: Colors.grey[600], fontSize: 12)),
          const SizedBox(height: 16),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final a in amounts)
              ActionChip(
                label: Text('\$${(a / 100).toStringAsFixed(a % 100 == 0 ? 0 : 2)}'),
                onPressed: () { Navigator.pop(sheetCtx); _donate(a); },
              ),
          ]),
          const SizedBox(height: 8),
        ]),
      ),
    );
  }

  Future<void> _donate(int amount) async {
    try {
      await SessionApi.donate(widget.listingId, amount);
      Analytics.capture('live_donation_sent', {'amount': amount});
    } on SessionApiError catch (e) {
      if (!mounted) return;
      if (e.status == 402) {
        // Insufficient balance → inline top-up (Phase 2 sheet behavior).
        final t = await MoneyApi.topup((amount - ((e.body['balance'] as num?)?.toInt() ?? 0)).clamp(50, 50000));
        final url = t['checkout_url']?.toString();
        if (url != null && url.isNotEmpty) { await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication); }
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Top up your wallet, then donate again.')));
      } else {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  @override
  void dispose() {
    _tick?.cancel();
    _bannerTimer?.cancel();
    _room?.close();
    _pc?.close();
    _renderer.dispose();
    _chatCtl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return Scaffold(
        appBar: AppBar(title: const Text('AvaLive')),
        body: Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!, textAlign: TextAlign.center))),
      );
    }
    final remaining = _endsAt > 0 ? _endsAt - DateTime.now().millisecondsSinceEpoch : null;
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(fit: StackFit.expand, children: [
        RTCVideoView(_renderer, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover),
        if (_status != 'watching')
          Center(child: Text(_status, style: const TextStyle(color: Colors.white70))),
        if (!_hostLive) const ReconnectingOverlay(),
        FlyLayer(msgs: _fly),
        ReactionLayer(bursts: _bursts),
        // Live voice translation — hear the creator in your language ($3/h in
        // AvaCoins; 100% platform — the creator's earnings are untouched).
        TranslateOverlay(context: 'live', refId: widget.listingId, top: 100),
        // chat bottom-left
        Positioned(
          left: 12, right: 110, bottom: 70, height: 180,
          child: ChatOverlay(lines: _chat, meta: _chatMeta),
        ),
        if (_pinned != null && _pinned!.isNotEmpty)
          Positioned(
            left: 12, right: 12, top: 64,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(10)),
              child: Row(children: [
                const Icon(Icons.push_pin, color: Colors.amber, size: 14),
                const SizedBox(width: 6),
                Expanded(child: Text(_pinned!, style: const TextStyle(color: Colors.white, fontSize: 12))),
              ]),
            ),
          ),
        if (_banner != null)
          Positioned(left: 0, right: 0, top: 110, child: Center(child: DonationBannerWidget(banner: _banner!))),
        // top bar
        Positioned(
          left: 0, right: 0, top: 0,
          child: LiveTopBar(
            title: _title, live: _live, watching: _watching,
            remainingMs: remaining != null && remaining > 0 ? remaining : null,
            onCreatorTap: _creatorId == null ? null : () =>
                Navigator.push(context, MaterialPageRoute(builder: (_) => CreatorChannelScreen(creatorUid: _creatorId!))),
            onClose: () => Navigator.pop(context),
          ),
        ),
        // bottom controls
        Positioned(
          left: 12, right: 12, bottom: 12,
          child: SafeArea(
            top: false,
            child: Row(children: [
              Expanded(
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  decoration: BoxDecoration(color: Colors.black45, borderRadius: BorderRadius.circular(22)),
                  child: TextField(
                    controller: _chatCtl,
                    style: const TextStyle(color: Colors.white, fontSize: 13),
                    decoration: const InputDecoration(hintText: 'Say something…', hintStyle: TextStyle(color: Colors.white54, fontSize: 13), border: InputBorder.none),
                    onSubmitted: (_) => _sendChat(),
                  ),
                ),
              ),
              IconButton(
                icon: const Icon(Icons.send, color: Colors.white),
                onPressed: _sendChat,
                tooltip: 'Chat',
              ),
              IconButton(
                icon: const Icon(Icons.rocket_launch, color: Colors.white),
                tooltip: 'Flying message',
                onPressed: () {
                  final t = _chatCtl.text.trim();
                  if (t.isEmpty) return;
                  _room?.send({'type': 'fly', 'text': t});
                  _chatCtl.clear();
                },
              ),
              // reactions + stickers
              PopupMenuButton<String>(
                icon: const Icon(Icons.emoji_emotions, color: Colors.white),
                color: Colors.black87,
                itemBuilder: (_) => [
                  PopupMenuItem(
                    enabled: false,
                    child: Wrap(spacing: 6, children: [
                      for (final e in kReactionEmojis)
                        GestureDetector(
                          onTap: () { Navigator.pop(context); _room?.send({'type': 'reaction', 'emoji': e}); setState(() => _bursts.add(ReactionBurst(e))); },
                          child: Text(e, style: const TextStyle(fontSize: 22)),
                        ),
                    ]),
                  ),
                  PopupMenuItem(
                    enabled: false,
                    child: Wrap(spacing: 6, children: [
                      for (final s in kStickerCatalog)
                        GestureDetector(
                          onTap: () { Navigator.pop(context); _room?.send({'type': 'sticker', 'id': s}); },
                          child: Text(s, style: const TextStyle(fontSize: 22)),
                        ),
                    ]),
                  ),
                ],
              ),
              const SizedBox(width: 4),
              FloatingActionButton.small(
                heroTag: 'donate',
                backgroundColor: AvaColors.brand,
                onPressed: _donateSheet,
                child: const Icon(Icons.volunteer_activism, color: Colors.white),
              ),
            ]),
          ),
        ),
      ]),
    );
  }
}

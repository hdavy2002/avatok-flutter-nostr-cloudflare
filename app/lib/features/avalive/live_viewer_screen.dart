// Phase 7 — AvaLive VIEWER. Full-bleed player (WHEP over the shared
// flutter_webrtc — no second engine), overlay: scrolling chat, flying messages,
// tap-burst reactions, sticker sends, Donate. Top bar: creator chip, LIVE
// badge, viewer count, time remaining. Join requires a paid order (the worker
// refuses non-payers); leave/rejoin within the entitlement always works.
//
// Chrome: video is content (full-bleed, untouched). Chrome = black-alpha bands
// and hairline circle buttons; join-error and stream-ended are full AD screens.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/money_api.dart';
import '../../core/session_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/wallet_entitlement.dart';
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
  bool _streamEnded = false;
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
          setState(() { _live = false; _streamEnded = true; _status = 'stream ended'; });
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
    // [WALLET-GET-STATE-1] A failed read is not a confirmed $0.00 — showing
    // that used to make a real balance look empty on a flaky network
    // (Root-Cause Report §17). The donate amounts below are always tappable
    // regardless; the server is the authoritative affordability check
    // (see _donate's 402/WALLET_INSUFFICIENT handling).
    final snap = await WalletEntitlement.I.refresh();
    if (!mounted) return;
    final balUnavailable = snap.state == WalletEntitlementState.unavailable;
    final bal = balUnavailable ? 0 : snap.balance;
    final amounts = [100, 200, 500, 1000, 2000, 5000];
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: Msg.brSheetTop),
      builder: (sheetCtx) => Padding(
        padding: const EdgeInsets.all(Msg.s5),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          ZineCardHead(
            icon: PhosphorIcons.coins(PhosphorIconsStyle.regular),
            accent: AD.online,
            title: 'Send a donation',
          ),
          const SizedBox(height: Msg.s1),
          Text(
              balUnavailable
                  ? '$kWalletUnavailableMessage · goes to the creator instantly'
                  : 'Balance \$${(bal / 100).toStringAsFixed(2)} · goes to the creator instantly',
              style: ADText.preview()),
          const SizedBox(height: Msg.s4),
          Wrap(spacing: Msg.s2, runSpacing: Msg.s2, children: [
            for (final a in amounts)
              ZineSticker(
                '\$${(a / 100).toStringAsFixed(a % 100 == 0 ? 0 : 2)}',
                kind: ZineStickerKind.ok, // the pay action
                onTap: () { Navigator.pop(sheetCtx); _donate(a); },
              ),
          ]),
          const SizedBox(height: Msg.s2),
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
    if (_error != null) return _errorScreen();
    if (_streamEnded) return _endedScreen();
    final remaining = _endsAt > 0 ? _endsAt - DateTime.now().millisecondsSinceEpoch : null;
    return Scaffold(
      backgroundColor: AD.bg,
      body: Stack(fit: StackFit.expand, children: [
        RTCVideoView(_renderer, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover),
        if (_status != 'watching')
          Center(child: LiveInkPill(_status)),
        if (!_hostLive) const ReconnectingOverlay(),
        FlyLayer(msgs: _fly),
        ReactionLayer(bursts: _bursts),
        // Live voice translation — hear the creator in your language ($3/h in
        // Tokens; 100% platform — the creator's earnings are untouched).
        TranslateOverlay(context: 'live', refId: widget.listingId, top: 100),
        // chat bottom-left
        Positioned(
          left: 12, right: 110, bottom: 76, height: 180,
          child: ChatOverlay(lines: _chat, meta: _chatMeta),
        ),
        if (_pinned != null && _pinned!.isNotEmpty)
          Positioned(
            left: 12, right: 12, top: 64,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s2),
              // Pinned-message pill.
              decoration: BoxDecoration(color: kInkScrim, borderRadius: Msg.brPill),
              child: Row(children: [
                PhosphorIcon(PhosphorIcons.pushPin(PhosphorIconsStyle.regular), color: AD.primaryBadge, size: 14),
                const SizedBox(width: Msg.s1),
                Expanded(child: Text(_pinned!, style: ADText.tabLabel(c: AD.textPrimary))),
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
        // bottom controls — ink-alpha input + bordered circle buttons
        Positioned(
          left: 12, right: 12, bottom: 12,
          child: SafeArea(
            top: false,
            child: Row(children: [
              Expanded(
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: Msg.s4),
                  decoration: BoxDecoration(color: kInkScrim, borderRadius: Msg.brSm),
                  child: TextField(
                    controller: _chatCtl,
                    style: ADText.tabLabel(c: AD.textPrimary),
                    cursorColor: AD.primaryBadge,
                    decoration: InputDecoration(
                      hintText: 'Say something…',
                      hintStyle: ADText.tabLabel(c: AD.textSecondary),
                      border: InputBorder.none,
                    ),
                    onSubmitted: (_) => _sendChat(),
                  ),
                ),
              ),
              const SizedBox(width: Msg.s2),
              LiveCircleButton(
                icon: PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.bold),
                size: 40,
                tooltip: 'Chat',
                onTap: _sendChat,
              ),
              const SizedBox(width: Msg.s1),
              LiveCircleButton(
                icon: PhosphorIcons.rocketLaunch(PhosphorIconsStyle.regular),
                size: 40,
                tooltip: 'Flying message',
                onTap: () {
                  final t = _chatCtl.text.trim();
                  if (t.isEmpty) return;
                  _room?.send({'type': 'fly', 'text': t});
                  _chatCtl.clear();
                },
              ),
              const SizedBox(width: Msg.s1),
              // reactions + stickers
              PopupMenuButton<String>(
                color: AD.menu,
                shape: RoundedRectangleBorder(
                    borderRadius: Msg.brMd,
                    side: const BorderSide(color: AD.borderControl, width: 1)),
                itemBuilder: (_) => [
                  PopupMenuItem(
                    enabled: false,
                    child: Wrap(spacing: Msg.s1, children: [
                      for (final e in kReactionEmojis)
                        GestureDetector(
                          onTap: () { Navigator.pop(context); _room?.send({'type': 'reaction', 'emoji': e}); setState(() => _bursts.add(ReactionBurst(e))); },
                          child: Text(e, style: const TextStyle(fontSize: 22)),
                        ),
                    ]),
                  ),
                  PopupMenuItem(
                    enabled: false,
                    child: Wrap(spacing: Msg.s1, children: [
                      for (final s in kStickerCatalog)
                        GestureDetector(
                          onTap: () { Navigator.pop(context); _room?.send({'type': 'sticker', 'id': s}); },
                          child: Text(s, style: const TextStyle(fontSize: 22)),
                        ),
                    ]),
                  ),
                ],
                child: Container(
                  width: 40, height: 40,
                  decoration: BoxDecoration(
                    color: AD.card,
                    shape: BoxShape.circle,
                    border: Border.all(color: AD.borderControl, width: 1),
                  ),
                  child: PhosphorIcon(PhosphorIcons.smiley(PhosphorIconsStyle.regular), size: 19, color: AD.iconNeutral),
                ),
              ),
              const SizedBox(width: Msg.s1),
              // money = green
              LiveCircleButton(
                icon: PhosphorIcons.coins(PhosphorIconsStyle.regular),
                fill: AD.online,
                size: 46,
                tooltip: 'Donate',
                onTap: _donateSheet,
              ),
            ]),
          ),
        ),
      ]),
    );
  }

  /// Join failed (unpaid / error) — full-screen AD surface.
  Widget _errorScreen() {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: const ZineAppBar(title: 'AvaLive', markWord: 'Live', tag: 'live stream'),
      body: ZinePaper(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(Msg.s5),
            child: ZineEmptyState(icon: PhosphorIcons.warning(PhosphorIconsStyle.regular), text: _error!),
          ),
        ),
      ),
    );
  }

  /// Stream over — full-screen AD surface.
  Widget _endedScreen() {
    return Scaffold(
      backgroundColor: AD.bg,
      body: ZineSuccessOverlay(
        icon: PhosphorIcons.check(PhosphorIconsStyle.bold),
        headline: 'Stream ended',
        accentLine: 'Thanks for watching',
        sub: 'The creator wrapped up — catch the next one from their channel.',
        ctaLabel: 'Back to AvaTOK',
        onCta: () => Navigator.pop(context),
      ),
    );
  }
}

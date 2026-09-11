// [WAITROOM-APP-1] Commercial 1:1 consult waiting room.
//
// This is the pre-call lobby (Specs/RULEBOOK-PAID-SESSIONS.md §3): opening the
// appointment connects to the session DO socket only — counterparty avatar,
// "Waiting for X…", the buyer/creator's OWN local preview, a meter, chat and
// (for the creator) the check-in line. No GetStream participant exists until
// the roster reports BOTH sides present, at which point this screen performs
// the existing `/join` handoff itself and pushes the existing
// [CommercialConsultationRoomScreen]. Leaving that room pops back HERE with
// the waiting-room socket still open. NO P2P/SFU code lives in this file.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:stream_video_flutter/stream_video_flutter.dart' show VideoTrackRenderer;

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/commercial_waiting_room_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import 'commercial_consult_screens.dart' show CommercialConsultationRoomScreen, CommercialConsultationCompletionScreen;
import 'commercial_device_check.dart' show CommercialDeviceCheckController;
import 'commercial_getstream_handoff.dart';
import 'commercial_live_gateway.dart' show CommercialConsultGateway;

class _ChatLine {
  final String from;
  final String text;
  final bool mine;
  const _ChatLine({required this.from, required this.text, required this.mine});
}

class CommercialWaitingRoomScreen extends StatefulWidget {
  const CommercialWaitingRoomScreen({
    super.key,
    required this.listingId,
    required this.bookingId,
    required this.title,
    required this.gateway,
    required this.connector,
    required this.isCreator,
    required this.grant,
    required this.deviceController,
    required this.cameraOn,
    required this.microphoneOn,
    required this.selfUid,
  });

  final String listingId, bookingId, title;
  final CommercialConsultGateway gateway;
  final CommercialGetStreamConnector connector;
  final bool isCreator;
  final CommercialWaitingRoomGrant grant;
  /// The SAME controller the prejoin screen warmed up. Reused here so the
  /// waiting room's own preview never opens a second camera.
  final CommercialDeviceCheckController deviceController;
  final bool cameraOn, microphoneOn;
  final String selfUid;

  @override
  State<CommercialWaitingRoomScreen> createState() => _CommercialWaitingRoomScreenState();
}

class _CommercialWaitingRoomScreenState extends State<CommercialWaitingRoomScreen> {
  late CommercialWaitingRoomChannel _channel;
  StreamSubscription<CommercialWaitingRoomEvent>? _sub;
  Timer? _tick;
  final _chatController = TextEditingController();
  final _chatScroll = ScrollController();
  final List<_ChatLine> _chat = [];

  int? _startsAt, _endsAt;
  bool _rosterHost = false;
  bool _warned5 = false;
  bool _noShow = false;
  bool _joining = false;
  bool _ended = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _startsAt = widget.grant.startsAt;
    _endsAt = widget.grant.endsAt;
    _channel = CommercialWaitingRoomChannel(widget.grant.roomWs!);
    _sub = _channel.events.listen(_onEvent);
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => _onTick());
    Analytics.capture('waitroom_enter', {
      'booking_id': widget.bookingId,
      'role': widget.isCreator ? 'creator' : 'buyer',
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    _sub?.cancel();
    _channel.close();
    // This screen is the sole owner of the device controller from the
    // handoff onward (the prejoin screen deliberately skips disposing it —
    // see [_controllerHandedOff] there). dispose() is idempotent even when
    // [_autoJoin] already released it for the GetStream call.
    unawaited(widget.deviceController.dispose());
    _chatController.dispose();
    _chatScroll.dispose();
    super.dispose();
  }

  void _onEvent(CommercialWaitingRoomEvent e) {
    if (!mounted) return;
    switch (e) {
      case CommercialWaitingRoomWelcome w:
        setState(() { _startsAt = w.startsAt; _endsAt = w.endsAt; });
      case CommercialWaitingRoomRoster r:
        setState(() => _rosterHost = r.host);
        if (r.host && r.attendee) unawaited(_autoJoin());
      case CommercialWaitingRoomPresence _:
        // Roster events are the source of truth for auto-join; presence is
        // informational only here (no per-peer UI beyond the roster line).
        break;
      case CommercialWaitingRoomChat c:
        setState(() => _chat.add(_ChatLine(from: c.from, text: c.text, mine: c.from == widget.selfUid)));
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (_chatScroll.hasClients) {
            _chatScroll.animateTo(_chatScroll.position.maxScrollExtent,
                duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
          }
        });
      case CommercialWaitingRoomEnded _:
        if (!_ended) _leave(auto: true);
    }
  }

  void _onTick() {
    if (!mounted) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    final endsAt = _endsAt;
    final checkInBy = widget.grant.checkInBy;
    if (endsAt != null && !_warned5) {
      final remaining = endsAt - now;
      if (remaining <= 5 * 60_000 && remaining > 0) {
        _warned5 = true;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(PhosphorIcons.timer(PhosphorIconsStyle.regular), size: 16, color: AD.textPrimary),
            const SizedBox(width: Msg.s2),
            Text('5 minutes remaining', style: ADText.preview(c: AD.textPrimary)),
          ]),
          backgroundColor: AD.card,
        ));
      }
    }
    if (!widget.isCreator && !_rosterHost && checkInBy != null && now > checkInBy && !_noShow) {
      _noShow = true;
      Analytics.capture('waitroom_noshow_shown', {
        'booking_id': widget.bookingId,
        'role': 'buyer',
      });
    }
    if (endsAt != null && now >= endsAt + 2 * 60_000 && !_ended) {
      _leave(auto: true);
      return;
    }
    setState(() {});
  }

  Future<void> _autoJoin() async {
    if (_joining || _ended) return;
    _joining = true;
    Analytics.capture('waitroom_autojoin', {
      'booking_id': widget.bookingId,
      'role': widget.isCreator ? 'creator' : 'buyer',
    });
    try {
      // Release the waiting-room preview before the SDK opens its own camera
      // and microphone — same rule the prejoin screen follows.
      await widget.deviceController.release();
      final handoff = await widget.gateway.authorize(CommercialGetStreamJoinRequest(
        listingId: widget.listingId,
        product: CommercialGetStreamProduct.consultation,
        bookingId: widget.bookingId,
      ));
      if (!mounted) return;
      final expected = widget.isCreator ? CommercialGetStreamRole.creator : CommercialGetStreamRole.buyer;
      if (handoff.role != expected) throw const FormatException('Server role does not match this booking');
      final session = widget.connector is CommercialGetStreamMediaConnector
          ? await (widget.connector as CommercialGetStreamMediaConnector).connectWithMedia(
              handoff, cameraEnabled: widget.cameraOn, microphoneEnabled: widget.microphoneOn)
          : await widget.connector.connect(handoff);
      if (!mounted) { await session.leave(); return; }
      await Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => CommercialConsultationRoomScreen(
          listingId: widget.listingId, bookingId: widget.bookingId, title: widget.title,
          gateway: widget.gateway, connector: widget.connector, handoff: handoff, session: session,
          cameraEnabled: widget.cameraOn, microphoneEnabled: widget.microphoneOn, isCreator: widget.isCreator,
        ),
      ));
      // Back from the call: resume the local preview (best-effort) while the
      // socket — never closed — keeps reporting roster/chat/meter.
      if (mounted && !_ended) {
        widget.deviceController.resume();
        try {
          await widget.deviceController.setCameraEnabled(widget.cameraOn);
          await widget.deviceController.setMicrophoneEnabled(widget.microphoneOn);
        } catch (_) {}
        if (mounted) setState(() {});
      }
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not connect. Waiting to try again…');
    } finally {
      _joining = false;
    }
  }

  void _sendChat() {
    final text = _chatController.text;
    if (text.trim().isEmpty) return;
    _channel.sendChat(text);
    _chatController.clear();
    Analytics.capture('waitroom_chat_sent', {
      'booking_id': widget.bookingId,
      'role': widget.isCreator ? 'creator' : 'buyer',
    });
  }

  Future<void> _leave({bool auto = false}) async {
    if (_ended) return;
    _ended = true;
    if (!mounted) return;
    if (auto) {
      // Session window is over (ends_at + 2 min) and no call ever started —
      // go to the same completion screen the in-call "Leave" path reaches,
      // rather than just popping to wherever the waiting room was opened from.
      var sessionId = widget.bookingId;
      try {
        final state = await widget.gateway.consultState(widget.bookingId);
        sessionId = state.sessionId;
      } catch (_) {/* best-effort; completion screen handles a missing receipt */}
      if (!mounted) return;
      await Navigator.of(context).pushReplacement(MaterialPageRoute<void>(
        builder: (_) => CommercialConsultationCompletionScreen(
          title: widget.title,
          sessionId: sessionId,
          gateway: widget.gateway,
          heading: 'Session ended',
          creator: widget.isCreator,
        ),
      ));
      return;
    }
    Navigator.of(context).pop();
  }

  String _fmt(int ms) {
    final clamped = ms.clamp(0, 1 << 62);
    final s = (clamped / 1000).floor();
    final h = s ~/ 3600, m = (s % 3600) ~/ 60, sec = s % 60;
    if (h > 0) return '${h.toString().padLeft(2, '0')}:${m.toString().padLeft(2, '0')}:${sec.toString().padLeft(2, '0')}';
    return '${m.toString().padLeft(2, '0')}:${sec.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now().millisecondsSinceEpoch;
    final startsAt = _startsAt, endsAt = _endsAt;
    final counterparty = widget.grant.counterparty;
    final counterpartyName = (counterparty?.name.isNotEmpty ?? false) ? counterparty!.name : 'the other person';
    final checkInBy = widget.grant.checkInBy;

    String meterLabel;
    String meterValue;
    if (startsAt != null && now < startsAt) {
      meterLabel = 'Starts in';
      meterValue = _fmt(startsAt - now);
    } else if (endsAt != null) {
      meterLabel = now >= endsAt ? 'Overtime' : 'Time left';
      meterValue = _fmt((endsAt - now).abs());
    } else {
      meterLabel = 'Session';
      meterValue = '—:—';
    }

    return PopScope(
      canPop: true,
      child: Scaffold(
        backgroundColor: AD.bg,
        appBar: AppBar(
          backgroundColor: AD.headerFooter,
          foregroundColor: AD.onBand(AD.headerFooter),
          title: Text(widget.title, maxLines: 1, overflow: TextOverflow.ellipsis),
        ),
        body: ListView(padding: const EdgeInsets.all(Msg.s4), children: [
          Center(
            child: Column(children: [
              Avatar(seed: widget.bookingId, name: counterpartyName, size: 84, avatarUrl: counterparty?.avatarUrl),
              const SizedBox(height: Msg.s3),
              Text('Waiting for $counterpartyName…', style: ADText.threadName(), textAlign: TextAlign.center),
              const SizedBox(height: Msg.s2),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s2),
                decoration: BoxDecoration(
                  color: AD.card,
                  borderRadius: Msg.brPill,
                  border: Border.all(color: AD.borderControl, width: 1),
                ),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  PhosphorIcon(PhosphorIcons.timer(PhosphorIconsStyle.regular), size: 15, color: AD.textPrimary),
                  const SizedBox(width: Msg.s1),
                  Text('$meterLabel · $meterValue', style: ADText.timestamp(c: AD.textPrimary)),
                ]),
              ),
            ]),
          ),
          const SizedBox(height: Msg.s4),
          // Own preview — reuses the SAME preflight controller (no second camera).
          ClipRRect(
            borderRadius: Msg.brLg,
            child: ColoredBox(
              color: Colors.black,
              child: AspectRatio(
                aspectRatio: 16 / 10,
                child: widget.deviceController.cameraTrack != null
                    ? VideoTrackRenderer(videoTrack: widget.deviceController.cameraTrack!, mirror: true)
                    : Center(child: Icon(PhosphorIcons.videoCameraSlash(PhosphorIconsStyle.bold), color: Colors.white, size: 40)),
              ),
            ),
          ),
          const SizedBox(height: Msg.s3),
          if (widget.isCreator)
            _Notice(
              icon: PhosphorIcons.checkCircle(PhosphorIconsStyle.fill),
              iconColor: AD.online,
              text: "You're checked in ✓ — you'll be paid for this slot",
            )
          else if (checkInBy != null)
            _Notice(
              icon: PhosphorIcons.clock(PhosphorIconsStyle.regular),
              iconColor: AD.textTertiary,
              text: 'Check in by ${TimeOfDay.fromDateTime(DateTime.fromMillisecondsSinceEpoch(checkInBy)).format(context)}',
            ),
          if (_noShow)
            _Notice(
              icon: PhosphorIcons.warning(PhosphorIconsStyle.fill),
              iconColor: AD.danger,
              text: "$counterpartyName hasn't checked in yet. If they don't, you'll be refunded automatically.",
            ),
          if (_error != null) Padding(
            padding: const EdgeInsets.only(top: Msg.s2),
            child: Text(_error!, style: ADText.preview(c: AD.danger)),
          ),
          const SizedBox(height: Msg.s4),
          Text('Chat', style: ADText.sectionLabel()),
          const SizedBox(height: Msg.s2),
          Container(
            height: 220,
            padding: const EdgeInsets.all(Msg.s3),
            decoration: BoxDecoration(
              color: AD.card,
              borderRadius: Msg.brMd,
              border: Border.all(color: AD.borderControl, width: 1),
            ),
            child: _chat.isEmpty
                ? Center(child: Text('No messages yet', style: ADText.preview(c: AD.textTertiary)))
                : ListView.builder(
                    controller: _chatScroll,
                    itemCount: _chat.length,
                    itemBuilder: (_, i) {
                      final line = _chat[i];
                      return Align(
                        alignment: line.mine ? Alignment.centerRight : Alignment.centerLeft,
                        child: Container(
                          margin: const EdgeInsets.symmetric(vertical: Msg.s1),
                          padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s2),
                          decoration: BoxDecoration(
                            color: line.mine ? AD.headerFooter : AD.cardHover,
                            borderRadius: Msg.brMd,
                          ),
                          child: Text(line.text, style: ADText.bubbleBody(c: line.mine ? AD.onBand(AD.headerFooter) : AD.textPrimary)),
                        ),
                      );
                    },
                  ),
          ),
          const SizedBox(height: Msg.s2),
          Row(children: [
            Expanded(
              child: TextField(
                controller: _chatController,
                maxLength: 500,
                decoration: const InputDecoration(hintText: 'Message…', counterText: '', filled: true),
                onSubmitted: (_) => _sendChat(),
              ),
            ),
            const SizedBox(width: Msg.s2),
            IconButton(onPressed: _sendChat, icon: Icon(PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.bold))),
          ]),
          const SizedBox(height: Msg.s5),
          FilledButton.icon(
            onPressed: () => _leave(),
            style: FilledButton.styleFrom(backgroundColor: AD.destructiveBg),
            icon: Icon(PhosphorIcons.signOut(PhosphorIconsStyle.bold)),
            label: const Text('Leave'),
          ),
          const SizedBox(height: Msg.s3),
        ]),
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.icon, required this.iconColor, required this.text});
  final IconData icon;
  final Color iconColor;
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: Msg.s2),
        child: Container(
          padding: const EdgeInsets.all(Msg.s3),
          decoration: BoxDecoration(color: AD.card, borderRadius: Msg.brMd, border: Border.all(color: AD.borderControl, width: 1)),
          child: Row(children: [
            PhosphorIcon(icon, size: 18, color: iconColor),
            const SizedBox(width: Msg.s2),
            Expanded(child: Text(text, style: ADText.preview(c: AD.textPrimary))),
          ]),
        ),
      );
}

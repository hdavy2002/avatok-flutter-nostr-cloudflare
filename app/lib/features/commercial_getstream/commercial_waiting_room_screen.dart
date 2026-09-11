// [WAITROOM-APP-1] Commercial 1:1 consult waiting room.
// [WAITROOM-APP-2] Applies the Opus client-review fixes: auto-join that
// cannot get stuck (fix 1), a Leave from the call that does not end the
// session (fix 2, in commercial_consult_screens.dart), this screen's OWN
// device preview controller (fix 5), a terminal no-show state for the buyer
// (fix 6), a check-in line gated on connection state + evidence (fix 7), a
// guard against ending the slot while the call screen is on top (fix 8), and
// chat "mine" by uid (fix 11).
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
import 'commercial_consult_screens.dart'
    show CommercialConsultationRoomScreen, CommercialConsultationCompletionScreen, CommercialConsultExit;
import 'commercial_device_check.dart' show CommercialDeviceCheckController;
import 'commercial_getstream_handoff.dart';
import 'commercial_live_gateway.dart' show CommercialConsultGateway, CommercialLiveState, CommercialLiveGatewayError;

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
    required this.cameraOn,
    required this.microphoneOn,
    required this.selfUid,
  });

  final String listingId, bookingId, title;
  final CommercialConsultGateway gateway;
  final CommercialGetStreamConnector connector;
  final bool isCreator;
  final CommercialWaitingRoomGrant grant;
  final bool cameraOn, microphoneOn;
  final String selfUid;

  @override
  State<CommercialWaitingRoomScreen> createState() => _CommercialWaitingRoomScreenState();
}

class _CommercialWaitingRoomScreenState extends State<CommercialWaitingRoomScreen> {
  late CommercialWaitingRoomChannel _channel;
  StreamSubscription<CommercialWaitingRoomEvent>? _sub;
  StreamSubscription<bool>? _connSub;
  StreamSubscription<void>? _failSub;
  Timer? _tick;
  Timer? _autoJoinTimer;
  Timer? _opensAtRetryTimer;
  Timer? _noShowPoll;
  final _chatController = TextEditingController();
  final _chatScroll = ScrollController();
  final List<_ChatLine> _chat = [];

  // [WAITROOM-APP-2] Fix 5: this screen creates and owns its OWN device
  // preview controller — it is never handed one from the prejoin screen, and
  // it never enables the microphone recorder (camera preview only).
  final CommercialDeviceCheckController _deviceController = CommercialDeviceCheckController();
  bool _devicePrimed = false;

  int? _startsAt, _endsAt;

  // [WAITROOM-APP-2] Fix 1: roster state kept explicitly so the auto-join
  // decision never depends solely on catching the exact roster event.
  bool _rosterHost = false;
  bool _rosterAttendee = false;
  // [WAITROOM-APP-3] A2: true once ANY welcome/roster message has arrived.
  // The 1 s tick can otherwise run before the socket delivers its first
  // message, so a buyer opening right after `check_in_by` would see a
  // permanent no-show even though the creator is actually present.
  bool _rosterSeen = false;
  bool _autoJoinPaused = false;
  ({bool host, bool attendee})? _pausedRosterSnapshot;

  // [WAITROOM-APP-2] Fix 6/7: check-in evidence. `_hostCheckedInAt` is the
  // server-authoritative value once the worker sends it; `_hostSeenAtLocal`
  // is the fallback — the first time THIS client's roster ever reported the
  // host present.
  int? _hostCheckedInAt;
  int? _hostSeenAtLocal;

  // [WAITROOM-APP-2] Fix 7: the creator's check-in line is gated on the
  // socket actually being connected, and on the FIRST connect time.
  bool _connected = false;
  int? _firstConnectedAt;

  bool _warned5 = false;
  bool _noShow = false;
  CommercialLiveState? _noShowState;
  bool _joining = false;
  // [WAITROOM-APP-2] Fix 8: true only while the GetStream call screen is
  // pushed on top of this one — the end-of-slot auto-exit must not fire then.
  bool _callScreenOnTop = false;
  // [WAITROOM-APP-3] A6: `session_ended` can arrive from the DO while the
  // call screen is on top — never `pushReplacement` over it; remember the
  // fact and act on it exactly like `CommercialConsultExit.ended` once that
  // screen returns.
  bool _pendingEnded = false;
  bool _ended = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _startsAt = widget.grant.startsAt;
    _endsAt = widget.grant.endsAt;
    _channel = CommercialWaitingRoomChannel(widget.grant.roomWs!);
    _sub = _channel.events.listen(_onEvent);
    _connSub = _channel.connectionState.listen(_onConnectionState);
    _failSub = _channel.failures.listen((_) => _onChannelFailure());
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => _onTick());
    // [WAITROOM-APP-2] Fix 1: a periodic backstop, independent of the roster
    // event stream, so a missed/late roster message can never leave both
    // parties stuck staring at the lobby.
    _autoJoinTimer = Timer.periodic(const Duration(seconds: 5), (_) => _maybeAutoJoin());
    Analytics.capture('waitroom_enter', {
      'booking_id': widget.bookingId,
      'role': widget.isCreator ? 'creator' : 'buyer',
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // [WAITROOM-APP-2] Fix 5: prime the OWN preview only after the push
    // transition that brought this screen in has finished, so the camera
    // never opens mid-animation.
    if (_devicePrimed) return;
    _devicePrimed = true;
    final route = ModalRoute.of(context);
    final animation = route?.animation;
    if (animation == null || animation.isCompleted) {
      unawaited(_primeDevicePreview());
    } else {
      late final AnimationStatusListener listener;
      listener = (status) {
        if (status != AnimationStatus.completed) return;
        animation.removeStatusListener(listener);
        unawaited(_primeDevicePreview());
      };
      animation.addStatusListener(listener);
    }
  }

  Future<void> _primeDevicePreview() async {
    if (!mounted) return;
    // [WAITROOM-APP-3] A5: a slow route-animation completion can land after
    // auto-join has already started (or finished) releasing the preview and
    // handing the camera to the call SDK — priming here then would double-
    // open the camera underneath it.
    if (_joining || _callScreenOnTop || _ended) return;
    _deviceController.resume();
    try {
      await _deviceController.setCameraEnabled(widget.cameraOn);
    } catch (_) {}
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _tick?.cancel();
    _autoJoinTimer?.cancel();
    _opensAtRetryTimer?.cancel();
    _noShowPoll?.cancel();
    _sub?.cancel();
    _connSub?.cancel();
    _failSub?.cancel();
    _channel.close();
    // [WAITROOM-APP-2] Fix 5: this screen owns its device controller
    // unconditionally now — no handoff to track.
    unawaited(_deviceController.dispose());
    _chatController.dispose();
    _chatScroll.dispose();
    super.dispose();
  }

  void _onConnectionState(bool connected) {
    if (!mounted) return;
    setState(() => _connected = connected);
    if (connected) _firstConnectedAt ??= DateTime.now().millisecondsSinceEpoch;
  }

  /// [WAITROOM-APP-3] A12: the waiting-room socket never delivered a single
  /// message after repeated attempts (a rejected token) — mirror the web
  /// client and fall back to a direct join rather than sit in a dead lobby.
  void _onChannelFailure() {
    if (!mounted || _ended) return;
    Analytics.capture('waitroom_socket_failed', {
      'booking_id': widget.bookingId,
      'role': widget.isCreator ? 'creator' : 'buyer',
    });
    unawaited(_autoJoin());
  }

  void _onEvent(CommercialWaitingRoomEvent e) {
    if (!mounted) return;
    switch (e) {
      case CommercialWaitingRoomWelcome w:
        setState(() { _startsAt = w.startsAt; _endsAt = w.endsAt; _rosterSeen = true; });
        if (w.hostCheckedInAt != null) _hostCheckedInAt ??= w.hostCheckedInAt;
        _reconsiderNoShow();
      case CommercialWaitingRoomRoster r:
        setState(() { _rosterHost = r.host; _rosterAttendee = r.attendee; _rosterSeen = true; });
        if (r.hostCheckedInAt != null) _hostCheckedInAt ??= r.hostCheckedInAt;
        if (r.host) _hostSeenAtLocal ??= DateTime.now().millisecondsSinceEpoch;
        // [WAITROOM-APP-2] Fix 1: any roster change ends a deliberate-leave
        // pause — "pause auto-join until the roster changes".
        final snap = _pausedRosterSnapshot;
        if (_autoJoinPaused && snap != null && (snap.host != r.host || snap.attendee != r.attendee)) {
          _autoJoinPaused = false;
          _pausedRosterSnapshot = null;
        }
        _reconsiderNoShow();
        _maybeAutoJoin();
      case CommercialWaitingRoomPresence _:
        // Roster events are the source of truth for auto-join; presence is
        // informational only here (no per-peer UI beyond the roster line).
        break;
      case CommercialWaitingRoomChat c:
        // [WAITROOM-APP-2] Fix 11: "mine" by uid when the DO sends one,
        // falling back to the previous name-match comparison otherwise.
        final mine = c.uid != null ? c.uid == widget.selfUid : c.from == widget.selfUid;
        setState(() => _chat.add(_ChatLine(from: c.from, text: c.text, mine: mine)));
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (_chatScroll.hasClients) {
            _chatScroll.animateTo(_chatScroll.position.maxScrollExtent,
                duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
          }
        });
      case CommercialWaitingRoomEnded _:
        // [WAITROOM-APP-3] A6: never `pushReplacement` over the call screen
        // — defer to when `_autoJoin` sees the pushed route return.
        if (_callScreenOnTop) {
          _pendingEnded = true;
        } else if (!_ended) {
          _leave(auto: true);
        }
    }
  }

  /// True once evidence (server `host_checked_in_at`, or the first roster
  /// sighting of the host as a fallback) places the creator's check-in at or
  /// before `check_in_by`.
  bool _hostCheckedInOnTime(int? checkInBy) {
    final evidence = _hostCheckedInAt ?? _hostSeenAtLocal;
    if (evidence == null || checkInBy == null) return false;
    return evidence <= checkInBy;
  }

  /// [WAITROOM-APP-3] A2: fresh evidence (a late `host_checked_in_at`, or a
  /// late roster sighting) can arrive AFTER `_noShow` was already latched —
  /// undo the terminal state instead of leaving the buyer stuck on a no-show
  /// notice for a creator who is actually present and on time.
  void _reconsiderNoShow() {
    if (!_noShow) return;
    if (!_hostCheckedInOnTime(widget.grant.checkInBy)) return;
    _noShowPoll?.cancel();
    _noShowPoll = null;
    setState(() {
      _noShow = false;
      _noShowState = null;
    });
    _autoJoinPaused = false;
    _maybeAutoJoin();
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

    // [WAITROOM-APP-2] Fix 6: terminal no-show — the check-in window passed
    // with no evidence the host was ever seen. Stop auto-join and start
    // polling the server for the refund outcome.
    if (!widget.isCreator && !_noShow && _rosterSeen && checkInBy != null && now > checkInBy && !_hostCheckedInOnTime(checkInBy)) {
      _noShow = true;
      _autoJoinPaused = true;
      Analytics.capture('waitroom_noshow_shown', {
        'booking_id': widget.bookingId,
        'role': 'buyer',
      });
      _noShowPoll?.cancel();
      _noShowPoll = Timer.periodic(const Duration(seconds: 5), (_) => _pollNoShowState());
      unawaited(_pollNoShowState());
    }
    // [WAITROOM-APP-2] Fix 8: never auto-exit the slot while a join is in
    // flight or the call screen is on top of this one — that screen's own
    // `_refresh`/end-of-slot handling owns the session in that state.
    if (endsAt != null && now >= endsAt + 2 * 60_000 && !_ended && !_joining && !_callScreenOnTop) {
      _leave(auto: true);
      return;
    }
    setState(() {});
  }

  Future<void> _pollNoShowState() async {
    if (!mounted) return;
    try {
      final s = await widget.gateway.consultState(widget.bookingId);
      if (mounted) setState(() => _noShowState = s);
    } catch (_) {/* keep polling; the notice already shows the fact of the no-show */}
  }

  /// [WAITROOM-APP-2] Fix 1: the single gate every auto-join attempt goes
  /// through — called from the roster event AND from the 5 s backstop timer,
  /// so a missed event can never leave both parties stuck.
  void _maybeAutoJoin() {
    if (!mounted || _ended || _joining || _autoJoinPaused || _callScreenOnTop) return;
    if (!(_rosterHost && _rosterAttendee)) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    // [WAITROOM-APP-3] A15: the slot is over — never start a fresh join past
    // ends_at (the end-of-slot exit in `_onTick` owns that transition).
    final endsAt = _endsAt;
    if (endsAt != null && now >= endsAt) return;
    // [WAITROOM-APP-3] A14: gate on the server's join-open time
    // (`opens_at` = starts_at − join-early minutes, same as web), not on
    // `startsAt` directly — `startsAt` falls back only when the worker
    // hasn't sent `opens_at` yet.
    final opensAt = widget.grant.opensAt ?? widget.grant.startsAt ?? _startsAt;
    if (opensAt != null && now < opensAt) return;
    unawaited(_autoJoin());
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
      await _deviceController.release();
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
      _callScreenOnTop = true;
      final exit = await Navigator.of(context).push<CommercialConsultExit>(MaterialPageRoute<CommercialConsultExit>(
        builder: (_) => CommercialConsultationRoomScreen(
          listingId: widget.listingId, bookingId: widget.bookingId, title: widget.title,
          gateway: widget.gateway, connector: widget.connector, handoff: handoff, session: session,
          cameraEnabled: widget.cameraOn, microphoneEnabled: widget.microphoneOn, isCreator: widget.isCreator,
          returnToWaitingRoom: true,
        ),
      ));
      _callScreenOnTop = false;
      if (!mounted) return;
      if (exit == CommercialConsultExit.ended || _pendingEnded) {
        // [WAITROOM-APP-2] Fix 2 / [WAITROOM-APP-3] A6: the room screen
        // already left the call (either it saw `ended` itself, or the DO's
        // `session_ended` arrived while it was on top) — go straight to the
        // same completion flow the end-of-slot path uses.
        _pendingEnded = false;
        if (!_ended) await _leave(auto: true);
        return;
      }
      // [WAITROOM-APP-2] Fix 1: a deliberate Leave (exit == leftManually, or
      // a bare back-pop) pauses auto-join until the roster changes, and the
      // "Rejoin call" button lets the user override that manually.
      _autoJoinPaused = true;
      _pausedRosterSnapshot = (host: _rosterHost, attendee: _rosterAttendee);
      await _resumePreviewAfterCall();
    } on CommercialLiveGatewayError catch (e) {
      _callScreenOnTop = false;
      if (e.status == 425) {
        // [WAITROOM-APP-3] A13: prefer the server's own `opens_at` from the
        // 425 body (authoritative) over the client-side grant, and always
        // wait at least 5 s — a clock a few ms off must not spin-retry.
        final opensAtFromBody = (e.body?['opens_at'] as num?)?.toInt();
        final opensAt = opensAtFromBody ?? widget.grant.opensAt ?? widget.grant.startsAt ?? _startsAt;
        final rawDelayMs = opensAt != null
            ? (opensAt - DateTime.now().millisecondsSinceEpoch)
            : 5000;
        final delayMs = rawDelayMs.clamp(5000, 1 << 31).toInt();
        _opensAtRetryTimer?.cancel();
        _opensAtRetryTimer = Timer(Duration(milliseconds: delayMs), _maybeAutoJoin);
      } else if (mounted) {
        setState(() => _error = 'Could not connect. Waiting to try again…');
      }
      await _resumePreviewAfterCall();
    } catch (e) {
      _callScreenOnTop = false;
      if (mounted) setState(() => _error = 'Could not connect. Waiting to try again…');
      await _resumePreviewAfterCall();
    } finally {
      _joining = false;
    }
  }

  /// [WAITROOM-APP-2] Fix 5: resume the OWN preview (camera only, never the
  /// mic recorder) whether the call ended normally, the user left manually,
  /// or the join attempt itself failed.
  Future<void> _resumePreviewAfterCall() async {
    if (!mounted || _ended) return;
    _deviceController.resume();
    try {
      await _deviceController.setCameraEnabled(widget.cameraOn);
    } catch (_) {}
    if (mounted) setState(() {});
  }

  void _rejoinNow() {
    _autoJoinPaused = false;
    _pausedRosterSnapshot = null;
    // [WAITROOM-APP-3] A1: `_maybeAutoJoin` returns void, not a Future —
    // wrapping it in `unawaited` was a compile error.
    _maybeAutoJoin();
    setState(() {});
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
    final windowClosed = checkInBy != null && now > checkInBy;
    final checkedInOnTime = _hostCheckedInOnTime(checkInBy);

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

    // [WAITROOM-APP-2] Fix 7: the check-in line is creator-only, gated on the
    // socket being connected right now, and on evidence at-or-before
    // check_in_by; after the window with no evidence it says the window is
    // closed instead. The buyer never sees "Check in by" at all.
    Widget? creatorNotice;
    if (widget.isCreator) {
      if (_connected && checkedInOnTime) {
        creatorNotice = _Notice(
          icon: PhosphorIcons.checkCircle(PhosphorIconsStyle.fill),
          iconColor: AD.online,
          text: "You're checked in ✓ — you'll be paid for this slot",
        );
      } else if (windowClosed && !checkedInOnTime) {
        creatorNotice = _Notice(
          icon: PhosphorIcons.warningCircle(PhosphorIconsStyle.regular),
          iconColor: AD.textTertiary,
          text: 'Check-in window is closed.',
        );
      }
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
          // Own preview — this screen's OWN controller (fix 5), camera only.
          ClipRRect(
            borderRadius: Msg.brLg,
            child: ColoredBox(
              color: Colors.black,
              child: AspectRatio(
                aspectRatio: 16 / 10,
                child: _deviceController.cameraTrack != null
                    ? VideoTrackRenderer(videoTrack: _deviceController.cameraTrack!, mirror: true)
                    : Center(child: Icon(PhosphorIcons.videoCameraSlash(PhosphorIconsStyle.bold), color: Colors.white, size: 40)),
              ),
            ),
          ),
          const SizedBox(height: Msg.s3),
          if (creatorNotice != null) creatorNotice,
          if (_noShow)
            _Notice(
              icon: PhosphorIcons.warning(PhosphorIconsStyle.fill),
              iconColor: AD.danger,
              text: _noShowState?.settlementState == 'refunded'
                  ? "$counterpartyName didn't check in. You've been refunded."
                  : "$counterpartyName didn't check in. You'll be refunded automatically.",
            ),
          if (_autoJoinPaused && !_noShow)
            Padding(
              padding: const EdgeInsets.only(top: Msg.s2),
              child: OutlinedButton.icon(
                onPressed: _rejoinNow,
                icon: Icon(PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.bold)),
                label: const Text('Rejoin call'),
              ),
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

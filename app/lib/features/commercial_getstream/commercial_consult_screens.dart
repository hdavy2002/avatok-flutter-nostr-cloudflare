// Phase 2D — commercial GetStream consultation prejoin, room and completion.
// This lane never calls Messenger, Cloudflare Realtime or legacy CallRoom.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:stream_video_flutter/stream_video_flutter.dart';

import '../../core/listings_api.dart';
import '../../core/remote_config.dart';
import '../../core/session_api.dart';
import '../../core/commercial_waiting_room_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../identity/identity.dart' show AccountScope;
import 'commercial_getstream_handoff.dart';
import 'commercial_live_gateway.dart';
import 'commercial_device_check.dart';
import 'commercial_speaker_test.dart';
import 'commercial_waiting_room_screen.dart';
import 'session_chat_panel.dart' show SessionChatController, SessionChatPanel;

class CommercialConsultationPrejoinFlow extends StatefulWidget {
  const CommercialConsultationPrejoinFlow({
    super.key,
    required this.listingId,
    required this.bookingId,
    required this.title,
    required this.gateway,
    required this.isCreator,
    required this.connector,
    this.flags,
  });

  final String listingId, bookingId, title;
  final CommercialConsultGateway gateway;
  final bool isCreator;
  final CommercialGetStreamConnector connector;
  final CommercialGetStreamJoinFlags? flags;

  @override
  State<CommercialConsultationPrejoinFlow> createState() => _CommercialConsultationPrejoinFlowState();
}

class _CommercialConsultationPrejoinFlowState extends State<CommercialConsultationPrejoinFlow> with WidgetsBindingObserver {
  PermissionStatus? _camera, _microphone;
  NetProbe? _network;
  bool _cameraOn = true, _microphoneOn = true, _checking = true, _joining = false;
  /// [AV-AUDIO-ONLY-1] False once this device proved it has no usable camera.
  /// Kept separate from [_cameraOn] (the user's intent) so "Run checks again"
  /// can re-probe, and so the join publishes audio only instead of asking the
  /// SDK to start a camera that cannot start.
  bool _cameraAvailable = true;
  String? _error;
  late final CommercialDeviceCheckController _deviceController;
  final _speaker = CommercialSpeakerTestController();
  bool _devicesReady = false;

  bool get _enabled => (widget.flags ?? CommercialGetStreamJoinFlags.fromRemoteConfig()).consultationJoinEnabled;
  /// The camera intent actually handed to the panel and to the join.
  bool get _cameraIntent => _cameraOn && _cameraAvailable;

  bool get _ready => _devicesReady && commercialDeviceCheckReady(
        enabled: _enabled,
        checking: _checking,
        cameraOn: _cameraOn,
        microphoneOn: _microphoneOn,
        cameraGranted: _camera?.isGranted == true,
        microphoneGranted: _microphone?.isGranted == true,
        networkVerdict: _network?.verdict,
        cameraAvailable: _cameraAvailable,
      );

  @override
  void initState() { super.initState(); WidgetsBinding.instance.addObserver(this); _deviceController = CommercialDeviceCheckController(); _check(); }

  Future<void> _check() async {
    if (!_enabled) { if (mounted) setState(() => _checking = false); return; }
    _deviceController.clearCameraUnavailable();
    setState(() { _checking = true; _network = null; _devicesReady = false; _error = null; _cameraAvailable = true; });
    try {
      final p = await [Permission.camera, Permission.microphone].request();
      final n = await SessionApi.probe();
      if (mounted) setState(() { _camera = p[Permission.camera]; _microphone = p[Permission.microphone]; _network = n; _checking = false; });
    } catch (_) { if (mounted) setState(() { _checking = false; _error = 'Device check failed. Try again on a stable connection.'; }); }
  }

  Future<void> _join() async {
    if (!_ready || _joining) return;
    setState(() { _joining = true; _devicesReady = false; _error = null; });
    try {
      // [WAITROOM-APP-1] Ask the server for a waiting-room grant first. A
      // missing/partial response (worker not deployed yet, feature off) is
      // NOT an error here: it just means today's direct-join flow runs below,
      // unchanged, so this screen never breaks on an old server.
      CommercialWaitingRoomGrant? grant;
      try {
        grant = await CommercialWaitingRoomApi.prejoin(widget.bookingId);
      } catch (_) {
        grant = null;
      }
      if (!mounted) return;
      if (grant != null && grant.isComplete && grant.isCreator == widget.isCreator) {
        // [WAITROOM-APP-2] Fix 5: the waiting room now creates and owns ITS
        // OWN device controller — no handoff. Release this screen's preview
        // (same rule as the direct-join path below) and let `dispose()`
        // dispose it unconditionally, exactly like the direct-join path.
        await _deviceController.release();
        await _speaker.stop();
        if (!mounted) return;
        await Navigator.of(context).pushReplacement(MaterialPageRoute<void>(
          builder: (_) => CommercialWaitingRoomScreen(
            listingId: widget.listingId,
            bookingId: widget.bookingId,
            title: widget.title,
            gateway: widget.gateway,
            connector: widget.connector,
            isCreator: widget.isCreator,
            grant: grant!,
            cameraOn: _cameraIntent,
            microphoneOn: _microphoneOn,
            selfUid: AccountScope.id ?? '',
          ),
        ));
        return;
      }
      // Preview capture is local-only. Release every native track before the
      // gateway or SDK is touched so the join cannot race the preview.
      await _deviceController.release();
      await _speaker.stop();
      if (!mounted) return;
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
              handoff, cameraEnabled: _cameraIntent, microphoneEnabled: _microphoneOn)
          : await widget.connector.connect(handoff);
      if (!mounted) { await session.leave(); return; }
      await Navigator.of(context).pushReplacement(MaterialPageRoute<void>(
        builder: (_) => CommercialConsultationRoomScreen(
          listingId: widget.listingId, bookingId: widget.bookingId, title: widget.title,
          gateway: widget.gateway, connector: widget.connector, handoff: handoff, session: session,
          cameraEnabled: _cameraIntent, microphoneEnabled: _microphoneOn, isCreator: widget.isCreator,
        ),
      ));
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString().replaceFirst('FormatException: ', ''));
        // A failed authorization/join leaves the user on this screen. Restore
        // the requested local devices so retry does not silently lose preview.
        // The panel resumes capture when _joining becomes false below.
      }
    }
    finally { if (mounted) setState(() => _joining = false); }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    // [WAITROOM-APP-2] Fix 5: prejoin always disposes its own controller now
    // — the waiting room never reuses it.
    unawaited(_deviceController.dispose());
    unawaited(_speaker.dispose());
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) unawaited(_speaker.stop());
  }

  Future<void> _cancelBooking() async {
    final yes = await showDialog<bool>(context: context, builder: (c) => AlertDialog(
      title: const Text('Cancel booking?'),
      content: const Text('The server will apply the accepted cancellation policy and return the authoritative result.'),
      actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Keep booking')), FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Cancel'))],
    ));
    if (yes != true || _joining) return;
    try { await widget.gateway.cancelConsultation(widget.bookingId); if (mounted) Navigator.pop(context); }
    catch (e) { if (mounted) setState(() => _error = e.toString()); }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: AD.bg,
    appBar: AppBar(backgroundColor: AD.headerFooter, foregroundColor: AD.onBand(AD.headerFooter), title: const Text('Consultation setup')),
    body: ListView(padding: const EdgeInsets.all(Msg.s5), children: [
      Text(widget.title, style: ADText.appTitle()),
      const SizedBox(height: Msg.s2),
      Text('Private appointment · ${widget.isCreator ? 'Creator' : 'Customer'}', style: ADText.preview()),
      const SizedBox(height: Msg.s4),
      _Check(label: 'Camera permission', value: _camera?.isGranted == true && _cameraAvailable, warning: !_cameraAvailable, detail: _cameraAvailable ? null : 'No camera — joining with audio only'),
      _Check(label: 'Microphone permission', value: _microphone?.isGranted == true),
      _Check(label: 'Connection', value: _network?.verdict == 'green', warning: _network?.verdict == 'yellow', detail: _network == null ? 'Checking…' : _network!.tip),
      const SizedBox(height: Msg.s3),
      // A denied permission can still be an intentional receive-only choice;
      // allow the user to turn that device off rather than blocking the room.
      CommercialDeviceCheckPanel(
        controller: _deviceController,
        captureEnabled: _enabled && !_checking && !_joining,
        cameraGranted: _camera?.isGranted == true,
        microphoneGranted: _microphone?.isGranted == true,
        onReadyChanged: (ready) { if (mounted && ready != _devicesReady) setState(() => _devicesReady = ready); },
        onCameraUnavailable: () { if (mounted && _cameraAvailable) setState(() => _cameraAvailable = false); },
        speakerControl: CommercialSpeakerTestButton(controller: _speaker, enabled: !_joining),
        cameraEnabled: _cameraIntent,
        microphoneEnabled: _microphoneOn,
        onCameraChanged: (v) => setState(() { _cameraOn = v; _devicesReady = false; }),
        onMicrophoneChanged: (v) => setState(() { _microphoneOn = v; _devicesReady = false; }),
      ),
      if (!_enabled) const _Notice(text: 'Consultation joining is not enabled yet.'),
      if (_checking) const Center(child: CircularProgressIndicator()),
      if (_error != null) Text(_error!, style: ADText.preview(c: AD.danger)),
      const SizedBox(height: Msg.s3),
      FilledButton.icon(onPressed: _ready && !_joining ? _join : null, icon: _joining ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2)) : Icon(PhosphorIcons.arrowRight(PhosphorIconsStyle.bold)), label: Text(_joining ? 'Joining securely…' : 'Join consultation')),
      TextButton(onPressed: _joining ? null : _cancelBooking, child: const Text('Cancel booking')),
      TextButton.icon(onPressed: _checking || _joining ? null : _check, icon: Icon(PhosphorIcons.arrowClockwise(PhosphorIconsStyle.regular)), label: const Text('Run checks again')),
    ]),
  );
}

/// [WAITROOM-APP-2] Fix 2: how [CommercialConsultationRoomScreen] pops back
/// when `returnToWaitingRoom` is true — the waiting room (still holding the
/// DO socket) decides what happens next from this, instead of the room
/// screen deciding on its own to end the session.
enum CommercialConsultExit {
  /// The user pressed Leave. The session is NOT ended; the waiting room
  /// resumes with auto-join paused until the roster changes.
  leftManually,

  /// `_refresh` observed the server session has ended. The waiting room
  /// should go straight to the completion/receipt screen.
  ended,
}

class CommercialConsultationRoomScreen extends StatefulWidget {
  const CommercialConsultationRoomScreen({super.key, required this.listingId, required this.bookingId, required this.title, required this.gateway, required this.connector, required this.handoff, required this.session, required this.cameraEnabled, required this.microphoneEnabled, required this.isCreator, this.returnToWaitingRoom = false, this.chatController});
  final String listingId, bookingId, title;
  final CommercialConsultGateway gateway;
  final CommercialGetStreamConnector connector;
  final CommercialGetStreamJoinHandoff handoff;
  final CommercialGetStreamSession session;
  final bool cameraEnabled, microphoneEnabled, isCreator;
  /// [WAITROOM-APP-2] Fix 2: true when this screen was pushed ON TOP of the
  /// waiting room (the WP6 auto-join path) rather than reached directly
  /// (the pre-WP6 fallback, when the server has not landed the waiting-room
  /// grant yet). When true, Leave must NOT end the consultation or show the
  /// completion screen — it pops back to the still-open waiting room, which
  /// owns those decisions. Old direct-join behaviour is unchanged when false.
  final bool returnToWaitingRoom;
  /// [APP-ONLY-TX-APP-2] The waiting room's live chat controller, handed in
  /// by reference — this screen never opens a second socket. Null on the
  /// legacy direct-join path (no waiting room ran first), which hides the
  /// chat button entirely rather than crash on a missing channel.
  final SessionChatController? chatController;
  @override State<CommercialConsultationRoomScreen> createState() => _CommercialConsultationRoomScreenState();
}

class _CommercialConsultationRoomScreenState extends State<CommercialConsultationRoomScreen> {
  Timer? _timer;
  StreamSubscription<CallState>? _sub;
  late CommercialGetStreamSession _session;
  late bool _cameraOn, _microphoneOn;
  bool _busy = false, _ending = false, _reconnecting = false;
  CommercialLiveState? _state;
  CommercialConsultExtensionQuote? _extension;
  String? _error;

  bool get _extensionAvailable => RemoteConfig.commercialConsultExtensionEnabled &&
      RemoteConfig.commercialConsultExtensionMinutes > 0 &&
      RemoteConfig.commercialConsultExtensionRate > 0;

  Call get _call => _session.call;

  @override
  void initState() {
    super.initState();
    _session = widget.session; _cameraOn = widget.cameraEnabled; _microphoneOn = widget.microphoneEnabled;
    _sub = _call.state.valueStream.listen((_) { if (mounted) setState(() {}); });
    _timer = Timer.periodic(const Duration(seconds: 5), (_) => _refresh());
    _refresh();
  }

  Future<void> _refresh() async {
    try {
      final s = await widget.gateway.consultState(widget.bookingId);
      if (!mounted) return;
      setState(() => _state = s);
      if (s.state == LiveServerState.ended || s.state == LiveServerState.reconciliationPending) {
        if (widget.returnToWaitingRoom) {
          // [WAITROOM-APP-2] Fix 2: the waiting room opens Completion itself —
          // this screen just reports that the server session ended.
          if (_ending) return;
          _ending = true; _timer?.cancel();
          await _session.leave();
          if (!mounted) return;
          Navigator.of(context).pop(CommercialConsultExit.ended);
          return;
        }
        await _finish('Session ended');
      }
    } catch (_) { if (mounted) setState(() => _error = 'Session status is temporarily unavailable.'); }
  }

  Future<void> _toggleMic() async { final r = await _call.setMicrophoneEnabled(enabled: !_microphoneOn); if (mounted && r.isSuccess) setState(() => _microphoneOn = !_microphoneOn); }
  Future<void> _toggleCamera() async { final r = await _call.setCameraEnabled(enabled: !_cameraOn); if (mounted && r.isSuccess) setState(() => _cameraOn = !_cameraOn); }

  /// [APP-ONLY-TX-APP-2] Paperclip-in-a-bubble button opens the SAME
  /// waiting-room chat channel — a bottom sheet in portrait, a right-hand
  /// side panel in landscape (video calls default to landscape).
  void _openChat() {
    final controller = widget.chatController;
    if (controller == null) return;
    controller.markRead();
    final landscape = MediaQuery.of(context).orientation == Orientation.landscape;
    if (landscape) {
      showGeneralDialog<void>(
        context: context,
        barrierDismissible: true,
        barrierLabel: 'Chat',
        barrierColor: AD.scrim,
        transitionDuration: Msg.base,
        pageBuilder: (dctx, __, ___) => Align(
          alignment: Alignment.centerRight,
          child: Material(
            color: AD.bg,
            child: SizedBox(
              width: 320,
              height: double.infinity,
              child: SafeArea(
                child: Padding(
                  padding: const EdgeInsets.all(Msg.s3),
                  child: Column(children: [
                    Row(children: [
                      Text('Chat', style: ADText.sectionLabel()),
                      const Spacer(),
                      IconButton(
                        icon: Icon(PhosphorIcons.x(PhosphorIconsStyle.bold)),
                        onPressed: () => Navigator.of(dctx).maybePop(),
                      ),
                    ]),
                    Expanded(child: SingleChildScrollView(child: SessionChatPanel(controller: controller, listHeight: 420))),
                  ]),
                ),
              ),
            ),
          ),
        ),
      );
    } else {
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        backgroundColor: AD.bg,
        builder: (dctx) => Padding(
          padding: EdgeInsets.only(
              bottom: MediaQuery.of(dctx).viewInsets.bottom + Msg.s3, left: Msg.s3, right: Msg.s3, top: Msg.s3),
          child: SafeArea(top: false, child: SessionChatPanel(controller: controller)),
        ),
      );
    }
  }

  Future<void> _extend() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final quote = _extension ?? await widget.gateway.extensionQuote(widget.bookingId);
      if (!mounted) return;
      final yes = await showDialog<bool>(context: context, builder: (c) => AlertDialog(
        title: const Text('Extend this consultation?'),
        content: Text('${quote.minutes} minutes · ${quote.amount} ${quote.currency}\n\nThis exact server quote is held from the customer only after both people agree.'),
        actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Not now')), FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Agree'))],
      ));
      if (yes != true) return;
      final confirmed = await widget.gateway.confirmExtension(widget.bookingId, quote.extensionId, accept: true);
      if (mounted) { setState(() => _extension = confirmed); ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(confirmed.state == 'applied' ? 'Extension applied.' : 'Your consent is recorded; waiting for the other person.'))); }
    } catch (e) { if (mounted) setState(() => _error = e.toString()); }
    finally { if (mounted) setState(() => _busy = false); }
  }

  Future<void> _reconnect() async {
    if (_reconnecting) return;
    setState(() { _reconnecting = true; _error = null; });
    try {
      await _session.leave();
      final handoff = await widget.gateway.authorize(CommercialGetStreamJoinRequest(listingId: widget.listingId, product: CommercialGetStreamProduct.consultation, bookingId: widget.bookingId));
      _session = widget.connector is CommercialGetStreamMediaConnector
          ? await (widget.connector as CommercialGetStreamMediaConnector).connectWithMedia(handoff, cameraEnabled: _cameraOn, microphoneEnabled: _microphoneOn)
          : await widget.connector.connect(handoff);
      await _sub?.cancel();
      _sub = _call.state.valueStream.listen((_) { if (mounted) setState(() {}); });
      if (mounted) setState(() {});
    } catch (e) { if (mounted) setState(() => _error = 'Reconnect failed. Leave safely and try again.'); }
    finally { if (mounted) setState(() => _reconnecting = false); }
  }

  Future<void> _leave() async {
    if (_ending) return;
    final confirm = await showDialog<bool>(context: context, builder: (c) => AlertDialog(title: const Text('Leave consultation?'), content: Text(widget.returnToWaitingRoom ? 'You can rejoin from the waiting room while the slot is still open.' : 'The session remains governed by the booking and provider evidence.'), actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Stay')), FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Leave'))]));
    if (confirm != true) return;
    if (widget.returnToWaitingRoom) {
      // [WAITROOM-APP-2] Fix 2: a deliberate Leave here must NOT end the
      // session — the slot is prepaid and still running (RULEBOOK §2/§3).
      // No `endConsultation`, no completion screen: just leave the GetStream
      // call and hand control back to the waiting room.
      if (_ending) return;
      _ending = true; _timer?.cancel();
      await _session.leave();
      if (!mounted) return;
      Navigator.of(context).pop(CommercialConsultExit.leftManually);
      return;
    }
    try { await widget.gateway.endConsultation(widget.bookingId); } catch (_) {}
    await _finish('You left the consultation');
  }

  Future<void> _reportNoShow() async {
    final yes = await showDialog<bool>(context: context, builder: (c) => AlertDialog(
      title: const Text('Report a no-show?'),
      content: const Text('The server will review signed attendance evidence and the accepted policy. This phone will not guess a refund.'),
      actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Not now')), FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Report'))],
    ));
    if (yes != true || _ending) return;
    try { await widget.gateway.cancelConsultation(widget.bookingId, reason: 'creator_no_show'); } catch (_) {}
    await _finish('No-show reported for server review');
  }

  Future<void> _finish(String heading) async {
    if (_ending) return;
    _ending = true; _timer?.cancel(); await _session.leave();
    if (!mounted) return;
    if (widget.returnToWaitingRoom) {
      // [WAITROOM-APP-3] A7: `_reportNoShow` also routes through here — when
      // pushed on top of the waiting room, ending the session must pop back
      // to it (which opens Completion itself) rather than pushReplacement
      // over a route the waiting room doesn't know was replaced.
      Navigator.of(context).pop(CommercialConsultExit.ended);
      return;
    }
    Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => CommercialConsultationCompletionScreen(title: widget.title, sessionId: _state?.sessionId ?? widget.handoff.sessionId, gateway: widget.gateway, heading: heading, creator: widget.isCreator)));
  }

  @override
  void dispose() { _timer?.cancel(); _sub?.cancel(); if (!_ending) unawaited(_session.leave()); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    final other = _call.state.value.otherParticipants.toList();
    final remaining = _state?.endsAt == null ? null : (_state!.endsAt! - DateTime.now().millisecondsSinceEpoch);
    return PopScope(canPop: false, onPopInvokedWithResult: (didPop, _) { if (!didPop) unawaited(_leave()); }, child: Scaffold(
      backgroundColor: AD.bg,
      appBar: AppBar(backgroundColor: AD.headerFooter, foregroundColor: AD.onBand(AD.headerFooter), title: Text(widget.title), actions: [IconButton(onPressed: _reconnect, icon: Icon(PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.bold))), if (_extensionAvailable) IconButton(onPressed: _extend, icon: Icon(PhosphorIcons.clock(PhosphorIconsStyle.bold))), IconButton(onPressed: _reportNoShow, icon: Icon(PhosphorIcons.warning(PhosphorIconsStyle.bold)))]),
      body: Column(children: [
        Padding(padding: const EdgeInsets.all(Msg.s3), child: Row(children: [Text(_state?.state == LiveServerState.live ? 'CONNECTED' : 'CONNECTING', style: ADText.sectionLabel(c: AD.online)), const Spacer(), if (remaining != null && remaining > 0) Text('${(remaining ~/ 60000)} min remaining', style: ADText.sectionLabel())])),
        if (_error != null) Padding(padding: const EdgeInsets.symmetric(horizontal: Msg.s4), child: Text(_error!, style: ADText.preview(c: AD.danger))),
        Expanded(child: Stack(children: [
          // [AV-AUDIO-ONLY-1] A participant with no published video track is
          // normal (no camera, or camera off), not an error — render the
          // placeholder tile the rest of this lane already uses
          // (commercial_live_screens.dart) instead of an empty renderer.
          if (other.isEmpty) const Center(child: CircularProgressIndicator()) else _ParticipantTile(call: _call, participant: other.first, avatarSize: 96),
          Positioned(right: Msg.s3, bottom: Msg.s3, width: 120, height: 170, child: Container(color: Colors.black, child: _call.state.value.localParticipant == null ? const SizedBox() : _ParticipantTile(call: _call, participant: _call.state.value.localParticipant!, avatarSize: 40, onDark: true))),
        ])),
        Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
          IconButton(onPressed: _toggleMic, icon: Icon(_microphoneOn ? PhosphorIcons.microphone(PhosphorIconsStyle.bold) : PhosphorIcons.microphoneSlash(PhosphorIconsStyle.bold))),
          IconButton(onPressed: _toggleCamera, icon: Icon(_cameraOn ? PhosphorIcons.videoCamera(PhosphorIconsStyle.bold) : PhosphorIcons.videoCameraSlash(PhosphorIconsStyle.bold))),
          // [APP-ONLY-TX-APP-2] Hidden on the legacy direct-join path
          // (no waiting-room channel to read/send through).
          if (widget.chatController != null)
            ListenableBuilder(
              listenable: widget.chatController!,
              builder: (_, __) => Stack(clipBehavior: Clip.none, children: [
                IconButton(onPressed: _openChat, icon: Icon(PhosphorIcons.chatCircleText(PhosphorIconsStyle.bold))),
                if (widget.chatController!.unread > 0)
                  Positioned(
                    right: 2, top: 2,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                      constraints: const BoxConstraints(minWidth: 16),
                      decoration: BoxDecoration(color: AD.danger, borderRadius: Msg.brPill),
                      child: Text('${widget.chatController!.unread}',
                          textAlign: TextAlign.center,
                          style: ADText.timestamp(c: Colors.white)),
                    ),
                  ),
              ]),
            ),
          FilledButton.icon(onPressed: _leave, icon: Icon(PhosphorIcons.phoneDisconnect(PhosphorIconsStyle.bold)), label: const Text('Leave')),
        ]),
        const SizedBox(height: Msg.s3),
      ]),
    ));
  }
}

class CommercialConsultationCompletionScreen extends StatefulWidget {
  const CommercialConsultationCompletionScreen({super.key, required this.title, required this.sessionId, required this.gateway, required this.heading, required this.creator});
  final String title, sessionId, heading;
  final CommercialConsultGateway gateway;
  final bool creator;
  @override State<CommercialConsultationCompletionScreen> createState() => _CommercialConsultationCompletionScreenState();
}
class _CommercialConsultationCompletionScreenState extends State<CommercialConsultationCompletionScreen> {
  CommercialReceiptResponse? _receipt; bool _loading = true;
  @override void initState() { super.initState(); _load(); }
  Future<void> _load() async { final r = await widget.gateway.consultationReceipt(widget.sessionId); if (mounted) setState(() { _receipt = r; _loading = false; }); }
  @override Widget build(BuildContext context) => Scaffold(backgroundColor: AD.bg, appBar: AppBar(backgroundColor: AD.headerFooter, foregroundColor: AD.onBand(AD.headerFooter), title: const Text('Consultation complete')), body: ListView(padding: const EdgeInsets.all(Msg.s5), children: [Text(widget.heading, style: ADText.appTitle()), const SizedBox(height: Msg.s3), Text(widget.title, style: ADText.preview()), const SizedBox(height: Msg.s4), if (_loading) const CircularProgressIndicator() else if (_receipt?.ready != true) const _Notice(text: 'Settlement is still being finalized from signed GetStream evidence.') else const _Notice(text: 'Your server receipt is ready.'), const SizedBox(height: Msg.s4), FilledButton(onPressed: () => Navigator.pop(context), child: const Text('Done'))]));
}

/// [AV-AUDIO-ONLY-1] One participant slot that survives a missing camera:
/// the video track when there is one, otherwise the participant's initials,
/// their name and a mic state icon — the same rule the live lane already
/// applies (`publishedTracks.containsKey(SfuTrackType.video)`).
class _ParticipantTile extends StatelessWidget {
  const _ParticipantTile({required this.call, required this.participant, required this.avatarSize, this.onDark = false});
  final Call call;
  final CallParticipantState participant;
  final double avatarSize;

  /// [AV-AUDIO-ONLY-2] True when this tile is painted on the black self-view
  /// surface. The whole `AD.text*` ramp is INK ON CREAM, so using it there
  /// paints near-black glyphs onto black and the name and mic icon vanish —
  /// the exact trap `AD.onMediaFaint` documents (avatok_dark.dart) and that
  /// `commercial_live_screens.dart` already routes around.
  final bool onDark;

  bool get _large => avatarSize >= 96;

  String get _name => participant.name.isNotEmpty ? participant.name : participant.userId;

  String get _initials {
    final parts = _name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).take(2);
    final letters = parts.map((p) => p.substring(0, 1).toUpperCase()).join();
    return letters.isEmpty ? '?' : letters;
  }

  @override
  Widget build(BuildContext context) {
    if (participant.publishedTracks.containsKey(SfuTrackType.video)) {
      return StreamVideoRenderer(call: call, participant: participant, videoTrackType: SfuTrackType.video);
    }
    final audioOn = participant.publishedTracks.containsKey(SfuTrackType.audio);
    return Center(
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Container(
          width: avatarSize,
          height: avatarSize,
          alignment: Alignment.center,
          decoration: BoxDecoration(color: AD.card, shape: BoxShape.circle),
          child: Text(_initials, style: _large ? ADText.appTitle() : ADText.preview(c: AD.textPrimary)),
        ),
        SizedBox(height: _large ? Msg.s3 : Msg.s2),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: Msg.s2),
          child: Text(_name, maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center, style: ADText.preview(c: onDark ? AD.onBandCream : AD.textPrimary)),
        ),
        const SizedBox(height: Msg.s1),
        Icon(
          audioOn ? PhosphorIcons.microphone(PhosphorIconsStyle.fill) : PhosphorIcons.microphoneSlash(PhosphorIconsStyle.fill),
          size: _large ? 22 : 16,
          color: audioOn ? AD.online : (onDark ? AD.onMediaFaint : AD.textTertiary),
        ),
      ]),
    );
  }
}

class _Check extends StatelessWidget { const _Check({required this.label, required this.value, this.warning = false, this.detail}); final String label; final bool value, warning; final String? detail; @override Widget build(BuildContext context) => ListTile(contentPadding: EdgeInsets.zero, leading: Icon(value ? PhosphorIcons.checkCircle(PhosphorIconsStyle.fill) : PhosphorIcons.warningCircle(PhosphorIconsStyle.regular), color: value ? AD.online : warning ? AD.primaryBadge : AD.danger), title: Text(label), subtitle: Text(detail ?? (value ? 'Ready' : 'Permission required'))); }
class _Notice extends StatelessWidget { const _Notice({required this.text}); final String text; @override Widget build(BuildContext context) => Card(color: AD.card, child: Padding(padding: const EdgeInsets.all(Msg.s3), child: Text(text))); }

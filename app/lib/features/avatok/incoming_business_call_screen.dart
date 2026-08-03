import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/blocking_api.dart';
import '../../core/chat_state.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine_widgets.dart';
import '../../push/push_service.dart';
import 'call_screen.dart' show gIncomingRingingFrom, gIncomingRingingCallId;

/// [DIALPAD-BIZ-CALLS] Named incoming-BUSINESS-call screen — "‹Name› is
/// calling", full screen, with FOUR actions: Accept · Decline · Send to Ava AI
/// Agent (only when the Ava AI Voice Agent is live — [RemoteConfig.voiceAgent])
/// · Block. Because every AvaTOK call is app-to-app, we always know who's
/// calling — never "Unknown caller". Distinct from the plain friend-channel
/// ring (still the native CallKit UI + [CallScreen] unchanged).
///
/// Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md §3 step 3,
/// §8 Phase A, §15.2 (silent block).
///
/// Accept/Decline reuse the SAME plumbing the native CallKit accept/decline
/// actions use ([PushService.acceptRingingCall] / a public wrapper around the
/// private decline router), so behaviour (missed-call log, analytics, status
/// signalling to the caller) is identical either way the callee answers.
/// [CALL-QUICK-REPLY-1 2026-08-01] Quick-reply catalog version. The client sends
/// `quick_reply_id` + this version; the SERVER resolves the text. Bump when the
/// catalog changes so the server can keep resolving an old client's ids.
const int _kQuickReplyCatalogVersion = 1;

class _QuickReply {
  final String id;
  final String text;
  final String emoji;
  const _QuickReply(this.id, this.text, this.emoji);
}

/// v1 catalog — deliberately neutral.
///
/// The original design mock listed "Wife is around", "Husband is here",
/// "In hospital" and "Potty time". Those were cut for v1: they fire from a
/// LOCK SCREEN, so a mis-tap discloses something sensitive about the callee's
/// health or relationships to whoever is calling, they localise badly, and they
/// read as unserious in a professional context. They can return later as an
/// opt-in personality pack the user chooses deliberately.
const List<_QuickReply> kQuickReplies = <_QuickReply>[
  _QuickReply('will_call_back', 'Will call back', '📞'),
  _QuickReply('busy_now', 'Busy right now', '⏳'),
  _QuickReply('in_meeting', 'In a meeting', '💼'),
  _QuickReply('travelling', 'Travelling', '✈️'),
  _QuickReply('cant_talk', "Can't talk", '🤫'),
];

class IncomingBusinessCallScreen extends StatefulWidget {
  final String callId;
  final String fromUid;
  final String fromName;
  final String avatarUrl;
  /// [CALL-IDENTITY-SNAPSHOT-1 2026-08-01] Version tag for the caller's avatar,
  /// stamped server-side from their profile's last-updated time. The on-disk
  /// cache is keyed `avatar:{uid}:{version}` rather than by URL, because CDN
  /// transforms and query-string churn change the URL while the image is
  /// unchanged — keying on the URL would re-download the same photo forever and
  /// still show a blank circle on the frame that matters.
  final String avatarVersion;
  final bool video;

  const IncomingBusinessCallScreen({
    super.key,
    required this.callId,
    required this.fromUid,
    required this.fromName,
    this.avatarUrl = '',
    this.avatarVersion = '',
    this.video = false,
  });

  @override
  State<IncomingBusinessCallScreen> createState() => _IncomingBusinessCallScreenState();
}

class _IncomingBusinessCallScreenState extends State<IncomingBusinessCallScreen> {
  bool _busy = false;
  /// [CALL-TERMINAL-BCAST-1] Guards against a double pop when a local action and
  /// the remote status broadcast (now sub-100ms, not 5s) land back-to-back.
  bool _dismissed = false;
  /// [CALL-SPAM-REPORT-1] When this screen appeared, so a spam report can carry
  /// how long it rang before the user gave up — an instant report on a first
  /// ring reads very differently from one after 20 seconds of deliberation.
  final int _shownAtMs = DateTime.now().millisecondsSinceEpoch;
  StreamSubscription<CallStatusEvent>? _statusSub;
  /// [PIV-2 2026-08-02] Ring-ended subscription — see [initState].
  StreamSubscription<RingEndedEvent>? _ringSub;

  @override
  void initState() {
    super.initState();
    // [AVACALL-INUI-1] Auto-dismiss when the CALLER cancels / the call ends while
    // this screen is up. Without this the branded ring lingered as an
    // un-cancellable screen after the caller hung up (a worse problem now that it
    // can be raised OVER THE LOCK SCREEN in INUI-2). The native CallKit ring is
    // ended by push_service's terminal-status handler in parallel; here we just
    // tear down the branded UI + clear the glare globals.
    _statusSub = callStatusBus.stream.listen((e) {
      if (e.callId != widget.callId) return;
      // [CALL-TERMINAL-BCAST-1 2026-08-01] 'decline'/'declined' (and the two
      // handoff variants) were MISSING here, so when this account's other device
      // — or this device via a redelivered push — declined, the ring screen had no
      // reason to close. Any status that ends the RING closes this screen.
      const terminal = {
        'cancel', 'ended', 'missed', 'no-answer', 'bye', 'hangup',
        'decline', 'declined', 'decline_ava', 'decline_agent',
      };
      if (terminal.contains(e.status)) {
        _dismiss(reason: 'status_${e.status}', status: e.status);
      }
    });
    // [PIV-2 2026-08-02] Close when THIS DEVICE's ring ends, whatever ended it.
    //
    // The subscription above only ever hears the SERVER's `call-status` push.
    // That is enough for a caller cancel, but a decline taken on the CallKit
    // notification is a purely LOCAL event: the device signals `decline`
    // outward to the caller and the server relays it to the CALLER, never back
    // to us. So the caller saw "call declined" while this screen — a separate
    // surface sitting underneath that notification — stayed up with no reason
    // to close. `ringEndedBus` is emitted by `applyRingTransition`, the one
    // reducer every ring-ending path now goes through, so the notification's
    // Decline, this screen's own Decline, and a ring timeout all land here.
    _ringSub = ringEndedBus.stream.listen((e) {
      if (e.callId != widget.callId) return;
      // Preserve the reducer's authoritative outcome. Falling back to this
      // method's `declined` default turned a receptionist handoff into a second
      // local decline when duplicate ring routes were briefly stacked.
      _dismiss(reason: 'ring_ended_${e.status}', status: e.status);
    });
    // FCM is a best-effort wake-up signal, not the source of truth. Firebase
    // can accept a cancellation while Android never invokes the foreground or
    // background handler (as seen in prod call avatok-8ad0e989). Reconcile the
    // authoritative CallRoom state while this route is ringing so a missed
    // push can never strand the branded incoming screen.
    unawaited(_reconcileDurableRing());
  }

  Future<void> _reconcileDurableRing() async {
    const delays = <Duration>[
      Duration(seconds: 1),
      Duration(seconds: 2),
      Duration(seconds: 4),
      Duration(seconds: 6),
      Duration(seconds: 10),
      Duration(seconds: 15),
      Duration(seconds: 20),
    ];
    for (final delay in delays) {
      await Future<void>.delayed(delay);
      if (!mounted || _dismissed) return;
      final status = await PushService.fetchDurableCallStatus(widget.callId);
      if (!mounted || _dismissed) return;
      if (status != null) {
        _dismiss(reason: 'durable_status_$status', status: status);
        return;
      }
    }
  }

  /// [CALL-TERMINAL-BCAST-1 2026-08-01] The ONE way this screen closes.
  ///
  /// Every dismissal site used to call `Navigator.of(context).maybePop()` while
  /// the build wraps everything in `PopScope(canPop: false)` — and `maybePop`
  /// is exactly the API `PopScope` is defined to intercept. `canPop: false`
  /// yields `RoutePopDisposition.doNotPop`, `maybePop` returns false, and with
  /// no `onPopInvoked` callback nothing else happened either. So decline,
  /// accept, block, send-to-agent AND the remote auto-dismiss were all silently
  /// no-ops, and the incoming-call screen stayed on top forever (prod call
  /// avatok-f0c0ef5c — the callee declined and the ring screen never left).
  ///
  /// `canPop: false` is LOAD-BEARING and stays: it blocks the hardware back
  /// button / back gesture so a ringing call can't be swiped away by accident.
  /// The fix is to keep the user-gesture path blocked and give the app an
  /// explicit programmatic exit — `pop()`, which PopScope does not intercept.
  /// Do NOT "fix" this by force-popping from `onPopInvoked`: that turns a
  /// deliberately-blocked back gesture back into an accidental dismissal.
  /// [CALL-REDUCER-1 2026-08-01] Ring-surface teardown is NOT done here. This
  /// method owns exactly one thing — closing this route. Everything else
  /// (CallKit, the lock-screen FSI notification, the ringtone fallback, the
  /// glare globals) belongs to the single reducer, `applyRingTransition`, which
  /// every surface shares. Each button used to re-implement its own subset of
  /// that teardown and each one forgot something different.
  /// [PIV-3 2026-08-02] `status` is the RING transition this dismissal
  /// represents, and it is load-bearing — it is fed straight to
  /// `applyRingTransition`, which marks the call terminal in the cache
  /// `CallSession` consults when a call is accepted. The `'declined'` default
  /// is correct for every dismissal that really does end the ring (decline,
  /// block, spam, quick reply, voicemail) and WRONG for any that does not.
  /// If you add a dismissal path that is not a decline, pass its real status;
  /// pass a non-terminal one (e.g. `'accepted'`) to make the reducer a no-op.
  void _dismiss({required String reason, String status = 'declined'}) {
    // Claim this route before starting asynchronous teardown. The reducer
    // broadcasts `ringEndedBus`; on fast devices that broadcast can re-enter
    // this method before Navigator has disposed the route. Re-entering used to
    // run a second, default `declined` transition during a receptionist handoff.
    if (!mounted || _dismissed) return;
    _dismissed = true;
    // The reducer is idempotent and ordering-aware, so calling it from a local
    // tap AND from the server transition that follows is safe by design.
    unawaited(applyRingTransition(widget.callId, status, source: 'incoming_screen'));
    Analytics.capture('business_call_screen_dismissed', {
      'call_id': widget.callId,
      'reason': reason,
      // [PIV-2 2026-08-02] Both parties + how long the screen was actually up.
      // `reason` now distinguishes WHICH surface closed it — `ring_ended_*`
      // means the reducer did (CallKit notification decline, timeout), while
      // `decline`/`accept` mean this screen's own buttons did. If the stuck-ring
      // bug ever returns, the absence of a matching `business_call_screen_dismissed`
      // after a `call_incoming_declined` for the same call_id is the signature.
      'peer_uid': widget.fromUid,
      'ring_ms': DateTime.now().millisecondsSinceEpoch - _shownAtMs,
      'video': widget.video,
    });
    Navigator.of(context).pop();
  }

  @override
  void dispose() {
    _statusSub?.cancel();
    _ringSub?.cancel();
    super.dispose();
  }

  Map<String, dynamic> get _extra => {
        'callId': widget.callId,
        'from': widget.fromUid,
        'fromName': widget.fromName,
        'kind': widget.video ? 'video' : 'audio',
      };

  void _clearRingGlobals() {
    if (gIncomingRingingCallId == widget.callId) {
      gIncomingRingingFrom = null;
      gIncomingRingingCallId = null;
    }
  }

  Future<void> _endNativeRing() async {
    try { await FlutterCallkitIncoming.endCall(widget.callId); } catch (_) {/* already ended */}
  }

  void _accept() {
    if (_busy) return;
    setState(() => _busy = true);
    final callId = widget.callId;
    final extra = _extra;
    Analytics.capture('business_call_incoming_accept', {'call_id': callId});
    // [ONERING-1 2026-08-02] Hand over our own payload. When the OS ring was
    // suppressed (app foregrounded — this screen IS the only ring surface),
    // there is no CallKit entry to read the call's `extra` back out of, and
    // Accept would otherwise do nothing at all. CallKit still wins whenever it
    // has the call; this is only consulted when the lookup comes back empty.
    // [CALL-ACCEPT-NONBLOCK-1 2026-08-03] Accept is an intent, not a loading
    // screen. The old path kept this route mounted with `_busy=true` while it
    // awaited the Android CallKit bridge and prior-session teardown. If either
    // platform Future stalled, EVERY action on this screen stayed disabled —
    // including Decline — so the whole call UI looked frozen. Start the durable
    // accept first, then close this ring surface immediately. PushService owns
    // the remaining native cleanup and opens CallScreen independently.
    unawaited(_completeAccept(callId, extra));
    // [PIV-3 2026-08-02] MUST pass a non-terminal status. Accepting is the one
    // dismissal here that is NOT a ring-ending transition, and the `status`
    // default is `'declined'` — so this line used to run
    // `applyRingTransition(callId, 'declined')`, whose FIRST cleanup step is
    // `_noteTerminalCall(callId)`. That cache is exactly what
    // `CallSession.start()` reads back on the accepted side
    // (`PushService.wasCallTerminated` -> `_endPreAcceptCancelled`) to honour a
    // cancel that landed before it could subscribe. So accepting could plant
    // the very marker that tells the new session the call was already dead, and
    // kill the call the user just answered — a race decided by whether
    // CallSession subscribed before or after this line.
    // `applyRingTransition` early-returns on a non-terminal status, so this is
    // a deliberate no-op: `acceptRingingCall` above already ended the native
    // ring, and the accept path must not touch the terminal cache at all.
    _dismiss(reason: 'accept', status: 'accepted');
  }

  Future<void> _completeAccept(String callId, Map<String, dynamic> extra) async {
    try {
      await PushService.acceptRingingCall(callId, fallbackExtra: extra);
    } catch (e, st) {
      Analytics.captureException(
        e,
        st,
        handled: true,
        screen: 'incoming_business_call',
        extra: {'stage': 'accept_background', 'call_id': callId},
      );
    }
  }

  Future<void> _decline() async {
    if (_busy) return;
    setState(() => _busy = true);
    Analytics.capture('business_call_incoming_decline', {'call_id': widget.callId});
    // [CALL-TERMINAL-BCAST-1] Tear the UI down FIRST. Declining is an instant,
    // unambiguous user intent; making the screen wait on a network round-trip
    // (declineIncomingCall POSTs /api/call-status) is what made a slow network
    // look like a frozen ring screen. The signalling still runs to completion.
    // Dismiss the Flutter route before waiting on the platform CallKit bridge.
    // On some devices `endCall` can stall while the OS is already tearing down
    // the native ring; awaiting it first leaves this branded screen stranded.
    // `applyRingTransition` performs the same native cleanup best-effort.
    _dismiss(reason: 'decline');
    await PushService.declineIncomingCall(_extra);
  }

  /// Hands the caller to the Ava AI Voice Agent right away (§3 step 4). Phase C
  /// wiring: signals `decline_agent` to the caller, whose CallSession probes
  /// /api/call/no-answer with outcome 'manual_send_to_agent' and bridges into
  /// the Grok realtime session (core/agent_voice_call.dart).
  Future<void> _sendToAgent() async {
    if (_busy) return;
    setState(() => _busy = true);
    Analytics.capture('business_call_incoming_send_to_agent', {'call_id': widget.callId});
    await _endNativeRing();
    _dismiss(reason: 'send_to_agent');
    await PushService.sendToAgentIncomingCall(_extra);
  }

  /// [CALL-DECLINE-IS-TERMINAL-1 2026-08-01] "Receptionist" — stop MY ring and
  /// hand the caller to Ava to leave a message. Distinct from Decline, which
  /// drops the caller immediately (owner ruling A). This is the only action that
  /// signals `decline_ava`.
  Future<void> _receptionist() async {
    if (_busy) return;
    setState(() => _busy = true);
    Analytics.capture('business_call_incoming_receptionist', {'call_id': widget.callId});
    // A receptionist choice ends this device's RING, not the caller's leg.
    // Feed the real handoff status to the reducer and let that one owner clear
    // CallKit + both notifications. Marking this as the default `declined`
    // planted a contradictory local terminal outcome before the command ran.
    _dismiss(reason: 'receptionist', status: 'decline_ava');
    final handedOff = await PushService.receptionistIncomingCall(_extra);
    Analytics.capture('business_call_receptionist_result', {
      'call_id': widget.callId,
      'ok': handedOff,
    });
  }

  /// [CALL-QUICK-REPLY-1 2026-08-01] "Message" — end the call on BOTH ends and
  /// send the caller a canned reply.
  ///
  /// The client sends a quick-reply ID, never the raw display text: the server
  /// owns the catalog so older clients, a localisation change or a modified
  /// client cannot inject arbitrary content, and the copy stays consistent.
  ///
  /// Delivery is deliberately DECOUPLED from termination — the call must end
  /// even if messenger delivery is momentarily unavailable. So the call is torn
  /// down first and the message is enqueued after; a delivery failure never
  /// leaves the ring hanging.
  Future<void> _openQuickReplies() async {
    if (_busy) return;
    final choice = await showModalBottomSheet<_QuickReply>(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (_) => _QuickReplySheet(callerName: _displayName),
    );
    if (choice == null || !mounted) return;
    setState(() => _busy = true);
    Analytics.capture('business_call_incoming_quick_reply', {
      'call_id': widget.callId,
      'quick_reply_id': choice.id,
      'catalog_version': _kQuickReplyCatalogVersion,
    });
    await _endNativeRing();
    _dismiss(reason: 'quick_reply');
    await PushService.quickReplyIncomingCall(
      _extra,
      quickReplyId: choice.id,
      catalogVersion: _kQuickReplyCatalogVersion,
      fallbackText: choice.text,
    );
  }

  /// [CALL-VOICEMAIL-1 2026-08-01] "Voice Mail" — stop my ring, and let the
  /// caller record a message. Their leg stays alive; the recording arrives as a
  /// normal audio message in this thread.
  Future<void> _voicemail() async {
    if (_busy) return;
    setState(() => _busy = true);
    Analytics.capture('business_call_incoming_voicemail', {'call_id': widget.callId});
    await _endNativeRing();
    _dismiss(reason: 'voicemail');
    await PushService.voicemailIncomingCall(_extra);
  }

  /// [CALL-SPAM-REPORT-1 2026-08-01] "Report Spam".
  ///
  /// Asks whether to block as well rather than assuming it. Reporting and
  /// blocking are different intentions — someone may want a suspicious caller
  /// flagged while still allowing future calls through to screening — and a
  /// button labelled "Report" silently blocking would be a surprise.
  Future<void> _reportSpam() async {
    if (_busy) return;
    final alsoBlock = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: AD.card,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 12),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Report spam', style: ADText.appTitle(c: AD.textPrimary)),
            const SizedBox(height: 6),
            Text('The call ends and $_displayName is reported.', style: ADText.preview(c: AD.textSecondary)),
            ListTile(contentPadding: EdgeInsets.zero, title: Text('Report only', style: ADText.preview(c: AD.textPrimary)), onTap: () => Navigator.of(sheetContext).pop(false)),
            ListTile(contentPadding: EdgeInsets.zero, title: Text('Report and block', style: ADText.preview(c: AD.destructiveBg)), onTap: () => Navigator.of(sheetContext).pop(true)),
            TextButton(onPressed: () => Navigator.of(sheetContext).pop(), child: const Text('Cancel')),
          ]),
        ),
      ),
    );
    if (alsoBlock == null || !mounted) return; // cancelled — keep ringing
    setState(() => _busy = true);
    Analytics.capture('business_call_incoming_report_spam', {
      'call_id': widget.callId, 'also_block': alsoBlock,
    });
    if (alsoBlock) {
      // Local flag mirrors the server block so the thread hides immediately.
      try { await ChatFlagsStore().toggle('blocked', '1:${widget.fromUid}'); } catch (_) {/* best-effort */}
    }
    await _endNativeRing();
    _dismiss(reason: alsoBlock ? 'spam_and_block' : 'spam');
    await PushService.reportSpamIncomingCall(
      _extra,
      alsoBlock: alsoBlock,
      ringDurationMs: DateTime.now().millisecondsSinceEpoch - _shownAtMs,
    );
  }

  /// Silent, account-level block (§15.2): the caller sees normal ringing then
  /// the standard no-answer card — never told they're blocked. Blocks calls to
  /// ALL of my numbers, voicemail, the agent, and messaging.
  Future<void> _block() async {
    if (_busy) return;
    setState(() => _busy = true);
    Analytics.capture('business_call_incoming_block', {'call_id': widget.callId});
    try { await ChatFlagsStore().toggle('blocked', '1:${widget.fromUid}'); } catch (_) {/* best-effort */}
    unawaited(BlockingApi.blockAccount(widget.fromUid));
    await _endNativeRing();
    _dismiss(reason: 'block');
    // Silent — same signal as a plain decline, no "you were blocked" tell.
    await PushService.declineIncomingCall(_extra);
  }

  /// [CALL-IDENTITY-SNAPSHOT-1] The name we actually paint. `fromName` is now
  /// the caller's AvaTOK PROFILE name resolved server-side ("Arti Singh"), not
  /// their Google account name. A callee-local contact override may layer on top
  /// of this for display, but must never be written back anywhere.
  String get _displayName =>
      widget.fromName.trim().isEmpty ? 'AvaTOK caller' : widget.fromName.trim();

  @override
  Widget build(BuildContext context) {
    final name = _displayName;
    return PopScope(
      canPop: false,
      child: Scaffold(
        backgroundColor: AD.bg,
        body: SafeArea(
          child: Padding(
            // [PIV-5 2026-08-02] Horizontal padding is applied PER SECTION, not
            // to the whole column. The action row needs the full width to divide
            // into four; the caller's name needs a margin so a long one doesn't
            // run to the bezel. A single 24px page inset served the text and
            // starved the row — it left each of the four slots ~78px, which is
            // narrower than the word "Receptionist" renders at, so that one
            // label alone got scaled down and the row looked mismatched.
            padding: const EdgeInsets.symmetric(vertical: 20),
            child: Column(
              children: [
                const Spacer(),
                Container(
                  decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: AD.borderAvatar, width: 3)),
                  child: Avatar(seed: widget.fromUid, name: name, size: 132,
                      avatarUrl: widget.avatarUrl.isEmpty ? null : widget.avatarUrl),
                ),
                const SizedBox(height: 24),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 24),
                  child: Column(children: [
                    Text('$name is calling',
                        textAlign: TextAlign.center,
                        style: ADText.appTitle(c: AD.textPrimary)),
                    const SizedBox(height: 8),
                    Text('This is an AvaTOK to AvaTOK call',
                        textAlign: TextAlign.center,
                        style: ADText.preview(c: AD.textSecondary)),
                  ]),
                ),
                const Spacer(),
                // ── [PIV-4 2026-08-02] ONE action row ─────────────────────────
                // Was two stacked rows (Receptionist alone above; Report Spam /
                // Decline / Accept below) separated by 26px, with only 8px of
                // breathing room beneath the whole cluster. On a real handset
                // that read as cramped and lopsided — a single orphaned button
                // hovering over a tight huddle of three.
                //
                // All four now sit on one row in equal `Expanded` slots, so the
                // spacing is divided from the available width and stays even on
                // any screen size instead of relying on hand-tuned 14/18px gaps
                // that only balanced at one width.
                //
                // The old design encoded "don't mis-tap the irreversible one" as
                // SIZE (a 46px Report Spam next to a 58px Accept). A single row
                // needs uniform footprints to look deliberate, so that intent now
                // rides on COLOUR and ORDER instead: Decline/Accept are solid and
                // saturated, Report Spam/Receptionist are recessive outlines, and
                // Report Spam sits at the far edge NEXT TO DECLINE — never
                // adjacent to Accept. Keep it that way.
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 6),
                  child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: _CallAction(
                        icon: PhosphorIcons.shieldWarning(PhosphorIconsStyle.bold),
                        label: 'Report\nSpam',
                        tint: AD.danger,
                        filled: false,
                        onTap: _busy ? null : _reportSpam,
                      ),
                    ),
                    Expanded(
                      child: _CallAction(
                        icon: PhosphorIcons.phoneX(PhosphorIconsStyle.bold),
                        label: 'Decline',
                        tint: AD.destructiveBg,
                        filled: true,
                        onTap: _busy ? null : _decline,
                      ),
                    ),
                    Expanded(
                      child: _CallAction(
                        icon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
                        label: 'Accept',
                        tint: AD.incomingCall,
                        filled: true,
                        onTap: _busy ? null : _accept,
                      ),
                    ),
                    Expanded(
                      child: _CallAction(
                        icon: PhosphorIcons.headset(PhosphorIconsStyle.bold),
                        label: 'Receptionist',
                        tint: AD.textSecondary,
                        filled: false,
                        onTap: _busy ? null : _receptionist,
                      ),
                    ),
                  ],
                ),
                ),
                // Real breathing room under the row (was 8px). Sits inside
                // SafeArea, so this is clear space ABOVE the gesture bar rather
                // than padding fighting with it.
                const SizedBox(height: 36),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// [PIV-4 2026-08-02] The ONE action control on this screen.
///
/// Replaces three near-identical widgets (`_ActionButton` 58px solid,
/// `_MiniAction` 46px tinted, `_SoftAction` 54px outlined) that existed only to
/// give each button a different diameter. Three sizes in one row is what made
/// the cluster look uneven, and three classes meant a styling change had to be
/// made three times and was made inconsistently.
///
/// Every action now has an IDENTICAL footprint — same circle, same fixed label
/// box — so a row of them is visually regular whatever the labels say.
/// Emphasis comes from [filled]: solid saturated fill for the two answers a
/// user is reaching for (Decline/Accept), a recessive tinted outline for the
/// side actions.
class _CallAction extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color tint;
  /// Solid = primary call action. Outlined = recessive side action.
  final bool filled;
  final VoidCallback? onTap;
  const _CallAction({
    required this.icon,
    required this.label,
    required this.tint,
    required this.filled,
    required this.onTap,
  });

  static const double _diameter = 58;
  /// Fixed so a one-line label ("Accept") and a two-line one ("Report\nSpam")
  /// occupy the same height and every circle in the row stays on one baseline.
  static const double _labelBox = 32;

  @override
  Widget build(BuildContext context) {
    final dim = onTap == null;
    return GestureDetector(
      onTap: onTap,
      // Opaque so the whole slot is tappable, not just the circle's pixels —
      // this screen is answered in a hurry and often without looking.
      behavior: HitTestBehavior.opaque,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Container(
          width: _diameter, height: _diameter,
          decoration: BoxDecoration(
            color: filled
                ? tint.withValues(alpha: dim ? 0.4 : 1.0)
                : tint.withValues(alpha: dim ? 0.06 : 0.14),
            shape: BoxShape.circle,
            border: Border.all(
              color: filled
                  ? AD.borderAvatar
                  : tint.withValues(alpha: dim ? 0.15 : 0.30),
              width: filled ? 2 : 1,
            ),
          ),
          child: Icon(
            icon,
            size: 26,
            // On a solid fill the icon reads as a knockout against the bg
            // colour; on an outline it takes the tint itself.
            color: filled ? AD.bg : tint.withValues(alpha: dim ? 0.4 : 1.0),
          ),
        ),
        const SizedBox(height: 7),
        SizedBox(
          height: _labelBox,
          child: Center(
            // [PIV-5 2026-08-02] `FittedBox` is a SAFETY NET, not the layout.
            //
            // It scales each label independently, so as soon as ONE label
            // genuinely overflows it renders smaller than its neighbours and the
            // row looks mismatched — which is exactly what "Receptionist" did.
            // The real cause was tracking: `sectionLabel` is 11px with 0.88px
            // letter-spacing (tuned for short all-caps headers like PINNED), and
            // across 12 characters that spacing alone adds ~10px, pushing the
            // word past its slot.
            //
            // So the label now uses the same 11px size with normal tracking and
            // fits at full size in every slot. Keep the FittedBox anyway: it
            // costs nothing and still guarantees no overflow at large system
            // font scales or on an unusually narrow device.
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(
                label,
                textAlign: TextAlign.center,
                style: ADText.sectionLabel(
                    c: filled ? AD.textPrimary : AD.textSecondary)
                    .copyWith(letterSpacing: 0.1),
              ),
            ),
          ),
        ),
      ]),
    );
  }
}

/// [CALL-QUICK-REPLY-1] Bottom sheet of canned replies. Returns the chosen
/// [_QuickReply] (or null if dismissed) — it performs no side effects itself, so
/// the call-teardown ordering stays in one place on the screen.
class _QuickReplySheet extends StatelessWidget {
  final String callerName;
  const _QuickReplySheet({required this.callerName});

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: AD.card,
        borderRadius: BorderRadius.vertical(top: Radius.circular(26)),
      ),
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 30),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Container(
          width: 44, height: 5,
          decoration: BoxDecoration(
            color: AD.textPrimary.withValues(alpha: 0.16),
            borderRadius: BorderRadius.circular(999),
          ),
        ),
        const SizedBox(height: 16),
        Align(
          alignment: Alignment.centerLeft,
          child: Text('Quick replies', style: ADText.appTitle(c: AD.textPrimary)),
        ),
        const SizedBox(height: 4),
        Align(
          alignment: Alignment.centerLeft,
          child: Text('$callerName gets this as a message — the call ends quietly',
              style: ADText.preview(c: AD.textSecondary)),
        ),
        const SizedBox(height: 14),
        ...kQuickReplies.map((r) => Padding(
              padding: const EdgeInsets.only(bottom: 7),
              child: GestureDetector(
                onTap: () => Navigator.of(context).pop(r),
                behavior: HitTestBehavior.opaque,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
                  decoration: BoxDecoration(
                    color: AD.textPrimary.withValues(alpha: 0.05),
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Row(children: [
                    Text(r.emoji, style: const TextStyle(fontSize: 19)),
                    const SizedBox(width: 13),
                    Expanded(
                      child: Text(r.text, style: ADText.appTitle(c: AD.textPrimary)),
                    ),
                  ]),
                ),
              ),
            )),
      ]),
    );
  }
}

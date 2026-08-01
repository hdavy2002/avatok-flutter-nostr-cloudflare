import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/blocking_api.dart';
import '../../core/chat_state.dart';
import '../../core/remote_config.dart';
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
      if (terminal.contains(e.status)) _dismiss(reason: 'status_${e.status}');
    });
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
  void _dismiss({required String reason, String status = 'declined'}) {
    // The reducer is idempotent and ordering-aware, so calling it from a local
    // tap AND from the server transition that follows is safe by design.
    unawaited(applyRingTransition(widget.callId, status, source: 'incoming_screen'));
    if (!mounted || _dismissed) return;
    _dismissed = true;
    Analytics.capture('business_call_screen_dismissed', {
      'call_id': widget.callId,
      'reason': reason,
    });
    Navigator.of(context).pop();
  }

  @override
  void dispose() {
    _statusSub?.cancel();
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

  Future<void> _accept() async {
    if (_busy) return;
    setState(() => _busy = true);
    Analytics.capture('business_call_incoming_accept', {'call_id': widget.callId});
    await PushService.acceptRingingCall(widget.callId); // ends the CallKit ring + opens CallScreen
    _dismiss(reason: 'accept');
  }

  Future<void> _decline() async {
    if (_busy) return;
    setState(() => _busy = true);
    Analytics.capture('business_call_incoming_decline', {'call_id': widget.callId});
    // [CALL-TERMINAL-BCAST-1] Tear the UI down FIRST. Declining is an instant,
    // unambiguous user intent; making the screen wait on a network round-trip
    // (declineIncomingCall POSTs /api/call-status) is what made a slow network
    // look like a frozen ring screen. The signalling still runs to completion.
    await _endNativeRing();
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
    await _endNativeRing();
    _dismiss(reason: 'receptionist');
    await PushService.receptionistIncomingCall(_extra);
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
    final alsoBlock = await showDialog<bool>(
      context: context,
      builder: (dctx) => AlertDialog(
        backgroundColor: AD.card,
        title: Text('Report as spam?', style: ADText.appTitle(c: AD.textPrimary)),
        content: Text(
          'We\'ll flag $_displayName. Do you also want to block them so they '
          'can\'t call you again?',
          style: ADText.preview(c: AD.textSecondary),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dctx).pop(null),
            child: Text('Cancel', style: ADText.preview(c: AD.textSecondary)),
          ),
          TextButton(
            onPressed: () => Navigator.of(dctx).pop(false),
            child: Text('Report only', style: ADText.preview(c: AD.textPrimary)),
          ),
          TextButton(
            onPressed: () => Navigator.of(dctx).pop(true),
            child: Text('Report & block', style: ADText.preview(c: AD.destructiveBg)),
          ),
        ],
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
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 20),
            child: Column(
              children: [
                const Spacer(),
                Container(
                  decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: AD.borderAvatar, width: 3)),
                  child: Avatar(seed: widget.fromUid, name: name, size: 132,
                      avatarUrl: widget.avatarUrl.isEmpty ? null : widget.avatarUrl),
                ),
                const SizedBox(height: 24),
                Text('$name is calling',
                    textAlign: TextAlign.center,
                    style: ADText.appTitle(c: AD.textPrimary)),
                const SizedBox(height: 8),
                Text('This is an AvaTOK to AvaTOK call',
                    style: ADText.preview(c: AD.textSecondary)),
                const SizedBox(height: 12),
                // Cost chip from the design. AvaTOK-to-AvaTOK is free; the
                // callee seeing that up front is the point of the screen.
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 5),
                  decoration: BoxDecoration(
                    color: AD.incomingCall.withValues(alpha: 0.12),
                    border: Border.all(color: AD.incomingCall.withValues(alpha: 0.25)),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text('Call cost: Free',
                      style: ADText.preview(c: AD.incomingCall)),
                ),
                const Spacer(),
                // ── Secondary row: non-destructive alternatives to answering ──
                // [CALL-DECLINE-IS-TERMINAL-1] Receptionist lives HERE, not
                // behind Decline. Decline drops the caller; Receptionist keeps
                // their leg alive and hands them to Ava. Two buttons because
                // they are two different outcomes for the person calling.
                Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  _SoftAction(
                    icon: PhosphorIcons.chatCircle(PhosphorIconsStyle.bold),
                    label: 'Message',
                    onTap: _busy ? null : _openQuickReplies,
                  ),
                  const SizedBox(width: 34),
                  _SoftAction(
                    icon: PhosphorIcons.headset(PhosphorIconsStyle.bold),
                    label: 'Receptionist',
                    onTap: _busy ? null : _receptionist,
                  ),
                  const SizedBox(width: 34),
                  _SoftAction(
                    icon: PhosphorIcons.voicemail(PhosphorIconsStyle.bold),
                    label: 'Voice Mail',
                    onTap: _busy ? null : _voicemail,
                  ),
                  if (RemoteConfig.voiceAgent) ...[
                    const SizedBox(width: 34),
                    _SoftAction(
                      icon: PhosphorIcons.robot(PhosphorIconsStyle.bold),
                      label: 'Send to Ava',
                      onTap: _busy ? null : _sendToAgent,
                    ),
                  ],
                ]),
                const SizedBox(height: 26),
                // Primary row. Decline and Accept are the big targets; Report
                // Spam and Block are smaller and outboard, because they are
                // irreversible-ish actions sitting on a high-pressure screen and
                // a mis-tap should not land on one.
                Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  _MiniAction(
                    icon: PhosphorIcons.shieldWarning(PhosphorIconsStyle.bold),
                    label: 'Report\nSpam',
                    tint: AD.danger,
                    onTap: _busy ? null : _reportSpam,
                  ),
                  const SizedBox(width: 14),
                  _ActionButton(
                    icon: PhosphorIcons.phoneX(PhosphorIconsStyle.bold),
                    label: 'Decline',
                    color: AD.destructiveBg,
                    onTap: _busy ? null : _decline,
                  ),
                  const SizedBox(width: 18),
                  _ActionButton(
                    icon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
                    label: 'Accept',
                    color: AD.incomingCall,
                    onTap: _busy ? null : _accept,
                  ),
                  const SizedBox(width: 14),
                  _MiniAction(
                    icon: PhosphorIcons.prohibit(PhosphorIconsStyle.bold),
                    label: 'Block',
                    tint: AD.textSecondary,
                    onTap: _busy ? null : _block,
                  ),
                ]),
                const SizedBox(height: 8),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ActionButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback? onTap;
  const _ActionButton({required this.icon, required this.label, required this.color, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Column(mainAxisSize: MainAxisSize.min, children: [
      GestureDetector(
        onTap: onTap,
        child: Container(
          width: 58, height: 58,
          decoration: BoxDecoration(
            color: onTap == null ? color.withValues(alpha: 0.4) : color,
            shape: BoxShape.circle,
            border: Border.all(color: AD.borderAvatar, width: 2),
          ),
          child: Icon(icon, color: AD.bg, size: 26),
        ),
      ),
      const SizedBox(height: 6),
      Text(label, style: ADText.sectionLabel(c: AD.textPrimary), textAlign: TextAlign.center),
    ]);
  }
}

/// A small outboard control for the irreversible-ish actions (Report Spam,
/// Block). Deliberately smaller than Decline/Accept and set apart from them:
/// this screen is answered under time pressure, often half-awake, and a mis-tap
/// must not land on something the user cannot take back.
class _MiniAction extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color tint;
  final VoidCallback? onTap;
  const _MiniAction({required this.icon, required this.label, required this.tint, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final dim = onTap == null;
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Container(
          width: 46, height: 46,
          decoration: BoxDecoration(
            color: tint.withValues(alpha: dim ? 0.06 : 0.14),
            shape: BoxShape.circle,
            border: Border.all(color: tint.withValues(alpha: 0.3)),
          ),
          child: Icon(icon, color: tint.withValues(alpha: dim ? 0.4 : 1.0), size: 19),
        ),
        const SizedBox(height: 6),
        Text(label,
            textAlign: TextAlign.center,
            style: ADText.sectionLabel(c: AD.textSecondary)),
      ]),
    );
  }
}

/// A quiet, outlined circular action. Visually subordinate to the three primary
/// call controls so a panicked tap on a ringing phone lands on Accept/Decline,
/// not on an irreversible side action.
class _SoftAction extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  const _SoftAction({required this.icon, required this.label, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final dim = onTap == null;
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Container(
          width: 54, height: 54,
          decoration: BoxDecoration(
            color: AD.textPrimary.withValues(alpha: dim ? 0.03 : 0.06),
            shape: BoxShape.circle,
            border: Border.all(color: AD.textPrimary.withValues(alpha: 0.10)),
          ),
          child: Icon(icon,
              color: AD.textSecondary.withValues(alpha: dim ? 0.4 : 1.0), size: 22),
        ),
        const SizedBox(height: 7),
        Text(label, style: ADText.sectionLabel(c: AD.textSecondary)),
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

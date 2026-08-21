// STREAM-LANE: depends on the currently-commented-out pubspec entries
// `stream_video_flutter` / `stream_video_push_notification` (see
// app/pubspec.yaml and stream_lane.dart's library comment). SDK imports will
// not resolve until those two lines are uncommented.
//
// A thin FOREGROUND in-app ringing screen only — the system incoming-call UI
// (lock-screen / full-screen intent) is owned by the SDK's native push layer
// (stream_push_glue.dart's background handler), not by this widget. Visual
// language mirrors features/avatok/incoming_business_call_screen.dart (AD.*
// tokens, PhosphorIcons accept/decline row) WITHOUT importing that file.
//
// [STREAM-INCOMING-1 2026-08-21] Minimum viable completeness pass (task item
// 4): still Accept/Decline only — voicemail, receptionist, message, report
// spam, block caller and first-answer-wins-across-devices are explicitly OUT
// OF SCOPE here (bigger, later issue; see this file's final doc block for the
// gap list). What is now in scope: the screen emits its own journey
// (`stream_lane_ring_screen_shown`/`..._dismissed`), decline is tagged with a
// reason, and — the one correctness gap, not just a telemetry gap — the ring
// screen now closes itself when the CALLER cancels before the callee answers,
// instead of sitting on screen ringing for a call that no longer exists.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:stream_video_flutter/stream_video_flutter.dart';

import '../core/avatar.dart';
import '../core/ui/avatok_dark.dart';
import '../core/ui/messenger_theme.dart';
// REVIEW FIX 2026-08-21: use the app's REAL root navigator key (assigned to
// MaterialApp in main.dart:379) instead of a never-assigned local key — with
// the local key, `currentContext` was always null and the foreground ring
// screen silently never appeared. Import cycles are legal in Dart; the
// push_service → glue → lane → this-file cycle resolves fine.
import '../core/analytics.dart';
import '../push/push_service.dart' show navigatorKey;
import 'stream_call_service.dart';
import 'stream_call_telemetry.dart';

/// Global navigator key access point so [StreamLane.init]'s
/// `incomingCall` listener can push this screen without threading a
/// BuildContext through the SDK callback. Set once from the app shell.
class StreamIncomingScreen extends StatefulWidget {
  const StreamIncomingScreen({super.key, required this.call});

  final Call call;

  /// Shown by [StreamLane] when a call rings in while the app is foregrounded.
  /// Uses the root navigator so it can appear over whatever screen is open,
  /// mirroring how the old lane's branded incoming screen is surfaced from
  /// push_service.dart.
  static void showForCall(Call call) {
    final ctx = navigatorKey.currentContext;
    if (ctx == null) return;
    Navigator.of(ctx, rootNavigator: true).push(
      MaterialPageRoute(
        fullscreenDialog: true,
        builder: (_) => StreamIncomingScreen(call: call),
      ),
    );
  }

  @override
  State<StreamIncomingScreen> createState() => _StreamIncomingScreenState();
}

class _StreamIncomingScreenState extends State<StreamIncomingScreen> {
  StreamSubscription<CallState>? _sub;
  bool _acting = false; // Accept/Decline in flight — don't double-dismiss.
  bool _dismissed = false; // Any dismissal path already ran.

  @override
  void initState() {
    super.initState();
    final callId = widget.call.callCid.value;
    Analytics.capture('stream_lane_ring_screen_shown', <String, Object>{
      'call_id': callId,
      'provider': 'stream',
      'role': 'callee',
      'app_lifecycle': StreamCallTelemetry.lifecycleState(),
      'user_email': Analytics.currentEmail ?? '',
    });

    // [STREAM-INCOMING-1] Close this screen when the call becomes terminal
    // while we are still ringing — the most common cause is the CALLER
    // cancelling before we answer (StreamCallService.cancelRinging sends
    // `reject(reason: CallRejectReason.cancel())`, which the coordinator
    // relays to every other call member, us included, over this same state
    // stream — see stream_call_service.dart's `cancelRinging` doc comment
    // for the full SDK evidence chain). It is equally the right thing to do
    // for any other reason the call ends while unanswered (caller's own
    // network drop, timeout, etc.) — a ring screen for a dead call is a
    // ghost ring on OUR side just as much as leaving the caller's phone
    // ringing is a ghost ring on theirs.
    //
    // verified: packages/stream_video/lib/src/state_emitter.dart +
    // packages/stream_video/lib/src/call/call.dart (`Call.state` is a
    // `StateEmitter<CallState>`; `.valueStream` is the same stream
    // `stream_call_screen.dart` already drives its whole UI from).
    _sub = widget.call.state.valueStream.listen((state) {
      if (_dismissed || _acting) return;
      final status = state.status;
      if (status is! CallStatusDisconnected) return;
      _dismissForRemoteEnd(status.reason);
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  void _emitDismissed(String reason) {
    if (_dismissed) return;
    _dismissed = true;
    Analytics.capture('stream_lane_ring_screen_dismissed', <String, Object>{
      'call_id': widget.call.callCid.value,
      'provider': 'stream',
      'role': 'callee',
      'app_lifecycle': StreamCallTelemetry.lifecycleState(),
      'user_email': Analytics.currentEmail ?? '',
      'reason': reason,
    });
  }

  void _dismissForRemoteEnd(Object? sdkReason) {
    _emitDismissed('remote_ended:${sdkReason.runtimeType}');
    if (!mounted) return;
    Navigator.of(context).maybePop();
  }

  Future<void> _onDecline() async {
    if (_acting || _dismissed) return;
    setState(() => _acting = true);
    _emitDismissed('declined');
    await StreamCallService.instance.decline(
      widget.call,
      peerId: widget.call.state.value.createdByUser.id,
    );
    if (mounted) Navigator.of(context).maybePop();
  }

  Future<void> _onAccept() async {
    if (_acting || _dismissed) return;
    setState(() => _acting = true);
    _emitDismissed('accepted');
    await StreamCallService.instance.accept(context, widget.call);
  }

  @override
  Widget build(BuildContext context) {
    // verified: packages/stream_video/lib/src/models/call_metadata.dart
    // (`class CallUser` has `id`/`name`/`image`) +
    // packages/stream_video/lib/src/call_state.dart (`CallState.createdByUser`
    // is a `CallUser`, defaulting to `CallUser.empty()`). There is no
    // `callerId`/`createdBy` field directly on `CallState`.
    final caller = widget.call.state.value.createdByUser;
    final callerName = caller.name.isNotEmpty ? caller.name : caller.id;
    return Scaffold(
      backgroundColor: AD.bg,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: Msg.s5, vertical: Msg.s6),
          child: Column(
            children: [
              const Spacer(),
              Avatar(seed: callerName, name: callerName, size: 120),
              const SizedBox(height: Msg.s4),
              Text(
                callerName,
                style: const TextStyle(
                  color: AD.textPrimary,
                  fontSize: 24,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                'Incoming AvaTOK call…',
                style: TextStyle(color: AD.textSecondary, fontSize: 14),
              ),
              const Spacer(),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: [
                  _ringButton(
                    icon: PhosphorIcons.phoneDisconnect(PhosphorIconsStyle.fill),
                    bg: AD.primaryBadge,
                    onTap: _onDecline,
                  ),
                  _ringButton(
                    icon: PhosphorIcons.phone(PhosphorIconsStyle.fill),
                    bg: AD.haldi,
                    onTap: _onAccept,
                  ),
                ],
              ),
              const SizedBox(height: Msg.s5),
            ],
          ),
        ),
      ),
    );
  }

  Widget _ringButton({
    required PhosphorIconData icon,
    required Color bg,
    required VoidCallback onTap,
  }) {
    return InkWell(
      onTap: onTap,
      customBorder: const CircleBorder(),
      child: Container(
        width: 68,
        height: 68,
        decoration: BoxDecoration(shape: BoxShape.circle, color: bg),
        child: Icon(icon, color: AD.tabActiveLabel, size: 30),
      ),
    );
  }
}

// (former local navigatorKeyForStreamLane removed — see REVIEW FIX above.)
//
// ---------------------------------------------------------------------------
// Gap list — what a FULL incoming-call implementation still needs
// (deliberately not built here; task explicitly scoped this out as bigger,
// later work). Tracked so this doc block is the one place that says what is
// still missing, matching audit item 3 in
// Specs/PLAN-STREAM-ONLY-CALLS-2026-08-21.md §8:
// ---------------------------------------------------------------------------
// - Voicemail / receptionist routing on decline or no-answer.
// - In-call "Message" quick-reply instead of answering.
// - Report spam / Block caller from the ring screen.
// - First-answer-wins across multiple signed-in devices (this screen has no
//   awareness of a sibling ring screen on another device accepting first —
//   `CallRejectReason.userRespondedElsewhere()` exists in the SDK for
//   exactly this and is unused here).
// - A reason PICKER for decline (this pass added the plumbing — `decline()`
//   takes a `reason` string and emits it — but the UI still always sends the
//   single default; there is no "I'm driving" / "Call back later" sheet).
// - Ringtone / vibration / full-screen lock-screen presentation for this
//   FOREGROUND screen specifically (the native background ring path in
//   `stream_push_glue.dart` is a different surface, owned by another agent).

// STREAM-LANE: Ava receptionist surface for the Stream call lane.
//
// [STREAM-RECEPTIONIST-1 2026-08-24] Reported the same day: calling a phone
// that was off rang forever on this lane and never reached Ava. The four-ring
// handoff lives in the legacy CallRoom DO, which counts the CALLEE's
// device-ringing receipts — a dead phone sends none, so nothing ever counted
// and nothing ever fired. The Stream lane does not create a CallRoom at all, so
// it had no ring accounting whatsoever.
//
// This screen is the client half of the bridge. It exists because
// `ReceptionistCall` turned out to be lane-agnostic: given a callee uid it
// mints its own session through `/api/receptionist/start` (whose `call_id` is
// OPTIONAL — every CALL_ROOMS interaction inside it is guarded), opens its own
// WebSocket and owns its own audio. It needs nothing from the legacy lane, so
// nothing here imports features/avatok/call_screen.dart — the two lanes must
// stay independent, exactly as stream_call_screen.dart's header says.
//
// Visual language deliberately mirrors stream_call_screen.dart (AD.* tokens,
// PhosphorIcons control row) rather than the old lane's `_ReceptionistDuo`.
library;

import 'dart:async';

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../core/analytics.dart';
import '../core/ava_identity.dart';
import '../core/avatar.dart';
import '../core/receptionist_call.dart';
import '../core/ui/avatok_dark.dart';
import '../core/ui/messenger_theme.dart';
import '../main.dart' show RootFlow;

/// What the Ava surface is showing. Deliberately separate from
/// `stream_call_screen.dart`'s `_Phase`: this screen never has a Stream call,
/// so `reconnecting`/`live` there mean media states that cannot occur here.
enum _AvaPhase { connecting, live, wrapup, failed }

/// Hands a Stream-lane caller to the callee's Ava receptionist.
///
/// Mounted by [StreamCallService.showAva] in two situations, both of which have
/// already ENDED any Stream call before arriving here:
///  * the Worker refused the dial with `code: 'receptionist'` because presence
///    proved the callee is not checking in (`activationMode: 'unreachable'`);
///  * the caller's own ring window elapsed unanswered (`'rings'`).
class StreamAvaScreen extends StatefulWidget {
  const StreamAvaScreen({
    super.key,
    required this.peerId,
    required this.activationMode,
    this.peerName,
    this.peerAvatarUrl,
    this.peerEmail,
    this.myName,
    this.myAvatarUrl,
    this.traceId,
    this.callId,
  });

  /// The callee whose receptionist this is — Ava answers on THEIR behalf, and
  /// their settings and wallet are what gate the session.
  final String peerId;

  /// `'rings'` (rang, nobody picked up) or `'unreachable'` (phone off / not
  /// checking in). These are two INDEPENDENT owner toggles server-side
  /// (`recept_avatok_not_picked_up` / `recept_avatok_unreachable`), so the value
  /// must be honest — sending `'rings'` for an off phone would consult the wrong
  /// switch. Passed straight through to `/api/receptionist/start`.
  final String activationMode;

  final String? peerName;
  final String? peerAvatarUrl;
  final String? peerEmail;

  /// The caller's own name/photo, for the "you ↔ Ava" pair.
  final String? myName;
  final String? myAvatarUrl;

  final String? traceId;

  /// The Stream call id this handoff came from, when there was one. Carried for
  /// telemetry correlation only — a `'rings'` handoff has one, an `'unreachable'`
  /// refusal never created a Stream call and so has none.
  final String? callId;

  @override
  State<StreamAvaScreen> createState() => _StreamAvaScreenState();
}

class _StreamAvaScreenState extends State<StreamAvaScreen> {
  ReceptionistCall? _recept;
  _AvaPhase _phase = _AvaPhase.connecting;
  String _failReason = '';
  // Deliberately NO mute control here. `ReceptionistCall` has no mute verb —
  // the mic feeds Ava directly — and a button that silently did nothing is
  // worse than its absence.
  bool _speakerOn = false;
  bool _popped = false;
  final int _startedAtMs = DateTime.now().millisecondsSinceEpoch;

  @override
  void initState() {
    super.initState();
    // ignore: discarded_futures
    _start();
  }

  Map<String, Object> _base(String outcome) => <String, Object>{
        'peer_id': widget.peerId,
        'peer_email': widget.peerEmail ?? '',
        'activation_mode': widget.activationMode,
        'trace_id': widget.traceId ?? '',
        'call_id': widget.callId ?? '',
        'lane': 'streamlane',
        'outcome': outcome,
      };

  Future<void> _start() async {
    final recept = ReceptionistCall(
      calleeUid: widget.peerId,
      // Deliberately NOT the Stream call id. `receptionistStart` treats a
      // `call_id` as a legacy CallRoom name and will try to claim that DO;
      // handing it an `sl-…` Stream id would make it look up a room that does
      // not exist. Omitting it is the supported shape (`if (callId)` guards).
      activationMode: widget.activationMode,
      speaker: false,
    );
    _recept = recept;
    recept.onStatus = (status) {
      if (!mounted) return;
      setState(() {
        switch (status) {
          case 'live':
          case 'connected':
          case 'reconnected':
            _phase = _AvaPhase.live;
          case 'wrapup':
            _phase = _AvaPhase.wrapup;
          case 'ended':
            break;
          default:
            // 'connecting' / 'reconnecting' — keep the connecting surface.
            break;
        }
      });
    };
    // ignore: discarded_futures
    recept.done.then((reason) {
      if (!mounted) return;
      Analytics.capture('stream_lane_ava_ended', {
        ..._base('ended'),
        'reason': reason,
        'duration_ms': DateTime.now().millisecondsSinceEpoch - _startedAtMs,
      });
      _exit(source: 'ava_done', reason: reason);
    });

    Analytics.capture('stream_lane_ava_handoff', _base('started'));
    final ok = await recept.start();
    if (!mounted) return;
    if (!ok) {
      final reason = recept.failReason ?? 'unknown';
      setState(() {
        _phase = _AvaPhase.failed;
        _failReason = reason;
      });
      Analytics.capture('stream_lane_ava_failed', {
        ..._base('failed'),
        'reason': reason,
      });
      return;
    }
    Analytics.capture('stream_lane_ava_connected', {
      ..._base('connected'),
      'connect_ms': DateTime.now().millisecondsSinceEpoch - _startedAtMs,
    });
  }

  Future<void> _hangUp() async {
    final recept = _recept;
    _recept = null;
    Analytics.capture('stream_lane_ava_hangup', {
      ..._base('caller_hangup'),
      'duration_ms': DateTime.now().millisecondsSinceEpoch - _startedAtMs,
    });
    if (recept != null && !recept.isEnded) {
      try {
        await recept.hangup();
      } catch (_) {/* leaving must never throw at the user */}
    }
    _exit(source: 'hangup_button');
  }

  Future<void> _toggleSpeaker() async {
    final recept = _recept;
    if (recept == null) return;
    final next = !_speakerOn;
    setState(() => _speakerOn = next);
    try {
      await recept.setSpeaker(next);
    } catch (_) {
      if (mounted) setState(() => _speakerOn = !next);
    }
  }

  void _exit({required String source, String? reason}) {
    if (_popped) return;
    _popped = true;
    Analytics.capture('stream_lane_ava_screen_exit', {
      ..._base('exit'),
      'source': source,
      'reason': reason ?? '',
      'phase': _phase.name,
    });
    final nav = Navigator.of(context);
    if (nav.canPop()) {
      nav.pop();
    } else {
      nav.pushReplacement(
        MaterialPageRoute<void>(builder: (_) => const RootFlow()),
      );
    }
  }

  @override
  void dispose() {
    final recept = _recept;
    _recept = null;
    if (recept != null && !recept.isEnded) {
      // ignore: discarded_futures
      recept.hangup().catchError((_) {});
    }
    super.dispose();
  }

  String get _statusLabel {
    switch (_phase) {
      case _AvaPhase.connecting:
        return 'Ava is picking up…';
      case _AvaPhase.live:
        return widget.activationMode == 'unreachable'
            ? "They can't be reached — Ava is taking a message"
            : 'No answer — Ava is taking a message';
      case _AvaPhase.wrapup:
        return 'Ava is wrapping up…';
      case _AvaPhase.failed:
        return _failReasonCopy(_failReason);
    }
  }

  /// Honest, non-technical copy per server refusal reason. Anything unmapped
  /// stays generic rather than leaking a machine reason at the user.
  static String _failReasonCopy(String reason) {
    switch (reason) {
      case 'insufficient_tokens':
        return "Ava can't take this call right now.";
      case 'scenario_disabled':
        return "They don't have Ava answering unanswered calls.";
      case 'disabled':
        return 'Ava is unavailable right now.';
      case 'network':
        return "Couldn't reach Ava — check your connection.";
      default:
        return "Couldn't reach Ava — please try again.";
    }
  }

  @override
  Widget build(BuildContext context) {
    final peerName = (widget.peerName ?? '').trim();
    return Scaffold(
      backgroundColor: AD.bg,
      body: SafeArea(
        child: Column(
          children: [
            const SizedBox(height: Msg.s5),
            Text(
              peerName.isEmpty ? 'Ava' : "$peerName's Ava",
              style: const TextStyle(
                color: AD.textPrimary,
                fontSize: 20,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 6),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Msg.s5),
              child: Text(
                _statusLabel,
                textAlign: TextAlign.center,
                style: const TextStyle(color: AD.textSecondary),
              ),
            ),
            const Spacer(),
            _AvaDuo(
              recept: _recept,
              connecting: _phase == _AvaPhase.connecting,
              myAvatarUrl: widget.myAvatarUrl,
              myName: widget.myName,
            ),
            const Spacer(),
            Padding(
              padding: const EdgeInsets.only(bottom: Msg.s6),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  if (_phase != _AvaPhase.failed) ...[
                    _controlButton(
                      icon: _speakerOn
                          ? PhosphorIcons.speakerHigh(PhosphorIconsStyle.bold)
                          : PhosphorIcons.speakerSlash(
                              PhosphorIconsStyle.bold),
                      onTap: _toggleSpeaker,
                      active: !_speakerOn,
                    ),
                    const SizedBox(width: Msg.s5),
                  ],
                  _controlButton(
                    icon: PhosphorIcons.phoneDisconnect(PhosphorIconsStyle.fill),
                    onTap: _hangUp,
                    danger: true,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Same treatment as stream_call_screen.dart's control row: indigo idle with a
  /// cream glyph, marigold when toggled, rani for hang-up. The two creams that
  /// used to be here were invisible against the page.
  Widget _controlButton({
    required PhosphorIconData icon,
    required VoidCallback onTap,
    bool danger = false,
    bool active = false,
  }) {
    final Color bg;
    final Color fg;
    if (danger) {
      bg = AD.primaryBadge;
      fg = AD.tabActiveLabel;
    } else if (active) {
      bg = AD.haldi;
      fg = AD.textPrimary;
    } else {
      bg = AD.tabCalls;
      fg = AD.tabActiveLabel;
    }
    return InkWell(
      onTap: onTap,
      customBorder: const CircleBorder(),
      child: Container(
        width: 56,
        height: 56,
        decoration: BoxDecoration(shape: BoxShape.circle, color: bg),
        child: Icon(icon, color: fg, size: 26),
      ),
    );
  }
}

/// The caller and Ava, each pulsing with their own voice level. Driven by
/// [ReceptionistCall.micLevel] / [ReceptionistCall.avaLevel], the same 0..1
/// notifiers the legacy lane's duo uses.
class _AvaDuo extends StatelessWidget {
  const _AvaDuo({
    required this.recept,
    required this.connecting,
    this.myAvatarUrl,
    this.myName,
  });

  final ReceptionistCall? recept;
  final bool connecting;
  final String? myAvatarUrl;
  final String? myName;

  @override
  Widget build(BuildContext context) {
    final r = recept;
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        _Pulse(
          level: r?.micLevel,
          label: 'You',
          child: Avatar(
            seed: 'me',
            name: myName ?? '',
            avatarUrl: myAvatarUrl,
            size: 84,
          ),
        ),
        const SizedBox(width: Msg.s6),
        _Pulse(
          level: r?.avaLevel,
          dimmed: connecting,
          label: 'Ava',
          child: const CircleAvatar(
            radius: 42,
            backgroundColor: AD.tabCalls,
            backgroundImage: AssetImage(AvaId.avatarAsset),
          ),
        ),
      ],
    );
  }
}

class _Pulse extends StatelessWidget {
  const _Pulse({
    required this.child,
    required this.label,
    this.level,
    this.dimmed = false,
  });

  final Widget child;
  final String label;
  final ValueListenable<double>? level;
  final bool dimmed;

  @override
  Widget build(BuildContext context) {
    final listenable = level;
    final avatar = Opacity(opacity: dimmed ? 0.45 : 1, child: child);
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (listenable == null)
          avatar
        else
          ValueListenableBuilder<double>(
            valueListenable: listenable,
            builder: (context, v, child) {
              final t = v.isNaN ? 0.0 : v.clamp(0.0, 1.0);
              return Container(
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  boxShadow: [
                    BoxShadow(
                      color: AD.haldi.withValues(alpha: 0.55 * t),
                      blurRadius: 6 + 18 * t,
                      spreadRadius: 1 + 7 * t,
                    ),
                  ],
                ),
                child: child,
              );
            },
            child: avatar,
          ),
        const SizedBox(height: Msg.s3),
        Text(label, style: const TextStyle(color: AD.textSecondary)),
      ],
    );
  }
}

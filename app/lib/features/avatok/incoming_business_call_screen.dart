import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/blocking_api.dart';
import '../../core/chat_state.dart';
import '../../core/remote_config.dart';
import '../../core/ui/zine.dart';
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
class IncomingBusinessCallScreen extends StatefulWidget {
  final String callId;
  final String fromUid;
  final String fromName;
  final String avatarUrl;
  final bool video;

  const IncomingBusinessCallScreen({
    super.key,
    required this.callId,
    required this.fromUid,
    required this.fromName,
    this.avatarUrl = '',
    this.video = false,
  });

  @override
  State<IncomingBusinessCallScreen> createState() => _IncomingBusinessCallScreenState();
}

class _IncomingBusinessCallScreenState extends State<IncomingBusinessCallScreen> {
  bool _busy = false;

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
    if (mounted) Navigator.of(context).maybePop();
  }

  Future<void> _decline() async {
    if (_busy) return;
    setState(() => _busy = true);
    Analytics.capture('business_call_incoming_decline', {'call_id': widget.callId});
    await _endNativeRing();
    _clearRingGlobals();
    await PushService.declineIncomingCall(_extra);
    if (mounted) Navigator.of(context).maybePop();
  }

  /// Hands the caller to the Ava AI Voice Agent right away (§3 step 4). The
  /// agent PIPELINE itself is Phase C (Grok realtime session, §4/§8) — not
  /// built yet. This wires the callee-facing action + the decline-equivalent
  /// signalling now (so the caller isn't left ringing forever), with a clear
  /// hook for Phase C to swap in the real hand-off instead of ending the call.
  Future<void> _sendToAgent() async {
    if (_busy) return;
    setState(() => _busy = true);
    Analytics.capture('business_call_incoming_send_to_agent', {'call_id': widget.callId});
    await _endNativeRing();
    _clearRingGlobals();
    // TODO(Phase C — Ava AI Voice Agent, §4/§8): replace this decline-equivalent
    // signal with the real Grok realtime session hand-off (routing_decision
    // reason 'manual_send_to_agent', §13).
    await PushService.declineIncomingCall(_extra);
    if (mounted) Navigator.of(context).maybePop();
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
    _clearRingGlobals();
    // Silent — same signal as a plain decline, no "you were blocked" tell.
    await PushService.declineIncomingCall(_extra);
    if (mounted) Navigator.of(context).maybePop();
  }

  @override
  Widget build(BuildContext context) {
    final name = widget.fromName.trim().isEmpty ? 'AvaTOK' : widget.fromName.trim();
    return PopScope(
      canPop: false,
      child: Scaffold(
        backgroundColor: Zine.ink,
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 20),
            child: Column(
              children: [
                const Spacer(),
                Container(
                  decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: Colors.white, width: 3)),
                  child: Avatar(seed: widget.fromUid, name: name, size: 132,
                      avatarUrl: widget.avatarUrl.isEmpty ? null : widget.avatarUrl),
                ),
                const SizedBox(height: 24),
                Text('$name is calling',
                    textAlign: TextAlign.center,
                    style: ZineText.hero(size: 26, color: Colors.white)),
                const SizedBox(height: 8),
                Text('AvaTOK business call', style: ZineText.sub(size: 13, color: Colors.white70)),
                const Spacer(),
                Row(children: [
                  Expanded(
                    child: _ActionButton(
                      icon: PhosphorIcons.prohibit(PhosphorIconsStyle.bold),
                      label: 'Block',
                      color: Zine.coral,
                      onTap: _busy ? null : _block,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: _ActionButton(
                      icon: PhosphorIcons.phoneX(PhosphorIconsStyle.bold),
                      label: 'Decline',
                      color: Zine.coral,
                      onTap: _busy ? null : _decline,
                    ),
                  ),
                  if (RemoteConfig.voiceAgent) ...[
                    const SizedBox(width: 10),
                    Expanded(
                      child: _ActionButton(
                        icon: PhosphorIcons.robot(PhosphorIconsStyle.bold),
                        label: 'Send to Ava',
                        color: Zine.lilac,
                        onTap: _busy ? null : _sendToAgent,
                      ),
                    ),
                  ],
                  const SizedBox(width: 10),
                  Expanded(
                    child: _ActionButton(
                      icon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
                      label: 'Accept',
                      color: Zine.mint,
                      onTap: _busy ? null : _accept,
                    ),
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
            border: Border.all(color: Colors.white, width: 2),
          ),
          child: Icon(icon, color: Zine.ink, size: 26),
        ),
      ),
      const SizedBox(height: 6),
      Text(label, style: ZineText.tag(size: 10.5, color: Colors.white), textAlign: TextAlign.center),
    ]);
  }
}

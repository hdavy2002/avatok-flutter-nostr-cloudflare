import 'dart:convert';

import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/paid_call_api.dart';
import '../../core/profile_store.dart';
import 'call_screen.dart';

/// [AVA-IDGATE-1] Place a 1:1 AvaTOK call THROUGH POST /api/call.
///
/// WHY THIS EXISTS: the dialpad (ava_phone_screen) and phone-contacts list used to
/// open [CallScreen] DIRECTLY, which had two bugs:
///   1. It SKIPPED the liveness gate — an unverified user could dial a stranger with
///      no verification, while messaging the same person was correctly gated. The
///      gate lives on /api/call (worker api.call → gatePublicAction 'call_stranger'),
///      and the direct-CallScreen path never touched it.
///   2. It never enqueued the ring push, so the callee wasn't actually woken — the
///      caller only heard local ringback. /api/call is what sends the wake.
///
/// Routing through /api/call fixes BOTH. On a 403 identity_required the global
/// ApiAuth interceptor (see core/api_auth.dart) has already opened the consent +
/// Didit liveness flow, so we simply abort the dial. On any other response we open
/// the call screen exactly as before (no worse than the old path for reachability;
/// strictly better because the callee now gets rung).
///
/// Mirrors chat_thread's placement, kept intentionally small.
Future<void> place1to1Call(
  BuildContext context, {
  required String uid,
  required String name,
  String avatarUrl = '',
  bool video = false,
  // WP6 (Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md §3B):
  // when the caller already confirmed + held funds via showPaidCallPrompt
  // (paid_call_prompt.dart), thread the hold through so the server can tie the
  // escrow to this call. '' = a normal free/callee-pays call (unchanged path).
  String paidHoldId = '',
  int paidMinutes = 0,
}) async {
  if (uid.isEmpty) return;
  final room = 'avatok-$uid';
  // Caller display name for the callee's incoming-call push (cosmetic; 'AvaTOK' is
  // the same fallback chat_thread uses).
  String myName = 'AvaTOK';
  try {
    final p = await ProfileStore().load();
    if (p.displayName.isNotEmpty) myName = p.displayName;
  } catch (_) {/* fall back to 'AvaTOK' */}

  // [WP3-ACT-1] Pre-seeded from the initial /api/call response when the server
  // decided 'voicemail'/'agent' and skipped ringing entirely (offline/busy/
  // business-hours/blocked, plan §15.1/§15.2) — threaded into CallScreen so its
  // no-answer card already knows the right affordance without a second probe.
  String? routed;
  Map<String, dynamic>? routingStart;
  try {
    final res = await ApiAuth.postJsonH(kCallUrl, {
      'to': uid,
      'fromName': myName,
      'callId': room,
      'kind': video ? 'video' : 'audio',
      // [DIALPAD-BIZ-CALLS] Marks this as a business-channel (dialpad) dial.
      // Harmless extra field today; ready for the server to thread through to
      // the callee's ring push once the routing work lands, so the callee's
      // named incoming-business-call screen (businessCallUx) knows to show.
      'via': 'dialpad',
      if (paidHoldId.isNotEmpty) 'paid_hold_id': paidHoldId,
      if (paidHoldId.isNotEmpty) 'paid_minutes': paidMinutes,
    }, const <String, String>{});
    if (res.statusCode == 200) {
      try {
        final j = jsonDecode(res.body) as Map<String, dynamic>;
        final r = j['routed'];
        if (r == 'voicemail' || r == 'agent') {
          routed = r as String;
          final st = j['start'];
          if (st is Map) routingStart = st.cast<String, dynamic>();
        }
      } catch (_) {/* not JSON / no routed field — normal ring path */}
    }
    if (res.statusCode == 403 && res.body.contains('identity_required')) {
      // The global 403 interceptor already launched the consent/liveness flow.
      // Do NOT open the call screen — the dial is gated until the user verifies.
      Analytics.capture('call_blocked_identity', {'via': 'dialpad', 'to': uid});
      if (paidHoldId.isNotEmpty) {
        // §11 "Caller abandons" — the call never placed, release the hold.
        // ignore: unawaited_futures
        PaidCallApi.cancel(holdId: paidHoldId);
      }
      return;
    }
    if (paidHoldId.isNotEmpty && res.statusCode >= 200 && res.statusCode < 300) {
      // §3B step 5 "connect": flip the hold live now that the call is actually
      // placed. The per-minute settle/refund/beep-timer plumbing itself lives
      // server-side (CallRoom DO, WP3) + the in-call countdown (CallCountdown in
      // paid_call_prompt.dart) — wiring THOSE into CallScreen's live session is
      // deferred until WP3's routing/escrow endpoints land, so it isn't faked
      // here. See the WP6 report for the exact remaining hook point.
      // ignore: unawaited_futures
      PaidCallApi.confirm(holdId: paidHoldId, callId: room);
    }
  } catch (_) {
    // Network error placing the call → fall through and still open the screen;
    // CallSession has its own reconnect/timeout handling, and this is no worse than
    // the previous behaviour (which opened the screen with no /api/call at all).
  }

  if (!context.mounted) return;
  await Navigator.push(context, MaterialPageRoute(
    builder: (_) => CallScreen(
      room: room,
      title: name.isNotEmpty ? name : uid,
      seed: uid,
      video: video,
      outgoing: true,
      avatarUrl: avatarUrl,
      initialRouted: routed,
      initialRoutingStart: routingStart,
    ),
  ));
}

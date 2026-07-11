import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
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

  try {
    final res = await ApiAuth.postJsonH(kCallUrl, {
      'to': uid,
      'fromName': myName,
      'callId': room,
      'kind': video ? 'video' : 'audio',
    }, const <String, String>{});
    if (res.statusCode == 403 && res.body.contains('identity_required')) {
      // The global 403 interceptor already launched the consent/liveness flow.
      // Do NOT open the call screen — the dial is gated until the user verifies.
      Analytics.capture('call_blocked_identity', {'via': 'dialpad', 'to': uid});
      return;
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
    ),
  ));
}

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show SystemSound, SystemSoundType;

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/calls/call_session_manager.dart'; // [INSTANT-CALL-MOUNT-1]
import '../../core/config.dart';
import '../../core/paid_call_api.dart';
import '../../core/profile_store.dart';
import '../../core/remote_config.dart'; // [INSTANT-CALL-MOUNT-1] kill switch
import '../../core/ringback_player.dart';
import '../../core/ui/avatok_dark.dart';
import 'call_screen.dart';
import 'paid_busy_card.dart';

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
  // [DIALER-UI-SPLIT 2026-07-12] true when the call was started from the phone
  // DIALER ecosystem (dialpad / recents / phone-contacts) rather than a chat
  // thread. Only themes CallScreen with the dialer's PhoneTheme palette so the
  // dialer feels like its own app; the call engine/logic is identical.
  bool dialer = false,
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

  // [INSTANT-CALL-MOUNT-1] Optimistic mount for NORMAL (non-paid) dialer calls:
  // open the CallScreen the instant the user taps and run POST /api/call in the
  // BACKGROUND (mirrors chat_thread._call). PAID (Mode B) calls are deliberately
  // EXCLUDED — their POST response gates the busy card + escrow-hold lifecycle
  // (routed:'busy', hold cancellation on 403) and MUST resolve before any UI is
  // committed, so they keep the awaited path below. The optimistic session runs
  // the honest guard flow (deferRing → connecting + searching tone, no fake
  // ringback); _dialerPlaceInBackground feeds the reachability/glare/failure
  // outcome back into it. Kill switch: RemoteConfig.instantCallMountEnabled.
  if (paidHoldId.isEmpty && RemoteConfig.instantCallMountEnabled) {
    if (!context.mounted) return;
    Analytics.capture('call_mount_optimistic',
        {'call_id': room, 'via': 'dialpad', 'kind': video ? 'video' : 'audio'});
    final nav = Navigator.push(context, MaterialPageRoute(
      builder: (_) => CallScreen(
        room: room,
        title: name.isNotEmpty ? name : uid,
        seed: uid,
        video: video,
        outgoing: true,
        avatarUrl: avatarUrl,
        business: true, // §3 after-ring flow (agent hand-off / post-ring busy)
        dialer: dialer,
        deferRing: true, // [INSTANT-CALL-MOUNT-1] honest guard flow until placed
      ),
    ));
    // Place the call off the critical path, then keep this function alive until
    // the call screen pops (same await semantics as the classic path below).
    // ignore: unawaited_futures
    _dialerPlaceInBackground(context, uid: uid, name: name, room: room, myName: myName, video: video, avatarUrl: avatarUrl, dialer: dialer);
    await nav;
    return;
  }

  // [WP3-ACT-1] Pre-seeded from the initial /api/call response when the server
  // decided 'voicemail'/'agent' and skipped ringing entirely (offline/busy/
  // business-hours/blocked, plan §15.1/§15.2) — threaded into CallScreen so its
  // no-answer card already knows the right affordance without a second probe.
  String? routed;
  Map<String, dynamic>? routingStart;
  // [DIALPAD-BIZ-CALLS] routed:'busy' (plan §11/§15.1, owner decision
  // 2026-07-11): a PAID (Mode B) line whose agents are all full or whose
  // human callee is already on a call. Never a normal call outcome — set only
  // when the server's routing decision short-circuits BEFORE any ring, so
  // below we skip both PaidCallApi.confirm() (never take the hold) and
  // CallScreen entirely in favor of a full-screen busy card.
  String? busyMessage;
  String? busyKind;
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
        } else if (r == 'busy') {
          busyKind = (j['busy_kind'] ?? '').toString();
          busyMessage = (j['message'] ?? '').toString();
          if (busyMessage!.isEmpty) {
            busyMessage = busyKind == 'agents_full'
                ? 'All agents are busy right now — please try again in a while.'
                : 'This line is busy. Please try again later.';
          }
          Analytics.capture('paid_call_busy', {'to': uid, 'busy_kind': busyKind});
        }
      } catch (_) {/* not JSON / no routed field — normal ring path */}
    }
    if (res.statusCode == 403 && res.body.contains('identity_required')) {
      // The global 403 interceptor already launched the consent/liveness flow.
      // Do NOT open the call screen — the dial is gated until the user verifies.
      Analytics.capture('call_blocked_identity', {'via': 'dialpad', 'to': uid});
      if (paidHoldId.isNotEmpty) {
        // §11 "Caller abandons" — the call never placed, release the hold.
        // (Server contract: the hold was taken at the price prompt's confirm,
        // keyed by this call_id; /api/call/paid/cancel disarms + refunds it.)
        // ignore: unawaited_futures
        PaidCallApi.cancel(callId: room);
      }
      return;
    }
    // NOTE (server contract, call_billing_routes.ts): the escrow hold + the
    // CallRoom billing-ticker arm ALREADY happened at the price prompt's
    // Confirm (POST /api/call/paid/confirm, keyed by this call_id) — there is
    // no second "flip live" call here. routed:'busy' above is disarmed
    // server-side (api.ts busy path posts /billing-disarm), and a ring
    // timeout auto-refunds per §11.
  } catch (_) {
    // Network error placing the call → fall through and still open the screen;
    // CallSession has its own reconnect/timeout handling, and this is no worse than
    // the previous behaviour (which opened the screen with no /api/call at all).
  }

  if (busyMessage != null) {
    // Never ring, never open CallScreen — a busy tone + full-screen card
    // instead (plan §15.1: "PAID lines never overflow to voicemail — the
    // caller gets a BUSY tone + message").
    unawaited(_playBusyTone());
    if (!context.mounted) return;
    final msg = busyMessage;
    await Navigator.push(context, MaterialPageRoute(
      fullscreenDialog: true,
      builder: (dialogCtx) => Scaffold(
        backgroundColor: AD.bg,
        body: SafeArea(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: PaidBusyCard(
                name: name,
                message: msg,
                onTryAgain: () {
                  final nav = Navigator.of(dialogCtx);
                  final navCtx = nav.context;
                  nav.pop();
                  place1to1Call(navCtx, uid: uid, name: name, avatarUrl: avatarUrl, video: video);
                },
                onClose: () => Navigator.of(dialogCtx).pop(),
              ),
            ),
          ),
        ),
      ),
    ));
    return;
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
      // [DIALPAD-BIZ-CALLS Phase C] business channel → §3 after-ring flow
      // (agent hand-off, post-ring busy) instead of the generic outcome menu.
      business: true,
      // [DIALER-UI-SPLIT 2026-07-12] dialer-styled call screen for dialpad calls.
      dialer: dialer,
      // [WP6 §3B] arms the in-call countdown + end-of-time beeps on connect.
      paidMinutes: paidHoldId.isNotEmpty ? paidMinutes : 0,
    ),
  ));
}

/// [INSTANT-CALL-MOUNT-1] Runs POST /api/call AFTER the dialer CallScreen is
/// already on screen (optimistic mount) and feeds the outcome to the live
/// session — the same POST the awaited path did, just off the critical path.
/// Only reached for NON-paid dialer calls (paid calls keep the awaited path),
/// so there is no escrow hold or busy-card decision to gate here. Outcomes match
/// chat_thread._placeCallInBackground: reachable → full ring window; unreachable
/// → Ava (no fake ringback); glare → supersede with the deterministic winner;
/// identity gate → tear down; hard network fail → 'network-error' + Retry.
Future<void> _dialerPlaceInBackground(
  BuildContext context, {
  required String uid,
  required String name,
  required String room,
  required String myName,
  required bool video,
  required String avatarUrl,
  required bool dialer,
}) async {
  final callKind = video ? 'video' : 'audio';
  try {
    final res = await ApiAuth.postJsonH(kCallUrl, {
      'to': uid,
      'fromName': myName,
      'callId': room,
      'kind': callKind,
      'via': 'dialpad',
    }, const <String, String>{});

    // [CALL-GLARE-2] Server folded a simultaneous mutual dial into one winning
    // room. If it isn't ours, supersede: end our (peer-less) session and open
    // the deterministic winner as the answering side.
    String glareJoin = '';
    try {
      final jb = jsonDecode(res.body);
      if (jb is Map && jb['glare'] == true) glareJoin = (jb['join_call_id'] ?? '').toString();
    } catch (_) {}
    if (glareJoin.isNotEmpty && glareJoin != room) {
      Analytics.capture('call_glare_autoconnect',
          {'winner_call_id': glareJoin, 'my_call_id': room, 'kind': callKind, 'via': 'dialpad', 'mount': 'optimistic'});
      CallSessionManager.instance.liveSessionFor(room)?.hangup('glare-superseded');
      if (!context.mounted) return;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!context.mounted) return;
        Navigator.push(context, MaterialPageRoute(
          builder: (_) => CallScreen(
            room: glareJoin, title: name.isNotEmpty ? name : uid, seed: uid, video: video,
            outgoing: false, avatarUrl: avatarUrl, business: true, dialer: dialer,
          ),
        ));
      });
      return;
    }

    bool reachableFalse = false;
    try { reachableFalse = jsonDecode(res.body)['reachable'] == false; } catch (_) {}

    final session = CallSessionManager.instance.liveSessionFor(room);
    if (res.statusCode == 200 && !reachableFalse) {
      Analytics.capture('call_place_ok', {'kind': callKind, 'via': 'dialpad', 'mount': 'optimistic'});
      session?.notePlaceResult(true);
    } else if (res.statusCode == 404 || reachableFalse) {
      Analytics.capture('call_no_device', {
        'to': uid.length > 40 ? uid.substring(0, 40) : uid,
        'kind': callKind,
        'reason': res.statusCode == 404 ? 'http_404' : 'reachable_false',
        'via': 'dialpad',
        'mount': 'optimistic',
      });
      session?.notePlaceResult(false);
    } else if (res.statusCode == 403 && res.body.contains('identity_required')) {
      // The global 403 interceptor already opened consent/liveness — tear the
      // optimistic screen down so it isn't stuck behind the gate.
      Analytics.capture('call_blocked_identity', {'via': 'dialpad', 'mount': 'optimistic'});
      session?.hangup('identity-gate');
    } else {
      Analytics.capture('call_place_failed', {'status': res.statusCode, 'kind': callKind, 'via': 'dialpad', 'mount': 'optimistic'});
      session?.notePlaceResult(true);
    }
  } catch (e) {
    final err = e.toString();
    Analytics.capture('call_place_failed', {
      'call_id': room,
      'kind': callKind,
      'error': err.length > 160 ? err.substring(0, 160) : err,
      'via': 'dialpad',
      'mount': 'optimistic',
    });
    CallSessionManager.instance.liveSessionFor(room)?.notePlaceFailed();
  }
}

/// Local busy tone for [routed]:'busy' (plan §15.1) — no ring was ever sent by
/// the server, so this is the caller's ONLY audible signal. Reuses the same
/// bundled clip [RingbackPlayer.playBusyTone] already plays for the ordinary
/// "callee busy" phase (call_session.dart), stopped automatically once the
/// clip finishes (ReleaseMode.release, not looped). A short-lived local
/// player — not tied to any [CallSession] — since no call/session ever starts
/// on this path.
Future<void> _playBusyTone() async {
  final player = RingbackPlayer();
  try {
    await player.playBusyTone();
  } catch (_) {
    // TODO(future): a purpose-built busy-tone asset load failure is rare
    // (bundled asset), but fall back to a plain system alert so the caller
    // still gets SOME signal rather than dead silence.
    try { await SystemSound.play(SystemSoundType.alert); } catch (_) {/* best-effort */}
  } finally {
    // Fire-and-forget: dispose shortly after the clip would have finished so
    // the underlying AudioPlayer doesn't leak. The busy card itself has no
    // further use for this player.
    unawaited(Future.delayed(const Duration(seconds: 3), player.dispose));
  }
}

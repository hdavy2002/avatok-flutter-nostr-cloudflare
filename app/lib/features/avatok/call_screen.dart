import 'dart:async';
import 'dart:math' as math;
// (unawaited comes from dart:async, already imported above)
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/agent_voice_call.dart';
import '../../core/analytics.dart'; // [VM-IN-MENU-1]
import '../../core/ava_identity.dart';
import '../../core/avatar.dart';
import '../../core/account_storage.dart'; // [CALLREC-UI-1] per-account consent key
import '../../core/call_recording/call_recording_model.dart'; // [CALLREC-UI-1]
import '../../core/call_recording/call_recording_store.dart'; // [CALLREC-UI-1]
import '../../core/call_routing_api.dart';
import '../../core/calls/adhoc_room_api.dart'; // [ADDCALL-1-UI]
import '../../core/calls/call_overlay.dart';
import '../../core/calls/call_telemetry_events.dart'; // [ADDCALL-1-UI]
import '../../core/disk_cache.dart'; // [CALLREC-UI-1] per-account consent store
import '../../core/calls/call_session.dart';
import '../../core/calls/call_session_manager.dart';
import '../conference/cloudflare_conference_controller.dart'; // [ADDCALL-1-UI]
import '../conference/cloudflare_conference_screen.dart'; // [ADDCALL-1-UI]
import 'add_to_call_sheet.dart'; // [ADDCALL-1-UI]
import '../../core/remote_config.dart';
import '../../core/ringback_player.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../avaphone/phone_theme.dart';
import 'busy_card.dart';
import 'call_outcome_menu.dart';
import 'chat_thread.dart'; // [AVACALL-MENU-1] Message → open DM thread
import '../translation/call_translate_overlay.dart'; // [CALL-TRANSLATE-1]
import 'contacts.dart';
import 'data.dart' show Chat; // [AVACALL-MENU-1] Chat model for the DM thread
import 'no_answer_card.dart';
import 'paid_busy_card.dart';
import 'place_1to1_call.dart';
// Ringing globals (gIncomingRingingFrom/CallId) live here — cleared by
// clearCallState() on account switch. push_service.dart also imports this file
// (Dart permits the library cycle).
import '../../push/push_service.dart';
import '../../main.dart' show RootFlow;

// ─────────────────────────────────────────────────────────────────────────────
//  BUSY / GLARE GLOBALS — thin shims delegating to the CallSession lifecycle.
//
//  These stay declared here so the push handler (push_service.dart), the busy
//  auto-reply, chat_thread.dart and account_switcher.dart keep importing them
//  unchanged. The GROUND TRUTH is now driven by CallSession.start()/hangup():
//  a session start == a genuinely-active call (attach() is called from the
//  view's initState), and hangup() is the single teardown. The phantom-busy /
//  glare protections below are unchanged in spirit — gLiveCallScreens is still
//  the mounted-call count, incremented when a session starts and decremented in
//  CallSession teardown, so a leaked flag can never phantom-busy later calls.
// ─────────────────────────────────────────────────────────────────────────────

/// True while a 1:1 call is on this device — used to auto-reply "busy" to a
/// second incoming call.
bool gInCall = false;

/// Room id of the call currently active (null when idle). The push handler uses
/// it to tell a DUPLICATE push for the same call apart from a genuine second
/// caller, and — with [gInCallSince] — to detect a STALE [gInCall] (the old
/// "phantom busy" bug).
String? gActiveCallId;

/// Epoch-ms when the active call took over. Past [kMaxCallLifeMs], [gInCall] is
/// treated as stale.
int gInCallSince = 0;
const int kMaxCallLifeMs = 2 * 60 * 60 * 1000; // 2 h ceiling

/// Number of live [CallSession]s on this device — the GROUND TRUTH for "on a
/// call right now". Incremented in [CallSession.start], decremented in
/// [CallSession] teardown. A live-session count can't leak past the process: a
/// hard kill resets it to 0, and every teardown path runs the single hangup.
int gLiveCallScreens = 0;

/// [AVATOK-DIAL-GUARD-1] Epoch-ms when [gLiveCallScreens] last went from 0 to
/// >0 — the staleness anchor unlike its siblings [gInCallSince] (2h ceiling)
/// and [gOutgoingSince] (60s ceiling) had until now. Zeroed the moment the
/// counter returns to 0. If [CallSession._teardown] never runs (the exact bug
/// behind the 13 suppressed call-back taps in the 2026-07-15 incident),
/// [gLiveCallScreens] sticks >0 forever and every future dial from this device
/// silently no-ops — see [selfHealStaleLiveCallScreens] below. Interim fix;
/// Phase 2 replaces the raw counter with an explicit session state machine
/// (Specs/FIXPLAN-2026-07-15-avadial-incoming-call-ui.md FIX 5).
int gLiveCallScreensSince = 0;

/// Ground truth for "the user is genuinely on a call right now", checked before
/// auto-replying busy so a leftover [gInCall] flag can never silently block
/// every future call. Backed by [gLiveCallScreens] (a real live-session count),
/// NOT a time-windowed flag. [AVATOK-DIAL-GUARD-1]: self-heals a stale counter
/// first, so a leaked teardown can't make this permanently return true either.
bool callIsGenuinelyActive() {
  selfHealStaleLiveCallScreens();
  return gLiveCallScreens > 0;
}

/// [AVATOK-DIAL-GUARD-1] Interim self-heal for a stuck [gLiveCallScreens].
/// Mirrors [gInCallSince]'s 2h ceiling ([kMaxCallLifeMs]): if the counter is
/// >0, has been so for longer than that ceiling, AND [CallSessionManager]
/// reports no genuinely live session (belt-and-suspenders so a real 2h+ call
/// is never reset out from under itself), reset the counter and the paired
/// [gInCall]/[gInCallSince] globals (mirrors what [CallSession._teardown]
/// itself clears) and log `call_guard_self_healed`. Returns true if it healed
/// — callers should then treat the device as not-in-call. Cheap/no-op when the
/// counter is healthy, so it's safe to call from every guard read.
bool selfHealStaleLiveCallScreens() {
  if (gLiveCallScreens <= 0) return false;
  if (gLiveCallScreensSince == 0)
    return false; // shouldn't happen, but never heal blind
  final ageMs = DateTime.now().millisecondsSinceEpoch - gLiveCallScreensSince;
  if (ageMs <= kMaxCallLifeMs) return false;
  if (CallSessionManager.instance.current != null)
    return false; // genuinely live — leave it alone
  final counterWas = gLiveCallScreens;
  gLiveCallScreens = 0;
  gLiveCallScreensSince = 0;
  gInCall = false;
  gInCallSince = 0;
  Analytics.capture('call_guard_self_healed', {
    'stale_ms': ageMs,
    'counter_was': counterWas,
  });
  return true;
}

/// CALL-GLARE-1: our PENDING OUTGOING call, if any — the peer we're DIALING and
/// its call_id, set when an outgoing dial is placed and CLEARED the moment that
/// call connects, ends, or is superseded. The incoming-push handler consults it
/// to detect GLARE (two users dialing each other within ~1s). NOT set once
/// connected (a connected call is genuinely busy and SHOULD auto-busy others).
String?
    gOutgoingCallTo; // the peer we are dialing (config.seed), null when idle/connected
String? gOutgoingCallId; // the call_id (room) of that outgoing dial
int gOutgoingSince = 0; // epoch-ms the dial was placed (staleness guard)
const int kMaxDialLifeMs =
    60 * 1000; // an unanswered dial can't ring longer than this

/// True while we have a LIVE outgoing dial to [peer] that has NOT yet connected —
/// the glare condition. Stale entries (older than [kMaxDialLifeMs]) are treated
/// as absent so a leaked flag can never mis-resolve a genuine later incoming call.
bool hasPendingOutgoingTo(String peer) {
  if (gOutgoingCallTo == null || gOutgoingCallTo != peer) return false;
  if (gOutgoingSince != 0 &&
      DateTime.now().millisecondsSinceEpoch - gOutgoingSince > kMaxDialLifeMs) {
    return false;
  }
  return true;
}

/// [MULTIACCT-3] Clear ALL in-flight call state on an account switch/logout.
/// Destroys any active [CallSession] (its teardown resets the busy/active/glare
/// globals) then resets the globals belt-and-suspenders so a fresh call on the
/// NEW account is never auto-busied by state the PREVIOUS account left behind.
/// Also best-effort ends any lingering native CallKit call so no ghost ring
/// survives the switch. Idempotent. The AccountSwitcher runs this BEFORE
/// swapping the account scope.
Future<void> clearCallState() async {
  try {
    await CallSessionManager.instance.destroyAll();
  } catch (_) {}
  gInCall = false;
  gActiveCallId = null;
  gInCallSince = 0;
  gLiveCallScreens = 0;
  gLiveCallScreensSince = 0; // [AVATOK-DIAL-GUARD-1]
  gOutgoingCallTo = null;
  gOutgoingCallId = null;
  gOutgoingSince = 0;
  gIncomingRingingFrom = null;
  gIncomingRingingCallId = null;
  try {
    await FlutterCallkitIncoming.endAllCalls();
  } catch (_) {/* none active */}
}

/// AvaTok 1:1 call — a PURE VIEW over a [CallSession]. All state/logic lives in
/// the session (owned by [CallSessionManager]) so the call survives navigation
/// and backgrounding: this screen's dispose() only detaches listeners, it never
/// tears down the call. The constructor signature is unchanged so every launch
/// site keeps working. See Specs/CALL-SESSION-API.md.
class CallScreen extends StatefulWidget {
  final String room;
  final String title;
  final String seed;
  final bool video;
  final bool outgoing; // true = caller (show ringback + no-answer timeout)
  final String avatarUrl; // peer's photo ('' = initials)
  final String ringbackUrl;
  final String? teamId;
  final int? teamSlot;

  /// [TRACE-ID-1] Correlation id for this call, minted at the dial boundary
  /// (caller) or carried in the incoming push (callee). '' → the session mints one.
  final String traceId;
  // [CALL-DIAL-FAIL-1] Optional retry hook, wired by launch sites that can
  // cheaply re-run their own dial flow (fresh room id + fresh place-call POST)
  // when this call ends in the 'network-error' terminal state. Null → the
  // Retry button is hidden (the user falls back to the normal dial button).
  final VoidCallback? onRetry;
  // [WP3-ACT-1] When place_1to1_call.dart's initial POST /api/call already came
  // back `routed:'voicemail'|'agent'` (the server skipped ringing entirely —
  // offline/busy/business-hours/blocked, plan §15.1/§15.2), it's pre-seeded here
  // so the no-answer card shows the RIGHT voicemail/agent affordance the moment
  // the client's own ring-timeout naturally elapses, without waiting on a second
  // /api/call/no-answer round trip. null = the normal path (probe on timeout).
  final String? initialRouted;
  final Map<String, dynamic>? initialRoutingStart;
  // [DIALPAD-BIZ-CALLS Phase C] true = placed through the business (dialpad)
  // channel (place_1to1_call.dart) — enables the §3 after-ring flow (agent
  // hand-off, post-ring busy card) on this session. See CallSessionConfig.business.
  final bool business;
  // [DIALER-UI-SPLIT 2026-07-12] true = launched from the phone DIALER ecosystem
  // (dialpad / recents / phone-contacts) rather than a chat thread. Purely
  // presentational: paints the call surface in the dialer's PhoneTheme palette
  // so the dialer feels like its own app, separate from the messenger. The
  // underlying CallSession logic is unchanged. Chat-initiated calls leave it
  // false and keep the zine look.
  final bool dialer;
  // [INSTANT-CALL-MOUNT-1] true = this screen was mounted OPTIMISTICALLY (the
  // instant the user tapped the call icon), BEFORE POST /api/call resolved. The
  // session then runs the honest guard flow (connecting + searching tone, no
  // fake ringback) and the launch site feeds the placement outcome back via
  // CallSession.notePlaceResult / notePlaceFailed. Default false = the classic
  // awaited path (screen mounts after the POST).
  final bool deferRing;
  const CallScreen({
    super.key,
    required this.room,
    required this.title,
    required this.seed,
    required this.video,
    this.outgoing = true,
    this.avatarUrl = '',
    this.ringbackUrl = '',
    this.teamId,
    this.teamSlot,
    this.traceId = '',
    this.onRetry,
    this.initialRouted,
    this.initialRoutingStart,
    this.business = false,
    this.dialer = false,
    this.deferRing = false,
  });
  @override
  State<CallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends State<CallScreen> {
  late final CallSession _session;
  bool _popped = false;

  /// [ADDCALL-1-UI] True from the moment the user confirms the picker until the
  /// escalation either fails (call untouched) or hands off to the conference.
  /// Exists so the Add tile cannot be tapped twice — the second create would
  /// mint a SECOND ad-hoc room, and the first would be an orphan row nothing
  /// deletes (spec §11 item 1).
  bool _escalating = false;

  // [CALL-UI-COLLAPSE-1] Collapsible control panel — VIDEO CALLS ONLY.
  //
  // The 2x3 labelled grid ([CALL-UI-GRID-2]) reserves 350px, roughly a third of
  // a handset screen, and on a video call it sits ON TOP of the thing the user
  // opened the call to look at. Collapsing it leaves a small chevron pill and
  // gives the remote video the whole screen back.
  //
  // This is deliberately NOT applied to the audio layout: there the panel IS
  // the screen (paper/dialer skin, hero avatar, status sticker), there is
  // nothing behind it worth revealing, and there would be no tap target to
  // bring it back. Everywhere below, the effective state is derived as
  // `showVideo && _panelCollapsed`, never read raw — so the audio path is
  // byte-for-byte unchanged and the "collapsed, then camera off" case
  // (see _toggleControlPanel) can never strand a user with hidden controls.
  //
  // In-memory only, and the CallScreen State dies with the call, so the
  // collapsed state lasts for THIS call and is not remembered across calls.
  bool _panelCollapsed = false;
  // Accumulated dy for the current vertical drag; reset on every drag end.
  double _panelDragDy = 0;

  static const double _panelDragDistance = 40; // px before a drag counts
  static const double _panelFlickVelocity = 320; // px/s for a flick

  /// Flip the control panel between expanded and collapsed. No-op on audio:
  /// `showVideo` is the only place the state is honoured, but guarding here as
  /// well keeps a stray call site from setting a flag that nothing can clear.
  void _toggleControlPanel(String source) {
    if (!(_session.videoActive.value && _session.cameraOn.value)) return;
    setState(() => _panelCollapsed = !_panelCollapsed);
    Analytics.capture('call_controls_toggled', {
      'call_id': widget.room,
      'collapsed': _panelCollapsed,
      'source': source, // 'tap_video' | 'drag_panel' | 'tap_handle'
      'peer_uid': widget.seed,
      'video': true,
    });
  }

  void _onPanelDragUpdate(DragUpdateDetails d) {
    _panelDragDy += d.delta.dy;
  }

  void _onPanelDragEnd(DragEndDetails d) {
    final dy = _panelDragDy;
    _panelDragDy = 0;
    final v = d.velocity.pixelsPerSecond.dy;
    // Velocity first so a flick works even when the finger barely travelled;
    // otherwise fall back to distance, and a small accidental drag snaps back
    // by simply leaving the state alone.
    bool? next;
    if (v > _panelFlickVelocity) {
      next = true;
    } else if (v < -_panelFlickVelocity) {
      next = false;
    } else if (dy > _panelDragDistance) {
      next = true;
    } else if (dy < -_panelDragDistance) {
      next = false;
    }
    if (next == null || next == _panelCollapsed) return;
    _toggleControlPanel('drag_panel');
  }

  // [WP3-ACT-1] After-ring routing (plan §3 step 4) — fetched ONCE when the
  // outgoing call genuinely goes to 'no-answer' while businessCallUx is on.
  // [RECEPT-SETTINGS-1] voicemail removed; the routing probe is retained for the
  // rest of the no-answer UX (busy/agent decisions).
  Map<String, dynamic>? _routingInfo;
  bool _routingFetched = false;

  // [DIALPAD-BIZ-CALLS Phase C] Caller↔agent Grok bridge state. The bridge
  // itself is core/agent_voice_call.dart; this screen owns starting it (from
  // the 'agent-handoff' phase, an 'agent' routing decision, or the early
  // AGENT_AUTO probe) and rendering the live agent panel.
  AgentVoiceCall? _agentCall;
  String _agentStatus =
      ''; // '' | 'connecting' | 'connected' | 'ended' | 'failed'
  bool _agentStarted = false;
  Timer? _agentAutoProbe;
  // Post-ring busy (plan §15.1): /api/call/no-answer said 'busy' after a
  // genuine ring timeout — render the PaidBusyCard instead of the no-answer card.
  Map<String, dynamic>? _postRingBusy;

  bool get _agentActive =>
      _agentCall != null || _session.uiPhase.value == 'agent-handoff';

  void _maybeFetchNoAnswerRouting() {
    if (_routingFetched || !RemoteConfig.businessCallUx || !widget.outgoing)
      return;
    if (widget.initialRouted == 'voicemail' ||
        widget.initialRouted == 'agent') {
      // Pre-seeded by place_1to1_call.dart from the initial /api/call response
      // (ring was skipped server-side) — no need for a second round trip.
      _routingFetched = true;
      _routingInfo = {
        'next': widget.initialRouted,
        'voicemail_available': widget.initialRouted == 'voicemail',
        if (widget.initialRoutingStart != null)
          'start': widget.initialRoutingStart,
      };
      return;
    }
    if (_session.uiPhase.value != 'no-answer') return;
    _routingFetched = true;
    CallRoutingApi.noAnswer(
            callee: widget.seed, callId: widget.room, traceId: widget.traceId)
        .then((r) {
      if (!mounted || r == null) return;
      setState(() => _routingInfo = r);
      // Phase C: the server routed this no-answer to the agent — connect
      // automatically (expectation: the caller HEARS the agent, not a card).
      if (r['next'] == 'agent' && RemoteConfig.voiceAgent) {
        // ignore: unawaited_futures
        _startAgentBridge(r['start'] is Map
            ? (r['start'] as Map).cast<String, dynamic>()
            : null);
      } else if (r['next'] == 'busy') {
        _showPostRingBusy(r);
      }
    });
  }

  // ── [DIALPAD-BIZ-CALLS Phase C] agent bridge ──────────────────────────────

  /// Early AGENT_AUTO probe (plan §3 step 4: "auto" profiles answer after
  /// agentAutoanswerSec ≈ 2 rings, well before the client's own 35s ring
  /// timeout). Armed only for business outgoing audio calls with voiceAgent
  /// on; the server is the decision-maker — a non-'agent' answer is ignored
  /// and the normal ring keeps going.
  void _armAgentAutoProbe() {
    if (!widget.business || !widget.outgoing || widget.video) return;
    if (!RemoteConfig.businessCallUx || !RemoteConfig.voiceAgent) return;
    if (widget.initialRouted != null) return; // server already decided pre-ring
    _agentAutoProbe = Timer(const Duration(seconds: 12), () async {
      if (!mounted || _agentStarted || _session.isConnected || _session.isEnded)
        return;
      final phase = _session.uiPhase.value;
      if (phase != 'ringing' && phase != 'connecting') return;
      final r = await CallRoutingApi.noAnswer(
          callee: widget.seed, callId: widget.room, traceId: widget.traceId);
      if (!mounted || r == null || r['next'] != 'agent') return;
      if (_agentStarted || _session.isConnected || _session.isEnded) return;
      _routingInfo = r;
      _routingFetched = true;
      // Cancels the ring toward the callee and parks the session in
      // 'agent-handoff'; the phase listener below starts the bridge.
      _session.businessAgentHandoff('no_answer');
    });
  }

  /// Reacts to the session entering 'agent-handoff' (callee tapped "Send to
  /// Ava AI Agent", or the early auto probe fired). Probes routing if the
  /// screen doesn't already have a decision, then bridges.
  void _maybeStartAgentFromPhase() {
    if (_session.uiPhase.value != 'agent-handoff' || _agentStarted) return;
    final start =
        _routingInfo?['next'] == 'agent' && _routingInfo?['start'] is Map
            ? (_routingInfo!['start'] as Map).cast<String, dynamic>()
            : null;
    if (start != null) {
      // ignore: unawaited_futures
      _startAgentBridge(start);
      return;
    }
    final outcome = _session.agentHandoffOutcome ?? 'manual_send_to_agent';
    _agentStarted = true; // claim now — the probe below is async
    CallRoutingApi.noAnswer(
      callee: widget.seed,
      callId: widget.room,
      traceId: widget.traceId,
      outcome: outcome,
    ).then((r) {
      if (!mounted) return;
      if (r != null && r['next'] == 'agent') {
        _agentStarted = false; // hand back to the bridge starter
        // ignore: unawaited_futures
        _startAgentBridge(r['start'] is Map
            ? (r['start'] as Map).cast<String, dynamic>()
            : null);
      } else if (r != null && r['next'] == 'busy') {
        _showPostRingBusy(r);
      } else if (r != null && r['next'] == 'voicemail') {
        // Agent slot gone between the tap and the probe (Mode A overflow) —
        // fall back to the voicemail card flow.
        setState(() {
          _routingInfo = r;
          _routingFetched = true;
          _agentStatus = 'failed';
        });
      } else {
        setState(() => _agentStatus = 'failed');
      }
    });
  }

  Future<void> _startAgentBridge(Map<String, dynamic>? start) async {
    if (_agentStarted) return;
    _agentStarted = true;
    setState(() => _agentStatus = 'connecting');
    final s = await AgentCallApi.start(
      to: (start?['to'] ?? widget.seed).toString(),
      callId: (start?['call_id'] ?? widget.room).toString(),
      traceId: (start?['trace_id'] ?? widget.traceId).toString(),
    );
    if (!mounted) return;
    final rtcUrl = s?['rtc_url'] as String?;
    if (s == null || rtcUrl == null) {
      _onAgentFailed();
      return;
    }
    final call = AgentVoiceCall(rtcUrl: rtcUrl);
    _agentCall = call;
    call.onStatus = (status) {
      if (mounted && status != 'ended') setState(() => _agentStatus = status);
    };
    // ignore: unawaited_futures
    call.done.then((reason) {
      if (!mounted) return;
      _agentCall = null;
      if (reason == 'agent_fail') {
        _onAgentFailed();
      } else {
        setState(() => _agentStatus = 'ended');
        // Conversation over — end the session cleanly (pops via onRequestPop).
        _session.endByUser();
      }
    });
    final ok = await call.start();
    if (!ok && mounted && _agentStatus != 'failed') {
      _onAgentFailed();
    }
  }

  // [RECEPT-SETTINGS-1] voicemail removed — when Ava's live agent can't take the
  // call there is no voicemail fallback; end the call cleanly with an honest
  // message. (The `fallbackVoicemail` param is gone with the feature.)
  void _onAgentFailed() {
    _agentCall = null;
    setState(() => _agentStatus = 'failed');
    ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("Couldn't connect to the Ava AI agent")));
    _session.endByUser();
  }

  void _hangupAgent() {
    final call = _agentCall;
    _agentCall = null;
    if (call != null) unawaited(call.hangup());
    _session.endByUser();
  }

  /// Post-ring busy (plan §15.1 — paid lines never overflow to voicemail):
  /// busy tone + PaidBusyCard, mirroring place_1to1_call.dart's pre-ring path.
  void _showPostRingBusy(Map<String, dynamic> r) {
    final kind = (r['busy_kind'] ?? '').toString();
    var msg = (r['message'] ?? '').toString();
    if (msg.isEmpty) {
      msg = kind == 'agents_full'
          ? 'All agents are busy right now — please try again in a while.'
          : 'This line is busy. Please try again later.';
    }
    setState(() => _postRingBusy = {'kind': kind, 'message': msg});
    final player = RingbackPlayer();
    unawaited(player.playBusyTone().catchError((_) {}).whenComplete(
        () => Future.delayed(const Duration(seconds: 3), player.dispose)));
  }

  @override
  void initState() {
    super.initState();
    // Attach to (or create) the app-level session for this call. The manager
    // owns it; this widget only listens.
    _session = CallSessionManager.instance.attach(CallSessionConfig(
      room: widget.room,
      title: widget.title,
      seed: widget.seed,
      video: widget.video,
      outgoing: widget.outgoing,
      avatarUrl: widget.avatarUrl,
      ringbackUrl: widget.ringbackUrl,
      teamId: widget.teamId,
      teamSlot: widget.teamSlot,
      traceId: widget.traceId, // [TRACE-ID-1]
      business: widget.business, // [DIALPAD-BIZ-CALLS Phase C]
      deferRing: widget.deferRing, // [INSTANT-CALL-MOUNT-1]
    ));
    // The session asks us to pop when a call ends (busy/decline/hangup, after
    // the ringback grace delay). Guarded so it fires once.
    _session.onRequestPop = _popIfMounted;
    // User-facing snackbars stay in the view; the session invokes these hooks.
    _session.setNoticeHooks(
      mediaDenied: () {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text('Microphone permission is needed to make a call')));
        }
      },
      placeCallFailed: () {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text("Couldn't reach ${widget.title} — retry?"),
            // [CALL-DIAL-FAIL-1] Redial (not just pop) when the launch site gave
            // us a hook — mirrors the in-sticker Retry button below.
            action: SnackBarAction(
              label: 'Retry',
              onPressed: () {
                final retry = widget.onRetry;
                _popIfMounted();
                retry?.call();
              },
            ),
          ));
        }
      },
      unreachable: () {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Text('${widget.title} is unreachable right now')));
        }
      },
      // [RECEPT-SETTINGS-1] voicemail removed — no voicemail status snackbars.
    );
    _session.revision.addListener(_onSessionChanged);
    _session.uiPhase.addListener(_onSessionChanged);
    _session.elapsedSeconds.addListener(_onSessionChanged);
    _session.muted.addListener(_onSessionChanged);
    _session.speakerOn.addListener(_onSessionChanged);
    _session.cameraOn.addListener(_onSessionChanged);
    _session.videoActive.addListener(_onSessionChanged);
    _session.onCellularHold.addListener(_onSessionChanged);
    _maybeFetchNoAnswerRouting(); // pre-seed from widget.initialRouted, if any
    // [DIALPAD-BIZ-CALLS Phase C] Server said 'agent' before the ring even
    // started (offline / auto profile with no reachable device) — connect the
    // caller to the agent right away instead of ringing into nobody for 35s.
    if (widget.initialRouted == 'receptionist') {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _session.noteServerReceptionistRoute();
      });
    } else if (widget.initialRouted == 'agent' && RemoteConfig.voiceAgent) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || _agentStarted) return;
        _session.businessAgentHandoff('no_answer');
        // ignore: unawaited_futures
        _startAgentBridge(widget.initialRoutingStart);
      });
    } else {
      _armAgentAutoProbe();
    }
  }

  void _onSessionChanged() {
    _maybeFetchNoAnswerRouting();
    _maybeStartAgentFromPhase(); // [DIALPAD-BIZ-CALLS Phase C]
    if (mounted) setState(() {});
  }

  void _popIfMounted() {
    if (_popped || !mounted) return;
    // CALL-UI-DEAD-1: use a DIRECT pop. `Navigator.maybePop()` consults this
    // screen's PopScope(canPop:false) and silently REFUSES to pop the route —
    // that deadlock is why end-call/minimize/back all appeared to do nothing
    // and users had to force-exit the app. `pop()` bypasses the PopScope veto.
    final nav = Navigator.of(context);
    if (nav.canPop()) {
      _popped = true; // latch ONLY after we know a pop will actually happen
      nav.pop();
      return;
    }
    // CALL-UI-DEAD-2 (2026-07-12): the call screen is the FIRST/only route —
    // cold-start straight into a call (push / CallKit tap), or the launching
    // surface (e.g. the dialpad bottom sheet) was already gone. A bare pop()
    // no-ops here, and the OLD code latched `_popped = true` BEFORE checking
    // canPop(), so once the ~1.4s natural-end auto-pop hit this branch every
    // later exit (red hang-up, ⌄ minimize, system back) dead-ended at the
    // `_popped` guard — the user was stranded on the "Call ended" screen with a
    // dead red button. Replace this route with the app root so there is ALWAYS
    // a way out, and only latch after we've actually navigated.
    _popped = true;
    nav.pushReplacement(MaterialPageRoute(builder: (_) => const RootFlow()));
  }

  /// Close a legacy terminal card without abandoning the CallSession. These
  /// cards are visually terminal, but the session deliberately stays alive for
  /// the Talk-to-Ava decision, so navigation must use the same serialized
  /// teardown as Call again and Message.
  Future<void> _closeOutcomeAndPop({required String reason}) async {
    try {
      await _session.dismissOutcomeAndWait(reason: reason);
    } catch (e, st) {
      Analytics.captureException(e, st,
          handled: true,
          screen: 'call_screen',
          extra: {'stage': 'outcome_close', 'reason': reason});
    } finally {
      _popIfMounted();
    }
  }

  @override
  void dispose() {
    // View detach ONLY — never tears down the call. The session (owned by the
    // manager) keeps the WS, PC, renderers and FGS alive so the call survives.
    _session.revision.removeListener(_onSessionChanged);
    _session.uiPhase.removeListener(_onSessionChanged);
    _session.elapsedSeconds.removeListener(_onSessionChanged);
    _session.muted.removeListener(_onSessionChanged);
    _session.speakerOn.removeListener(_onSessionChanged);
    _session.cameraOn.removeListener(_onSessionChanged);
    _session.videoActive.removeListener(_onSessionChanged);
    _session.onCellularHold.removeListener(_onSessionChanged);
    // Release our view-scoped hooks so a stale closure can't fire into a dead
    // context. If this exact session re-attaches to a new screen, it re-installs
    // them in initState.
    if (identical(_session.onRequestPop, _popIfMounted))
      _session.onRequestPop = null;
    _session.setNoticeHooks();
    // [DIALPAD-BIZ-CALLS Phase C] Tear down an orphaned agent bridge — the
    // AgentVoiceRoom DO finalizes (settle/refund/summary card) on WS close.
    if (_agentCall != null) unawaited(_agentCall!.hangup());
    _agentAutoProbe?.cancel();
    super.dispose();
  }

  // Red button: end the call (durable hangup) and pop.
  void _hangup() {
    // If the call has ALREADY ended (the "Call ended" screen), endByUser()'s
    // only dismissal path is a pop hook it may have already consumed/nulled —
    // so pop the screen directly instead. This is what makes the red button on
    // the terminal screen reliably exit (pic2). During a live call, fall
    // through to the durable hangup which tears down and then pops.
    if (_session.isEnded || _session.phase.value == CallPhase.ended) {
      _popIfMounted();
      return;
    }
    _session.endByUser();
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  [ADDCALL-1-UI] ADD TO CALL — spec Specs/SPEC-ADD-TO-CALL-2026-08-06.md §9,
  //  PHASE 1 ONLY.
  //
  //  Phase 1 is deliberately the CHEAP version the spec calls "a valid
  //  intermediate": create the invisible room, END the 1:1, join the conference
  //  cold. There WILL be a 2–4 second gap. Make-before-break (carrying the live
  //  capture stream onto the SFU leg and only then releasing the P2P leg) is
  //  Phase 2 and is NOT here — do not add it piecemeal, it needs the migration
  //  coordinator, the DO reservation and the relaxed busy guards together.
  //
  //  THE ORDER OF OPERATIONS IS THE WHOLE DESIGN. Read it before changing it:
  //
  //   1. Everything that can refuse is checked or attempted while the 1:1 is
  //      STILL UP. The picker, the navigator lookup and the `create` round-trip
  //      all happen first, so every refusal — flag off, identity gate, cap,
  //      blocked contact, no network — leaves the user on exactly the call they
  //      were on, with a sentence explaining why. Nothing is torn down on a
  //      maybe.
  //   2. Only after the server has returned a real `conv_id` do we end the 1:1.
  //   3. We WAIT for the teardown before joining. This is the "most easily
  //      missed blocker in the whole feature" (spec §4.3 item 3): both
  //      `CloudflareConferenceController.activeGid` and `callIsGenuinelyActive()`
  //      refuse a second call, and `gLiveCallScreens` is only decremented inside
  //      `CallSession._teardown`. Joining before that lands presents as "Add to
  //      call does nothing", silently, on the initiator's own device.
  //
  //  On the guards specifically: this path does NOT relax them and does not need
  //  to, because Phase 1 never overlaps two calls. It SEQUENCES around them —
  //  `await endByUser()` (which awaits `hangup` → `_teardown`) plus a bounded
  //  poll on `callIsGenuinelyActive()`. Phase 2 is where they genuinely have to
  //  be relaxed, because the overlap is the point.
  // ───────────────────────────────────────────────────────────────────────────

  /// Bounded wait for the one-call-at-a-time guard to actually clear.
  ///
  /// `endByUser()` awaits the memoized teardown, so this is normally already
  /// true on entry and costs nothing. It exists because the teardown time-boxes
  /// every native await (`_safeAwait`, 2s each) and swallows failures — a wedged
  /// method channel can therefore return from `hangup` with the counter still
  /// up. Returns whether the guard cleared; the caller reports it rather than
  /// hiding it.
  Future<bool> _awaitCallGuardClear({int budgetMs = 4000}) async {
    final sw = Stopwatch()..start();
    while (callIsGenuinelyActive() && sw.elapsedMilliseconds < budgetMs) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    return !callIsGenuinelyActive();
  }

  void _escalationSnack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _addToCall() async {
    if (_escalating) return;
    // Defensive: the tile is not rendered when the flag is off, so reaching this
    // means the config flipped mid-call. The server would 403 `disabled` anyway.
    if (!RemoteConfig.addToCallEnabled) return;

    final callId = widget.room;
    // Shared funnel key across client and worker (spec §10) — `adhoc_room.ts`
    // builds the byte-identical string from the same call id, so one escalation
    // reconstructs as one funnel in PostHog the way `rec_id` does for recordings.
    final escalationId = 'addcall:$callId';
    final peerUid = widget.seed;
    if (peerUid.isEmpty) {
      _escalationSnack("We couldn't work out who else is on this call.");
      return;
    }

    final picked = await showAddToCallSheet(
      context,
      callId: callId,
      // You + the peer. The cap counts everyone in the room, so the picker
      // offers at most 8.
      alreadyOnCall: 2,
      excludeUids: {peerUid},
    );
    if (!mounted || picked == null || picked.isEmpty) return;

    // Resolve the navigator BEFORE tearing anything down. Without it we could
    // end the 1:1 and then have nowhere to put the conference — the exact
    // "lost their call for nothing" outcome this whole ordering exists to avoid.
    final nav = navigatorKey.currentState;
    if (nav == null) {
      Analytics.capture(CallEvents.groupcallEscalateFailed, {
        'escalation_id': escalationId,
        'call_id': callId,
        'reason': 'no_navigator',
        'stage': 'preflight',
      });
      _escalationSnack("We couldn't open the group call. Please try again.");
      return;
    }

    // Snapshot everything we need AFTER the call is gone: the session's own
    // notifiers are reset by teardown, and `widget`/`context` die with the pop.
    final wantVideo = _session.videoActive.value && _session.cameraOn.value;
    final peerName = widget.title;
    final peerAvatar = widget.avatarUrl;
    final invitees = picked.map((c) => c.uid).toList();
    final title = _escalatedTitle(peerName, picked);

    setState(() => _escalating = true);

    Analytics.capture(CallEvents.groupcallEscalateStarted, {
      'escalation_id': escalationId,
      'call_id': callId,
      'phase': 1,
      'peer_uid': peerUid,
      'invitee_count': invitees.length,
      'member_count': invitees.length + 2,
      'kind': wantVideo ? 'video' : 'audio',
      // Tag every participant (CLAUDE.md): a multi-party event must be
      // retrievable from ANY of the people in it, not just whoever pressed Add.
      'participants': [peerUid, ...invitees],
    });

    // ── Step 1: create the room. The 1:1 is untouched no matter what this does.
    final res = await AdhocRoomApi.create(
      callId: callId,
      peerUid: peerUid,
      invitees: invitees,
      title: title,
    );
    if (!res.ok) {
      Analytics.capture(CallEvents.groupcallEscalateFailed, {
        'escalation_id': escalationId,
        'call_id': callId,
        'reason': res.raw,
        'error': res.error?.name,
        'http': res.status,
        'stage': 'create',
        'invitee_count': invitees.length,
      });
      // The identity gate is the ONE case we stay silent on: `ApiAuth`'s global
      // interceptor has already put the consent/Didit flow on screen, and a
      // snackbar underneath it would be a second, competing instruction.
      if (res.error != AdhocRoomError.identityRequired) {
        _escalationSnack(res.message);
      }
      if (mounted) setState(() => _escalating = false);
      return;
    }
    final gid = res.convId ?? '';
    if (gid.isEmpty) {
      Analytics.capture(CallEvents.groupcallEscalateFailed, {
        'escalation_id': escalationId,
        'call_id': callId,
        'reason': 'empty_conv_id',
        'stage': 'create',
      });
      _escalationSnack("We couldn't set up the group call. Please try again.");
      if (mounted) setState(() => _escalating = false);
      return;
    }

    Analytics.capture(CallEvents.groupcallInviteCreated, {
      'escalation_id': escalationId,
      'call_id': callId,
      'gid_hash': gid.hashCode.toString(),
      'member_count': res.members.length,
      'invitee_count': invitees.length,
      'participants': res.members,
    });

    // ── Step 2: end the 1:1. Past this line the call is gone and `mounted` is
    // false (endByUser consumes the pop hook), so nothing below may touch
    // `context` or `setState` — everything uses `nav` and `Analytics`.
    try {
      await _session.endByUser();
    } catch (e, st) {
      // Teardown swallows its own failures; if one escapes, the call is still
      // going away, so we continue into the conference rather than stranding
      // the user between two calls.
      Analytics.captureException(e, st,
          handled: true,
          screen: 'call_screen',
          extra: {'stage': 'escalate_hangup', 'escalation_id': escalationId});
    }

    // ── Step 3: wait for the guard, then join cold.
    final guardCleared = await _awaitCallGuardClear();
    Analytics.capture(CallEvents.groupcallReleaseP2p, {
      'escalation_id': escalationId,
      'call_id': callId,
      'gid_hash': gid.hashCode.toString(),
      'guard_cleared': guardCleared,
      'phase': 1,
    });

    if (CloudflareConferenceController.activeGid != null) {
      // Should be impossible — we were on a 1:1, not a conference — but if a
      // stale gid is latched, joining would be refused deep inside the
      // controller with no message. Say it here instead, and offer the 1:1 back.
      Analytics.capture(CallEvents.groupcallEscalateFailed, {
        'escalation_id': escalationId,
        'call_id': callId,
        'reason': 'conference_already_active',
        'stage': 'join',
      });
      _offerCallBack(nav, peerUid, peerName, peerAvatar, wantVideo,
          "We couldn't start the group call.");
      return;
    }

    final joinedAt = DateTime.now().millisecondsSinceEpoch;
    await nav.push(MaterialPageRoute(
      builder: (_) => CloudflareConferenceScreen(
        gid: gid,
        title: title,
        video: wantVideo,
        // We minted the room, so we are the starter — that is what writes the
        // OUTGOING call-history row, which is the only place an ad-hoc call
        // appears at all (the conversation itself is invisible by design).
        starter: true,
      ),
    ));

    // ── If the conference route came back almost immediately, the join failed
    // (or the screen refused to mount) rather than a call having happened. We
    // cannot read the controller's state from here — it is disposed with the
    // route — so the duration is the honest available signal, and it is used
    // ONLY to decide whether to OFFER the 1:1 back. It never redials on its own.
    final lifeMs = DateTime.now().millisecondsSinceEpoch - joinedAt;
    if (lifeMs < 10000) {
      Analytics.capture(CallEvents.groupcallEscalateFailed, {
        'escalation_id': escalationId,
        'call_id': callId,
        'gid_hash': gid.hashCode.toString(),
        'reason': 'conference_ended_immediately',
        'stage': 'join',
        'conference_life_ms': lifeMs,
      });
      _offerCallBack(nav, peerUid, peerName, peerAvatar, wantVideo,
          "The group call didn't connect.");
      return;
    }

    Analytics.capture(CallEvents.groupcallEscalateCompleted, {
      'escalation_id': escalationId,
      'call_id': callId,
      'gid_hash': gid.hashCode.toString(),
      'conference_life_ms': lifeMs,
      'member_count': res.members.length,
      'phase': 1,
    });
  }

  /// The one place a failed escalation is made good: a snackbar that offers to
  /// put the original 1:1 back, on a tap. Deliberately NOT an automatic redial —
  /// silently ringing someone again is worse than leaving the user in control,
  /// and the peer may already have been rung by the conference.
  ///
  /// Runs after this State is disposed, so it takes the navigator explicitly and
  /// never reads `context` / `mounted`.
  void _offerCallBack(NavigatorState nav, String peerUid, String peerName,
      String peerAvatar, bool video, String why) {
    final ctx = nav.context;
    final messenger = ScaffoldMessenger.maybeOf(ctx);
    if (messenger == null) return;
    messenger.showSnackBar(SnackBar(
      duration: const Duration(seconds: 8),
      content: Text('$why Call $peerName back?'),
      action: SnackBarAction(
        label: 'Call back',
        onPressed: () {
          Analytics.capture('addcall_call_back_tapped', {'peer_uid': peerUid});
          unawaited(place1to1Call(ctx,
              uid: peerUid,
              name: peerName,
              avatarUrl: peerAvatar,
              video: video));
        },
      ),
    ));
  }

  /// "Ana & Ben" — the call-history title for the escalated call. The server
  /// derives its own when we send none; we send one because we know the display
  /// names the user actually sees, and it has to match the row they will find in
  /// their call log.
  String _escalatedTitle(String peerName, List<Contact> picked) {
    final names = <String>[
      if (peerName.trim().isNotEmpty) peerName.trim(),
      ...picked.map((c) => c.name.trim()).where((n) => n.isNotEmpty),
    ];
    if (names.isEmpty) return 'Group call';
    if (names.length == 1) return names.first;
    final head = names.take(3).toList();
    final extra = names.length - head.length;
    final base =
        '${head.sublist(0, head.length - 1).join(', ')} & ${head.last}';
    return extra > 0 ? '$base +$extra' : base;
  }

  /// Back gesture / header ⌄ button: MINIMIZE, not hang up. Keeps the call alive
  /// (the session owns the WS/PC/renderers/FGS) and shows the floating video
  /// thumbnail / audio pill via [CallOverlay]. If the call has already ended
  /// (e.g. a busy/declined sticker is showing), fall through to a plain pop.
  void _minimize() {
    if (_popped) return;
    if (_session.isEnded || _session.phase.value == CallPhase.ended) {
      // [CALL-MENU-FIX-2] Back-nav — the header back button, the system back
      // gesture (PopScope), and the control row's chat-minimize icon all funnel
      // through here — while a terminal outcome surface (outcome-menu / busy /
      // no-answer / declined / network-error) owns the screen. `_popIfMounted()`
      // below is a PURE navigation pop; it never touches the session (dispose()
      // is view-detach only by design). Before this fix that meant backing out
      // of the outcome menu never reached the session's teardown, leaking the
      // SAME one-call guard slot as an un-dismissed "Call again" tap.
      // `dismissOutcomeAndWait` checks `_ended` first, so this is a safe no-op
      // for a session whose own terminal path already fully closed it.
      if (_session.isOutcomeSurface) {
        Analytics.capture('call_menu_option_selected', {
          'call_id': widget.room,
          'option': 'back_nav',
        });
      }
      unawaited(_session.dismissOutcomeAndWait(reason: 'back-nav'));
      _popIfMounted();
      return;
    }
    // Mark popped BEFORE handing off — minimizeActiveCall pops this route, and
    // a racing onRequestPop/back-gesture must not attempt a second pop.
    _popped = true;
    minimizeActiveCall(_session, context);
  }

  @override
  Widget build(BuildContext context) {
    final s = _session;
    final phase = s.uiPhase.value;
    final connected = s.isConnected;
    final video = s.videoActive.value;
    final camOn = s.cameraOn.value;
    final speaker = s.speakerOn.value;
    final muted = s.muted.value;
    final showVideo = video && camOn;
    final light = !showVideo; // audio call → zine paper screen
    // [DIALER-UI-SPLIT 2026-07-12] Dialer-initiated audio calls wear the phone
    // dialer's DARK PhoneTheme surface instead of the messenger's cream paper,
    // so the dialer reads as its own app. The zine control circles / back button
    // / status sticker are all light-filled, so they stay legible on dark — only
    // the background and the hero name need recolouring.
    final dialerSkin = widget.dialer && light;
    // [CALL-DIAL-FAIL-1] 'network-error' joins the failed-sticker set so a
    // dead place-call POST/timeout reads as a clear failure, not a silent hang.
    final failed = phase == 'declined' ||
        phase == 'busy' ||
        phase == 'no-answer' ||
        phase == 'network-error';
    final bottomInset = MediaQuery.of(context).padding.bottom;
    // Five secondary controls now occupy two rows above the isolated hang-up.
    // Reserve their real footprint so the avatar/status content scrolls above
    // the controls instead of being centred underneath them on short phones.
    // [CALL-UI-GRID-2026-08-05] Was 222 for the old 3+2 circles + isolated
    // hang-up. The labelled 2x3 panel is taller: 14 card margin + 18 pad +
    // 2x(64 circle + 6 + ~15 label) + 18 row gap + 18 pad ≈ 238.
    // [CALLREC-UI-1] The Record row is a THIRD grid row (spec §5.2 — an
    // on-demand feature buried in the More sheet does not get used), so the
    // reserved footprint has to grow with it or the hero avatar scrolls under
    // the panel again. Following the same arithmetic: one more row gap
    // (Msg.s4 = 16) + one more tile (64 circle + Msg.s1 = 4 + ~15 label) ≈ 99,
    // rounded to 100 for the same slack the 250 above carries.
    // [CALL-UI-GRID-2] This used to be `callRecordingEnabled ? 350 : 250`,
    // because row 3 held Record and nothing else. Row 3 now also holds Hold,
    // which is UNCONDITIONAL (it is not a recording feature and has no flag),
    // so the third row always renders and the reservation is always 350. With
    // the recording flag off, Record's third collapses to SizedBox.shrink()
    // INSIDE a row that still occupies its full height — a shorter reservation
    // would put the panel back over the avatar.
    //
    // [CALL-UI-COLLAPSE-1] This constant is NOT touched by the collapsible
    // panel. It is read in exactly one place — the `if (light)` audio subtree
    // below, as scroll padding / minHeight so the hero avatar cannot scroll
    // under the panel — and the audio panel never collapses. On video the
    // panel is a plain bottom-anchored overlay over a Positioned.fill video
    // surface, so it reserves nothing and collapsing it hands the full frame
    // back with no layout arithmetic at all.
    const controlPanelHeight = 350.0;
    // [CALL-UI-COLLAPSE-1] Collapsed ONLY ever on video. Deriving it here
    // rather than reading `_panelCollapsed` raw is what makes the camera-off
    // edge case safe: the instant `showVideo` goes false the audio layout
    // renders with its controls fully visible, whatever the remembered flag
    // says. Turning the camera back on restores the user's last choice.
    final panelCollapsed = showVideo && _panelCollapsed;
    // [CALL-UI-COLLAPSE-1] Hoisted out of the `if (...)` that used to guard the
    // control panel inline, so the collapsed handle below can share it — a
    // handle offering to reveal a panel that the outcome surface has taken
    // over would be a dead control.
    final showControls = !s.showOutcomeMenu &&
        !s.showBusyCard &&
        phase != 'no-answer' &&
        phase != 'agent-handoff';
    // [ISSUE-VIDEO-TEXTNOTE-KEYBOARD-1] Keyboard height (0 when closed) — the
    // video outcome-menu overlay bottoms out at its top edge while typing.
    final keyboardInset = MediaQuery.of(context).viewInsets.bottom;
    final stack = Stack(
      children: [
        // [CALL-UI-STACK-FIX 2026-07-14] Anchor the Stack to the full body size.
        // Scaffold lays its body out with LOOSE constraints, and since
        // CALL-UI-FIXES-2026-07-12 (008644c) turned the audio content into a
        // Positioned.fill, the only NON-positioned child left here was the
        // SafeArea header row — so the whole Stack collapsed to ~header height:
        // the bottom-pinned control row rendered at the TOP of the screen and
        // the hero avatar clipped to an arc (owner screenshot 2026-07-14).
        // Positioned/Positioned.fill children never size a Stack; this
        // non-positioned SizedBox.expand() does, restoring the full-screen
        // canvas for BOTH the audio and video layouts.
        const SizedBox.expand(),
        if (showVideo) ...[
          Positioned.fill(
            child: connected
                ? RTCVideoView(s.remoteRenderer,
                    objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover)
                : Container(color: AD.bg),
          ),
          // [CALL-UI-COLLAPSE-1] Tap anywhere on the video to show/hide the
          // controls. A drag-only affordance is easy to miss, and this is the
          // gesture every other video-calling app trains people on. It also
          // settles the End-button question: hang-up is never more than one tap
          // (reveal) plus one tap (End) away, so no second floating End button
          // is needed — and adding one would put a destructive control on the
          // video surface with nothing to stop a mis-tap.
          //
          // It sits EARLY in the Stack on purpose. Stack hit-tests children in
          // reverse paint order, so the self-view flip target, the header, the
          // control panel and the outcome menu — all added after this — win any
          // overlap; this only ever receives taps on bare video.
          Positioned.fill(
            child: GestureDetector(
              // `opaque`: the child is an empty box over a platform view, which
              // is not a reliable hit-test target on its own.
              behavior: HitTestBehavior.opaque,
              onTap: showControls ? () => _toggleControlPanel('tap_video') : null,
              onVerticalDragUpdate: showControls ? _onPanelDragUpdate : null,
              onVerticalDragEnd: showControls ? _onPanelDragEnd : null,
              child: const SizedBox.expand(),
            ),
          ),
          Positioned(
              top: 0,
              left: 0,
              right: 0,
              height: 128,
              child: IgnorePointer(
                  child:
                      Container(color: Colors.black.withValues(alpha: 0.45)))),
          // [CALL-UI-GRID-2] Tap the self-view to flip the camera.
          //
          // Camera flip used to live ONLY in the More sheet, which is gone; and
          // the self-view preview — the one place every other calling app puts
          // this gesture — was not tappable at all. It is now the single flip
          // affordance, with a small camera-rotate glyph in the corner so it is
          // discoverable rather than a hidden hotspot.
          //
          // No `canFlipCamera` gate is needed: this Positioned only builds when
          // `showVideo` (video && camOn), i.e. exactly when a live camera is
          // being sent, which is the condition the old sheet tested for.
          Positioned(
            top: 56,
            right: 16,
            width: 78,
            height: 112,
            child: Semantics(
              button: true,
              label: 'Switch camera',
              child: GestureDetector(
                // `opaque`, not the default `deferToChild`: the child is a
                // platform view (RTCVideoView) and a Stack of Positioned-only
                // children, neither of which is a reliable hit-test target.
                behavior: HitTestBehavior.opaque,
                // flipCamera is a Future<void>; nothing here needs its
                // completion, and an un-awaited call trips the analyzer.
                onTap: () => unawaited(s.flipCamera()),
                child: Stack(
                  children: [
                    Positioned.fill(
                      child: Container(
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(AD.rListCard),
                          border:
                              Border.all(color: AD.borderControl, width: 1),
                          boxShadow: const [],
                        ),
                        clipBehavior: Clip.antiAlias,
                        child: RTCVideoView(s.localRenderer,
                            mirror: true,
                            objectFit: RTCVideoViewObjectFit
                                .RTCVideoViewObjectFitCover),
                      ),
                    ),
                    // Understated corner glyph — the affordance, not a button.
                    Positioned(
                      right: 4,
                      bottom: 4,
                      child: Container(
                        padding: const EdgeInsets.all(4),
                        decoration: BoxDecoration(
                          color: Colors.black.withValues(alpha: 0.45),
                          shape: BoxShape.circle,
                        ),
                        child: PhosphorIcon(
                          PhosphorIcons.cameraRotate(PhosphorIconsStyle.bold),
                          size: 12,
                          color: Colors.white,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],

        // header: zine back circle + CENTRED peer name + encryption/state line
        // [CALL-UI-GRID-2026-08-05] The name used to live in the header on
        // VIDEO only, and a second, much larger copy sat under the avatar on
        // audio. It is now one centred header title on both, so the audio
        // screen reads as a call header rather than a profile card, and the
        // avatar/status block below it has room to breathe.
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s2, Msg.s4, 0),
            child: Row(
              children: [
                // Back = MINIMIZE (keeps the call alive as a PiP/pill), not hang up.
                AdBackButton(onTap: _minimize),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      Text(widget.title,
                          maxLines: 1,
                          textAlign: TextAlign.center,
                          overflow: TextOverflow.ellipsis,
                          style: ADText.threadName(
                              c: showVideo
                                  ? Colors.white
                                  : (dialerSkin
                                      ? PhoneTheme.text
                                      : AD.textPrimary))),
                      const SizedBox(height: 2),
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          PhosphorIcon(
                              PhosphorIcons.lock(PhosphorIconsStyle.fill),
                              size: 11,
                              color: showVideo
                                  ? AD.textSecondary
                                  : AD.textTertiary),
                          const SizedBox(width: 4),
                          Flexible(
                            child: Text(
                              // On video the timer has nowhere else to live
                              // (the audio screen shows it on the sticker under
                              // the avatar), so the subtitle carries it there.
                              showVideo
                                  ? (connected ? s.clock : s.statusText)
                                  : 'End-to-end encrypted',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: ADText.sectionLabel(
                                  c: showVideo
                                      ? AD.textSecondary
                                      : AD.textTertiary),
                            ),
                          ),
                        ],
                      ),
                      // [CALL-UI-GRID-2] The PEER's hold/mute state. Rendered
                      // here, in the header, so it appears on BOTH the audio
                      // and the video layout from one call site — and directly
                      // under the status line, which is where a user looks
                      // when a call goes quiet. It collapses to nothing when
                      // the peer is neither holding nor muted, so the normal
                      // call costs no layout.
                      _PeerStateLine(
                          session: s, name: widget.title, onVideo: showVideo),
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                // Explicit ⌄ minimize control — shrink to the floating thumbnail
                // (video) or the ongoing-call pill (audio) and return to the app.
                _MinimizeButton(light: light, onTap: _minimize),
              ],
            ),
          ),
        ),

        // audio call: paper screen — ink-ringed avatar, name, mono call-state sticker.
        // [NOTE-COMPOSER-LAYOUT 2026-07-12] Scrollable + keyboard-aware so the
        // text/voice note composer (opened from the outcome menu) scrolls above
        // BOTH the keyboard and the bottom control row instead of being drawn
        // underneath them. Reserves the control-row footprint as bottom padding;
        // the ConstrainedBox keeps the content vertically centred when it fits.
        if (light)
          Positioned.fill(
            child: SingleChildScrollView(
              padding: EdgeInsets.fromLTRB(24, 0, 24,
                  controlPanelHeight + (bottomInset > 0 ? bottomInset : 16)),
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  minHeight: MediaQuery.of(context).size.height -
                      MediaQuery.of(context).viewInsets.bottom -
                      (controlPanelHeight +
                          (bottomInset > 0 ? bottomInset : 16)),
                ),
                child: Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (s.isReceptDuo && s.receptionist != null) ...[
                        _ReceptionistDuo(
                          mic: s.receptionist!.micLevel,
                          ava: s.receptionist!.avaLevel,
                          me: Avatar(
                              seed: s.mySeed,
                              name: s.myName,
                              size: 88,
                              avatarUrl:
                                  s.myAvatar.isEmpty ? null : s.myAvatar),
                          myLabel: s.myName,
                        ),
                        const SizedBox(height: Msg.s5),
                        Text('Ava',
                            textAlign: TextAlign.center,
                            style: ADText.appTitle().copyWith(fontSize: 28)),
                      ] else ...[
                        Container(
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            color:
                                phase == 'ava-countdown' ? AD.iconVideo : null,
                            border:
                                Border.all(color: AD.borderAvatar, width: 2),
                            boxShadow: const [],
                          ),
                          child: phase == 'ava-countdown'
                              ? SizedBox(
                                  width: 132,
                                  height: 132,
                                  child: Center(
                                      child: Text('${s.avaCount}',
                                          style: ADText.appTitle()
                                              .copyWith(fontSize: 76))),
                                )
                              : Avatar(
                                  seed: widget.seed,
                                  name: widget.title,
                                  size: 132,
                                  avatarUrl: widget.avatarUrl.isEmpty
                                      ? null
                                      : widget.avatarUrl),
                        ),
                        // [CALL-UI-GRID-2026-08-05] The 28px name that used to
                        // sit here is gone — it is now the centred header
                        // title, exactly once, as on every other call UI.
                      ],
                      const SizedBox(height: 24),
                      // [CALL-OUTCOME-MENU-1] Unified call outcome menu — ONE surface
                      // for declined / no-answer / unreachable / busy while
                      // callMenuEnabled (Specs/CALL-OUTCOME-MENU-SPEC-2026-07-09.md).
                      // Renders instead of the busy card / plain sticker; with the
                      // flag off it never constructs and everything below is legacy.
                      if (s.showOutcomeMenu)
                        // [ISSUE-VIDEO-OUTCOME-MENU-1] AUDIO path — unchanged. The menu
                        // still renders right here, in the same slot and stacking order
                        // as before, so the paper screen is pixel-identical. The SAME
                        // widget is now ALSO rendered as a top-level overlay for VIDEO
                        // calls (last child of this Stack); both call sites go through
                        // _outcomeMenu() so their arguments can never drift apart.
                        _outcomeMenu()
                      // [BUSY-CARD-1] Personalized busy card — replaces the cold
                      // "User is busy" sticker when the server told us WHY the callee
                      // is busy (Specs §3.1). Only on the terminal 'busy' phase and
                      // only when the field/flag gate is satisfied; otherwise the
                      // legacy sticker below renders unchanged.
                      else if (s.showBusyCard)
                        BusyCard(
                          name: widget.title,
                          busyReason: s.busyReason ?? '',
                          pronoun: s.busyPronoun,
                          receptionistEnabled: s.busyReceptionistEnabled,
                          notifyInFlight: s.busyNotifyInFlight,
                          notifyRegistered: s.busyNotifyRegistered,
                          onCancel: () {
                            s.busyCancel();
                            _popIfMounted();
                          },
                          onNotifyMe: () {
                            // ignore: unawaited_futures
                            s.busyNotifyMe();
                          },
                          onLeaveMessage: () {
                            // ignore: unawaited_futures
                            s.busyLeaveMessage();
                          },
                        )
                      // [DIALPAD-BIZ-CALLS Phase C] Live Ava AI agent bridge — the
                      // caller is talking (or connecting) to the callee's Grok
                      // voice agent. Takes precedence over the no-answer card.
                      else if (_agentActive ||
                          _agentStatus == 'connecting' ||
                          _agentStatus == 'connected')
                        _AgentCallPanel(
                          name: widget.title,
                          status: _agentStatus,
                          onHangup: _hangupAgent,
                        )
                      // [DIALPAD-BIZ-CALLS Phase C] Post-ring busy (plan §15.1):
                      // the ring genuinely timed out and /api/call/no-answer said
                      // 'busy' (paid line, all agents full / human busy) — busy
                      // card, never voicemail.
                      else if (_postRingBusy != null)
                        PaidBusyCard(
                          name: widget.title,
                          message: (_postRingBusy!['message'] ?? '').toString(),
                          onTryAgain: () async {
                            Analytics.capture('call_menu_option_selected', {
                              'call_id': widget.room,
                              'option': 'call_again',
                            });
                            final nav = Navigator.of(context);
                            final uidSeed = widget.seed,
                                title = widget.title,
                                avatar = widget.avatarUrl,
                                vid = widget.video;
                            // [CALL-MENU-FIX-2] Serialized teardown BEFORE redial — same
                            // leaked-guard-slot bug as the unified menu's Call again, just
                            // on the legacy business post-ring-busy card.
                            try {
                              await s.dismissOutcomeAndWait(
                                  reason: 'call-again');
                            } catch (e, st) {
                              Analytics.captureException(e, st,
                                  handled: true,
                                  screen: 'call_screen',
                                  extra: {'stage': 'paid_busy_try_again'});
                            }
                            _popIfMounted();
                            unawaited(place1to1Call(nav.context,
                                uid: uidSeed,
                                name: title,
                                avatarUrl: avatar,
                                video: vid,
                                business: widget.business));
                          },
                          onClose: () {
                            unawaited(
                                _closeOutcomeAndPop(reason: 'paid-busy-close'));
                          },
                        )
                      // [DIALPAD-BIZ-CALLS] Phone-style "no answer" card for the
                      // CALLER on an outgoing business (dialpad) call — replaces
                      // dropping straight into the messenger thread. Only the
                      // legacy plain sticker below is shown while the flag is off
                      // (existing behaviour preserved byte-for-byte).
                      else if (RemoteConfig.businessCallUx &&
                          widget.outgoing &&
                          phase == 'no-answer')
                        NoAnswerCard(
                          name: widget.title,
                          seed: widget.seed,
                          avatarUrl: widget.avatarUrl,
                          // [RECEPT-SETTINGS-1] voicemail removed — the card now
                          // offers Call again / Save contact / Close only.
                          onCallAgain: () async {
                            Analytics.capture('call_menu_option_selected', {
                              'call_id': widget.room,
                              'option': 'call_again',
                            });
                            final nav = Navigator.of(context);
                            final uidSeed = widget.seed,
                                title = widget.title,
                                avatar = widget.avatarUrl,
                                vid = widget.video;
                            // [CALL-MENU-FIX-2] Serialized teardown BEFORE redial — the
                            // legacy business no-answer card has the same shape as the
                            // unified menu's Call again and leaked the same guard slot.
                            try {
                              await s.dismissOutcomeAndWait(
                                  reason: 'call-again');
                            } catch (e, st) {
                              Analytics.captureException(e, st,
                                  handled: true,
                                  screen: 'call_screen',
                                  extra: {'stage': 'no_answer_call_again'});
                            }
                            _popIfMounted();
                            // nav.context stays mounted after this route pops (it's
                            // the ancestor Navigator), so it's safe to push from here.
                            unawaited(place1to1Call(nav.context,
                                uid: uidSeed,
                                name: title,
                                avatarUrl: avatar,
                                video: vid,
                                business: widget.business));
                          },
                          onSaveContact: () async {
                            try {
                              await ContactsStore().add(Contact(
                                  uid: widget.seed,
                                  name: widget.title,
                                  avatarUrl: widget.avatarUrl));
                            } catch (_) {/* best-effort */}
                            if (mounted) {
                              ScaffoldMessenger.of(context).showSnackBar(
                                  const SnackBar(
                                      content: Text('Contact saved')));
                            }
                          },
                          onClose: () {
                            unawaited(
                                _closeOutcomeAndPop(reason: 'no-answer-close'));
                          },
                        )
                      else ...[
                        AdSticker(
                          connected ? s.clock : s.statusText,
                          kind: failed ? AdStickerKind.no : AdStickerKind.plain,
                        ),
                      ],
                      // [CALL-DIAL-FAIL-1] Retry affordance — only on the
                      // network-error terminal state, only when the launch site
                      // gave us a redial hook.
                      if (phase == 'network-error' &&
                          widget.onRetry != null) ...[
                        const SizedBox(height: Msg.s4),
                        AdButton(
                          label: 'Retry',
                          icon: PhosphorIcons.arrowClockwise(
                              PhosphorIconsStyle.bold),
                          onPressed: () {
                            final retry = widget.onRetry;
                            _popIfMounted();
                            retry?.call();
                          },
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),

        // [CALL-NETHUD-1] animated network health HUD — sits just under the
        // header, tap for a detail sheet. Only while the call is live.
        if (connected && !s.isReceptDuo)
          Positioned(
            top: MediaQuery.of(context).padding.top + 58,
            left: 0,
            right: 0,
            child: Center(
              child: _CallNetHud(session: s, onVideo: showVideo),
            ),
          ),

        // [CALLREC-UI-1] The recording indicator — spec §4's consent surface.
        //
        // This matters MORE for on-demand recording than it would for automatic
        // recording, because the other party gets no other warning at all. It is
        // rendered here, OUTSIDE the `light`/`showVideo` branches, so it appears
        // on both the audio (paper/dialer) and video (dark chrome) layouts; the
        // pill paints its own fill and ink, so it reads on either. It sits below
        // the network HUD (top + 58) rather than beside it, so neither clips the
        // other on a narrow handset.
        //
        // The pill renders NOTHING when no recording is running, so the
        // non-recording case costs no layout at all.
        //
        // [CALLREC-PEER-1] Gated on `callRecordingIndicatorEnabled` ALONE.
        // `callRecordingEnabled` used to be ANDed in here and that was a real
        // defect: it is the master switch on RECORDING, and a device with it off
        // (or a build that predates the feature flag being flipped on) can never
        // record — but it can absolutely BE recorded, and it is precisely that
        // device which needs to see the pill. Gating the display on the ability
        // to record hid the indicator from exactly the wrong person.
        if (RemoteConfig.callRecordingIndicatorEnabled)
          Positioned(
            top: MediaQuery.of(context).padding.top + 104,
            left: 0,
            right: 0,
            child: Center(
              child: _RecordingIndicatorPill(
                session: s,
                peerName: widget.title,
              ),
            ),
          ),

        // [CALL-TRANSLATE-UI-1 2026-08-05] The translate control used to live
        // HERE — a floating light-themed pill pinned top-right, the only
        // interactive thing on the call screen that wasn't in the control row.
        // It is now a normal 56x56 call control alongside mute/speaker/video;
        // see the `_controlRow` below. Nothing is rendered at this position any
        // more, and `CallTranslateOverlay` itself renders nothing at all unless
        // the flags and the native bridge allow translation.

        // [CALL-MENU-UI-1] The outcome surface owns the screen after the
        // dialing leg has ended. Do not leave live-call controls underneath it:
        // they look tappable but the peer connection and tracks are already
        // stopped, which caused speaker/audio state to appear broken.
        if (showControls)
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            // [CALL-UI-GRID-2026-08-05] Labelled 2x3 control panel.
            //
            // Replaces [CALL-CTRL-GRID-1]'s two bare circle rows + an isolated
            // hang-up. Three problems with that layout: the circles were
            // unlabelled, so "which one is the dialpad" was a guess; the rows
            // were centred Rows with hard 28px gaps, so the geometry shifted
            // whenever an optional control (camera flip, Translate) appeared or
            // vanished mid-call; and up to six controls competed for the same
            // level of attention.
            //
            // Now: one raised card, FIXED slots on a 3-column grid, each an
            // icon circle with a text label under it. Row one is the three
            // controls people reach for constantly (Speaker / Video / Mute);
            // row two is Keypad / Translate / End; row three is Record / Hold /
            // (reserved). Every slot is an Expanded third, so a hidden
            // Translate leaves its slot empty instead of re-centring the row
            // under the user's thumb.
            //
            // [CALL-UI-GRID-2] The More sheet is GONE. An overflow sheet
            // holding three items on a screen with a nine-slot grid was pure
            // indirection: Keypad is promoted into More's own slot, camera flip
            // moved onto the self-view preview (where every other calling app
            // puts it), and chat/minimize needed no replacement — the header
            // back button, the ⌄ button and the system back gesture all already
            // minimize.
            //
            // [CALL-UI-COLLAPSE-1] On VIDEO the whole card slides out of the
            // bottom edge and fades when collapsed. AnimatedSlide/AnimatedOpacity
            // rather than DraggableScrollableSheet: that widget is built for
            // scrollable content and fights a fixed tile grid. On audio both
            // wrappers are handed their identity values (offset zero, opacity
            // one) and the vertical-drag callbacks are null, so the audio panel
            // is exactly what it was.
            child: GestureDetector(
              behavior: HitTestBehavior.deferToChild,
              // Tile taps still win: a tap and a vertical drag are different
              // gestures, so the arena hands each to the right recogniser.
              onVerticalDragUpdate: showVideo ? _onPanelDragUpdate : null,
              onVerticalDragEnd: showVideo ? _onPanelDragEnd : null,
              child: AnimatedSlide(
                duration: const Duration(milliseconds: 200),
                curve: Curves.easeOutCubic,
                offset: panelCollapsed ? const Offset(0, 1) : Offset.zero,
                child: AnimatedOpacity(
                  duration: const Duration(milliseconds: 180),
                  opacity: panelCollapsed ? 0 : 1,
                  child: Container(
              margin: EdgeInsets.fromLTRB(
                  12, 0, 12, 12 + (bottomInset > 0 ? bottomInset : 4)),
              padding: const EdgeInsets.fromLTRB(Msg.s2, Msg.s5, Msg.s2, Msg.s5),
              decoration: BoxDecoration(
                color: light ? AD.card : Colors.black.withValues(alpha: 0.55),
                borderRadius: BorderRadius.circular(AD.rSheet),
                border: Border.all(color: AD.borderCard, width: 1),
              ),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Row(children: [
                  Expanded(
                    child: _CallTile(
                      icon: speaker
                          ? PhosphorIcons.speakerHigh(PhosphorIconsStyle.bold)
                          : PhosphorIcons.speakerSlash(PhosphorIconsStyle.bold),
                      label: 'Speaker',
                      active: speaker,
                      onTap: s.toggleSpeaker,
                    ),
                  ),
                  Expanded(
                    child: _CallTile(
                      icon: video && camOn
                          ? PhosphorIcons.videoCamera(PhosphorIconsStyle.bold)
                          : PhosphorIcons.videoCameraSlash(
                              PhosphorIconsStyle.bold),
                      label: 'Video',
                      active: video && camOn,
                      onTap: s.toggleCamera,
                    ),
                  ),
                  Expanded(
                    child: _CallTile(
                      icon: muted
                          ? PhosphorIcons.microphoneSlash(
                              PhosphorIconsStyle.bold)
                          : PhosphorIcons.microphone(PhosphorIconsStyle.bold),
                      label: 'Mute',
                      // Inverted vs the old row: the tile lights up when the mic
                      // is CUT, because that is the state you need to notice.
                      active: muted,
                      onTap: s.toggleMute,
                    ),
                  ),
                ]),
                const SizedBox(height: Msg.s4),
                Row(children: [
                  Expanded(
                    // [CALL-UI-GRID-2] Was "More". The overflow sheet is gone:
                    // it held exactly three things, and two of them (chat
                    // /minimize, camera flip) already have — or now have — a
                    // better home, while the third (the DTMF keypad) had NO
                    // other route at all and is the one control on this screen
                    // a user genuinely hunts for mid-call (IVR menus). It takes
                    // More's slot outright.
                    //
                    // phosphor_flutter 2.1.0 names this icon `numpad`. The
                    // obvious guess (the one starting "dial") does NOT exist
                    // and fails at kernel snapshot — i.e. only in CI, ~5
                    // minutes into a release build. Verify icon names against
                    // the package, not intuition.
                    child: _CallTile(
                      icon: PhosphorIcons.numpad(PhosphorIconsStyle.bold),
                      label: 'Keypad',
                      onTap: () => _showDtmfPad(s),
                    ),
                  ),
                  Expanded(
                    // Translate styles ITSELF to match `_CallTile` (same 64px
                    // circle, same AD tokens, same label slot) because it owns
                    // its own active/preparing state and the per-minute cost
                    // caption. When it is unavailable — non-Android, flags off,
                    // no native bridge — it collapses to nothing and this third
                    // of the row is simply empty; the neighbouring tiles do not
                    // move.
                    //
                    // [CALL-TRANSLATE-SLOT-1 2026-08-05] `connected` is now PASSED
                    // rather than used to decide whether to mount. Gating the mount
                    // meant the slot sat blank through ringing and the icon appeared
                    // out of nowhere on connect (owner report; measured at ~2.4s on
                    // avatok-7ed0f03c). The overlay renders a dimmed, inert tile
                    // until `callConnected` — and warms its native probe meanwhile,
                    // so the live control is ready the instant the call connects.
                    child: !s.isReceptDuo
                        ? Center(
                            child: CallTranslateOverlay(
                                callRef: s.room,
                                tile: true,
                                callConnected: connected))
                        : const SizedBox.shrink(),
                  ),
                  Expanded(
                    child: _CallTile(
                      icon: PhosphorIcons.phoneDisconnect(
                          PhosphorIconsStyle.fill),
                      label: 'End',
                      onTap: _hangup,
                      bg: AD.destructiveBg,
                      border: AD.destructiveBg,
                      ink: AD.destructiveInk,
                    ),
                  ),
                ]),
                // [CALLREC-UI-1] Third row: Record (spec §5.2 — an on-demand
                // feature buried in the More sheet does not get used).
                // Deliberately NOT gated on video: recording is audio-only and
                // unaffected by the camera (spec §3.4).
                //
                // [CALL-UI-GRID-2] The row itself is no longer gated on
                // `callRecordingEnabled`. Hold shares it and has no flag, so
                // the row ALWAYS renders and only Record's own third collapses
                // when recording is off. (`controlPanelHeight` above is a flat
                // 350 for the same reason.)
                //
                // Still three Expanded thirds: the equal-thirds geometry is
                // what stops a control moving under the user's thumb when an
                // optional tile appears or vanishes. The third slot was
                // RESERVED for "Add to call"; [ADDCALL-1-UI] fills it. It still
                // collapses to nothing when `addToCallEnabled` is off, for the
                // same reason it used to be left empty: a greyed-out placeholder
                // for a feature that cannot run is a dead control, which is
                // worse than a gap.
                const SizedBox(height: Msg.s4),
                Row(children: [
                  Expanded(
                    child: RemoteConfig.callRecordingEnabled
                        ? Center(
                            child: _CallRecordTile(
                              callId: s.room,
                              peerUid: widget.seed,
                              peerName: widget.title,
                              peerAvatar: widget.avatarUrl,
                              direction:
                                  widget.outgoing ? 'outgoing' : 'incoming',
                              callConnected: connected,
                            ),
                          )
                        : const SizedBox.shrink(),
                  ),
                  // [CALL-UI-GRID-2] Hold. `holdActive` is bumped through the
                  // session revision by `toggleHold`, but this binds to the
                  // notifier directly so the tile can never lag the latch.
                  Expanded(
                    child: ValueListenableBuilder<bool>(
                      valueListenable: s.holdActive,
                      builder: (context, held, _) {
                        final tile = _CallTile(
                          icon: PhosphorIcons.pause(PhosphorIconsStyle.bold),
                          label: held ? 'On hold' : 'Hold',
                          active: held,
                          // Holding a call that has not connected would hold
                          // ringback and nothing else — same reasoning, and the
                          // same dimmed-and-inert treatment, as the Record
                          // tile beside it.
                          onTap: connected
                              ? () => unawaited(s.toggleHold())
                              : null,
                        );
                        return connected
                            ? tile
                            : Opacity(opacity: 0.45, child: tile);
                      },
                    ),
                  ),
                  // [ADDCALL-1-UI] The reserved third slot, now filled — spec
                  // §9 Phase 1. HIDDEN ENTIRELY when `addToCallEnabled` is
                  // false, so with the flag off this row is byte-for-byte the
                  // Record / Hold / empty it has always been. (The row itself
                  // still renders unconditionally: Hold has no flag.)
                  //
                  // `userPlus` is a real phosphor_flutter 2.1.0 name — already
                  // used at search_screen.dart:515, chat_list.dart:2016 and
                  // group_info_screen.dart:727. A GUESSED Phosphor name compiles
                  // fine and fails at kernel snapshot, i.e. only in CI ~5 minutes
                  // into a release build (same trap as the `numpad` note on the
                  // Keypad tile above). Verify against the repo, not intuition.
                  Expanded(
                    child: RemoteConfig.addToCallEnabled
                        ? Builder(builder: (_) {
                            // Dimmed and inert until connected, exactly like the
                            // Record and Hold tiles beside it: escalating a call
                            // that has not connected would tear down a ringing
                            // leg and join a conference nobody is in. `_escalating`
                            // keeps it inert through the create round-trip too, so
                            // a double tap cannot mint two ad-hoc rooms.
                            final live = connected && !_escalating;
                            final tile = _CallTile(
                              icon: PhosphorIcons.userPlus(
                                  PhosphorIconsStyle.bold),
                              label: 'Add',
                              onTap: live ? () => unawaited(_addToCall()) : null,
                            );
                            return live
                                ? tile
                                : Opacity(opacity: 0.45, child: tile);
                          })
                        : const SizedBox.shrink(),
                  ),
                ]),
              ]),
                  ),
                ),
              ),
            ),
          ),

        // [CALL-UI-COLLAPSE-1] The collapsed affordance: a small translucent
        // chevron pill centred on the bottom edge. Understated on purpose — it
        // should read as "there is something here", not as chrome competing
        // with the video. Pull it up (or tap it, or tap the video) to bring the
        // controls back.
        //
        // VIDEO ONLY, and gated on `showControls` for the same reason the panel
        // is: once the outcome surface owns the screen there is no panel left
        // to reveal.
        //
        // NOTE ON THE ICON: `caretUp` is a real phosphor_flutter 2.1.0 name —
        // it is already used at ava_sidebar.dart:427 and chat_list.dart:556.
        // A guessed Phosphor name compiles fine and fails at kernel snapshot,
        // i.e. only in CI ~5 minutes into a release build (same trap as the
        // `numpad` note on the Keypad tile above).
        if (showVideo && showControls)
          Positioned(
            left: 0,
            right: 0,
            bottom: 8 + (bottomInset > 0 ? bottomInset : 4),
            child: IgnorePointer(
              ignoring: !panelCollapsed,
              child: AnimatedOpacity(
                duration: const Duration(milliseconds: 180),
                opacity: panelCollapsed ? 1 : 0,
                child: Center(
                  child: Semantics(
                    button: true,
                    label: 'Show call controls',
                    child: GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: () => _toggleControlPanel('tap_handle'),
                      onVerticalDragUpdate: _onPanelDragUpdate,
                      onVerticalDragEnd: _onPanelDragEnd,
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: Msg.s5, vertical: Msg.s2),
                        decoration: BoxDecoration(
                          color: Colors.black.withValues(alpha: 0.45),
                          borderRadius: BorderRadius.circular(AD.rSheet),
                          border:
                              Border.all(color: AD.borderControl, width: 1),
                        ),
                        child: PhosphorIcon(
                          PhosphorIcons.caretUp(PhosphorIconsStyle.bold),
                          size: 18,
                          color: Colors.white,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),

        // [ISSUE-VIDEO-OUTCOME-MENU-1] VIDEO path — the outcome menu used to live
        // ONLY inside the `if (light)` audio subtree, so on a video call
        // (showVideo == true → light == false) it was never built and the caller
        // got nothing but the header text + a snackbar when the callee was
        // unreachable. call_session already drives showOutcomeMenu for video
        // (no gate), and CallOutcomeMenu already hides "Talk to Ava" on video, so
        // the fix is purely to render it outside that layout branch. Last child of
        // the Stack → paints above the remote video surface and the control row;
        // `bottom` keeps it clear of the control row so hang-up stays tappable.
        // The scrim is only for video: the menu relied on the light zine paper
        // backdrop for contrast, which doesn't exist over a live video feed.
        // [ISSUE-VIDEO-TEXTNOTE-KEYBOARD-1] (2026-07-14) "Leave a text note"
        // opens a composer INSIDE the menu, and on video the keyboard could
        // cover it — the audio path has a deliberate keyboard-aware layout
        // ([NOTE-COMPOSER-LAYOUT 2026-07-12]) but this overlay had none.
        //
        // Do NOT subtract keyboardInset from `bottom` here. This Scaffold leaves
        // resizeToAvoidBottomInset at its default (true), so the body — and
        // therefore this whole Stack — is ALREADY shrunk to sit above the
        // keyboard. Subtracting the inset again would double-count it and float
        // the menu a full keyboard-height too high, stranding the composer
        // mid-screen. (Compare the audio path, which uses viewInsets to
        // RECONSTRUCT the resized body height for minHeight — not as an offset.)
        // The real fix is the bottom anchor: `reverse: true` pins a menu taller
        // than the shrunk region to its bottom edge, keeping the composer
        // visible; `bottom: 0` reclaims the control-row gap, since those buttons
        // are behind the keyboard while typing anyway.
        if (showVideo && s.showOutcomeMenu)
          Positioned(
            left: 0, right: 0, top: 0,
            // NB: both operands must be double — `112 + <num>` infers `num`,
            // which won't assign to Positioned.bottom (double?).
            bottom: keyboardInset > 0
                ? 0.0
                : 112.0 + (bottomInset > 0 ? bottomInset : 16.0),
            child: Container(
              color: AD.scrim,
              // Bottom-align while typing so the composer sits just above the
              // keyboard rather than floating under the header padding.
              child: SingleChildScrollView(
                reverse: keyboardInset > 0,
                padding: EdgeInsets.fromLTRB(
                    24,
                    keyboardInset > 0
                        ? 16
                        : MediaQuery.of(context).padding.top + 72,
                    24,
                    16),
                child: _outcomeMenu(),
              ),
            ),
          ),
      ],
    );
    // PopScope: intercept the system back gesture so it MINIMIZES the call
    // instead of tearing it down. canPop:false → onPopInvoked runs _minimize,
    // which pops the route itself while keeping the session alive.
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop || _popped) return;
        _minimize();
      },
      child: Scaffold(
        // [DIALER-UI-SPLIT 2026-07-12] dialer audio call → dark PhoneTheme surface.
        backgroundColor: dialerSkin ? PhoneTheme.bg : AD.bg,
        body: dialerSkin
            ? Container(color: PhoneTheme.bg, child: stack)
            : Container(color: AD.bg, child: stack),
      ),
    );
  }

  void _showDtmfPad(CallSession session) {
    const keys = <String>[
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '*',
      '0',
      '#'
    ];
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AD.card,
      shape: const RoundedRectangleBorder(borderRadius: Msg.brSheetTop),
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(Msg.s5),
          child: GridView.count(
            shrinkWrap: true,
            crossAxisCount: 3,
            mainAxisSpacing: 12,
            crossAxisSpacing: 12,
            children: keys
                .map((key) => TextButton(
                      onPressed: () {
                        unawaited(session.sendDtmf(key));
                      },
                      child:
                          Text(key, style: ADText.appTitle(c: AD.textPrimary)),
                    ))
                .toList(),
          ),
        ),
      ),
    );
  }

  // [CALL-OUTCOME-MENU-1] Unified call outcome menu — ONE surface for
  // declined / no-answer / unreachable / busy while callMenuEnabled
  // (Specs/CALL-OUTCOME-MENU-SPEC-2026-07-09.md). Renders instead of the busy
  // card / plain sticker; with the flag off it never constructs and the legacy
  // branches take over.
  // [ISSUE-VIDEO-OUTCOME-MENU-1] Extracted from the inline audio-column build so
  // the audio slot and the new video overlay share ONE definition of the args.
  Widget _outcomeMenu() {
    return CallOutcomeMenu(
      session: _session,
      name: widget.title,
      peerUid: widget.seed,
      onClosed: () {
        // Notes call menuDismiss internally; this is idempotent and also
        // covers an ordinary close/contact action.
        unawaited(_session.dismissOutcomeAndWait(reason: 'menu-closed'));
        _popIfMounted();
      },
      // [AVACALL-MENU-1] Call again — pop this screen and re-place the 1:1 call
      // (audio; a declined/busy call is retried as the same modality it started).
      onCallAgain: () async {
        Analytics.capture('call_menu_option_selected', {
          'call_id': widget.room,
          'option': 'call_again',
        });
        final nav = Navigator.of(context);
        final uidSeed = widget.seed,
            title = widget.title,
            avatar = widget.avatarUrl,
            vid = widget.video;
        await _session.dismissOutcomeAndWait(reason: 'menu-call-again');
        _popIfMounted();
        unawaited(place1to1Call(nav.context,
            uid: uidSeed,
            name: title,
            avatarUrl: avatar,
            video: vid,
            business: widget.business));
      },
      // [AVACALL-MENU-1] Message — pop and open the DM thread with the callee.
      onMessage: () {
        Analytics.capture('call_menu_option_selected', {
          'call_id': widget.room,
          'option': 'message',
        });
        final nav = Navigator.of(context);
        final chat = Chat(
          name: widget.title,
          seed: widget.seed,
          last: '',
          time: '',
          avatarUrl: widget.avatarUrl,
        );
        unawaited(_session.dismissOutcomeAndWait(reason: 'menu-message'));
        _popIfMounted();
        nav.push(
            MaterialPageRoute(builder: (_) => ChatThreadScreen(chat: chat)));
      },
      // [NOANSWER-LEAVE-NOTE-1] Save contact — parity with the phone-style
      // no-answer card; saves the callee without leaving the card (it stays open
      // so the caller can still leave a note or redial).
      onSaveContact: () async {
        try {
          await ContactsStore().add(Contact(
              uid: widget.seed,
              name: widget.title,
              avatarUrl: widget.avatarUrl));
        } catch (_) {/* best-effort */}
        if (mounted) {
          ScaffoldMessenger.of(context)
              .showSnackBar(const SnackBar(content: Text('Contact saved')));
        }
      },
      // [RECEPT-SETTINGS-1] The classic "Leave a voicemail" option was removed
      // with the voicemail feature. The outcome menu keeps Talk to Ava (the
      // receptionist), voice note, and text note.
    );
  }

  // [CALL-UI-GRID-2] `_showMoreSheet` lived here and is DELETED, along with its
  // `canFlipCamera` plumbing. It held Chat, Keypad and Flip; nothing was
  // stranded by its removal — Keypad is now a permanent grid tile, Flip is the
  // self-view tap, and Chat/minimize was already reachable three other ways
  // (header back button, the ⌄ button, the system back gesture via PopScope).
  //
  // `_controlRow` / `_btn` (the old bare 56px circles) went earlier with the
  // rows that used them — every control on this screen is a `_CallTile`.
}

/// [CALL-UI-GRID-2] The PEER's hold / mute state, rendered under the call
/// status line.
///
/// A call that goes silent with no explanation is a support ticket: the user
/// cannot tell "they put me on hold" from "they muted" from "the call broke",
/// and their only recourse is to hang up. `CallSession` now knows both facts
/// ([CallSession.peerHold], [CallSession.peerMuted]), so this says which.
///
/// Neither notifier bumps the session revision — they are set straight from the
/// peer's `hold` / `mute` data-channel frames — so this binds to them DIRECTLY.
/// A `setState`-driven parent would simply never rebuild for them.
///
/// Hold takes precedence over mute when both are set: holding already stops
/// their capture, so "on hold" is the fact that explains the silence, and
/// stacking two lines in the header would push the layout around.
class _PeerStateLine extends StatelessWidget {
  const _PeerStateLine({
    required this.session,
    required this.name,
    required this.onVideo,
  });

  final CallSession session;
  final String name;
  final bool onVideo;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<bool>(
      valueListenable: session.peerHold,
      builder: (context, held, _) => ValueListenableBuilder<bool>(
        valueListenable: session.peerMuted,
        builder: (context, peerMuted, __) {
          if (!held && !peerMuted) return const SizedBox.shrink();
          final peer = name.trim();
          final who = peer.isEmpty ? 'They' : peer;
          final text =
              held ? '$who put the call on hold' : '$who is muted';
          // Hold is the accent state — it is the one the user must read to
          // understand the silence. Mute is quieter, matching the status line.
          final tint = held
              ? AD.primaryBadge
              : (onVideo ? AD.textSecondary : AD.textTertiary);
          return Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                PhosphorIcon(
                  held
                      ? PhosphorIcons.pause(PhosphorIconsStyle.fill)
                      : PhosphorIcons.microphoneSlash(
                          PhosphorIconsStyle.fill),
                  size: 11,
                  color: tint,
                ),
                const SizedBox(width: 4),
                Flexible(
                  child: Text(
                    text,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ADText.sectionLabel(c: tint),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

/// [CALL-UI-GRID-2026-08-05] One cell of the call control panel: a 64px icon
/// circle with a text label under it.
///
/// This is the ONLY control primitive on the call screen — the control panel,
/// the More sheet and `CallTranslateOverlay` all render this exact geometry, so
/// a change here must be mirrored in the translate control (which builds its
/// own copy because it owns extra per-session state).
///
/// [active] lights the circle in the single accent (`AD.primaryBadge`) and
/// darkens the icon, the same engaged-toggle language used everywhere else in
/// the app. [bg] / [border] / [ink] override the palette outright, which only
/// the destructive End tile does.
class _CallTile extends StatelessWidget {
  const _CallTile({
    required this.icon,
    required this.label,
    required this.onTap,
    this.active = false,
    this.bg,
    this.border,
    this.ink,
  });

  final IconData icon;
  final String label;

  /// [CALL-UI-GRID-2] Nullable: a null [onTap] makes the tile genuinely inert
  /// (`ZinePressable.onTap` is already nullable), which is what the Hold tile
  /// needs before the call connects. Callers pair it with the same `Opacity`
  /// dimming `_CallRecordTile` uses so an inert tile also LOOKS inert.
  final VoidCallback? onTap;
  final bool active;
  final Color? bg;
  final Color? border;
  final Color? ink;

  @override
  Widget build(BuildContext context) {
    final fill = bg ?? (active ? AD.primaryBadge : AD.cardHover);
    final edge = border ?? (active ? AD.primaryBadge : AD.borderControl);
    final foreground = ink ?? (active ? AD.textOnInput : AD.textPrimary);
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        ZinePressable(
          onTap: onTap,
          color: fill,
          pressedColor: bg ?? AD.primaryBadge,
          radius: Msg.brPill,
          boxShadow: const [],
          borderWidth: 1,
          borderColor: edge,
          child: SizedBox(
            width: 64,
            height: 64,
            child: Center(
                child: PhosphorIcon(icon, size: 27, color: foreground)),
          ),
        ),
        const SizedBox(height: Msg.s1),
        Text(
          label,
          maxLines: 1,
          textAlign: TextAlign.center,
          overflow: TextOverflow.ellipsis,
          style: ADText.sectionLabel(c: AD.textSecondary),
        ),
      ],
    );
  }
}

/// [CALLREC-UI-1] The Record control — one cell of the call control panel.
///
/// Spec: `Specs/FEASIBILITY-CALL-RECORDING-2026-08-04.md` §5.2.
///
/// It builds its OWN copy of [_CallTile]'s geometry (64px circle, 27px icon,
/// label underneath) for the same reason `CallTranslateOverlay` does: it owns
/// per-session state and a live duration caption that `_CallTile` has no slot
/// for. The two are deliberate copies — if the call controls change, change this
/// with them or Record will visibly not belong in the row.
///
/// THINGS THAT ARE EASY TO GET WRONG HERE, all of them load-bearing:
///
/// * **A recording can end without anyone calling `stop`.** Native's degradation
///   ladder finalizes on its own, so this widget binds to
///   [CallRecordingStore.phase]/[CallRecordingStore.activeCallId] and never
///   holds a local `_isRecording` bool that could disagree with reality.
/// * **`start` fails by RETURNING FALSE, not throwing.** Every refusal is
///   surfaced with its real reason. A tap that silently does nothing would read
///   as "it's recording" — the worst possible outcome for a consent feature.
/// * **Audio only, always.** Nothing here reads the camera/video state, and
///   turning the camera on mid-call does not stop, pause or alter recording
///   (spec §3.4).
class _CallRecordTile extends StatefulWidget {
  const _CallRecordTile({
    required this.callId,
    required this.peerUid,
    required this.peerName,
    required this.peerAvatar,
    required this.direction,
    required this.callConnected,
  });

  final String callId;
  final String peerUid;
  final String peerName;
  final String peerAvatar;
  final String direction; // 'incoming' | 'outgoing'

  /// Arming before the call connects would record ringback and nothing else, so
  /// the tile renders dimmed and inert until then — the same treatment
  /// `CallTranslateOverlay._pendingTile()` uses, rather than an empty slot.
  final bool callConnected;

  @override
  State<_CallRecordTile> createState() => _CallRecordTileState();
}

class _CallRecordTileState extends State<_CallRecordTile> {
  /// Per-account (spec/rulebook §1): one phone is shared by a parent and each
  /// child, and one person's consent is not another's. [DiskCache] is already
  /// scoped to `AccountScope.id` internally; [scopedKey] on top of it makes the
  /// intent explicit at the call site and survives any future re-pointing of
  /// DiskCache at a shared directory.
  static String get _consentKey => scopedKey('callrec_consent_v1');

  /// Guards a double tap: `start`/`stop` are async and the store's own `_busy`
  /// returns false rather than queueing, which would otherwise look like a
  /// failed tap.
  bool _busy = false;

  Future<bool> _hasConsent() async {
    try {
      return (await DiskCache.read(_consentKey)) == '1';
    } catch (_) {
      return false; // a read failure must never SKIP the consent dialog
    }
  }

  /// The one-time first-tap dialog (spec §4.3). Covers what is captured, that
  /// the other party is shown a recording indicator, and that it counts toward
  /// the user's storage. Returns true only on an explicit accept.
  Future<bool> _askConsent() async {
    final peer = widget.peerName.trim();
    final theirs = peer.isEmpty ? 'the other person’s' : '$peer’s';
    // [CALLREC-TELEM-1] Consent is a THREE-outcome funnel — shown → accepted, or
    // shown → declined — and only the accept was ever recorded. Without `shown`
    // there is no denominator, so "how many people back out of recording once
    // they read what it does" was unanswerable; and a decline was
    // indistinguishable from the dialog never appearing, which is also how a
    // broken Record tile would look.
    unawaited(Analytics.capture('callrec_consent_shown', {
      'call_id': widget.callId,
      'rec_id': 'callrec:${widget.callId}',
      'direction': widget.direction,
      if (widget.peerUid.isNotEmpty) 'peer_uid': widget.peerUid,
    }));
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        backgroundColor: AD.overlaySheet,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AD.rDialog),
        ),
        title: Text('Record this call?', style: ADText.appTitle()),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'AvaTOK records the AUDIO of both sides of the call — yours and '
              '$theirs. Video is never captured, even if the camera is on.',
              style: ADText.preview(c: AD.textSecondary),
            ),
            const SizedBox(height: Msg.s3),
            // [CALLREC-PEER-1] This line used to be a flat promise, and it was
            // FALSE: nothing signalled the recording state to the peer, so only
            // the recorder ever saw a pill. The signalling now exists
            // (CallSession.peerRecording), but the promise is still not
            // unconditional — the peer's phone has to be running a build that
            // understands the frame — so the copy says "up-to-date" rather than
            // claiming something the code cannot guarantee for every device.
            Text(
              'AvaTOK tells the other person: on an up-to-date version of the '
              'app they see a “Recording” indicator on their call screen for as '
              'long as you are recording.',
              style: ADText.preview(c: AD.textSecondary),
            ),
            const SizedBox(height: Msg.s3),
            Text(
              'The recording is saved to your Inbox and counts toward your '
              'AvaStorage. It stays until you delete it.',
              style: ADText.preview(c: AD.textSecondary),
            ),
            const SizedBox(height: Msg.s3),
            Text(
              'Recording laws differ by country and state. You are responsible '
              'for recording lawfully.',
              style: ADText.timestamp(),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(d, false),
            child: Text('Not now',
                style: ADText.preview(c: AD.textSecondary)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(d, true),
            child: Text('Start recording',
                style: ADText.preview(c: AD.primaryBadge)),
          ),
        ],
      ),
    );
    if (ok != true) {
      unawaited(Analytics.capture('callrec_consent_declined', {
        'call_id': widget.callId,
        'rec_id': 'callrec:${widget.callId}',
        'direction': widget.direction,
        if (widget.peerUid.isNotEmpty) 'peer_uid': widget.peerUid,
        // A tap on "Not now" and a dismissed dialog are the same product
        // outcome but not the same UX signal.
        'dismissed': ok == null,
      }));
      return false;
    }
    var persisted = true;
    try {
      await DiskCache.write(_consentKey, '1');
    } catch (_) {
      // They'll simply be asked again next call — but a device that can never
      // persist the flag shows the dialog on EVERY call, which reads to the user
      // as a bug and would otherwise be invisible.
      persisted = false;
    }
    unawaited(Analytics.capture('callrec_consent_accepted', {
      'call_id': widget.callId,
      'rec_id': 'callrec:${widget.callId}',
      'direction': widget.direction,
      if (widget.peerUid.isNotEmpty) 'peer_uid': widget.peerUid,
      'persisted': persisted,
    }));
    return true;
  }

  Future<void> _onTap({required bool recording}) async {
    if (_busy) return;
    _busy = true;
    try {
      if (recording) {
        // [CALLREC-TELEM-1] The USER-INITIATED stop, which is a different fact
        // from `callrec_finalized` (that one also fires for the degradation
        // ladder and for orphan recovery). Timed with `uiInteraction` rather
        // than a bespoke `*_ms` event, per CLAUDE.md: finalize remuxes the whole
        // ADTS stream, so on a long recording this is a real, visible wait on
        // the call screen and is exactly what that helper exists to measure.
        final t0 = DateTime.now().millisecondsSinceEpoch;
        unawaited(Analytics.capture('callrec_stop_tapped', {
          'call_id': widget.callId,
          'rec_id': 'callrec:${widget.callId}',
          'direction': widget.direction,
          if (widget.peerUid.isNotEmpty) 'peer_uid': widget.peerUid,
        }));
        final saved = await CallRecordingStore.I.stop();
        unawaited(Analytics.uiInteraction(
          'callrec_finalize',
          DateTime.now().millisecondsSinceEpoch - t0,
          extra: {
            'call_id': widget.callId,
            'rec_id': 'callrec:${widget.callId}',
            'ok': saved != null,
            'duration_s': saved?.durationS ?? 0,
            'bytes': saved?.bytes ?? 0,
          },
        ));
        return;
      }
      unawaited(Analytics.capture('callrec_armed', {
        'call_id': widget.callId,
        'rec_id': 'callrec:${widget.callId}',
        'direction': widget.direction,
        if (widget.peerUid.isNotEmpty) 'peer_uid': widget.peerUid,
      }));
      if (!await _hasConsent()) {
        if (!mounted) return;
        if (!await _askConsent()) return;
      }
      if (!mounted) return;
      final ok = await CallRecordingStore.I.start(
        callId: widget.callId,
        peerUid: widget.peerUid,
        peerName: widget.peerName,
        peerAvatar: widget.peerAvatar,
        direction: widget.direction,
      );
      if (ok || !mounted) return;
      // Never let a refusal look like a start. `lastError` carries the real
      // reason the store/native gave.
      await _showFailure(CallRecordingStore.I.lastError.value ?? '');
    } finally {
      _busy = false;
    }
  }

  Future<void> _showFailure(String error) async {
    final String message;
    if (error == 'disabled') {
      message = 'Call recording is switched off right now. Your call is '
          'unaffected.';
    } else if (error == 'insufficient_storage') {
      message = 'There is not enough free space on this phone to record. Free '
          'some space and try again — your call is unaffected.';
    } else if (error == 'already_recording' || error == 'busy_other_call') {
      message = 'A recording is already running.';
    } else if (error.startsWith('near_adapter_unavailable') ||
        error.startsWith('subscribe_failed')) {
      // The microphone-side tap never bound. Recording anyway would capture the
      // OTHER person only — a one-sided recording is a correctness failure, not
      // a degraded success, so the store refuses and so does this copy.
      message = 'This phone could not capture both sides of the call, so '
          'nothing was recorded. Your call is unaffected.';
    } else {
      message = 'Recording could not start. Your call is unaffected.';
    }
    await showDialog<void>(
      context: context,
      builder: (d) => AlertDialog(
        backgroundColor: AD.overlaySheet,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AD.rDialog),
        ),
        title: Text('Recording unavailable', style: ADText.appTitle()),
        content: Text(message, style: ADText.preview(c: AD.textSecondary)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(d),
            child: Text('OK', style: ADText.preview(c: AD.primaryBadge)),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<CallRecordingPhase>(
      valueListenable: CallRecordingStore.I.phase,
      builder: (context, phase, _) => ValueListenableBuilder<String?>(
        valueListenable: CallRecordingStore.I.activeCallId,
        builder: (context, activeId, __) {
          // The recorder is process-wide, so "is it recording" is not enough —
          // it has to be recording THIS call before this tile turns red.
          final mine = activeId == widget.callId;
          final recording = mine && phase == CallRecordingPhase.recording;
          final finalizing = mine && phase == CallRecordingPhase.finalizing;
          final ready = widget.callConnected && !finalizing;

          return ValueListenableBuilder<CallRecordingProgress?>(
            valueListenable: CallRecordingStore.I.progress,
            builder: (context, progress, ___) {
              final elapsed = (recording && progress != null)
                  ? _hhmmss(progress.durationMs)
                  : '';
              final label = finalizing
                  ? 'Saving…'
                  : recording
                      ? (elapsed.isEmpty ? 'Recording' : elapsed)
                      : 'Record';
              final semantics = finalizing
                  ? 'Saving recording'
                  : recording
                      ? 'Stop recording'
                      : 'Record this call';
              final tile = Semantics(
                button: true,
                enabled: ready,
                label: semantics,
                child: Tooltip(
                  message: semantics,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      ZinePressable(
                        onTap: ready
                            ? () => unawaited(_onTap(recording: recording))
                            : null,
                        // RED while recording — the single unmistakable state
                        // this control has to communicate.
                        color: recording ? AD.destructiveBg : AD.cardHover,
                        pressedColor:
                            recording ? AD.destructiveBg : AD.primaryBadge,
                        radius: Msg.brPill,
                        boxShadow: const [],
                        borderWidth: 1,
                        borderColor: recording
                            ? AD.destructiveBg
                            : AD.borderControl,
                        child: SizedBox(
                          width: 64,
                          height: 64,
                          child: Center(
                            child: PhosphorIcon(
                              recording
                                  // `stop` and `circle` are both verified names
                                  // in phosphor_flutter 2.1.0 (grep the repo) —
                                  // there is no `record`, and an invented icon
                                  // name only fails in CI, ~5 minutes into a
                                  // release build.
                                  ? PhosphorIcons.stop(PhosphorIconsStyle.fill)
                                  : PhosphorIcons.circle(
                                      PhosphorIconsStyle.fill),
                              size: 27,
                              color: recording
                                  ? AD.destructiveInk
                                  : AD.destructiveBg,
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: Msg.s1),
                      Text(
                        label,
                        maxLines: 1,
                        textAlign: TextAlign.center,
                        overflow: TextOverflow.ellipsis,
                        style: ADText.sectionLabel(
                            c: recording ? AD.danger : AD.textSecondary),
                      ),
                    ],
                  ),
                ),
              );
              // Same dimming as the other not-yet-available call controls
              // rather than a new treatment.
              return ready ? tile : Opacity(opacity: 0.45, child: tile);
            },
          );
        },
      ),
    );
  }
}

/// [CALLREC-UI-1] The persistent "Recording" pill (spec §4.2).
///
/// Renders NOTHING unless a recording is actually running or finalizing, so it
/// costs no layout on an ordinary call. It paints its own fill and ink so the
/// one widget reads correctly on both the paper/dialer audio screen and the dark
/// video chrome.
///
/// [CALLREC-PEER-1] It now shows when EITHER side is recording, and says which.
/// Before this it bound only to [CallRecordingStore] — local state, with no peer
/// signalling anywhere in the app — so the only person who ever saw a "Recording"
/// pill was the person who had pressed Record, while the consent dialog told
/// them the other party could see one. Spec §4 makes this indicator one of the
/// two load-bearing consent surfaces, so that gap was the feature's last real
/// hole. [CallSession.peerRecording] is the other half of the wire.
class _RecordingIndicatorPill extends StatelessWidget {
  const _RecordingIndicatorPill({required this.session, required this.peerName});

  final CallSession session;

  /// Display name of the other party, for "<peer> is recording". May be empty.
  final String peerName;

  /// First name only — the pill is one line on a phone, and "Amy is recording"
  /// fits where "Amy Williams is recording" wraps or ellipsises away the verb.
  String get _peerFirst {
    final t = peerName.trim();
    if (t.isEmpty) return 'The other person';
    return t.split(RegExp(r'\s+')).first;
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<bool>(
      valueListenable: session.peerRecording,
      builder: (context, peerRec, _) => ValueListenableBuilder<CallRecordingPhase>(
        valueListenable: CallRecordingStore.I.phase,
        builder: (context, phase, __) => ValueListenableBuilder<String?>(
          valueListenable: CallRecordingStore.I.activeCallId,
          builder: (context, activeId, ___) {
            // The recorder is process-wide, so "recording" is not enough — it
            // has to be recording THIS call before we claim it in this pill.
            final mine = activeId == session.room;
            final recording = mine && phase == CallRecordingPhase.recording;
            final finalizing = mine && phase == CallRecordingPhase.finalizing;
            if (!recording && !finalizing && !peerRec) {
              return const SizedBox.shrink();
            }
            return ValueListenableBuilder<CallRecordingProgress?>(
              valueListenable: CallRecordingStore.I.progress,
              builder: (context, progress, ____) {
                final elapsed = (recording && progress != null)
                    ? _hhmmss(progress.durationMs)
                    : '';
                final String text;
                if (finalizing && !peerRec) {
                  text = 'Saving recording…';
                } else if (recording && peerRec) {
                  // Both sides. Say so plainly — "Recording" alone would let the
                  // user think only their own recorder was running.
                  text = 'You and $_peerFirst are recording';
                } else if (peerRec && !recording && !finalizing) {
                  text = '$_peerFirst is recording';
                } else if (peerRec) {
                  // We are finalizing, they are still going.
                  text = '$_peerFirst is recording';
                } else {
                  text = elapsed.isEmpty ? 'Recording' : 'Recording · $elapsed';
                }
                return Container(
                  padding: const EdgeInsets.symmetric(
                      horizontal: Msg.s3, vertical: Msg.s1),
                  decoration: BoxDecoration(
                    color: AD.destructiveBg,
                    // A genuine status pill — one of the shapes rPill is for.
                    borderRadius: Msg.brPill,
                    border: Border.all(color: AD.destructiveBg, width: 1),
                  ),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    PhosphorIcon(PhosphorIcons.circle(PhosphorIconsStyle.fill),
                        size: 10, color: AD.destructiveInk),
                    const SizedBox(width: Msg.s2),
                    Flexible(
                      child: Text(
                        text,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ADText.timestamp(c: AD.destructiveInk)
                            .copyWith(fontWeight: FontWeight.w700),
                      ),
                    ),
                  ]),
                );
              },
            );
          },
        ),
      ),
    );
  }
}

/// `m:ss`, or `h:mm:ss` once a recording passes an hour. Shared by the Record
/// tile and the indicator pill so the two can never disagree about how long the
/// same recording has been running.
String _hhmmss(int ms) {
  final total = ms <= 0 ? 0 : ms ~/ 1000;
  final h = total ~/ 3600;
  final m = (total % 3600) ~/ 60;
  final s = total % 60;
  final ss = s.toString().padLeft(2, '0');
  if (h > 0) return '$h:${m.toString().padLeft(2, '0')}:$ss';
  return '$m:$ss';
}

/// Header ⌄ control — shrinks the call to the floating PiP/pill. A small zine
/// circle that adapts its colours to the video (dark chrome) vs audio (paper)
/// screen so it stays legible on either background.
class _MinimizeButton extends StatelessWidget {
  const _MinimizeButton({required this.light, required this.onTap});
  final bool light; // true = audio/paper screen; false = video/dark chrome
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ZinePressable(
      onTap: onTap,
      color: light ? AD.card : Colors.white.withValues(alpha: 0.16),
      radius: Msg.brPill,
      boxShadow: const [],
      borderWidth: 1,
      borderColor: light ? AD.borderControl : Colors.transparent,
      child: SizedBox(
        width: 42,
        height: 42,
        child: Center(
          child: PhosphorIcon(
            PhosphorIcons.caretDown(PhosphorIconsStyle.bold),
            size: 20,
            color: light ? AD.textPrimary : Colors.white,
          ),
        ),
      ),
    );
  }
}

/// Receptionist "You ↔ Ava" view: your avatar and Ava's, side by side, with a
/// live audio link between them. The dots flow toward whoever is speaking and
/// brighten with their voice level; each avatar gets a soft pulsing ring while
/// that side talks. Driven by [mic] (caller VU) and [ava] (Ava VU).
class _ReceptionistDuo extends StatefulWidget {
  const _ReceptionistDuo({
    required this.mic,
    required this.ava,
    required this.me,
    required this.myLabel,
  });
  final ValueListenable<double> mic;
  final ValueListenable<double> ava;
  final Widget me;
  final String myLabel;

  @override
  State<_ReceptionistDuo> createState() => _ReceptionistDuoState();
}

class _ReceptionistDuoState extends State<_ReceptionistDuo>
    with SingleTickerProviderStateMixin {
  late final AnimationController _flow = AnimationController(
      vsync: this, duration: const Duration(milliseconds: 1100))
    ..repeat();

  @override
  void dispose() {
    _flow.dispose();
    super.dispose();
  }

  Widget _pulse(
      {required Widget child, required double level, required Color color}) {
    final g = level.clamp(0.0, 1.0);
    return SizedBox(
      width: 104,
      height: 104,
      child: Stack(
        alignment: Alignment.center,
        children: [
          Container(
            width: 84 + g * 20,
            height: 84 + g * 20,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: color.withValues(alpha: 0.14 * g),
              border: Border.all(
                  color: color.withValues(alpha: 0.55 * g), width: 3),
            ),
          ),
          child,
        ],
      ),
    );
  }

  Widget _avaCircle() => Container(
        width: 88,
        height: 88,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: AD.iconVideo,
          border: Border.all(color: AD.borderAvatar, width: 2),
          boxShadow: const [],
        ),
        clipBehavior: Clip.antiAlias,
        child: Image.asset(
          AvaId.avatarAsset,
          width: 88,
          height: 88,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => Center(
              child:
                  Text('A', style: ADText.appTitle().copyWith(fontSize: 40))),
        ),
      );

  Widget _label(String s) => SizedBox(
        width: 104,
        child: Text(s,
            textAlign: TextAlign.center,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: ADText.preview(c: AD.textSecondary)),
      );

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: Listenable.merge([widget.mic, widget.ava, _flow]),
      builder: (context, _) {
        final mic = widget.mic.value.clamp(0.0, 1.0);
        final ava = widget.ava.value.clamp(0.0, 1.0);
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                _pulse(child: widget.me, level: mic, color: AD.textPrimary),
                SizedBox(
                  width: 92,
                  height: 104,
                  child: CustomPaint(
                    painter:
                        _LinkPainter(phase: _flow.value, mic: mic, ava: ava),
                  ),
                ),
                _pulse(child: _avaCircle(), level: ava, color: AD.iconVideo),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                _label(widget.myLabel),
                const SizedBox(width: 92),
                _label('Ava'),
              ],
            ),
          ],
        );
      },
    );
  }
}

/// The animated audio link between the two avatars.
class _LinkPainter extends CustomPainter {
  _LinkPainter({required this.phase, required this.mic, required this.ava});
  final double phase; // 0..1 repeating flow phase
  final double mic; // caller VU 0..1
  final double ava; // Ava VU 0..1

  @override
  void paint(Canvas canvas, Size size) {
    final cy = size.height / 2;
    const n = 5;
    final active = mic >= ava; // caller louder → flow toward Ava (rightward)
    final level = (active ? mic : ava).clamp(0.0, 1.0);
    final speaking = level > 0.06;
    final dir = active ? 1.0 : -1.0;
    final color = active ? AD.textPrimary : AD.iconVideo;
    for (int i = 0; i < n; i++) {
      final t = (i + 0.5) / n; // 0..1 across the width
      final x = size.width * t;
      double b;
      double r;
      if (speaking) {
        final wave =
            (math.sin((t * dir - phase) * 2 * math.pi) + 1) / 2; // 0..1
        b = (0.22 + 0.78 * wave) * (0.4 + 0.6 * level);
        r = 2.5 + 3.0 * level * wave;
      } else {
        b = 0.16;
        r = 2.5;
      }
      final paint = Paint()..color = color.withValues(alpha: b.clamp(0.0, 1.0));
      canvas.drawCircle(Offset(x, cy), r, paint);
    }
  }

  @override
  bool shouldRepaint(_LinkPainter old) =>
      old.phase != phase || old.mic != mic || old.ava != ava;
}

/// [CALL-NETHUD-1] Compact, animated network-health strip shown on the live call
/// screen. Reads [CallSession.netStats] (published by the media watchdog every
/// ~5s — no extra poller) and [Connectivity] for the transport label. Renders a
/// 5-bar quality meter, live up/down kbps, cumulative MB used, and a subtle
/// "peer on weak network" badge when inbound stats degrade. Fades/slides in when
/// it first appears; tap → an expandable detail sheet (rtt, loss, transport).
/// Works for audio (paper) + video (dark chrome), light + dark variants.
class _CallNetHud extends StatefulWidget {
  const _CallNetHud({required this.session, required this.onVideo});
  final CallSession session;
  final bool onVideo; // true = over dark video chrome; false = paper screen

  @override
  State<_CallNetHud> createState() => _CallNetHudState();
}

class _CallNetHudState extends State<_CallNetHud>
    with SingleTickerProviderStateMixin {
  late final AnimationController _appear;
  StreamSubscription<List<ConnectivityResult>>? _connSub;
  String _transport = 'Network';

  @override
  void initState() {
    super.initState();
    _appear = AnimationController(
        vsync: this, duration: Msg.slow)
      ..forward();
    _resolveTransport();
    _connSub =
        Connectivity().onConnectivityChanged.listen((r) => _applyTransport(r));
  }

  Future<void> _resolveTransport() async {
    try {
      final r = await Connectivity().checkConnectivity();
      _applyTransport(r);
    } catch (_) {/* keep default label */}
  }

  void _applyTransport(List<ConnectivityResult> r) {
    String label;
    if (r.contains(ConnectivityResult.wifi)) {
      label = 'Wi-Fi';
    } else if (r.contains(ConnectivityResult.ethernet)) {
      label = 'Ethernet';
    } else if (r.contains(ConnectivityResult.mobile)) {
      // Carrier name + SIM slot aren't cheaply available without a platform
      // channel/telephony permission; show the generic label per spec.
      label = 'Mobile data';
    } else if (r.contains(ConnectivityResult.vpn)) {
      label = 'VPN';
    } else {
      label = 'Network';
    }
    if (mounted && label != _transport) setState(() => _transport = label);
  }

  @override
  void dispose() {
    _connSub?.cancel();
    _appear.dispose();
    super.dispose();
  }

  Color get _fg => widget.onVideo ? Colors.white : AD.textPrimary;
  Color get _bg =>
      widget.onVideo ? Colors.black.withValues(alpha: 0.38) : AD.card;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<CallNetStats>(
      valueListenable: widget.session.netStats,
      builder: (context, ns, _) {
        // Slide down + fade the whole strip on first appearance.
        return FadeTransition(
          opacity: CurvedAnimation(parent: _appear, curve: Msg.curve),
          child: SlideTransition(
            position: Tween<Offset>(
              begin: const Offset(0, -0.35),
              end: Offset.zero,
            ).animate(
                CurvedAnimation(parent: _appear, curve: Curves.easeOutCubic)),
            child: _strip(ns),
          ),
        );
      },
    );
  }

  bool _peerWeak(CallNetStats ns) =>
      (ns.lossPct >= 0 && ns.lossPct > 8) ||
      (ns.downKbps > 0 && ns.downKbps < 12);

  Widget _strip(CallNetStats ns) {
    final weak = _peerWeak(ns);
    final mos = ns.estMos;
    final poor = mos != null && mos < 3.0;
    final indicatorOn = RemoteConfig.callQualityIndicatorV1;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => _openDetail(ns),
      child: AnimatedContainer(
        duration: Msg.slow,
        curve: Msg.curve,
        padding: const EdgeInsets.fromLTRB(Msg.s3, Msg.s2, Msg.s3, Msg.s2),
        decoration: BoxDecoration(
          color: _bg,
          borderRadius: Msg.brPill,
          border: widget.onVideo
              ? null
              : Border.all(color: AD.borderControl, width: 1),
          boxShadow: const [],
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (indicatorOn && mos != null) ...[
              Container(
                width: 9,
                height: 9,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: poor
                      ? AD.danger
                      : mos < 3.5
                          ? Colors.amber
                          : Colors.greenAccent,
                ),
              ),
              const SizedBox(width: Msg.s1),
            ],
            PhosphorIcon(
                _transport == 'Wi-Fi'
                    ? PhosphorIcons.wifiHigh(PhosphorIconsStyle.bold)
                    : PhosphorIcons.broadcast(PhosphorIconsStyle.bold),
                size: 15,
                color: _fg),
            const SizedBox(width: Msg.s1),
            Text(_transport, style: ADText.timestamp(c: _fg)),
            const SizedBox(width: Msg.s2),
            _QualityBars(quality: ns.quality, color: _fg),
            const SizedBox(width: Msg.s2),
            _rateChip(PhosphorIcons.arrowDownLeft(PhosphorIconsStyle.bold),
                ns.downKbps),
            const SizedBox(width: Msg.s1),
            _rateChip(
                PhosphorIcons.arrowUpRight(PhosphorIconsStyle.bold), ns.upKbps),
            const SizedBox(width: Msg.s2),
            Text('${ns.dataMb.toStringAsFixed(ns.dataMb < 10 ? 1 : 0)} MB',
                style: ADText.timestamp(c: _fg)),
            if (weak) ...[
              const SizedBox(width: 8),
              AnimatedOpacity(
                duration: Msg.slow,
                opacity: weak ? 1 : 0,
                child: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: Msg.s2, vertical: 2),
                  decoration: BoxDecoration(
                    color: AD.danger,
                    borderRadius: Msg.brPill,
                  ),
                  child:
                  Text('Weak', style: ADText.statCaption(c: Colors.white)),
                ),
              ),
            ],
            if (indicatorOn && poor) ...[
              const SizedBox(width: 8),
              Text('Poor network — try WiFi', style: ADText.statCaption(c: AD.danger)),
            ],
          ],
        ),
      ),
    );
  }

  Widget _rateChip(IconData icon, int kbps) {
    return Row(mainAxisSize: MainAxisSize.min, children: [
      PhosphorIcon(icon, size: 12, color: _fg),
      const SizedBox(width: 2),
      Text('$kbps', style: ADText.timestamp(c: _fg)),
    ]);
  }

  void _openDetail(CallNetStats ns) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet)),
      ),
      builder: (_) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s4, Msg.s5, Msg.s5),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Connection', style: ADText.appTitle()),
              const SizedBox(height: 4),
              Text(_transport, style: ADText.statCaption(c: AD.textTertiary)),
              const SizedBox(height: 16),
              _detailRow('Signal', _qualityLabel(ns.quality)),
              _detailRow('Round-trip', ns.rttMs >= 0 ? '${ns.rttMs} ms' : '—'),
              _detailRow('Packet loss',
                  ns.lossPct >= 0 ? '${ns.lossPct.toStringAsFixed(1)}%' : '—'),
              _detailRow('Download', '${ns.downKbps} kbps'),
              _detailRow('Upload', '${ns.upKbps} kbps'),
              _detailRow('Data used', '${ns.dataMb.toStringAsFixed(2)} MB'),
              if (_peerWeak(ns)) ...[
                const SizedBox(height: 12),
                Row(children: [
                  PhosphorIcon(PhosphorIcons.warning(PhosphorIconsStyle.bold),
                      size: 16, color: AD.danger),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text('The other side is on a weak network.',
                        style: ADText.preview(c: AD.danger)),
                  ),
                ]),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _detailRow(String k, String v) => Padding(
        padding: const EdgeInsets.symmetric(vertical: Msg.s2),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(k, style: ADText.preview(c: AD.textSecondary)),
            Text(v, style: ADText.rowName()),
          ],
        ),
      );

  static String _qualityLabel(int q) => switch (q) {
        0 => 'Very poor',
        1 => 'Poor',
        2 => 'Fair',
        3 => 'Good',
        _ => 'Excellent',
      };
}

/// [CALL-NETHUD-1] 5-bar quality meter. Bars up to [quality] fill (green→amber→
/// coral by level); the rest are faint. Bar heights ramp so it reads as a signal
/// meter. Fills animate via AnimatedContainer for smooth transitions.
class _QualityBars extends StatelessWidget {
  const _QualityBars({required this.quality, required this.color});
  final int quality; // 0..4
  final Color color; // foreground (for the empty-bar tint)

  Color get _fillColor {
    if (quality <= 1) return AD.danger;
    if (quality == 2) return const Color(0xFFF5B942); // amber
    return AD.online;
  }

  @override
  Widget build(BuildContext context) {
    const n = 5;
    return Row(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: List.generate(n, (i) {
        final on = i <= quality;
        final h = 5.0 + i * 2.4; // ramp
        return Padding(
          padding: EdgeInsets.only(right: i == n - 1 ? 0 : 2),
          child: AnimatedContainer(
            duration: Msg.slow,
            curve: Msg.curve,
            width: 3.2,
            height: h,
            decoration: BoxDecoration(
              color: on ? _fillColor : color.withValues(alpha: 0.22),
              borderRadius: BorderRadius.circular(2),
            ),
          ),
        );
      }),
    );
  }
}

/// [DIALPAD-BIZ-CALLS Phase C] Live Ava AI agent panel — shown in CallScreen's
/// status slot while the caller is bridged to the callee's Grok voice agent
/// (core/agent_voice_call.dart). Presentation only; the screen owns the bridge.
class _AgentCallPanel extends StatelessWidget {
  final String name;
  final String status; // 'connecting' | 'connected' | 'failed' | 'ended' | ''
  final VoidCallback onHangup;
  const _AgentCallPanel(
      {required this.name, required this.status, required this.onHangup});

  String get _line => switch (status) {
        'connected' => "You're talking to $name's Ava AI agent",
        'failed' => "Couldn't reach $name's Ava AI agent",
        'ended' => 'Agent call ended',
        _ => "Connecting you to $name's Ava AI agent…",
      };

  @override
  Widget build(BuildContext context) {
    return Column(mainAxisSize: MainAxisSize.min, children: [
      AdSticker(_line,
          kind: status == 'failed' ? AdStickerKind.no : AdStickerKind.plain),
      const SizedBox(height: Msg.s1),
      Text('AI assistant · this call is transcribed',
          style: ADText.preview(), textAlign: TextAlign.center),
      if (status == 'connecting' || status == 'connected') ...[
        const SizedBox(height: Msg.s4),
        AdButton(
          label: 'End agent call',
          icon: PhosphorIcons.phoneX(PhosphorIconsStyle.bold),
          onPressed: onHangup,
        ),
      ],
    ]);
  }
}

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
import '../../core/call_routing_api.dart';
import '../../core/calls/call_overlay.dart';
import '../../core/calls/call_session.dart';
import '../../core/calls/call_session_manager.dart';
import '../../core/remote_config.dart';
import '../../core/ringback_player.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/ui/avatok_dark.dart';
import '../avaphone/phone_theme.dart';
import 'busy_card.dart';
import 'call_outcome_menu.dart';
import 'chat_thread.dart'; // [AVACALL-MENU-1] Message → open DM thread
import 'contacts.dart';
import 'data.dart' show Chat; // [AVACALL-MENU-1] Chat model for the DM thread
import 'no_answer_card.dart';
import 'paid_busy_card.dart';
import 'paid_call_prompt.dart' show CallCountdown;
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
  if (gLiveCallScreensSince == 0) return false; // shouldn't happen, but never heal blind
  final ageMs = DateTime.now().millisecondsSinceEpoch - gLiveCallScreensSince;
  if (ageMs <= kMaxCallLifeMs) return false;
  if (CallSessionManager.instance.current != null) return false; // genuinely live — leave it alone
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
String? gOutgoingCallTo;     // the peer we are dialing (config.seed), null when idle/connected
String? gOutgoingCallId;     // the call_id (room) of that outgoing dial
int gOutgoingSince = 0;      // epoch-ms the dial was placed (staleness guard)
const int kMaxDialLifeMs = 60 * 1000; // an unanswered dial can't ring longer than this

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
  try { await CallSessionManager.instance.destroyAll(); } catch (_) {}
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
  try { await FlutterCallkitIncoming.endAllCalls(); } catch (_) {/* none active */}
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
  // [WP6 §3B] Minutes the caller pre-paid via the price sheet ('' hold →
  // confirm on connect). >0 arms the in-call countdown + end-of-time beeps
  // (CallCountdown) once the call connects. 0 = not a paid call.
  final int paidMinutes;
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
    this.paidMinutes = 0,
    this.deferRing = false,
  });
  @override
  State<CallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends State<CallScreen> {
  late final CallSession _session;
  bool _popped = false;

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
  String _agentStatus = ''; // '' | 'connecting' | 'connected' | 'ended' | 'failed'
  bool _agentStarted = false;
  Timer? _agentAutoProbe;
  // Post-ring busy (plan §15.1): /api/call/no-answer said 'busy' after a
  // genuine ring timeout — render the PaidBusyCard instead of the no-answer card.
  Map<String, dynamic>? _postRingBusy;
  // [WP6 §3B] Paid-call countdown + end-of-time beeps, armed on connect.
  CallCountdown? _countdown;
  bool _countdownStarted = false;
  Timer? _paidEndTimer;

  bool get _agentActive => _agentCall != null || _session.uiPhase.value == 'agent-handoff';

  void _maybeFetchNoAnswerRouting() {
    if (_routingFetched || !RemoteConfig.businessCallUx || !widget.outgoing) return;
    if (widget.initialRouted == 'voicemail' || widget.initialRouted == 'agent') {
      // Pre-seeded by place_1to1_call.dart from the initial /api/call response
      // (ring was skipped server-side) — no need for a second round trip.
      _routingFetched = true;
      _routingInfo = {
        'next': widget.initialRouted,
        'voicemail_available': widget.initialRouted == 'voicemail',
        if (widget.initialRoutingStart != null) 'start': widget.initialRoutingStart,
      };
      return;
    }
    if (_session.uiPhase.value != 'no-answer') return;
    _routingFetched = true;
    CallRoutingApi.noAnswer(callee: widget.seed, callId: widget.room, traceId: widget.traceId).then((r) {
      if (!mounted || r == null) return;
      setState(() => _routingInfo = r);
      // Phase C: the server routed this no-answer to the agent — connect
      // automatically (expectation: the caller HEARS the agent, not a card).
      if (r['next'] == 'agent' && RemoteConfig.voiceAgent) {
        // ignore: unawaited_futures
        _startAgentBridge(r['start'] is Map ? (r['start'] as Map).cast<String, dynamic>() : null);
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
      if (!mounted || _agentStarted || _session.isConnected || _session.isEnded) return;
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
    final start = _routingInfo?['next'] == 'agent' && _routingInfo?['start'] is Map
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
      callee: widget.seed, callId: widget.room, traceId: widget.traceId,
      outcome: outcome,
    ).then((r) {
      if (!mounted) return;
      if (r != null && r['next'] == 'agent') {
        _agentStarted = false; // hand back to the bridge starter
        // ignore: unawaited_futures
        _startAgentBridge(r['start'] is Map ? (r['start'] as Map).cast<String, dynamic>() : null);
      } else if (r != null && r['next'] == 'busy') {
        _showPostRingBusy(r);
      } else if (r != null && r['next'] == 'voicemail') {
        // Agent slot gone between the tap and the probe (Mode A overflow) —
        // fall back to the voicemail card flow.
        setState(() { _routingInfo = r; _routingFetched = true; _agentStatus = 'failed'; });
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

  // ── [WP6 §3B] paid-call countdown ─────────────────────────────────────────

  void _maybeStartPaidCountdown() {
    if (_countdownStarted || widget.paidMinutes <= 0 || !_session.isConnected) return;
    _countdownStarted = true;
    _countdown = CallCountdown()..start(widget.paidMinutes);
    // Local end-of-time stop — both sides agreed the duration up front (§3B);
    // the server's CallRoom ticker is the billing authority either way.
    _paidEndTimer = Timer(Duration(minutes: widget.paidMinutes), () {
      if (mounted && _session.isConnected) _session.endByUser();
    });
  }

  String? get _paidRemainingLabel {
    if (!_countdownStarted || !_session.isConnected) return null;
    final left = widget.paidMinutes * 60 - _session.elapsedSeconds.value;
    if (left <= 0) return 'Paid time is up';
    final m = left ~/ 60, s = left % 60;
    return 'Paid call · $m:${s.toString().padLeft(2, '0')} left';
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
    if (widget.initialRouted == 'agent' && RemoteConfig.voiceAgent) {
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
    _maybeStartPaidCountdown(); // [WP6 §3B]
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
    if (identical(_session.onRequestPop, _popIfMounted)) _session.onRequestPop = null;
    _session.setNoticeHooks();
    // [DIALPAD-BIZ-CALLS Phase C] Tear down an orphaned agent bridge — the
    // AgentVoiceRoom DO finalizes (settle/refund/summary card) on WS close.
    if (_agentCall != null) unawaited(_agentCall!.hangup());
    _agentAutoProbe?.cancel();
    // [WP6 §3B]
    _paidEndTimer?.cancel();
    _countdown?.dispose();
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

  /// Back gesture / header ⌄ button: MINIMIZE, not hang up. Keeps the call alive
  /// (the session owns the WS/PC/renderers/FGS) and shows the floating video
  /// thumbnail / audio pill via [CallOverlay]. If the call has already ended
  /// (e.g. a busy/declined sticker is showing), fall through to a plain pop.
  void _minimize() {
    if (_popped) return;
    if (_session.isEnded || _session.phase.value == CallPhase.ended) {
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
    final failed = phase == 'declined' || phase == 'busy' || phase == 'no-answer' ||
        phase == 'network-error';
    final bottomInset = MediaQuery.of(context).padding.bottom;
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
                ? RTCVideoView(s.remoteRenderer, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover)
                : Container(color: AD.bg),
          ),
          Positioned(top: 0, left: 0, right: 0, height: 128,
              child: Container(color: Colors.black.withValues(alpha: 0.45))),
          Positioned(
            top: 56, right: 16, width: 78, height: 112,
            child: Container(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(AD.rListCard),
                border: Border.all(color: AD.borderControl, width: 1),
                boxShadow: const [],
              ),
              clipBehavior: Clip.antiAlias,
              child: RTCVideoView(s.localRenderer, mirror: true,
                  objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover),
            ),
          ),
        ],

        // header: zine back circle + (video chrome) name + mono state/timer
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
            child: Row(
              children: [
                // Back = MINIMIZE (keeps the call alive as a PiP/pill), not hang up.
                AdBackButton(onTap: _minimize),
                const SizedBox(width: 12),
                if (showVideo)
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(widget.title,
                          maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: ADText.threadName(c: Colors.white)),
                      const SizedBox(height: 2),
                      Text((connected ? s.clock : s.statusText).toUpperCase(),
                          maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: ADText.sectionLabel(c: Colors.white)),
                    ]),
                  )
                else
                  const Spacer(),
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
              padding: EdgeInsets.fromLTRB(
                  24, 0, 24, 112 + (bottomInset > 0 ? bottomInset : 16)),
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  minHeight: MediaQuery.of(context).size.height -
                      MediaQuery.of(context).viewInsets.bottom -
                      (112 + (bottomInset > 0 ? bottomInset : 16)),
                ),
                child: Center(
                  child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (s.isReceptDuo && s.receptionist != null) ...[
                    _ReceptionistDuo(
                      mic: s.receptionist!.micLevel,
                      ava: s.receptionist!.avaLevel,
                      me: Avatar(seed: s.mySeed, name: s.myName, size: 88,
                          avatarUrl: s.myAvatar.isEmpty ? null : s.myAvatar),
                      myLabel: s.myName,
                    ),
                    const SizedBox(height: 22),
                    Text('Ava', textAlign: TextAlign.center,
                        style: ADText.appTitle().copyWith(fontSize: 28)),
                  ] else ...[
                    Container(
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: phase == 'ava-countdown' ? AD.iconVideo : null,
                        border: Border.all(color: AD.borderAvatar, width: 2),
                        boxShadow: const [],
                      ),
                      child: phase == 'ava-countdown'
                          ? SizedBox(
                              width: 132, height: 132,
                              child: Center(child: Text('${s.avaCount}',
                                  style: ADText.appTitle().copyWith(fontSize: 76))),
                            )
                          : Avatar(seed: widget.seed, name: widget.title, size: 132,
                              avatarUrl: widget.avatarUrl.isEmpty ? null : widget.avatarUrl),
                    ),
                    const SizedBox(height: 24),
                    Text(widget.title, textAlign: TextAlign.center,
                        style: ADText.appTitle(c: dialerSkin ? PhoneTheme.text : AD.textPrimary)
                            .copyWith(fontSize: 28)),
                  ],
                  const SizedBox(height: 16),
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
                  else if (_agentActive || _agentStatus == 'connecting' || _agentStatus == 'connected')
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
                      onTryAgain: () {
                        final nav = Navigator.of(context);
                        final uidSeed = widget.seed, title = widget.title,
                            avatar = widget.avatarUrl, vid = widget.video;
                        _popIfMounted();
                        place1to1Call(nav.context, uid: uidSeed, name: title, avatarUrl: avatar, video: vid);
                      },
                      onClose: _popIfMounted,
                    )
                  // [DIALPAD-BIZ-CALLS] Phone-style "no answer" card for the
                  // CALLER on an outgoing business (dialpad) call — replaces
                  // dropping straight into the messenger thread. Only the
                  // legacy plain sticker below is shown while the flag is off
                  // (existing behaviour preserved byte-for-byte).
                  else if (RemoteConfig.businessCallUx && widget.outgoing && phase == 'no-answer')
                    NoAnswerCard(
                      name: widget.title,
                      seed: widget.seed,
                      avatarUrl: widget.avatarUrl,
                      // [RECEPT-SETTINGS-1] voicemail removed — the card now
                      // offers Call again / Save contact / Close only.
                      onCallAgain: () {
                        final nav = Navigator.of(context);
                        final uidSeed = widget.seed, title = widget.title,
                            avatar = widget.avatarUrl, vid = widget.video;
                        _popIfMounted();
                        // nav.context stays mounted after this route pops (it's
                        // the ancestor Navigator), so it's safe to push from here.
                        place1to1Call(nav.context, uid: uidSeed, name: title, avatarUrl: avatar, video: vid);
                      },
                      onSaveContact: () async {
                        try {
                          await ContactsStore().add(Contact(
                              uid: widget.seed, name: widget.title,
                              avatarUrl: widget.avatarUrl));
                        } catch (_) {/* best-effort */}
                        if (mounted) {
                          ScaffoldMessenger.of(context)
                              .showSnackBar(const SnackBar(content: Text('Contact saved')));
                        }
                      },
                      onClose: _popIfMounted,
                    )
                  else ...[
                    AdSticker(
                      connected ? s.clock : s.statusText,
                      kind: failed ? AdStickerKind.no : AdStickerKind.plain,
                    ),
                    // [WP6 §3B] Live paid-call countdown under the clock —
                    // CallCountdown handles the T-60s/T-10s warning beeps.
                    if (_paidRemainingLabel != null) ...[
                      const SizedBox(height: 8),
                      Text(_paidRemainingLabel!,
                          style: ADText.preview(),
                          textAlign: TextAlign.center),
                    ],
                  ],
                  // [CALL-DIAL-FAIL-1] Retry affordance — only on the
                  // network-error terminal state, only when the launch site
                  // gave us a redial hook.
                  if (phase == 'network-error' && widget.onRetry != null) ...[
                    const SizedBox(height: 20),
                    AdButton(
                      label: 'Retry',
                      icon: PhosphorIcons.arrowClockwise(PhosphorIconsStyle.bold),
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
            left: 0, right: 0,
            child: Center(
              child: _CallNetHud(session: s, onVideo: showVideo),
            ),
          ),

        // control row — bordered zine circles; hang-up = coral circle.
        Positioned(
          left: 0, right: 0, bottom: 0,
          child: Container(
            color: light ? null : Colors.black.withValues(alpha: 0.45),
            padding: EdgeInsets.fromLTRB(16, 16, 16, 20 + (bottomInset > 0 ? bottomInset : 16)),
            child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              // Chat: minimize the call (keeps it alive as a pill/PiP) so the
              // user lands back on the thread and can read/send messages.
              _btn(PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), onTap: _minimize),
              const SizedBox(width: 14),
              _btn(
                  speaker
                      ? PhosphorIcons.speakerHigh(PhosphorIconsStyle.bold)
                      : PhosphorIcons.speakerSlash(PhosphorIconsStyle.bold),
                  active: speaker, onTap: s.toggleSpeaker),
              const SizedBox(width: 14),
              ZinePressable(
                onTap: _hangup,
                color: AD.destructiveBg,
                radius: BorderRadius.circular(100),
                boxShadow: const [],
                borderWidth: 1,
                borderColor: AD.destructiveBg,
                child: SizedBox(
                  width: 60, height: 60,
                  child: Center(
                    child: PhosphorIcon(
                        PhosphorIcons.phoneDisconnect(PhosphorIconsStyle.bold),
                        size: 27, color: Colors.white),
                  ),
                ),
              ),
              const SizedBox(width: 14),
              _btn(
                  video && camOn
                      ? PhosphorIcons.videoCamera(PhosphorIconsStyle.bold)
                      : PhosphorIcons.videoCameraSlash(PhosphorIconsStyle.bold),
                  active: video && camOn, onTap: s.toggleCamera),
              // [CF-CALL-P2P-1] Front/back camera flip — only meaningful (and
              // only shown) while a live camera feed is actually being sent.
              if (video && camOn) ...[
                const SizedBox(width: 14),
                _btn(PhosphorIcons.cameraRotate(PhosphorIconsStyle.bold),
                    onTap: s.flipCamera),
              ],
              const SizedBox(width: 14),
              _btn(
                  muted
                      ? PhosphorIcons.microphoneSlash(PhosphorIconsStyle.bold)
                      : PhosphorIcons.microphone(PhosphorIconsStyle.bold),
                  active: !muted, onTap: s.toggleMute),
            ]),
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
      onClosed: _popIfMounted,
      // [AVACALL-MENU-1] Call again — pop this screen and re-place the 1:1 call
      // (audio; a declined/busy call is retried as the same modality it started).
      onCallAgain: () {
        Analytics.capture('call_menu_option_selected', {
          'call_id': widget.room, 'option': 'call_again',
        });
        final nav = Navigator.of(context);
        final uidSeed = widget.seed, title = widget.title,
            avatar = widget.avatarUrl, vid = widget.video;
        _popIfMounted();
        place1to1Call(nav.context, uid: uidSeed, name: title, avatarUrl: avatar, video: vid);
      },
      // [AVACALL-MENU-1] Message — pop and open the DM thread with the callee.
      onMessage: () {
        Analytics.capture('call_menu_option_selected', {
          'call_id': widget.room, 'option': 'message',
        });
        final nav = Navigator.of(context);
        final chat = Chat(
          name: widget.title,
          seed: widget.seed,
          last: '',
          time: '',
          avatarUrl: widget.avatarUrl,
        );
        _popIfMounted();
        nav.push(MaterialPageRoute(builder: (_) => ChatThreadScreen(chat: chat)));
      },
      // [NOANSWER-LEAVE-NOTE-1] Save contact — parity with the phone-style
      // no-answer card; saves the callee without leaving the card (it stays open
      // so the caller can still leave a note or redial).
      onSaveContact: () async {
        try {
          await ContactsStore().add(Contact(
              uid: widget.seed, name: widget.title, avatarUrl: widget.avatarUrl));
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

  // Dark v2 control circle — card fill, hairline border; active = orange badge.
  Widget _btn(IconData icon, {bool active = false, required VoidCallback onTap}) {
    return ZinePressable(
      onTap: onTap,
      color: active ? AD.primaryBadge : AD.card,
      pressedColor: AD.primaryBadge,
      radius: BorderRadius.circular(100),
      boxShadow: const [],
      borderWidth: 1,
      borderColor: active ? AD.primaryBadge : AD.borderControl,
      child: SizedBox(
        width: 48, height: 48,
        child: Center(child: PhosphorIcon(icon, size: 21,
            color: active ? AD.textOnInput : AD.textPrimary)),
      ),
    );
  }
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
      radius: BorderRadius.circular(100),
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

  Widget _pulse({required Widget child, required double level, required Color color}) {
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
              border: Border.all(color: color.withValues(alpha: 0.55 * g), width: 3),
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
          errorBuilder: (_, __, ___) =>
              Center(child: Text('A', style: ADText.appTitle().copyWith(fontSize: 40))),
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
                    painter: _LinkPainter(phase: _flow.value, mic: mic, ava: ava),
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
  final double mic;   // caller VU 0..1
  final double ava;   // Ava VU 0..1

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
        final wave = (math.sin((t * dir - phase) * 2 * math.pi) + 1) / 2; // 0..1
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
        vsync: this, duration: const Duration(milliseconds: 420))
      ..forward();
    _resolveTransport();
    _connSub = Connectivity()
        .onConnectivityChanged
        .listen((r) => _applyTransport(r));
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
  Color get _bg => widget.onVideo
      ? Colors.black.withValues(alpha: 0.38)
      : AD.card;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<CallNetStats>(
      valueListenable: widget.session.netStats,
      builder: (context, ns, _) {
        // Slide down + fade the whole strip on first appearance.
        return FadeTransition(
          opacity: CurvedAnimation(parent: _appear, curve: Curves.easeOut),
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
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => _openDetail(ns),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeOut,
        padding: const EdgeInsets.fromLTRB(12, 7, 12, 7),
        decoration: BoxDecoration(
          color: _bg,
          borderRadius: BorderRadius.circular(100),
          border: widget.onVideo ? null : Border.all(color: AD.borderControl, width: 1),
          boxShadow: const [],
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            PhosphorIcon(
                _transport == 'Wi-Fi'
                    ? PhosphorIcons.wifiHigh(PhosphorIconsStyle.bold)
                    : PhosphorIcons.broadcast(PhosphorIconsStyle.bold),
                size: 15, color: _fg),
            const SizedBox(width: 6),
            Text(_transport,
                style: ADText.timestamp(c: _fg)),
            const SizedBox(width: 10),
            _QualityBars(quality: ns.quality, color: _fg),
            const SizedBox(width: 10),
            _rateChip(
                PhosphorIcons.arrowDownLeft(PhosphorIconsStyle.bold), ns.downKbps),
            const SizedBox(width: 6),
            _rateChip(
                PhosphorIcons.arrowUpRight(PhosphorIconsStyle.bold), ns.upKbps),
            const SizedBox(width: 10),
            Text('${ns.dataMb.toStringAsFixed(ns.dataMb < 10 ? 1 : 0)} MB',
                style: ADText.timestamp(c: _fg)),
            if (weak) ...[
              const SizedBox(width: 8),
              AnimatedOpacity(
                duration: const Duration(milliseconds: 300),
                opacity: weak ? 1 : 0,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                  decoration: BoxDecoration(
                    color: AD.danger,
                    borderRadius: BorderRadius.circular(100),
                  ),
                  child: Text('WEAK',
                      style: ADText.statCaption(c: Colors.white)),
                ),
              ),
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
      Text('$kbps',
          style: ADText.timestamp(c: _fg)),
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
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Connection', style: ADText.appTitle()),
              const SizedBox(height: 4),
              Text(_transport, style: ADText.statCaption(c: AD.textTertiary)),
              const SizedBox(height: 16),
              _detailRow('Signal', _qualityLabel(ns.quality)),
              _detailRow('Round-trip',
                  ns.rttMs >= 0 ? '${ns.rttMs} ms' : '—'),
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
        padding: const EdgeInsets.symmetric(vertical: 5),
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
            duration: const Duration(milliseconds: 320),
            curve: Curves.easeOut,
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
  const _AgentCallPanel({required this.name, required this.status, required this.onHangup});

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
      const SizedBox(height: 6),
      Text('AI assistant · this call is transcribed',
          style: ADText.preview(), textAlign: TextAlign.center),
      if (status == 'connecting' || status == 'connected') ...[
        const SizedBox(height: 18),
        AdButton(
          label: 'End agent call',
          icon: PhosphorIcons.phoneX(PhosphorIconsStyle.bold),
          onPressed: onHangup,
        ),
      ],
    ]);
  }
}

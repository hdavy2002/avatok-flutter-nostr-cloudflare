import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ava_identity.dart';
import '../../core/avatar.dart';
import '../../core/calls/call_overlay.dart';
import '../../core/calls/call_session.dart';
import '../../core/calls/call_session_manager.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

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

/// Ground truth for "the user is genuinely on a call right now", checked before
/// auto-replying busy so a leftover [gInCall] flag can never silently block
/// every future call. Backed by [gLiveCallScreens] (a real live-session count),
/// NOT a time-windowed flag.
bool callIsGenuinelyActive() => gLiveCallScreens > 0;

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
  });
  @override
  State<CallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends State<CallScreen> {
  late final CallSession _session;
  bool _popped = false;

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
            action: SnackBarAction(label: 'Retry', onPressed: _popIfMounted),
          ));
        }
      },
      unreachable: () {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Text('${widget.title} is unreachable right now')));
        }
      },
    );
    _session.revision.addListener(_onSessionChanged);
    _session.uiPhase.addListener(_onSessionChanged);
    _session.elapsedSeconds.addListener(_onSessionChanged);
    _session.muted.addListener(_onSessionChanged);
    _session.speakerOn.addListener(_onSessionChanged);
    _session.cameraOn.addListener(_onSessionChanged);
    _session.videoActive.addListener(_onSessionChanged);
    _session.onCellularHold.addListener(_onSessionChanged);
  }

  void _onSessionChanged() {
    if (mounted) setState(() {});
  }

  void _popIfMounted() {
    if (_popped) return;
    _popped = true;
    if (mounted) Navigator.maybePop(context);
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
    super.dispose();
  }

  // Red button: end the call (durable hangup) and pop.
  void _hangup() => _session.endByUser();

  /// Back gesture / header ⌄ button: MINIMIZE, not hang up. Keeps the call alive
  /// (the session owns the WS/PC/renderers/FGS) and shows the floating video
  /// thumbnail / audio pill via [CallOverlay]. If the call has already ended
  /// (e.g. a busy/declined sticker is showing), fall through to a plain pop.
  void _minimize() {
    if (_session.isEnded || _session.phase.value == CallPhase.ended) {
      _popIfMounted();
      return;
    }
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
    final failed = phase == 'declined' || phase == 'busy' || phase == 'no-answer';
    final bottomInset = MediaQuery.of(context).padding.bottom;
    final stack = Stack(
      children: [
        if (showVideo) ...[
          Positioned.fill(
            child: connected
                ? RTCVideoView(s.remoteRenderer, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover)
                : Container(color: Zine.ink),
          ),
          Positioned(top: 0, left: 0, right: 0, height: 128,
              child: Container(color: Zine.ink.withValues(alpha: 0.45))),
          Positioned(
            top: 56, right: 16, width: 78, height: 112,
            child: Container(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(Zine.rSm),
                border: Zine.border,
                boxShadow: Zine.shadowSm,
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
                ZineBackButton(onTap: _minimize),
                const SizedBox(width: 12),
                if (showVideo)
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(widget.title,
                          maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: ZineText.cardTitle(size: 18, color: Colors.white)),
                      const SizedBox(height: 2),
                      Text((connected ? s.clock : s.statusText).toUpperCase(),
                          maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: ZineText.tag(size: 11, color: Colors.white)),
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
        if (light)
          Center(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24),
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
                        style: ZineText.hero(size: 30)),
                  ] else ...[
                    Container(
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: phase == 'ava-countdown' ? Zine.lilac : null,
                        border: Zine.borderLg,
                        boxShadow: Zine.shadow,
                      ),
                      child: phase == 'ava-countdown'
                          ? SizedBox(
                              width: 132, height: 132,
                              child: Center(child: Text('${s.avaCount}',
                                  style: ZineText.hero(size: 76))),
                            )
                          : Avatar(seed: widget.seed, name: widget.title, size: 132,
                              avatarUrl: widget.avatarUrl.isEmpty ? null : widget.avatarUrl),
                    ),
                    const SizedBox(height: 24),
                    Text(widget.title, textAlign: TextAlign.center,
                        style: ZineText.hero(size: 30)),
                  ],
                  const SizedBox(height: 16),
                  ZineSticker(
                    connected ? s.clock : s.statusText,
                    kind: failed ? ZineStickerKind.no : ZineStickerKind.plain,
                  ),
                ],
              ),
            ),
          ),

        // control row — bordered zine circles; hang-up = coral circle.
        Positioned(
          left: 0, right: 0, bottom: 0,
          child: Container(
            color: light ? null : Zine.ink.withValues(alpha: 0.45),
            padding: EdgeInsets.fromLTRB(16, 16, 16, 20 + (bottomInset > 0 ? bottomInset : 16)),
            child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              _btn(PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), onTap: () {}),
              const SizedBox(width: 14),
              _btn(
                  speaker
                      ? PhosphorIcons.speakerHigh(PhosphorIconsStyle.bold)
                      : PhosphorIcons.speakerSlash(PhosphorIconsStyle.bold),
                  active: speaker, onTap: s.toggleSpeaker),
              const SizedBox(width: 14),
              ZinePressable(
                onTap: _hangup,
                color: Zine.coral,
                radius: BorderRadius.circular(100),
                boxShadow: Zine.shadowSm,
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
              const SizedBox(width: 14),
              _btn(
                  muted
                      ? PhosphorIcons.microphoneSlash(PhosphorIconsStyle.bold)
                      : PhosphorIcons.microphone(PhosphorIconsStyle.bold),
                  active: !muted, onTap: s.toggleMute),
            ]),
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
        if (didPop) return;
        _minimize();
      },
      child: Scaffold(
        backgroundColor: light ? Zine.paper : Zine.ink,
        body: light ? ZinePaper(child: stack) : stack,
      ),
    );
  }

  // Zine control circle — ink border, card fill, hard shadow; active = lime.
  Widget _btn(IconData icon, {bool active = false, required VoidCallback onTap}) {
    return ZinePressable(
      onTap: onTap,
      color: active ? Zine.lime : Zine.card,
      pressedColor: Zine.lime,
      radius: BorderRadius.circular(100),
      boxShadow: Zine.shadowXs,
      child: SizedBox(
        width: 48, height: 48,
        child: Center(child: PhosphorIcon(icon, size: 21, color: Zine.ink)),
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
      color: light ? Zine.card : Colors.white.withValues(alpha: 0.16),
      radius: BorderRadius.circular(100),
      boxShadow: light ? Zine.shadowXs : const [],
      child: SizedBox(
        width: 42,
        height: 42,
        child: Center(
          child: PhosphorIcon(
            PhosphorIcons.caretDown(PhosphorIconsStyle.bold),
            size: 20,
            color: light ? Zine.ink : Colors.white,
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
          color: Zine.lilac,
          border: Zine.borderLg,
          boxShadow: Zine.shadowSm,
        ),
        clipBehavior: Clip.antiAlias,
        child: Image.asset(
          AvaId.avatarAsset,
          width: 88,
          height: 88,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) =>
              Center(child: Text('A', style: ZineText.hero(size: 40))),
        ),
      );

  Widget _label(String s) => SizedBox(
        width: 104,
        child: Text(s,
            textAlign: TextAlign.center,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: ZineText.tag(size: 12)),
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
                _pulse(child: widget.me, level: mic, color: Zine.ink),
                SizedBox(
                  width: 92,
                  height: 104,
                  child: CustomPaint(
                    painter: _LinkPainter(phase: _flow.value, mic: mic, ava: ava),
                  ),
                ),
                _pulse(child: _avaCircle(), level: ava, color: Zine.lilac),
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
    final color = active ? Zine.ink : Zine.lilac;
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

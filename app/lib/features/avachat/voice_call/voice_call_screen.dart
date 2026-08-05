/// VoiceCallScreen — the hands-free "Voice call Ava" UI.
///
/// An animated voice orb sits in the middle of the screen (no Ava portrait asset
/// yet); it breathes while listening and pulses brighter while Ava speaks. Live
/// captions show the last thing the user said and Ava's reply. One big End button.
/// All the audio/logic lives in [LiveVoiceController]; this screen just renders it.
/// Every 5 minutes it pauses and asks "Keep going?" — a spend guardrail for the
/// online Live session (which also runs sliding-window context compression).
library;

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../wallet/wallet_screen.dart';
import 'live_voice_controller.dart';
import 'voice_call_api.dart';

class VoiceCallScreen extends StatefulWidget {
  const VoiceCallScreen({super.key});
  @override
  State<VoiceCallScreen> createState() => _VoiceCallScreenState();
}

class _VoiceCallScreenState extends State<VoiceCallScreen>
    with SingleTickerProviderStateMixin {
  final LiveVoiceController _call = LiveVoiceController();
  late final AnimationController _pulse;

  // 5-minute "still there?" guardrail — a visible countdown. At 50s left it beeps
  // a warning; at 0 it pauses + asks "Keep going?"; if the user doesn't respond
  // within _autoEndFrom seconds the call auto-disconnects.
  static const _segment = Duration(minutes: 5);
  static const int _warnAt = 50; // seconds-left warning beep
  static const int _autoEndFrom = 20; // overlay auto-disconnect countdown
  Timer? _segTimer;
  Timer? _autoEndTimer;
  bool _started = false;
  bool _needContinue = false;
  bool _warned = false;
  int _remaining = 300; // seconds left in the current 5-min segment
  int _autoEnd = _autoEndFrom; // seconds left before auto-disconnect on the prompt
  int _segNum = 0; // which 5-min segment we're on

  // Guardrail/timer events, stamped with the controller's call_id so they stitch
  // into the same call lifecycle in PostHog.
  void _seg(String action, [Map<String, Object> extra = const {}]) {
    Analytics.capture('voice_live_segment',
        {'call_id': _call.callId, 'action': action, 'segment': _segNum, ...extra});
  }

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 2200))
      ..repeat();
    _call.state.addListener(_onState);
    // [AVABRAIN-VOICE-BILL-1] Fires at most once, only for a metered session,
    // when the server's heartbeat advises the balance ran out. The controller
    // has already ended the call by the time this runs; this just offers the
    // top-up path.
    _call.onInsufficientBalance = _showTopUpPrompt;
    // If this screen is re-presented for an already-running call (tap the
    // notification / tap the pill to return), clear minimized instead of
    // starting a second call.
    if (_call.minimized.value) {
      _call.restore();
    } else {
      _call.start();
    }
  }

  void _showTopUpPrompt() {
    if (!mounted) return;
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Out of AvaBrain voice balance'),
        content: const Text('Top up to keep talking to Ava.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('Not now')),
          TextButton(
            onPressed: () {
              Navigator.of(ctx).pop();
              Navigator.of(context).push(MaterialPageRoute(builder: (_) => const WalletScreen()));
            },
            child: const Text('Top up'),
          ),
        ],
      ),
    );
  }

  // Start the segment timer once the call is actually live.
  void _onState() {
    if (!_started && _call.state.value == CallState.listening) {
      _started = true;
      _startSegTimer();
    }
  }

  void _startSegTimer() {
    _segTimer?.cancel();
    _remaining = _segment.inSeconds;
    _warned = false;
    _segNum++;
    _segTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() => _remaining--);
      // Heads-up beep ~50s before the segment ends.
      if (!_warned && _remaining == _warnAt) {
        _warned = true;
        SystemSound.play(SystemSoundType.alert);
        _seg('warn', {'remaining': _remaining});
      }
      if (_remaining <= 0) {
        _segTimer?.cancel();
        _onSegmentEnd();
      }
    });
  }

  Future<void> _onSegmentEnd() async {
    if (!mounted) return;
    await _call.pause(); // stop billing while we wait for the user
    SystemSound.play(SystemSoundType.alert); // beep
    if (!mounted) return;
    setState(() { _needContinue = true; _autoEnd = _autoEndFrom; });
    _seg('prompt');
    // Auto-disconnect if the user doesn't tap Continue in time.
    _autoEndTimer?.cancel();
    _autoEndTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() => _autoEnd--);
      if (_autoEnd <= 0) {
        _autoEndTimer?.cancel();
        _seg('autoend');
        _end();
      }
    });
  }

  Future<void> _continue() async {
    _autoEndTimer?.cancel();
    setState(() => _needContinue = false);
    _seg('continue');
    // Resume the SAME Live session: sliding-window context compression (set in the
    // token) keeps the running context bounded and carries it into the next turn,
    // so a long 2-hour call stays roughly linear in tokens.
    await _call.resume();
    _startSegTimer();
  }

  String _fmt(int s) {
    if (s < 0) s = 0;
    final m = s ~/ 60;
    final ss = (s % 60).toString().padLeft(2, '0');
    return '$m:$ss';
  }

  // CALL-GLIVE-E4/E5: guards so we only run ONE of {minimize, real end} when
  // this screen goes away, and so a real end doesn't also try to minimize.
  bool _endedByUser = false;

  @override
  void dispose() {
    // View detach ONLY. If the screen is going away because the user tapped
    // End, `_end()` already ran the real teardown (`_call.dispose()`) before
    // this pop — `_call.detach()` here is a documented no-op. If the screen is
    // going away because of minimize (back navigation), the segment timers
    // must also pause-but-not-cancel is unnecessary: they are UI-only (the
    // 5-min guardrail) and safe to leave running against the still-live call;
    // we still cancel them here because they drive `setState` on THIS widget,
    // which would throw once disposed — the call's own state is untouched.
    _segTimer?.cancel();
    _autoEndTimer?.cancel();
    _call.state.removeListener(_onState);
    _pulse.dispose();
    _call.detach();
    super.dispose();
  }

  Future<void> _end() async {
    _endedByUser = true;
    _segTimer?.cancel();
    _autoEndTimer?.cancel();
    await _call.dispose();
    if (mounted) Navigator.of(context).pop();
  }

  /// Back gesture / system back: minimize, don't hang up. Only the red End
  /// button (or notification Hang up, wired in the controller) ends the call.
  void _minimize() {
    if (_endedByUser) return;
    _call.minimize();
    if (mounted) Navigator.of(context).pop();
  }

  /// Orb fill per call state.
  ///
  /// [UI-ZINE-DARK-1] FILL/INK PAIR: these were the PALE poster colours
  /// (`Zine.mint`/`lilac`/`coral`/`blue`) carrying a near-BLACK `Zine.ink`
  /// glyph. Mapping the ink to `AD.textPrimary` (white) on those pale fills
  /// would have made the glyph vanish. Both sides moved together: the fills are
  /// now the dark system's SATURATED family `solid` variants and the glyph is
  /// white — every pair clears the 3:1 graphical-object bar.
  Color _orbColor(CallState s) => switch (s) {
        CallState.speaking => AD.familyByName('mint').solid,
        CallState.thinking => AD.familyByName('lilac').solid,
        CallState.error => AD.destructiveBg,
        _ => AD.familyByName('sky').solid,
      };

  @override
  Widget build(BuildContext context) {
    return PopScope(
      // Back = minimize (pill/FGS keep the call alive), not hang up.
      canPop: false,
      onPopInvokedWithResult: (didPop, result) {
        if (didPop) return;
        _minimize();
      },
      child: Scaffold(
        backgroundColor: AD.bg,
        body: ZinePaper(
          child: SafeArea(
            child: Stack(children: [
              Column(children: [
                _topBar(),
                const Spacer(),
                _orb(),
                const SizedBox(height: Msg.s5),
                _statusLine(),
                const SizedBox(height: Msg.s4),
                _captions(),
                const Spacer(),
                Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  _routeButton(),
                  const SizedBox(width: Msg.s4),
                  _endButton(),
                ]),
                const SizedBox(height: Msg.s5),
              ]),
              if (_needContinue) _continueOverlay(),
            ]),
          ),
        ),
      ),
    );
  }

  // After 5 minutes the call pauses (no billing) and asks to keep going.
  Widget _continueOverlay() => Positioned.fill(
        child: Container(
          color: AD.scrim,
          alignment: Alignment.center,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: Msg.s5),
            child: ZineCard(
              padding: const EdgeInsets.all(20),
              boxShadow: Msg.lift,
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                PhosphorIcon(PhosphorIcons.pauseCircle(PhosphorIconsStyle.fill),
                    size: 40, color: Msg.accent),
                const SizedBox(height: Msg.s3),
                Text('Still there?',
                    style: ADText.threadName().copyWith(fontSize: 18)),
                const SizedBox(height: Msg.s1),
                Text(
                  "You've been talking with Ava for 5 minutes. Keep going?",
                  textAlign: TextAlign.center,
                  style: ADText.preview(c: AD.textSecondary)
                      .copyWith(fontSize: 13),
                ),
                const SizedBox(height: Msg.s2),
                Text(
                  'Ending in ${_autoEnd}s…',
                  textAlign: TextAlign.center,
                  style: ADText.sectionLabel(c: Msg.error),
                ),
                const SizedBox(height: Msg.s4),
                Row(children: [
                  Expanded(
                    child: ZineButton(
                      label: 'End call',
                      variant: ZineButtonVariant.coral,
                      fontSize: 15,
                      onPressed: _end,
                    ),
                  ),
                  const SizedBox(width: Msg.s3),
                  Expanded(
                    child: ZineButton(
                      label: 'Continue',
                      fontSize: 15,
                      onPressed: _continue,
                    ),
                  ),
                ]),
              ]),
            ),
          ),
        ),
      );

  Widget _topBar() => Padding(
        padding: const EdgeInsets.fromLTRB(18, Msg.s3, 18, 0),
        child: Row(children: [
          // Forced `color:`/`boxShadow:` DROPPED — ZinePressable is already
          // re-skinned dark and defaults to AD.card with no shadow.
          ZinePressable(
            onTap: _minimize,
            radius: Msg.brPill, // a round icon button is genuinely round
            padding: const EdgeInsets.all(10),
            child: PhosphorIcon(
                PhosphorIcons.caretDown(PhosphorIconsStyle.regular),
                size: 18, color: AD.textPrimary),
          ),
          const SizedBox(width: Msg.s3),
          ZineMarkTitle(
            pre: 'Talking to ',
            mark: 'Ava',
            post: '',
            fontSize: 20,
            textAlign: TextAlign.left,
          ),
          const Spacer(),
          if (_started)
            Container(
              padding: const EdgeInsets.symmetric(
                  horizontal: Msg.s3, vertical: Msg.s1),
              decoration: BoxDecoration(
                color: AD.card,
                // A status pill IS one of the shapes Msg.rPill is reserved for.
                borderRadius: Msg.brPill,
                border: Border.all(color: AD.borderControl, width: 1),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                PhosphorIcon(PhosphorIcons.timer(PhosphorIconsStyle.regular),
                    size: 14,
                    color: _remaining <= 30 ? Msg.error : AD.textSecondary),
                const SizedBox(width: Msg.s1),
                Text(_fmt(_remaining),
                    style: ADText.rowName(
                            c: _remaining <= 30 ? Msg.error : AD.textPrimary)
                        .copyWith(fontSize: 13)),
              ]),
            ),
        ]),
      );

  Widget _orb() {
    return ValueListenableBuilder<CallState>(
      valueListenable: _call.state,
      builder: (context, st, _) {
        final color = _orbColor(st);
        return ValueListenableBuilder<bool>(
          valueListenable: _call.avaSpeaking,
          builder: (context, speaking, __) {
            return AnimatedBuilder(
              animation: _pulse,
              builder: (context, _) {
                final t = _pulse.value * 2 * math.pi;
                final amp = speaking ? 0.10 : 0.045;
                final scale = 1 + amp * math.sin(t);
                final glow = speaking ? 0.55 : 0.32;
                return Center(
                  child: Transform.scale(
                    scale: scale,
                    child: Container(
                      width: 190, height: 190,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        gradient: RadialGradient(
                          colors: [color, color.withValues(alpha: 0.6)],
                        ),
                        border: Border.all(color: AD.borderHairline, width: 1),
                        boxShadow: [
                          // The orb's glow is kept on purpose: it IS the
                          // affordance (it tells you Ava is speaking), not a
                          // decorative halo behind a control. The hard offset
                          // ink shadow that sat under it was pure paper idiom
                          // and is gone.
                          BoxShadow(
                            color: color.withValues(alpha: glow),
                            blurRadius: 44, spreadRadius: 8,
                          ),
                        ],
                      ),
                      child: PhosphorIcon(
                        st == CallState.speaking
                            ? PhosphorIcons.waveform(PhosphorIconsStyle.fill)
                            : st == CallState.thinking
                                ? PhosphorIcons.dotsThree(PhosphorIconsStyle.fill)
                                : PhosphorIcons.microphone(PhosphorIconsStyle.fill),
                        size: 64, color: Colors.white,
                      ),
                    ),
                  ),
                );
              },
            );
          },
        );
      },
    );
  }

  Widget _statusLine() => ValueListenableBuilder<String>(
        valueListenable: _call.status,
        builder: (context, s, _) => Text(
          s.isEmpty ? 'Listening…' : s,
          style: ADText.rowName().copyWith(fontSize: 16),
          textAlign: TextAlign.center,
        ),
      );

  Widget _captions() => Padding(
        padding: const EdgeInsets.symmetric(horizontal: Msg.s5),
        child: Column(children: [
          ValueListenableBuilder<String>(
            valueListenable: _call.userCaption,
            builder: (context, t, _) => t.isEmpty
                ? const SizedBox.shrink()
                : Padding(
                    padding: const EdgeInsets.only(bottom: Msg.s3),
                    child: Text('“$t”',
                        textAlign: TextAlign.center,
                        style: ADText.preview(c: AD.textSecondary)
                            .copyWith(fontSize: 14)),
                  ),
          ),
          ValueListenableBuilder<String>(
            valueListenable: _call.avaCaption,
            builder: (context, t, _) => t.isEmpty
                ? const SizedBox.shrink()
                : Text(t,
                    textAlign: TextAlign.center,
                    style: ADText.rowName()),
          ),
        ]),
      );

  Widget _endButton() => ZinePressable(
        onTap: _end,
        color: AD.destructiveBg,
        borderColor: AD.destructiveBg,
        // A labelled button is NOT one of the shapes Msg.rPill is reserved for.
        radius: Msg.brLg,
        padding: const EdgeInsets.symmetric(
            horizontal: Msg.s5, vertical: Msg.s4),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(PhosphorIcons.phoneX(PhosphorIconsStyle.fill),
              color: Colors.white, size: 22),
          const SizedBox(width: Msg.s3),
          Text('End call',
              style: ADText.rowName(c: Colors.white)
                  .copyWith(fontSize: 16, height: 1.0)),
        ]),
      );

  // Audio-route toggle: loudspeaker ⇆ earpiece/Bluetooth. Speaker ON is hands-free;
  // OFF hands the route to a connected Bluetooth/wired headset or the earpiece
  // (privacy). The choice is remembered for next time by the controller.
  Widget _routeButton() => ValueListenableBuilder<bool>(
        valueListenable: _call.speakerOn,
        builder: (context, on, _) => ZinePressable(
          onTap: () => _call.setSpeaker(!on),
          // Active = the single accent + white glyph, the same active-control
          // pairing ZineChip/AdChip use everywhere else.
          color: on ? Msg.accent : AD.card,
          borderColor: on ? Msg.accent : AD.borderControl,
          radius: Msg.brPill, // a round icon button is genuinely round
          padding: const EdgeInsets.all(Msg.s4),
          child: PhosphorIcon(
            on
                ? PhosphorIcons.speakerHigh(PhosphorIconsStyle.fill)
                : PhosphorIcons.phoneCall(PhosphorIconsStyle.fill),
            color: on ? Colors.white : AD.textPrimary, size: 24,
          ),
        ),
      );
}

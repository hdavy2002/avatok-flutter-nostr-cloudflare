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
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
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
    _call.start();
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

  @override
  void dispose() {
    _segTimer?.cancel();
    _autoEndTimer?.cancel();
    _call.state.removeListener(_onState);
    _pulse.dispose();
    _call.dispose();
    super.dispose();
  }

  Future<void> _end() async {
    _segTimer?.cancel();
    _autoEndTimer?.cancel();
    await _call.dispose();
    if (mounted) Navigator.of(context).pop();
  }

  Color _orbColor(CallState s) => switch (s) {
        CallState.speaking => Zine.mint,
        CallState.thinking => Zine.lilac,
        CallState.error => Zine.coral,
        _ => Zine.blue,
      };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      body: ZinePaper(
        child: SafeArea(
          child: Stack(children: [
            Column(children: [
              _topBar(),
              const Spacer(),
              _orb(),
              const SizedBox(height: 28),
              _statusLine(),
              const SizedBox(height: 18),
              _captions(),
              const Spacer(),
              _endButton(),
              const SizedBox(height: 28),
            ]),
            if (_needContinue) _continueOverlay(),
          ]),
        ),
      ),
    );
  }

  // After 5 minutes the call pauses (no billing) and asks to keep going.
  Widget _continueOverlay() => Positioned.fill(
        child: Container(
          color: Zine.ink.withValues(alpha: 0.45),
          alignment: Alignment.center,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 28),
            child: ZineCard(
              radius: Zine.rSm,
              padding: const EdgeInsets.all(20),
              boxShadow: Zine.shadowSm,
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                PhosphorIcon(PhosphorIcons.pauseCircle(PhosphorIconsStyle.fill),
                    size: 40, color: Zine.lilac),
                const SizedBox(height: 12),
                Text('Still there?', style: ZineText.value(size: 18)),
                const SizedBox(height: 6),
                Text(
                  "You've been talking with Ava for 5 minutes. Keep going?",
                  textAlign: TextAlign.center,
                  style: ZineText.sub(size: 13),
                ),
                const SizedBox(height: 8),
                Text(
                  'Ending in ${_autoEnd}s…',
                  textAlign: TextAlign.center,
                  style: ZineText.kicker(size: 11, color: Zine.coral),
                ),
                const SizedBox(height: 18),
                Row(children: [
                  Expanded(
                    child: ZineButton(
                      label: 'End call',
                      variant: ZineButtonVariant.coral,
                      fontSize: 15,
                      onPressed: _end,
                    ),
                  ),
                  const SizedBox(width: 12),
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
        padding: const EdgeInsets.fromLTRB(18, 12, 18, 0),
        child: Row(children: [
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
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                color: Zine.card,
                borderRadius: BorderRadius.circular(100),
                border: Zine.border,
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                PhosphorIcon(PhosphorIcons.timer(PhosphorIconsStyle.bold),
                    size: 14, color: _remaining <= 30 ? Zine.coral : Zine.inkSoft),
                const SizedBox(width: 6),
                Text(_fmt(_remaining),
                    style: ZineText.value(size: 13,
                        color: _remaining <= 30 ? Zine.coral : Zine.ink)),
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
                        border: Border.all(color: Zine.ink, width: Zine.bwLg),
                        boxShadow: [
                          BoxShadow(
                            color: color.withValues(alpha: glow),
                            blurRadius: 44, spreadRadius: 8,
                          ),
                          const BoxShadow(color: Zine.ink, offset: Offset(6, 7)),
                        ],
                      ),
                      child: Icon(
                        st == CallState.speaking
                            ? Icons.graphic_eq_rounded
                            : st == CallState.thinking
                                ? Icons.more_horiz_rounded
                                : Icons.mic_rounded,
                        size: 64, color: Zine.ink,
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
          style: ZineText.value(size: 16),
          textAlign: TextAlign.center,
        ),
      );

  Widget _captions() => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 26),
        child: Column(children: [
          ValueListenableBuilder<String>(
            valueListenable: _call.userCaption,
            builder: (context, t, _) => t.isEmpty
                ? const SizedBox.shrink()
                : Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Text('“$t”',
                        textAlign: TextAlign.center,
                        style: ZineText.sub(size: 13.5)),
                  ),
          ),
          ValueListenableBuilder<String>(
            valueListenable: _call.avaCaption,
            builder: (context, t, _) => t.isEmpty
                ? const SizedBox.shrink()
                : Text(t,
                    textAlign: TextAlign.center,
                    style: ZineText.value(size: 15)),
          ),
        ]),
      );

  Widget _endButton() => Center(
        child: ZinePressable(
          onTap: _end,
          color: Zine.coral,
          radius: BorderRadius.circular(100),
          boxShadow: Zine.shadowSm,
          padding: const EdgeInsets.symmetric(horizontal: 26, vertical: 16),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(PhosphorIcons.phoneX(PhosphorIconsStyle.fill),
                color: Colors.white, size: 22),
            const SizedBox(width: 10),
            Text('End call',
                style: ZineText.button(size: 16, color: Colors.white)),
          ]),
        ),
      );
}

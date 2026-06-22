/// VoiceCallScreen — the hands-free "Voice call Ava" UI.
///
/// An animated voice orb sits in the middle of the screen (no Ava portrait asset
/// yet); it breathes while listening and pulses brighter while Ava speaks. Live
/// captions show the last thing the user said and Ava's reply. One big End button.
/// All the audio/logic lives in [VoiceCallController]; this screen just renders it.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../../core/voice/voice_call_mode.dart';
import 'live_voice_controller.dart';
import 'voice_call_api.dart';
import 'voice_call_controller.dart';

class VoiceCallScreen extends StatefulWidget {
  const VoiceCallScreen({super.key});
  @override
  State<VoiceCallScreen> createState() => _VoiceCallScreenState();
}

class _VoiceCallScreenState extends State<VoiceCallScreen>
    with SingleTickerProviderStateMixin {
  // Fast online (Gemini Live) vs private on-device — the user's VoiceCallMode pick.
  final VoiceCallApi _call =
      VoiceCallMode.I.online.value ? LiveVoiceController() : VoiceCallController();
  late final AnimationController _pulse;

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 2200))
      ..repeat();
    _call.start();
  }

  @override
  void dispose() {
    _pulse.dispose();
    _call.dispose();
    super.dispose();
  }

  Future<void> _end() async {
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
          child: Column(children: [
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
        ),
      ),
    );
  }

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
          Text('LOCAL · GEMINI', style: ZineText.kicker(size: 10)),
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

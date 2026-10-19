import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/brand.dart';
import '../data.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets.dart';

enum _Stage { ringingThem, ringingYou, onCall, ended }

/// The masked call: we ring the influencer, then the fan's phone, then they talk.
/// In the demo the stages advance by themselves; End call shows the rating.
class CallScreen extends StatefulWidget {
  const CallScreen({super.key, required this.id});

  final String id;

  @override
  State<CallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends State<CallScreen> with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 1200))..repeat();
  _Stage _stage = _Stage.ringingThem;
  int _seconds = 0;
  int _stars = 0;
  Timer? _timer;

  Influencer get who => influencerById(widget.id);

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      setState(() {
        _seconds++;
        if (_stage == _Stage.ringingThem && _seconds >= 3) {
          _stage = _Stage.ringingYou;
          _seconds = 0;
        } else if (_stage == _Stage.ringingYou && _seconds >= 3) {
          _stage = _Stage.onCall;
          _seconds = 0;
        }
      });
    });
  }

  void _end() {
    _timer?.cancel();
    _pulse.stop();
    if (_stage == _Stage.onCall) demo.recordCall(who, _seconds);
    setState(() => _stage = _Stage.ended);
  }

  @override
  void dispose() {
    _timer?.cancel();
    _pulse.dispose();
    super.dispose();
  }

  String get _clock => '${(_seconds ~/ 60).toString().padLeft(2, '0')}:${(_seconds % 60).toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context) {
    final w = who;
    final first = w.name.split(' ').first;
    final minutes = _seconds == 0 ? 0 : (_seconds / 60).ceil();
    return PopScope(
      canPop: _stage == _Stage.ended,
      child: Scaffold(
        backgroundColor: C.cinema,
        body: SafeArea(
          child: Stack(
            children: [
              const Positioned(left: 0, top: 0, bottom: 0, child: SprocketRail()),
              const Positioned(right: 0, top: 0, bottom: 0, child: SprocketRail()),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 28),
                child: Column(
                  children: [
                    const SizedBox(height: 40),
                    SizedBox(
                      width: 220,
                      height: 220,
                      child: Stack(
                        alignment: Alignment.center,
                        children: [
                          if (_stage != _Stage.ended)
                            AnimatedBuilder(
                              animation: _pulse,
                              builder: (_, __) => Container(
                                width: 150 + 70 * _pulse.value,
                                height: 150 + 70 * _pulse.value,
                                decoration: BoxDecoration(shape: BoxShape.circle, color: C.marigold.withValues(alpha: 0.35 * (1 - _pulse.value))),
                              ),
                            ),
                          Avatar(w, size: 150),
                        ],
                      ),
                    ),
                    const SizedBox(height: 18),
                    Text(w.name, style: t(30, color: C.ivory, ls: 0.02)),
                    const SizedBox(height: 8),
                    Text(
                      switch (_stage) {
                        _Stage.ringingThem => 'Calling $first…',
                        _Stage.ringingYou => '$first picked up! Ringing your phone…',
                        _Stage.onCall => 'On call · $_clock',
                        _Stage.ended => 'Call ended',
                      },
                      textAlign: TextAlign.center,
                      style: t(19, color: C.gold),
                    ),
                    if (_stage == _Stage.ringingYou) ...[
                      const SizedBox(height: 10),
                      Text('Answer the call from the ${Brand.name} number.', textAlign: TextAlign.center, style: t(15, color: C.cream, w: FontWeight.w700)),
                    ],
                    if (_stage == _Stage.onCall) ...[
                      const SizedBox(height: 18),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
                        decoration: BoxDecoration(color: C.deep, borderRadius: BorderRadius.circular(14), border: Border.all(color: C.brass, width: 2)),
                        child: Text('$minutes min · ${inr(minutes * w.rate, paise: false)} so far', style: t(17, color: C.gold)),
                      ),
                      const SizedBox(height: 8),
                      Text('Wallet: ${inr(demo.balance - minutes * w.rate)}', style: t(14, color: C.cream, w: FontWeight.w700)),
                    ],
                    if (_stage == _Stage.ended) ...[
                      const SizedBox(height: 18),
                      Text(
                        demo.calls.isNotEmpty && demo.calls.first.who.id == w.id && demo.calls.first.when == 'Just now'
                            ? '${demo.calls.first.minutes} min · ${inr(demo.calls.first.cost, paise: false)}'
                            : 'No charge — the call did not connect.',
                        style: t(18, color: C.ivory),
                      ),
                      const SizedBox(height: 22),
                      Text('How was it?', style: t(18, color: C.gold)),
                      const SizedBox(height: 8),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          for (var i = 1; i <= 5; i++)
                            IconButton(
                              iconSize: 40,
                              tooltip: '$i stars',
                              onPressed: () {
                                setState(() => _stars = i);
                                demo.rateLastCall(i);
                              },
                              icon: Icon(i <= _stars ? Icons.star_rounded : Icons.star_outline_rounded, color: C.marigold),
                            ),
                        ],
                      ),
                    ],
                    const Spacer(),
                    if (_stage != _Stage.ended)
                      SizedBox(
                        width: double.infinity,
                        child: ChunkyButton(label: 'END CALL', icon: Icons.call_end_rounded, dark: true, height: 64, onTap: _end),
                      )
                    else
                      SizedBox(
                        width: double.infinity,
                        child: ChunkyButton(label: 'DONE', height: 64, onTap: () => context.canPop() ? context.pop() : context.go('/reels')),
                      ),
                    const SizedBox(height: 24),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/brand.dart';
import '../data.dart';
import '../state.dart';
import '../theme.dart';
import '../call_kit.dart';
import 'call_real.dart';

enum _Stage { ringingThem, ringingYou, onCall, ended }

/// The masked call: we ring the influencer, then the fan's phone, then they talk.
/// In the demo the stages advance by themselves; End call shows the rating.
/// `/call/:id`. In a real build [id] is the call id from `POST /api/hf/calls` (HF-WIRE-7, call_real.dart);
/// in the demo it is the influencer id and the dummy stages below run.
class CallScreen extends StatelessWidget {
  const CallScreen({super.key, required this.id});

  final String id;

  @override
  Widget build(BuildContext context) => CallsBridge.real ? RealCallScreen(callId: id) : _DemoCallScreen(id: id);
}

class _DemoCallScreen extends StatefulWidget {
  const _DemoCallScreen({required this.id});

  final String id;

  @override
  State<_DemoCallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends State<_DemoCallScreen> with SingleTickerProviderStateMixin {
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
    final ended = _stage == _Stage.ended;
    final last = demo.calls.isNotEmpty && demo.calls.first.who.id == w.id && demo.calls.first.when == 'Just now' ? demo.calls.first : null;
    // [HF-APP-DESI-6] approved on-call / call-ended layout
    return PopScope(
      canPop: ended,
      child: Scaffold(
        backgroundColor: C.deep,
        body: CallBackdrop(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(22, 40, 22, 24),
            child: Column(
              children: [
                CallPortrait(who: w, pulse: _pulse, active: !ended, small: ended),
                const SizedBox(height: 14),
                if (ended) ...[
                  Text('Call ended', style: t(28, color: C.white, w: FontWeight.w900)),
                  Text('with ${w.name}', style: t(16, color: C.white, w: FontWeight.w700)),
                  const SizedBox(height: 16),
                  last != null
                      ? CallEndHisaab(talked: '${last.minutes} min', paid: inr(last.cost, paise: false), footer: 'Wallet now ${inr(demo.balance)} · no charge if a call doesn\'t connect')
                      : const CallEndHisaab(message: 'No charge — the call did not connect.'),
                  if (last != null) ...[
                    const SizedBox(height: 18),
                    CallStars(value: _stars, onPick: (i) {
                      setState(() => _stars = i);
                      demo.rateLastCall(i);
                    }),
                  ],
                ] else ...[
                  Text(w.name, textAlign: TextAlign.center, style: t(30, color: C.white, w: FontWeight.w900)),
                  const SizedBox(height: 8),
                  if (_stage == _Stage.onCall) ...[
                    const CallOnChip(),
                    const SizedBox(height: 10),
                    CallClock(_clock),
                    const SizedBox(height: 14),
                    CallSpendTiles(spent: inr(minutes * w.rate, paise: false), spentSub: '$minutes min', wallet: inr(demo.balance - minutes * w.rate)),
                  ] else ...[
                    Text(_stage == _Stage.ringingThem ? 'Calling $first…' : '$first picked up! Ringing your phone…', textAlign: TextAlign.center, style: t(19, color: C.lemon, w: FontWeight.w800)),
                    if (_stage == _Stage.ringingYou) ...[
                      const SizedBox(height: 10),
                      Text('Answer the call from the ${Brand.name} number.', textAlign: TextAlign.center, style: t(15, color: C.white, w: FontWeight.w700)),
                    ],
                  ],
                ],
                const Spacer(),
                if (!ended)
                  CallPill(label: 'END CALL', kind: CallPillKind.red, icon: Icons.call_end_rounded, height: 64, onTap: _end)
                else
                  CallPill(label: 'DONE', kind: CallPillKind.gold, onTap: () => context.canPop() ? context.pop() : context.go('/reels')),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

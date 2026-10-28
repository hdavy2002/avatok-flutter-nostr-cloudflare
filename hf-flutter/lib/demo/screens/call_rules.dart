import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/brand.dart';
import '../../data/api_exception.dart';
import '../../data/call_safety_store.dart';
import '../../data/repos/call_safety_repo.dart';
import '../../data/services.dart';
import '../../data/telemetry.dart';
import '../../ui/async_view.dart';
import '../call_safety_kit.dart';
import '../desi.dart';
import '../theme.dart';
import '../widgets.dart';
import 'onboarding/intro_onb_kit.dart' show onbTotalSteps;

/// [HF-CALL-SAFETY-APP] "Our call rules" (artboard AppRules): lavender hero, the four rules with icon tiles, the striped strike note,
/// a tick box and "I agree · continue". Used three ways: onboarding step 7 ([OnbRulesStep]), the one-time gate before an existing
/// influencer can go Online again (`/safety/rules?gate=1`), and the read-only view from Me > Call rules ([CallRulesScreen]).

class _Rule {
  const _Rule(this.icon, this.tone, this.title, this.sub);
  final IconData icon;
  final DesiTone tone;
  final String title;
  final String sub;
}

List<_Rule> _rules() => <_Rule>[
      _Rule(Icons.remove_shopping_cart_rounded, DesiTone.rani, "Don't sell", 'Sell merch in the ${Brand.name} Shop'),
      const _Rule(Icons.money_off_rounded, DesiTone.gold, 'No outside payment', 'No UPI, GPay or cash outside the app'),
      const _Rule(Icons.phone_disabled_rounded, DesiTone.tea, 'No contact sharing', 'No numbers, IDs or addresses'),
      const _Rule(Icons.favorite_rounded, DesiTone.lav, 'Be respectful', 'No abuse, threats or sexual talk'),
    ];

/// Hero, the rules card and the strike note. The screens put their own header above and their own footer below.
class CallRulesBody extends StatelessWidget {
  const CallRulesBody({super.key, this.eyebrow = 'Before you go live', this.strikesToPause = 3});

  final String eyebrow;
  final int strikesToPause;

  @override
  Widget build(BuildContext context) {
    final rules = _rules();
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      DesiHero(
        eyebrow: eyebrow,
        title: 'Our call rules',
        sub: 'Calls are recorded for safety. Nobody listens live.',
        ghost: 'Niyam',
        tone: DesiTone.lav,
        minHeight: 150,
      ),
      const SizedBox(height: 12),
      DesiCard(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        child: Column(children: [
          for (var i = 0; i < rules.length; i++)
            Container(
              constraints: const BoxConstraints(minHeight: 62),
              padding: const EdgeInsets.symmetric(vertical: 8),
              decoration: BoxDecoration(border: i == rules.length - 1 ? null : const Border(bottom: BorderSide(color: C.line))),
              child: Row(children: [
                DesiIconSquare(rules[i].icon, tone: rules[i].tone, size: 44),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(rules[i].title, style: t(16, w: FontWeight.w800)),
                    Text(rules[i].sub, style: t(14, color: C.muted, w: FontWeight.w600)),
                  ]),
                ),
              ]),
            ),
        ]),
      ),
      const SizedBox(height: 12),
      DesiCard(
        pattern: DesiPattern.stripes,
        radius: 20,
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        child: Text.rich(TextSpan(style: t(15, w: FontWeight.w700, h: 1.45), children: [
          const TextSpan(text: 'Breaking a rule gives a strike. '),
          TextSpan(text: '$strikesToPause strikes pause your account', style: t(15, w: FontWeight.w800, h: 1.45)),
          const TextSpan(text: ' until a person checks it.'),
        ])),
      ),
    ]);
  }
}

/// The tick box and the main button at the bottom.
class _AgreeBar extends StatefulWidget {
  const _AgreeBar({required this.busy, required this.onAgree, this.error});

  final bool busy;
  final VoidCallback onAgree;
  final String? error;

  @override
  State<_AgreeBar> createState() => _AgreeBarState();
}

class _AgreeBarState extends State<_AgreeBar> {
  bool _on = false;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 20),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (widget.error != null) ...[
          Semantics(liveRegion: true, child: Text(widget.error!, style: t(14, color: C.ruby, w: FontWeight.w800, h: 1.35))),
          const SizedBox(height: 8),
        ],
        SafetyTick(
          label: 'I agree to the call rules and the Influencer Agreement, and that my calls are recorded and checked.',
          on: _on,
          onTap: widget.busy ? null : () => setState(() => _on = !_on),
        ),
        const SizedBox(height: 12),
        SafetyButton('I agree · continue', busy: widget.busy, onTap: _on ? widget.onAgree : null),
      ]),
    );
  }
}

// ======================================================================================================== standalone

/// Me > Call rules, and the gate before going Online. Not agreed yet: tick and "I agree · continue". Already agreed: read only.
class CallRulesScreen extends StatefulWidget {
  const CallRulesScreen({super.key, this.gate = false, this.repo});

  /// True when opened because the server answered 403 `call_rules_required`: agreeing closes the screen with `true`.
  final bool gate;
  final CallSafetyRepo? repo;

  @override
  State<CallRulesScreen> createState() => _CallRulesScreenState();
}

class _CallRulesScreenState extends State<CallRulesScreen> {
  AsyncState<SafetyMe> _state = const AsyncLoading<SafetyMe>();
  bool _busy = false;
  String? _error;

  CallSafetyRepo get _repo => widget.repo ?? Services.instance.callSafetyRepo;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    if (_state is! AsyncLoading<SafetyMe>) setState(() => _state = const AsyncLoading<SafetyMe>());
    try {
      final m = await _repo.me();
      if (!mounted) return;
      setState(() => _state = AsyncData<SafetyMe>(m));
      CallSafetyStore.instance.accept(m);
      Telemetry.event('hf_safety_view', {'surface': 'rules', 'status': m.status});
    } catch (e) {
      if (!mounted) return;
      setState(() => _state = AsyncFailure<SafetyMe>(e));
    }
  }

  Future<void> _agree(SafetyMe m) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final surface = widget.gate ? 'gate' : 'me';
    try {
      await _repo.acceptRules(m.rulesVersion);
      Telemetry.event('hf_safety_rules_accepted', {'version': m.rulesVersion, 'surface': surface, 'outcome': 'ok'});
      if (!mounted) return;
      setState(() => _busy = false);
      if (widget.gate) {
        toast(context, 'Thank you. You can switch Online now.');
        context.canPop() ? context.pop(true) : context.go('/me');
      } else {
        unawaited(_load());
      }
    } on ApiException catch (e) {
      Telemetry.event('hf_safety_rules_accepted', {'version': m.rulesVersion, 'surface': surface, 'outcome': 'failed', 'reason': e.code});
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.userMessage;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = ApiException.genericText;
      });
    }
  }

  Widget _content(BuildContext context, SafetyMe m) {
    return Column(children: [
      Expanded(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          children: [
            CallRulesBody(eyebrow: m.rulesAccepted ? 'Call rules' : 'Before you go live', strikesToPause: m.strikesToPause),
            if (m.rulesAccepted) ...[
              const SizedBox(height: 12),
              const Align(alignment: Alignment.centerLeft, child: DesiChip('You agreed to these rules', tone: DesiTone.tea, icon: Icons.check_rounded)),
              const SizedBox(height: 8),
              const DesiMogra(),
            ],
          ],
        ),
      ),
      if (!m.rulesAccepted) _AgreeBar(busy: _busy, error: _error, onAgree: () => unawaited(_agree(m))),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(children: [
          const SafetyHeader(title: 'Call rules'),
          Expanded(
            child: AsyncView<SafetyMe>(
              state: _state,
              onRetry: () => unawaited(_load()),
              isEmpty: (_) => false,
              builder: _content,
            ),
          ),
        ]),
      ),
    );
  }
}

// ======================================================================================================== onboarding

/// Onboarding step 7 of 8 "Our call rules", between "How do you want to take calls?" and "Sent for approval". Agreeing records the
/// rules (`POST /api/hf/safety/rules/accept`) and then calls [onAgreed], which sends the application. [busy] and [error] come from
/// the flow while it sends.
class OnbRulesStep extends StatefulWidget {
  const OnbRulesStep({super.key, required this.onBack, required this.onAgreed, required this.busy, required this.error, this.repo});

  final VoidCallback onBack;
  final VoidCallback onAgreed;
  final bool busy;
  final String? error;
  final CallSafetyRepo? repo;

  @override
  State<OnbRulesStep> createState() => _OnbRulesStepState();
}

class _OnbRulesStepState extends State<OnbRulesStep> {
  AsyncState<SafetyMe> _state = const AsyncLoading<SafetyMe>();
  bool _acting = false;
  String? _err;

  CallSafetyRepo get _repo => widget.repo ?? Services.instance.callSafetyRepo;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    if (_state is! AsyncLoading<SafetyMe>) setState(() => _state = const AsyncLoading<SafetyMe>());
    try {
      final m = await _repo.me();
      if (!mounted) return;
      setState(() => _state = AsyncData<SafetyMe>(m));
      Telemetry.event('hf_safety_view', {'surface': 'rules', 'status': m.status});
    } catch (e) {
      if (!mounted) return;
      setState(() => _state = AsyncFailure<SafetyMe>(e));
    }
  }

  Future<void> _agree(SafetyMe m) async {
    if (_acting || widget.busy) return;
    if (m.rulesAccepted) {
      widget.onAgreed();
      return;
    }
    setState(() {
      _acting = true;
      _err = null;
    });
    try {
      await _repo.acceptRules(m.rulesVersion);
      Telemetry.event('hf_safety_rules_accepted', {'version': m.rulesVersion, 'surface': 'onboarding', 'outcome': 'ok'});
      if (!mounted) return;
      setState(() => _acting = false);
      widget.onAgreed();
    } on ApiException catch (e) {
      Telemetry.event('hf_safety_rules_accepted', {'version': m.rulesVersion, 'surface': 'onboarding', 'outcome': 'failed', 'reason': e.code});
      if (!mounted) return;
      setState(() {
        _acting = false;
        _err = e.userMessage;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _acting = false;
        _err = ApiException.genericText;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final total = onbTotalSteps();
    final busy = _acting || widget.busy;
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(children: [
          SafetyHeader(stepLabel: 'Step 7 of $total', progress: 7 / total, onBack: busy ? () {} : widget.onBack),
          Expanded(
            child: AsyncView<SafetyMe>(
              state: _state,
              onRetry: () => unawaited(_load()),
              isEmpty: (_) => false,
              builder: (context, m) => Column(children: [
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                    children: [CallRulesBody(strikesToPause: m.strikesToPause)],
                  ),
                ),
                _AgreeBar(busy: busy, error: widget.error ?? _err, onAgree: () => unawaited(_agree(m))),
              ]),
            ),
          ),
        ]),
      ),
    );
  }
}

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';
import '../../../explore/data/host_options.dart';
import '../../../kyc/kyc.dart';
import '../../flow/onboarding_context.dart';
import '../data/edit_lock.dart';
import '../data/part_b_rules.dart';
import '../data/part_b_telemetry.dart';
import '../data/profile_saver.dart';
import 'part_b_copy.dart';
import 'part_b_widgets.dart';

/// Step `price`: one price for every topic, whole rupees per minute (from `GET /api/hf/options`, 5 to 100).
/// Shows what the caller pays and what the host gets (the platform keeps Rs 2 and 40% of the rest, GST inside).
/// A live host can still change the price.
class PriceStep extends ConsumerStatefulWidget {
  const PriceStep({super.key, required this.ctx});

  final OnboardingStepContext ctx;

  @override
  ConsumerState<PriceStep> createState() => _PriceStepState();
}

class _PriceStepState extends ConsumerState<PriceStep> {
  late final ProfileSaver _saver;
  late int _price;
  bool _busy = false;

  OnboardingStepContext get ctx => widget.ctx;

  @override
  void initState() {
    super.initState();
    _saver = ref.read(profileSaverProvider);
    final server = ctx.state.hostNum('pricePerMin')?.toInt();
    _saver.seed('pricePerMin', server);
    final v = _saver.valueOf('pricePerMin', server);
    _price = v is int ? v : kDefaultPrice;
    _saver.addListener(_changed);
  }

  @override
  void dispose() {
    _saver.removeListener(_changed);
    unawaited(_saver.flush());
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  void _set(int v, int min, int max) {
    final next = v < min ? min : (v > max ? max : v);
    setState(() => _price = next);
    _saver.set('pricePerMin', next);
  }

  Future<void> _continue() async {
    if (_busy) return;
    if (EditLock.of(ctx.state.hostStatus).priceHoursLocked) {
      await ctx.next();
      return;
    }
    setState(() => _busy = true);
    // The default price counts as a choice: it is saved even when the host never touched it.
    _saver.set('pricePerMin', _price);
    final ok = await _saver.flush(fields: const <String>['pricePerMin']);
    if (!mounted) return;
    setState(() => _busy = false);
    if (!ok) {
      OnboardingTelemetry.step('price', 'error', reason: _saver.saveProblem == null ? 'invalid_field' : 'save_failed');
      return;
    }
    OnboardingTelemetry.step('price', 'ok');
    await ctx.next();
  }

  @override
  Widget build(BuildContext context) {
    final opts = optionsOf(ref.watch(hostOptionsProvider));
    final min = opts?.priceMin ?? 5;
    final max = opts?.priceMax ?? 100;
    final lock = EditLock.of(ctx.state.hostStatus);
    final locked = lock.priceHoursLocked;
    final banner = lock.banner(editableWhenLive: true);
    final price = _price < min ? min : (_price > max ? max : _price);
    final mine = hostSharePaise(price);
    final platform = price * 100 - mine;
    final monthlyPaise = mine * 60 * 25;
    final problem = _saver.saveProblem;
    final fieldError = _saver.errorOf('pricePerMin');
    return PartBStep(
      scene: HfSceneKind.wallet,
      title: PartBCopy.priceTitle,
      lead: PartBCopy.priceLead,
      bottom: [
        if (fieldError != null) InlineError(fieldError),
        if (problem != null) InlineError(problem),
        const SizedBox(height: 4),
        HfButton(
          key: const ValueKey<String>('price-continue'),
          label: PartBCopy.continueLabel,
          loading: _busy,
          onPressed: _continue,
        ),
      ],
      children: [
        if (banner != null) LockBanner(banner),
        HfCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Semantics(
                liveRegion: true,
                child: Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(text: rupeesText(price), style: HfText.hero.copyWith(fontSize: 36)),
                      const TextSpan(text: ' ${PartBCopy.perMin}', style: HfText.bodyStrong),
                    ],
                  ),
                  key: const ValueKey<String>('price-big'),
                  textAlign: TextAlign.center,
                ),
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  IconButton.filledTonal(
                    constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
                    key: const ValueKey<String>('price-minus'),
                    tooltip: PartBCopy.lowerPrice,
                    iconSize: 28,
                    onPressed: locked || price <= min ? null : () => _set(price - 1, min, max),
                    icon: const Icon(Icons.remove_rounded),
                  ),
                  Expanded(
                    child: Slider(
                      key: const ValueKey<String>('price-slider'),
                      value: price.toDouble(),
                      min: min.toDouble(),
                      max: max.toDouble(),
                      divisions: max - min,
                      semanticFormatterCallback: (v) => '${rupeesText(v.round())} per minute',
                      onChanged: locked ? null : (v) => _set(v.round(), min, max),
                    ),
                  ),
                  IconButton.filledTonal(
                    constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
                    key: const ValueKey<String>('price-plus'),
                    tooltip: PartBCopy.raisePrice,
                    iconSize: 28,
                    onPressed: locked || price >= max ? null : () => _set(price + 1, min, max),
                    icon: const Icon(Icons.add_rounded),
                  ),
                ],
              ),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(rupeesText(min), style: HfText.note),
                  Text(rupeesText(max), style: HfText.note),
                ],
              ),
              const SizedBox(height: 12),
              const Text(PartBCopy.quickPicks, style: HfText.bodyStrong),
              const SizedBox(height: 4),
              Wrap(
                spacing: 8,
                runSpacing: 4,
                children: [
                  for (final v in kQuickPrices)
                    if (v >= min && v <= max)
                      HfChip(
                        key: ValueKey<String>('price-pick-$v'),
                        label: rupeesText(v),
                        selected: price == v,
                        onTap: locked ? null : () => _set(v, min, max),
                      ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        HfCard(
          color: HfColors.mint,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _Line(PartBCopy.callerPays, '${rupeesText(price)}${PartBCopy.previewPerMin}'),
              _Line(PartBCopy.youGet, '${rupeesFromPaise(mine)}${PartBCopy.previewPerMin}', strong: true, lineKey: 'price-you-get'),
              _Line(PartBCopy.platformGets, rupeesFromPaise(platform)),
              const SizedBox(height: 8),
              Text(PartBCopy.priceExample(rupeesFromPaise(monthlyPaise)), style: HfText.note),
            ],
          ),
        ),
        const SizedBox(height: 12),
        const Text(PartBCopy.priceChangeAnytime, style: HfText.note),
      ],
    );
  }
}

class _Line extends StatelessWidget {
  const _Line(this.label, this.value, {this.strong = false, this.lineKey});

  final String label;
  final String value;
  final bool strong;
  final String? lineKey;

  @override
  Widget build(BuildContext context) {
    final style = strong ? HfText.bodyStrong : HfText.bodyText;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: style),
          const SizedBox(height: 4),
          Text(value, key: lineKey == null ? null : ValueKey<String>(lineKey!), style: style),
        ],
      ),
    );
  }
}

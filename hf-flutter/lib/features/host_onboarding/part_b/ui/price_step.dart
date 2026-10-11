import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/theme/hf_theme.dart';
import '../../../../core/widgets/widgets.dart';
import '../../../explore/data/host_options.dart';
import '../../flow/onboarding_context.dart';
import '../data/edit_lock.dart';
import '../data/part_b_rules.dart';
import '../data/part_b_telemetry.dart';
import '../data/profile_saver.dart';
import 'part_b_copy.dart';
import 'part_b_widgets.dart';

/// Legacy flag-off step: one price for every topic, in whole rupees per minute.
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
    final value = _saver.valueOf('pricePerMin', server);
    _price = value is int ? value : kDefaultPrice;
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

  void _set(int value, int min, int max) {
    final next = value < min ? min : (value > max ? max : value);
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
    _saver.set('pricePerMin', _price);
    final ok = await _saver.flush(fields: const <String>['pricePerMin']);
    if (!mounted) return;
    setState(() => _busy = false);
    if (!ok) {
      OnboardingTelemetry.step(
        'price',
        'error',
        reason: _saver.saveProblem == null ? 'invalid_field' : 'save_failed',
      );
      return;
    }
    OnboardingTelemetry.step('price', 'ok');
    await ctx.next();
  }

  @override
  Widget build(BuildContext context) {
    final options = optionsOf(ref.watch(hostOptionsProvider));
    final min = options?.priceMin ?? 5;
    final max = options?.priceMax ?? 100;
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
      scene: HfClusterKind.wallet,
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
                      TextSpan(
                        text: rupeesText(price),
                        style: HfText.of(
                          context,
                          HfText.hero,
                        ).copyWith(fontSize: 36),
                      ),
                      TextSpan(
                        text: ' ${PartBCopy.perMin}',
                        style: HfText.of(context, HfText.bodyStrong),
                      ),
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
                    constraints: const BoxConstraints(
                      minWidth: 48,
                      minHeight: 48,
                    ),
                    key: const ValueKey<String>('price-minus'),
                    tooltip: PartBCopy.lowerPrice,
                    iconSize: 28,
                    onPressed: locked || price <= min
                        ? null
                        : () => _set(price - 1, min, max),
                    icon: const Icon(Icons.remove_rounded),
                  ),
                  Expanded(
                    child: Slider(
                      key: const ValueKey<String>('price-slider'),
                      value: price.toDouble(),
                      min: min.toDouble(),
                      max: max.toDouble(),
                      divisions: max - min,
                      semanticFormatterCallback: (value) =>
                          '${rupeesText(value.round())} per minute',
                      onChanged: locked
                          ? null
                          : (value) => _set(value.round(), min, max),
                    ),
                  ),
                  IconButton.filledTonal(
                    constraints: const BoxConstraints(
                      minWidth: 48,
                      minHeight: 48,
                    ),
                    key: const ValueKey<String>('price-plus'),
                    tooltip: PartBCopy.raisePrice,
                    iconSize: 28,
                    onPressed: locked || price >= max
                        ? null
                        : () => _set(price + 1, min, max),
                    icon: const Icon(Icons.add_rounded),
                  ),
                ],
              ),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(rupeesText(min), style: HfText.of(context, HfText.note)),
                  Text(rupeesText(max), style: HfText.of(context, HfText.note)),
                ],
              ),
              const SizedBox(height: 12),
              Text(
                PartBCopy.quickPicks,
                style: HfText.of(context, HfText.bodyStrong),
              ),
              const SizedBox(height: 4),
              Wrap(
                spacing: 8,
                runSpacing: 4,
                children: [
                  for (final value in kQuickPrices)
                    if (value >= min && value <= max)
                      HfChip(
                        key: ValueKey<String>('price-pick-$value'),
                        label: rupeesText(value),
                        selected: price == value,
                        onTap: locked ? null : () => _set(value, min, max),
                      ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        HfCard(
          color: HfColors.lavender,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _Line(
                PartBCopy.callerPays,
                '${rupeesText(price)}${PartBCopy.previewPerMin}',
              ),
              _Line(
                PartBCopy.youGet,
                '${rupeesFromPaise(mine)}${PartBCopy.previewPerMin}',
                strong: true,
                lineKey: 'price-you-get',
              ),
              _Line(PartBCopy.platformGets, rupeesFromPaise(platform)),
              const SizedBox(height: 8),
              Text(
                PartBCopy.priceExample(rupeesFromPaise(monthlyPaise)),
                style: HfText.of(context, HfText.note),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        Text(PartBCopy.priceChangeAnytime, style: HfText.of(context, HfText.note)),
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
    final style = strong
        ? HfText.of(context, HfText.bodyStrong)
        : HfText.of(context, HfText.body);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: style),
          const SizedBox(height: 4),
          Text(
            value,
            key: lineKey == null ? null : ValueKey<String>(lineKey!),
            style: style,
          ),
        ],
      ),
    );
  }
}

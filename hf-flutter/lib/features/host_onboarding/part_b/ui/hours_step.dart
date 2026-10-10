import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';
import '../../../kyc/kyc.dart';
import '../../flow/onboarding_context.dart';
import '../data/edit_lock.dart';
import '../data/part_b_rules.dart';
import '../data/part_b_telemetry.dart';
import '../data/profile_saver.dart';
import 'part_b_copy.dart';
import 'part_b_widgets.dart';

/// Step `hours`: the days and times a host is usually free (optional), and the comfort switches: health topics,
/// the private LGBTQ+ lane (and "show on my profile"), and the women-only lane (only when the verified ID shows
/// female). Everything saves by itself, debounced. A live host can still change days and times; the switches lock.
class HoursStep extends ConsumerStatefulWidget {
  const HoursStep({super.key, required this.ctx});

  final OnboardingStepContext ctx;

  @override
  ConsumerState<HoursStep> createState() => _HoursStepState();
}

class _HoursStepState extends ConsumerState<HoursStep> {
  late final ProfileSaver _saver;
  late Set<int> _days;
  late String _from;
  late String _to;
  late bool _health;
  late bool _lgbtq;
  late bool _lgbtqPublic;
  late bool _women;
  bool _busy = false;

  OnboardingStepContext get ctx => widget.ctx;

  bool _serverBool(String key) => ctx.state.host?[key] == true;

  @override
  void initState() {
    super.initState();
    _saver = ref.read(profileSaverProvider);
    final hours = ctx.state.hostMap('hours');
    final serverDays = <int>[
      if (hours['days'] is List)
        for (final d in hours['days'] as List)
          if (d is num && d >= 0 && d <= 6) d.toInt(),
    ]..sort();
    final serverFrom = validHhmm(hours['from'], '19:00');
    final serverTo = validHhmm(hours['to'], '22:00');
    if (serverDays.isNotEmpty) {
      _saver.seed('hours', <String, Object?>{'days': serverDays, 'from': serverFrom, 'to': serverTo});
    }
    for (final k in const <String>['healthConsent', 'lgbtqLane', 'lgbtqPublic', 'womenLane']) {
      _saver.seed(k, _serverBool(k));
    }
    final h = _saver.valueOf('hours', null);
    if (h is Map) {
      _days = <int>{for (final d in (h['days'] as List? ?? const <Object?>[])) if (d is int) d};
      _from = validHhmm(h['from'], serverFrom);
      _to = validHhmm(h['to'], serverTo);
    } else {
      _days = serverDays.toSet();
      _from = serverFrom;
      _to = serverTo;
    }
    _health = _saver.valueOf('healthConsent', _serverBool('healthConsent')) == true;
    _lgbtq = _saver.valueOf('lgbtqLane', _serverBool('lgbtqLane')) == true;
    _lgbtqPublic = _saver.valueOf('lgbtqPublic', _serverBool('lgbtqPublic')) == true;
    _women = _saver.valueOf('womenLane', _serverBool('womenLane')) == true;
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

  void _saveHours() {
    if (_days.isEmpty) return;
    final sorted = _days.toList()..sort();
    _saver.set('hours', <String, Object?>{'days': sorted, 'from': _from, 'to': _to});
  }

  void _toggleDay(int d) {
    setState(() {
      if (!_days.remove(d)) _days.add(d);
    });
    _saveHours();
  }

  Future<void> _pickTime({required bool from}) async {
    final cur = from ? _from : _to;
    final parts = cur.split(':');
    final initial = TimeOfDay(hour: int.tryParse(parts[0]) ?? 19, minute: int.tryParse(parts.length > 1 ? parts[1] : '0') ?? 0);
    final picked = await showTimePicker(context: context, initialTime: initial);
    if (picked == null || !mounted) return;
    setState(() {
      if (from) {
        _from = hhmm(picked.hour, picked.minute);
      } else {
        _to = hhmm(picked.hour, picked.minute);
      }
    });
    _saveHours();
  }

  void _setHealth(bool v) {
    setState(() => _health = v);
    _saver.set('healthConsent', v);
  }

  void _setLgbtq(bool v) {
    setState(() {
      _lgbtq = v;
      if (!v) _lgbtqPublic = false;
    });
    _saver.set('lgbtqLane', v);
    _saver.set('lgbtqPublic', _lgbtqPublic);
  }

  void _setLgbtqPublic(bool v) {
    setState(() => _lgbtqPublic = v);
    _saver.set('lgbtqPublic', v);
  }

  void _setWomen(bool v) {
    setState(() => _women = v);
    _saver.set('womenLane', v);
  }

  Future<void> _continue() async {
    if (_busy) return;
    final lock = EditLock.of(ctx.state.hostStatus);
    if (lock.priceHoursLocked) {
      await ctx.next();
      return;
    }
    setState(() => _busy = true);
    final ok = await _saver.flush(fields: const <String>['hours', 'healthConsent', 'lgbtqLane', 'lgbtqPublic', 'womenLane']);
    if (!mounted) return;
    setState(() => _busy = false);
    if (!ok) {
      OnboardingTelemetry.step('hours', 'error', reason: _saver.saveProblem == null ? 'invalid_field' : 'save_failed');
      return;
    }
    OnboardingTelemetry.step('hours', 'ok');
    await ctx.next();
  }

  Widget _switch(String key, bool value, String title, {String? body, String? error, required bool enabled, required ValueChanged<bool> onChanged}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: HfCard(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SwitchListTile(
              key: ValueKey<String>(key),
              value: value,
              onChanged: enabled ? onChanged : null,
              contentPadding: const EdgeInsets.symmetric(horizontal: 8),
              title: Text(title, style: HfText.bodyStrong),
              subtitle: body == null ? null : Text(body, style: HfText.note),
            ),
            if (error != null)
              Padding(padding: const EdgeInsets.fromLTRB(8, 0, 8, 8), child: InlineError(error)),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final lock = EditLock.of(ctx.state.hostStatus);
    final hoursLocked = lock.priceHoursLocked;
    final comfortLocked = lock.profileLocked;
    final banner = lock.banner(editableWhenLive: true);
    final problem = _saver.saveProblem;
    final isWoman = ctx.state.kyc.gender == 'F';
    return PartBStep(
      title: PartBCopy.hoursTitle,
      lead: PartBCopy.hoursLead,
      bottom: [
        if (problem != null) InlineError(problem),
        const SizedBox(height: 4),
        HfButton(
          key: const ValueKey<String>('hours-continue'),
          label: PartBCopy.continueLabel,
          loading: _busy,
          onPressed: _continue,
        ),
      ],
      children: [
        if (banner != null) LockBanner(banner),
        if (lock.live) const LockBanner(PartBCopy.comfortLockedLive),
        const GroupLegend(PartBCopy.daysLegend),
        Wrap(
          spacing: 8,
          runSpacing: 4,
          children: [
            for (var i = 0; i < kDayLabels.length; i++)
              HfChip(
                key: ValueKey<String>('hours-day-$i'),
                label: kDayLabels[i],
                selected: _days.contains(i),
                onTap: hoursLocked ? null : () => _toggleDay(i),
              ),
          ],
        ),
        if (_saver.errorOf('hours') != null) InlineError(_saver.errorOf('hours')!),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(child: _TimeBox(label: PartBCopy.fromLabel, value: _from, boxKey: 'hours-from', onTap: hoursLocked ? null : () => unawaited(_pickTime(from: true)))),
            const SizedBox(width: 12),
            Expanded(child: _TimeBox(label: PartBCopy.toLabel, value: _to, boxKey: 'hours-to', onTap: hoursLocked ? null : () => unawaited(_pickTime(from: false)))),
          ],
        ),
        const SizedBox(height: 16),
        const GroupLegend(PartBCopy.comfortTitle),
        _switch('hours-health', _health, PartBCopy.healthConsent,
            error: _saver.errorOf('healthConsent'), enabled: !comfortLocked, onChanged: _setHealth),
        _switch('hours-lgbtq', _lgbtq, PartBCopy.lgbtqTitle,
            body: PartBCopy.lgbtqBody, error: _saver.errorOf('lgbtqLane'), enabled: !comfortLocked, onChanged: _setLgbtq),
        if (_lgbtq)
          _switch('hours-lgbtq-public', _lgbtqPublic, PartBCopy.lgbtqPublic,
              error: _saver.errorOf('lgbtqPublic'), enabled: !comfortLocked, onChanged: _setLgbtqPublic),
        if (isWoman)
          _switch('hours-women', _women, PartBCopy.womenLane,
              error: _saver.errorOf('womenLane'), enabled: !comfortLocked, onChanged: _setWomen),
      ],
    );
  }
}

class _TimeBox extends StatelessWidget {
  const _TimeBox({required this.label, required this.value, required this.boxKey, required this.onTap});

  final String label;
  final String value;
  final String boxKey;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(HfRadius.control);
    return Semantics(
      button: true,
      enabled: onTap != null,
      label: '$label $value',
      excludeSemantics: true,
      child: InkWell(
        key: ValueKey<String>(boxKey),
        borderRadius: radius,
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 64),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          decoration: BoxDecoration(
            color: HfColors.white,
            borderRadius: radius,
            border: Border.all(color: HfColors.line, width: 1.5),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(label, style: HfText.label),
              Text(value, style: HfText.subtitle),
            ],
          ),
        ),
      ),
    );
  }
}

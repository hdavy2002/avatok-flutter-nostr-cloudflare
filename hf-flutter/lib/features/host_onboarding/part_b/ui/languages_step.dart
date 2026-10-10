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

/// Step `languages`: the languages the host speaks (1 to 6, from `GET /api/hf/options`) and a conversation style.
/// The first language also becomes `conversationLang` (the worker wants its code). Saves by itself, debounced.
class LanguagesStep extends ConsumerStatefulWidget {
  const LanguagesStep({super.key, required this.ctx});

  final OnboardingStepContext ctx;

  @override
  ConsumerState<LanguagesStep> createState() => _LanguagesStepState();
}

class _LanguagesStepState extends ConsumerState<LanguagesStep> {
  late final ProfileSaver _saver;
  late List<String> _languages;
  String? _style;
  bool _busy = false;

  OnboardingStepContext get ctx => widget.ctx;

  @override
  void initState() {
    super.initState();
    _saver = ref.read(profileSaverProvider);
    final s = ctx.state;
    _saver.seed('languages', s.hostStrings('languages'));
    _saver.seed('style', s.hostString('style'));
    final langs = _saver.valueOf('languages', s.hostStrings('languages'));
    _languages = langs is List ? langs.map((e) => '$e').toList() : <String>[];
    final st = _saver.valueOf('style', s.hostString('style'));
    _style = st is String && st.isNotEmpty ? st : null;
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

  void _toggle(String label, HostOptions options) {
    final next = List<String>.of(_languages);
    if (next.contains(label)) {
      next.remove(label);
    } else if (next.length < kMaxLanguages) {
      next.add(label);
    }
    setState(() => _languages = next);
    if (next.isEmpty) return;
    _saver.set('languages', next);
    final code = options.languageCode(next.first);
    if (code != null) _saver.set('conversationLang', code);
  }

  void _pickStyle(String slug) {
    setState(() => _style = slug);
    _saver.set('style', slug);
  }

  bool get _valid => _languages.isNotEmpty && _style != null;

  Future<void> _continue() async {
    if (_busy) return;
    if (EditLock.of(ctx.state.hostStatus).profileLocked) {
      await ctx.next();
      return;
    }
    if (!_valid) return;
    setState(() => _busy = true);
    final ok = await _saver.flush(fields: const <String>['languages', 'conversationLang', 'style']);
    if (!mounted) return;
    setState(() => _busy = false);
    if (!ok) {
      OnboardingTelemetry.step('languages', 'error', reason: _saver.saveProblem == null ? 'invalid_field' : 'save_failed');
      return;
    }
    OnboardingTelemetry.step('languages', 'ok');
    await ctx.next();
  }

  @override
  Widget build(BuildContext context) {
    final options = ref.watch(hostOptionsProvider);
    return AsyncValueView<HostOptions>(
      value: options,
      onRetry: () => ref.invalidate(hostOptionsProvider),
      data: _form,
    );
  }

  Widget _form(HostOptions o) {
    final lock = EditLock.of(ctx.state.hostStatus);
    final locked = lock.profileLocked;
    final banner = lock.banner();
    final full = _languages.length >= kMaxLanguages;
    final problem = _saver.saveProblem;
    final fieldError = _saver.errorOf('languages') ?? _saver.errorOf('style') ?? _saver.errorOf('conversationLang');
    return PartBStep(
      title: PartBCopy.languagesTitle,
      lead: PartBCopy.languagesLead,
      bottom: [
        if (problem != null) InlineError(problem),
        const SizedBox(height: 4),
        HfButton(
          key: const ValueKey<String>('languages-continue'),
          label: PartBCopy.continueLabel,
          loading: _busy,
          onPressed: (locked || _valid) ? _continue : null,
        ),
      ],
      children: [
        if (banner != null) LockBanner(banner),
        const GroupLegend(PartBCopy.languagesLegend),
        Wrap(
          spacing: 8,
          runSpacing: 4,
          children: [
            for (final l in o.languages)
              HfChip(
                key: ValueKey<String>('language-${l.code}'),
                label: l.label,
                selected: _languages.contains(l.label),
                onTap: locked || (full && !_languages.contains(l.label)) ? null : () => _toggle(l.label, o),
              ),
          ],
        ),
        if (full) const Padding(padding: EdgeInsets.only(top: 8), child: Text(PartBCopy.languagesMax, style: HfText.note)),
        const SizedBox(height: 12),
        const GroupLegend(PartBCopy.styleLegend),
        for (final s in kStyleChoices)
          ChoiceTile(
            key: ValueKey<String>('style-${s.slug}'),
            title: s.label,
            help: s.help,
            selected: _style == s.slug,
            onTap: locked ? null : () => _pickStyle(s.slug),
          ),
        if (fieldError != null) InlineError(fieldError),
      ],
    );
  }
}

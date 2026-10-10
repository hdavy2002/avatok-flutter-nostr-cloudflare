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

/// Step `topics`: 1 to 6 topics, grouped by mood. The list comes from `GET /api/hf/options`; the app keeps no copy.
/// Saves by itself, debounced. A topic is a full-width row (labels can be long), at least 56 dp high.
class TopicsStep extends ConsumerStatefulWidget {
  const TopicsStep({super.key, required this.ctx});

  final OnboardingStepContext ctx;

  @override
  ConsumerState<TopicsStep> createState() => _TopicsStepState();
}

class _TopicsStepState extends ConsumerState<TopicsStep> {
  late final ProfileSaver _saver;
  late List<String> _topics;
  bool _busy = false;

  OnboardingStepContext get ctx => widget.ctx;

  @override
  void initState() {
    super.initState();
    _saver = ref.read(profileSaverProvider);
    final s = ctx.state;
    _saver.seed('topics', s.hostStrings('topics'));
    final t = _saver.valueOf('topics', s.hostStrings('topics'));
    _topics = t is List ? t.map((e) => '$e').toList() : <String>[];
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

  void _toggle(String slug) {
    final next = List<String>.of(_topics);
    if (next.contains(slug)) {
      next.remove(slug);
    } else if (next.length < kMaxTopics) {
      next.add(slug);
    }
    setState(() => _topics = next);
    if (next.isNotEmpty) _saver.set('topics', next);
  }

  Future<void> _continue() async {
    if (_busy) return;
    if (EditLock.of(ctx.state.hostStatus).profileLocked) {
      await ctx.next();
      return;
    }
    if (_topics.isEmpty) return;
    setState(() => _busy = true);
    final ok = await _saver.flush(fields: const <String>['topics']);
    if (!mounted) return;
    setState(() => _busy = false);
    if (!ok) {
      OnboardingTelemetry.step('topics', 'error', reason: _saver.saveProblem == null ? 'invalid_field' : 'save_failed');
      return;
    }
    OnboardingTelemetry.step('topics', 'ok');
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
    final n = _topics.length;
    final full = n >= kMaxTopics;
    final problem = _saver.saveProblem;
    final fieldError = _saver.errorOf('topics');

    // Topics grouped by mood, in the worker's order. A topic whose group is unknown still shows, under "More".
    final known = <String>{for (final g in o.moodGroups) g.label};
    final groups = <MapEntry<String, List<HostTopic>>>[
      for (final g in o.moodGroups) MapEntry(g.label, [for (final t in o.topics) if (t.group == g.label) t]),
    ];
    final extra = [for (final t in o.topics) if (!known.contains(t.group)) t];
    if (extra.isNotEmpty) groups.add(MapEntry(PartBCopy.topicsMore, extra));

    return PartBStep(
      title: PartBCopy.topicsTitle,
      lead: PartBCopy.topicsLead,
      bottom: [
        Semantics(
          liveRegion: true,
          child: Text(
            '${PartBCopy.topicsCount(n)}${full ? PartBCopy.topicsFull : ''}',
            key: const ValueKey<String>('topics-count'),
            style: HfText.bodyStrong,
          ),
        ),
        if (fieldError != null) InlineError(fieldError),
        if (problem != null) InlineError(problem),
        const SizedBox(height: 8),
        HfButton(
          key: const ValueKey<String>('topics-continue'),
          label: PartBCopy.continueLabel,
          loading: _busy,
          onPressed: (locked || n >= 1) ? _continue : null,
        ),
      ],
      children: [
        if (banner != null) LockBanner(banner),
        for (final g in groups)
          if (g.value.isNotEmpty) ...[
            GroupLegend(g.key),
            for (final t in g.value)
              ChoiceTile(
                key: ValueKey<String>('topic-${t.slug}'),
                title: t.label,
                selected: _topics.contains(t.slug),
                onTap: locked || (full && !_topics.contains(t.slug)) ? null : () => _toggle(t.slug),
              ),
          ],
      ],
    );
  }
}

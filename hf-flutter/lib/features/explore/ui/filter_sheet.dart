import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../data/host_filters.dart';
import '../data/host_options.dart';
import 'explore_copy.dart';

/// The filter sheet (mockup `Explore`). Returns the chosen filters, or null when it is closed without
/// "Show N hosts". [countFor] asks how many hosts a set of filters would show (the live count on the button).
Future<HostFilters?> showFilterSheet(
  BuildContext context,
  HostFilters initial, {
  required bool standardPlan,
  Future<int?> Function(HostFilters filters)? countFor,
}) async {
  final draft = FilterDraft(initial, countFor, standardPlan: standardPlan);
  // The tab shell's floating nav sits above each tab's navigator and would cover the pinned button, so the
  // sheet opens on the root navigator (the root overlay's context finds it).
  final rootContext = Overlay.of(context, rootOverlay: true).context;
  try {
    return await showHfSheet<HostFilters>(
      rootContext,
      title: ExploreCopy.sheetTitle,
      onClear: draft.clear,
      initialSize: 0.82,
      builder: (_) => FilterSheet(draft: draft),
      footer: ListenableBuilder(
        listenable: draft,
        builder: (ctx, _) {
          final n = draft.count;
          return SizedBox(
            width: double.infinity,
            child: FilledButton(
              key: const ValueKey<String>('filter-show'),
              onPressed: () => Navigator.of(ctx).pop(draft.value),
              child: Text(
                n == null
                    ? ExploreCopy.showHostsUnknown
                    : ExploreCopy.showHosts(n),
                textAlign: TextAlign.center,
              ),
            ),
          );
        },
      ),
    );
  } finally {
    draft.close();
  }
}
/// The filters being edited in the sheet, and how many hosts they would show.
///
/// The count is asked for once at the start and again 300 ms after the last change, one request at a time
/// (an older answer never overwrites a newer one). A count that cannot be read just leaves "Show hosts".
class FilterDraft extends ChangeNotifier {
  FilterDraft(
    this.initial,
    this._countFor, {
    required this.standardPlan,
  }) : _value = standardPlan
           ? initial.copyWith(
               minPrice: null,
               maxPrice: null,
               sort: HostSort.onlineFirst,
             )
           : initial {
    unawaited(_fetch());
  }

  final HostFilters initial;
  final Future<int?> Function(HostFilters)? _countFor;
  final bool standardPlan;

  HostFilters _value;
  int? _count;
  Timer? _timer;
  int _gen = 0;
  bool _closed = false;

  HostFilters get value => _value;
  int? get count => _count;

  void update(HostFilters next) {
    _value = next;
    notifyListeners();
    _timer?.cancel();
    _timer = Timer(
      const Duration(milliseconds: 300),
      () => unawaited(_fetch()),
    );
  }

  /// "Clear all": every filter off; the lane stays (it has its own switch on Discover).
  void clear() => update(HostFilters.none.copyWith(lane: initial.lane));

  Future<void> _fetch() async {
    final ask = _countFor;
    if (ask == null || _closed) return;
    final gen = ++_gen;
    final n = await ask(_value);
    if (_closed || gen != _gen) return;
    _count = n;
    notifyListeners();
  }

  /// The sheet is gone: no more timers or answers. (Not `dispose`: the sheet is still animating out.)
  void close() {
    _closed = true;
    _timer?.cancel();
  }
}

/// The scrolling content of the sheet. Legacy host pricing also shows price and sort controls.
/// `GET /api/hf/options`; nothing is typed in here.
class FilterSheet extends ConsumerStatefulWidget {
  const FilterSheet({super.key, required this.draft});

  final FilterDraft draft;

  @override
  ConsumerState<FilterSheet> createState() => _FilterSheetState();
}

class _FilterSheetState extends ConsumerState<FilterSheet> {
  static const int _collapsedTopics = 6;
  bool _allTopics = false;

  FilterDraft get _draft => widget.draft;

  void _toggle(
    List<String> list,
    String v,
    HostFilters Function(List<String>) set,
  ) {
    HapticFeedback.selectionClick();
    final next = list.contains(v)
        ? [
            for (final x in list)
              if (x != v) x,
          ]
        : [...list, v];
    _draft.update(set(next));
  }

  @override
  Widget build(BuildContext context) {
    final options = ref.watch(hostOptionsProvider);
    return options.when(
      loading: () => const LoadingPanel(),
      error: (e, _) => ErrorPanel(
        message: ExploreCopy.optionsFailed,
        onRetry: () => ref.invalidate(hostOptionsProvider),
      ),
      data: (o) => ListenableBuilder(
        listenable: _draft,
        builder: (context, _) => _content(context, o),
      ),
    );
  }

  Widget _heading(BuildContext context, String text) =>
      Text(text, style: HfText.of(context, HfText.subsection));

  Widget _content(BuildContext context, HostOptions o) {
    final d = _draft.value;
    const gap = SizedBox(height: HfSpacing.md);
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(
        HfSpacing.pageWide,
        6,
        HfSpacing.pageWide,
        20,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (o.topics.isNotEmpty) ...[
            _heading(context, ExploreCopy.feeling),
            gap,
            _moods(o, d),
            const SizedBox(height: HfSpacing.section - 4),
          ],
          if (o.languages.isNotEmpty) ...[
            _heading(context, ExploreCopy.language),
            gap,
            _languages(o, d),
            const SizedBox(height: HfSpacing.section - 4),
          ],
          if (!_draft.standardPlan) ...[
            _sort(context, d),
            const SizedBox(height: HfSpacing.section - 4),
            _price(context, o, d),
            const SizedBox(height: HfSpacing.section - 4),
          ],
          _OnlineRow(
            value: d.online,
            onChanged: (v) {
              HapticFeedback.selectionClick();
              _draft.update(d.copyWith(online: v));
            },
          ),
        ],
      ),
    );
  }

  Widget _moods(HostOptions o, HostFilters d) {
    final shown = <HostTopic>[];
    for (var i = 0; i < o.topics.length; i++) {
      final t = o.topics[i];
      if (_allTopics || i < _collapsedTopics || d.topics.contains(t.slug)) {
        shown.add(t);
      }
    }
    final hidden = o.topics.length - shown.length;
    return Wrap(
      spacing: HfSpacing.sm,
      children: [
        for (final t in shown)
          if (d.topics.contains(t.slug))
            HfChip.selected(
              key: ValueKey<String>('topic-${t.slug}'),
              label: t.label,
              tint: HfTint.sky,
              onTap: () =>
                  _toggle(d.topics, t.slug, (l) => d.copyWith(topics: l)),
            )
          else
            HfChip.outline(
              key: ValueKey<String>('topic-${t.slug}'),
              label: t.label,
              onTap: () =>
                  _toggle(d.topics, t.slug, (l) => d.copyWith(topics: l)),
            ),
        if (hidden > 0)
          _SoftChip(
            key: const ValueKey<String>('topics-more'),
            label: ExploreCopy.moreTopics(hidden),
            onTap: () => setState(() => _allTopics = true),
          )
        else if (_allTopics && o.topics.length > _collapsedTopics)
          _SoftChip(
            key: const ValueKey<String>('topics-fewer'),
            label: ExploreCopy.fewerTopics,
            onTap: () => setState(() => _allTopics = false),
          ),
      ],
    );
  }

  Widget _languages(HostOptions o, HostFilters d) {
    return Wrap(
      spacing: HfSpacing.sm,
      children: [
        for (final l in o.languages)
          if (d.languages.contains(l.code))
            MergeSemantics(
              child: Semantics(
                selected: true,
                child: HfChip.filled(
                  key: ValueKey<String>('lang-${l.code}'),
                  label: l.label,
                  tint: HfTint.peach,
                  onTap: () => _toggle(
                    d.languages,
                    l.code,
                    (v) => d.copyWith(languages: v),
                  ),
                ),
              ),
            )
          else
            HfChip.outline(
              key: ValueKey<String>('lang-${l.code}'),
              label: l.label,
              onTap: () =>
                  _toggle(d.languages, l.code, (v) => d.copyWith(languages: v)),
            ),
      ],
    );
  }

  Widget _sort(BuildContext context, HostFilters d) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      _heading(context, ExploreCopy.sort),
      const SizedBox(height: HfSpacing.sm),
      Wrap(
        spacing: HfSpacing.sm,
        runSpacing: HfSpacing.sm,
        children: [
          for (final sort in HostSort.values)
            HfChip(
              key: ValueKey<String>('filter-sort-${sort.wire}'),
              label: sort.label,
              selected: d.sort == sort,
              onTap: () => _draft.update(d.copyWith(sort: sort)),
            ),
        ],
      ),
    ],
  );

  Widget _price(BuildContext context, HostOptions o, HostFilters d) {
    final dark = HfBrightness.isDark(context);
    final accent = dark ? HfColors.lavenderLight : HfColors.link;
    final cap = (d.maxPrice ?? o.priceMax)
        .clamp(o.priceMin, o.priceMax)
        .toInt();
    final atMax = cap >= o.priceMax;
    final range = o.priceMax - o.priceMin;
    final muted = dark ? HfColors.mutedSoft : HfColors.muted;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            Expanded(child: _heading(context, ExploreCopy.price)),
            Text(
              atMax ? ExploreCopy.anyPrice : ExploreCopy.upTo(cap),
              style: HfText.buttonSmall.copyWith(
                color: HfTint.lavender.valueInk(context),
              ),
            ),
          ],
        ),
        const SizedBox(height: HfSpacing.sm),
        SliderTheme(
          data: SliderTheme.of(context).copyWith(
            trackHeight: 6,
            activeTrackColor: accent,
            inactiveTrackColor: dark
                ? HfColors.darkTile
                : HfColors.segmentTrack,
            overlayColor: Colors.transparent,
            thumbShape: _FilterThumb(accent),
            trackShape: const RoundedRectSliderTrackShape(),
            tickMarkShape: SliderTickMarkShape.noTickMark,
          ),
          child: Slider(
            key: const ValueKey<String>('filter-price'),
            min: o.priceMin.toDouble(),
            max: o.priceMax.toDouble(),
            divisions: range > 0 && range <= 100 ? range : null,
            value: cap.toDouble(),
            semanticFormatterCallback: (v) => v.round() >= o.priceMax
                ? ExploreCopy.anyPrice
                : ExploreCopy.upTo(v.round()),
            onChanged: (v) {
              final n = v.round();
              _draft.update(
                d.copyWith(
                  maxPrice: n >= o.priceMax ? null : n,
                  minPrice: (d.minPrice != null && d.minPrice! > n)
                      ? null
                      : d.minPrice,
                ),
              );
            },
          ),
        ),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              '₹${o.priceMin}',
              style: HfText.label.copyWith(
                color: muted,
                fontWeight: FontWeight.w400,
              ),
            ),
            Text(
              '₹${o.priceMax}+',
              style: HfText.label.copyWith(
                color: muted,
                fontWeight: FontWeight.w400,
              ),
            ),
          ],
        ),
      ],
    );
  }
}

/// The "+12 more" / "Show fewer" chip: soft fill, link-coloured text.
class _SoftChip extends StatelessWidget {
  const _SoftChip({super.key, required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    return Semantics(
      button: true,
      label: label,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: HfSpacing.tap),
          child: Center(
            widthFactor: 1,
            child: Container(
              height: 40,
              padding: const EdgeInsets.symmetric(horizontal: 14),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: dark ? HfColors.darkBar : HfColors.surfaceSoft,
                borderRadius: BorderRadius.circular(HfRadius.control),
              ),
              child: Text(
                label,
                style: HfText.badge.copyWith(
                  color: dark ? HfColors.lavenderLight : HfColors.link,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The blush "Online now only" row with its rose switch (52 x 32, white knob).
class _OnlineRow extends StatelessWidget {
  const _OnlineRow({required this.value, required this.onChanged});

  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    const tint = HfTint.blush;
    return Semantics(
      toggled: value,
      button: true,
      label: '${ExploreCopy.onlineOnly}. ${ExploreCopy.onlineOnlyBody}',
      excludeSemantics: true,
      child: GestureDetector(
        key: const ValueKey<String>('filter-online'),
        behavior: HitTestBehavior.opaque,
        onTap: () => onChanged(!value),
        child: Container(
          constraints: const BoxConstraints(minHeight: HfSpacing.tap),
          padding: const EdgeInsets.symmetric(
            horizontal: HfSpacing.page,
            vertical: HfSpacing.xl,
          ),
          decoration: BoxDecoration(
            color: tint.bg(context),
            borderRadius: BorderRadius.circular(HfRadius.control),
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      ExploreCopy.onlineOnly,
                      style: HfText.buttonSmall.copyWith(
                        color: dark ? tint.ink(context) : HfColors.blushInk,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      ExploreCopy.onlineOnlyBody,
                      style: HfText.label.copyWith(
                        color: dark ? tint.ink(context) : HfColors.blushInk,
                        fontWeight: FontWeight.w400,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: HfSpacing.lg),
              AnimatedContainer(
                duration: HfMotion.of(context, HfMotion.fast),
                curve: HfMotion.curve,
                width: 52,
                height: 32,
                padding: const EdgeInsets.all(3),
                alignment: value ? Alignment.centerRight : Alignment.centerLeft,
                decoration: BoxDecoration(
                  color: value
                      ? HfColors.rose
                      : (dark ? HfColors.darkLine : HfColors.handle),
                  borderRadius: BorderRadius.circular(16),
                ),
                child: Container(
                  width: 26,
                  height: 26,
                  decoration: const BoxDecoration(
                    color: HfColors.white,
                    shape: BoxShape.circle,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _FilterThumb extends SliderComponentShape {
  const _FilterThumb(this.ring);

  final Color ring;

  @override
  Size getPreferredSize(bool isEnabled, bool isDiscrete) =>
      const Size.square(28);

  @override
  void paint(
    PaintingContext context,
    Offset center, {
    required Animation<double> activationAnimation,
    required Animation<double> enableAnimation,
    required bool isDiscrete,
    required TextPainter labelPainter,
    required RenderBox parentBox,
    required SliderThemeData sliderTheme,
    required TextDirection textDirection,
    required double value,
    required double textScaleFactor,
    required Size sizeWithOverflow,
  }) {
    final canvas = context.canvas;
    canvas.drawShadow(
      Path()
        ..addOval(Rect.fromCircle(center: center.translate(0, 2), radius: 14)),
      HfColors.ink.withValues(alpha: 0.5),
      4,
      false,
    );
    canvas.drawCircle(center, 14, Paint()..color = HfColors.white);
    canvas.drawCircle(
      center,
      12.5,
      Paint()
        ..color = ring
        ..style = PaintingStyle.stroke
        ..strokeWidth = 3,
    );
  }
}

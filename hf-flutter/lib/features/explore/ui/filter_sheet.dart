import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../data/host_filters.dart';
import '../data/host_options.dart';
import '../widgets/option_chip.dart';
import 'explore_copy.dart';

/// The filter sheet. Returns the chosen filters, or null when it is closed without "Show results".
Future<HostFilters?> showFilterSheet(BuildContext context, HostFilters initial) {
  return showModalBottomSheet<HostFilters>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: HfColors.cream,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(HfRadius.pill)),
    ),
    builder: (_) => FilterSheet(initial: initial),
  );
}

/// Mood/topic (many), language (many), a price range inside the server's bounds, "Online now only" and
/// the sort order. The choices come from `GET /api/hf/options`; nothing is typed in here.
class FilterSheet extends ConsumerStatefulWidget {
  const FilterSheet({super.key, required this.initial});

  final HostFilters initial;

  @override
  ConsumerState<FilterSheet> createState() => _FilterSheetState();
}

class _FilterSheetState extends ConsumerState<FilterSheet> {
  late HostFilters _draft = widget.initial;

  void _toggle(List<String> list, String v, HostFilters Function(List<String>) set) {
    final next = list.contains(v) ? [...list]..remove(v) : [...list, v];
    setState(() => _draft = set(next));
  }

  @override
  Widget build(BuildContext context) {
    final options = ref.watch(hostOptionsProvider);
    return FractionallySizedBox(
      heightFactor: 0.92,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(HfSpacing.page, 16, 8, 0),
            child: Row(
              children: [
                const Expanded(child: Text(ExploreCopy.filters, style: HfText.title)),
                IconButton(
                  tooltip: 'Close',
                  icon: const Icon(Icons.close_rounded),
                  onPressed: () => Navigator.of(context).pop(),
                ),
              ],
            ),
          ),
          Expanded(
            child: options.when(
              loading: () => const LoadingPanel(),
              error: (e, _) => ErrorPanel(
                message: ExploreCopy.optionsFailed,
                onRetry: () => ref.invalidate(hostOptionsProvider),
              ),
              data: _content,
            ),
          ),
          _footer(context),
        ],
      ),
    );
  }

  Widget _content(HostOptions o) {
    final lo = (_draft.minPrice ?? o.priceMin).clamp(o.priceMin, o.priceMax).toInt();
    final hi = (_draft.maxPrice ?? o.priceMax).clamp(lo, o.priceMax).toInt();
    final range = o.priceMax - o.priceMin;
    final anyPrice = lo == o.priceMin && hi == o.priceMax;
    return ListView(
      padding: const EdgeInsets.fromLTRB(HfSpacing.page, 8, HfSpacing.page, 16),
      children: [
        const _SectionTitle(ExploreCopy.sort),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final s in HostSort.values)
              OptionChip(
                label: s.label,
                selected: _draft.sort == s,
                onTap: () => setState(() => _draft = _draft.copyWith(sort: s)),
              ),
          ],
        ),
        const SizedBox(height: 8),
        SwitchListTile(
          key: const ValueKey<String>('filter-online'),
          contentPadding: EdgeInsets.zero,
          title: const Text(ExploreCopy.onlineOnly, style: HfText.bodyStrong),
          value: _draft.online,
          activeTrackColor: HfColors.rose,
          activeThumbColor: HfColors.white,
          onChanged: (v) => setState(() => _draft = _draft.copyWith(online: v)),
        ),
        const _SectionTitle(ExploreCopy.price),
        Text(anyPrice ? ExploreCopy.anyPrice : ExploreCopy.priceRange(lo, hi), style: HfText.bodyText),
        SliderTheme(
          data: SliderTheme.of(context).copyWith(
            activeTrackColor: HfColors.rose,
            inactiveTrackColor: HfColors.blush,
            thumbColor: HfColors.rose,
            overlayColor: const Color(0x22B2367E),
            rangeThumbShape: const RoundRangeSliderThumbShape(enabledThumbRadius: 12),
            trackHeight: 6,
          ),
          child: RangeSlider(
            key: const ValueKey<String>('filter-price'),
            min: o.priceMin.toDouble(),
            max: o.priceMax.toDouble(),
            divisions: range > 0 && range <= 100 ? range : null,
            values: RangeValues(lo.toDouble(), hi.toDouble()),
            labels: RangeLabels('₹$lo', '₹$hi'),
            onChanged: (v) {
              final a = v.start.round();
              final b = v.end.round();
              setState(() => _draft = _draft.copyWith(
                    minPrice: a > o.priceMin ? a : null,
                    maxPrice: b < o.priceMax ? b : null,
                  ));
            },
          ),
        ),
        if (o.moodGroups.isNotEmpty) const _SectionTitle(ExploreCopy.mood),
        for (final g in o.moodGroups) ...[
          Padding(
            padding: const EdgeInsets.only(bottom: 8, top: 4),
            child: Text(g.label, style: HfText.bodyStrong.copyWith(color: HfColors.orchid)),
          ),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final t in o.topics.where((t) => t.group == g.label))
                OptionChip(
                  label: t.label,
                  selected: _draft.topics.contains(t.slug),
                  onTap: () => _toggle(_draft.topics, t.slug, (l) => _draft.copyWith(topics: l)),
                ),
            ],
          ),
          const SizedBox(height: 8),
        ],
        if (o.languages.isNotEmpty) const _SectionTitle(ExploreCopy.language),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final l in o.languages)
              OptionChip(
                label: l.label,
                selected: _draft.languages.contains(l.code),
                onTap: () => _toggle(_draft.languages, l.code, (v) => _draft.copyWith(languages: v)),
              ),
          ],
        ),
      ],
    );
  }

  Widget _footer(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(HfSpacing.page, 12, HfSpacing.page, 12),
      decoration: const BoxDecoration(
        color: HfColors.white,
        border: Border(top: BorderSide(color: HfColors.line)),
      ),
      child: Row(
        children: [
          Expanded(
            child: HfButton(
              label: ExploreCopy.clearAll,
              kind: HfButtonKind.secondary,
              onPressed: () => setState(() => _draft = HostFilters.none.copyWith(lane: widget.initial.lane)),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            flex: 2,
            child: HfButton(
              label: ExploreCopy.showResults,
              onPressed: () => Navigator.of(context).pop(_draft),
            ),
          ),
        ],
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);
  final String text;

  @override
  Widget build(BuildContext context) =>
      Padding(padding: const EdgeInsets.only(top: 16, bottom: 8), child: Text(text, style: HfText.subtitle));
}

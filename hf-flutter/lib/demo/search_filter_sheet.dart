import 'package:flutter/material.dart';

import '../data/models/search_filters.dart';
import 'theme.dart';

/// [HF-SEARCH-FILTERS-1] The Search filter bar and sheet. Same filters, same wording and same order as the web Explore chip row:
/// Category (sensitive four last), Language, Availability, Price per minute, Verified on, Women-only and Sort. No gender filter.

/// A chunky pill that is either on (indigo) or off (white), like the other Search pills.
class FilterPill extends StatelessWidget {
  const FilterPill({super.key, required this.label, required this.selected, required this.onTap, this.onClear});

  final String label;
  final bool selected;
  final VoidCallback onTap;

  /// When set, a small cross is drawn and tapping it clears the pill.
  final VoidCallback? onClear;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
          decoration: BoxDecoration(
            color: selected ? C.maroon : C.white,
            borderRadius: BorderRadius.circular(999),
            border: Border.all(color: selected ? C.maroon : C.line, width: 1.5),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Text(label, style: t(15, color: selected ? C.white : C.maroon, w: FontWeight.w800)),
            if (onClear != null) ...[
              const SizedBox(width: 6),
              GestureDetector(onTap: onClear, child: Icon(Icons.close_rounded, size: 18, color: selected ? C.white : C.maroon, semanticLabel: 'Remove $label')),
            ],
          ]),
        ),
      ),
    );
  }
}

/// "Filters (n)" button, a Women-only quick pill and the filters that are on, each removable. Scrolls sideways.
class SearchFilterBar extends StatelessWidget {
  const SearchFilterBar({
    super.key,
    required this.filters,
    required this.categories,
    required this.languages,
    required this.onOpen,
    required this.onChanged,
  });

  final SearchFilters filters;
  final List<FilterOption> categories;
  final List<FilterOption> languages;
  final VoidCallback onOpen;
  final ValueChanged<SearchFilters> onChanged;

  static String _labelOf(List<FilterOption> all, String id) {
    for (final o in all) {
      if (o.id == id) return o.label;
    }
    return id;
  }

  @override
  Widget build(BuildContext context) {
    final f = filters;
    final chips = <Widget>[
      for (final id in (f.categories.toList()..sort()))
        FilterPill(key: ValueKey('chip-category-$id'), label: _labelOf(categories, id), selected: true, onTap: onOpen, onClear: () => onChanged(f.copyWith(categories: {...f.categories}..remove(id)))),
      for (final id in (f.langs.toList()..sort()))
        FilterPill(key: ValueKey('chip-lang-$id'), label: _labelOf(languages, id), selected: true, onTap: onOpen, onClear: () => onChanged(f.copyWith(langs: {...f.langs}..remove(id)))),
      if (f.avail.isNotEmpty)
        FilterPill(key: const ValueKey('chip-avail'), label: kAvailOptions.firstWhere((o) => o.$1 == f.avail, orElse: () => kAvailOptions.first).$2, selected: true, onTap: onOpen, onClear: () => onChanged(f.copyWith(avail: ''))),
      if (f.price != null) FilterPill(key: const ValueKey('chip-price'), label: '${f.price!.label}/min', selected: true, onTap: onOpen, onClear: () => onChanged(f.copyWith(clearPrice: true))),
      for (final v in (f.verified.toList()..sort()))
        FilterPill(key: ValueKey('chip-verified-$v'), label: 'Verified on ${kVerifiedOptions.firstWhere((o) => o.$1 == v, orElse: () => (v, v)).$2}', selected: true, onTap: onOpen, onClear: () => onChanged(f.copyWith(verified: {...f.verified}..remove(v)))),
      if (f.sort != 'recommended')
        FilterPill(key: const ValueKey('chip-sort'), label: kSortOptions.firstWhere((o) => o.$1 == f.sort, orElse: () => kSortOptions.first).$2, selected: true, onTap: onOpen, onClear: () => onChanged(f.copyWith(sort: 'recommended'))),
    ];
    return SizedBox(
      height: 48,
      child: ListView(
        key: const ValueKey('filter-bar'),
        scrollDirection: Axis.horizontal,
        children: [
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: FilterPill(key: const ValueKey('filters-open'), label: f.activeCount == 0 ? 'Filters' : 'Filters (${f.activeCount})', selected: false, onTap: onOpen),
          ),
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: FilterPill(key: const ValueKey('filter-women'), label: 'Women-only', selected: f.women, onTap: () => onChanged(f.copyWith(women: !f.women))),
          ),
          for (final c in chips) Padding(padding: const EdgeInsets.only(right: 8), child: c),
        ],
      ),
    );
  }
}

/// Opens the filter sheet. Returns the new filters when "Show results" is tapped, null when it is dismissed.
Future<SearchFilters?> showSearchFilterSheet(
  BuildContext context, {
  required SearchFilters current,
  required List<FilterOption> categories,
  required List<FilterOption> languages,
}) {
  return showModalBottomSheet<SearchFilters>(
    context: context,
    isScrollControlled: true,
    backgroundColor: C.white,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
    builder: (_) => _FilterSheet(current: current, categories: categories, languages: languages),
  );
}

class _FilterSheet extends StatefulWidget {
  const _FilterSheet({required this.current, required this.categories, required this.languages});

  final SearchFilters current;
  final List<FilterOption> categories;
  final List<FilterOption> languages;

  @override
  State<_FilterSheet> createState() => _FilterSheetState();
}

class _FilterSheetState extends State<_FilterSheet> {
  late SearchFilters _f = widget.current;

  Set<String> _toggle(Set<String> s, String id) => s.contains(id) ? ({...s}..remove(id)) : {...s, id};

  Widget _section(String title, Widget child) => Padding(
        padding: const EdgeInsets.only(bottom: 18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: t(16, w: FontWeight.w900)),
          const SizedBox(height: 10),
          child,
        ]),
      );

  Widget _wrap(List<Widget> kids) => Wrap(spacing: 8, runSpacing: 8, children: kids);

  @override
  Widget build(BuildContext context) {
    final cats = [...widget.categories.where((c) => !c.sensitive), ...widget.categories.where((c) => c.sensitive)]; // sensitive four last
    final langs = widget.languages.isEmpty ? kFallbackLanguages : widget.languages;
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.9),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 12, 4),
            child: Row(children: [
              Expanded(child: Text('Filters', style: t(20, w: FontWeight.w900))),
              TextButton(
                key: const ValueKey('filters-reset'),
                onPressed: () => setState(() => _f = const SearchFilters()),
                child: Text('Reset', style: t(15, color: C.rani, w: FontWeight.w800)),
              ),
              IconButton(tooltip: 'Close', onPressed: () => Navigator.of(context).pop(), icon: const Icon(Icons.close_rounded)),
            ]),
          ),
          Flexible(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
              children: [
                if (cats.isNotEmpty)
                  _section('Category', _wrap([
                    for (final c in cats)
                      FilterPill(key: ValueKey('f-category-${c.id}'), label: c.label, selected: _f.categories.contains(c.id), onTap: () => setState(() => _f = _f.copyWith(categories: _toggle(_f.categories, c.id)))),
                  ])),
                _section('Language', _wrap([
                  for (final l in langs) FilterPill(key: ValueKey('f-lang-${l.id}'), label: l.label, selected: _f.langs.contains(l.id), onTap: () => setState(() => _f = _f.copyWith(langs: _toggle(_f.langs, l.id)))),
                ])),
                _section('Availability', _wrap([
                  for (final o in kAvailOptions) FilterPill(key: ValueKey('f-avail-${o.$1.isEmpty ? 'any' : o.$1}'), label: o.$2, selected: _f.avail == o.$1, onTap: () => setState(() => _f = _f.copyWith(avail: o.$1))),
                ])),
                _section('Price per minute', _wrap([
                  for (final r in kPriceRanges)
                    FilterPill(key: ValueKey('f-price-${r.min ?? 0}-${r.max ?? 'up'}'), label: r.label, selected: _f.price == r, onTap: () => setState(() => _f = _f.price == r ? _f.copyWith(clearPrice: true) : _f.copyWith(price: r))),
                ])),
                _section('Verified on', _wrap([
                  for (final o in kVerifiedOptions) FilterPill(key: ValueKey('f-verified-${o.$1}'), label: o.$2, selected: _f.verified.contains(o.$1), onTap: () => setState(() => _f = _f.copyWith(verified: _toggle(_f.verified, o.$1)))),
                ])),
                _section('Channel type', _wrap([
                  FilterPill(key: const ValueKey('f-women'), label: 'Women-only', selected: _f.women, onTap: () => setState(() => _f = _f.copyWith(women: !_f.women))),
                ])),
                _section('Sort', _wrap([
                  for (final o in kSortOptions) FilterPill(key: ValueKey('f-sort-${o.$1}'), label: o.$2, selected: _f.sort == o.$1, onTap: () => setState(() => _f = _f.copyWith(sort: o.$1))),
                ])),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
            child: SizedBox(
              width: double.infinity,
              child: FilledButton(
                key: const ValueKey('filters-apply'),
                style: FilledButton.styleFrom(backgroundColor: C.maroon, padding: const EdgeInsets.symmetric(vertical: 16), shape: const StadiumBorder()),
                onPressed: () => Navigator.of(context).pop(_f),
                child: Text('Show results', style: t(16, color: C.white, w: FontWeight.w800)),
              ),
            ),
          ),
        ]),
      ),
    );
  }
}

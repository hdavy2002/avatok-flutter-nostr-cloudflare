import 'package:flutter/material.dart';
import '../../../core/brand.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../data/host_filters.dart';
import '../data/host_options.dart';
import '../widgets/option_chip.dart';

/// The marketplace starts with useful discovery controls, not a marketing page.
class DiscoveryHeader extends StatelessWidget {
  const DiscoveryHeader({super.key, required this.filters, required this.options,
    required this.onFilters, required this.onApply, required this.onSearch, required this.search});
  final HostFilters filters;
  final HostOptions? options;
  final VoidCallback onFilters;
  final ValueChanged<HostFilters> onApply;
  final ValueChanged<String> onSearch;
  final TextEditingController search;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(HfSpacing.page, 12, HfSpacing.page, 4),
    child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const Text(Brand.name, style: HfText.title),
      const SizedBox(height: 12),
      const Text('Who feels like your kind of company?', style: HfText.hero),
      const SizedBox(height: 18),
      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(child: DecoratedBox(
          decoration: BoxDecoration(color: HfColors.white,
            borderRadius: BorderRadius.circular(HfRadius.pill), boxShadow: HfShadows.card),
          child: TextField(controller: search, onChanged: onSearch,
            textInputAction: TextInputAction.search,
            decoration: InputDecoration(
              hintText: 'Search hosts shown below',
              prefixIcon: const Icon(Icons.search_rounded),
              suffixIcon: search.text.isEmpty ? null : IconButton(
                tooltip: 'Clear search', onPressed: () { search.clear(); onSearch(''); },
                icon: const Icon(Icons.close_rounded)),
            )),
        )),
        const SizedBox(width: 8),
        DecoratedBox(decoration: const BoxDecoration(color: HfColors.white,
          shape: BoxShape.circle, boxShadow: HfShadows.card),
          child: IconButton(key: const ValueKey<String>('open-filters'),
            tooltip: 'Filters', onPressed: onFilters,
            padding: const EdgeInsets.all(16),
            icon: Badge(isLabelVisible: filters.activeCount>0,
              backgroundColor: HfColors.ink,
              label: Text('${filters.activeCount}', style: HfText.badge.copyWith(color: HfColors.white)), child: const Icon(Icons.tune_rounded)))),
      ]),
      const SizedBox(height: 12),
      Wrap(spacing: 8, runSpacing: 8, children: [
        OptionChip(label: 'Everyone', selected: filters.lane==null,
          onTap: () => onApply(filters.copyWith(lane: null))),
        OptionChip(label: 'Women-only', selected: filters.lane==HostLane.women,
          onTap: () => onApply(filters.copyWith(lane: HostLane.women))),
        OptionChip(label: 'LGBTQ+', selected: filters.lane==HostLane.lgbtq,
          onTap: () => onApply(filters.copyWith(lane: HostLane.lgbtq))),
      ]),
      const SizedBox(height: 14),
      if (filters.lane==null) _moods(context)
      else HfCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        HfScene(kind: filters.lane==HostLane.women ? HfSceneKind.women : HfSceneKind.lgbtq, height: 110),
        Text(filters.lane==HostLane.women ? 'A space for women' : 'A space to be yourself', style: HfText.title),
        const SizedBox(height: 6),
        Text(filters.lane==HostLane.women
          ? 'Private conversations with women. Entry follows our identity verification rules.'
          : 'A private LGBTQ+ space. Join by choice, with identity and video verification.',
          style: HfText.bodyText),
      ])),
      const SizedBox(height: 14),
      Wrap(spacing: 8, runSpacing: 8, children: [
        _filter('Language', Icons.language_rounded, onFilters),
        _filter(filters.maxPrice==null ? 'Price' : 'Up to ₹${filters.maxPrice}/min',
          Icons.sell_outlined, onFilters),
        OptionChip(label: 'Online now', selected: filters.online,
          onTap: () => onApply(filters.copyWith(online: !filters.online))),
      ]),
      if (options!=null) ...[
        const SizedBox(height: 10),
        Text('Host rates ₹${options!.priceMin}–₹${options!.priceMax}/min',
          style: HfText.note),
      ],
      const SizedBox(height: 12),
    ]),
  );

  Widget _filter(String label, IconData icon, VoidCallback onTap) => HfButton(
    label: label, icon: icon, kind: HfButtonKind.secondary, expand: false, onPressed: onTap);

  Widget _moods(BuildContext context) {
    final groups=options?.moodGroups.take(3).toList() ?? <MoodGroup>[];
    if(groups.isEmpty) return const HfScene(kind: HfSceneKind.discover, height: 150);
    const colors=[HfColors.mint,HfColors.sky,HfColors.lavender];
    const kinds=[HfSceneKind.discover,HfSceneKind.call,HfSceneKind.welcome];
    Widget tile(int i) => HfCard(key: ValueKey<String>('mood-${groups[i].slug}'), color: colors[i], padding: const EdgeInsets.all(14),
      onTap: () => onApply(filters.copyWith(topics: options!.topicsOfGroup(groups[i]))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(groups[i].label, style: HfText.subtitle),
        HfScene(kind:kinds[i],height:groups.length==2 ? 66 : i==0 ? 180 : 52),
        const Row(children: [Expanded(child: Text('Find company', style: HfText.badge)),
          Icon(Icons.arrow_forward_rounded, size:20)]),
      ]));
    return LayoutBuilder(builder: (context,c) {
      final largeType=MediaQuery.textScalerOf(context).scale(16)>22;
      if(c.maxWidth<280 || largeType || groups.length==1) {
        return Column(children: [for(var i=0;i<groups.length;i++) ...[
          tile(i), if(i<groups.length-1) const SizedBox(height:10)]]);
      }
      if (groups.length==2) return Row(crossAxisAlignment: CrossAxisAlignment.start,
        children: [Expanded(child:tile(0)),const SizedBox(width:10),Expanded(child:tile(1))]);
      return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(child:tile(0)),const SizedBox(width:10),
        Expanded(child:Column(children:[tile(1),const SizedBox(height:10),tile(2)])),
      ]);
    });
  }
}

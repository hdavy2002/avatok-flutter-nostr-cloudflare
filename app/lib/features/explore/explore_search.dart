import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/account_storage.dart';
import '../../core/analytics.dart';
import '../../core/listings_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'listing_detail.dart';
import 'widgets.dart';

/// A1 marketplace search: FTS query (partial title + creator name), filter
/// sheet (price / date / country / rating) + sort chips, recent searches
/// (stored locally, per-account scoped).
class ExploreSearchScreen extends StatefulWidget {
  const ExploreSearchScreen({super.key});
  @override
  State<ExploreSearchScreen> createState() => _ExploreSearchScreenState();
}

class _ExploreSearchScreenState extends State<ExploreSearchScreen> {
  static const _storage = FlutterSecureStorage();
  final _q = TextEditingController();
  Timer? _debounce;
  List<ListingCard> _results = [];
  List<String> _recent = [];
  bool _searching = false, _ran = false;

  // filters
  String _sort = 'soonest';
  int? _minPrice, _maxPrice;
  double? _minRating;
  String _country = '';
  DateTime? _from, _to;

  @override
  void initState() {
    super.initState();
    _loadRecent();
  }

  Future<void> _loadRecent() async {
    final raw = await readScoped(_storage, 'explore_recent_searches');
    if (raw == null || !mounted) return;
    try { setState(() => _recent = (jsonDecode(raw) as List).map((e) => e.toString()).toList()); } catch (_) {}
  }

  Future<void> _saveRecent(String q) async {
    if (q.trim().isEmpty) return;
    _recent.remove(q);
    _recent.insert(0, q);
    if (_recent.length > 8) _recent = _recent.sublist(0, 8);
    await _storage.write(key: scopedKey('explore_recent_searches'), value: jsonEncode(_recent));
  }

  void _onChanged(String v) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), _run);
  }

  Future<void> _run() async {
    final q = _q.text.trim();
    setState(() { _searching = true; _ran = true; });
    final res = await ListingsApi.search(
      q: q, sort: _sort,
      minPrice: _minPrice, maxPrice: _maxPrice, minRating: _minRating,
      country: _country.isEmpty ? null : _country.toUpperCase(),
      from: _from?.millisecondsSinceEpoch, to: _to?.millisecondsSinceEpoch,
    );
    if (!mounted) return;
    setState(() { _results = res; _searching = false; });
    if (q.isNotEmpty) { _saveRecent(q); Analytics.capture('explore_search_ran', {'q_len': q.length, 'sort': _sort, 'n': res.length}); }
  }

  bool get _hasFilters => _minPrice != null || _maxPrice != null || _minRating != null || _country.isNotEmpty || _from != null || _to != null;

  Future<void> _openFilters() async {
    await showModalBottomSheet(
      context: context, isScrollControlled: true, backgroundColor: Colors.transparent,
      builder: (_) => _FilterSheet(
        minPrice: _minPrice, maxPrice: _maxPrice, minRating: _minRating,
        country: _country, from: _from, to: _to,
        onApply: (minP, maxP, minR, cc, f, t) {
          setState(() { _minPrice = minP; _maxPrice = maxP; _minRating = minR; _country = cc; _from = f; _to = t; });
          _run();
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      body: SafeArea(
        child: Column(children: [
          // Search band: paper-2 fill + ink bottom border (§8).
          Container(
            decoration: const BoxDecoration(
              color: Zine.paper2,
              border: Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
            ),
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 14),
            child: Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
              const ZineBackButton(),
              const SizedBox(width: 12),
              Expanded(
                child: ZineField(
                  controller: _q,
                  autofocus: true,
                  hint: 'Search the marketplace…',
                  leadIcon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
                  onChanged: _onChanged,
                  onSubmitted: (_) => _run(),
                ),
              ),
              const SizedBox(width: 12),
              Stack(clipBehavior: Clip.none, children: [
                ZineBackButton(
                  onTap: _openFilters,
                  icon: PhosphorIcons.faders(PhosphorIconsStyle.bold),
                ),
                if (_hasFilters)
                  Positioned(right: -2, top: -2, child: Container(
                    width: 13, height: 13,
                    decoration: BoxDecoration(
                      color: Zine.coral, shape: BoxShape.circle,
                      border: Border.all(color: Zine.ink, width: 2),
                    ),
                  )),
              ]),
            ]),
          ),
          SizedBox(
            height: 58,
            child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10), children: [
              for (final s in const [['soonest', 'Soonest'], ['cheapest', 'Cheapest'], ['popular', 'Popular'], ['rating', 'Top rated']])
                Padding(
                  padding: const EdgeInsets.only(right: 9),
                  child: ZineChip(
                    label: s[1],
                    active: _sort == s[0],
                    onTap: () { setState(() => _sort = s[0]); _run(); },
                  ),
                ),
            ]),
          ),
          Expanded(child: _bodyContent()),
        ]),
      ),
    );
  }

  Widget _bodyContent() {
    if (_searching) return const Center(child: CircularProgressIndicator(color: Zine.blueInk));
    if (!_ran) {
      if (_recent.isEmpty) {
        return Center(child: ZineEmptyState(
            icon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
            text: 'Search the marketplace — events, sessions, creators.'));
      }
      return ListView(padding: const EdgeInsets.all(18), children: [
        Text('RECENT SEARCHES', style: ZineText.kicker()),
        const SizedBox(height: 10),
        for (final r in _recent)
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () { _q.text = r; _run(); },
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 9),
              child: Row(children: [
                PhosphorIcon(PhosphorIcons.clockCounterClockwise(PhosphorIconsStyle.bold), size: 18, color: Zine.inkSoft),
                const SizedBox(width: 10),
                Expanded(child: Text(r, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ZineText.value(size: 14.5, weight: FontWeight.w700))),
                PhosphorIcon(PhosphorIcons.arrowUpLeft(PhosphorIconsStyle.bold), size: 15, color: Zine.inkMute),
              ]),
            ),
          ),
      ]);
    }
    if (_results.isEmpty) {
      return Center(child: ZineEmptyState(
          icon: PhosphorIcons.binoculars(PhosphorIconsStyle.bold),
          text: 'No results — try fewer filters.'));
    }
    return GridView.builder(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 2, crossAxisSpacing: 14, mainAxisSpacing: 16, childAspectRatio: 0.70),
      itemCount: _results.length,
      itemBuilder: (_, i) => ListingCardTile(
        card: _results[i],
        onTap: () => Navigator.push(context,
            MaterialPageRoute(builder: (_) => ListingDetailScreen(listingId: _results[i].id))),
      ),
    );
  }
}

class _FilterSheet extends StatefulWidget {
  final int? minPrice, maxPrice;
  final double? minRating;
  final String country;
  final DateTime? from, to;
  final void Function(int?, int?, double?, String, DateTime?, DateTime?) onApply;
  const _FilterSheet({this.minPrice, this.maxPrice, this.minRating, required this.country, this.from, this.to, required this.onApply});
  @override
  State<_FilterSheet> createState() => _FilterSheetState();
}

class _FilterSheetState extends State<_FilterSheet> {
  late RangeValues _price;
  double? _minRating;
  late TextEditingController _country;
  DateTime? _from, _to;

  @override
  void initState() {
    super.initState();
    _price = RangeValues((widget.minPrice ?? 0) / 100, (widget.maxPrice ?? 50000) / 100);
    _minRating = widget.minRating;
    _country = TextEditingController(text: widget.country);
    _from = widget.from; _to = widget.to;
  }

  String _fmtDay(DateTime? d) => d == null ? 'Any' : '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  Widget _dateBtn(String label, VoidCallback onTap) => ZinePressable(
        onTap: onTap,
        radius: BorderRadius.circular(100),
        boxShadow: Zine.shadowXs,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        child: Row(mainAxisAlignment: MainAxisAlignment.center, mainAxisSize: MainAxisSize.max, children: [
          PhosphorIcon(PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold), size: 15, color: Zine.ink),
          const SizedBox(width: 7),
          Flexible(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis,
              style: ZineText.tag(size: 11.5))),
        ]),
      );

  @override
  Widget build(BuildContext context) => Container(
        decoration: const BoxDecoration(
          color: Zine.paper,
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
          border: Border(top: BorderSide(color: Zine.ink, width: Zine.bwLg)),
        ),
        padding: EdgeInsets.fromLTRB(20, 16, 20, 20 + MediaQuery.of(context).viewInsets.bottom + MediaQuery.of(context).viewPadding.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Filters', style: ZineText.cardTitle(size: 20)),
          const SizedBox(height: 12),
          Text('PRICE: \$${_price.start.round()} – \$${_price.end.round()}${_price.end >= 500 ? '+' : ''}',
              style: ZineText.kicker()),
          RangeSlider(
            values: _price, min: 0, max: 500, divisions: 50,
            activeColor: Zine.blueInk,
            inactiveColor: Zine.paper2,
            onChanged: (v) => setState(() => _price = v),
          ),
          Text('MINIMUM RATING', style: ZineText.kicker()),
          const SizedBox(height: 9),
          Wrap(spacing: 9, runSpacing: 8, children: [
            for (final r in const [null, 3.0, 4.0, 4.5])
              ZineChip(
                label: r == null ? 'Any' : '★ $r+',
                active: _minRating == r,
                onTap: () => setState(() => _minRating = r),
              ),
          ]),
          const SizedBox(height: 16),
          Row(children: [
            Expanded(child: _dateBtn('From: ${_fmtDay(_from)}', () async {
              final d = await showDatePicker(context: context, initialDate: _from ?? DateTime.now(),
                  firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 365)));
              if (d != null) setState(() => _from = d);
            })),
            const SizedBox(width: 10),
            Expanded(child: _dateBtn('To: ${_fmtDay(_to)}', () async {
              final d = await showDatePicker(context: context, initialDate: _to ?? DateTime.now().add(const Duration(days: 30)),
                  firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 365)));
              if (d != null) setState(() => _to = d.add(const Duration(hours: 23, minutes: 59)));
            })),
          ]),
          const SizedBox(height: 16),
          ZineField(
            controller: _country,
            label: 'Country code (e.g. IN, US)',
            hint: 'Anywhere',
            maxLength: 2,
            textCapitalization: TextCapitalization.characters,
            leadIcon: PhosphorIcons.globeHemisphereEast(PhosphorIconsStyle.bold),
          ),
          const SizedBox(height: 18),
          Row(children: [
            Expanded(child: ZineButton(
              label: 'Clear all',
              variant: ZineButtonVariant.ghost,
              fontSize: 16,
              onPressed: () { widget.onApply(null, null, null, '', null, null); Navigator.pop(context); },
            )),
            const SizedBox(width: 10),
            Expanded(flex: 2, child: ZineButton(
              label: 'Apply filters',
              fontSize: 17,
              onPressed: () {
                widget.onApply(
                  _price.start <= 0 ? null : (_price.start * 100).round(),
                  _price.end >= 500 ? null : (_price.end * 100).round(),
                  _minRating, _country.text.trim(), _from, _to,
                );
                Navigator.pop(context);
              },
            )),
          ]),
        ]),
      );
}

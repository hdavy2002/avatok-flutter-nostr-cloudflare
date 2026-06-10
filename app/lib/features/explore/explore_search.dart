import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/account_storage.dart';
import '../../core/analytics.dart';
import '../../core/listings_api.dart';
import '../../core/theme.dart';
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
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink,
        titleSpacing: 0,
        title: Padding(
          padding: const EdgeInsets.only(right: 12),
          child: TextField(
            controller: _q, autofocus: true, onChanged: _onChanged,
            onSubmitted: (_) => _run(),
            textInputAction: TextInputAction.search,
            decoration: InputDecoration(
              hintText: 'Search events, sessions, creators…',
              isDense: true, filled: true, fillColor: AvaColors.soft,
              prefixIcon: const Icon(Icons.search, size: 20),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide.none),
            ),
          ),
        ),
        actions: [
          IconButton(
            icon: Badge(isLabelVisible: _hasFilters, child: const Icon(Icons.tune)),
            onPressed: _openFilters,
          ),
        ],
      ),
      body: Column(children: [
        SizedBox(
          height: 46,
          child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7), children: [
            for (final s in const [['soonest', 'Soonest'], ['cheapest', 'Cheapest'], ['popular', 'Popular'], ['rating', 'Top rated']])
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: ChoiceChip(
                  label: Text(s[1]), selected: _sort == s[0],
                  onSelected: (_) { setState(() => _sort = s[0]); _run(); },
                ),
              ),
          ]),
        ),
        Expanded(child: _bodyContent()),
      ]),
    );
  }

  Widget _bodyContent() {
    if (_searching) return const Center(child: CircularProgressIndicator());
    if (!_ran) {
      if (_recent.isEmpty) return const Center(child: Text('Search the marketplace', style: TextStyle(color: AvaColors.sub)));
      return ListView(padding: const EdgeInsets.all(16), children: [
        const Text('Recent searches', style: TextStyle(fontWeight: FontWeight.w800)),
        const SizedBox(height: 6),
        for (final r in _recent)
          ListTile(
            dense: true, contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.history, size: 19, color: AvaColors.sub),
            title: Text(r),
            onTap: () { _q.text = r; _run(); },
          ),
      ]);
    }
    if (_results.isEmpty) return const Center(child: Text('No results — try fewer filters.', style: TextStyle(color: AvaColors.sub)));
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

  @override
  Widget build(BuildContext context) => Container(
        decoration: const BoxDecoration(color: Colors.white, borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
        padding: EdgeInsets.fromLTRB(20, 16, 20, 20 + MediaQuery.of(context).viewInsets.bottom + MediaQuery.of(context).viewPadding.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Text('Filters', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
          const SizedBox(height: 8),
          Text('Price: \$${_price.start.round()} – \$${_price.end.round()}${_price.end >= 500 ? '+' : ''}',
              style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
          RangeSlider(
            values: _price, min: 0, max: 500, divisions: 50,
            activeColor: AvaColors.brand,
            onChanged: (v) => setState(() => _price = v),
          ),
          const Text('Minimum rating', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
          const SizedBox(height: 6),
          Wrap(spacing: 8, children: [
            for (final r in const [null, 3.0, 4.0, 4.5])
              ChoiceChip(
                label: Text(r == null ? 'Any' : '★ $r+'),
                selected: _minRating == r,
                onSelected: (_) => setState(() => _minRating = r),
              ),
          ]),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(child: OutlinedButton(
              onPressed: () async {
                final d = await showDatePicker(context: context, initialDate: _from ?? DateTime.now(),
                    firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 365)));
                if (d != null) setState(() => _from = d);
              },
              child: Text('From: ${_fmtDay(_from)}', style: const TextStyle(fontSize: 12.5)),
            )),
            const SizedBox(width: 8),
            Expanded(child: OutlinedButton(
              onPressed: () async {
                final d = await showDatePicker(context: context, initialDate: _to ?? DateTime.now().add(const Duration(days: 30)),
                    firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 365)));
                if (d != null) setState(() => _to = d.add(const Duration(hours: 23, minutes: 59)));
              },
              child: Text('To: ${_fmtDay(_to)}', style: const TextStyle(fontSize: 12.5)),
            )),
          ]),
          const SizedBox(height: 12),
          TextField(
            controller: _country, maxLength: 2, textCapitalization: TextCapitalization.characters,
            decoration: InputDecoration(labelText: 'Country code (e.g. IN, US)', counterText: '', isDense: true,
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12))),
          ),
          const SizedBox(height: 14),
          Row(children: [
            Expanded(child: TextButton(
              onPressed: () { widget.onApply(null, null, null, '', null, null); Navigator.pop(context); },
              child: const Text('Clear all'),
            )),
            const SizedBox(width: 8),
            Expanded(flex: 2, child: FilledButton(
              style: FilledButton.styleFrom(backgroundColor: AvaColors.brand, padding: const EdgeInsets.symmetric(vertical: 13)),
              onPressed: () {
                widget.onApply(
                  _price.start <= 0 ? null : (_price.start * 100).round(),
                  _price.end >= 500 ? null : (_price.end * 100).round(),
                  _minRating, _country.text.trim(), _from, _to,
                );
                Navigator.pop(context);
              },
              child: const Text('Apply filters', style: TextStyle(fontWeight: FontWeight.w800)),
            )),
          ]),
        ]),
      );
}

import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/listings_api.dart';
import '../explore/listing_detail.dart';
import 'sell_listing_flow.dart' show kMarketCategories;

/// AvaMarketplace landing — the real buy/sell/social browse (replaces AvaExplore
/// as the marketplace home). Cards show photo, title, price (multi-currency) and
/// the seller's country flag. Defaults to the user's detected country; a toggle
/// switches to All countries, and the search + category chips filter the rest.
class MarketplaceBrowse extends StatefulWidget {
  const MarketplaceBrowse({super.key});
  @override
  State<MarketplaceBrowse> createState() => _MarketplaceBrowseState();
}

String _flagOf(String? cc) {
  if (cc == null || cc.length != 2) return '🌍';
  final up = cc.toUpperCase();
  return String.fromCharCode(0x1F1E6 + up.codeUnitAt(0) - 65) +
      String.fromCharCode(0x1F1E6 + up.codeUnitAt(1) - 65);
}

class _MarketplaceBrowseState extends State<MarketplaceBrowse> {
  final _search = TextEditingController();
  String? _category; // null = All
  late String _country; // detected; '' = All countries
  bool _myCountryOnly = true;
  late Future<List<ListingCard>> _future;

  @override
  void initState() {
    super.initState();
    _country = WidgetsBinding.instance.platformDispatcher.locale.countryCode ?? '';
    if (_country.isEmpty) _myCountryOnly = false;
    Analytics.capture('marketplace_opened', {'country': _country});
    _load();
  }

  void _load() {
    _future = _fetch();
    setState(() {});
  }

  /// Fetch listings; if "My country" yields nothing, auto-fall back to all
  /// countries so the user always sees results instead of an empty grid.
  Future<List<ListingCard>> _fetch() async {
    final country = _myCountryOnly && _country.isNotEmpty ? _country : '';
    final q = _search.text.trim();
    final items = await ListingsApi.marketBrowse(country: country, category: _category, q: q);
    if (items.isEmpty && country.isNotEmpty) {
      final all = await ListingsApi.marketBrowse(country: '', category: _category, q: q);
      if (all.isNotEmpty && mounted) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) setState(() => _myCountryOnly = false);
        });
        return all;
      }
    }
    return items;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Marketplace')),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
          child: TextField(
            controller: _search,
            textInputAction: TextInputAction.search,
            onSubmitted: (_) => _load(),
            decoration: InputDecoration(
              hintText: 'Search the marketplace…',
              prefixIcon: const Icon(Icons.search),
              filled: true,
              fillColor: Colors.white,
              isDense: true,
              border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(100),
                  borderSide: const BorderSide(color: Colors.black, width: 2)),
              enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(100),
                  borderSide: const BorderSide(color: Colors.black, width: 2)),
              focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(100),
                  borderSide: const BorderSide(color: Colors.black, width: 2)),
            ),
          ),
        ),
        // Country toggle + category chips.
        SizedBox(
          height: 44,
          child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 12), children: [
            if (_country.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: ChoiceChip(
                  label: Text('${_flagOf(_country)} My country'),
                  selected: _myCountryOnly,
                  onSelected: (v) { _myCountryOnly = v; _load(); },
                ),
              ),
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: ChoiceChip(
                label: const Text('🌍 All'),
                selected: !_myCountryOnly,
                onSelected: (v) { _myCountryOnly = !v; _load(); },
              ),
            ),
            const SizedBox(width: 8),
            ChoiceChip(
              label: const Text('All categories'),
              selected: _category == null,
              onSelected: (_) { _category = null; _load(); },
            ),
            for (final c in kMarketCategories) ...[
              const SizedBox(width: 8),
              ChoiceChip(
                label: Text(c),
                selected: _category == c,
                onSelected: (_) { _category = c; _load(); },
              ),
            ],
          ]),
        ),
        const Divider(height: 1),
        Expanded(
          child: RefreshIndicator(
            onRefresh: () async => _load(),
            child: FutureBuilder<List<ListingCard>>(
              future: _future,
              builder: (context, snap) {
                if (snap.connectionState != ConnectionState.done) {
                  return const Center(child: CircularProgressIndicator());
                }
                final items = snap.data ?? const <ListingCard>[];
                if (items.isEmpty) {
                  return ListView(children: const [
                    SizedBox(height: 120),
                    Icon(Icons.storefront_outlined, size: 48, color: Colors.black26),
                    SizedBox(height: 8),
                    Center(child: Text('No listings here yet — try All countries.')),
                  ]);
                }
                return GridView.builder(
                  padding: const EdgeInsets.all(12),
                  gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: 2, mainAxisSpacing: 12, crossAxisSpacing: 12, childAspectRatio: 0.72),
                  itemCount: items.length,
                  itemBuilder: (_, i) => _Card(card: items[i]),
                );
              },
            ),
          ),
        ),
      ]),
    );
  }
}

class _Card extends StatelessWidget {
  final ListingCard card;
  const _Card({required this.card});
  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () {
        Analytics.capture('listing_card_clicked', {'listing_id': card.id});
        Navigator.of(context).push(MaterialPageRoute(
          builder: (_) => ListingDetailScreen(listingId: card.id)));
      },
      child: Container(
        decoration: BoxDecoration(
          color: Colors.white,
          border: Border.all(color: Colors.black, width: 2),
          borderRadius: BorderRadius.circular(12),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: card.coverUrl != null
                ? Image.network(card.coverUrl!, width: double.infinity, fit: BoxFit.cover,
                    errorBuilder: (_, __, ___) => Container(color: const Color(0x11000000), child: const Icon(Icons.image_not_supported)))
                : Container(color: const Color(0x11000000), child: const Center(child: Icon(Icons.inventory_2_outlined, size: 36))),
          ),
          Padding(
            padding: const EdgeInsets.all(8),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(card.title, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
              const SizedBox(height: 2),
              Row(children: [
                Expanded(child: Text(card.displayPrice,
                    maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14))),
                Text(_flagOf(card.country), style: const TextStyle(fontSize: 14)),
              ]),
            ]),
          ),
        ]),
      ),
    );
  }
}

import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/listings_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../explore/listing_detail.dart';
import 'intent_theme.dart';
import 'sell_listing_flow.dart' show kMarketCategories;

/// [UI-MKT-1] Card-impression de-dupe — fire 'mkt_card_impression' once per
/// listing_id per app session (a simple in-memory set is enough; the point is to
/// avoid re-firing on every scroll/rebuild).
final Set<String> _impressed = <String>{};
void _fireImpression(String listingId) {
  if (listingId.isEmpty || _impressed.contains(listingId)) return;
  _impressed.add(listingId);
  Analytics.capture('mkt_card_impression', {'listing_id': listingId});
}

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

  void _load({bool fresh = false}) {
    _future = _fetch(fresh: fresh);
    setState(() {});
  }

  /// Fetch listings; if "My country" yields nothing, auto-fall back to all
  /// countries so the user always sees results instead of an empty grid.
  Future<List<ListingCard>> _fetch({bool fresh = false}) async {
    final country = _myCountryOnly && _country.isNotEmpty ? _country : '';
    final q = _search.text.trim();
    final items = await ListingsApi.marketBrowse(country: country, category: _category, q: q, forceFresh: fresh);
    if (items.isEmpty && country.isNotEmpty) {
      final all = await ListingsApi.marketBrowse(country: '', category: _category, q: q, forceFresh: fresh);
      if (all.isNotEmpty && mounted) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) setState(() => _myCountryOnly = false);
        });
        return all;
      }
    }
    return items;
  }

  /// Dark-themed ChoiceChip — orange fill when selected, hairline card otherwise.
  Widget _chipStyled({required String label, required bool selected, required ValueChanged<bool> onSelected}) =>
      ChoiceChip(
        label: Text(label),
        labelStyle: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w800,
            color: selected ? Colors.white : AD.textSecondary),
        selected: selected,
        showCheckmark: false,
        onSelected: onSelected,
        backgroundColor: AD.card,
        selectedColor: AD.primaryBadge,
        side: BorderSide(color: selected ? AD.primaryBadge : AD.borderControl, width: 1),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(100)),
      );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: AppBar(
        backgroundColor: AD.headerFooter,
        foregroundColor: AD.textPrimary,
        elevation: 0,
        title: Text('Marketplace', style: ADText.appTitle()),
      ),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 14),
          child: TextField(
            controller: _search,
            textInputAction: TextInputAction.search,
            onSubmitted: (_) => _load(),
            decoration: InputDecoration(
              hintText: 'Search the marketplace…',
              hintStyle: TextStyle(color: AD.placeholderOnWhite),
              prefixIcon: Icon(Icons.search, color: AD.placeholderOnWhite),
              filled: true,
              fillColor: AD.inputField,
              isDense: true,
              border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(100),
                  borderSide: BorderSide(color: AD.borderControl, width: 1)),
              enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(100),
                  borderSide: BorderSide(color: AD.borderControl, width: 1)),
              focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(100),
                  borderSide: BorderSide(color: AD.iconSearch, width: 1)),
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
                child: _chipStyled(
                  label: '${_flagOf(_country)} My country',
                  selected: _myCountryOnly,
                  onSelected: (v) { _myCountryOnly = v; _load(); },
                ),
              ),
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: _chipStyled(
                label: '🌍 All',
                selected: !_myCountryOnly,
                onSelected: (v) { _myCountryOnly = !v; _load(); },
              ),
            ),
            const SizedBox(width: 8),
            _chipStyled(
              label: 'All categories',
              selected: _category == null,
              onSelected: (_) { _category = null; _load(); },
            ),
            for (final c in kMarketCategories) ...[
              const SizedBox(width: 8),
              _chipStyled(
                label: c,
                selected: _category == c,
                onSelected: (_) { _category = c; _load(); },
              ),
            ],
          ]),
        ),
        const SizedBox(height: 10),
        Divider(height: 1, color: AD.borderHairline),
        Expanded(
          child: RefreshIndicator(
            onRefresh: () async => _load(fresh: true),
            child: FutureBuilder<List<ListingCard>>(
              future: _future,
              builder: (context, snap) {
                if (snap.connectionState != ConnectionState.done) {
                  return const Center(child: CircularProgressIndicator());
                }
                final items = snap.data ?? const <ListingCard>[];
                if (items.isEmpty) {
                  return ListView(children: [
                    const SizedBox(height: 120),
                    Icon(Icons.storefront_outlined, size: 48, color: AD.textTertiary),
                    const SizedBox(height: 8),
                    Center(child: Text('No listings here yet — try All countries.', style: ADText.preview())),
                  ]);
                }
                return GridView.builder(
                  padding: const EdgeInsets.all(12),
                  gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                    // Match the ListingCardTile family extent (MarketplaceCard
                    // mirrors it, and its 2-line one-liner + location row need
                    // the extra height vs the old compact card's 0.72).
                    crossAxisCount: 2, mainAxisSpacing: 12, crossAxisSpacing: 12, childAspectRatio: 0.66),
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

/// [UI-MKT-1 · M-D6] Browse grid cell — a thin stateful wrapper that owns the
/// per-card side effects this screen is responsible for (session-deduped
/// `mkt_card_impression`, the `listing_card_clicked` → detail navigation, and
/// the optimistic-with-revert favourite toggle) and renders the shared pale
/// [MarketplaceCard] for the actual UI. All appearance (intent tint, price
/// semantics, chips, stats) lives in `MarketplaceCard`; this wrapper only wires
/// the callbacks so behaviour stays byte-for-byte what it was before.
class _Card extends StatefulWidget {
  final ListingCard card;
  const _Card({required this.card});
  @override
  State<_Card> createState() => _CardState();
}

class _CardState extends State<_Card> {
  bool _favBusy = false;

  ListingCard get card => widget.card;

  Future<void> _toggleFav() async {
    if (_favBusy) return;
    final next = !card.favorited;
    setState(() { card.favorited = next; _favBusy = true; }); // optimistic
    Analytics.capture(next ? 'listing_favorited' : 'listing_unfavorited', {'listing_id': card.id});
    final ok = next
        ? await ListingsApi.favorite(card.id)
        : await ListingsApi.unfavorite(card.id);
    if (!mounted) return;
    setState(() { if (!ok) card.favorited = !next; _favBusy = false; }); // revert on failure
  }

  @override
  Widget build(BuildContext context) {
    // Fire the impression once this card is built into the tree.
    WidgetsBinding.instance.addPostFrameCallback((_) => _fireImpression(card.id));
    return MarketplaceCard(
      card: card,
      // Pass the real intent + price semantics the card carries (server ships
      // them on the browse item; both default safe — SELL / asking — when the
      // server hasn't populated them yet, so this is always well-defined).
      intent: parseIntent(card.intent),
      priceSemantics: card.priceSemantics,
      onTap: () {
        Analytics.capture('listing_card_clicked', {'listing_id': card.id});
        Navigator.of(context).push(MaterialPageRoute(
          builder: (_) => ListingDetailScreen(listingId: card.id)));
      },
      // Reuse the existing optimistic-with-revert handler. It computes the next
      // state and reverts on failure itself (and fires listing_favorited /
      // listing_unfavorited), so the desired flag the card passes is ignored.
      onFavToggle: (_) => _toggleFav(),
    );
  }
}

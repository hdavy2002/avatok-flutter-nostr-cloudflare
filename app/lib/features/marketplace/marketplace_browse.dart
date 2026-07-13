import 'package:flutter/material.dart';

import 'dart:io';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/avatar_cache.dart';
import '../../core/listings_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../explore/listing_detail.dart';
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

/// Disk-cached cover image — loads from the on-device cache so it doesn't
/// re-download on every scroll/reopen (pic 3). Falls back to a placeholder.
class _CachedCover extends StatelessWidget {
  final String? url;
  const _CachedCover({required this.url});
  @override
  Widget build(BuildContext context) {
    final placeholder = Container(
      color: AD.card,
      child: Center(child: Icon(Icons.inventory_2_outlined, size: 36, color: AD.textTertiary)),
    );
    if (url == null || url!.isEmpty) return placeholder;
    return FutureBuilder<File?>(
      future: AvatarCache.getAny(url!, 600),
      builder: (_, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return Container(color: AD.cardHover);
        }
        final f = snap.data;
        if (f == null) return placeholder;
        return Image.file(f, width: double.infinity, fit: BoxFit.cover,
            errorBuilder: (_, __, ___) => placeholder);
      },
    );
  }
}

/// [UI-MKT-1] Compact zine-styled grid card, WIRED to the extended list endpoint.
/// Photo edge-to-edge on top with a heart overlay (optimistic favorite toggle);
/// below: price, 1-line title, and a micro-stats row built ONLY from real data —
/// star rating + review count, eye view count, country flag, an optional "NEW"
/// chip (<48h), and a small seller avatar. Zero/absent stats hide their chip
/// (never render "0" or "NULL").
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
    return GestureDetector(
      onTap: () {
        Analytics.capture('listing_card_clicked', {'listing_id': card.id});
        Navigator.of(context).push(MaterialPageRoute(
          builder: (_) => ListingDetailScreen(listingId: card.id)));
      },
      child: Container(
        decoration: BoxDecoration(
          color: AD.card,
          border: Border.all(color: AD.borderControl, width: 1),
          borderRadius: BorderRadius.circular(AD.rListCard),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Stack(fit: StackFit.expand, children: [
              _CachedCover(url: card.coverUrl),
              // "NEW" chip (top-left) — only when created_at < 48h.
              if (card.isNew)
                Positioned(left: 6, top: 6, child: _chip('NEW', bg: AD.primaryBadge, fg: Colors.white)),
              // Heart overlay (top-right) — optimistic favorite toggle.
              Positioned(
                right: 4, top: 4,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: _toggleFav,
                  child: Container(
                    padding: const EdgeInsets.all(5),
                    decoration: const BoxDecoration(color: Color(0xE6FFFFFF), shape: BoxShape.circle),
                    child: Icon(
                      card.favorited ? Icons.favorite : Icons.favorite_border,
                      size: 18,
                      color: card.favorited ? AD.danger : AD.textOnInput,
                    ),
                  ),
                ),
              ),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 7, 8, 8),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text(card.displayPrice,
                    maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w800, fontSize: 14, color: AD.online))),
                if (card.country != null && card.country!.isNotEmpty)
                  Text(_flagOf(card.country), style: const TextStyle(fontSize: 13)),
              ]),
              const SizedBox(height: 2),
              Text(card.title, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w600, fontSize: 12.5, color: AD.textPrimary)),
              const SizedBox(height: 5),
              // Wired micro-stats row — every chip guards its own value (no 0/NULL).
              Row(children: [
                if (card.ratingAvg != null && card.ratingCount > 0) ...[
                  Icon(Icons.star, size: 12, color: AD.iconEmoji),
                  const SizedBox(width: 1),
                  Text('${card.ratingAvg!.toStringAsFixed(1)} (${card.ratingCount})',
                      style: TextStyle(fontFamily: ADText.family, fontSize: 10.5, color: AD.textTertiary, fontWeight: FontWeight.w700)),
                  const SizedBox(width: 8),
                ],
                if (card.viewCount > 0) ...[
                  Icon(Icons.visibility_outlined, size: 12, color: AD.textTertiary),
                  const SizedBox(width: 2),
                  Text('${card.viewCount}',
                      style: TextStyle(fontFamily: ADText.family, fontSize: 10.5, color: AD.textTertiary, fontWeight: FontWeight.w600)),
                ],
                const Spacer(),
                // Small seller avatar chip (never a dummy — Avatar seeds from uid).
                Avatar(
                  seed: card.creator.uid,
                  name: card.creator.name ?? card.creator.handle ?? '?',
                  size: 20,
                  avatarUrl: card.creator.avatarUrl,
                ),
              ]),
            ]),
          ),
        ]),
      ),
    );
  }

  Widget _chip(String text, {required Color bg, required Color fg}) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(100)),
        child: Text(text, style: TextStyle(fontSize: 9.5, color: fg, fontWeight: FontWeight.w800, letterSpacing: 0.4)),
      );
}

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/listings_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
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
  /// When true this screen renders WITHOUT its own app bar, because the host
  /// (the shell's Services root) already draws the shared AvaTOK header band.
  ///
  /// [UI-MARKET-2026] Leaving it to draw its own [ZineAppBar] there was the
  /// "two stacked Marketplace titles" the owner reported: `ServicesRoot` shows
  /// a "Marketplace" bar and this screen showed a second one directly beneath
  /// it. When null (the default) it is inferred: this screen is embedded when
  /// it is the FIRST route of its navigator (how `ServicesRoot` mounts it) and
  /// standalone when it was pushed (sidebar → Browse), where it must carry its
  /// own header + back button. A host may still pass the flag explicitly.
  final bool? embedded;
  const MarketplaceBrowse({super.key, this.embedded});
  @override
  State<MarketplaceBrowse> createState() => _MarketplaceBrowseState();
}

/// [UI-MARKET-2026] Responsive page title. "Marketplace" is long enough to push
/// the wallet chip / avatar / bell out of a narrow header, so anything under
/// ~400dp gets the shortened form. Shared so the Services root can use the same
/// string as this screen.
String marketplaceTitle(BuildContext context) =>
    MediaQuery.sizeOf(context).width < 400 ? 'Market…' : 'Marketplace';

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

  /// [UI-MARKET-2026] Holi/bandhani accent per filter family, so country,
  /// category and each vehicle-style category chip read as different things at
  /// a glance instead of one undifferentiated orange row.
  ///
  /// Order matters: `kMarketCategories` starts with Vehicles, so index 0 is
  /// terracotta (lac red) — the vehicle filter the owner called out. The rest
  /// rotate through marigold / rani / indigo / green.
  static const List<Color> _categoryPalette = <Color>[
    AD.terracotta,    // Vehicles
    AD.haldi,         // marigold — LIGHT band, takes ink
    AD.primaryBadge,  // rani pink — dark, takes cream
    AD.tabCalls,      // Jodhpur indigo — dark, takes cream
    AD.online,        // deep green — dark, takes cream
  ];

  /// Country toggles get their own hue (deep green) so they never look like a
  /// category. Categories rotate through [_categoryPalette] by position.
  Color _chipAccent(String label, {int? categoryIndex}) {
    if (categoryIndex != null && categoryIndex >= 0) {
      return _categoryPalette[categoryIndex % _categoryPalette.length];
    }
    return AD.online;
  }

  /// Filter chip. Selected = full accent fill with the readable foreground
  /// [AD.onBand] picks for that hue (cream on indigo/rani/green, ink on
  /// marigold — never black text on indigo). Unselected = paper with a faint
  /// wash of the same accent and a 2px accent outline, so the family colour is
  /// still legible while the selected state stays unmistakable. No blur
  /// shadows: this palette uses ink outlines, not elevation.
  Widget _chipStyled({
    required String label,
    required bool selected,
    required ValueChanged<bool> onSelected,
    int? categoryIndex,
  }) {
    final accent = _chipAccent(label, categoryIndex: categoryIndex);
    return ChoiceChip(
      label: Text(label),
      labelStyle: TextStyle(
        fontFamily: ADText.family,
        fontWeight: FontWeight.w600,
        color: selected ? AD.onBand(accent) : AD.textPrimary,
      ),
      selected: selected,
      showCheckmark: false,
      onSelected: onSelected,
      elevation: 0,
      pressElevation: 0,
      backgroundColor: accent.withValues(alpha: 0.14),
      selectedColor: accent,
      side: BorderSide(
          color: selected ? AD.borderControl : accent, width: AD.wBorder),
      shape: RoundedRectangleBorder(borderRadius: Msg.brPill),
    );
  }

  @override
  Widget build(BuildContext context) {
    // [UI-MARKET-2026] Embedded (Services root already drew the shared header)
    // vs standalone (pushed route → this screen owns the header). See the
    // `embedded` doc on the widget.
    final embedded =
        widget.embedded ?? (ModalRoute.of(context)?.isFirst ?? false);
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: embedded
          ? null
          : ZineAppBar(
              title: marketplaceTitle(context),
              showBack: Navigator.of(context).canPop(),
            ),
      body: Column(children: [
        Padding(
          // The search field must START BELOW THE TIP OF THE HEADER WAVE and
          // never sit behind the golden seam. This is a plain TextField, not
          // the shared AdSearchDock, so it has to reproduce that component's
          // offset by hand: hosts pad AdSearchDock by Msg.s3 and the dock adds
          // its own 12px top margin, so the equivalent clearance is Msg.s3+12.
          padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s3 + 12, Msg.s4, Msg.s4),
          child: TextField(
            controller: _search,
            textInputAction: TextInputAction.search,
            onSubmitted: (_) => _load(),
            decoration: InputDecoration(
              hintText: 'Search the marketplace…',
              hintStyle: TextStyle(color: AD.placeholderOnWhite),
              prefixIcon: PhosphorIcon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.regular), color: AD.placeholderOnWhite),
              filled: true,
              fillColor: AD.inputField,
              isDense: true,
              border: OutlineInputBorder(
                  borderRadius: Msg.brMd,
                  borderSide: BorderSide(color: AD.borderControl, width: 1)),
              enabledBorder: OutlineInputBorder(
                  borderRadius: Msg.brMd,
                  borderSide: BorderSide(color: AD.borderControl, width: 1)),
              focusedBorder: OutlineInputBorder(
                  borderRadius: Msg.brMd,
                  borderSide: BorderSide(color: AD.iconSearch, width: 1)),
            ),
          ),
        ),
        // Country toggle + category chips.
        SizedBox(
          height: 44,
          child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: Msg.s4), children: [
            if (_country.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(right: Msg.s2),
                child: _chipStyled(
                  label: '${_flagOf(_country)} My country',
                  selected: _myCountryOnly,
                  onSelected: (v) { _myCountryOnly = v; _load(); },
                ),
              ),
            Padding(
              padding: const EdgeInsets.only(right: Msg.s2),
              child: _chipStyled(
                label: 'All countries',
                selected: !_myCountryOnly,
                onSelected: (v) { _myCountryOnly = !v; _load(); },
              ),
            ),
            const SizedBox(width: Msg.s2),
            _chipStyled(
              label: 'All categories',
              selected: _category == null,
              categoryIndex: _categoryPalette.length - 1,
              onSelected: (_) { _category = null; _load(); },
            ),
            for (int i = 0; i < kMarketCategories.length; i++) ...[
              const SizedBox(width: Msg.s2),
              _chipStyled(
                label: kMarketCategories[i],
                selected: _category == kMarketCategories[i],
                categoryIndex: i,
                onSelected: (_) { _category = kMarketCategories[i]; _load(); },
              ),
            ],
          ]),
        ),
        const SizedBox(height: Msg.s3),
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
                  // [UI-MARKET-2026] Was a left-aligned icon with a centred
                  // caption and a hard 120px spacer — on a small screen the
                  // glyph sat in the corner and the copy wrapped awkwardly.
                  // Centred, padded and word-wrapped instead, still inside a
                  // scrollable so pull-to-refresh keeps working.
                  return ListView(
                    padding: const EdgeInsets.fromLTRB(Msg.s5, 72, Msg.s5, Msg.s5),
                    children: [
                      Center(
                        child: PhosphorIcon(
                            PhosphorIcons.storefront(PhosphorIconsStyle.regular),
                            size: 44,
                            color: AD.textTertiary),
                      ),
                      const SizedBox(height: Msg.s3),
                      Text('Nothing listed here yet',
                          textAlign: TextAlign.center,
                          style: ADText.rowName()),
                      const SizedBox(height: Msg.s1),
                      Text(
                          'Try “All countries”, clear the category filter, or pull down to refresh.',
                          textAlign: TextAlign.center,
                          style: ADText.preview()),
                    ],
                  );
                }
                return GridView.builder(
                  padding: const EdgeInsets.all(Msg.s3),
                  // [UI-MARKET-2026] Max-extent instead of a hard 2 columns:
                  // a 240dp cap still gives exactly 2 columns on every phone
                  // (a 360dp screen leaves 336dp of content → 168dp tiles) but
                  // stops the cards stretching to unreadable widths on a
                  // tablet or a large foldable.
                  gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                    // Aspect matches the ListingCardTile family extent
                    // (MarketplaceCard mirrors it, and its 2-line one-liner +
                    // location row need the extra height vs 0.72).
                    maxCrossAxisExtent: 240,
                    mainAxisSpacing: 12,
                    crossAxisSpacing: 12,
                    childAspectRatio: 0.66),
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

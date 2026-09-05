import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/listings_api.dart';
import '../../core/remote_config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/breakpoints.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import '../explore/listing_detail.dart';
import '../booking/commercial_customer_screens.dart';
import 'commercial_service_cards.dart';
import 'create_service_choice_sheet.dart';
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
  String _commercialQuery = '';
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
    final commercialLive = RemoteConfig.commercialLiveListingsEnabled;
    final commercialConsult = RemoteConfig.commercialConsultListingsEnabled;
    final commercialDiscovery = commercialLive || commercialConsult;
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: embedded
          ? null
          // [RESP-SHORT-1] `chromeScaleHV` is 1.0 on a normal phone (nothing
          // changes there); on a short screen it trims the fixed 76dp band so
          // the grid gets a row back.
          : ZineAppBar(
              title: marketplaceTitle(context),
              showBack: Navigator.of(context).canPop(),
              heightScale: ZineBreakpoints.chromeScaleHV(context),
            ),
      // [UI-MKT-VERT-1 2026-09-05] One CustomScrollView, not a Column whose
      // last child is an Expanded grid. The old shape pinned the search box,
      // the chips and a hard 350dp creator shelf to the top of the viewport and
      // let only the grid move, so a phone screen was mostly permanent chrome
      // and the shelves could never grow past one row. Everything is a sliver
      // now: the header, the shelves and the grid scroll as one surface, which
      // is what makes "scroll down for more categories" possible at all.
      body: RefreshIndicator(
        onRefresh: () async => _load(fresh: true),
        // Pull-to-refresh must keep working even when the page is shorter than
        // the viewport (empty grid, no shelves), which a CustomScrollView will
        // not do on its default physics.
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
          SliverToBoxAdapter(child: Column(children: [
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
            onSubmitted: (value) {
              _commercialQuery = value.trim();
              Analytics.capture('marketplace_search_submitted', {
                'has_commercial_services': commercialDiscovery,
                'query_length': _commercialQuery.length,
              });
              _load();
            },
            decoration: InputDecoration(
              hintText: commercialDiscovery
                  ? 'Search Marketplace and creator services…'
                  : 'Search the marketplace…',
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
            if (commercialDiscovery)
              _CommercialServicesShelf(
                liveEnabled: commercialLive,
                consultEnabled: commercialConsult,
                query: _commercialQuery,
              ),
          ])),
          FutureBuilder<List<ListingCard>>(
            future: _future,
            builder: (context, snap) {
              if (snap.connectionState != ConnectionState.done) {
                return const SliverToBoxAdapter(
                  child: Padding(
                    padding: EdgeInsets.symmetric(vertical: 48),
                    child: Center(child: CircularProgressIndicator()),
                  ),
                );
              }
              final items = snap.data ?? const <ListingCard>[];
              if (items.isEmpty) {
                // [UI-MARKET-2026] Was a left-aligned icon with a centred
                // caption and a hard 120px spacer — on a small screen the
                // glyph sat in the corner and the copy wrapped awkwardly.
                // Centred, padded and word-wrapped instead.
                //
                // [UI-MKT-VERT-1] A sliver now, and NOT a SliverFillRemaining:
                // with tall shelves above it there is often no remaining
                // viewport to fill, and forcing one would add a screen of dead
                // scroll below the last shelf.
                return SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(Msg.s5, 56, Msg.s5, 56),
                    child: Column(children: [
                      PhosphorIcon(
                          PhosphorIcons.storefront(PhosphorIconsStyle.regular),
                          size: 44,
                          color: AD.textTertiary),
                      const SizedBox(height: Msg.s3),
                      Text('Nothing listed here yet',
                          textAlign: TextAlign.center,
                          style: ADText.rowName()),
                      const SizedBox(height: Msg.s1),
                      Text(
                          'Try “All countries”, clear the category filter, or pull down to refresh.',
                          textAlign: TextAlign.center,
                          style: ADText.preview()),
                    ]),
                  ),
                );
              }
              return SliverPadding(
                padding: const EdgeInsets.all(Msg.s3),
                sliver: SliverGrid(
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
                  delegate: SliverChildBuilderDelegate(
                    (_, i) => _Card(card: items[i]),
                    childCount: items.length,
                  ),
                ),
              );
            },
          ),
          const SliverToBoxAdapter(child: SizedBox(height: Msg.s5)),
        ]),
      ),
    );
  }
}

/// [UI-MKT-VERT-1 2026-09-05] One horizontally-scrolling row of creator cards
/// under its own heading. The page stacks several of these, so a heading is the
/// only thing separating one category's row from the next.
class _CommercialSection {
  final String title;
  final List<ListingCard> cards;
  const _CommercialSection(this.title, this.cards);
}

/// Title-case a raw category string from the server (`wellness` → `Wellness`).
/// Server categories are free text, so anything already cased is left alone.
String _sectionTitle(String raw) {
  final t = raw.trim();
  if (t.isEmpty) return 'More sessions';
  return t
      .split(RegExp(r'[\s_-]+'))
      .where((w) => w.isNotEmpty)
      .map((w) => w[0].toUpperCase() + w.substring(1))
      .join(' ');
}

/// Group creator cards into the rows the page renders, in display order:
/// anything on air first, then one row per category (biggest first, so a
/// category with real supply is not buried under a category with one card),
/// then a catch-all for cards the server left uncategorised.
///
/// Deliberately NOT one row per entry in `kMarketCategories`: those are the
/// goods-for-sale taxonomy, and emitting an empty row per name would give a
/// page of seventeen headings with nothing under any of them.
List<_CommercialSection> _sectionsFor(List<ListingCard> cards) {
  if (cards.isEmpty) return const <_CommercialSection>[];
  final liveNow = cards.where((c) => c.status == 'live').toList();
  final rest = cards.where((c) => c.status != 'live').toList();

  final byCategory = <String, List<ListingCard>>{};
  for (final c in rest) {
    byCategory.putIfAbsent(c.category.trim().toLowerCase(), () => []).add(c);
  }
  final uncategorised = byCategory.remove('') ?? const <ListingCard>[];

  final keys = byCategory.keys.toList()
    ..sort((a, b) {
      final n = byCategory[b]!.length.compareTo(byCategory[a]!.length);
      return n != 0 ? n : a.compareTo(b);
    });

  return <_CommercialSection>[
    if (liveNow.isNotEmpty) _CommercialSection('Live now', liveNow),
    for (final k in keys) _CommercialSection(_sectionTitle(k), byCategory[k]!),
    if (uncategorised.isNotEmpty)
      _CommercialSection(_sectionTitle(''), uncategorised),
  ];
}

/// Phase 2 discovery shelf. It is completely absent while both listing flags
/// are false, preserving the current production Marketplace. Public cards lead
/// to listing detail only; entitlement/payment remains a later server action.
class _CommercialServicesShelf extends StatefulWidget {
  final bool liveEnabled, consultEnabled;
  final String query;

  const _CommercialServicesShelf({
    required this.liveEnabled,
    required this.consultEnabled,
    required this.query,
  });

  @override
  State<_CommercialServicesShelf> createState() =>
      _CommercialServicesShelfState();
}

class _CommercialServicesShelfState extends State<_CommercialServicesShelf> {
  /// [UI-MKT-VERT-1] Both lanes are fetched together and then grouped by
  /// category, because the rows are now categories rather than lanes. The old
  /// "Live & upcoming / 1:1 consultations" chip pair is gone: with a row per
  /// category the chips were a second, contradictory way to slice the same
  /// cards, and they were the reason only ONE row could ever be on screen.
  late Future<List<ListingCard>> _all;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  @override
  void didUpdateWidget(covariant _CommercialServicesShelf oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.query != widget.query ||
        oldWidget.liveEnabled != widget.liveEnabled ||
        oldWidget.consultEnabled != widget.consultEnabled) {
      _reload();
    }
  }

  void _reload() {
    _all = _loadAll();
  }

  Future<List<ListingCard>> _loadAll() async {
    final live = widget.liveEnabled
        ? await _loadLive()
        : const <ListingCard>[];
    final consult = widget.consultEnabled
        ? await (widget.query.isEmpty
            ? ListingsApi.explore(kind: 'consult')
            : ListingsApi.search(q: widget.query, kind: 'consult'))
        : const <ListingCard>[];
    // De-dupe across lanes — a listing that answers both queries must not
    // appear twice inside its category row.
    final byId = <String, ListingCard>{};
    for (final c in [...live, ...consult]) {
      byId[c.id] = c;
    }
    return byId.values.toList();
  }

  Future<List<ListingCard>> _loadLive() async {
    final results = widget.query.isEmpty
        ? await Future.wait([
            ListingsApi.liveNow(),
            ListingsApi.explore(kind: 'live_event'),
          ])
        : <List<ListingCard>>[
            await ListingsApi.search(q: widget.query, kind: 'live_event'),
          ];
    final byId = <String, ListingCard>{};
    for (final result in results) {
      for (final card in result) {
      byId[card.id] = card;
      }
    }
    final cards = byId.values.toList();
    cards.sort((a, b) {
      if (a.status == 'live' && b.status != 'live') return -1;
      if (b.status == 'live' && a.status != 'live') return 1;
      return (a.startsAt ?? 1 << 62).compareTo(b.startsAt ?? 1 << 62);
    });
    return cards;
  }

  void _open(ListingCard card) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => ListingDetailScreen(listingId: card.id),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final metrics = CommercialCardMetrics.of(context);
    // [UI-MKT-VERT-1] No fixed height. This block sizes to its rows, and the
    // page it sits in is a scroll view — that is the whole fix for the "BOTTOM
    // OVERFLOWED BY 51 PIXELS" stripe, which was a 350dp box being handed cards
    // that needed more.
    return Container(
      color: AD.bg,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s3, Msg.s4, Msg.s2),
          child: Row(children: [
            Expanded(child: Text(
              widget.query.isEmpty
                  ? 'Book a creator'
                  : 'Creator results for “${widget.query}”',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: ADText.rowName(),
            )),
            TextButton.icon(
              onPressed: () => Navigator.of(context).push(MaterialPageRoute(
                  builder: (_) => const MySessionsScreen())),
              icon: PhosphorIcon(PhosphorIcons.calendarCheck(PhosphorIconsStyle.bold), size: 16),
              label: const Text('My sessions'),
            ),
            TextButton.icon(
              onPressed: () async {
                final created = await openCreateServiceChoice(context);
                if (created == true && mounted) setState(_reload);
              },
              icon: PhosphorIcon(
                PhosphorIcons.plus(PhosphorIconsStyle.bold),
                size: 16,
              ),
              label: const Text('Offer a service'),
            ),
          ]),
        ),
        FutureBuilder<List<ListingCard>>(
          future: _all,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return const SizedBox(
                height: 120,
                child: Center(child: CircularProgressIndicator()),
              );
            }
            if (snap.hasError) {
              return SizedBox(
                height: 140,
                child: _CommercialShelfMessage(
                  icon: PhosphorIcons.cloudSlash(PhosphorIconsStyle.regular),
                  title: 'Creator services are unavailable',
                  action: 'Try again',
                  onAction: () => setState(_reload),
                ),
              );
            }
            final sections = _sectionsFor(snap.data ?? const <ListingCard>[]);
            if (sections.isEmpty) {
              return SizedBox(
                height: 140,
                child: _CommercialShelfMessage(
                  icon: PhosphorIcons.broadcast(PhosphorIconsStyle.regular),
                  title: widget.query.isEmpty
                      ? 'No creator sessions listed yet'
                      : 'No creator sessions match this search',
                ),
              );
            }
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final s in sections) ...[
                  Padding(
                    padding: const EdgeInsets.fromLTRB(
                        Msg.s4, Msg.s3, Msg.s4, Msg.s2),
                    child: Row(children: [
                      Expanded(
                        child: Text(s.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: ADText.rowName()),
                      ),
                      Text('${s.cards.length}',
                          style: ADText.preview(c: AD.textSecondary)),
                    ]),
                  ),
                  SizedBox(
                    height: metrics.height,
                    child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      // [UI-MKT-VERT-1] `clipBehavior: none` would bleed the
                      // card shadow into the next row's heading; the row is
                      // deliberately its own clipped band.
                      padding: const EdgeInsets.symmetric(horizontal: Msg.s4),
                      itemCount: s.cards.length,
                      separatorBuilder: (_, __) =>
                          const SizedBox(width: Msg.s3),
                      itemBuilder: (_, index) {
                        final card = s.cards[index];
                        return card.kind == 'consult'
                            ? ConsultationCard(
                                card: card, onTap: () => _open(card))
                            : LiveEventCard(
                                card: card, onTap: () => _open(card));
                      },
                    ),
                  ),
                  const SizedBox(height: Msg.s3),
                ],
              ],
            );
          },
        ),
        Divider(height: 1, color: AD.borderHairline),
      ]),
    );
  }
}

class _CommercialShelfMessage extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? action;
  final VoidCallback? onAction;

  const _CommercialShelfMessage({
    required this.icon,
    required this.title,
    this.action,
    this.onAction,
  });

  @override
  Widget build(BuildContext context) => Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(icon, size: 32, color: AD.textTertiary),
          const SizedBox(height: Msg.s2),
          Text(title, textAlign: TextAlign.center, style: ADText.preview()),
          if (action != null && onAction != null)
            TextButton(onPressed: onAction, child: Text(action!)),
        ]),
      );
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

import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/listing_groups.dart';
import '../../core/listings_api.dart';
import '../../core/remote_config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/breakpoints.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/rajasthani_motifs.dart'; // ScallopBorder
import '../../core/ui/zine_widgets.dart';
import '../explore/listing_detail.dart';
import 'commercial_service_cards.dart';
import 'intent_theme.dart';

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
        // [UI-SEAM-OFF-1 2026-09-05] `removeBottom` so this scroll view runs
        // flush to the bottom of the shell body. Nested inside the shell's
        // Scaffold, the MediaQuery reaching this screen can still carry the
        // device's bottom inset even though the shell's own bar already sits
        // over it — which shows up as a dead paper strip under the last row.
        child: MediaQuery.removePadding(
          context: context,
          removeBottom: true,
          // Pull-to-refresh must keep working even when the page is shorter
          // than the viewport (empty grid, no shelves), which a
          // CustomScrollView will not do on its default physics.
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
            // [UI-SECTION-HEAD-1 2026-09-05] The country/category chip strip
            // that used to sit here is REMOVED (owner). It was a 44dp
            // horizontal scroller carrying "My country" / "All countries" plus
            // all 17 `kMarketCategories`, and it competed with the category
            // section headings below, which now do the same job by simply
            // showing what is actually on offer.
            //
            // The FILTER STATE it drove is still live: `_myCountryOnly`
            // defaults on and auto-falls back to all countries when the user's
            // country is empty (`_fetch`), and `_category` stays null = all.
            // They are just no longer user-settable from this screen. If the
            // filters need to come back, they belong behind a control in the
            // header rather than as a permanent band.
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
            const SliverToBoxAdapter(child: SizedBox(height: Msg.s3)),
          ]),
        ),
      ),
    );
  }
}

/// [UI-SECTION-HEAD-1 2026-09-05] The category headline above each row, in the
/// website's editorial voice: a small lac-red eyebrow ("01 · MUSIC · 2
/// SESSIONS"), the category set large in the display face, and a scalloped
/// jharokha border closing it off.
///
/// TYPE RULES (CLAUDE.md, learned the hard way — do not "tidy" these away):
///   * Anton ships ONE weight. Asking for bold makes the browser/engine
///     synthesise it by smearing glyphs sideways until the letters touch, and
///     letter-spacing cannot repair that because the glyphs themselves are
///     distorted. `fontWeight: w400` here is load-bearing, not a default.
///   * Tracking is NEVER negative on display or bold type. Display sits at
///     0.055em–0.07em, small-caps eyebrows at 0.1em–0.16em — expressed here in
///     logical pixels, so they scale with the font size above them.
///   * Line height stays at or above 1.02 on display type.
class _SectionHeading extends StatelessWidget {
  final int index;
  final String title;
  final int count;

  const _SectionHeading({
    required this.index,
    required this.title,
    required this.count,
  });

  @override
  Widget build(BuildContext context) {
    // Scale with the screen so a 320dp phone does not wrap every headline, but
    // hold a floor and a ceiling — this is a headline, not a fluid unit.
    final display = (MediaQuery.sizeOf(context).width * 0.093).clamp(30.0, 44.0);
    final eyebrow =
        '${index.toString().padLeft(2, '0')} · ${title.toUpperCase()} · '
        '$count ${count == 1 ? 'SESSION' : 'SESSIONS'}';

    return Padding(
      padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s5, Msg.s4, 0),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(
          eyebrow,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: GoogleFonts.nunito(
            fontSize: 12,
            fontWeight: FontWeight.w800,
            letterSpacing: 1.7, // ~0.14em
            color: AD.terracotta,
          ),
        ),
        const SizedBox(height: Msg.s2),
        // The trailing full stop is the website's device — it is what makes
        // "MUSIC." read as a masthead rather than a label. It carries the
        // accent so a one-word category still has the two-colour split that
        // "LIVE STREAMING & SHOWS." gets.
        Text.rich(
          TextSpan(children: [
            TextSpan(text: title.toUpperCase()),
            TextSpan(
                text: '.', style: const TextStyle(color: AD.terracotta)),
          ]),
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: GoogleFonts.anton(
            fontSize: display,
            fontWeight: FontWeight.w400, // see the Anton note above
            height: 1.04,
            letterSpacing: display * 0.06,
            wordSpacing: display * 0.2,
            color: AD.textPrimary,
          ),
        ),
        const SizedBox(height: Msg.s2),
        const ScallopBorder(),
        const SizedBox(height: Msg.s3),
      ]),
    );
  }
}

/// [MKT-3GROUP-APP-1 2026-09-05] Creator cards, bucketed into the THREE
/// marketplace groups (`Specs/SPEC-2026-09-05-THREE-GROUPS-AND-HOURLY-PRICING.md`
/// §1), replacing the old "one row per raw category string" model. A card with
/// no resolved group (an `ai_voice_agents` listing, or a marketplace-goods
/// category) renders in none of the three rows — that is the spec, not a bug.
class _GroupedListings {
  final Map<String, List<ListingCard>> byGroup;
  const _GroupedListings(this.byGroup);
  List<ListingCard> cardsFor(String groupId) =>
      byGroup[groupId] ?? const <ListingCard>[];
  bool get isEmpty => byGroup.values.every((l) => l.isEmpty);
}

/// [MKT-3GROUP-APP-1] `adda_rooms` is a `find_your_people` blip gated on
/// `conferenceEnabled`, which is FALSE in production (verified on the live
/// config, not read from DEFAULTS — see CLAUDE.md). Hiding the blip while the
/// flag is off, rather than showing an always-empty one, is the spec: a blip
/// that can never have cards behind it reads exactly like "nobody has listed
/// one yet", and only one of those is a bug.
bool _blipAllowed(String categoryId) =>
    categoryId != 'adda_rooms' || RemoteConfig.conferenceEnabled;

/// One sub-category blip: id + label + emoji, from whichever source resolved
/// it (server categories, or the offline mirror).
class _Blip {
  final String id, label, emoji;
  const _Blip(this.id, this.label, this.emoji);
}

/// The blips to render under one group's heading, in the server's order (or
/// the mirror's `sort` order when the fetch fell back to it), minus any blip
/// [_blipAllowed] hides.
List<_Blip> _blipsFor(List<ExploreCategory> categories, String groupId) {
  final seen = <String>{};
  final out = <_Blip>[];
  for (final c in categories) {
    if (c.resolvedGroupId != groupId) continue;
    if (!_blipAllowed(c.id)) continue;
    if (!seen.add(c.id)) continue;
    out.add(_Blip(c.id, c.label, c.emoji));
  }
  return out;
}

/// [MKT-3GROUP-APP-1] One horizontally-scrolling row of sub-category chips.
/// Tapping a blip filters the cards rendered below it in the same group;
/// tapping the active blip again clears the filter back to "all".
class _BlipRow extends StatelessWidget {
  final List<_Blip> blips;
  final String? selected;
  final ValueChanged<String> onSelect;
  const _BlipRow({required this.blips, required this.selected, required this.onSelect});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 40,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: Msg.s4),
        itemCount: blips.length,
        separatorBuilder: (_, __) => const SizedBox(width: Msg.s2),
        itemBuilder: (_, i) {
          final blip = blips[i];
          return AdChip(
            label: '${blip.emoji} ${blip.label}',
            active: blip.id == selected,
            onTap: () => onSelect(blip.id),
          );
        },
      ),
    );
  }
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
  /// [MKT-3GROUP-APP-1] Both lanes are fetched together and then bucketed by
  /// GROUP (`ListingCard.resolvedGroupId`), because the rows are now the three
  /// marketplace groups rather than raw category strings or live/consult
  /// lanes.
  late Future<_GroupedListings> _all;

  /// [MKT-3GROUP-APP-1] The blip labels for every group, fetched once from
  /// `GET /api/explore/categories` (the runtime authority — a category added
  /// in D1 must appear without an app release) and falling back to the
  /// generated offline mirror only when that fetch is empty or fails.
  late Future<List<ExploreCategory>> _categories;

  /// groupId -> selected category id, or absent/null for "all" in that group.
  final Map<String, String?> _selectedCategory = {};

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
    _categories = _loadCategories();
  }

  Future<List<ExploreCategory>> _loadCategories() async {
    try {
      final fetched = await ListingsApi.categories();
      if (fetched.isNotEmpty) return fetched;
    } catch (_) {
      // fall through to the offline mirror below
    }
    // [MKT-3GROUP-APP-1] Offline fallback ONLY — the server categories fetch
    // is the runtime authority. Reached when the fetch fails or an older
    // server returns nothing.
    return kListingSubCategories
        .map((c) => ExploreCategory.fromJson({
              'id': c.id,
              'label': c.label,
              'emoji': c.emoji,
              'group_id': c.group,
            }))
        .toList();
  }

  Future<_GroupedListings> _loadAll() async {
    final live = widget.liveEnabled
        ? await _loadLive()
        : const <ListingCard>[];
    final consult = widget.consultEnabled
        ? await (widget.query.isEmpty
            ? ListingsApi.explore(kind: 'consult')
            : ListingsApi.search(q: widget.query, kind: 'consult'))
        : const <ListingCard>[];
    // De-dupe across lanes — a listing that answers both queries must not
    // appear twice inside its group's row.
    final byId = <String, ListingCard>{};
    for (final c in [...live, ...consult]) {
      byId[c.id] = c;
    }
    final byGroup = <String, List<ListingCard>>{};
    for (final c in byId.values) {
      final g = c.resolvedGroupId;
      if (g == null) continue; // ai_voice_agents, or a goods category — renders nowhere.
      byGroup.putIfAbsent(g, () => []).add(c);
    }
    return _GroupedListings(byGroup);
  }

  void _selectBlip(String groupId, String categoryId) {
    final next = _selectedCategory[groupId] == categoryId ? null : categoryId;
    setState(() => _selectedCategory[groupId] = next);
    Analytics.capture('mkt_blip_tapped', {
      'group_id': groupId,
      'category_id': next ?? '',
      'cleared': next == null,
    });
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
        // [UI-SECTION-HEAD-1 2026-09-05] The "Book a creator · My sessions ·
        // Offer a service" strip that used to open this block is REMOVED
        // (owner). Both actions now live only in the sidebar's Marketplace
        // group, which is why the `MySessionsScreen` /
        // `openCreateServiceChoice` imports are gone from this file. Nothing
        // was deleted — this is a discoverability change. If sellers stop
        // listing after this ships, it is the first thing to look at.
        FutureBuilder<_GroupedListings>(
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
            final grouped = snap.data ?? const _GroupedListings({});
            if (grouped.isEmpty) {
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
            // [MKT-3GROUP-APP-1] The blip labels load independently of the
            // cards (a slower/failed categories fetch must not blank out
            // cards that are otherwise ready) — an empty blip list just means
            // no filter row renders for that group yet.
            return FutureBuilder<List<ExploreCategory>>(
              future: _categories,
              builder: (context, catSnap) {
                final categories = catSnap.data ?? const <ExploreCategory>[];
                final sections = <Widget>[];
                var index = 0;
                for (final group in kListingGroups) {
                  final selected = _selectedCategory[group.id];
                  final groupCards = grouped.cardsFor(group.id);
                  if (groupCards.isEmpty) continue;
                  final filtered = selected == null
                      ? groupCards
                      : groupCards.where((c) => c.category == selected).toList();
                  index++;
                  sections.add(_SectionHeading(
                    index: index,
                    title: group.heading,
                    count: filtered.length,
                  ));
                  final blips = _blipsFor(categories, group.id);
                  if (blips.isNotEmpty) {
                    sections.add(_BlipRow(
                      blips: blips,
                      selected: selected,
                      onSelect: (id) => _selectBlip(group.id, id),
                    ));
                    sections.add(const SizedBox(height: Msg.s3));
                  }
                  if (filtered.isEmpty) {
                    // The blip's own category has no live supply right now —
                    // say so rather than silently collapsing the row to
                    // nothing, which reads as a bug.
                    sections.add(Padding(
                      padding: const EdgeInsets.symmetric(horizontal: Msg.s4),
                      child: Text('Nothing listed in this category yet',
                          style: ADText.preview()),
                    ));
                  } else {
                    sections.add(SizedBox(
                      height: metrics.height,
                      child: ListView.separated(
                        scrollDirection: Axis.horizontal,
                        // [UI-MKT-VERT-1] `clipBehavior: none` would bleed the
                        // card shadow into the next row's heading; the row is
                        // deliberately its own clipped band.
                        padding: const EdgeInsets.symmetric(horizontal: Msg.s4),
                        itemCount: filtered.length,
                        separatorBuilder: (_, __) =>
                            const SizedBox(width: Msg.s3),
                        itemBuilder: (_, i) {
                          final card = filtered[i];
                          return card.kind == 'consult'
                              ? ConsultationCard(
                                  card: card, onTap: () => _open(card))
                              : LiveEventCard(
                                  card: card, onTap: () => _open(card));
                        },
                      ),
                    ));
                  }
                  sections.add(const SizedBox(height: Msg.s3));
                }
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
                  children: sections,
                );
              },
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

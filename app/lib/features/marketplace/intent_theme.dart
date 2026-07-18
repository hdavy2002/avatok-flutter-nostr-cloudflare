import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/listings_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../explore/widgets.dart';

/// Marketplace intent theming — the SHARED pale palette (M-D6, owner decision
/// 2026-07-18) consumed by the browse card AND all five detail templates.
///
/// The app ships a DARK shell (`AD` — near-black surfaces, hairline borders).
/// The owner wants "light pale colours" on marketplace cards; M-D6 resolves
/// that as a **tinted card face**, luminance-flipped for dark mode: the card
/// stays on the near-black `AD.card` surface, but gets a soft PALE-TINTED
/// border, a pale accent chip and a subtle pale accent per intent. It reads as
/// a pale FAMILY on the dark shell — NOT a white island, NOT a light zone, and
/// never a bright fill.
///
/// Every colour here is built from / harmonises with the `AD` design system —
/// specifically the `AvatarFamily` chip palette (`avatok_dark.dart:201`), whose
/// `chipInk` (pale ink) and `chipBg` (dark tinted) values are already the app's
/// canonical "pale tint on near-black" language. This is deliberately NOT a
/// parallel design system: the intent tints are drawn straight from that family
/// so a marketplace chip and an avatar chip feel like the same app.

/// The five listing intents (§2 of the AI-listing plan): every category is one
/// intent + a field schema. Drives card tint, chip and detail template.
enum ListingIntent { sell, rent, book, lead, profile }

/// Parse a stored intent string (case-insensitive). Unknown / null defaults to
/// [ListingIntent.sell] — the commonest commerce case and a safe fallback.
ListingIntent parseIntent(String? raw) {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'rent':
      return ListingIntent.rent;
    case 'book':
      return ListingIntent.book;
    case 'lead':
      return ListingIntent.lead;
    case 'profile':
      return ListingIntent.profile;
    case 'sell':
    default:
      return ListingIntent.sell;
  }
}

/// The pale, dark-adapted palette for one intent.
///
/// - [tint]      — the soft PALE accent (icons, small highlights). A low-lum
///                 pastel readable on `AD.card`, never used as a large fill.
/// - [tintBorder]— the pale-tinted HAIRLINE for the card edge. Same border
///                 language as `AD.borderCard` (0xFF26262D) but nudged toward
///                 the hue so the tint reads as a soft glow on the edge.
/// - [chipBg]/[chipFg] — the intent chip: dark tinted background + pale ink,
///                 exactly the `AvatarFamily` chip recipe.
/// - [icon]      — the Phosphor glyph for the intent.
class IntentTheme {
  final ListingIntent intent;
  final String label;
  final Color tint;
  final Color tintBorder;
  final Color chipBg;
  final Color chipFg;
  final IconData icon;

  const IntentTheme({
    required this.intent,
    required this.label,
    required this.tint,
    required this.tintBorder,
    required this.chipBg,
    required this.chipFg,
    required this.icon,
  });

  /// The palette for [intent].
  static IntentTheme of(ListingIntent intent) => _all[intent]!;

  /// Convenience: theme straight from a stored intent string.
  static IntentTheme parse(String? raw) => of(parseIntent(raw));

  // The five hues — each drawn from an `AvatarFamily` in `avatok_dark.dart` so
  // they belong to the same pale-on-near-black family, not a rainbow. Reasoning
  // per intent (chosen to be soft, distinguishable AND semantically apt):
  //
  //   SELL    → pale GOLD (butter family). Money / a price tag / the warmth of
  //             "for sale". Gold reads as value without shouting.
  //   RENT    → pale AQUA-TEAL (aqua family). Cool and cyclical — a recurring
  //             per-month rate, calm and steady, distinct from SELL's warmth.
  //   BOOK    → pale LILAC (lilac family). Calendar / appointment time; echoes
  //             the app's own `AD.tabCalls` purple and `AD.iconMic` violet.
  //   LEAD    → pale SKY BLUE (sky family). Outreach / questions / "ask me";
  //             harmonises with `AD.iconSearch` (0xFF6FA8E8), the app's inquiry
  //             blue.
  //   PROFILE → pale ROSE (rose family). A person — human warmth, screening a
  //             candidate / freelancer / match.
  //
  // Warm (SELL gold, PROFILE rose) and cool (RENT aqua, BOOK lilac, LEAD sky)
  // are interleaved so adjacent intents in a grid never blur together, while
  // every value sits at the same low luminance so the set reads as one family.
  static final Map<ListingIntent, IntentTheme> _all = {
    ListingIntent.sell: IntentTheme(
      intent: ListingIntent.sell,
      label: 'For sale',
      tint: const Color(0xFFEBD48A), // butter chipInk — pale gold
      tintBorder: const Color(0xFF3D361F), // gold-tinted hairline
      chipBg: const Color(0xFF544625), // butter chipBg
      chipFg: const Color(0xFFEBD48A),
      icon: PhosphorIcons.tag(PhosphorIconsStyle.fill),
    ),
    ListingIntent.rent: IntentTheme(
      intent: ListingIntent.rent,
      label: 'To rent',
      tint: const Color(0xFF8AE3D6), // aqua chipInk — pale teal
      tintBorder: const Color(0xFF20433D), // teal-tinted hairline
      chipBg: const Color(0xFF1E4A44), // aqua chipBg
      chipFg: const Color(0xFF8AE3D6),
      icon: PhosphorIcons.key(PhosphorIconsStyle.fill),
    ),
    ListingIntent.book: IntentTheme(
      intent: ListingIntent.book,
      label: 'Book',
      tint: const Color(0xFFCBBCF2), // lilac chipInk — pale violet
      tintBorder: const Color(0xFF2E2749), // lilac-tinted hairline
      chipBg: const Color(0xFF3A2F63), // lilac chipBg
      chipFg: const Color(0xFFCBBCF2),
      icon: PhosphorIcons.calendarCheck(PhosphorIconsStyle.fill),
    ),
    ListingIntent.lead: IntentTheme(
      intent: ListingIntent.lead,
      label: 'Enquire',
      tint: const Color(0xFFA8CBEE), // sky chipInk — pale blue
      tintBorder: const Color(0xFF25384D), // sky-tinted hairline
      chipBg: const Color(0xFF2A425C), // sky chipBg
      chipFg: const Color(0xFFA8CBEE),
      icon: PhosphorIcons.chatCircle(PhosphorIconsStyle.fill),
    ),
    ListingIntent.profile: IntentTheme(
      intent: ListingIntent.profile,
      label: 'Profile',
      tint: const Color(0xFFF0B3C9), // rose chipInk — pale rose
      tintBorder: const Color(0xFF432936), // rose-tinted hairline
      chipBg: const Color(0xFF553144), // rose chipBg
      chipFg: const Color(0xFFF0B3C9),
      icon: PhosphorIcons.userCircle(PhosphorIconsStyle.fill),
    ),
  };
}

// ─────────────────────────────────────────────────────────────── price ──────

/// Currency symbol for an ISO code (major-unit prefix). Falls back to the code
/// itself with a trailing space for anything uncommon ("AED 500").
String _currencySymbol(String code) {
  switch (code) {
    case 'USD':
    case 'CAD':
    case 'AUD':
    case 'SGD':
    case 'NZD':
    case 'HKD':
    case 'MXN':
      return '\$';
    case 'INR':
      return '₹'; // ₹
    case 'PKR':
    case 'NPR':
    case 'LKR':
      return '₨'; // ₨
    case 'EUR':
      return '€'; // €
    case 'GBP':
      return '£'; // £
    case 'JPY':
    case 'CNY':
      return '¥'; // ¥
    case 'BDT':
      return '৳'; // ৳
    case 'AED':
      return 'AED ';
    case 'SAR':
      return 'SAR ';
    default:
      return '$code ';
  }
}

/// South-Asian lakh/crore grouping vs Western K/M/B — driven by the currency.
bool _isLakhCrore(String code) =>
    code == 'INR' || code == 'PKR' || code == 'NPR' || code == 'LKR' || code == 'BDT';

String _decTrim(double x) {
  final s = x.toStringAsFixed(1);
  return s.endsWith('.0') ? s.substring(0, s.length - 2) : s;
}

/// Thousands-grouped integer ("5,200"). Western grouping — good enough for the
/// small residual (< 1 lakh / < 10K) that isn't compacted to L/Cr/K.
String _grouped(num v) {
  final s = v.round().abs().toString();
  final b = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) b.write(',');
    b.write(s[i]);
  }
  return b.toString();
}

/// Compact a major-unit amount for its currency:
/// INR 5,200,000 → "52L";  USD 5,200,000 → "5.2M";  500 → "500".
String _compact(num v, String code) {
  final neg = v < 0;
  final a = v.abs();
  String out;
  if (_isLakhCrore(code)) {
    if (a >= 10000000) {
      out = '${_decTrim(a / 10000000)}Cr';
    } else if (a >= 100000) {
      out = '${_decTrim(a / 100000)}L';
    } else {
      out = _grouped(a);
    }
  } else {
    if (a >= 1000000000) {
      out = '${_decTrim(a / 1000000000)}B';
    } else if (a >= 1000000) {
      out = '${_decTrim(a / 1000000)}M';
    } else if (a >= 10000) {
      out = '${_decTrim(a / 1000)}K';
    } else {
      out = _grouped(a);
    }
  }
  return neg ? '-$out' : out;
}

/// A bare amount with its currency symbol ("₹52L", "$500").
///
/// [currencyDisplay] maps to `ListingCard.currency` (the listing's
/// `currency_display`), where commerce listings store **real currency in major
/// units** (see `ListingCard.displayPrice` — "3000 INR"). The AvaCoin
/// convention (`fmtCoins`: 1 USD = 100 coins) is honoured when the currency is
/// explicitly a coin sentinel (`COINS`/`AVACOIN`) — then [price] is divided by
/// 100 and shown as USD, matching `ListingCard.money(coins)`.
String _amount(int price, String? currencyDisplay) {
  final code =
      (currencyDisplay == null || currencyDisplay.trim().isEmpty) ? 'USD' : currencyDisplay.trim().toUpperCase();
  if (code == 'COINS' || code == 'AVACOIN' || code == 'COIN') {
    return '\$${_compact(price / 100.0, 'USD')}';
  }
  return '${_currencySymbol(code)}${_compact(price, code)}';
}

/// Render a price with the correct SEMANTICS per §4.1.
///
/// | priceSemantics | example         |
/// |----------------|-----------------|
/// | `asking`       | `₹52L` / `$500` |
/// | `per_month`    | `$25/mo`        |
/// | `from`         | `from $500`     |
/// | `range`        | `$500 – $900`   |
/// | `none`         | `` (job seeker) |
///
/// [range] needs an upper bound; pass [maxPrice] for a real range, otherwise it
/// degrades to `from <price>`. A non-positive [price] renders "Free" for the
/// paid semantics (asking / per_month / from), matching `ListingCard`'s
/// free-listing convention.
String priceLabel(
  int price,
  String? currencyDisplay,
  String priceSemantics, {
  int? maxPrice,
}) {
  switch (priceSemantics.trim().toLowerCase()) {
    case 'none':
      return '';
    case 'range':
      if (maxPrice != null && maxPrice > price) {
        return '${_amount(price, currencyDisplay)} – ${_amount(maxPrice, currencyDisplay)}';
      }
      if (price <= 0) return '';
      return 'from ${_amount(price, currencyDisplay)}';
    case 'from':
      if (price <= 0) return 'Free';
      return 'from ${_amount(price, currencyDisplay)}';
    case 'per_month':
      if (price <= 0) return 'Free';
      return '${_amount(price, currencyDisplay)}/mo';
    case 'asking':
    default:
      if (price <= 0) return 'Free';
      return _amount(price, currencyDisplay);
  }
}

// ─────────────────────────────────────────────────────── marketplace card ───

/// The shared pale marketplace card (§4.1) — a PURE presentational widget: no
/// API calls, no navigation, so browse and any grid can reuse it. All actions
/// (tap, favourite) are callbacks the parent owns.
///
/// Card face = `AD.card` (near-black) with the intent's [IntentTheme.tintBorder]
/// pale-tinted edge; the tint also shows in the intent chip and the small accent
/// glyphs — never as a bright fill (M-D6).
///
/// Intended for a fixed-extent grid cell (like `ListingCardTile`): the cover
/// takes the flexible top space, so give the card a bounded height.
class MarketplaceCard extends StatelessWidget {
  final ListingCard card;

  /// Tapped anywhere on the card body.
  final VoidCallback onTap;

  /// Explicit intent. When null it is resolved from the card's own
  /// `marketType` / `kind` via [parseIntent] (defaults to SELL). Parallel
  /// agents that read the real intent off `attrs` can pass it directly.
  final ListingIntent? intent;

  /// Price semantics for this listing's category (§4.1). Defaults to `asking`.
  final String priceSemantics;

  /// Optimistic favourite toggle. Called with the DESIRED new state
  /// (`!card.favorited`); the parent owns the truth and rebuilds. Heart is
  /// hidden when null.
  final ValueChanged<bool>? onFavToggle;

  const MarketplaceCard({
    super.key,
    required this.card,
    required this.onTap,
    this.intent,
    this.priceSemantics = 'asking',
    this.onFavToggle,
  });

  @override
  Widget build(BuildContext context) {
    final it = IntentTheme.of(intent ?? parseIntent(card.marketType ?? card.kind));
    final reviewN = card.reviewCount > 0 ? card.reviewCount : card.ratingCount;
    final label = priceLabel(card.price, card.currency, priceSemantics);
    final free = card.price <= 0;

    return GestureDetector(
      onTap: onTap,
      child: Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: BorderRadius.circular(AD.rListCard),
          // The pale tint reads as a soft glow on the edge.
          border: Border.all(color: it.tintBorder, width: 1),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Stack(children: [
              Positioned.fill(
                child: CoverImage(
                  url: card.coverUrl,
                  seed: card.id.hashCode,
                  radius: BorderRadius.zero,
                ),
              ),
              // Intent chip — pale tint on dark, top-left.
              Positioned(left: 8, top: 8, child: _IntentChip(theme: it)),
              // NEW (<48h) — pale-tinted, next to the intent chip.
              if (card.isNew)
                Positioned(left: 8, top: 38, child: _NewBadge(theme: it)),
              // Favourite heart — optimistic, parent owns state.
              if (onFavToggle != null)
                Positioned(
                  right: 6,
                  top: 6,
                  child: _FavHeart(
                    favorited: card.favorited,
                    onTap: () => onFavToggle!(!card.favorited),
                  ),
                ),
            ]),
          ),
          Container(height: 1, color: it.tintBorder),
          Padding(
            padding: const EdgeInsets.fromLTRB(10, 8, 10, 9),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(card.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ADText.rowName()),
                if (card.oneLiner.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(card.oneLiner,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: ADText.preview(c: AD.textSecondary)),
                ],
                const SizedBox(height: 6),
                Row(children: [
                  if (label.isNotEmpty)
                    Flexible(
                      child: Text(label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          // Free → the app's online-green ink; else the pale
                          // intent tint so price carries the family colour.
                          style: ADText.rowName(c: free ? AD.online : it.tint)),
                    ),
                  const Spacer(),
                  RatingStars(rating: card.ratingAvg, count: reviewN, size: 13),
                ]),
                if (_hasLocation) ...[
                  const SizedBox(height: 4),
                  Row(children: [
                    if (card.country != null) ...[
                      Text(flagEmoji(card.country),
                          style: const TextStyle(fontSize: 12)),
                      const SizedBox(width: 4),
                    ],
                    if ((card.location ?? '').isNotEmpty)
                      Expanded(
                        child: Text(card.location!,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: ADText.statCaption(c: AD.textSecondary)),
                      ),
                  ]),
                ],
              ],
            ),
          ),
        ]),
      ),
    );
  }

  bool get _hasLocation =>
      card.country != null || (card.location ?? '').isNotEmpty;
}

/// The intent pill — dark tinted background + pale ink + glyph.
class _IntentChip extends StatelessWidget {
  final IntentTheme theme;
  const _IntentChip({required this.theme});
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: theme.chipBg,
        borderRadius: BorderRadius.circular(100),
        border: Border.all(color: theme.tintBorder, width: 1),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        PhosphorIcon(theme.icon, size: 11, color: theme.chipFg),
        const SizedBox(width: 4),
        Text(theme.label.toUpperCase(),
            style: ADText.statCaption(c: theme.chipFg)),
      ]),
    );
  }
}

/// "NEW" (<48h) — pale-tinted, subtle.
class _NewBadge extends StatelessWidget {
  final IntentTheme theme;
  const _NewBadge({required this.theme});
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: AD.card,
        borderRadius: BorderRadius.circular(100),
        border: Border.all(color: theme.tintBorder, width: 1),
      ),
      child: Text('NEW', style: ADText.statCaption(c: theme.tint)),
    );
  }
}

/// Favourite heart — filled coral when on, hairline outline when off.
class _FavHeart extends StatelessWidget {
  final bool favorited;
  final VoidCallback onTap;
  const _FavHeart({required this.favorited, required this.onTap});
  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        width: 30,
        height: 30,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: AD.scrim,
          shape: BoxShape.circle,
        ),
        child: PhosphorIcon(
          favorited
              ? PhosphorIcons.heart(PhosphorIconsStyle.fill)
              : PhosphorIcons.heart(PhosphorIconsStyle.bold),
          size: 16,
          color: favorited ? AD.danger : Colors.white,
        ),
      ),
    );
  }
}

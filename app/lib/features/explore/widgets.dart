import 'dart:io';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar_cache.dart';
import '../../core/listings_api.dart';
import '../../core/ui/zine.dart';

/// Country code → flag emoji ("IN" → 🇮🇳).
String flagEmoji(String? cc) {
  if (cc == null || cc.length != 2) return '';
  final u = cc.toUpperCase();
  return String.fromCharCodes([0x1F1E6 + u.codeUnitAt(0) - 65, 0x1F1E6 + u.codeUnitAt(1) - 65]);
}

String fmtCoins(int coins) =>
    coins == 0 ? 'Free' : '\$${(coins / 100).toStringAsFixed(coins % 100 == 0 ? 0 : 2)}';

String fmtWhen(int? ms) {
  if (ms == null) return '';
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  final hh = d.hour % 12 == 0 ? 12 : d.hour % 12;
  final mm = d.minute.toString().padLeft(2, '0');
  return '${months[d.month - 1]} ${d.day}, $hh:$mm ${d.hour >= 12 ? 'PM' : 'AM'}';
}

/// Cover image via the standard CF-AVIF + on-device cache pipeline.
/// Zine treatment: ink-bordered rounded container; fallback = flat poster
/// accent fill (no gradients, ever).
class CoverImage extends StatelessWidget {
  final String? url;
  final int seed;
  final double? width, height;
  final BorderRadius? radius;
  const CoverImage({super.key, required this.url, this.seed = 0, this.width, this.height, this.radius});

  @override
  Widget build(BuildContext context) {
    final r = radius ?? BorderRadius.circular(Zine.rSm);
    final accent = Zine.accents[seed.abs() % Zine.accents.length];
    Widget frame(Widget? child, {Color? fill}) => Container(
          width: width, height: height,
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(color: fill ?? Zine.card, borderRadius: r, border: Zine.border),
          child: child,
        );
    final fallback = frame(
      Center(
        child: PhosphorIcon(PhosphorIcons.image(PhosphorIconsStyle.bold),
            size: 26, color: accent == Zine.coral ? Colors.white : Zine.ink),
      ),
      fill: accent,
    );
    final u = url;
    if (u == null || u.isEmpty) return fallback;
    return FutureBuilder<File?>(
      future: AvatarCache.getAny(u, 800),
      builder: (context, snap) {
        final f = snap.data;
        if (f == null) return fallback;
        return frame(
          Image.file(f, width: width, height: height, fit: BoxFit.cover, errorBuilder: (_, __, ___) => fallback),
        );
      },
    );
  }
}

class RatingStars extends StatelessWidget {
  final double? rating;
  final int count;
  final double size;
  const RatingStars({super.key, required this.rating, this.count = 0, this.size = 14});
  @override
  Widget build(BuildContext context) {
    if (rating == null || count == 0) return const SizedBox.shrink();
    return Row(mainAxisSize: MainAxisSize.min, children: [
      PhosphorIcon(PhosphorIcons.star(PhosphorIconsStyle.fill), color: Zine.coral, size: size + 1),
      const SizedBox(width: 3),
      Text('${rating!.toStringAsFixed(1)} ($count)',
          style: ZineText.value(size: size - 2, color: Zine.inkSoft, weight: FontWeight.w800)),
    ]);
  }
}

/// The marketplace card — zine cut-out: card fill, thick ink border, hard
/// shadow; photo, title, $price, date, country flag, one-liner,
/// "🔥 400 joined" social proof (spec §Flutter/AvaExplore).
class ListingCardTile extends StatelessWidget {
  final ListingCard card;
  final VoidCallback onTap;
  const ListingCardTile({super.key, required this.card, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final live = card.status == 'live';
    return GestureDetector(
      onTap: onTap,
      child: Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          color: Zine.card,
          borderRadius: BorderRadius.circular(Zine.rSm),
          border: Zine.border,
          boxShadow: Zine.shadowXs,
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Stack(children: [
              Positioned.fill(
                child: CoverImage(url: card.coverUrl, seed: card.id.hashCode, radius: BorderRadius.zero),
              ),
              // LIVE → coral sticker (white text allowed on coral); else category tag.
              Positioned(left: 8, top: 8, child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                decoration: BoxDecoration(
                  color: live ? Zine.coral : Zine.card,
                  borderRadius: BorderRadius.circular(100),
                  border: Border.all(color: Zine.ink, width: 2),
                  boxShadow: Zine.shadowXs,
                ),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  if (live) ...[
                    Container(width: 6, height: 6, decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle)),
                    const SizedBox(width: 4),
                  ],
                  Text((live ? 'LIVE' : card.category).toUpperCase(),
                      style: ZineText.tag(size: 10, color: live ? Colors.white : Zine.ink)),
                ]),
              )),
              if (card.adultsOnly)
                Positioned(right: 8, top: 8, child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                  decoration: BoxDecoration(
                    color: Zine.coral,
                    borderRadius: BorderRadius.circular(100),
                    border: Border.all(color: Zine.ink, width: 2),
                  ),
                  child: Text('18+', style: ZineText.tag(size: 9.5, color: Colors.white)),
                )),
            ]),
          ),
          Container(height: Zine.bw, color: Zine.ink),
          Padding(
            padding: const EdgeInsets.fromLTRB(10, 8, 10, 9),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text(card.title, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ZineText.value(size: 13.5, weight: FontWeight.w800)),
              if (card.oneLiner.isNotEmpty) ...[
                const SizedBox(height: 1),
                Text(card.oneLiner, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ZineText.sub(size: 11)),
              ],
              const SizedBox(height: 4),
              Row(children: [
                if (card.promoPct > 0) ...[
                  Text(fmtCoins(card.price), style: ZineText.sub(size: 11, color: Zine.inkMute)
                      .copyWith(decoration: TextDecoration.lineThrough)),
                  const SizedBox(width: 4),
                ],
                // Money = Nunito 900; free → mint ink.
                Flexible(child: Text(card.priceLabel,
                    maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ZineText.value(size: 14,
                        color: card.effectivePrice == 0 ? Zine.mintInk : Zine.ink,
                        weight: FontWeight.w900))),
                const Spacer(),
                if (card.country != null) Text(flagEmoji(card.country), style: const TextStyle(fontSize: 12)),
                const SizedBox(width: 4),
                RatingStars(rating: card.ratingAvg, count: card.ratingCount, size: 13),
              ]),
              const SizedBox(height: 2),
              Row(children: [
                if (card.startsAt != null)
                  Expanded(child: Text(fmtWhen(card.startsAt).toUpperCase(),
                      maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: ZineText.tag(size: 9, color: Zine.inkSoft))),
                if (card.joinedCount > 0)
                  Text('🔥 ${card.joinedCount} joined', style: ZineText.sub(size: 10)),
              ]),
            ]),
          ),
        ]),
      ),
    );
  }
}

import 'dart:io';

import 'package:flutter/material.dart';

import '../../core/avatar_cache.dart';
import '../../core/listings_api.dart';
import '../../core/theme.dart';

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
class CoverImage extends StatelessWidget {
  final String? url;
  final int seed;
  final double? width, height;
  final BorderRadius? radius;
  const CoverImage({super.key, required this.url, this.seed = 0, this.width, this.height, this.radius});

  @override
  Widget build(BuildContext context) {
    final r = radius ?? BorderRadius.circular(16);
    final fallback = Container(
      width: width, height: height,
      decoration: BoxDecoration(gradient: AvaColors.thumbGradients[seed % AvaColors.thumbGradients.length], borderRadius: r),
    );
    final u = url;
    if (u == null || u.isEmpty) return fallback;
    return FutureBuilder<File?>(
      future: AvatarCache.get(u, 800),
      builder: (context, snap) {
        final f = snap.data;
        if (f == null) return fallback;
        return ClipRRect(
          borderRadius: r,
          child: Image.file(f, width: width, height: height, fit: BoxFit.cover, errorBuilder: (_, __, ___) => fallback),
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
      Icon(Icons.star_rounded, color: const Color(0xFFFFB400), size: size + 2),
      const SizedBox(width: 2),
      Text('${rating!.toStringAsFixed(1)} ($count)',
          style: TextStyle(fontSize: size - 2, fontWeight: FontWeight.w600, color: AvaColors.sub)),
    ]);
  }
}

/// The marketplace card: photo, title, $price, date, country flag, one-liner,
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
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: Stack(children: [
            Positioned.fill(child: CoverImage(url: card.coverUrl, seed: card.id.hashCode)),
            Positioned(left: 8, top: 8, child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(color: live ? AvaColors.coral : Colors.white, borderRadius: BorderRadius.circular(10)),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                if (live) ...[
                  Container(width: 6, height: 6, decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle)),
                  const SizedBox(width: 4),
                ],
                Text(live ? 'LIVE' : card.category,
                    style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, color: live ? Colors.white : AvaColors.ink)),
              ]),
            )),
            if (card.adultsOnly)
              Positioned(right: 8, top: 8, child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(8)),
                child: const Text('18+', style: TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.w800)),
              )),
          ]),
        ),
        const SizedBox(height: 8),
        Text(card.title, maxLines: 1, overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14)),
        if (card.oneLiner.isNotEmpty) ...[
          const SizedBox(height: 2),
          Text(card.oneLiner, maxLines: 1, overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: AvaColors.sub, fontSize: 11.5)),
        ],
        const SizedBox(height: 4),
        Row(children: [
          if (card.promoPct > 0) ...[
            Text(fmtCoins(card.price), style: const TextStyle(
                fontSize: 11.5, color: AvaColors.sub, decoration: TextDecoration.lineThrough)),
            const SizedBox(width: 4),
          ],
          Text(card.priceLabel, style: TextStyle(fontWeight: FontWeight.w800, fontSize: 14,
              color: card.effectivePrice == 0 ? AvaColors.brand : AvaColors.ink)),
          const Spacer(),
          if (card.country != null) Text(flagEmoji(card.country), style: const TextStyle(fontSize: 13)),
          const SizedBox(width: 4),
          RatingStars(rating: card.ratingAvg, count: card.ratingCount),
        ]),
        const SizedBox(height: 2),
        Row(children: [
          if (card.startsAt != null)
            Expanded(child: Text(fmtWhen(card.startsAt), maxLines: 1, overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: AvaColors.sub, fontSize: 11))),
          if (card.joinedCount > 0)
            Text('🔥 ${card.joinedCount} joined', style: const TextStyle(fontSize: 10.5, color: AvaColors.sub, fontWeight: FontWeight.w600)),
        ]),
      ]),
    );
  }
}

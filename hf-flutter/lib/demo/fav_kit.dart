import 'package:flutter/material.dart';

import 'desi.dart';
import 'theme.dart';
import 'widgets.dart';

/// [HF-APP-DESI-3] Favourites screen pieces, built to the owner-approved canvas previews "3 · Favourites" and
/// "3b · Favourites, nothing saved yet" (2026-10-22). Shared by the demo and the real Favourites screens.

/// Pink hero "Mere fraands" with the saved count and the sakhi art. [compact] drops the art and the line (empty state).
class FavHeader extends StatelessWidget {
  const FavHeader({super.key, required this.count, this.compact = false});
  final int count;
  final bool compact;
  @override
  Widget build(BuildContext context) => DesiHero(
        eyebrow: compact ? 'Favourites' : 'Favourites · $count saved',
        title: 'Mere fraands',
        sub: compact ? null : 'Everyone you saved with a ♥, in one place. Call the ones who are online.',
        ghost: 'Dil',
        tone: DesiTone.rani,
        minHeight: compact ? 150 : 214,
        art: compact ? null : const SizedBox(width: 128, height: 150, child: Art('favourites/empty-sakhi.webp', fit: BoxFit.contain)),
      );
}

/// Plum "Online right now" + lavender "Saved" tiles.
class FavStats extends StatelessWidget {
  const FavStats({super.key, required this.online, required this.saved});
  final int online;
  final int saved;
  @override
  Widget build(BuildContext context) => DesiKpiGrid(children: [
        DesiKpi(label: 'Online right now', value: '$online', sub: 'ready for a call', tone: DesiTone.plum),
        DesiKpi(label: 'Saved', value: '$saved', sub: 'fraands and reels', tone: DesiTone.lav),
      ]);
}

enum FavFilter { all, online, offline }

/// All / Online / Offline pills; the chosen one plum.
class FavFilterPills extends StatelessWidget {
  const FavFilterPills({super.key, required this.value, required this.onPick});
  final FavFilter value;
  final ValueChanged<FavFilter> onPick;
  @override
  Widget build(BuildContext context) {
    const labels = {FavFilter.all: 'All', FavFilter.online: 'Online', FavFilter.offline: 'Offline'};
    return Wrap(spacing: 8, runSpacing: 8, children: [
      for (final f in FavFilter.values)
        Semantics(
          button: true,
          selected: value == f,
          child: Material(
            color: value == f ? C.maroon : C.white,
            shape: StadiumBorder(side: BorderSide(color: value == f ? C.maroon : C.line, width: 1.5)),
            child: InkWell(
              key: ValueKey('fav-filter-${f.name}'),
              customBorder: const StadiumBorder(),
              onTap: () => onPick(f),
              child: Container(
                constraints: const BoxConstraints(minHeight: 44),
                padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 11),
                child: Text(labels[f]!, style: t(15, color: value == f ? C.white : C.maroon, w: FontWeight.w800)),
              ),
            ),
          ),
        ),
    ]);
  }
}

const _edges = [Color(0xFFF8C4D9), Color(0xFFDDD2FB), Color(0xFFB9E2E5), Color(0xFFF3DFB3)];

/// One saved card: photo with name, Online/Offline label and a heart on it; rate tag and Call (online) or Book below.
class FavCard extends StatelessWidget {
  const FavCard({
    super.key,
    required this.index,
    required this.image,
    required this.name,
    required this.sub,
    required this.online,
    required this.rate,
    required this.onOpen,
    required this.onHeart,
    required this.onCall,
    required this.onBook,
    this.heartLabel = 'Remove from favourites',
  });
  final int index;
  final Widget image;
  final String name;
  final String sub;
  final bool online;
  final int rate;
  final VoidCallback onOpen;
  final VoidCallback? onHeart;
  final VoidCallback onCall;
  final VoidCallback onBook;
  final String heartLabel;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: C.white,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: _edges[index % _edges.length], width: 2),
        boxShadow: const [BoxShadow(color: Color(0x404A1747), offset: Offset(0, 10), blurRadius: 24, spreadRadius: -12)],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(20),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Expanded(
            child: GestureDetector(
              onTap: onOpen,
              child: Stack(fit: StackFit.expand, children: [
                ColorFiltered(
                  colorFilter: online
                      ? const ColorFilter.mode(Color(0x00000000), BlendMode.dst)
                      : const ColorFilter.matrix([.86, .1, .04, 0, 0, .06, .9, .04, 0, 0, .06, .1, .84, 0, 0, 0, 0, 0, 1, 0]),
                  child: image,
                ),
                const Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 90,
                  child: DecoratedBox(decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0x002B1530), Color(0xD92B1530)]))),
                ),
                Positioned(
                  left: 10,
                  top: 10,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
                    decoration: BoxDecoration(color: online ? C.onlineBg : const Color(0xFFF3EEF2), borderRadius: BorderRadius.circular(999)),
                    child: Text(online ? '● Online' : 'Offline', style: t(14, color: online ? C.onlineInk : C.muted, w: FontWeight.w800)),
                  ),
                ),
                Positioned(
                  right: 4,
                  top: 4,
                  child: Tooltip(
                    message: heartLabel,
                    child: GestureDetector(
                      onTap: onHeart,
                      behavior: HitTestBehavior.opaque,
                      child: SizedBox(
                        width: 48,
                        height: 48,
                        child: Center(
                          child: Container(
                            width: 40,
                            height: 40,
                            decoration: const BoxDecoration(color: C.white, shape: BoxShape.circle),
                            child: const Icon(Icons.favorite_rounded, color: C.rani, size: 20),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                Positioned(
                  left: 10,
                  right: 10,
                  bottom: 8,
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(16, color: C.white, w: FontWeight.w800)),
                    if (sub.isNotEmpty) Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(14, color: C.white, w: FontWeight.w600)),
                  ]),
                ),
              ]),
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(8),
            child: Row(children: [
              Flexible(child: FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: DesiChip('₹$rate/min', tone: DesiTone.gold))),
              const SizedBox(width: 6),
              _Mini(online ? 'Call' : 'Book', primary: online, onTap: online ? onCall : onBook),
            ]),
          ),
        ]),
      ),
    );
  }
}

class _Mini extends StatelessWidget {
  const _Mini(this.label, {required this.primary, required this.onTap});
  final String label;
  final bool primary;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        child: Material(
          color: C.clear,
          child: InkWell(
            customBorder: const StadiumBorder(),
            onTap: onTap,
            child: Container(
              constraints: const BoxConstraints(minHeight: 44, minWidth: 56),
              alignment: Alignment.center,
              padding: const EdgeInsets.symmetric(horizontal: 14),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(999),
                gradient: primary ? const LinearGradient(colors: [Color(0xFFD81B72), Color(0xFFF0408F)]) : null,
                color: primary ? null : C.white,
                border: primary ? null : Border.all(color: C.line, width: 1.5),
              ),
              child: Text(label, style: t(14, color: primary ? C.white : C.maroon, w: FontWeight.w800)),
            ),
          ),
        ),
      );
}

/// Two-column grid of [FavCard]s (shrink-wrapped, for use inside a ListView).
class FavGrid extends StatelessWidget {
  const FavGrid({super.key, required this.cards});
  final List<Widget> cards;
  @override
  Widget build(BuildContext context) => GridView.count(
        crossAxisCount: 2,
        mainAxisSpacing: 12,
        crossAxisSpacing: 12,
        childAspectRatio: .6,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        padding: EdgeInsets.zero,
        children: cards,
      );
}

/// Gold tip card with a hibiscus.
class FavTip extends StatelessWidget {
  const FavTip({super.key});
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(22),
          border: Border.all(color: const Color(0xFFF3DFB3)),
          gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.white, C.goldtint]),
        ),
        child: Row(children: [
          const Hibiscus(size: 36),
          const SizedBox(width: 12),
          Expanded(child: Text('Tap ♥ on any reel to save that influencer here.', style: t(15, w: FontWeight.w700))),
        ]),
      );
}

/// White card with the sakhi art: "No favourites yet" and an orange Watch reels button.
class FavEmptyCard extends StatelessWidget {
  const FavEmptyCard({super.key, required this.onWatch, this.title = 'No favourites yet', this.line = 'Tap ♥ on a reel to save it here.', this.button = 'WATCH REELS'});
  final VoidCallback onWatch;
  final String title;
  final String line;
  final String button;
  @override
  Widget build(BuildContext context) => DesiCard(
        corner: DesiCorner.marigold,
        padding: const EdgeInsets.fromLTRB(18, 20, 18, 22),
        child: Column(children: [
          const SizedBox(width: 200, height: 220, child: Art('favourites/empty-sakhi.webp', fit: BoxFit.contain)),
          const SizedBox(height: 4),
          Text(title, textAlign: TextAlign.center, style: t(22, w: FontWeight.w800)),
          const SizedBox(height: 4),
          Text(line, textAlign: TextAlign.center, style: t(16, color: C.muted, w: FontWeight.w700)),
          const SizedBox(height: 14),
          DesiButton(button, kind: DesiButtonKind.gold, onTap: onWatch),
        ]),
      );
}

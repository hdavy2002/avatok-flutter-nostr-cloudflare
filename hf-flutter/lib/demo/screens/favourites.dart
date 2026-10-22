import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/repos/favourites_repo.dart';
import '../../data/services.dart';
import '../data.dart';
import '../desi.dart';
import '../fav_kit.dart';
import '../favourites_real.dart';
import '../presence_bridge.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets.dart';
import 'sheets.dart';

/// Favourites: reels the fan saved with ♥ (HF-REEL-7).
class FavouritesScreen extends StatelessWidget {
  const FavouritesScreen({super.key, this.repo});

  /// Tests pass a repo on a fake API; the app uses [Services]. Real mode only (HF-WIRE-9).
  final FavouritesRepo? repo;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([demo, Services.instance.authAccount]),
    builder: (context, _) => (PresenceBridge.real ? Services.instance.isSignedIn : demo.signedIn)
        ? _authenticated(context)
        : const AccountInvitation(reason: 'Save your favourite reels'),
  );

  Widget _authenticated(BuildContext context) {
    if (PresenceBridge.real) return RealFavourites(key: ValueKey(Services.instance.user?.id), repo: repo ?? Services.instance.favouritesRepo); // [HF-WIRE-9]
    return const _DemoFavourites();
  }
}

/// [HF-APP-DESI-3] Demo favourites to the approved canvas: pink hero, online/saved tiles, filter pills, coloured cards.
class _DemoFavourites extends StatefulWidget {
  const _DemoFavourites();
  @override
  State<_DemoFavourites> createState() => _DemoFavouritesState();
}

class _DemoFavouritesState extends State<_DemoFavourites> {
  FavFilter _filter = FavFilter.all;

  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: C.ivory,
        body: SafeArea(
          child: ListenableBuilder(
            listenable: demo,
            builder: (context, _) {
              final saved = reels.where((r) => demo.isFav(r.id)).toList();
              if (saved.isEmpty) {
                return ListView(padding: const EdgeInsets.fromLTRB(16, 12, 16, 24), children: [
                  const FavHeader(count: 0, compact: true),
                  const SizedBox(height: 14),
                  FavEmptyCard(onWatch: () => context.go('/reels')),
                ]);
              }
              final online = saved.where((r) => r.who.online).length;
              final shown = saved.where((r) => switch (_filter) { FavFilter.all => true, FavFilter.online => r.who.online, FavFilter.offline => !r.who.online }).toList();
              return ListView(padding: const EdgeInsets.fromLTRB(16, 12, 16, 24), children: [
                FavHeader(count: saved.length),
                const SizedBox(height: 14),
                FavStats(online: online, saved: saved.length),
                const SizedBox(height: 14),
                FavFilterPills(value: _filter, onPick: (f) => setState(() => _filter = f)),
                const SizedBox(height: 14),
                FavGrid(cards: [
                  for (var i = 0; i < shown.length; i++)
                    FavCard(
                      index: i,
                      image: _portrait(shown[i].who),
                      name: shown[i].who.name,
                      sub: shown[i].who.niche,
                      online: shown[i].who.online,
                      rate: shown[i].who.rate,
                      onOpen: () => context.push('/profile/${shown[i].who.id}'),
                      onHeart: () => demo.toggleFav(shown[i].id),
                      onCall: () => startCall(context, shown[i].who),
                      onBook: () => context.push('/book/${shown[i].who.id}'),
                    ),
                ]),
                const SizedBox(height: 14),
                const FavTip(),
                const SizedBox(height: 10),
                const DesiMogra(),
              ]);
            },
          ),
        ),
      );

  Widget _portrait(Influencer who) => DecoratedBox(
        decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [who.tones.first, who.tones.last])),
        child: who.portrait == null ? null : Art(who.portrait!, fit: BoxFit.cover, alignment: Alignment.topCenter),
      );
}

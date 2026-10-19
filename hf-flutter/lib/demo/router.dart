import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'screens/booking.dart';
import 'screens/bookings_real.dart'; // [HF-WIRE-8]
import '../data/models/channel.dart';
import 'screens/channels.dart';
import 'screens/call.dart';
import 'screens/favourites.dart';
import 'screens/feed.dart';
import 'screens/influencer.dart';
import 'screens/intro.dart';
import 'screens/me.dart';
import 'screens/money.dart';
import 'screens/profile.dart';
import 'screens/search.dart';
import 'theme.dart';

final rootKey = GlobalKey<NavigatorState>();

/// Every screen of the demo app and where each tap goes. Screens only, dummy data.
final router = GoRouter(
  navigatorKey: rootKey,
  initialLocation: '/splash',
  routes: [
    GoRoute(path: '/splash', builder: (_, __) => const SplashScreen()),
    GoRoute(path: '/intro', builder: (_, __) => const IntroScreen()),
    // Site links (`https://<domain>/h/<slug>`, `/r/<id>`): the same targets core/deep_links.dart opens for taps.
    GoRoute(path: '/h/:slug', redirect: (_, s) => '/profile/${Uri.encodeComponent(s.pathParameters['slug'] ?? '')}'),
    GoRoute(path: '/r/:id', redirect: (_, s) => '/reels?reel=${Uri.encodeQueryComponent(s.pathParameters['id'] ?? '')}'),
    StatefulShellRoute.indexedStack(
      builder: (context, state, shell) => MainShell(shell: shell),
      branches: [
        StatefulShellBranch(routes: [GoRoute(path: '/reels', builder: (_, s) => FeedScreen(reelId: s.uri.queryParameters['reel']))]),
        StatefulShellBranch(routes: [GoRoute(path: '/search', builder: (_, __) => const SearchScreen())]),
        StatefulShellBranch(routes: [GoRoute(path: '/favourites', builder: (_, __) => const FavouritesScreen())]),
        StatefulShellBranch(routes: [GoRoute(path: '/me', builder: (_, __) => const MeScreen())]),
      ],
    ),
    GoRoute(parentNavigatorKey: rootKey, path: '/profile/:id', builder: (_, s) => ProfileScreen(id: s.pathParameters['id']!)),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/book/:id',
      builder: (_, s) => BookingsBridge.real
          ? RealBookScreen(id: s.pathParameters['id']!, day: s.uri.queryParameters['day'], slot: s.uri.queryParameters['slot'])
          : BookScreen(id: s.pathParameters['id']!, day: s.uri.queryParameters['day'], slot: s.uri.queryParameters['slot']),
    ),
    GoRoute(parentNavigatorKey: rootKey, path: '/call/:id', builder: (_, s) => CallScreen(id: s.pathParameters['id']!)),
    GoRoute(parentNavigatorKey: rootKey, path: '/wallet', builder: (_, __) => const WalletScreen()),
    GoRoute(parentNavigatorKey: rootKey, path: '/topup', builder: (_, __) => const TopUpScreen()),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/payment',
      builder: (_, s) => PaymentScreen(
        amount: double.tryParse(s.uri.queryParameters['amount'] ?? '') ?? 500,
        orderId: s.uri.queryParameters['order'],
        creditPaise: int.tryParse(s.uri.queryParameters['credit'] ?? ''),
      ),
    ),
    GoRoute(parentNavigatorKey: rootKey, path: '/payout', builder: (_, __) => const PayoutScreen()),
    GoRoute(parentNavigatorKey: rootKey, path: '/calls', builder: (_, __) => const CallRecordsScreen()),
    GoRoute(parentNavigatorKey: rootKey, path: '/bookings', builder: (_, __) => const BookingsScreen()),
    GoRoute(parentNavigatorKey: rootKey, path: '/settings', builder: (_, __) => const SettingsScreen()),
    GoRoute(parentNavigatorKey: rootKey, path: '/help', builder: (_, __) => const HelpScreen()),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/influencer/join',
      builder: (_, s) => InfluencerJoinScreen(initialStep: int.tryParse(s.uri.queryParameters['step'] ?? '') ?? 0),
    ),
    // [HF-WIRE-3] Channels. `?from=join` keeps the person inside "Join as influencer".
    GoRoute(parentNavigatorKey: rootKey, path: '/inf/channels', builder: (_, __) => const ChannelsListScreen()),
    GoRoute(parentNavigatorKey: rootKey, path: '/inf/channels/add', builder: (_, s) => ChannelPlatformScreen(from: s.uri.queryParameters['from'])),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/inf/channels/add/:platform',
      builder: (_, s) => ChannelConsentScreen(platform: s.pathParameters['platform'] ?? '', from: s.uri.queryParameters['from']),
    ),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/inf/channels/:id/checking',
      builder: (_, s) => ChannelCheckingScreen(id: s.pathParameters['id']!, from: s.uri.queryParameters['from'], initial: s.extra is ChannelCheck ? s.extra as ChannelCheck : null),
    ),
    // The influencer's side has its own bottom bar (owner 2026-10-19).
    StatefulShellRoute.indexedStack(
      builder: (context, state, shell) => InfluencerShell(shell: shell),
      branches: [
        StatefulShellBranch(routes: [GoRoute(path: '/inf/home', builder: (_, __) => const InfluencerHomeScreen())]),
        StatefulShellBranch(routes: [GoRoute(path: '/inf/bookings', builder: (_, __) => BookingsBridge.real ? const RealInfluencerBookingsScreen() : const InfluencerBookingsScreen())]),
        StatefulShellBranch(routes: [GoRoute(path: '/inf/status', builder: (_, __) => const InfluencerStatusScreen())]),
        StatefulShellBranch(routes: [GoRoute(path: '/inf/availability', builder: (_, __) => BookingsBridge.real ? const RealAvailabilityScreen() : const AvailabilityScreen())]),
      ],
    ),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/book/:id/confirm',
      builder: (_, s) => BookingsBridge.real
          ? RealBookConfirmScreen(id: s.pathParameters['id']!, day: s.uri.queryParameters['day'] ?? '', slot: s.uri.queryParameters['slot'] ?? '')
          : BookConfirmScreen(id: s.pathParameters['id']!, day: s.uri.queryParameters['day'] ?? '', slot: s.uri.queryParameters['slot'] ?? ''),
    ),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/booked/:id',
      builder: (_, s) => BookingsBridge.real
          ? RealBookedScreen(day: s.uri.queryParameters['day'] ?? '', slot: s.uri.queryParameters['slot'] ?? '', name: s.uri.queryParameters['name'] ?? '')
          : BookedScreen(id: s.pathParameters['id']!, day: s.uri.queryParameters['day'] ?? '', slot: s.uri.queryParameters['slot'] ?? ''),
    ),
  ],
);

/// Bottom bar: Reels · Search · Favourites · Me (owner, 2026-10-19).
class MainShell extends StatelessWidget {
  const MainShell({super.key, required this.shell});

  final StatefulNavigationShell shell;

  static const _items = <(IconData, IconData, String)>[
    (Icons.slow_motion_video_outlined, Icons.slow_motion_video_rounded, 'Reels'),
    (Icons.search_rounded, Icons.search_rounded, 'Search'),
    (Icons.favorite_border_rounded, Icons.favorite_rounded, 'Favourites'),
    (Icons.person_outline_rounded, Icons.person_rounded, 'Me'),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: shell,
      bottomNavigationBar: Container(
        decoration: const BoxDecoration(
          color: C.paper,
          border: Border(top: BorderSide(color: C.turquoise, width: 3)),
        ),
        child: SafeArea(
          top: false,
          child: SizedBox(
            height: 68,
            child: Row(
              children: [
                for (var i = 0; i < _items.length; i++)
                  Expanded(
                    child: Semantics(
                      button: true,
                      selected: shell.currentIndex == i,
                      label: _items[i].$3,
                      child: InkWell(
                        onTap: () => shell.goBranch(i, initialLocation: i == shell.currentIndex),
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(shell.currentIndex == i ? _items[i].$2 : _items[i].$1, size: 27, color: shell.currentIndex == i ? C.maroon : C.muted),
                            const SizedBox(height: 3),
                            Text(
                              _items[i].$3,
                              style: t(14, color: shell.currentIndex == i ? C.maroon : C.muted, w: shell.currentIndex == i ? FontWeight.w800 : FontWeight.w700),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

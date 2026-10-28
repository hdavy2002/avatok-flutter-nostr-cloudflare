import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'screens/booking.dart';
import 'screens/blocked_people.dart'; // [HF-BLOCK-PROFILE-1]
import '../data/models/reel.dart';
import '../data/services.dart';
import 'screens/availability_real.dart'; // [HF-BOOK-APPROVE-6]
import 'screens/bookings_real.dart'; // [HF-WIRE-8]
import 'screens/booking_detail.dart'; // [HF-APP-PARITY-BOOKINGS]
import '../data/models/booking.dart' show AppBooking; // [HF-APP-PARITY-BOOKINGS]
import '../data/models/channel.dart';
import 'screens/channels.dart';
import 'screens/edit_profile.dart'; // [HF-APP-PARITY-PROFILE]
import 'screens/call.dart';
import 'screens/favourites.dart';
import 'screens/feed.dart';
import 'screens/influencer.dart';
import 'screens/my_verifications.dart'; // [HF-CREATOR-BADGES-1]
import 'screens/intro.dart';
import 'screens/me.dart';
import 'screens/merch_fan.dart'; // [HF-MERCH-APP-1]
import '../data/repos/channel_repo.dart'; // [HF-CHANNEL-APP-1]
import 'screens/bag.dart'; // [HF-CHANNEL-APP-1]
import 'screens/merch_product.dart'; // [HF-CHANNEL-APP-1]
import 'screens/profile_photo.dart'; // [HF-CHANNEL-APP-1]
import 'screens/merch_studio.dart';
import 'screens/merch_wizard.dart';
import 'screens/money.dart';
import 'screens/creator_page.dart'; // [HF-REELS-FAV-1]
import 'screens/page_moved.dart';
import 'screens/profile.dart';
import 'screens/queue_real.dart'; // [HF-CALL-MODES-E2]
import 'screens/search.dart';
import 'screens/space_verify.dart'; // [HF-CREATOR-SPACES-1]
import '../data/models/spaces.dart'; // [HF-CREATOR-SPACES-1]
import 'reel_player.dart';
import 'theme.dart';

final rootKey = GlobalKey<NavigatorState>();

/// Every screen of the demo app and where each tap goes. Screens only, dummy data.
final router = GoRouter(
  navigatorKey: rootKey,
  observers: [ReelGate.observer],
  initialLocation: '/splash',
  errorBuilder: hfErrorPage, // [HF-REELS-FAV-1] never the raw GoException
  routes: [
    GoRoute(path: '/splash', builder: (_, __) => const SplashScreen()),
    GoRoute(path: '/intro', builder: (_, __) => const IntroScreen()),
    // Site links (`https://<domain>/h/<slug>`, `/r/<id>`): the same targets core/deep_links.dart opens for taps.
    GoRoute(
      path: '/h/:slug',
      redirect: (_, s) =>
          '/profile/${Uri.encodeComponent(s.pathParameters['slug'] ?? '')}',
    ),
    GoRoute(
      path: '/r/:id',
      redirect: (_, s) =>
          '/reels?reel=${Uri.encodeQueryComponent(s.pathParameters['id'] ?? '')}',
    ),
    StatefulShellRoute.indexedStack(
      builder: (context, state, shell) => MainShell(shell: shell),
      branches: [
        StatefulShellBranch(
          routes: [
            GoRoute(
              path: '/reels',
              builder: (_, s) => s.extra is FeedReel
                  ? RealFeed(
                      repo: Services.instance.reelsRepo,
                      reelId: (s.extra as FeedReel).id,
                      initialReel: s.extra as FeedReel,
                    )
                  : FeedScreen(reelId: s.uri.queryParameters['reel']),
            ),
          ],
        ),
        StatefulShellBranch(
          routes: [
            GoRoute(path: '/search', builder: (_, __) => const SearchScreen()),
          ],
        ),
        StatefulShellBranch(
          routes: [
            GoRoute(
              path: '/favourites',
              builder: (_, __) => const FavouritesScreen(),
            ),
          ],
        ),
        StatefulShellBranch(
          routes: [GoRoute(path: '/me', builder: (_, __) => const MeScreen())],
        ),
      ],
    ),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/creator/:platform/:handle',
      builder: (_, s) => inviteProfileFromRoute(s, searchRepo: Services.instance.searchRepo), // [HF-VOTE-COUNT-1] live vote count
    ), // [HF-REELS-FAV-1] creator not on the app yet
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/profile/:id',
      builder: (_, s) => ProfileScreen(id: s.pathParameters['id']!),
    ),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/book/:id',
      pageBuilder: (_, s) => _BookingSheetPage(
        key: s.pageKey,
        child: BookingsBridge.real
            ? RealBookScreen(
                id: s.pathParameters['id']!,
                day: s.uri.queryParameters['day'],
                slot: s.uri.queryParameters['slot'],
              )
            : BookScreen(
                id: s.pathParameters['id']!,
                day: s.uri.queryParameters['day'],
                slot: s.uri.queryParameters['slot'],
              ),
      ),
    ),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/queue/:slug',
      builder: (_, s) => QueueScreen(
        slug: s.pathParameters['slug']!,
        waiting: int.tryParse(s.uri.queryParameters['n'] ?? '') ?? 0,
      ),
    ), // [HF-CALL-MODES-E2] only linked to while hfCallQueueEnabled
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/call/:id',
      builder: (_, s) => CallScreen(id: s.pathParameters['id']!),
    ),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/wallet',
      builder: (_, __) => const WalletScreen(),
    ),
    // [HF-MERCH-APP-1] Influencer merch shop: studio, new-product wizard, checkout, My orders and one order.
    GoRoute(parentNavigatorKey: rootKey, path: '/merch', builder: (_, __) => const MerchStudioScreen()),
    GoRoute(parentNavigatorKey: rootKey, path: '/merch/new', builder: (_, __) => const MerchWizardScreen()),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/merch/checkout',
      redirect: (_, s) => s.extra is MerchCheckoutArgs ? null : '/merch/orders',
      builder: (_, s) => MerchCheckoutScreen(args: s.extra! as MerchCheckoutArgs),
    ),
    GoRoute(parentNavigatorKey: rootKey, path: '/merch/orders', builder: (_, __) => const MerchMyOrdersScreen()),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/merch/orders/:id',
      builder: (_, s) => MerchOrderScreen(
        id: s.pathParameters['id']!,
        waiting: s.uri.queryParameters['wait'] == '1',
        source: s.uri.queryParameters['src'] ?? 'link',
      ),
    ),
    // [HF-CHANNEL-APP-1] Bag, bag checkout, one merch product, and the influencer's profile photo.
    GoRoute(parentNavigatorKey: rootKey, path: '/bag', builder: (_, __) => const BagScreen()),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/bag/checkout',
      redirect: (_, s) => s.extra is BagCheckoutArgs ? null : '/bag',
      builder: (_, s) => BagCheckoutScreen(args: s.extra! as BagCheckoutArgs),
    ),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/merch/p/:host/:slug',
      builder: (_, s) => MerchProductScreen(
        hostSlug: s.pathParameters['host']!,
        productSlug: s.pathParameters['slug']!,
        initial: s.extra is ChannelProduct ? s.extra! as ChannelProduct : null,
      ),
    ),
    GoRoute(parentNavigatorKey: rootKey, path: '/inf/photo', builder: (_, __) => const ProfilePhotoScreen()),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/topup',
      builder: (_, s) => TopUpScreen(callId: s.uri.queryParameters['callId']),
    ),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/payment',
      builder: (_, s) => PaymentScreen(
        // No amount when the screen is opened from a return link (hellofraands://wallet/topup/<id>): it is read from the server.
        amount:
            double.tryParse(s.uri.queryParameters['amount'] ?? '') ??
            (s.uri.queryParameters['order'] == null ? 500 : null),
        orderId: s.uri.queryParameters['order'],
        creditPaise: int.tryParse(s.uri.queryParameters['credit'] ?? ''),
        sdkFailed: s.uri.queryParameters['sdk'] == 'err',
        callId: s.uri.queryParameters['callId'],
      ),
    ),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/payout',
      builder: (_, __) => const PayoutScreen(),
    ),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/calls',
      builder: (_, __) => const CallRecordsScreen(),
    ),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/bookings',
      builder: (_, __) => const BookingsScreen(),
    ),
    GoRoute(
      // [HF-APP-PARITY-BOOKINGS] One booking in full. Push it with the booking as `extra` to paint at once.
      parentNavigatorKey: rootKey,
      path: '/bookings/:id',
      builder: (_, s) => RealBookingDetailScreen(id: s.pathParameters['id']!, initial: s.extra is AppBooking ? s.extra as AppBooking : null),
    ),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/settings',
      builder: (_, __) => const SettingsScreen(),
    ),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/settings/profile',
      builder: (_, __) => const EditProfileScreen(),
    ), // [HF-APP-PARITY-PROFILE]
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/settings/blocked',
      builder: (_, __) => const BlockedPeopleScreen(),
    ), // [HF-BLOCK-PROFILE-1]
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/help',
      builder: (_, __) => const HelpScreen(),
    ),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/influencer/join',
      builder: (_, s) => InfluencerJoinScreen(
        initialStep: int.tryParse(s.uri.queryParameters['step'] ?? '') ?? 0,
      ),
    ),
    // [HF-CREATOR-SPACES-1] Video KYC for Women-only / LGBTQ+ channels (customers and creators).
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/verify/space',
      builder: (_, s) => SpaceVerifyScreen(
        lane: SpaceLane.parse(s.uri.queryParameters['lane']), // null (`lane=kyc`) = plain video KYC [HF-CREATOR-BADGES-1]
        creator: s.uri.queryParameters['creator'] == '1',
      ),
    ),
    // [HF-CREATOR-BADGES-1] The creator's stacked badges, space and "who can call you".
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/inf/verifications',
      builder: (_, __) => const MyVerificationsScreen(),
    ),
    // [HF-WIRE-3] Channels. `?from=join` keeps the person inside "Join as influencer".
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/inf/channels',
      // [HF-IG-LOGIN-1] `?ig=connected|error&reason=&result=` is where the Instagram login sends her back (core/deep_links.dart).
      builder: (_, s) => ChannelsListScreen(
        ig: s.uri.queryParameters['ig'],
        reason: s.uri.queryParameters['reason'],
        result: s.uri.queryParameters['result'],
        igLogin: IgLoginMode.probe,
      ),
    ),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/inf/channels/instagram-guide',
      builder: (_, __) => const InstagramSwitchGuideScreen(),
    ),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/inf/channels/add',
      builder: (_, s) =>
          ChannelPlatformScreen(from: s.uri.queryParameters['from']),
    ),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/inf/channels/add/:platform',
      builder: (_, s) => ChannelConsentScreen(
        platform: s.pathParameters['platform'] ?? '',
        from: s.uri.queryParameters['from'],
        igLogin: IgLoginMode.probe, // [HF-IG-LOGIN-1] hidden unless hfInstagramLoginEnabled
      ),
    ),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/inf/channels/:id/checking',
      builder: (_, s) => ChannelCheckingScreen(
        id: s.pathParameters['id']!,
        from: s.uri.queryParameters['from'],
        initial: s.extra is ChannelCheck ? s.extra as ChannelCheck : null,
      ),
    ),
    // The influencer's side has its own bottom bar (owner 2026-10-19).
    StatefulShellRoute.indexedStack(
      builder: (context, state, shell) => InfluencerShell(shell: shell),
      branches: [
        StatefulShellBranch(
          routes: [
            GoRoute(
              path: '/inf/home',
              builder: (_, __) => const InfluencerHomeScreen(),
            ),
          ],
        ),
        StatefulShellBranch(
          routes: [
            GoRoute(
              path: '/inf/bookings',
              builder: (_, __) => BookingsBridge.real
                  ? const RealInfluencerBookingsScreen()
                  : const InfluencerBookingsScreen(),
            ),
          ],
        ),
        StatefulShellBranch(
          routes: [
            GoRoute(
              path: '/inf/status',
              builder: (_, __) => const InfluencerStatusScreen(),
            ),
          ],
        ),
        StatefulShellBranch(
          routes: [
            GoRoute(
              path: '/inf/availability',
              builder: (_, __) => BookingsBridge.real
                  ? const RealAvailabilityScreen()
                  : const AvailabilityScreen(),
            ),
          ],
        ),
      ],
    ),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/book/:id/confirm',
      builder: (_, s) => BookingsBridge.real
          ? RealBookConfirmScreen(
              id: s.pathParameters['id']!,
              day: s.uri.queryParameters['day'] ?? '',
              slot: s.uri.queryParameters['slot'] ?? '',
              topic: s.uri.queryParameters['topic'],
              length: int.tryParse(s.uri.queryParameters['len'] ?? ''), // [HF-CALL-MODES-E2]
              name: s.uri.queryParameters['name'],
              avatar: s.uri.queryParameters['avatar'],
            )
          : BookConfirmScreen(
              id: s.pathParameters['id']!,
              day: s.uri.queryParameters['day'] ?? '',
              slot: s.uri.queryParameters['slot'] ?? '',
            ),
    ),
    GoRoute(
      parentNavigatorKey: rootKey,
      path: '/booked/:id',
      builder: (_, s) => BookingsBridge.real
          ? RealBookedScreen(
              day: s.uri.queryParameters['day'] ?? '',
              slot: s.uri.queryParameters['slot'] ?? '',
              name: s.uri.queryParameters['name'] ?? '',
              approval:
                  s.uri.queryParameters['approval'] == '1', // [HF-BOOK-APPROVE]
              approvalText: s.uri.queryParameters['text'] ?? '',
            )
          : BookedScreen(
              id: s.pathParameters['id']!,
              day: s.uri.queryParameters['day'] ?? '',
              slot: s.uri.queryParameters['slot'] ?? '',
            ),
    ),
  ],
);

/// Bottom bar: Reels · Search · Favourites · Me (owner, 2026-10-19).
class MainShell extends StatefulWidget {
  const MainShell({super.key, required this.shell});

  final StatefulNavigationShell shell;

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  StatefulNavigationShell get shell => widget.shell;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final route = ModalRoute.of(context);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ReelGate.attachShell(route);
      ReelGate.setBranch(shell.currentIndex);
    });
  }

  @override
  void didUpdateWidget(covariant MainShell old) {
    super.didUpdateWidget(old);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) ReelGate.setBranch(shell.currentIndex);
    });
  }

  @override
  void dispose() {
    ReelGate.detachShell();
    super.dispose();
  }

  static const _items = <(IconData, IconData, String)>[
    (
      Icons.slow_motion_video_outlined,
      Icons.slow_motion_video_rounded,
      'Reels',
    ),
    (Icons.search_rounded, Icons.search_rounded, 'Search'),
    (Icons.favorite_border_rounded, Icons.favorite_rounded, 'Favourites'),
    (Icons.person_outline_rounded, Icons.person_rounded, 'Me'),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: shell,
      bottomNavigationBar: Container(
        // [HF-APP-DESI-1] Dashboard bottom bar: white, soft top shadow, the chosen tab rani on a blush pill.
        decoration: BoxDecoration(
          color: shell.currentIndex == 0 ? Colors.black : C.white,
          border: shell.currentIndex == 0 ? null : const Border(top: BorderSide(color: C.line)),
          boxShadow: shell.currentIndex == 0 ? null : const [BoxShadow(color: Color(0x404A1747), blurRadius: 24, offset: Offset(0, -8), spreadRadius: -16)],
        ),
        child: SafeArea(
          top: false,
          child: SizedBox(
            // [HF-REEL-FOOTER-1] taller bar (was 52) so there is room above the icons (owner 2026-10-22)
            height: 66,
            child: Row(
              children: [
                for (var i = 0; i < _items.length; i++)
                  Expanded(
                    child: Semantics(
                      button: true,
                      selected: shell.currentIndex == i,
                      label: _items[i].$3,
                      child: InkWell(
                        onTap: () => shell.goBranch(
                          i,
                          initialLocation: i == shell.currentIndex,
                        ),
                        // [HF-APP-DESI-1] blush pill on the chosen tab (not on Reels)
                        child: Container(
                          margin: const EdgeInsets.symmetric(horizontal: 6, vertical: 5),
                          decoration: BoxDecoration(
                            color: shell.currentIndex == i && shell.currentIndex != 0 ? C.blush : C.clear,
                            borderRadius: BorderRadius.circular(14),
                          ),
                          child: Column(
                          // [HF-REEL-FOOTER-1] icons sit low in the bar: the room is above them
                          mainAxisAlignment: MainAxisAlignment.end,
                          children: [
                            Icon(
                              shell.currentIndex == i
                                  ? _items[i].$2
                                  : _items[i].$1,
                              size: 22,
                              color: shell.currentIndex == i
                                  ? (shell.currentIndex == 0
                                        ? Colors.white
                                        : C.rani)
                                  : (shell.currentIndex == 0
                                        ? Colors.white70
                                        : C.muted),
                            ),
                            const SizedBox(height: 1),
                            Text(
                              _items[i].$3,
                              style: t(
                                11,
                                color: shell.currentIndex == i
                                    ? (shell.currentIndex == 0
                                          ? Colors.white
                                          : C.rani)
                                    : (shell.currentIndex == 0
                                          ? Colors.white70
                                          : C.muted),
                                w: shell.currentIndex == i
                                    ? FontWeight.w800
                                    : FontWeight.w700,
                              ),
                            ),
                            const SizedBox(height: 7),
                          ],
                        ),
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

class _BookingSheetPage extends Page<void> {
  const _BookingSheetPage({super.key, required this.child});
  final Widget child;
  @override
  Route<void> createRoute(BuildContext context) => ModalBottomSheetRoute<void>(
    settings: this,
    builder: (_) => FractionallySizedBox(
      heightFactor: 0.9,
      child: ClipRRect(
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
        child: child,
      ),
    ),
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    backgroundColor: C.cream,
  );
}

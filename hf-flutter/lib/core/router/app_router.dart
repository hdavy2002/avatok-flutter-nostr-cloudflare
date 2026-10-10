import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../analytics/analytics.dart';
import '../auth/session.dart';
import '../boot.dart';
import '../strings.dart';
import '../theme/hf_tokens.dart';
import '../widgets/widgets.dart';
import '../../features/auth/ui/sign_in_screen.dart';
import '../../features/call/ui/call_screen.dart';
import '../../features/explore/ui/explore_screen.dart';
import '../../features/home/ui/home_screen.dart';
import '../../features/host_dashboard/ui/host_dashboard_screen.dart';
import '../../features/host_onboarding/ui/host_onboarding_screen.dart';
import '../../features/host_profile/ui/host_profile_screen.dart';
import '../../features/lanes/ui/lanes_screen.dart';
import '../../features/me/ui/delete_account_screen.dart';
import '../../features/me/ui/me_screen.dart';
import '../../features/review/ui/review_screen.dart';
import '../../features/splash/ui/splash_screen.dart';
import '../../features/wallet/ui/wallet_screen.dart';
import '../../features/welcome/ui/welcome_screen.dart';
import 'deep_links.dart';
import 'routes.dart';
import 'tab_shell.dart';

/// The one router. Tests override [initialLocationProvider] and the session providers.
final appRouterProvider = Provider<GoRouter>((ref) {
  final refresh = _RefreshNotifier();
  ref.listen<SessionState>(sessionProvider, (prev, next) {
    if (prev?.status != next.status) refresh.poke();
  });
  final router = createAppRouter(
    ref: ref,
    initialLocation: ref.read(initialLocationProvider),
    refreshListenable: refresh,
  );
  ref.onDispose(() {
    router.dispose();
    refresh.dispose();
  });
  return router;
});

class _RefreshNotifier extends ChangeNotifier {
  void poke() => notifyListeners();
}

/// Sign-in rule (spec 3.2): a protected route without a session goes to `/sign-in?next=<that route>`.
/// While the session is still loading nothing redirects (the splash holds the person, and a link that
/// arrives early waits for boot).
String? hfRedirect(SessionState session, Uri uri) {
  if (session.isLoading) return null;
  if (!session.isSignedIn && Routes.needsSignIn(uri.path)) return Routes.signInTo(uri.toString());
  return null;
}

GoRouter createAppRouter({
  required Ref ref,
  String initialLocation = Routes.splash,
  Listenable? refreshListenable,
}) {
  final router = GoRouter(
    initialLocation: initialLocation,
    refreshListenable: refreshListenable,
    redirect: (context, state) => hfRedirect(ref.read(sessionProvider), state.uri),
    errorBuilder: (context, state) => const _NotFoundScreen(),
    routes: [
      GoRoute(path: Routes.splash, builder: (_, __) => const SplashScreen()),
      GoRoute(path: Routes.welcome, builder: (_, __) => const WelcomeScreen()),
      GoRoute(
        path: Routes.signIn,
        builder: (_, state) {
          final next = state.uri.queryParameters['next'];
          return SignInScreen(next: next != null && Routes.isSafeNext(next) ? next : null);
        },
      ),
      GoRoute(
        path: Routes.hostProfile,
        builder: (_, state) => HostProfileScreen(slug: state.pathParameters['slug'] ?? ''),
      ),
      GoRoute(path: Routes.call, builder: (_, state) => CallScreen(id: state.pathParameters['id'] ?? '')),
      // `review/call/:id` must come before `review/:token`.
      GoRoute(
        path: Routes.reviewCall,
        builder: (_, state) => ReviewScreen(callId: state.pathParameters['id']),
      ),
      GoRoute(
        path: Routes.reviewToken,
        builder: (_, state) => ReviewScreen(token: state.pathParameters['token']),
      ),
      GoRoute(path: Routes.lanes, builder: (_, state) => LanesScreen(lane: state.uri.queryParameters['lane'])),
      GoRoute(
        path: Routes.hostOnboarding,
        builder: (_, state) => HostOnboardingScreen(
          step: state.uri.queryParameters['step'],
          digiLockerReturn: state.uri.queryParameters['dl'] == 'return',
        ),
      ),
      GoRoute(path: Routes.meDelete, builder: (_, __) => const DeleteAccountScreen()),
      StatefulShellRoute.indexedStack(
        builder: (_, __, shell) => HfTabShell(navigationShell: shell),
        branches: [
          StatefulShellBranch(routes: [GoRoute(path: Routes.home, builder: (_, __) => const HomeScreen())]),
          StatefulShellBranch(routes: [
            GoRoute(path: Routes.explore, builder: (_, state) => ExploreScreen(query: state.uri.queryParameters)),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(path: Routes.wallet, builder: (_, state) => WalletScreen(query: state.uri.queryParameters)),
          ]),
          StatefulShellBranch(routes: [GoRoute(path: Routes.host, builder: (_, __) => const HostDashboardScreen())]),
          StatefulShellBranch(routes: [GoRoute(path: Routes.me, builder: (_, __) => const MeScreen())]),
        ],
      ),
    ],
  );

  // `screen_viewed` on every route change, with a templated path (no slug, id or token).
  String? last;
  router.routerDelegate.addListener(() {
    final uri = router.routeInformationProvider.value.uri;
    final screen = DeepLinks.telemetryPath(uri.toString());
    if (screen == last) return;
    final from = last;
    last = screen;
    Analytics.screenViewed(screen, from: from);
  });
  return router;
}

class _NotFoundScreen extends StatelessWidget {
  const _NotFoundScreen();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text(Strings.notFoundTitle)),
      body: Padding(
        padding: const EdgeInsets.all(HfSpacing.page),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Text(Strings.notFoundBody, style: HfText.bodyText, textAlign: TextAlign.center),
            const SizedBox(height: HfSpacing.gapLarge),
            HfButton(label: Strings.goHome, onPressed: () => GoRouter.of(context).go(Routes.home)),
          ],
        ),
      ),
    );
  }
}

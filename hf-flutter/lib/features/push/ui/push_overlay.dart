import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/session.dart';
import '../../../core/router/app_router.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_tokens.dart';
import '../data/push_controller.dart';
import '../data/push_service.dart';
import 'push_widgets.dart';

/// Wraps the whole app (`MaterialApp.router builder`). It starts the push controller, shows the in-app
/// banner for a push that arrives while the app is open, and shows the opt-in sheet once it is due.
class PushOverlay extends ConsumerStatefulWidget {
  const PushOverlay({super.key, required this.child});

  final Widget child;

  /// How long the banner stays before it hides itself.
  static const Duration bannerTime = Duration(seconds: 8);

  @override
  ConsumerState<PushOverlay> createState() => _PushOverlayState();
}

class _PushOverlayState extends ConsumerState<PushOverlay> {
  Timer? _bannerTimer;
  bool _sheetOpen = false;
  bool _sheetScheduled = false;
  GoRouter? _router;

  /// The sheet never opens over these: the person is still getting in.
  static const Set<String> _quietPaths = {Routes.splash, Routes.welcome, Routes.signIn, Routes.completeProfile};

  @override
  void initState() {
    super.initState();
    _router = ref.read(appRouterProvider);
    _router!.routerDelegate.addListener(_maybeShowSheet);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(ref.read(pushControllerProvider.notifier).start());
    });
  }

  @override
  void dispose() {
    _bannerTimer?.cancel();
    _router?.routerDelegate.removeListener(_maybeShowSheet);
    super.dispose();
  }

  void _armBannerTimer() {
    _bannerTimer?.cancel();
    _bannerTimer = Timer(PushOverlay.bannerTime, () {
      if (mounted) ref.read(pushControllerProvider.notifier).dismissBanner();
    });
  }

  void _maybeShowSheet() {
    if (!mounted || _sheetOpen || _sheetScheduled) return;
    if (!ref.read(pushControllerProvider).promptOptIn) return;
    _sheetScheduled = true;
    // An async redirect can notify before its Navigator is mounted. Wait for
    // that frame, then check the current account and route before opening UI.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _sheetScheduled = false;
      if (!mounted || _sheetOpen || !ref.read(sessionProvider).isSignedIn ||
          !ref.read(pushControllerProvider).promptOptIn) return;
      final router = _router;
      if (router == null || _quietPaths.contains(router.routeInformationProvider.value.uri.path)) return;
      final navContext = router.routerDelegate.navigatorKey.currentContext;
      if (navContext != null) unawaited(_showSheet(navContext));
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  Future<void> _showSheet(BuildContext navContext) async {
    _sheetOpen = true;
    final controller = ref.read(pushControllerProvider.notifier);
    final service = ref.read(pushServiceProvider);
    final host = ref.read(sessionProvider).hasHostTab;
    controller.promptHandled();
    try {
      final allow = await showModalBottomSheet<bool>(
        context: navContext,
        isScrollControlled: true,
        backgroundColor: HfColors.cream,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(HfRadius.card + 6)),
        ),
        builder: (_) => PushOptInSheet(host: host),
      );
      // Allow runs the Android prompt. Not now, a swipe down or Back count as "Not now" for 14 days.
      if (allow == true) {
        await service.allow();
      } else {
        await service.notNow();
      }
    } finally {
      _sheetOpen = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<PushUiState>(pushControllerProvider, (prev, next) {
      if (next.banner != prev?.banner) {
        if (next.banner == null) {
          _bannerTimer?.cancel();
        } else {
          _armBannerTimer();
        }
      }
      if (next.promptOptIn && !(prev?.promptOptIn ?? false)) _maybeShowSheet();
    });
    final state = ref.watch(pushControllerProvider);
    if (state.promptOptIn) _maybeShowSheet();
    final banner = state.banner;
    return Stack(
      fit: StackFit.expand,
      children: [
        widget.child,
        if (banner != null)
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: PushBanner(
              message: banner,
              onOpen: () => unawaited(ref.read(pushControllerProvider.notifier).openBanner()),
              onClose: () => ref.read(pushControllerProvider.notifier).dismissBanner(),
            ),
          ),
      ],
    );
  }
}

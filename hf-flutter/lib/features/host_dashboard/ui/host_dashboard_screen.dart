import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../data/host_dashboard_models.dart';
import '../host_dashboard_providers.dart';
import 'calls_section.dart';
import 'earnings_card.dart';
import 'host_dashboard_copy.dart';
import 'payouts_section.dart';
import 'presence_card.dart';
import 'status_banner.dart';

/// Host tab (needs sign-in). The profile status banner, the online switch, today, recent calls, earnings in
/// rupees and withdrawals. A person without a host profile who lands here sees a "Become a host" panel.
///
/// Before the profile is live only the banner shows (with its next step). Once it was reviewed (live, paused
/// or rejected) the money sections show too, so earnings and withdrawal history never disappear.
class HostDashboardScreen extends ConsumerStatefulWidget {
  const HostDashboardScreen({super.key});

  @override
  ConsumerState<HostDashboardScreen> createState() => _HostDashboardScreenState();
}

class _HostDashboardScreenState extends ConsumerState<HostDashboardScreen> {
  bool _viewed = false;

  Future<void> _refresh() async {
    ref.invalidate(hostProfileStatusProvider);
    ref.invalidate(hostPresenceProvider);
    ref.invalidate(hostCallsProvider);
    ref.invalidate(hostEarningsProvider);
    ref.invalidate(hostPayoutsProvider);
    try {
      await ref.read(hostProfileStatusProvider.future);
    } catch (_) {
      // the error panel shows it
    }
  }

  /// Opens onboarding (at [step], or where the host stopped) and reloads everything when the host comes back.
  Future<void> _openOnboarding(String? step) async {
    await GoRouter.of(context).push<void>(Routes.hostOnboardingAt(step));
    if (!mounted) return;
    unawaited(_refresh());
    unawaited(ref.read(sessionProvider.notifier).refreshMe());
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    final Widget body;
    if (session.isLoading) {
      body = const LoadingPanel();
    } else if (!session.isSignedIn) {
      body = EmptyPanel(
        message: HostCopy.signInBody,
        icon: Icons.lock_outline_rounded,
        actionLabel: HostCopy.signIn,
        onAction: () => requireSignIn(context, ref),
      );
    } else {
      body = _signedIn();
    }
    return Scaffold(
      appBar: AppBar(automaticallyImplyLeading: false, title: const Text(HostCopy.title)),
      body: SafeArea(child: body),
    );
  }

  Widget _signedIn() {
    ref.listen<AsyncValue<HostProfileStatus>>(hostProfileStatusProvider, (prev, next) {
      final s = dashValueOf(next);
      if (s == null || _viewed) return;
      _viewed = true;
      unawaited(Analytics.capture('hf_app_host_dashboard_viewed', {'status': s.hasHost ? s.status : 'none'}));
    });
    final profile = ref.watch(hostProfileStatusProvider);
    return profile.when(
      skipLoadingOnReload: true,
      skipLoadingOnRefresh: true,
      loading: () => const LoadingPanel(),
      error: (e, _) {
        if (e is ApiError && e.isNotEnabled) return const ComingSoonPanel();
        return ErrorPanel(error: e, onRetry: () => ref.invalidate(hostProfileStatusProvider));
      },
      data: (s) {
        if (!s.hasHost) {
          return EmptyPanel(
            message: HostCopy.becomeTitle,
            icon: Icons.mic_none_rounded,
            actionLabel: HostCopy.becomeAction,
            onAction: () => _openOnboarding(null),
          );
        }
        final sections = <Widget>[
          const HfScene(kind: HfSceneKind.host, height: 150),
          const Text('Your hosting corner', style: HfText.title),
          const Text('Make room for a good conversation. You choose when you are available.', style: HfText.bodyText),
          if (!s.isLive) StatusBanner(status: s, onAction: _openOnboarding),
          if (s.isLive) ...const [PresenceCard(), TodayCard(), CallsSection()],
          if (s.showsMoney) ...[
            const EarningsCard(),
            PayoutsSection(onFinishSetup: _openOnboarding),
          ],
        ];
        // A plain scroll view with a Column, not a lazy list: every section stays built, so the online
        // switch (and its heartbeat) is never disposed when the host scrolls down.
        return RefreshIndicator(
          onRefresh: _refresh,
          child: SingleChildScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(HfSpacing.page),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                for (var i = 0; i < sections.length; i++) ...[
                  if (i > 0) const SizedBox(height: HfSpacing.gapLarge),
                  sections[i],
                ],
              ]),
          ),
        );
      },
    );
  }
}

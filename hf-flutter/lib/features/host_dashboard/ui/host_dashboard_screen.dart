import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/router/tab_shell.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../data/host_dashboard_models.dart';
import '../host_dashboard_providers.dart';
import 'calls_section.dart';
import 'dash_surface.dart';
import 'earnings_card.dart';
import 'host_dashboard_copy.dart';
import 'payouts_section.dart';
import 'presence_card.dart';
import 'status_banner.dart';

/// Host tab (needs sign-in), after the `Host` mockup: header with "My profile", the online card, three tiles
/// for today, the earnings card with "Withdraw to bank", today's calls and the withdrawal history. A person
/// without a host profile who lands here sees a "Become a host" panel.
///
/// Before the profile is live only the banner shows (with its next step). Once it was reviewed (live, paused
/// or rejected) the money sections show too, so earnings and withdrawal history never disappear.
class HostDashboardScreen extends ConsumerStatefulWidget {
  const HostDashboardScreen({super.key});

  @override
  ConsumerState<HostDashboardScreen> createState() =>
      _HostDashboardScreenState();
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
      body = const LoadingPanel(skeleton: _DashboardSkeleton());
    } else if (!session.isSignedIn) {
      body = EmptyPanel(
        message: HostCopy.signInBody,
        icon: Icons.lock_outline_rounded,
        actionLabel: HostCopy.signIn,
        onAction: () => requireSignIn(context, ref),
      );
    } else {
      body = _signedIn(session.me?.displayName, session.me?.host?.slug);
    }
    return Scaffold(body: SafeArea(bottom: false, child: body));
  }

  Widget _signedIn(String? sessionName, String? sessionSlug) {
    ref.listen<AsyncValue<HostProfileStatus>>(hostProfileStatusProvider, (
      prev,
      next,
    ) {
      final s = dashValueOf(next);
      if (s == null || _viewed) return;
      _viewed = true;
      unawaited(
        Analytics.capture('hf_app_host_dashboard_viewed', {
          'status': s.hasHost ? s.status : 'none',
        }),
      );
    });
    final profile = ref.watch(hostProfileStatusProvider);
    return profile.when(
      skipLoadingOnReload: true,
      skipLoadingOnRefresh: true,
      loading: () => const LoadingPanel(skeleton: _DashboardSkeleton()),
      error: (e, _) {
        if (e is ApiError && e.isNotEnabled) return const ComingSoonPanel();
        return ErrorPanel(
          error: e,
          onRetry: () => ref.invalidate(hostProfileStatusProvider),
        );
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
          _Header(
            name: s.displayName ?? sessionName ?? HostCopy.hostFallbackName,
            avatarUrl: s.avatarUrl,
            slug: s.slug ?? sessionSlug,
          ),
          if (!s.isLive) StatusBanner(status: s, onAction: _openOnboarding),
          if (s.isLive) const PresenceCard(),
          if (s.isLive) const TodayCard(),
          if (s.showsMoney) EarningsCard(onFinishSetup: _openOnboarding),
          if (s.isLive) const CallsSection(),
          if (s.showsMoney) const PayoutsSection(),
        ];
        // A plain scroll view with a Column, not a lazy list: every section stays built, so the online
        // switch (and its heartbeat) is never disposed when the host scrolls down.
        return RefreshIndicator(
          onRefresh: _refresh,
          child: SingleChildScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            // Bottom padding clears the floating nav (hfNavPadding: bar + gap + system inset).
            padding: EdgeInsets.fromLTRB(
              HfSpacing.pageWide,
              HfSpacing.lg,
              HfSpacing.pageWide,
              hfNavPadding(context),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (var i = 0; i < sections.length; i++) ...[
                  if (i > 0) const SizedBox(height: 16),
                  sections[i],
                ],
              ],
            ),
          ),
        );
      },
    );
  }
}

/// 52 px avatar (radius 18), "Host" eyebrow with the name, and the "My profile" pill that opens the public page.
class _Header extends StatelessWidget {
  const _Header({required this.name, this.avatarUrl, this.slug});

  final String name;
  final String? avatarUrl;
  final String? slug;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final slug = this.slug;
    return Row(
      children: [
        _Avatar(url: avatarUrl, name: name),
        const SizedBox(width: HfSpacing.lg),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(HostCopy.title, style: dashMuted(context)),
              Text(
                name,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: HfText.of(context, HfText.title),
              ),
            ],
          ),
        ),
        if (slug != null) ...[
          const SizedBox(width: HfSpacing.lg),
          Semantics(
            button: true,
            label: HostCopy.myProfile,
            excludeSemantics: true,
            child: Material(
              color: dark ? HfColors.darkBar : HfColors.surfaceSoft,
              borderRadius: BorderRadius.circular(HfRadius.segment),
              child: InkWell(
                key: const ValueKey<String>('my-profile'),
                borderRadius: BorderRadius.circular(HfRadius.segment),
                onTap: () =>
                    GoRouter.of(context).push(Routes.hostProfileOf(slug)),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: HfSpacing.tap),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: HfSpacing.xl,
                    ),
                    child: Center(
                      widthFactor: 1,
                      child: Text(
                        HostCopy.myProfile,
                        style: HfText.of(context, HfText.badge),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ],
    );
  }
}

class _Avatar extends StatelessWidget {
  const _Avatar({required this.url, required this.name});

  final String? url;
  final String name;

  @override
  Widget build(BuildContext context) {
    final letter = name.trim().isEmpty
        ? '?'
        : name.trim().substring(0, 1).toUpperCase();
    final fallback = Container(
      width: 52,
      height: 52,
      alignment: Alignment.center,
      color: HfTint.peach.bg(context),
      child: Text(
        letter,
        style: HfText.title.copyWith(color: HfTint.peach.valueInk(context)),
      ),
    );
    final u = url;
    return Semantics(
      image: true,
      label: 'Your avatar',
      excludeSemantics: true,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(HfRadius.tileSmall),
        child: SizedBox(
          width: 52,
          height: 52,
          child: u == null
              ? fallback
              : Image.network(
                  u,
                  width: 52,
                  height: 52,
                  fit: BoxFit.cover,
                  cacheWidth: 156,
                  errorBuilder: (_, __, ___) => fallback,
                ),
        ),
      ),
    );
  }
}

/// Placeholder with the shape of the dashboard (header, online card, three tiles, earnings, a call row).
class _DashboardSkeleton extends StatelessWidget {
  const _DashboardSkeleton();

  @override
  Widget build(BuildContext context) {
    return const Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            HfSkeleton.box(width: 52, height: 52, radius: HfRadius.tileSmall),
            SizedBox(width: HfSpacing.lg),
            Expanded(child: HfSkeleton.line()),
          ],
        ),
        SizedBox(height: 16),
        HfSkeleton.box(height: 110, radius: HfRadius.cardInner),
        SizedBox(height: 16),
        Row(
          children: [
            Expanded(
              child: HfSkeleton.box(height: 78, radius: HfRadius.tileSmall),
            ),
            SizedBox(width: HfSpacing.sm),
            Expanded(
              child: HfSkeleton.box(height: 78, radius: HfRadius.tileSmall),
            ),
            SizedBox(width: HfSpacing.sm),
            Expanded(
              child: HfSkeleton.box(height: 78, radius: HfRadius.tileSmall),
            ),
          ],
        ),
        SizedBox(height: 16),
        HfSkeleton.box(height: 200, radius: 26),
        SizedBox(height: 16),
        HfSkeleton.box(height: 64, radius: HfRadius.control),
      ],
    );
  }
}

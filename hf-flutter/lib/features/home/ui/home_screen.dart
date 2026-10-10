import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import '../../../core/brand.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/strings.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../../explore/data/host_filters.dart';
import '../../explore/data/host_options.dart';
import '../../explore/widgets/host_card_view.dart';
import '../data/online_hosts.dart';
import 'home_copy.dart';

/// Tab 1. Greeting, "Online now", mood tiles (open Explore already filtered), the women-only and LGBTQ+
/// spaces, the safety line with the crisis numbers, and the "Become a host" card.
///
/// Works signed out (browse first). "Your regulars" is not here yet: the server has no list of a caller's
/// regulars (only each host's regulars count), so the section stays hidden until it does.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key, this.animate = true});

  /// False in widget tests (the online dot pulses forever, which never settles).
  final bool animate;

  Future<void> _refresh(WidgetRef ref) async {
    ref.invalidate(hostOptionsProvider);
    ref.invalidate(onlineHostsProvider);
    try {
      await ref.read(onlineHostsProvider.future);
    } catch (_) {
      // the strip shows its own error
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final name = ref.watch(sessionProvider.select((s) => s.me?.displayName));
    final hasHost = ref.watch(sessionProvider.select((s) => s.hasHostTab));
    final options = optionsOf(ref.watch(hostOptionsProvider));
    return Scaffold(
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: () => _refresh(ref),
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(HfSpacing.page, 12, HfSpacing.page, 28),
            children: [
              _Greeting(firstName: _firstName(name)),
              const SizedBox(height: 24),
              _OnlineNow(animate: animate),
              if (options != null && options.moodGroups.isNotEmpty) ...[
                const SizedBox(height: 28),
                _MoodTiles(options: options),
              ],
              const SizedBox(height: 28),
              const _Spaces(),
              const SizedBox(height: 28),
              const _SafetyBlock(),
              const SizedBox(height: 20),
              _HostCard(hasHost: hasHost),
            ],
          ),
        ),
      ),
    );
  }

  static String? _firstName(String? full) {
    final t = (full ?? '').trim();
    if (t.isEmpty) return null;
    return t.split(RegExp(r'\s+')).first;
  }
}

class _Greeting extends StatelessWidget {
  const _Greeting({required this.firstName});

  final String? firstName;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(HfRadius.card),
          child: Image.asset(
            'assets/images/hero_collage.webp',
            width: double.infinity,
            fit: BoxFit.cover,
            excludeFromSemantics: true,
            errorBuilder: (_, __, ___) => const SizedBox.shrink(),
          ),
        ),
        const SizedBox(height: 16),
        Text(HomeCopy.greeting(firstName), style: HfText.hero),
        const SizedBox(height: 6),
        const Text(Brand.slogan, style: HfText.bodyText),
      ],
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.title, this.hint, this.action});

  final String title;
  final String? hint;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(title, style: HfText.title)),
              if (action != null) action!,
            ],
          ),
          if (hint != null) ...[
            const SizedBox(height: 2),
            Text(hint!, style: HfText.note),
          ],
        ],
      ),
    );
  }
}

/// "Online now": a horizontal strip of narrow host cards.
class _OnlineNow extends ConsumerWidget {
  const _OnlineNow({required this.animate});

  final bool animate;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final online = ref.watch(onlineHostsProvider);
    final Widget body = online.when(
      loading: () => const _InlineLoading(),
      error: (e, _) => _InlineError(error: e, onRetry: () => ref.invalidate(onlineHostsProvider)),
      data: (u) {
        if (u.page.items.isEmpty) {
          return _InlineEmpty(message: HomeCopy.nobodyOnline, onBrowse: () => context.go(Routes.explore));
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (u.showSaved) ...[
              const _SavedNote(),
              const SizedBox(height: 8),
            ],
            // A horizontal strip whose height follows its tallest card (no fixed height to overflow).
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              clipBehavior: Clip.none,
              child: IntrinsicHeight(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (final h in u.page.items) ...[
                      HostMiniCard(host: h, from: 'home', animate: animate),
                      const SizedBox(width: HfSpacing.gap),
                    ],
                  ],
                ),
              ),
            ),
          ],
        );
      },
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _SectionHeader(
          title: HomeCopy.onlineNow,
          action: TextButton(
            onPressed: () => context.go(const HostFilters(online: true).toLocation()),
            child: const Text(HomeCopy.seeAll),
          ),
        ),
        body,
      ],
    );
  }
}

class _InlineLoading extends StatelessWidget {
  const _InlineLoading();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: 24),
      child: Center(
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2.5)),
            SizedBox(width: 12),
            Text(Strings.loadingPeople, style: HfText.bodyText),
          ],
        ),
      ),
    );
  }
}

class _InlineError extends StatelessWidget {
  const _InlineError({required this.error, required this.onRetry});

  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final e = error;
    if (e is ApiError && e.isNotEnabled) {
      return const Text(Strings.comingSoonBody, style: HfText.bodyText);
    }
    return HfCard(
      color: HfColors.blush,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(e is ApiError ? e.userMessage : Strings.somethingWrong, style: HfText.bodyText),
          const SizedBox(height: 8),
          HfButton(label: Strings.tryAgain, kind: HfButtonKind.secondary, onPressed: onRetry, expand: false),
        ],
      ),
    );
  }
}

class _InlineEmpty extends StatelessWidget {
  const _InlineEmpty({required this.message, required this.onBrowse});

  final String message;
  final VoidCallback onBrowse;

  @override
  Widget build(BuildContext context) {
    return HfCard(
      color: HfColors.lilac,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(message, style: HfText.bodyText),
          const SizedBox(height: 8),
          HfButton(label: HomeCopy.browseAll, kind: HfButtonKind.secondary, onPressed: onBrowse, expand: false),
        ],
      ),
    );
  }
}

class _SavedNote extends StatelessWidget {
  const _SavedNote();

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const ValueKey<String>('home-saved-pill'),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: HfColors.butter,
        borderRadius: BorderRadius.circular(HfRadius.pill),
        border: Border.all(color: HfColors.butterDeep),
      ),
      child: const Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.history_rounded, size: 18, color: HfColors.plum),
          SizedBox(width: 6),
          Text(Strings.showingSavedList, style: HfText.badge),
        ],
      ),
    );
  }
}

/// Mood group tiles from `GET /api/hf/options`. A tile opens Explore filtered to that group's topics.
class _MoodTiles extends StatelessWidget {
  const _MoodTiles({required this.options});

  final HostOptions options;

  static const List<Color> _colors = [HfColors.blush, HfColors.lilac, HfColors.butter, HfColors.white];
  static const List<IconData> _icons = [
    Icons.waving_hand_rounded,
    Icons.favorite_rounded,
    Icons.cloud_rounded,
    Icons.auto_stories_rounded,
  ];

  @override
  Widget build(BuildContext context) {
    final groups = options.moodGroups;
    final rows = <Widget>[];
    for (var i = 0; i < groups.length; i += 2) {
      final pair = <Widget>[
        for (var j = i; j < i + 2; j++)
          Expanded(
            child: j < groups.length
                ? _MoodTile(
                    key: ValueKey<String>('mood-${groups[j].slug}'),
                    label: groups[j].label,
                    color: _colors[j % _colors.length],
                    icon: _icons[j % _icons.length],
                    onTap: () => context.go(HostFilters(topics: options.topicsOfGroup(groups[j])).toLocation()),
                  )
                : const SizedBox.shrink(),
          ),
      ];
      rows.add(IntrinsicHeight(
        child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          pair[0],
          const SizedBox(width: HfSpacing.gap),
          pair[1],
        ]),
      ));
      if (i + 2 < groups.length) rows.add(const SizedBox(height: HfSpacing.gap));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _SectionHeader(title: HomeCopy.moodTitle, hint: HomeCopy.moodHint),
        ...rows,
      ],
    );
  }
}

class _MoodTile extends StatelessWidget {
  const _MoodTile({super.key, required this.label, required this.color, required this.icon, required this.onTap});

  final String label;
  final Color color;
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return HfCard(
      color: color,
      onTap: onTap,
      padding: const EdgeInsets.all(16),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 72),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Icon(icon, size: 28, color: HfColors.rose),
            const SizedBox(height: 10),
            Text(label, style: HfText.subtitle),
          ],
        ),
      ),
    );
  }
}

/// Women-only and LGBTQ+ spaces: they open Explore on that lane tab (sign-in and verification happen there).
class _Spaces extends StatelessWidget {
  const _Spaces();

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _SectionHeader(title: HomeCopy.spacesTitle),
        _SpaceCard(
          title: HomeCopy.womenTitle,
          body: HomeCopy.womenBody,
          color: HfColors.blush,
          icon: Icons.spa_rounded,
          onTap: () => context.go(const HostFilters(lane: HostLane.women).toLocation()),
        ),
        const SizedBox(height: HfSpacing.gap),
        _SpaceCard(
          title: HomeCopy.lgbtqTitle,
          body: HomeCopy.lgbtqBody,
          color: HfColors.lilac,
          icon: Icons.diversity_1_rounded,
          onTap: () => context.go(const HostFilters(lane: HostLane.lgbtq).toLocation()),
        ),
      ],
    );
  }
}

class _SpaceCard extends StatelessWidget {
  const _SpaceCard({required this.title, required this.body, required this.color, required this.icon, required this.onTap});

  final String title;
  final String body;
  final Color color;
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return HfCard(
      color: color,
      onTap: onTap,
      child: Row(
        children: [
          Icon(icon, size: 32, color: HfColors.rose),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: HfText.subtitle),
                const SizedBox(height: 2),
                Text(body, style: HfText.note.copyWith(color: HfColors.plum)),
              ],
            ),
          ),
          const Icon(Icons.chevron_right_rounded, color: HfColors.plum),
        ],
      ),
    );
  }
}

/// The safety line, the disclaimer strip and the crisis numbers.
class _SafetyBlock extends StatelessWidget {
  const _SafetyBlock();

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        HfCard(
          color: HfColors.lilac,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.shield_rounded, size: 30, color: HfColors.orchid),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(HomeCopy.safetyTitle, style: HfText.subtitle),
                    const SizedBox(height: 4),
                    Text(HomeCopy.safetyBody, style: HfText.note.copyWith(color: HfColors.plum)),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: HfSpacing.gap),
        const Text(HomeCopy.disclaimer, style: HfText.note),
        const SizedBox(height: HfSpacing.gap),
        const CrisisStrip(),
      ],
    );
  }
}

/// "Become a host" (sign-in first). A person who already has a host profile gets a way to the Host tab instead.
class _HostCard extends ConsumerWidget {
  const _HostCard({required this.hasHost});

  final bool hasHost;

  Future<void> _open(BuildContext context, WidgetRef ref) async {
    if (hasHost) {
      context.go(Routes.host);
      return;
    }
    if (!await requireSignIn(context, ref)) return;
    if (!context.mounted) return;
    unawaited(GoRouter.of(context).push(Routes.hostOnboardingAt()));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return HfCard(
      color: HfColors.butter,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(hasHost ? HomeCopy.hostTitleExisting : HomeCopy.hostTitle, style: HfText.title),
          const SizedBox(height: 6),
          Text(hasHost ? HomeCopy.hostBodyExisting : HomeCopy.hostBody, style: HfText.bodyText),
          const SizedBox(height: 14),
          HfButton(
            label: hasHost ? HomeCopy.hostButtonExisting : HomeCopy.hostButton,
            onPressed: () => _open(context, ref),
          ),
        ],
      ),
    );
  }
}

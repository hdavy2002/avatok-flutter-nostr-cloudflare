import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/session.dart';
import '../../../core/config/flags.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../../home/data/home_balance.dart';
import '../../home/ui/home_copy.dart';
import '../data/host_filters.dart';
import '../data/host_options.dart';
import 'explore_copy.dart';

/// The top of Discover (mockup `Main`, dark: `HomeDark`): greeting, the question, the wallet pill, the search
/// bar with its filter button, the Everyone / Women-only / LGBTQ+ switch, the mood chips and the list title.
class DiscoveryHeader extends ConsumerWidget {
  const DiscoveryHeader({
    super.key,
    required this.filters,
    required this.options,
    required this.onFilters,
    required this.onApply,
    required this.onSearch,
    required this.search,
    this.showListTitle = false,
    this.trailing,
    this.now,
  });

  final HostFilters filters;
  final HostOptions? options;
  final VoidCallback onFilters;
  final ValueChanged<HostFilters> onApply;
  final ValueChanged<String> onSearch;
  final TextEditingController search;

  /// "Good listeners for you" and [trailing] ("23 online") under the chips.
  final bool showListTitle;
  final String? trailing;

  /// For tests: the clock the greeting reads.
  final DateTime? now;

  static const List<String> _lanes = <String>[
    'Everyone',
    'Women-only',
    'LGBTQ+',
  ];
  static const List<HfTint> _moodTints = <HfTint>[
    HfTint.peach,
    HfTint.sky,
    HfTint.butter,
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final dark = HfBrightness.isDark(context);
    final standardPlan = hfStdPlanOn(ref.watch(flagsProvider));
    final laneIndex = filters.lane == HostLane.women
        ? 1
        : filters.lane == HostLane.lgbtq
        ? 2
        : 0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(
            HfSpacing.pageWide,
            12,
            HfSpacing.pageWide,
            0,
          ),
          child: LayoutBuilder(
            builder: (context, c) {
              final texts = Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    ExploreCopy.title,
                    style: HfText.of(context, HfText.hero),
                  ),
                  const SizedBox(height: HfSpacing.xs),
                  Text(
                    ExploreCopy.tagline,
                    style: HfText.of(context, HfText.body),
                  ),
                ],
              );
              // A very big system font or a very narrow phone: the pill goes under the question.
              final stacked =
                  c.maxWidth < 300 ||
                  MediaQuery.textScalerOf(context).scale(16) > 22;
              if (stacked) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    texts,
                    const SizedBox(height: HfSpacing.sm),
                    const _WalletPill(),
                  ],
                );
              }
              return Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(child: texts),
                  const SizedBox(width: HfSpacing.lg),
                  const _WalletPill(),
                ],
              );
            },
          ),
        ),
        const SizedBox(height: HfSpacing.xxl),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: HfSpacing.pageWide),
          child: _SearchBar(
            controller: search,
            onChanged: onSearch,
            onFilters: onFilters,
            activeCount: filters.activeCount,
          ),
        ),
        if (standardPlan) ...[
          const SizedBox(height: HfSpacing.sm),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: HfSpacing.pageWide),
            child: Text(ExploreCopy.sameRate, style: HfText.note),
          ),
        ],
        const SizedBox(height: HfSpacing.xxl),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: HfSpacing.pageWide),
          child: HfSegmented(
            options: _lanes,
            selected: laneIndex,
            onChanged: (i) {
              HapticFeedback.selectionClick();
              onApply(
                filters.copyWith(
                  lane: i == 1
                      ? HostLane.women
                      : i == 2
                      ? HostLane.lgbtq
                      : null,
                ),
              );
            },
          ),
        ),
        const SizedBox(height: HfSpacing.xl),
        _moodRow(context),
        if (showListTitle)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              HfSpacing.pageWide,
              22,
              HfSpacing.pageWide,
              0,
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Expanded(
                  child: Text(
                    ExploreCopy.listTitle,
                    style: HfText.of(context, HfText.section),
                  ),
                ),
                if (trailing != null) ...[
                  const SizedBox(width: HfSpacing.md),
                  Flexible(
                    child: Text(
                      trailing!,
                      textAlign: TextAlign.end,
                      style: HfText.label.copyWith(
                        color: dark ? HfColors.mutedSoft : HfColors.muted,
                        fontWeight: FontWeight.w400,
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
      ],
    );
  }

  bool _groupSelected(MoodGroup g) {
    final t = options?.topicsOfGroup(g) ?? const <String>[];
    return t.isNotEmpty &&
        filters.topics.length == t.length &&
        t.every(filters.topics.contains);
  }

  /// "All moods" (dark chip) and one tinted chip per server mood group; a picked group is a topic filter.
  Widget _moodRow(BuildContext context) {
    final groups = options?.moodGroups ?? const <MoodGroup>[];
    final allSelected = filters.topics.isEmpty;
    return SizedBox(
      height: HfSpacing.tap,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: HfSpacing.pageWide),
        itemCount: groups.length + 1,
        separatorBuilder: (_, __) => const SizedBox(width: HfSpacing.sm),
        itemBuilder: (context, i) {
          if (i == 0) {
            void resetMoods() {
              HapticFeedback.selectionClick();
              onApply(filters.copyWith(topics: const <String>[]));
            }

            return allSelected
                ? HfChip.dark(
                    key: const ValueKey<String>('mood-all'),
                    label: ExploreCopy.allMoods,
                    onTap: resetMoods,
                  )
                : HfChip.outline(
                    key: const ValueKey<String>('mood-all'),
                    label: ExploreCopy.allMoods,
                    onTap: resetMoods,
                  );
          }
          final g = groups[i - 1];
          final tint = _moodTints[(i - 1) % _moodTints.length];
          final picked = _groupSelected(g);
          void onTap() {
            HapticFeedback.selectionClick();
            onApply(
              filters.copyWith(
                topics: picked ? const <String>[] : options!.topicsOfGroup(g),
              ),
            );
          }

          final key = ValueKey<String>('mood-${g.slug}');
          return picked
              ? HfChip.selected(
                  key: key,
                  label: g.label,
                  tint: tint,
                  onTap: onTap,
                )
              : HfChip.filled(
                  key: key,
                  label: g.label,
                  tint: tint,
                  onTap: onTap,
                );
        },
      ),
    );
  }
}

/// The lavender wallet pill: the balance for a signed-in person, "Sign in" for a guest. Opens `/wallet`.
class _WalletPill extends ConsumerWidget {
  const _WalletPill();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final dark = HfBrightness.isDark(context);
    final signedIn = ref.watch(sessionProvider.select((s) => s.isSignedIn));
    final wallet = signedIn ? ref.watch(homeBalanceProvider) : null;
    final balance = (wallet != null && wallet.hasValue)
        ? wallet.requireValue
        : null;
    final label = !signedIn
        ? HomeCopy.walletSignIn
        : (balance ?? HomeCopy.walletFallback);
    final bg = HfTint.lavender.bg(context);
    final fg = HfTint.lavender.ink(context);
    return Semantics(
      button: true,
      label: signedIn
          ? '${HomeCopy.walletLabel} $label'
          : '${HomeCopy.walletLabel}, $label',
      excludeSemantics: true,
      child: GestureDetector(
        key: const ValueKey<String>('wallet-pill'),
        behavior: HitTestBehavior.opaque,
        onTap: () => GoRouter.of(context).go(Routes.wallet),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: HfSpacing.tap),
          child: Center(
            widthFactor: 1,
            child: Container(
              constraints: const BoxConstraints(minHeight: 44),
              padding: const EdgeInsets.symmetric(horizontal: HfSpacing.xl),
              decoration: BoxDecoration(
                color: bg,
                borderRadius: BorderRadius.circular(22),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    Icons.account_balance_wallet_outlined,
                    size: 18,
                    color: fg,
                  ),
                  const SizedBox(width: HfSpacing.sm),
                  Text(
                    label,
                    style: HfText.buttonSmall.copyWith(
                      color: dark
                          ? HfColors.lavenderLight
                          : HfColors.lavenderDeep,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// White search bar (radius 18, hairline, soft shadow): magnifier, a text field and the soft-square filter button.
class _SearchBar extends StatelessWidget {
  const _SearchBar({
    required this.controller,
    required this.onChanged,
    required this.onFilters,
    required this.activeCount,
  });

  final TextEditingController controller;
  final ValueChanged<String> onChanged;
  final VoidCallback onFilters;
  final int activeCount;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final muted = dark ? HfColors.mutedSoft : HfColors.muted;
    return Container(
      constraints: const BoxConstraints(minHeight: 54),
      padding: const EdgeInsets.fromLTRB(16, 0, 8, 0),
      decoration: BoxDecoration(
        color: dark ? HfColors.darkCard : HfColors.white,
        borderRadius: BorderRadius.circular(HfRadius.input),
        border: Border.all(color: dark ? HfColors.darkLine : HfColors.line),
        boxShadow: dark ? null : HfShadows.field,
      ),
      child: Row(
        children: [
          Icon(Icons.search_rounded, size: 20, color: muted),
          const SizedBox(width: HfSpacing.lg),
          Expanded(
            child: TextField(
              controller: controller,
              onChanged: onChanged,
              textInputAction: TextInputAction.search,
              style: HfText.body.copyWith(
                fontSize: 15,
                color: dark ? HfColors.darkText : HfColors.ink,
              ),
              decoration: InputDecoration(
                isDense: true,
                filled: false,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                contentPadding: const EdgeInsets.symmetric(vertical: 14),
                hintText: ExploreCopy.searchHint,
                hintStyle: HfText.body.copyWith(fontSize: 15, color: muted),
              ),
            ),
          ),
          ListenableBuilder(
            listenable: controller,
            builder: (context, _) => controller.text.isEmpty
                ? const SizedBox.shrink()
                : IconButton(
                    tooltip: 'Clear search',
                    onPressed: () {
                      controller.clear();
                      onChanged('');
                    },
                    icon: Icon(Icons.close_rounded, color: muted),
                  ),
          ),
          Tooltip(
            message: ExploreCopy.filters,
            child: GestureDetector(
              key: const ValueKey<String>('open-filters'),
              behavior: HitTestBehavior.opaque,
              onTap: onFilters,
              child: SizedBox(
                width: HfSpacing.tap,
                height: HfSpacing.tap,
                child: Center(
                  child: Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(
                      color: dark ? HfColors.darkBar : HfColors.surfaceSoft,
                      borderRadius: BorderRadius.circular(HfRadius.segmentItem),
                    ),
                    child: Badge(
                      isLabelVisible: activeCount > 0,
                      backgroundColor: dark ? HfColors.lavender : HfColors.ink,
                      label: Text(
                        '$activeCount',
                        style: HfText.badge.copyWith(
                          color: dark ? HfColors.ink : HfColors.white,
                        ),
                      ),
                      child: Icon(
                        Icons.tune_rounded,
                        size: 18,
                        color: dark ? HfColors.darkText : HfColors.ink,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

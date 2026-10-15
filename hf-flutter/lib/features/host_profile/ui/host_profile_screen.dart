import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import '../../../core/brand.dart';
import '../../../core/links.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/strings.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../data/host_profile.dart';
import '../data/host_profile_providers.dart';
import '../host_profile_strings.dart';
import 'widgets/gallery_grid.dart';
import 'widgets/host_action_bar.dart';
import 'widgets/profile_common.dart';
import 'widgets/profile_header.dart';
import 'widgets/profile_hero.dart';
import 'widgets/profile_sections.dart';
import 'widgets/profile_skeleton.dart';
import 'widgets/reviews_section.dart';
import 'widgets/voice_intro_player.dart';

/// `/h/:slug`. Public: anyone can look. Call and Notify me ask for sign-in first (browse-before-sign-in).
///
/// States: loading (skeleton of the layout), content, not found ("This profile isn't available."), error with
/// "Try again", and the saved copy of the last visit when the network fails (with a "Showing saved profile" pill).
class HostProfileScreen extends ConsumerStatefulWidget {
  const HostProfileScreen({super.key, required this.slug, this.lane});

  final String slug;
  final String? lane;

  @override
  ConsumerState<HostProfileScreen> createState() => _HostProfileScreenState();
}

class _HostProfileScreenState extends ConsumerState<HostProfileScreen> {
  bool _viewLogged = false;

  void _logViewed(HostProfile p) {
    if (_viewLogged) return;
    _viewLogged = true;
    unawaited(
      Analytics.capture('hf_app_profile_viewed', {
        'slug': widget.slug,
        'status': p.status.name,
      }),
    );
  }

  Future<void> _report() async {
    unawaited(Analytics.capture('hf_app_report_tapped', {'slug': widget.slug}));
    // The web report page (needed by Play's UGC policy). The slug rides along so the page can show who it is about.
    await LinkOpener.instance.site(
      Uri(
        path: '/report',
        queryParameters: {'profile': widget.slug},
      ).toString(),
    );
  }

  @override
  Widget build(BuildContext context) {
    final slug = widget.slug;
    final async = widget.lane == null
        ? ref.watch(hostProfileProvider(slug))
        : ref.watch(laneHostProfileProvider((slug: slug, lane: widget.lane!)));
    final query = GoRouterState.of(context).uri.queryParameters;
    final notifyIntent = query['action'] != 'notify'
        ? null
        : query['notify'] == 'on' || query['notify'] == 'off'
        ? query['notify']
        : 'choose';
    final Widget? bar = async.when<Widget?>(
      data: (r) => HostActionBar(
        key: ValueKey('$slug:${widget.lane}:$notifyIntent'),
        profile: r.profile,
        notificationIntent: notifyIntent,
      ),
      loading: () => null,
      error: (_, __) => null,
    );
    return Scaffold(
      backgroundColor: profilePage(context),
      body: async.when(
        loading: () => _Frame(
          child: Semantics(
            liveRegion: true,
            label: HostProfileStrings.loading,
            child: const SingleChildScrollView(
              physics: NeverScrollableScrollPhysics(),
              child: ProfileSkeleton(),
            ),
          ),
        ),
        error: (e, _) => _Frame(
          child: Padding(
            padding: const EdgeInsets.only(top: 72),
            child: _errorBody(e),
          ),
        ),
        data: (r) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted) _logViewed(r.profile);
          });
          return _ProfileBody(result: r, onReport: _report);
        },
      ),
      bottomNavigationBar: bar,
    );
  }

  Widget _errorBody(Object e) {
    if (e is ApiError && e.isNotEnabled) return const ComingSoonPanel();
    if (e is ApiError && e.status == 404) {
      return EmptyPanel(
        message: Strings.notAvailable,
        icon: Icons.person_off_rounded,
        actionLabel: HostProfileStrings.exploreHosts,
        onAction: () => GoRouter.of(context).go(Routes.explore),
      );
    }
    if (e is ApiError &&
        (e.status == 401 || e.status == 403) &&
        widget.lane != null) {
      return EmptyPanel(
        message: 'Verify to enter this private space.',
        icon: Icons.lock_outline_rounded,
        actionLabel: 'Continue to verification',
        onAction: () => GoRouter.of(context).push(
          Routes.lanesOf(
            widget.lane,
            next: Routes.hostProfileOf(widget.slug, lane: widget.lane),
          ),
        ),
      );
    }
    return ErrorPanel(
      error: e,
      onRetry: () {
        if (widget.lane == null) {
          ref.invalidate(hostProfileProvider(widget.slug));
        } else {
          ref.invalidate(
            laneHostProfileProvider((slug: widget.slug, lane: widget.lane!)),
          );
        }
      },
    );
  }
}

/// Loading / error layout: the content with a floating back button, since there is no app bar.
class _Frame extends StatelessWidget {
  const _Frame({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        Positioned.fill(child: child),
        Positioned(
          top: _topInset(context),
          left: HfSpacing.page,
          child: HeroCircleButton(
            icon: Icons.arrow_back_rounded,
            label: HostProfileStrings.backLabel,
            onTap: () => popOrHome(context),
          ),
        ),
      ],
    );
  }
}

double _topInset(BuildContext context) =>
    MediaQuery.paddingOf(context).top + HfSpacing.sm;

/// Height of the pinned bar below the top inset: the 48 px back button / tab bar.
const double _stickyBarHeight = HfSpacing.tap + HfSpacing.sm;

String _savedKey() => 'hf.saved_hosts.v1';

class _ProfileBody extends ConsumerStatefulWidget {
  const _ProfileBody({required this.result, required this.onReport});

  final HostProfileResult result;
  final VoidCallback onReport;

  @override
  ConsumerState<_ProfileBody> createState() => _ProfileBodyState();
}

class _ProfileBodyState extends ConsumerState<_ProfileBody> {
  static const int _about = 0, _topics = 1, _reviews = 2, _gallery = 3;

  final ScrollController _scroll = ScrollController();
  final List<GlobalKey> _keys = List<GlobalKey>.generate(4, (_) => GlobalKey());
  int _tab = _about;
  final GlobalKey _segKey = GlobalKey();
  bool _jumping = false;
  bool _stuck = false;
  bool _saved = false;

  HostProfile get _p => widget.result.profile;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_follow);
    unawaited(_loadSaved());
  }

  @override
  void dispose() {
    _scroll.removeListener(_follow);
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _loadSaved() async {
    final entry = await ref
        .read(jsonCacheProvider)
        .read(_savedKey(), scoped: true);
    final data = entry?.data;
    if (!mounted || data is! List) return;
    final saved = data.map((e) => '$e').contains(_p.slug);
    if (saved != _saved) setState(() => _saved = saved);
  }

  Future<void> _toggleSaved() async {
    unawaited(HapticFeedback.selectionClick());
    final next = !_saved;
    setState(() => _saved = next);
    final cache = ref.read(jsonCacheProvider);
    final entry = await cache.read(_savedKey(), scoped: true);
    final data = entry?.data;
    final slugs = <String>{if (data is List) ...data.map((e) => '$e')};
    if (next) {
      slugs.add(_p.slug);
    } else {
      slugs.remove(_p.slug);
    }
    await cache.write(_savedKey(), slugs.toList(), scoped: true);
  }

  Future<void> _share() async {
    await Clipboard.setData(
      ClipboardData(text: Brand.url(Routes.hostProfileOf(_p.slug))),
    );
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        const SnackBar(content: Text(HostProfileStrings.linkCopied)),
      );
  }

  /// Which section the person is reading: the last one whose top has passed the follow line.
  int _currentSection() {
    final line = _topInset(context) + 120;
    var current = _about;
    for (var i = 0; i < _keys.length; i++) {
      final box = _keys[i].currentContext?.findRenderObject();
      if (box is! RenderBox || !box.attached) continue;
      if (box.localToGlobal(Offset.zero).dy <= line) current = i;
    }
    if (_scroll.hasClients &&
        _scroll.position.pixels >= _scroll.position.maxScrollExtent - 4 &&
        _p.gallery.isNotEmpty) {
      final box = _keys[_gallery].currentContext?.findRenderObject();
      if (box is RenderBox &&
          box.attached &&
          box.localToGlobal(Offset.zero).dy <
              MediaQuery.sizeOf(context).height * 0.8) {
        current = _gallery;
      }
    }
    return current;
  }

  /// The in-flow tab bar has scrolled away: a copy is pinned at the top (with a back button) so the tabs stay reachable.
  void _updateStuck() {
    final box = _segKey.currentContext?.findRenderObject();
    if (box is! RenderBox || !box.attached || !mounted) return;
    final stuck =
        box.localToGlobal(Offset.zero).dy + box.size.height <=
        _topInset(context) + _stickyBarHeight;
    if (stuck != _stuck) setState(() => _stuck = stuck);
  }

  bool _followQueued = false;

  /// Scroll positions change before the next layout, so the sections are measured after the frame.
  void _follow() {
    if (_followQueued) return;
    _followQueued = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _followQueued = false;
      if (!mounted) return;
      _updateStuck();
      if (_jumping) return;
      final now = _currentSection();
      if (now != _tab) setState(() => _tab = now);
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  Future<void> _goTo(int index) async {
    unawaited(HapticFeedback.selectionClick());
    setState(() => _tab = index);
    final target = _keys[index].currentContext;
    if (target == null) return;
    _jumping = true;
    try {
      await Scrollable.ensureVisible(
        target,
        alignment: 0.1,
        duration: HfMotion.of(context, HfMotion.slow),
        curve: HfMotion.curve,
      );
    } finally {
      _jumping = false;
      _updateStuck();
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = _p;
    final labels = ref
        .watch(topicLabelsProvider)
        .when(
          data: (m) => m,
          loading: () => const <String, String>{},
          error: (_, __) => const <String, String>{},
        );
    const pad = EdgeInsets.symmetric(horizontal: kProfileSidePad);
    const gap = SizedBox(height: kProfileGap);
    final quote = p.quote;
    final segmented = HfSegmented(
      options: const [
        HostProfileStrings.about,
        HostProfileStrings.tabTopics,
        HostProfileStrings.tabReviews,
        HostProfileStrings.gallery,
      ],
      selected: _tab,
      onChanged: _goTo,
    );
    return Stack(
      children: [
        CustomScrollView(
          controller: _scroll,
          slivers: [
            // The photo area is 408 tall; the rounded body sheet starts right below it (the mockup overlaps 32 px).
            SliverToBoxAdapter(
              child: SizedBox(
                height: kHeroHeight,
                child: ProfileHero(profile: p),
              ),
            ),
            SliverToBoxAdapter(
              child: Stack(
                children: [
                  // The photo's colour shows behind the sheet's rounded top corners.
                  Positioned(
                    top: 0,
                    left: 0,
                    right: 0,
                    height: kHeroOverlap,
                    child: const ColoredBox(color: ProfileSunBandsPainter.base),
                  ),
                  Container(
                    decoration: BoxDecoration(
                      color: profilePage(context),
                      borderRadius: const BorderRadius.vertical(
                        top: Radius.circular(HfRadius.sheet),
                      ),
                    ),
                    padding: const EdgeInsets.only(
                      top: 22,
                      bottom: HfSpacing.section,
                    ),
                    // HF-MOTION-B: the sections rise in one after another on first load only (the
                    // state survives rebuilds, so scrolling and refreshes do not replay it).
                    child: StaggeredReveal(
                      key: const ValueKey<String>('profile-sections-reveal'),
                      stagger: const Duration(milliseconds: 45),
                      children: [
                        if (widget.result.fromCache) ...[
                          const Padding(
                            padding: pad,
                            child: Align(
                              alignment: Alignment.centerLeft,
                              child: _SavedPill(
                                label: HostProfileStrings.savedProfile,
                              ),
                            ),
                          ),
                          const SizedBox(height: HfSpacing.lg),
                        ],
                        Padding(
                          padding: pad,
                          child: ProfileHeader(
                            profile: p,
                            onReviews: () => _goTo(_reviews),
                          ),
                        ),
                        if (p.hasIntro) ...[
                          gap,
                          Padding(
                            padding: pad,
                            child: VoiceIntroPlayer(
                              url: p.introAudioUrl!,
                              name: p.displayName,
                              introSeconds: p.introSeconds,
                            ),
                          ),
                        ],
                        if (quote != null) ...[
                          gap,
                          Padding(
                            padding: pad,
                            child: QuoteCard(quote: quote, name: p.displayName),
                          ),
                        ],
                        gap,
                        Padding(
                          padding: pad,
                          child: KeyedSubtree(key: _segKey, child: segmented),
                        ),
                        gap,
                        KeyedSubtree(
                          key: _keys[_about],
                          child: AboutSection(profile: p),
                        ),
                        gap,
                        KeyedSubtree(
                          key: _keys[_topics],
                          child: TopicsSection(profile: p, labels: labels),
                        ),
                        gap,
                        KeyedSubtree(
                          key: _keys[_reviews],
                          child: ReviewsSection(
                            profile: p,
                            topicLabels: labels,
                          ),
                        ),
                        gap,
                        KeyedSubtree(
                          key: _keys[_gallery],
                          child: GalleryGrid(items: p.gallery),
                        ),
                        gap,
                        const BeforeYouCall(),
                        gap,
                        CrisisAndReport(onReport: widget.onReport),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        if (_stuck)
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: Container(
              color: profilePage(context),
              padding: EdgeInsets.fromLTRB(
                HfSpacing.page,
                _topInset(context),
                HfSpacing.page,
                HfSpacing.sm,
              ),
              child: Row(
                children: [
                  HeroCircleButton(
                    icon: Icons.arrow_back_rounded,
                    label: HostProfileStrings.backLabel,
                    onTap: () => popOrHome(context),
                  ),
                  const SizedBox(width: HfSpacing.sm),
                  Expanded(child: segmented),
                ],
              ),
            ),
          )
        else
          Positioned(
            top: _topInset(context),
            left: HfSpacing.page,
            right: HfSpacing.page,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                HeroCircleButton(
                  icon: Icons.arrow_back_rounded,
                  label: HostProfileStrings.backLabel,
                  onTap: () => popOrHome(context),
                ),
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    HeroCircleButton(
                      icon: _saved
                          ? Icons.favorite_rounded
                          : Icons.favorite_border_rounded,
                      label: _saved
                          ? HostProfileStrings.unsaveLabel
                          : HostProfileStrings.saveLabel,
                      color: HfColors.rose,
                      toggled: _saved,
                      onTap: _toggleSaved,
                    ),
                    const SizedBox(width: HfSpacing.sm),
                    HeroCircleButton(
                      icon: Icons.ios_share_rounded,
                      label: HostProfileStrings.shareLabel,
                      onTap: _share,
                    ),
                  ],
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class _SavedPill extends StatelessWidget {
  const _SavedPill({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
      decoration: BoxDecoration(
        color: dark ? HfColors.darkBar : HfColors.surfaceSoft,
        borderRadius: BorderRadius.circular(HfRadius.chip),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.cloud_off_rounded, size: 16, color: profileMuted(context)),
          const SizedBox(width: HfSpacing.xs),
          Flexible(
            child: Text(
              label,
              style: HfText.badge.copyWith(color: profileMuted(context)),
            ),
          ),
        ],
      ),
    );
  }
}

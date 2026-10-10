import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_error.dart';
import '../../../core/links.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/strings.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../data/host_profile.dart';
import '../data/host_profile_providers.dart';
import '../host_profile_strings.dart';
import 'widgets/gallery_pager.dart';
import 'widgets/host_action_bar.dart';
import 'widgets/profile_header.dart';
import 'widgets/reviews_section.dart';
import 'widgets/voice_intro_player.dart';

/// `/h/:slug`. Public: anyone can look. Call and Notify me ask for sign-in first (browse-before-sign-in).
///
/// States: loading, content, not found ("This profile isn't available."), error with "Try again", and
/// the saved copy of the last visit when the network fails (with a "Showing saved profile" pill).
class HostProfileScreen extends ConsumerStatefulWidget {
  const HostProfileScreen({super.key, required this.slug});

  final String slug;

  @override
  ConsumerState<HostProfileScreen> createState() => _HostProfileScreenState();
}

class _HostProfileScreenState extends ConsumerState<HostProfileScreen> {
  bool _viewLogged = false;

  void _logViewed(HostProfile p) {
    if (_viewLogged) return;
    _viewLogged = true;
    unawaited(Analytics.capture('hf_app_profile_viewed', {'slug': widget.slug, 'status': p.status.name}));
  }

  Future<void> _report() async {
    unawaited(Analytics.capture('hf_app_report_tapped', {'slug': widget.slug}));
    // The web report page (needed by Play's UGC policy). The slug rides along so the page can show who it is about.
    await LinkOpener.instance.site(Uri(path: '/report', queryParameters: {'profile': widget.slug}).toString());
  }

  @override
  Widget build(BuildContext context) {
    final slug = widget.slug;
    final async = ref.watch(hostProfileProvider(slug));
    final Widget? bar = async.when<Widget?>(
      data: (r) => HostActionBar(profile: r.profile),
      loading: () => null,
      error: (_, __) => null,
    );
    return Scaffold(
      appBar: AppBar(
        leading: const HfBackButton(),
        title: const Text(HostProfileStrings.appBarTitle),
      ),
      body: async.when(
        loading: () => const LoadingPanel(message: HostProfileStrings.loading),
        error: (e, _) => _errorBody(e),
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
    return ErrorPanel(error: e, onRetry: () => ref.invalidate(hostProfileProvider(widget.slug)));
  }
}

class _ProfileBody extends ConsumerWidget {
  const _ProfileBody({required this.result, required this.onReport});

  final HostProfileResult result;
  final VoidCallback onReport;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = result.profile;
    final labels = ref.watch(topicLabelsProvider).when(
          data: (m) => m,
          loading: () => const <String, String>{},
          error: (_, __) => const <String, String>{},
        );
    final estimate = ref.watch(hostEstimateProvider(p.slug)).when(
          data: (e) => e,
          loading: () => null,
          error: (_, __) => null,
        );
    final about = p.aboutPolished;
    final quote = p.quote;
    final facts = <(String, String)>[
      if (p.languages.isNotEmpty) (HostProfileStrings.languages, p.languages.join(', ')),
      if (p.styleLabel != null) (HostProfileStrings.style, p.styleLabel!),
    ];
    const gap = SizedBox(height: HfSpacing.gapLarge);
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(HfSpacing.page, 8, HfSpacing.page, HfSpacing.gapLarge),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (result.fromCache) ...[
            const Align(
              alignment: Alignment.centerLeft,
              child: HfTag(label: HostProfileStrings.savedProfile, icon: Icons.cloud_off_rounded),
            ),
            const SizedBox(height: HfSpacing.gap),
          ],
          ProfileHeader(profile: p, estimate: estimate),
          if (p.hasIntro) ...[
            gap,
            VoiceIntroPlayer(url: p.introAudioUrl!, introSeconds: p.introSeconds),
          ],
          if (about != null || quote != null) ...[
            gap,
            HfCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Semantics(header: true, child: Text('${HostProfileStrings.about} ${p.displayName}', style: HfText.title)),
                  if (about != null) ...[
                    const SizedBox(height: HfSpacing.gap),
                    Text(about, style: HfText.bodyText),
                  ],
                  if (quote != null) ...[
                    const SizedBox(height: HfSpacing.gapLarge),
                    Container(
                      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                      decoration: BoxDecoration(
                        color: HfColors.butter,
                        borderRadius: BorderRadius.circular(HfRadius.control),
                      ),
                      child: Text('“$quote”', style: HfText.bodyStrong),
                    ),
                  ],
                ],
              ),
            ),
          ],
          if (p.topics.isNotEmpty || facts.isNotEmpty) ...[
            gap,
            HfCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (p.topics.isNotEmpty) ...[
                    Semantics(header: true, child: const Text(HostProfileStrings.talkAbout, style: HfText.title)),
                    const SizedBox(height: HfSpacing.gap),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [for (final t in p.topics) HfTag(label: topicLabel(labels, t))],
                    ),
                  ],
                  for (final f in facts) ...[
                    const SizedBox(height: HfSpacing.gap),
                    Text(f.$1, style: HfText.label),
                    const SizedBox(height: 2),
                    Text(f.$2, style: HfText.bodyText),
                  ],
                ],
              ),
            ),
          ],
          if (p.gallery.isNotEmpty) ...[
            gap,
            GalleryPager(items: p.gallery),
          ],
          gap,
          ReviewsSection(profile: p, topicLabels: labels),
          gap,
          const _BeforeYouCall(),
          const SizedBox(height: HfSpacing.gap),
          const CrisisStrip(),
          const SizedBox(height: HfSpacing.gap),
          Align(
            alignment: Alignment.centerLeft,
            child: HfButton(
              label: HostProfileStrings.report,
              icon: Icons.flag_outlined,
              kind: HfButtonKind.text,
              expand: false,
              onPressed: onReport,
            ),
          ),
        ],
      ),
    );
  }
}

class _BeforeYouCall extends StatelessWidget {
  const _BeforeYouCall();

  @override
  Widget build(BuildContext context) {
    return HfCard(
      color: HfColors.blush,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(header: true, child: const Text(HostProfileStrings.beforeYouCall, style: HfText.title)),
          const SizedBox(height: HfSpacing.gap),
          const Text(HostProfileStrings.disclosure, style: HfText.bodyText),
          for (final n in HostProfileStrings.beforeNotes) ...[
            const SizedBox(height: HfSpacing.gap),
            Text(n.$1, style: HfText.bodyStrong),
            const SizedBox(height: 2),
            Text(n.$2, style: HfText.bodyText),
          ],
        ],
      ),
    );
  }
}

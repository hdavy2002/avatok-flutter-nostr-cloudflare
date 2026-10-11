import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/config/flags.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../data/host_card.dart';
import 'host_image.dart';
import 'intro_player.dart';

/// Always-visible compact AI avatar disclosure, approved 2026-10-11.
const String kAiPictureLabel = 'AI avatar';

/// What a tap on a host card does by default: telemetry `hf_app_host_card_tapped {slug, from}`, stop any
/// intro that is playing, then open the host profile (`/h/:slug`).
void openHostProfile(BuildContext context, WidgetRef ref, HostCard host, {required String from, String? lane}) {
  Analytics.capture('hf_app_host_card_tapped', <String, Object>{'slug': host.slug, 'from': from});
  ref.read(introPlayerProvider.notifier).stop();
  GoRouter.of(context).push(Routes.hostProfileOf(host.slug, lane: lane));
}

/// Play / pause for a host's voice intro, inline. One speaker for the whole app: starting one intro stops
/// the one before. A 48 dp round button, with the length ("12s") beside it.
/// Shared with the host profile screen: give it `from: 'profile'`.
class IntroPlayButton extends ConsumerWidget {
  const IntroPlayButton({super.key, required this.host, required this.from, this.dark = false});

  final HostCard host;
  final bool dark;

  /// Where the card sits (`explore`, `home`, `profile`): telemetry `hf_app_intro_played {slug, from}`.
  final String from;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final url = host.introAudioUrl;
    if (url == null || url.isEmpty) return const SizedBox.shrink();
    final player = ref.watch(introPlayerProvider);
    final playing = player.isPlaying(host.slug);
    final failed = player.failedSlug == host.slug;
    final label = playing ? 'Pause voice intro of ${host.displayName}' : 'Play voice intro of ${host.displayName}';
    return Wrap(
      crossAxisAlignment: WrapCrossAlignment.center,
      runSpacing: 6,
      children: [
        Semantics(
          button: true,
          label: label,
          excludeSemantics: true,
          child: InkResponse(
            key: ValueKey<String>('intro-${host.slug}'),
            onTap: () => ref.read(introPlayerProvider.notifier).toggle(slug: host.slug, url: url, from: from),
            radius: 28,
            child: Container(
              width: HfSpacing.tap,
              height: HfSpacing.tap,
              decoration: const BoxDecoration(color: HfColors.coral, shape: BoxShape.circle),
              child: Icon(
                playing ? Icons.pause_rounded : Icons.play_arrow_rounded,
                size: 28,
                color: HfColors.ink,
              ),
            ),
          ),
        ),
        if (host.introSeconds != null) ...[
          const SizedBox(width: 6),
          Text('${host.introSeconds}s', style: HfText.badge.copyWith(color: dark ? HfColors.white : HfColors.mauve)),
        ],
        if (failed) ...[
          const SizedBox(width: 6),
          Text("Can't play", style: HfText.badge.copyWith(color: HfColors.accent)),
        ],
      ],
    );
  }
}

/// A host in the Explore list: picture, name, tagline, languages, topics, price, rating, status and the
/// intro button. The whole card opens the profile.
///
/// [topicLabels] maps a topic slug to its label (`HostOptions.topicLabels`); an unknown slug shows as words.
/// Pass [onTap] to replace the default (open the profile).
class HostCardView extends ConsumerWidget {
  const HostCardView({
    super.key,
    required this.host,
    this.topicLabels = const <String, String>{},
    this.from = 'explore',
    this.onTap,
    this.animate = true,
    this.lane,
  });

  final HostCard host;
  final Map<String, String> topicLabels;
  final String from;
  final String? lane;
  final VoidCallback? onTap;

  /// False in widget tests (the online dot pulses forever, which never settles).
  final bool animate;

  static const int _maxTopics = 3;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final callsOn = ref.watch(flagsProvider).when(data: (f) => f.hfCallsEnabled, loading: () => false, error: (_, __) => false);
    final tags = <String>[
      for (final t in host.topics.take(_maxTopics)) topicLabels[t] ?? t.replaceAll('-', ' '),
    ];
    final open = onTap ?? () => openHostProfile(context, ref, host, from: from, lane: lane);
    final palette = [HfColors.blush, HfColors.butter, HfColors.sky, HfColors.mint, HfColors.lavender];
    final shade = palette[host.slug.codeUnits.fold<int>(0, (a, b) => a+b) % palette.length];
    Widget identity() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(host.displayName, style: HfText.headline),
      const SizedBox(height: 8),
      StatusPill(presence: host.status, animate: animate),
      if (host.tagline != null) ...[
        const SizedBox(height: 10), Text(host.tagline!, style: HfText.bodyText)],
    ]);
    return HfCard(
      onTap: open,
      padding: const EdgeInsets.all(16),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        LayoutBuilder(builder: (context, c) {
          final stacked = c.maxWidth < 260 || MediaQuery.textScalerOf(context).scale(16) > 22;
          final photo = Container(padding: const EdgeInsets.all(4),
            decoration: BoxDecoration(color: shade, borderRadius: BorderRadius.circular(26)),
            child: HostAvatar(url: host.avatarUrl, size: stacked ? 152 : 124, radius: 22, aiLabel: kAiPictureLabel));
          if (stacked) return Column(crossAxisAlignment: CrossAxisAlignment.start,
            children: [photo, const SizedBox(height: 12), identity()]);
          return Row(crossAxisAlignment: CrossAxisAlignment.start,
            children: [photo, const SizedBox(width: 14), Expanded(child: identity())]);
        }),
        const SizedBox(height: 14),
        Wrap(spacing: 16, runSpacing: 10, children: [
          HostRating(host: host),
          if (host.regulars > 0) Text('${host.regulars} regulars', style: HfText.note),
          if (host.languages.isNotEmpty) Text(host.languages.join(' · '), style: HfText.bodyText),
          if (host.style != null) Text(host.style!.replaceAll('_', ' ').replaceAll('-', ' '), style: HfText.note),
        ]),
        if (tags.isNotEmpty || host.womenOnly || host.lgbtqFriendly) ...[
          const SizedBox(height: 14),
          Wrap(spacing: 8, runSpacing: 8, children: [
            if (host.womenOnly) const HostTag('Women-only', accent: true),
            if (host.lgbtqFriendly) const HostTag('LGBTQ+ friendly', accent: true),
            for (final t in tags) HostTag(t),
          ]),
        ],
        if (host.hasIntro) ...[
          const SizedBox(height: 16), _CardVoice(host: host, from: from)],
        const SizedBox(height: 16),
        LayoutBuilder(builder: (context, c) {
          final price = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(host.priceLabel, style: HfText.title),
            const Text('Estimate before you call', style: HfText.note),
          ]);
          final call = HfButton(label: !callsOn ? 'Calls open soon' : host.isOnline ? 'Call ${host.displayName}' : 'View availability',
            icon: host.isOnline ? Icons.call_rounded : Icons.notifications_outlined,
            onPressed: !callsOn ? null : host.isOnline ? () {
              ref.read(introPlayerProvider.notifier).stop();
              GoRouter.of(context).push(Routes.callConfirmOf(host.slug,
                lane: lane));
            } : open);
          if (c.maxWidth < 280 || MediaQuery.textScalerOf(context).scale(16)>22) {
            return Column(crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [price, const SizedBox(height: 12), call]);
          }
          return Row(children: [Expanded(child: price), const SizedBox(width: 12), Expanded(child: call)]);
        }),
        Align(alignment: Alignment.centerRight, child: TextButton(
          onPressed: open, child: const Text('View profile →'))),
      ]),
    );
  }
}

/// A dark voice strip keeps audio clearly separate from the paid call action.
class _CardVoice extends ConsumerWidget {
  const _CardVoice({required this.host, required this.from});
  final HostCard host;
  final String from;
  @override
  Widget build(BuildContext context, WidgetRef ref) => Container(
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(color: HfColors.ink, borderRadius: BorderRadius.circular(26)),
    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Expanded(child: IntroPlayButton(host: host, from: from, dark: true)),
        const SizedBox(width: 10),
        Expanded(flex: 2, child: Text('Hear ${host.displayName}',
          style: HfText.bodyStrong.copyWith(color: HfColors.white))),
      ]),
      const SizedBox(height: 8),
      ExcludeSemantics(child: SizedBox(height: 20, child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [for (var i=0;i<24;i++) Container(width: 3,
          height: 5.0 + (i * 7 % 16), decoration: BoxDecoration(
            color: HfColors.mint, borderRadius: BorderRadius.circular(3)))],
      ))),
      const SizedBox(height: 8),
      Text('Recorded by the host', style: HfText.badge.copyWith(color: HfColors.white)),
    ]),
  );
}

/// A narrow card for a horizontal strip ("Online now" on Home): picture, name, price, status, intro button.
class HostMiniCard extends ConsumerWidget {
  const HostMiniCard({super.key, required this.host, this.from = 'home', this.onTap, this.animate = true});

  final HostCard host;
  final String from;
  final VoidCallback? onTap;
  final bool animate;

  static const double width = 176;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return SizedBox(
      width: width,
      child: HfCard(
        onTap: onTap ?? () => openHostProfile(context, ref, host, from: from),
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Center(child: HostAvatar(url: host.avatarUrl, size: 96, aiLabel: kAiPictureLabel)),
            const SizedBox(height: 10),
            Text(host.displayName, style: HfText.subtitle, maxLines: 1, overflow: TextOverflow.ellipsis),
            const SizedBox(height: 2),
            Wrap(
              spacing: 8,
              runSpacing: 2,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Text(host.priceLabel, style: HfText.bodyStrong),
                HostRating(host: host),
              ],
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                _Pill(host: host, animate: animate),
                if (host.hasIntro) IntroPlayButton(host: host, from: from),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// "★ 4.8 (23)", or "New" when nobody has rated this host yet.
class HostRating extends StatelessWidget {
  const HostRating({super.key, required this.host});

  final HostCard host;

  @override
  Widget build(BuildContext context) {
    final r = host.rating;
    if (r == null || host.reviewCount <= 0) return Text('New', style: HfText.badge.copyWith(color: HfColors.orchid));
    return Semantics(
      label: 'Rated ${r.toStringAsFixed(1)} from ${host.reviewCount} reviews',
      excludeSemantics: true,
      child: Text.rich(
        TextSpan(children: [
          const TextSpan(text: '★ ', style: TextStyle(color: HfColors.rose)),
          TextSpan(text: r.toStringAsFixed(1), style: HfText.badge),
          TextSpan(text: ' (${host.reviewCount})', style: HfText.badge.copyWith(color: HfColors.mauve)),
        ]),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    );
  }
}

/// A small read-only tag (topic, "Women-only"). 14 sp.
class HostTag extends StatelessWidget {
  const HostTag(this.text, {super.key, this.accent = false});

  final String text;

  /// Rose on blush for the lane tags; orchid on lilac for topics.
  final bool accent;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: accent ? HfColors.blush : HfColors.lilac,
        borderRadius: BorderRadius.circular(HfRadius.pill),
      ),
      child: Text(text, style: HfText.badge.copyWith(color: accent ? HfColors.rose : HfColors.orchid)),
    );
  }
}

/// The status pill, shrunk to fit when the phone's font is turned up very high (never overflows).
class _Pill extends StatelessWidget {
  const _Pill({required this.host, required this.animate});

  final HostCard host;
  final bool animate;

  @override
  Widget build(BuildContext context) =>
      FittedBox(fit: BoxFit.scaleDown, child: StatusPill(presence: host.status, animate: animate));
}

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import '../../../core/config/flags.dart';
import '../../../core/format/money.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../../host_profile/data/host_profile_providers.dart';
import '../../host_profile/host_profile_strings.dart';
import '../data/favourites.dart';
import '../data/host_card.dart';
import 'host_image.dart';
import 'intro_player.dart';

/// Always-visible compact AI avatar disclosure, approved 2026-10-11.
const String kAiPictureLabel = 'AI avatar';

/// What a tap on a host card does by default: telemetry `hf_app_host_card_tapped {slug, from}`, stop any
/// intro that is playing, then open the host profile (`/h/:slug`).
void openHostProfile(
  BuildContext context,
  WidgetRef ref,
  HostCard host, {
  required String from,
  String? lane,
}) {
  Analytics.capture('hf_app_host_card_tapped', <String, Object>{
    'slug': host.slug,
    'from': from,
  });
  ref.read(introPlayerProvider.notifier).stop();
  GoRouter.of(context).push(Routes.hostProfileOf(host.slug, lane: lane));
}

/// Waveform bar heights (percent, 30 to 100) for a host's voice bar. The same slug always gives the same
/// shape, so the bar does not change between rebuilds, scrolls or app starts.
List<int> hostWaveHeights(String slug, {int count = 20}) {
  var h = 7;
  for (final c in slug.codeUnits) {
    h = (h * 31 + c) % 65537;
  }
  final out = <int>[];
  for (var i = 0; i < count; i++) {
    h = (h * 75 + 74) % 65537;
    out.add(30 + h % 71);
  }
  return out;
}

String _clock(int seconds) {
  final s = seconds < 0 ? 0 : seconds;
  return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
}

/// "calm_and-warm" to "Calm and warm".
String _prettyStyle(String? raw) {
  final s = (raw ?? '').replaceAll('_', ' ').replaceAll('-', ' ').trim();
  return s.isEmpty ? '—' : '${s[0].toUpperCase()}${s.substring(1)}';
}

/// Play / pause for a host's voice intro, inline. One speaker for the whole app: starting one intro stops
/// the one before. A 48 dp round button, with the length ("12s") beside it.
/// Shared with the host profile screen: give it `from: 'profile'`.
class IntroPlayButton extends ConsumerWidget {
  const IntroPlayButton({
    super.key,
    required this.host,
    required this.from,
    this.dark = false,
    this.compact = false,
  });

  final HostCard host;
  final bool dark;
  final bool compact;

  /// Where the card sits (`explore`, `home`, `profile`): telemetry `hf_app_intro_played {slug, from}`.
  final String from;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final url = host.introAudioUrl;
    if (url == null || url.isEmpty) return const SizedBox.shrink();
    final player = ref.watch(introPlayerProvider);
    final playing = player.isPlaying(host.slug);
    final failed = player.failedSlug == host.slug;
    final label = playing
        ? 'Pause voice intro of ${host.displayName}'
        : 'Play voice intro of ${host.displayName}';
    final muted = dark ? HfColors.mutedSoft : HfColors.muted;
    final buttonSize = compact ? 34.0 : HfSpacing.tap;
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
            onTap: () => ref
                .read(introPlayerProvider.notifier)
                .toggle(slug: host.slug, url: url, from: from),
            radius: 28,
            child: SizedBox(
              width: HfSpacing.tap,
              height: HfSpacing.tap,
              child: Center(
                child: Container(
                  width: buttonSize,
                  height: buttonSize,
                  decoration: BoxDecoration(
                    color: dark ? HfColors.peachLight : HfColors.ink,
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    playing ? Icons.pause_rounded : Icons.play_arrow_rounded,
                    size: compact ? 20 : 28,
                    color: dark ? HfColors.ink : HfColors.white,
                  ),
                ),
              ),
            ),
          ),
        ),
        const SizedBox(width: 6),
        Text(
          compact
              ? '0:${host.previewSeconds.toString().padLeft(2, '0')}'
              : '${host.previewSeconds}s',
          style: HfText.badge.copyWith(color: muted),
        ),
        if (failed) ...[
          const SizedBox(width: 6),
          Text(
            "Can't play",
            style: HfText.badge.copyWith(color: HfColors.accent),
          ),
        ],
      ],
    );
  }
}

/// A host on Discover (mockup `Main`): the photo card with the frosted name panel and voice bar, a 2x2 grid of
/// tiles, up to three topic chips and the price bar with the Call now / Notify me action.
///
/// [topicLabels] maps a topic slug to its label (`HostOptions.topicLabels`); an unknown slug shows as words.
/// Pass [onTap] to replace the default (open the profile). Tapping the photo or the name opens the profile.
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
  static const List<HfTint> _photoTints = <HfTint>[
    HfTint.lavender,
    HfTint.peach,
    HfTint.sky,
    HfTint.butter,
    HfTint.blush,
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final dark = HfBrightness.isDark(context);
    final open =
        onTap ??
        () => openHostProfile(context, ref, host, from: from, lane: lane);
    final saved = ref.watch(
      favouriteHostsProvider.select((s) => s.contains(host.slug)),
    );
    final tint =
        _photoTints[host.slug.codeUnits.fold<int>(0, (a, b) => a + b) %
            _photoTints.length];
    final dpr = MediaQuery.devicePixelRatioOf(context);
    final photo = host.avatarUrl == null
        ? null
        : resizedImageUrl(
            host.avatarUrl!,
            width: (MediaQuery.sizeOf(context).width - 12) * dpr,
            quality: 70,
          );
    final tags = <String>[
      for (final t in host.topics.take(_maxTopics))
        topicLabels[t] ?? t.replaceAll('-', ' '),
    ];
    final moreTopics = host.topics.length - _maxTopics;
    return Container(
      decoration: BoxDecoration(
        color: dark ? HfColors.darkCard : HfColors.white,
        borderRadius: BorderRadius.circular(HfRadius.card),
        boxShadow: dark ? null : HfShadows.card,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(6, 6, 6, 0),
            child: Semantics(
              container: true,
              button: true,
              label: 'Open ${host.displayName}’s profile',
              child: GestureDetector(
                onTap: open,
                child: HfPhotoCard(
                  imageUrl: photo,
                  height: (MediaQuery.sizeOf(context).width * 0.72)
                      .clamp(260.0, 340.0)
                      .toDouble(),
                  status: switch (host.status) {
                    HostPresence.online => HfPresence.online,
                    HostPresence.busy => HfPresence.busy,
                    HostPresence.offline => HfPresence.offline,
                  },
                  aiLabel: host.isAiAvatar ? kAiPictureLabel : null,
                  saved: saved,
                  tint: tint,
                  animatePill: animate,
                  onSave: () {
                    HapticFeedback.selectionClick();
                    unawaited(
                      ref
                          .read(favouriteHostsProvider.notifier)
                          .toggle(host.slug),
                    );
                  },
                  child: _PanelContent(host: host, from: from),
                ),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _tiles(),
                if (tags.isNotEmpty) ...[
                  // The chips are 40 high inside a 48 tap area, so 10 here is the mockup's 14 gap.
                  const SizedBox(height: HfSpacing.md),
                  Wrap(
                    spacing: HfSpacing.sm,
                    children: [
                      for (final t in tags) HfChip.outline(label: t),
                      if (moreTopics > 0) _MoreChip(count: moreTopics),
                    ],
                  ),
                  const SizedBox(height: HfSpacing.md),
                ] else
                  const SizedBox(height: HfSpacing.xl),
                _PriceBar(host: host, lane: lane, onOpen: open),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _tiles() {
    final langs = host.languages.isEmpty ? '—' : host.languages.join(', ');
    const gap = SizedBox(width: HfSpacing.sm);
    final textTile = HfText.badge.copyWith(height: 1.35);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: HfTile(
                  tint: HfTint.lavender,
                  icon: Icons.groups_rounded,
                  value: '${host.talkedTo}',
                  caption: 'talked to',
                  compact: true,
                ),
              ),
              gap,
              Expanded(
                child: HfTile(
                  tint: HfTint.sky,
                  icon: Icons.sync_rounded,
                  value: '${host.regulars}',
                  caption: 'regulars',
                  compact: true,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: HfSpacing.sm),
        IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: HfTile(
                  tint: HfTint.butter,
                  icon: Icons.language_rounded,
                  value: langs,
                  compact: true,
                  valueStyle: textTile,
                ),
              ),
              gap,
              Expanded(
                child: HfTile(
                  tint: HfTint.blush,
                  icon: Icons.auto_awesome_rounded,
                  value: _prettyStyle(host.style),
                  compact: true,
                  valueStyle: textTile,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// "+2": the topics that did not fit.
class _MoreChip extends StatelessWidget {
  const _MoreChip({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: HfSpacing.tap),
      child: Center(
        widthFactor: 1,
        child: Container(
          height: 40,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          decoration: BoxDecoration(
            color: dark ? HfColors.darkBar : HfColors.surfaceSoft,
            borderRadius: BorderRadius.circular(HfRadius.control),
          ),
          child: Center(
            widthFactor: 1,
            child: Text(
              '+$count',
              style: HfText.badge.copyWith(
                color: dark ? HfColors.mutedSoft : HfColors.muted,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// What sits in the frosted panel over the photo: name, verified badge, rating, tagline and the voice bar.
class _PanelContent extends ConsumerWidget {
  const _PanelContent({required this.host, required this.from});

  final HostCard host;
  final String from;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final dark = HfBrightness.isDark(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Flexible(
              child: Text(
                host.displayName,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: HfText.of(context, HfText.title),
              ),
            ),
            const SizedBox(width: HfSpacing.xs),
            const HfVerifiedBadge(size: 20),
            Expanded(
              child: Align(
                alignment: Alignment.centerRight,
                child: HostRating(host: host),
              ),
            ),
          ],
        ),
        if (host.tagline != null) ...[
          const SizedBox(height: 3),
          Text(
            host.tagline!,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: HfText.label.copyWith(
              fontWeight: FontWeight.w400,
              color: dark ? HfColors.mutedSoft : HfColors.inkTagline,
            ),
          ),
        ],
        if (host.hasIntro) ...[
          const SizedBox(height: HfSpacing.md),
          _CardVoice(host: host, from: from),
        ],
      ],
    );
  }
}

/// The compact peach voice bar. Plays the host's intro with the app's one speaker; the waveform fills while it plays.
class _CardVoice extends ConsumerStatefulWidget {
  const _CardVoice({required this.host, required this.from});

  final HostCard host;
  final String from;

  @override
  ConsumerState<_CardVoice> createState() => _CardVoiceState();
}

class _CardVoiceState extends ConsumerState<_CardVoice>
    with SingleTickerProviderStateMixin {
  late final AnimationController _progress;

  @override
  void initState() {
    super.initState();
    _progress = AnimationController(
      vsync: this,
      duration: Duration(seconds: widget.host.previewSeconds),
    );
    // A recycled card whose clip is still playing picks the fill up again.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted &&
          ref.read(introPlayerProvider).isPlaying(widget.host.slug)) {
        _start();
      }
    });
  }

  void _start() {
    if (MediaQuery.disableAnimationsOf(context)) return;
    _progress.forward(from: 0);
  }

  @override
  void dispose() {
    _progress.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final host = widget.host;
    final player = ref.watch(introPlayerProvider);
    final playing = player.isPlaying(host.slug);
    ref.listen<bool>(
      introPlayerProvider.select((s) => s.isPlaying(host.slug)),
      (prev, now) {
        if (now) {
          _start();
        } else {
          _progress
            ..stop()
            ..value = 0;
        }
      },
    );
    final url = host.introAudioUrl!;
    final failed = player.failedSlug == host.slug;
    final bigText = MediaQuery.textScalerOf(context).scale(16) > 22;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AnimatedBuilder(
          animation: _progress,
          builder: (context, _) => HfVoiceBar(
            key: ValueKey<String>('intro-${host.slug}'),
            compact: true,
            title: host.voiceTitle,
            durationLabel: _clock(host.previewSeconds),
            // HfVoiceBar's 2 px gaps overflow when a big system font leaves the waveform a few pixels.
            heights: hostWaveHeights(host.slug, count: bigText ? 6 : 20),
            progress: _progress.value,
            playing: playing,
            onTap: () => ref
                .read(introPlayerProvider.notifier)
                .toggle(slug: host.slug, url: url, from: widget.from),
          ),
        ),
        if (failed)
          Padding(
            padding: const EdgeInsets.only(top: HfSpacing.xs),
            child: Text(
              "Can't play",
              style: HfText.badge.copyWith(color: HfColors.accent),
            ),
          ),
      ],
    );
  }
}

/// The price bar: "₹20 /min" and "10 min ≈ ₹200" on the left; Call now (online) or Notify me on the right.
class _PriceBar extends ConsumerStatefulWidget {
  const _PriceBar({
    required this.host,
    required this.lane,
    required this.onOpen,
  });

  final HostCard host;
  final String? lane;
  final VoidCallback onOpen;

  @override
  ConsumerState<_PriceBar> createState() => _PriceBarState();
}

class _PriceBarState extends ConsumerState<_PriceBar> {
  bool _busy = false;
  bool? _subscribedOverride;

  HostCard get _h => widget.host;

  /// The same steps as the profile's Call button: telemetry, sign in, then the call confirm step.
  Future<void> _call() async {
    unawaited(
      Analytics.capture('hf_app_call_tapped', <String, Object>{
        'slug': _h.slug,
        'status': _h.status.name,
      }),
    );
    unawaited(ref.read(introPlayerProvider.notifier).stop());
    if (_h.womenOnly && ref.read(sessionProvider).me?.womenLane != true) {
      // The space explanation is public; registration belongs to its join action.
      unawaited(
        GoRouter.of(context).push<Object?>(
          Routes.lanesOf(
            'women',
            next: Routes.callConfirmOf(_h.slug, lane: 'women'),
          ),
        ),
      );
      return;
    }
    if (!await requireSignIn(
      context,
      ref,
      next: Routes.callConfirmOf(_h.slug, lane: widget.lane),
    )) {
      return;
    }
    if (!mounted) return;
    await ref.read(callConfirmOpenerProvider)(context, _h.slug);
  }

  /// The same steps as the profile's Notify me: sign in, then `POST` / `DELETE /api/hf/hosts/:slug/notify`.
  Future<void> _toggleNotify(bool subscribed) async {
    if (_busy) return;
    final turnOn = !subscribed;
    final next = Uri(
      path: Routes.hostProfileOf(_h.slug),
      queryParameters: <String, String>{
        'action': 'notify',
        'notify': turnOn ? 'on' : 'off',
        if (widget.lane != null) 'lane': widget.lane!,
      },
    ).toString();
    if (!await requireSignIn(context, ref, next: next)) return;
    if (!mounted) return;
    unawaited(HapticFeedback.selectionClick());
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.maybeOf(context);
    final sw = Stopwatch()..start();
    try {
      final now = await setNotifyMe(
        ref.read(apiClientProvider),
        _h.slug,
        on: turnOn,
      );
      if (!mounted) return;
      setState(() {
        _busy = false;
        _subscribedOverride = now;
      });
      messenger?.showSnackBar(
        SnackBar(
          content: Text(
            now ? HostProfileStrings.notifyOn : HostProfileStrings.notifyOff,
          ),
        ),
      );
      unawaited(
        Analytics.capture('hf_app_notify_me', <String, Object>{
          'slug': _h.slug,
          'on': now,
          'outcome': 'ok',
          'ms': sw.elapsedMilliseconds,
        }),
      );
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      messenger?.showSnackBar(SnackBar(content: Text(e.userMessage)));
      unawaited(
        Analytics.capture('hf_app_notify_me', <String, Object>{
          'slug': _h.slug,
          'on': turnOn,
          'outcome': 'error',
          'reason': e.code,
          'status': e.status,
          'ms': sw.elapsedMilliseconds,
        }),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final callsOn = ref
        .watch(flagsProvider)
        .when(
          data: (f) => f.hfCallsEnabled,
          loading: () => true,
          error: (_, __) => true,
        );
    final online = _h.isOnline;
    final bool subscribed = online
        ? false
        : (_subscribedOverride ??
              ref
                  .watch(notifyStatusProvider(_h.slug))
                  .when<bool>(
                    data: (v) => v == true,
                    loading: () => false,
                    error: (_, __) => false,
                  ));

    final String label;
    final IconData icon;
    final Color bg;
    final Color fg;
    final VoidCallback? action;
    String? semantics;
    if (!callsOn) {
      label = HostProfileStrings.callsSoon;
      icon = Icons.call_rounded;
      bg = dark ? HfColors.darkTile : HfColors.handle;
      fg = dark ? HfColors.mutedSoft : HfColors.muted;
      action = null;
    } else if (online) {
      label = 'Call now';
      icon = Icons.call_rounded;
      bg = dark ? HfColors.lavender : HfColors.ink;
      fg = dark ? HfColors.ink : HfColors.white;
      action = _call;
    } else {
      label = subscribed ? 'Notifying' : 'Notify me';
      semantics = subscribed ? HostProfileStrings.notifyStop : null;
      icon = subscribed
          ? Icons.notifications_active_rounded
          : Icons.notifications_none_rounded;
      bg = dark ? HfColors.darkCard : HfColors.white;
      fg = dark ? HfColors.darkText : HfColors.ink;
      action = _busy ? null : () => _toggleNotify(subscribed);
    }

    final muted = dark ? HfColors.mutedSoft : HfColors.muted;
    return Container(
      constraints: const BoxConstraints(minHeight: 60),
      padding: const EdgeInsets.all(5),
      decoration: BoxDecoration(
        color: dark ? HfColors.darkBar : HfColors.surfaceSoft,
        borderRadius: BorderRadius.circular(HfRadius.tile),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: HfSpacing.lg,
                vertical: 2,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _h.priceLabel,
                    style: HfText.of(context, HfText.section),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  Text(
                    _h.plan == 'standard' || _h.priceTiers.isNotEmpty
                        ? 'Lower rates after 30 min'
                        : '10 min ≈ ${formatRupees(_h.pricePerMin * 10)}',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: HfText.label.copyWith(
                      color: muted,
                      fontWeight: FontWeight.w400,
                    ),
                  ),
                ],
              ),
            ),
          ),
          Flexible(
            fit: FlexFit.loose,
            child: Semantics(
              button: true,
              enabled: action != null,
              label: semantics ?? label,
              excludeSemantics: true,
              child: Material(
                color: bg,
                borderRadius: BorderRadius.circular(HfRadius.tileSmall),
                child: InkWell(
                  borderRadius: BorderRadius.circular(HfRadius.tileSmall),
                  onTap: action,
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(minHeight: HfSpacing.tap),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: HfSpacing.xxl,
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(icon, size: 17, color: fg),
                          const SizedBox(width: HfSpacing.sm),
                          Flexible(
                            child: Text(
                              label,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: HfText.buttonSmall.copyWith(color: fg),
                            ),
                          ),
                        ],
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

/// A narrow card for a horizontal strip: picture, name, price, status, intro button.
class HostMiniCard extends ConsumerWidget {
  const HostMiniCard({
    super.key,
    required this.host,
    this.from = 'home',
    this.onTap,
    this.animate = true,
  });

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
            Center(
              child: HostAvatar(
                url: host.avatarUrl,
                size: 96,
                aiLabel: host.isAiAvatar ? kAiPictureLabel : null,
              ),
            ),
            const SizedBox(height: 10),
            Text(
              host.displayName,
              style: HfText.of(context, HfText.subsection),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(height: 2),
            Wrap(
              spacing: 8,
              runSpacing: 2,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Text(
                  host.priceLabel,
                  style: HfText.of(context, HfText.bodyStrong),
                ),
                HostRating(host: host),
              ],
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                FittedBox(
                  fit: BoxFit.scaleDown,
                  child: StatusPill(presence: host.status, animate: animate),
                ),
                if (host.hasIntro) IntroPlayButton(host: host, from: from),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// "★ 4.8", or "New" when nobody has rated this host yet.
class HostRating extends StatelessWidget {
  const HostRating({super.key, required this.host});

  final HostCard host;

  @override
  Widget build(BuildContext context) {
    final r = host.rating;
    if (r == null || host.reviewCount <= 0) {
      return Text(
        'New',
        style: HfText.badge.copyWith(
          color: HfBrightness.isDark(context)
              ? HfColors.lavenderLight
              : HfColors.link,
        ),
      );
    }
    return Semantics(
      label: 'Rated ${r.toStringAsFixed(1)} from ${host.reviewCount} reviews',
      excludeSemantics: true,
      child: Text.rich(
        TextSpan(
          children: [
            const TextSpan(
              text: '★ ',
              style: TextStyle(color: HfColors.star),
            ),
            TextSpan(
              text: r.toStringAsFixed(1),
              style: HfText.of(context, HfText.buttonSmall),
            ),
          ],
        ),
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

  /// Blush for the lane tags; lavender for topics.
  final bool accent;

  @override
  Widget build(BuildContext context) {
    final tint = accent ? HfTint.blush : HfTint.lavender;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: tint.bg(context),
        borderRadius: BorderRadius.circular(HfRadius.pillRadius),
      ),
      child: Text(text, style: HfText.badge.copyWith(color: tint.ink(context))),
    );
  }
}

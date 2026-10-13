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
import '../../../core/theme/hf_explore_style.dart';
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

/// A portrait-led Explore card. Topic labels remain a compatible constructor
/// input; topics are chosen in the discovery filters instead of shown on cards.
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
  final bool animate;

  static const double width = 300;
  static const List<HfTint> _photoTints = <HfTint>[
    HfTint.lavender, HfTint.peach, HfTint.sky, HfTint.butter, HfTint.blush,
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final style = HfExploreStyle.of(context);
    final open = onTap ??
        () => openHostProfile(context, ref, host, from: from, lane: lane);
    final saved = ref.watch(
      favouriteHostsProvider.select((s) => s.contains(host.slug)),
    );
    final tint = _photoTints[
      host.slug.codeUnits.fold<int>(0, (a, b) => a + b) % _photoTints.length
    ];
    return LayoutBuilder(builder: (context, constraints) {
      final photoWidth = (constraints.maxWidth - 16).clamp(1.0, double.infinity).toDouble();
      final largePhotoLabels = MediaQuery.textScalerOf(context).scale(14) > 20;
      final presence = switch (host.status) {
        HostPresence.online => HfPresence.online,
        HostPresence.busy => HfPresence.busy,
        HostPresence.offline => HfPresence.offline,
      };
      final photo = host.avatarUrl == null ? null : resizedImageUrl(
        host.avatarUrl!,
        width: photoWidth * MediaQuery.devicePixelRatioOf(context),
        quality: 70,
      );
      return Container(
        decoration: style.card,
        child: Column(
          mainAxisSize: MainAxisSize.min,
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
                  child: Container(
                    decoration: style.imageFrame,
                    padding: const EdgeInsets.all(2),
                    child: Stack(children: [
                    HfPhotoCard(
                      imageUrl: photo,
                      height: 340,
                      status: largePhotoLabels ? null : presence,
                      aiLabel: !largePhotoLabels && host.isAiAvatar ? kAiPictureLabel : null,
                      saved: saved,
                      tint: tint,
                      animatePill: animate,
                      onSave: () {
                        HapticFeedback.selectionClick();
                        unawaited(ref.read(favouriteHostsProvider.notifier).toggle(host.slug));
                      },
                    ),
                    if (largePhotoLabels)
                      Positioned(
                        left: 12, right: 12, bottom: 12,
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            HfStatusPill(status: presence, animate: animate),
                            if (host.isAiAvatar) ...[
                              const SizedBox(height: 8),
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                                decoration: BoxDecoration(color: const Color(0xF2FFFFFF),
                                  borderRadius: BorderRadius.circular(12)),
                                child: Text(kAiPictureLabel,
                                  style: HfText.label.copyWith(color: HfColors.inkSoft)),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ]),
                  ),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: open,
                    child: Semantics(
                      button: true,
                      child: Row(children: [
                        Expanded(child: Text(
                          host.displayName,
                          style: HfText.title.copyWith(color: style.ink),
                        )),
                        const SizedBox(width: 6),
                        const HfVerifiedBadge(size: 20),
                      ]),
                    ),
                  ),
                  const SizedBox(height: 6),
                  Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      HostRating(host: host),
                      if (host.rating != null && host.reviewCount > 0)
                        Text('(${host.reviewCount} reviews)',
                          style: HfText.label.copyWith(color: style.muted)),
                    ],
                  ),
                  if (host.tagline?.trim().isNotEmpty == true) ...[
                    const SizedBox(height: 8),
                    Text(host.tagline!, style: HfText.body.copyWith(color: style.muted)),
                  ],
                  if (host.hasIntro) ...[
                    const SizedBox(height: 12),
                    _CardVoice(host: host, from: from),
                  ],
                  const SizedBox(height: 14),
                  _stats(context),
                  const SizedBox(height: 14),
                  _PriceBar(host: host, lane: lane, onOpen: open),
                ],
              ),
            ),
          ],
        ),
      );
    });
  }

  Widget _stats(BuildContext context) {
    final style = HfExploreStyle.of(context);
    Widget block(IconData icon, String value, String caption) => Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: style.soft,
        border: Border.all(color: style.line),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 22, color: style.accent),
          const SizedBox(height: 8),
          Text(value, style: HfText.bodyStrong.copyWith(color: style.ink)),
          const SizedBox(height: 3),
          Text(caption, style: HfText.label.copyWith(color: style.muted)),
        ],
      ),
    );
    final people = block(Icons.groups_rounded, '${host.talkedTo}', 'People talked to');
    final languages = block(Icons.language_rounded,
      host.languages.isEmpty ? 'Not listed' : host.languages.join(', '), 'Languages');
    return LayoutBuilder(builder: (context, c) {
      if (c.maxWidth < 250 || MediaQuery.textScalerOf(context).scale(14) > 20) {
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          people, const SizedBox(height: 8), languages,
        ]);
      }
      return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(child: people), const SizedBox(width: 8), Expanded(child: languages),
      ]);
    });
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
    final style = HfExploreStyle.of(context);
    void toggle() => unawaited(ref.read(introPlayerProvider.notifier)
        .toggle(slug: host.slug, url: url, from: widget.from));
    return LayoutBuilder(builder: (context, constraints) => Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (bigText || constraints.maxWidth < 250)
          Semantics(
            button: true,
            label: '${playing ? 'Pause' : 'Play'} ${host.voiceTitle}, ${_clock(host.previewSeconds)}',
            excludeSemantics: true,
            child: Material(
              color: style.soft,
              borderRadius: BorderRadius.circular(18),
              child: InkWell(
                key: ValueKey<String>('intro-${host.slug}'),
                onTap: toggle,
                borderRadius: BorderRadius.circular(18),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Row(children: [
                    Icon(playing ? Icons.pause_rounded : Icons.play_arrow_rounded,
                      size: 32, color: style.accent),
                    const SizedBox(width: 10),
                    Expanded(child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(host.voiceTitle, style: HfText.badge.copyWith(color: style.ink)),
                        Text(_clock(host.previewSeconds), style: HfText.label.copyWith(color: style.muted)),
                      ],
                    )),
                  ]),
                ),
              ),
            ),
          )
        else AnimatedBuilder(
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
    ));
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
    final style = HfExploreStyle.of(context);
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
      bg = style.soft;
      fg = style.muted;
      action = null;
    } else if (online) {
      label = 'Call now';
      icon = Icons.call_rounded;
      bg = HfExploreStyle.call;
      fg = const Color(0xFF231407);
      action = _call;
    } else {
      label = subscribed ? 'Notifying' : 'Notify me';
      semantics = subscribed ? HostProfileStrings.notifyStop : null;
      icon = subscribed
          ? Icons.notifications_active_rounded
          : Icons.notifications_none_rounded;
      bg = style.surface;
      fg = style.ink;
      action = _busy ? null : () => _toggleNotify(subscribed);
    }

    final price = Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(_h.priceLabel, style: HfText.section.copyWith(color: style.ink)),
        const SizedBox(height: 3),
        Text(
          _h.plan == 'standard' || _h.priceTiers.isNotEmpty
              ? 'Lower rates after 30 min'
              : '10 min ≈ ${formatRupees(_h.pricePerMin * 10)}',
          style: HfText.label.copyWith(color: style.muted, fontWeight: FontWeight.w400),
        ),
      ],
    );
    final button = Semantics(
      button: true,
      enabled: action != null,
      label: semantics ?? label,
      excludeSemantics: true,
      child: Material(
        color: bg,
        borderRadius: BorderRadius.circular(16),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: action,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 52),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(icon, size: 22, color: fg),
                  const SizedBox(width: 8),
                  Flexible(child: Text(label, style: HfText.buttonSmall.copyWith(color: fg))),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    return LayoutBuilder(builder: (context, c) {
      final stacked = c.maxWidth < 320 || MediaQuery.textScalerOf(context).scale(14) > 20;
      return Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: style.soft,
          border: Border.all(color: style.line),
          borderRadius: BorderRadius.circular(20),
        ),
        child: stacked
            ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                price, const SizedBox(height: 10), button,
              ])
            : Row(children: [
                Expanded(child: price), const SizedBox(width: 12), Flexible(child: button),
              ]),
      );
    });
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

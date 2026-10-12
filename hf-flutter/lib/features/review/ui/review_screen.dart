import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_error.dart';
import '../../../core/router/routes.dart';
import '../../../core/strings.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../../call/data/call_api.dart';
import '../../call/ui/call_avatar.dart';
import '../data/review_api.dart';

/// `/review/call/:id` (signed in, from the call screen) and `/review/:token` (no sign-in, from a push or a
/// WhatsApp link). Exactly one of [callId] and [token] is set.
///
/// 1 to 5 stars (required), a short text (optional, 500 characters, no phone numbers, emails or links), and a
/// topic from the host's topics (optional). Reviews are checked before they appear and only the first name shows.
class ReviewScreen extends ConsumerStatefulWidget {
  const ReviewScreen({super.key, this.callId, this.token});

  final String? callId;
  final String? token;

  @override
  ConsumerState<ReviewScreen> createState() => _ReviewScreenState();
}

abstract final class ReviewStrings {
  static const String title = 'Rate your call';
  static const String ask = 'How was your call?';
  static const String textLabel = 'Anything you would like to say? (optional)';
  static const String textHint = 'What was it like to talk to them?';
  static const String topicLabel = 'What did you talk about? (optional)';
  static const String checked =
      'Reviews are checked before they appear. Only your first name is shown.';
  static const String noContact =
      'Please do not share phone numbers, emails or links.';
  static const String send = 'Send review';
  static const String thanks = 'Your review was sent';
  static const String thanksBody =
      'Thank you for helping us keep conversations useful and welcoming.';
  static const String alreadyDone = 'Thanks, you already reviewed this call.';
  static const String cannotReview =
      'This call can no longer be reviewed. It may already have a review, or it is too old.';
  static const String linkInvalid = "This review link isn't valid.";
  static const String linkExpired =
      'This review link has expired. Review links work for 7 days after a call.';
  static const String done = 'Done';
  static const List<String> starWords = [
    '',
    'Not good',
    'Could be better',
    'Okay',
    'Good',
    'Really good',
  ];
}

class _ReviewScreenState extends ConsumerState<ReviewScreen> {
  final TextEditingController _text = TextEditingController();
  int _stars = 0;
  String? _topic;
  bool _sending = false;
  bool _sent = false;
  bool _alreadyDone = false;
  bool _expired = false;
  String? _error;

  String get _via => widget.token != null ? 'token' : 'call';
  ReviewKey get _key => (callId: widget.callId, token: widget.token);

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  void _back() {
    final router = GoRouter.of(context);
    if (router.canPop()) {
      router.pop(_sent || _alreadyDone);
    } else {
      router.go(Routes.home);
    }
  }

  Future<void> _submit() async {
    if (_sending) return;
    final problem = ReviewRules.validate(stars: _stars, text: _text.text);
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    setState(() {
      _sending = true;
      _error = null;
    });
    final draft = ReviewDraft(stars: _stars, text: _text.text, topic: _topic);
    final api = ref.read(reviewApiProvider);
    final sw = Stopwatch()..start();
    try {
      final token = widget.token;
      if (token != null) {
        await api.submitToken(token, draft);
      } else {
        await api.submitCall(widget.callId ?? '', draft);
      }
      reportReviewSubmitted(
        stars: _stars,
        via: _via,
        ok: true,
        ms: sw.elapsedMilliseconds,
      );
      if (!mounted) return;
      setState(() {
        _sending = false;
        _sent = true;
      });
    } on ApiError catch (e) {
      reportReviewSubmitted(
        stars: _stars,
        via: _via,
        ok: false,
        reason: e.code,
        httpStatus: e.status,
        ms: sw.elapsedMilliseconds,
      );
      if (!mounted) return;
      setState(() {
        _sending = false;
        if (e.code == 'already_reviewed') {
          _alreadyDone = true;
        } else if (e.code == 'expired' || e.status == 410) {
          _expired = true;
        } else {
          _error = reviewErrorMessage(e);
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _back();
      },
      child: Scaffold(
        appBar: AppBar(
          automaticallyImplyLeading: false,
          leading: IconButton(
            tooltip: 'Back',
            icon: const Icon(Icons.arrow_back_rounded),
            onPressed: _back,
          ),
          title: const Text(ReviewStrings.title),
        ),
        body: SafeArea(child: _body()),
      ),
    );
  }

  Widget _body() {
    final target = ref.watch(reviewTargetProvider(_key));
    return target.when(
      loading: () => const LoadingPanel(skeleton: _ReviewSkeleton()),
      error: (e, _) => _loadError(e),
      data: _loaded,
    );
  }

  Widget _loadError(Object e) {
    if (e is ApiError) {
      if (e.isNotEnabled) return const ComingSoonPanel();
      if (e.status == 404) {
        return EmptyPanel(
          message: widget.token != null
              ? ReviewStrings.linkInvalid
              : 'We could not find this call.',
          icon: Icons.link_off_rounded,
          actionLabel: Strings.goHome,
          onAction: () => GoRouter.of(context).go(Routes.home),
        );
      }
      if (e.status == 410) {
        return EmptyPanel(
          message: ReviewStrings.linkExpired,
          icon: Icons.hourglass_disabled_rounded,
          actionLabel: 'Explore hosts',
          onAction: () => GoRouter.of(context).go(Routes.explore),
        );
      }
    }
    return ErrorPanel(
      error: e,
      onRetry: () => ref.invalidate(reviewTargetProvider(_key)),
    );
  }

  Widget _loaded(ReviewTarget t) {
    final hostVisual = t.hostSlug == null
        ? null
        : ref.watch(callHostVisualProvider(t.hostSlug!));
    final photoUrl = hostVisual != null && hostVisual.hasValue
        ? hostVisual.requireValue.photoUrl
        : null;
    if (_sent) {
      return _Thanks(
        target: t,
        photoUrl: photoUrl,
        onDone: _back,
        onMarketplace: () => GoRouter.of(context).go(Routes.explore),
      );
    }
    if (_alreadyDone || t.alreadyReviewed) {
      return _Thanks(
        target: t,
        photoUrl: photoUrl,
        already: true,
        onDone: _back,
        onMarketplace: () => GoRouter.of(context).go(Routes.explore),
      );
    }
    if (_expired) {
      return const EmptyPanel(
        message: ReviewStrings.linkExpired,
        icon: Icons.hourglass_disabled_rounded,
      );
    }
    if (!t.canReview) {
      return EmptyPanel(
        message: ReviewStrings.cannotReview,
        icon: Icons.rate_review_outlined,
        actionLabel: ReviewStrings.done,
        onAction: _back,
      );
    }
    return _form(t);
  }

  Widget _form(ReviewTarget t) {
    final name = t.hostFirstName;
    final hostVisual = t.hostSlug == null
        ? null
        : ref.watch(callHostVisualProvider(t.hostSlug!));
    final photoUrl = hostVisual != null && hostVisual.hasValue
        ? hostVisual.requireValue.photoUrl
        : null;
    final topics = t.hostSlug == null
        ? const <ReviewTopic>[]
        : (ref.watch(reviewTopicsProvider(t.hostSlug!)).value ??
              const <ReviewTopic>[]);
    final detail = [
      if (t.callDate != null) t.callDate!,
      if (t.durationSeconds != null && t.durationSeconds! > 0)
        reviewDurationLabel(t.durationSeconds!)
      else if (t.minutes > 0)
        '${t.minutes} min',
    ].join(' · ');
    return ListView(
      padding: const EdgeInsets.fromLTRB(
        HfSpacing.pageWide,
        HfSpacing.sm,
        HfSpacing.pageWide,
        HfSpacing.section,
      ),
      children: [
        _ReviewHero(
          name: name,
          photoUrl: photoUrl,
          detail: detail,
        ),
        const SizedBox(height: HfSpacing.xxl),
        Semantics(
          label: 'Star rating',
          child: _StarRow(
            stars: _stars,
            enabled: !_sending,
            onChanged: (n) => setState(() {
              _stars = n;
              _error = null;
            }),
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: HfSpacing.sm),
          child: Center(
            child: Text(
              ReviewStrings.starWords[_stars],
              style: HfText.of(context, HfText.bodyStrong),
            ),
          ),
        ),
        const SizedBox(height: HfSpacing.lg),
        Text(
          ReviewStrings.textLabel,
          style: HfText.of(context, HfText.bodyStrong),
        ),
        const SizedBox(height: HfSpacing.sm),
        TextField(
          controller: _text,
          enabled: !_sending,
          maxLines: 5,
          minLines: 3,
          maxLength: ReviewRules.maxText,
          style: HfText.of(context, HfText.body),
          textCapitalization: TextCapitalization.sentences,
          decoration: InputDecoration(
            hintText: ReviewStrings.textHint,
            border: _fieldBorder(context, 1),
            enabledBorder: _fieldBorder(context, 1),
            focusedBorder: _fieldBorder(context, 2),
            disabledBorder: _fieldBorder(context, 1),
          ),
          buildCounter:
              (
                context, {
                required currentLength,
                required isFocused,
                maxLength,
              }) => Text(
                '$currentLength/$maxLength',
                style: HfText.of(context, HfText.note),
              ),
          onChanged: (_) {
            if (_error != null) setState(() => _error = null);
          },
        ),
        const SizedBox(height: HfSpacing.xs),
        Text(ReviewStrings.noContact, style: HfText.of(context, HfText.note)),
        if (topics.isNotEmpty) ...[
          const SizedBox(height: HfSpacing.xxl),
          Text(
            ReviewStrings.topicLabel,
            style: HfText.of(context, HfText.bodyStrong),
          ),
          const SizedBox(height: HfSpacing.sm),
          Wrap(
            spacing: HfSpacing.sm,
            runSpacing: HfSpacing.xs,
            children: [
              for (final topic in topics)
                if (_topic == topic.slug)
                  HfChip.selected(
                    label: topic.label,
                    tint: HfTint.lavender,
                    onTap: _sending
                        ? null
                        : () => setState(() => _topic = null),
                  )
                else
                  HfChip.outline(
                    label: topic.label,
                    onTap: _sending
                        ? null
                        : () => setState(() => _topic = topic.slug),
                  ),
            ],
          ),
        ],
        const SizedBox(height: HfSpacing.xxl),
        const _CheckedNote(),
        if (_error != null) ...[
          const SizedBox(height: HfSpacing.lg),
          Semantics(
            liveRegion: true,
            child: Text(
              _error!,
              style: HfText.bodyStrong.copyWith(
                color: HfBrightness.isDark(context)
                    ? HfColors.blushLight
                    : HfColors.accent,
              ),
            ),
          ),
        ],
        const SizedBox(height: HfSpacing.section),
        HfButton(
          label: ReviewStrings.send,
          loading: _sending,
          onPressed: _sending ? null : _submit,
        ),
      ],
    );
  }

  OutlineInputBorder _fieldBorder(BuildContext context, double width) {
    final dark = HfBrightness.isDark(context);
    final color = width > 1
        ? (dark ? HfColors.lavenderLight : HfColors.ink)
        : (dark ? HfColors.darkLine : HfColors.line);
    return OutlineInputBorder(
      borderRadius: BorderRadius.circular(HfRadius.input),
      borderSide: BorderSide(color: color, width: width),
    );
  }
}

class _ReviewHero extends StatelessWidget {
  const _ReviewHero({
    required this.name,
    required this.photoUrl,
    required this.detail,
  });

  final String name;
  final String? photoUrl;
  final String detail;

  @override
  Widget build(BuildContext context) {
    final avatar = HfCallAvatar(
      name: name,
      size: 86,
      radius: 43,
      photoUrl: photoUrl,
      borderColor: HfBrightness.isDark(context)
          ? HfColors.darkBg
          : HfColors.white,
      borderWidth: 4,
    );
    final copy = Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'How was your call with $name?',
          style: HfText.of(context, HfText.headline),
        ),
        if (detail.isNotEmpty) ...[
          const SizedBox(height: HfSpacing.xs),
          Text(detail, style: HfText.of(context, HfText.note)),
        ],
      ],
    );
    return HfCard(
      child: LayoutBuilder(
        builder: (context, constraints) {
          final stack = constraints.maxWidth < 280 ||
              MediaQuery.textScalerOf(context).scale(16) > 23;
          if (stack) {
            return Column(
              children: [
                avatar,
                const SizedBox(height: HfSpacing.lg),
                copy,
              ],
            );
          }
          return Row(
            children: [
              avatar,
              const SizedBox(width: HfSpacing.xl),
              Expanded(child: copy),
            ],
          );
        },
      ),
    );
  }
}

/// "Reviews are checked before they appear. Only your first name is shown." in a soft box.
class _CheckedNote extends StatelessWidget {
  const _CheckedNote();

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    return Container(
      padding: const EdgeInsets.all(HfSpacing.xl),
      decoration: BoxDecoration(
        color: dark ? HfColors.darkBar : HfColors.surfaceSoft,
        borderRadius: BorderRadius.circular(HfRadius.tileSmall),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            Icons.verified_user_outlined,
            size: 20,
            color: dark ? HfColors.mutedSoft : HfColors.muted,
          ),
          const SizedBox(width: HfSpacing.lg),
          Expanded(
            child: Text(
              ReviewStrings.checked,
              style: HfText.of(context, HfText.note),
            ),
          ),
        ],
      ),
    );
  }
}

/// Five 48 px stars in the star colour. The tapped star bounces (scale 1 to 1.3 and back); reduced motion
/// skips the bounce.
class _StarRow extends StatefulWidget {
  const _StarRow({
    required this.stars,
    required this.enabled,
    required this.onChanged,
  });

  final int stars;
  final bool enabled;
  final ValueChanged<int> onChanged;

  @override
  State<_StarRow> createState() => _StarRowState();
}

class _StarRowState extends State<_StarRow>
    with SingleTickerProviderStateMixin {
  late final AnimationController _bounce;

  @override
  void initState() {
    super.initState();
    _bounce = AnimationController(vsync: this, duration: HfMotion.base);
  }

  late final Animation<double> _scale = TweenSequence<double>([
    TweenSequenceItem(
      tween: Tween<double>(
        begin: 1,
        end: 1.3,
      ).chain(CurveTween(curve: HfMotion.curve)),
      weight: 45,
    ),
    TweenSequenceItem(
      tween: Tween<double>(
        begin: 1.3,
        end: 1,
      ).chain(CurveTween(curve: Curves.easeInCubic)),
      weight: 55,
    ),
  ]).animate(_bounce);
  int _last = 0;

  @override
  void dispose() {
    _bounce.dispose();
    super.dispose();
  }

  void _tap(int n) {
    if (!widget.enabled) return;
    HapticFeedback.selectionClick();
    widget.onChanged(n);
    if (MediaQuery.disableAnimationsOf(context)) return;
    _last = n;
    _bounce.forward(from: 0);
  }

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    return Row(
      children: [
        for (var n = 1; n <= 5; n++)
          Expanded(
            child: _StarButton(
              value: n,
              selected: n <= widget.stars,
              scale: n == _last
                  ? _scale
                  : const AlwaysStoppedAnimation<double>(1),
              emptyColor: dark ? HfColors.darkSelected : HfColors.handle,
              onTap: widget.enabled ? () => _tap(n) : null,
            ),
          ),
      ],
    );
  }
}

class _StarButton extends StatelessWidget {
  const _StarButton({
    required this.value,
    required this.selected,
    required this.scale,
    required this.emptyColor,
    required this.onTap,
  });

  final int value;
  final bool selected;
  final Animation<double> scale;
  final Color emptyColor;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      label: value == 1 ? '1 star' : '$value stars',
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: SizedBox(
          height: 56,
          child: Center(
            child: ScaleTransition(
              scale: scale,
              child: Icon(
                selected ? Icons.star_rounded : Icons.star_outline_rounded,
                size: 48,
                color: selected ? HfColors.star : emptyColor,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Thanks extends StatelessWidget {
  const _Thanks({
    required this.target,
    required this.photoUrl,
    required this.onDone,
    required this.onMarketplace,
    this.already = false,
  });

  final ReviewTarget target;
  final String? photoUrl;
  final bool already;
  final VoidCallback onDone;
  final VoidCallback onMarketplace;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(HfSpacing.pageWide),
      children: [
        const SizedBox(height: HfSpacing.section),
        Center(
          child: _CheckBurst(
            name: target.hostFirstName,
            photoUrl: photoUrl,
          ),
        ),
        const SizedBox(height: HfSpacing.xxl),
        Semantics(
          liveRegion: true,
          child: Text(
            already ? ReviewStrings.alreadyDone : ReviewStrings.thanks,
            style: HfText.of(context, HfText.headline),
            textAlign: TextAlign.center,
          ),
        ),
        if (!already) ...[
          const SizedBox(height: HfSpacing.sm),
          Text(
            '${ReviewStrings.thanksBody} Your review will show after it is checked.',
            style: HfText.of(context, HfText.note),
            textAlign: TextAlign.center,
          ),
        ],
        const SizedBox(height: HfSpacing.section),
        const _CheckedNote(),
        const SizedBox(height: HfSpacing.xxl),
        HfButton(label: 'Back to marketplace', onPressed: onMarketplace),
        const SizedBox(height: HfSpacing.sm),
        HfButton(
          label: ReviewStrings.done,
          kind: HfButtonKind.secondary,
          onPressed: onDone,
        ),
      ],
    );
  }
}

/// A lavender disc that pops in with a check mark. Reduced motion shows it at full size at once.
class _CheckBurst extends StatefulWidget {
  const _CheckBurst({required this.name, this.photoUrl});

  final String name;
  final String? photoUrl;

  @override
  State<_CheckBurst> createState() => _CheckBurstState();
}

class _CheckBurstState extends State<_CheckBurst>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: HfMotion.slow);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      _c.value = 1;
    } else if (!_c.isAnimating && _c.value == 0) {
      _c.forward();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    return ExcludeSemantics(
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          final t = Curves.easeOutBack.transform(_c.value);
          return Transform.scale(
            scale: 0.4 + 0.6 * t,
            child: Container(
              width: 166,
              height: 166,
              decoration: BoxDecoration(
                color: dark ? HfColors.darkTile : HfColors.lavender,
                shape: BoxShape.circle,
              ),
              child: Stack(
                alignment: Alignment.center,
                children: [
                  HfCallAvatar(
                    name: widget.name,
                    photoUrl: widget.photoUrl,
                    size: 104,
                    radius: 52,
                    borderColor: dark ? HfColors.darkBg : HfColors.white,
                    borderWidth: 4,
                  ),
                  Positioned(
                    right: 18,
                    bottom: 22,
                    child: Opacity(
                      opacity: _c.value.clamp(0.0, 1.0),
                      child: Container(
                        width: 46,
                        height: 46,
                        decoration: BoxDecoration(
                          color: dark ? HfColors.lavenderLight : HfColors.ink,
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: dark ? HfColors.darkBg : HfColors.white,
                            width: 3,
                          ),
                        ),
                        child: Icon(
                          Icons.check_rounded,
                          size: 27,
                          color: dark ? HfColors.ink : HfColors.white,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

/// Placeholder with the shape of the form: headline, five stars, the note box.
class _ReviewSkeleton extends StatelessWidget {
  const _ReviewSkeleton();

  @override
  Widget build(BuildContext context) {
    return const Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        HfSkeleton.box(height: 32, radius: 12),
        SizedBox(height: HfSpacing.section),
        HfSkeleton.box(height: 56, radius: 16),
        SizedBox(height: HfSpacing.section),
        HfSkeleton.box(height: 120, radius: HfRadius.input),
      ],
    );
  }
}

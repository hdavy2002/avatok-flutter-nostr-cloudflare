import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_error.dart';
import '../../../core/router/routes.dart';
import '../../../core/strings.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
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
  static const String checked = 'Reviews are checked before they appear. Only your first name is shown.';
  static const String noContact = 'Please do not share phone numbers, emails or links.';
  static const String send = 'Send review';
  static const String thanks = 'Thank you!';
  static const String thanksBody = 'Your review will show once our team has checked it.';
  static const String alreadyDone = 'Thanks, you already reviewed this call.';
  static const String cannotReview = 'This call can no longer be reviewed. It may already have a review, or it is too old.';
  static const String linkInvalid = "This review link isn't valid.";
  static const String linkExpired = 'This review link has expired. Review links work for 7 days after a call.';
  static const String done = 'Done';
  static const List<String> starWords = ['', 'Not good', 'Could be better', 'Okay', 'Good', 'Really good'];

  static String seeProfile(String name) => "See $name's page";
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
      reportReviewSubmitted(stars: _stars, via: _via, ok: true, ms: sw.elapsedMilliseconds);
      if (!mounted) return;
      setState(() {
        _sending = false;
        _sent = true;
      });
    } on ApiError catch (e) {
      reportReviewSubmitted(
          stars: _stars, via: _via, ok: false, reason: e.code, httpStatus: e.status, ms: sw.elapsedMilliseconds);
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
      loading: () => const LoadingPanel(),
      error: (e, _) => _loadError(e),
      data: _loaded,
    );
  }

  Widget _loadError(Object e) {
    if (e is ApiError) {
      if (e.isNotEnabled) return const ComingSoonPanel();
      if (e.status == 404) {
        return EmptyPanel(
          message: widget.token != null ? ReviewStrings.linkInvalid : 'We could not find this call.',
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
    return ErrorPanel(error: e, onRetry: () => ref.invalidate(reviewTargetProvider(_key)));
  }

  Widget _loaded(ReviewTarget t) {
    if (_sent) return _Thanks(target: t, onDone: _back, onProfile: _openProfile(t));
    if (_alreadyDone || t.alreadyReviewed) {
      return _Thanks(target: t, already: true, onDone: _back, onProfile: _openProfile(t));
    }
    if (_expired) {
      return const EmptyPanel(message: ReviewStrings.linkExpired, icon: Icons.hourglass_disabled_rounded);
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

  VoidCallback? _openProfile(ReviewTarget t) {
    final slug = t.hostSlug;
    if (slug == null) return null;
    return () => GoRouter.of(context).go(Routes.hostProfileOf(slug));
  }

  Widget _form(ReviewTarget t) {
    final name = t.hostFirstName;
    final topics = t.hostSlug == null
        ? const <ReviewTopic>[]
        : (ref.watch(reviewTopicsProvider(t.hostSlug!)).value ?? const <ReviewTopic>[]);
    final detail = [
      if (t.callDate != null) t.callDate!,
      if (t.minutes > 0) '${t.minutes} min',
    ].join(' · ');
    return ListView(
      padding: const EdgeInsets.all(HfSpacing.page),
      children: [
        Text('How was your call with $name?', style: HfText.headline),
        if (detail.isNotEmpty) ...[
          const SizedBox(height: 4),
          Text(detail, style: HfText.note),
        ],
        const SizedBox(height: 20),
        Semantics(
          label: 'Star rating',
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              for (var n = 1; n <= 5; n++)
                _StarButton(
                  value: n,
                  selected: n <= _stars,
                  onTap: _sending ? null : () => setState(() {
                        _stars = n;
                        _error = null;
                      }),
                ),
            ],
          ),
        ),
        SizedBox(
          height: 28,
          child: Center(
            child: Text(ReviewStrings.starWords[_stars], style: HfText.bodyStrong),
          ),
        ),
        const SizedBox(height: 12),
        const Text(ReviewStrings.textLabel, style: HfText.bodyStrong),
        const SizedBox(height: 8),
        TextField(
          controller: _text,
          enabled: !_sending,
          maxLines: 5,
          minLines: 3,
          maxLength: ReviewRules.maxText,
          style: HfText.bodyText,
          textCapitalization: TextCapitalization.sentences,
          decoration: const InputDecoration(hintText: ReviewStrings.textHint),
          buildCounter: (context, {required currentLength, required isFocused, maxLength}) =>
              Text('$currentLength/$maxLength', style: HfText.note),
          onChanged: (_) {
            if (_error != null) setState(() => _error = null);
          },
        ),
        const SizedBox(height: 4),
        const Text(ReviewStrings.noContact, style: HfText.note),
        if (topics.isNotEmpty) ...[
          const SizedBox(height: 16),
          const Text(ReviewStrings.topicLabel, style: HfText.bodyStrong),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 4,
            children: [
              for (final topic in topics)
                HfChip(
                  label: topic.label,
                  selected: _topic == topic.slug,
                  onTap: _sending ? null : () => setState(() => _topic = _topic == topic.slug ? null : topic.slug),
                ),
            ],
          ),
        ],
        const SizedBox(height: 16),
        const Text(ReviewStrings.checked, style: HfText.note),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Semantics(
            liveRegion: true,
            child: Text(_error!, style: HfText.bodyStrong.copyWith(color: HfColors.accent)),
          ),
        ],
        const SizedBox(height: 20),
        HfButton(label: ReviewStrings.send, loading: _sending, onPressed: _submit),
      ],
    );
  }
}

class _StarButton extends StatelessWidget {
  const _StarButton({required this.value, required this.selected, required this.onTap});

  final int value;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      label: value == 1 ? '1 star' : '$value stars',
      excludeSemantics: true,
      child: InkResponse(
        onTap: onTap,
        radius: 28,
        child: SizedBox(
          width: 56,
          height: HfSpacing.tap + 8,
          child: Icon(
            selected ? Icons.star_rounded : Icons.star_outline_rounded,
            size: 44,
            color: selected ? HfColors.rose : HfColors.line,
          ),
        ),
      ),
    );
  }
}

class _Thanks extends StatelessWidget {
  const _Thanks({required this.target, required this.onDone, required this.onProfile, this.already = false});

  final ReviewTarget target;
  final bool already;
  final VoidCallback onDone;
  final VoidCallback? onProfile;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(HfSpacing.page),
      children: [
        const SizedBox(height: 24),
        const Icon(Icons.favorite_rounded, size: 64, color: HfColors.rose),
        const SizedBox(height: 16),
        Semantics(
          liveRegion: true,
          child: Text(
            already ? ReviewStrings.alreadyDone : ReviewStrings.thanks,
            style: HfText.headline,
            textAlign: TextAlign.center,
          ),
        ),
        if (!already) ...[
          const SizedBox(height: 8),
          const Text(
            '${ReviewStrings.thanksBody} Only your first name is shown.',
            style: HfText.bodyText,
            textAlign: TextAlign.center,
          ),
        ],
        const SizedBox(height: 24),
        if (onProfile != null) ...[
          HfButton(label: ReviewStrings.seeProfile(target.hostFirstName), onPressed: onProfile),
          const SizedBox(height: 8),
          HfButton(label: ReviewStrings.done, kind: HfButtonKind.secondary, onPressed: onDone),
        ] else
          HfButton(label: ReviewStrings.done, onPressed: onDone),
      ],
    );
  }
}

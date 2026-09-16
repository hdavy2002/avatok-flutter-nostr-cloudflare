import '../../../../core/cached_image.dart';

import '../../../../core/localization/ui_text.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import '../../../../core/ui/avatok_dark.dart';
import 'shared_widgets.dart';
import '../../../../core/ui/zine_widgets.dart';

class ListingReadinessCheck {
  final String label;
  final bool ok;
  final bool blocking;
  final String? detail;
  const ListingReadinessCheck(
      {required this.label,
      required this.ok,
      this.blocking = true,
      this.detail});
}

class ListingStep8Preview extends StatelessWidget {
  final dynamic draft;
  final List<ListingReadinessCheck> checks;
  final dynamic review;
  final bool reviewing;
  final bool submitting;
  final bool repeating;
  final bool copyReviewing;
  final String? error;
  final VoidCallback? onRunReview;
  final VoidCallback? onRunCopyReview;
  final VoidCallback? onSubmit;
  final ValueChanged<int>? onRepeat;
  final DraftPatch? onPatch;
  final Future<void> Function(String field, String suggestion)? onApplyCopy;
  const ListingStep8Preview(
      {super.key,
      required this.draft,
      this.checks = const [],
      this.review,
      this.reviewing = false,
      this.submitting = false,
      this.repeating = false,
      this.copyReviewing = false,
      this.error,
      this.onRunReview,
      this.onRunCopyReview,
      this.onSubmit,
      this.onRepeat,
      this.onPatch,
      this.onApplyCopy});
  @override
  Widget build(BuildContext context) { UiLocaleScope.watch(context); return
      LayoutBuilder(builder: (context, constraints) {
        final wide = constraints.maxWidth > 680;
        final body =
            Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (error != null) statusMessage(error!, error: true),
          if (error != null) const SizedBox(height: 12),
          _statusCard(context),
          const SizedBox(height: 16),
          ListingCard(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                Row(children: [
                  Expanded(
                      child: UiText(UiMessage.m_publishing_checklist_d54f765e7a,
                          style: Theme.of(context).textTheme.titleMedium)),
                  IconButton(
                      onPressed: reviewing ? null : onRunReview,
                      icon: reviewing
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2))
                          : Icon(PhosphorIcons.arrowClockwise(PhosphorIconsStyle.regular)))
                ]),
                const SizedBox(height: 8),
                ...checks.map((check) => ListTile(
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                    leading: Icon(
                        check.ok ? PhosphorIcons.checkCircle(PhosphorIconsStyle.fill) : PhosphorIcons.warningCircle(PhosphorIconsStyle.regular),
                        color: check.ok
                            ? AD.online
                            : (check.blocking ? AD.danger : AD.primaryBadge)),
                    title: Text(check.label),
                    subtitle:
                        check.detail == null ? null : Text(check.detail!))),
              ])),
          const SizedBox(height: 16),
          _copyReview(context),
          const SizedBox(height: 16),
          _actions(context),
        ]);
        return Center(
            child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 960),
                child: wide
                    ? Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                            Expanded(child: body),
                            const SizedBox(width: 24),
                            SizedBox(width: 300, child: _poster(context))
                          ])
                    : body));
      }); }

  Widget _statusCard(BuildContext context) {
    final status = textValue(draftValue(draft, 'status', 'draft'));
    final message = status == 'pending_review'
        ? 'This listing is with the team for review.'
        : status == 'approved'
            ? 'Approved — it will go live shortly.'
            : status == 'rejected'
                ? 'Changes requested. Update the earlier steps and send it again.'
                : 'Ready to send for human review?';
    return statusMessage(message, error: status == 'rejected');
  }

  Widget _copyReview(BuildContext context) {
    final result = review is Map ? review as Map : null;
    return ListingCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Expanded(
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          UiText(UiMessage.m_review_my_details_using_ai_7be9771bc8,
              style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          const UiText(UiMessage.m_suggestions_only_you_choose_what_f2d9855583)
        ])),
        ZineButton(
            label: copyReviewing ? uiCopy(UiMessage.m_checking_ec963ffc91) : uiCopy(UiMessage.m_review_copy_d99a25ae6d),
            onPressed: copyReviewing ? null : onRunCopyReview,
            loading: copyReviewing,
            variant: ZineButtonVariant.blue)
      ]),
      if (result != null) ...[
        const Divider(height: 24),
        Text(
            textValue(result['source']) == 'ai'
                ? uiCopy(UiMessage.m_reviewed_by_ava_f15132e0ca)
                : uiCopy(UiMessage.m_length_check_only_ava_was_b0cd2a25d2),
            style: Theme.of(context).textTheme.labelSmall),
        for (final field in ['title', 'blurb', 'description'])
          _reviewField(field, result[field]),
      ],
    ]));
  }

  Widget _reviewField(String name, dynamic value) {
    final f = draftMap(value);
    final suggestion = textValue(f['suggested']);
    final original = textValue(f['original']);
    return Padding(
        padding: const EdgeInsets.only(top: 12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(name, style: const TextStyle(fontWeight: FontWeight.bold)),
          if (f['note'] != null) Text(textValue(f['note'])),
          if (suggestion.isEmpty || suggestion == original)
            const UiText(UiMessage.m_nothing_to_change_this_already_b7a1d6430f)
          else ...[
            Text(suggestion),
            Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                    onPressed: onApplyCopy == null
                        ? null
                        : () => onApplyCopy!(name, suggestion),
                    child: const UiText(UiMessage.m_use_this_b291996520)))
          ]
        ]));
  }

  Widget _actions(BuildContext context) {
    final status = textValue(draftValue(draft, 'status', 'draft'));
    final live = status == 'published' || status == 'approved';
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (status == 'draft' || status == 'rejected')
        fullWidthButton(
            label: status == 'rejected' ? uiCopy(UiMessage.m_submit_changes_for_review_c1395d7425) : uiCopy(UiMessage.m_submit_for_human_review_cd84eda463),
            loading: submitting,
            onPressed: submitting ? null : onSubmit),
      if (status == 'draft' || status == 'rejected')
        const Padding(
            padding: EdgeInsets.only(top: 8),
            child: UiText(UiMessage.m_usually_checked_within_an_hour_eaf9a78494)),
      if (live) ...[
        const SizedBox(height: 12),
        UiText(UiMessage.m_runs_every_week_d5d26bcc36,
            style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        Wrap(spacing: 8, children: [
          for (final weeks in [1, 2, 4, 8, 12])
            OutlinedButton(
                onPressed: repeating || onRepeat == null
                    ? null
                    : () => onRepeat!(weeks),
                child: UiText(UiMessage.m_weeks_week_value2_fa521b3a20, params: {'weeks': (weeks).toString(), 'value2': (weeks == 1 ? '' : 's').toString()}))
        ]),
      ],
    ]);
  }

  Widget _poster(BuildContext context) {
    final poster = draftMap(draftValue(draft, 'poster'));
    final url = textValue((poster['variants'] is Map
            ? draftMap(poster['variants']['portrait'])['url']
            : null) ??
        poster['url']);
    final title = textValue(
        poster['copy'] is Map ? draftMap(poster['copy'])['title'] : null);
    return Column(children: [
      UiText(UiMessage.m_your_poster_ab33d2a64b, style: Theme.of(context).textTheme.labelSmall),
      const SizedBox(height: 8),
      AspectRatio(
          aspectRatio: 2 / 3,
          child: ClipRRect(
              borderRadius: BorderRadius.circular(AD.rHero),
              child: url.isNotEmpty
                  ? CachedThumb(url: url, px: 768,
                  
                      fit: BoxFit.cover,
                      fallback:
                          _posterPlaceholder(uiCopy(UiMessage.m_poster_unavailable_ba18edaa2b)))
                  : _posterPlaceholder(
                      textValue(poster['status']) == 'generating'
                          ? uiCopy(UiMessage.m_painting_your_poster_0e16f51ab5)
                          : uiCopy(UiMessage.m_your_poster_is_painted_after_890f67b9f1)))),
      if (title.isNotEmpty)
        Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(title,
                style: const TextStyle(fontWeight: FontWeight.bold)))
    ]);
  }

  Widget _posterPlaceholder(String message) => Container(
      color: AD.inputField,
      alignment: Alignment.center,
      padding: const EdgeInsets.all(20),
      child: Text(message, textAlign: TextAlign.center));
}

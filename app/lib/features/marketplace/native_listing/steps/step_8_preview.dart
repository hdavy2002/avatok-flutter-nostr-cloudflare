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
  Widget build(BuildContext context) =>
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
                      child: Text('Publishing checklist',
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
      });

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
          Text('Review my details using AI',
              style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          const Text('Suggestions only — you choose what to apply.')
        ])),
        ZineButton(
            label: copyReviewing ? 'Checking…' : 'Review copy',
            onPressed: copyReviewing ? null : onRunCopyReview,
            loading: copyReviewing,
            variant: ZineButtonVariant.blue)
      ]),
      if (result != null) ...[
        const Divider(height: 24),
        Text(
            textValue(result['source']) == 'ai'
                ? 'Reviewed by Ava'
                : 'Length check only — Ava was unavailable',
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
            const Text('Nothing to change — this already fits.')
          else ...[
            Text(suggestion),
            Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                    onPressed: onApplyCopy == null
                        ? null
                        : () => onApplyCopy!(name, suggestion),
                    child: const Text('Use this')))
          ]
        ]));
  }

  Widget _actions(BuildContext context) {
    final status = textValue(draftValue(draft, 'status', 'draft'));
    final live = status == 'published' || status == 'approved';
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (status == 'draft' || status == 'rejected')
        fullWidthButton(
            label: 'Submit for human review',
            loading: submitting,
            onPressed: submitting ? null : onSubmit),
      if (status == 'draft' || status == 'rejected')
        const Padding(
            padding: EdgeInsets.only(top: 8),
            child: Text('Takes 24–48 hours. We’ll email you once it passes.')),
      if (live) ...[
        const SizedBox(height: 12),
        Text('Runs every week?',
            style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        Wrap(spacing: 8, children: [
          for (final weeks in [1, 2, 4, 8, 12])
            OutlinedButton(
                onPressed: repeating || onRepeat == null
                    ? null
                    : () => onRepeat!(weeks),
                child: Text('$weeks week${weeks == 1 ? '' : 's'}'))
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
      Text('Your poster', style: Theme.of(context).textTheme.labelSmall),
      const SizedBox(height: 8),
      AspectRatio(
          aspectRatio: 2 / 3,
          child: ClipRRect(
              borderRadius: BorderRadius.circular(AD.rHero),
              child: url.isNotEmpty
                  ? Image.network(url,
                      fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) =>
                          _posterPlaceholder('Poster unavailable'))
                  : _posterPlaceholder(
                      textValue(poster['status']) == 'generating'
                          ? 'Painting your poster…'
                          : 'Your poster is painted after you submit.'))),
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

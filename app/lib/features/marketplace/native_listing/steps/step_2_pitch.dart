import 'package:flutter/material.dart';

import '../../../../core/ui/avatok_dark.dart';
import 'step_widgets.dart';

class Step2Pitch extends StatelessWidget {
  const Step2Pitch({
    super.key,
    required this.draft,
    required this.patch,
    required this.categories,
    this.conferenceEnabled = false,
    this.error = _noError,
  });

  final dynamic draft;
  final NativeListingPatch patch;
  final List<NativeListingCategory> categories;
  final bool conferenceEnabled;
  final NativeListingError error;

  static String? _noError(String field) => null;
  static const _groups = <String, String>{
    'india_goes_live': 'India goes live',
    'find_your_people': 'Find your people',
    'book_their_time': 'Book their time',
  };

  List<NativeListingCategory> _categoriesFor(String group) {
    final filtered = categories.where((c) => c.groupId == group &&
        (conferenceEnabled || c.id != 'adda_rooms')).toList();
    return filtered;
  }

  @override
  Widget build(BuildContext context) {
    final kind = '${listingDraftValue(draft, 'kind', 'kind', 'live_event')}';
    final groups = kind == 'live_event'
        ? const ['india_goes_live']
        : const ['find_your_people', 'book_their_time'];
    final selected = '${listingDraftValue(draft, 'category', 'category', '')}';
    return NativeStepLayout(children: [
      _textField('Title', '${listingDraftValue(draft, 'title', 'title', '')}', (v) => patch({'title': v}),
          maxLength: 80, error: error('title')),
      _textField('Short blurb', '${listingDraftValue(draft, 'blurb', 'blurb', '')}', (v) => patch({'blurb': v}),
          maxLength: 180, error: error('blurb')),
      _textField('Description', '${listingDraftValue(draft, 'description', 'description', '')}', (v) => patch({'description': v}),
          maxLines: 6, maxLength: 4000, error: error('description')),
      Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const NativeStepLabel('Category'),
        const SizedBox(height: 12),
        for (final group in groups) ...[
          Text(_groups[group]!, style: ADText.threadName(c: AD.textPrimary)),
          const SizedBox(height: 8),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final category in _categoriesFor(group))
              AdChip(
                label: '${category.emoji ?? ''}${category.emoji == null ? '' : ' '}${category.label}',
                active: selected == category.id,
                onTap: () => patch({'category': category.id}),
              ),
          ]),
          const SizedBox(height: 16),
        ],
        NativeErrorText(message: error('category')),
      ]),
    ]);
  }

  Widget _textField(String label, String value, ValueChanged<String> onChanged,
      {int? maxLines, int? maxLength, String? error}) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      AdField(
        label: label,
        maxLines: maxLines ?? 1,
        maxLength: maxLength,
        onChanged: onChanged,
      ),
      NativeErrorText(message: error),
    ]);
  }
}

import 'package:flutter/material.dart';

import '../../../../core/ui/avatok_dark.dart';
import 'step_widgets.dart';

class Step1Type extends StatelessWidget {
  const Step1Type({
    super.key,
    required this.draft,
    required this.patch,
    required this.freeEntryLocked,
    this.error = _noError,
  });

  final dynamic draft;
  final NativeListingPatch patch;
  final bool freeEntryLocked;
  final NativeListingError error;

  static String? _noError(String field) => null;

  @override
  Widget build(BuildContext context) {
    final kind = '${listingDraftValue(draft, 'kind', 'kind', 'live_event')}';
    final schedule = '${listingDraftValue(draft, 'scheduleMode', 'schedule_mode', 'fixed_date')}';
    final showFree = !freeEntryLocked || listingDraftValue(draft, 'freeEntry', 'free_entry', false) == true;
    final kinds = [
      ('live_event', 'Live event', 'Broadcast to ticket holders', '◐', false),
      ('consult', '1:1 consult', 'Private video session', '◑', false),
      ('ai_agent', 'AI agent', 'Coming soon', '✦', true),
    ];
    final schedules = kind == 'live_event'
        ? [('fixed_date', 'One fixed date', 'A single date and time')]
        : [
            ('fixed_date', 'One fixed date', 'A single date and time'),
            ('recurring', 'Recurring', 'Same day(s) and time every week'),
            ('on_request', 'On request', 'People request a time, you confirm'),
            ('always_on', 'Always on', 'No fixed schedule — join any time'),
          ];

    return NativeStepLayout(children: [
      Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const NativeStepLabel('Type'),
        const SizedBox(height: 8),
        LayoutBuilder(builder: (context, constraints) {
          final columns = constraints.maxWidth >= 560 ? 3 : 1;
          return GridView.count(
            crossAxisCount: columns,
            crossAxisSpacing: 10,
            mainAxisSpacing: 10,
            childAspectRatio: columns == 1 ? 4.3 : 1.05,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            children: [for (final item in kinds)
              InkWell(
                onTap: item.$5 ? null : () => patch({'kind': item.$1}),
                borderRadius: BorderRadius.circular(AD.rListCard),
                child: Opacity(
                  opacity: item.$5 ? .42 : 1,
                  child: NativeStepCard(
                    selected: kind == item.$1,
                    child: Row(children: [
                      Text(item.$4, style: const TextStyle(fontSize: 22)),
                      const SizedBox(width: 12),
                      Expanded(child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Text(item.$2, style: ADText.threadName(c: AD.textPrimary)),
                          Text(item.$3, style: ADText.preview(c: AD.textSecondary)),
                        ],
                      )),
                      if (kind == item.$1) const Icon(Icons.check, color: AD.primaryBadge),
                    ]),
                  ),
                ),
              ),],
          );
        }),
      ]),
      if (showFree)
        NativeStepCard(
          child: SwitchListTile.adaptive(
            contentPadding: EdgeInsets.zero,
            value: listingDraftValue(draft, 'freeEntry', 'free_entry', false) == true,
            onChanged: freeEntryLocked ? (value) {
              if (!value) patch({'free_entry': false});
            } : (value) => patch({'free_entry': value}),
            title: Text('This is a free show', style: ADText.preview(c: AD.textPrimary)),
            subtitle: freeEntryLocked
                ? Text('Turn this off to continue as a paid listing.', style: ADText.preview(c: AD.textSecondary))
                : null,
          ),
        ),
      Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const NativeStepLabel('Schedule'),
        const SizedBox(height: 8),
        for (final item in schedules) ...[
          InkWell(
            onTap: () => patch({'schedule_mode': item.$1}),
            borderRadius: BorderRadius.circular(AD.rListCard),
            child: NativeStepCard(
              selected: schedule == item.$1,
              child: Row(children: [
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(item.$2, style: ADText.threadName(c: AD.textPrimary)),
                  Text(item.$3, style: ADText.preview(c: AD.textSecondary)),
                ])),
                if (schedule == item.$1) const Icon(Icons.check, color: AD.primaryBadge),
              ]),
            ),
          ),
          const SizedBox(height: 8),
        ],
        NativeErrorText(message: error('schedule_mode')),
      ]),
    ]);
  }
}

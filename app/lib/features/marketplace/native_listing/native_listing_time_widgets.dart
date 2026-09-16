import '../../../core/localization/known_ui_copy.dart';

import '../../../core/localization/ui_text.dart';
// [CAL-TIME-1 2026-09-15] The widget layer of the native wizard's Time step.
//
// Every control here is deliberately dumb and self-contained: the wizard owns
// the state (mode, weekly windows, the wall-clock start) and these widgets only
// render it and report edits. Design tokens only — AD / Msg / Zine / Phosphor,
// like the rest of the wizard.
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../calendar/calendar_data.dart';
import 'native_listing_conflict_state.dart';
import 'native_listing_gcal_readiness.dart';
import 'native_listing_time_model.dart';

/// One availability choice, with the sentences the creator needs to understand
/// when time is and is not reserved.
class NativeListingAvailabilityModeOption {
  const NativeListingAvailabilityModeOption({
    required this.mode,
    required this.title,
    required this.help,
    required this.reserved,
  });

  final AvailabilityMode mode;
  final String title;
  final String help;
  final String reserved;
}

/// [CAL-TIME-1] Wording mirrors the web wizard's three choices (steps.tsx
/// `availabilityModes`) and adds the paragraph the audit asked for: what each
/// choice means and when a time is actually reserved.
const List<NativeListingAvailabilityModeOption> kNativeListingAvailabilityModeOptions =
    <NativeListingAvailabilityModeOption>[
  NativeListingAvailabilityModeOption(
    mode: AvailabilityMode.shared,
    title: 'Use my usual hours',
    help: 'Customers book any open slot inside the working hours in your AvaCalendar.',
    reserved: 'Nothing is reserved when you publish — customers pick a slot from your usual hours.',
  ),
  NativeListingAvailabilityModeOption(
    mode: AvailabilityMode.custom,
    title: 'Choose different hours',
    help: 'Narrow this listing to its own weekly windows, inside your usual working hours.',
    reserved: 'Nothing is reserved when you publish — customers pick a slot inside these windows.',
  ),
  NativeListingAvailabilityModeOption(
    mode: AvailabilityMode.exclusive,
    title: 'Reserve specific dates',
    help: 'Keep the exact date and time you pick below for this listing only.',
    reserved: 'Reserved when you submit the listing — publishing writes the hold, drafts do not.',
  ),
];

/// The shared / custom / exclusive picker.
class NativeListingAvailabilityModeField extends StatelessWidget {
  const NativeListingAvailabilityModeField({
    super.key,
    required this.value,
    required this.onChanged,
    this.enabled = true,
  });

  final AvailabilityMode value;
  final ValueChanged<AvailabilityMode> onChanged;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    final selected = kNativeListingAvailabilityModeOptions.firstWhere(
      (option) => option.mode == value,
      orElse: () => kNativeListingAvailabilityModeOptions.first,
    );
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      UiText(UiMessage.m_where_can_customers_book_63ee7befeb, style: ADText.rowName()),
      const SizedBox(height: Msg.s1),
      for (final option in kNativeListingAvailabilityModeOptions) ...[
        Padding(
          padding: const EdgeInsets.only(top: Msg.s2),
          child: ZineCard(
            padding: const EdgeInsets.all(Msg.s3),
            color: option.mode == value ? AD.cardHover : AD.card,
            onTap: enabled ? () => onChanged(option.mode) : null,
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(authoredUiCopy(option.title), style: ADText.rowName()),
                  const SizedBox(height: 2),
                  Text(authoredUiCopy(option.help), style: ADText.preview(c: AD.textSecondary)),
                ]),
              ),
              if (option.mode == value)
                PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), size: 18, color: AD.online),
            ]),
          ),
        ),
      ],
      const SizedBox(height: Msg.s2),
      AdCard(
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          PhosphorIcon(PhosphorIcons.info(PhosphorIconsStyle.regular), size: 16, color: AD.textSecondary),
          const SizedBox(width: Msg.s2),
          Expanded(child: Text(authoredUiCopy(selected.reserved), style: ADText.preview(c: AD.textSecondary))),
        ]),
      ),
    ]);
  }
}

/// The weekly-windows editor used by the custom mode.
class NativeListingWeeklyHoursField extends StatelessWidget {
  const NativeListingWeeklyHoursField({
    super.key,
    required this.rules,
    required this.timezone,
    required this.onChanged,
    this.enabled = true,
  });

  final List<AvailabilityRule> rules;
  final String timezone;
  final ValueChanged<List<AvailabilityRule>> onChanged;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      UiText(UiMessage.m_weekly_windows_d2b877320f, style: ADText.rowName()),
      const SizedBox(height: 2),
      UiText(UiMessage.m_times_use_timezone_each_window_c6870c3269, params: {'timezone': (timezone).toString()},
          style: ADText.preview(c: AD.textSecondary)),
      const SizedBox(height: Msg.s2),
      for (var index = 0; index < rules.length; index++) _ruleRow(context, index),
      TextButton.icon(
        onPressed: enabled
            ? () => onChanged([...rules, const AvailabilityRule(weekday: 1, startMin: 540, endMin: 1020)])
            : null,
        icon: PhosphorIcon(PhosphorIcons.plus(PhosphorIconsStyle.bold), size: 16),
        label: const UiText(UiMessage.m_add_weekly_window_d44669bfe0),
      ),
    ]);
  }

  Widget _ruleRow(BuildContext context, int index) {
    final rule = rules[index];
    return Padding(
      padding: const EdgeInsets.only(bottom: Msg.s2),
      child: LayoutBuilder(builder: (context, constraints) {
        final day = _dayField(rule, index);
        final start = _timeField(context, 'Starts', rule.startMin, (minutes) => _patch(index, rule.copyWith(startMin: minutes)));
        final end = _timeField(context, 'Ends', rule.endMin, (minutes) => _patch(index, rule.copyWith(endMin: minutes)));
        final remove = IconButton(
          onPressed: enabled ? () => onChanged([...rules]..removeAt(index)) : null,
          icon: PhosphorIcon(PhosphorIcons.trash(PhosphorIconsStyle.regular), size: 18, color: AD.danger),
        );
        if (constraints.maxWidth < 460) {
          return Column(children: [
            day,
            const SizedBox(height: Msg.s2),
            Row(children: [
              Expanded(child: start),
              const SizedBox(width: Msg.s2),
              Expanded(child: end),
              remove,
            ]),
          ]);
        }
        return Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Expanded(child: day),
          const SizedBox(width: Msg.s2),
          Expanded(child: start),
          const SizedBox(width: Msg.s2),
          Expanded(child: end),
          remove,
        ]);
      }),
    );
  }

  void _patch(int index, AvailabilityRule next) {
    final updated = List<AvailabilityRule>.of(rules);
    updated[index] = next;
    onChanged(updated);
  }

  Widget _dayField(AvailabilityRule rule, int index) => DropdownButtonFormField<int>(
        value: rule.weekday.clamp(0, 6).toInt(),
        decoration:  InputDecoration(labelText: uiCopy(UiMessage.m_day_8f2364e11b), filled: true, fillColor: AD.inputField),
        items: [
          for (var day = 0; day < 7; day++)
            DropdownMenuItem<int>(value: day, child: Text(nativeListingWeekdayName(day))),
        ],
        onChanged: enabled
            ? (value) {
                if (value == null) return;
                _patch(index, rule.copyWith(weekday: value));
              }
            : null,
      );

  Widget _timeField(BuildContext context, String label, int minutes, ValueChanged<int> onChanged) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(label, style: ADText.sectionLabel()),
      const SizedBox(height: 4),
      InkWell(
        onTap: enabled
            ? () async {
                final picked = await showTimePicker(
                  context: context,
                  initialTime: TimeOfDay(hour: (minutes ~/ 60) % 24, minute: minutes % 60),
                );
                if (picked == null) return;
                onChanged(picked.hour * 60 + picked.minute);
              }
            : null,
        borderRadius: BorderRadius.circular(AD.rInput),
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s3),
          decoration: BoxDecoration(
            color: AD.inputField,
            borderRadius: BorderRadius.circular(AD.rInput),
            border: Border.all(color: AD.borderControl, width: AD.wBorder),
          ),
          child: Row(children: [
            Expanded(child: Text(nativeListingClockLabel(minutes), style: ADText.preview(c: AD.textPrimary))),
            PhosphorIcon(PhosphorIcons.clock(PhosphorIconsStyle.regular), size: 16, color: AD.textSecondary),
          ]),
        ),
      ),
    ]);
  }
}

/// [CAL-TIME-1] A real date + time picker that REPLACES the raw ISO text box.
/// The value it writes is still the same `YYYY-MM-DDTHH:MM` wall clock the
/// Worker's `starts_at` expects, always read in [timezone], so the audit's
/// "no more typed 2026-12-31T18:00" and the existing payload contract agree.
class NativeListingDateTimeField extends StatelessWidget {
  const NativeListingDateTimeField({
    super.key,
    required this.label,
    required this.value,
    required this.timezone,
    required this.onChanged,
    this.help,
    this.enabled = true,
  });

  final String label;
  final String? value;
  final String timezone;
  final ValueChanged<String> onChanged;
  final String? help;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    final parsed = nativeListingParseLocal(value);
    final display = parsed == null
        ? 'Choose a date and time'
        : '${nativeListingHumanDateTime(parsed)} · $timezone';
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(label, style: ADText.sectionLabel()),
      const SizedBox(height: 4),
      InkWell(
        onTap: enabled ? () => _pick(context, parsed) : null,
        borderRadius: BorderRadius.circular(AD.rInput),
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.all(Msg.s3),
          decoration: BoxDecoration(
            color: AD.inputField,
            borderRadius: BorderRadius.circular(AD.rInput),
            border: Border.all(color: AD.borderControl, width: AD.wBorder),
          ),
          child: Row(children: [
            Expanded(
              child: Text(display,
                  style: ADText.preview(c: parsed == null ? AD.textTertiary : AD.textPrimary)),
            ),
            PhosphorIcon(PhosphorIcons.calendarBlank(PhosphorIconsStyle.regular),
                size: 18, color: AD.textSecondary),
          ]),
        ),
      ),
      if (help != null) ...[
        const SizedBox(height: 4),
        Text(help!, style: ADText.preview(c: AD.textTertiary)),
      ],
    ]);
  }

  Future<void> _pick(BuildContext context, DateTime? parsed) async {
    final now = DateTime.now();
    final firstDate = DateTime(now.year, now.month, now.day);
    final lastDate = firstDate.add(const Duration(days: 730));
    var initial = parsed ?? now.add(const Duration(hours: 1));
    if (initial.isBefore(firstDate)) initial = firstDate;
    if (initial.isAfter(lastDate)) initial = lastDate;
    final date = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: firstDate,
      lastDate: lastDate,
    );
    if (date == null || !context.mounted) return;
    final time = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(initial));
    if (time == null) return;
    onChanged(nativeListingLocalInput(DateTime(date.year, date.month, date.day, time.hour, time.minute)));
  }
}

/// [CAL-CONFLICT-1] "Checking… / This time is free / already taken / not
/// verified", plus the server's suggested alternatives.
class NativeListingConflictFeedback extends StatelessWidget {
  const NativeListingConflictFeedback({
    super.key,
    required this.state,
    required this.timezone,
    required this.published,
    required this.mode,
    required this.liveEvent,
    this.onUseAlternative,
    this.onCheckAgain,
    this.emptyHint = 'Pick a date and time to check it against your calendar.',
  });

  final NativeListingConflictState state;
  final String timezone;
  final bool published;
  final AvailabilityMode mode;
  final bool liveEvent;
  final ValueChanged<AvailabilityAlternative>? onUseAlternative;
  final VoidCallback? onCheckAgain;
  final String emptyHint;

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    switch (state.status) {
      case NativeListingConflictStatus.idle:
        return Text(emptyHint, style: ADText.preview(c: AD.textTertiary));
      case NativeListingConflictStatus.checking:
        return Row(children: [
          const SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(strokeWidth: 2, color: Msg.accent)),
          const SizedBox(width: Msg.s2),
          Expanded(child: UiText(UiMessage.m_checking_your_calendar_7deb047ea2, style: ADText.preview(c: AD.textSecondary))),
        ]);
      case NativeListingConflictStatus.free:
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const AdSticker('This time is free', kind: AdStickerKind.ok),
          const SizedBox(height: Msg.s2),
          Text(knownUiCopy(nativeListingReservedCopy(published: published, mode: mode, liveEvent: liveEvent)),
              style: ADText.preview(c: AD.textSecondary)),
        ]);
      case NativeListingConflictStatus.conflicts:
        final conflict = state.firstConflict;
        return ZineCard(
          padding: const EdgeInsets.all(Msg.s3),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const AdSticker('Already taken', kind: AdStickerKind.no),
            const SizedBox(height: Msg.s2),
            Text(
              conflict == null
                  ? uiCopy(UiMessage.m_this_time_conflicts_with_something_6422e999a8)
                  : knownUiCopy(nativeListingConflictMessage(conflict, timezone)),
              style: ADText.preview(c: AD.textPrimary),
            ),
            const SizedBox(height: Msg.s2),
            Text(knownUiCopy(nativeListingReservedCopy(published: published, mode: mode, liveEvent: liveEvent)),
                style: ADText.preview(c: AD.textSecondary)),
            if (state.alternatives.isNotEmpty) ...[
              const SizedBox(height: Msg.s3),
              UiText(UiMessage.m_free_times_nearby_9cee155d61, style: ADText.sectionLabel()),
              const SizedBox(height: Msg.s2),
              Wrap(spacing: Msg.s2, runSpacing: Msg.s2, children: [
                for (final alternative in state.alternatives)
                  ZineChip(
                    label: nativeListingAlternativeLabel(alternative, timezone),
                    onTap: onUseAlternative == null ? null : () => onUseAlternative!(alternative),
                  ),
              ]),
            ],
            if (onCheckAgain != null) ...[
              const SizedBox(height: Msg.s2),
              ZineLink('Check again', onTap: onCheckAgain),
            ],
          ]),
        );
      case NativeListingConflictStatus.unknown:
        return ZineCard(
          padding: const EdgeInsets.all(Msg.s3),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const AdSticker('Not verified', kind: AdStickerKind.hint),
            const SizedBox(height: Msg.s2),
            Text(knownUiError(state.message) ?? uiCopy(UiMessage.m_the_app_could_not_check_37de6a54da),
                style: ADText.preview(c: AD.textPrimary)),
            const SizedBox(height: Msg.s2),
            UiText(
                UiMessage.m_this_time_has_not_been_36a1391603,
                style: ADText.preview(c: AD.textSecondary)),
            if (onCheckAgain != null) ...[
              const SizedBox(height: Msg.s2),
              ZineLink('Check again', onTap: onCheckAgain),
            ],
          ]),
        );
    }
  }
}

/// [CAL-GCAL-1] The Google readiness card. Its only job is to stop the app
/// saying "connected" where the server means "not ready", and to point at the
/// screen that can actually refresh the sync.
class NativeListingGcalReadinessCard extends StatelessWidget {
  const NativeListingGcalReadinessCard({
    super.key,
    required this.readiness,
    this.loading = false,
    this.onCheckAgain,
    this.onOpenCalendar,
  });

  final NativeListingGcalReadiness? readiness;
  final bool loading;
  final VoidCallback? onCheckAgain;
  final VoidCallback? onOpenCalendar;

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    final value = readiness;
    final Color accent = switch (value?.state) {
      NativeListingGcalState.ready => AD.online,
      NativeListingGcalState.unknown => AD.newGroup,
      null => AD.newGroup,
      _ => AD.danger,
    };
    return ZineCard(
      padding: const EdgeInsets.all(Msg.s3),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(
            icon: PhosphorIcons.googleLogo(PhosphorIconsStyle.regular),
            color: accent,
            size: 28,
          ),
          const SizedBox(width: Msg.s2),
          Expanded(
            child: Text(
              loading || value == null ? uiCopy(UiMessage.m_checking_google_calendar_965b072fff) : knownUiCopy(value.headline),
              style: ADText.rowName(),
            ),
          ),
        ]),
        const SizedBox(height: Msg.s2),
        if (value != null)
          Text(knownUiCopy(value.body), style: ADText.preview(c: AD.textSecondary)),
        if (value != null && value.state != NativeListingGcalState.ready) ...[
          const SizedBox(height: Msg.s2),
          UiText(
            UiMessage.m_publishing_a_listing_with_a_8faa350c99,
            style: ADText.preview(c: AD.textPrimary),
          ),
        ],
        const SizedBox(height: Msg.s2),
        Wrap(spacing: Msg.s2, runSpacing: Msg.s2, children: [
          if (onCheckAgain != null)
            ZineLink(loading ? 'Checking…' : 'Check again', onTap: loading ? null : onCheckAgain),
          if (onOpenCalendar != null) ZineLink('Open calendar & availability', onTap: onOpenCalendar),
        ]),
      ]),
    );
  }
}

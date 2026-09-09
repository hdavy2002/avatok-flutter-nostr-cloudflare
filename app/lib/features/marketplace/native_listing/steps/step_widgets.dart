import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../../core/ui/avatok_dark.dart';

/// The native wizard deliberately keeps its steps dumb: the coordinator owns
/// persistence, validation, and the draft model. These callbacks are the
/// boundary between a step and that controller.
typedef NativeListingPatch = void Function(Map<String, dynamic> changes);
typedef NativeListingError = String? Function(String field);

dynamic listingDraftValue(dynamic draft, String camel, String snake, [dynamic fallback]) {
  if (draft is Map) return draft[snake] ?? draft[camel] ?? fallback;
  try {
    switch (camel) {
      case 'kind':
        final value = '${draft.kind}';
        return switch (value) {
          'ListingKind.consult' => 'consult',
          'ListingKind.aiAgent' => 'ai_agent',
          'consult' => 'consult',
          'ai_agent' => 'ai_agent',
          _ => 'live_event',
        };
      case 'freeEntry': return draft.freeEntry ?? fallback;
      case 'scheduleMode':
        final value = '${draft.scheduleMode ?? draft.schedule}';
        return switch (value) {
          'ListingScheduleMode.recurring' || 'recurring' => 'recurring',
          'ListingScheduleMode.onRequest' || 'on_request' => 'on_request',
          'ListingScheduleMode.alwaysOn' || 'always_on' => 'always_on',
          _ => 'fixed_date',
        };
      case 'title': return draft.title ?? fallback;
      case 'blurb': return draft.blurb ?? fallback;
      case 'description': return draft.description ?? fallback;
      case 'category': return draft.category ?? fallback;
      case 'price': return draft.price ?? fallback;
      case 'earlyBirdPct': return draft.earlyBirdPct ?? fallback;
      case 'promoCode': return draft.promoCode ?? fallback;
      case 'timezone': return draft.timezone ?? fallback;
      case 'startsAt': return draft.startsAt ?? fallback;
      case 'durationMin': return draft.durationMin ?? draft.duration ?? fallback;
      case 'recurrenceDays': return draft.recurrenceDays ?? fallback;
      case 'recurrenceTime': return draft.recurrenceTime ?? fallback;
      case 'slots': return draft.slots ?? fallback;
      case 'responseTimeMin': return draft.responseTimeMin ?? draft.responseMin ?? fallback;
      case 'maxPerBooking': return draft.maxPerBooking ?? fallback;
      case 'capacity': return draft.capacity ?? fallback;
    }
  } catch (_) {}
  return fallback;
}

class NativeListingCategory {
  const NativeListingCategory({
    required this.id,
    required this.label,
    this.emoji,
    this.groupId,
  });

  final String id;
  final String label;
  final String? emoji;
  final String? groupId;
}

class NativeListingSlotDraft {
  const NativeListingSlotDraft({
    required this.startsAt,
    required this.durationMin,
    required this.label,
    required this.capacity,
  });

  final int startsAt;
  final int durationMin;
  final String label;
  final int capacity;
}

class NativeStepLayout extends StatelessWidget {
  const NativeStepLayout({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) => Center(
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: constraints.maxWidth > 720 ? 680 : double.infinity,
          ),
          child: Padding(
            padding: EdgeInsets.symmetric(
              horizontal: constraints.maxWidth > 560 ? 28 : 16,
              vertical: 8,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [for (var i = 0; i < children.length; i++) ...[
                children[i],
                if (i != children.length - 1) const SizedBox(height: 20),
              ]],
            ),
          ),
        ),
      ),
    );
  }
}

class NativeStepLabel extends StatelessWidget {
  const NativeStepLabel(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Text(
        text,
        style: ADText.sectionLabel(c: AD.textSecondary),
      );
}

class NativeStepCard extends StatelessWidget {
  const NativeStepCard({super.key, required this.child, this.selected = false});
  final Widget child;
  final bool selected;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: selected ? AD.primaryBadge.withValues(alpha: .16) : AD.card,
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(
            color: selected ? AD.primaryBadge : AD.borderControl,
            width: AD.wBorder,
          ),
          boxShadow: const [
            BoxShadow(color: AD.borderDivider, offset: Offset(3, 3)),
          ],
        ),
        child: child,
      );
}

class NativeErrorText extends StatelessWidget {
  const NativeErrorText({super.key, this.message});
  final String? message;

  @override
  Widget build(BuildContext context) => message == null || message!.isEmpty
      ? const SizedBox.shrink()
      : Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text('⚠ $message', style: ADText.preview(c: AD.danger)),
        );
}

Widget nativeSelect<T>({
  required String label,
  required T value,
  required List<DropdownMenuItem<T>> items,
  required ValueChanged<T?> onChanged,
}) {
  return Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      NativeStepLabel(label),
      const SizedBox(height: 8),
      DropdownButtonFormField<T>(
        value: value,
        items: items,
        onChanged: onChanged,
        decoration: const InputDecoration(isDense: true),
      ),
    ],
  );
}

Widget nativeNumberField({
  required String label,
  required String value,
  required ValueChanged<String> onChanged,
  String? hint,
  String? error,
  int? min,
  int? max,
}) {
  return Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      AdField(
        label: label,
        hint: hint,
        keyboardType: TextInputType.number,
        inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9]'))],
        onChanged: onChanged,
      ),
      NativeErrorText(message: error),
    ],
  );
}

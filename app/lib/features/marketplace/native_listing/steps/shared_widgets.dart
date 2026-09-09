import 'package:flutter/material.dart';

import '../../../../core/ui/avatok_dark.dart';
import '../../../../core/ui/messenger_theme.dart';
import '../../../../core/ui/zine_widgets.dart';

typedef DraftPatch = void Function(Map<String, dynamic> patch);

dynamic draftValue(dynamic draft, String key, [dynamic fallback]) {
  if (draft is Map) return draft[key] ?? fallback;
  try {
    switch (key) {
      case 'kind':
        return draft.kind ?? fallback;
      case 'title':
        return draft.title ?? fallback;
      case 'blurb':
        return draft.blurb ?? fallback;
      case 'description':
        return draft.description ?? fallback;
      case 'category':
        return draft.category ?? fallback;
      case 'content_how_it_works':
        return draft.content_how_it_works ?? fallback;
      case 'content_house_rules_intro':
        return draft.content_house_rules_intro ?? fallback;
      case 'content_house_rules':
        return draft.content_house_rules ?? fallback;
      case 'content_what_you_get':
        return draft.content_what_you_get ?? fallback;
      case 'content_who_for':
        return draft.content_who_for ?? fallback;
      case 'content_not_for':
        return draft.content_not_for ?? fallback;
      case 'content_faq':
        return draft.content_faq ?? fallback;
      case 'join_requirements':
        return draft.join_requirements ?? fallback;
      case 'content_join_lead_minutes':
        return draft.content_join_lead_minutes ?? fallback;
      case 'content_sample_qa':
        return draft.content_sample_qa ?? fallback;
      case 'credential':
        return draft.credential ?? fallback;
      case 'commercial_preparation_instructions':
        return draft.commercial_preparation_instructions ?? fallback;
      case 'content_sample_chat':
        return draft.content_sample_chat ?? fallback;
      case 'content_can_do':
        return draft.content_can_do ?? fallback;
      case 'content_cant_do':
        return draft.content_cant_do ?? fallback;
      case 'cover_media':
        return draft.cover_media ?? fallback;
      case 'face_photo':
        return draft.face_photo ?? fallback;
      case 'video_url':
        return draft.video_url ?? fallback;
      case 'location':
        return draft.location ?? fallback;
      case 'adults_only':
        return draft.adults_only ?? fallback;
      case 'commercial_refund_window_hours':
        return draft.commercial_refund_window_hours ?? fallback;
      case 'commercial_cancellation_window_hours':
        return draft.commercial_cancellation_window_hours ?? fallback;
      case 'commercial_reschedule_allowed':
        return draft.commercial_reschedule_allowed ?? fallback;
      case 'commercial_booking_notice_hours':
        return draft.commercial_booking_notice_hours ?? fallback;
      case 'poster':
        return draft.poster ?? fallback;
      case 'status':
        return draft.status ?? fallback;
    }
  } catch (_) {}
  return fallback;
}

List<dynamic> draftList(dynamic draft, String key) {
  final value = draftValue(draft, key, const <dynamic>[]);
  return value is List ? List<dynamic>.from(value) : <dynamic>[];
}

Map<String, dynamic> draftMap(dynamic value) {
  if (value is Map) return Map<String, dynamic>.from(value);
  return <String, dynamic>{};
}

String textValue(dynamic value) => value?.toString() ?? '';

class ListingSection extends StatelessWidget {
  final String title;
  final String? hint;
  final Widget child;
  final Widget? action;
  const ListingSection(
      {super.key,
      required this.title,
      required this.child,
      this.hint,
      this.action});
  @override
  Widget build(BuildContext context) =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                Text(title, style: ADText.threadName().copyWith(fontSize: 18)),
                if (hint != null)
                  Text(hint!,
                      style: ADText.preview(c: AD.textSecondary)
                          .copyWith(fontSize: 12)),
              ])),
          if (action != null) action!,
        ]),
        const SizedBox(height: Msg.s3),
        child,
      ]);
}

class ListingField extends StatelessWidget {
  final String label;
  final String? hint;
  final String value;
  final ValueChanged<String> onChanged;
  final int maxLines;
  final int? maxLength;
  final TextInputType? keyboardType;
  const ListingField(
      {super.key,
      required this.label,
      required this.value,
      required this.onChanged,
      this.hint,
      this.maxLines = 1,
      this.maxLength,
      this.keyboardType});
  @override
  Widget build(BuildContext context) =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: ADText.sectionLabel(c: AD.textSecondary)),
        const SizedBox(height: Msg.s1),
        TextFormField(
          initialValue: value,
          onChanged: onChanged,
          maxLines: maxLines,
          maxLength: maxLength,
          keyboardType: keyboardType,
          style: ADText.bubbleBody(c: AD.textPrimary).copyWith(fontSize: 16),
          decoration: InputDecoration(
              hintText: hint,
              filled: true,
              fillColor: AD.inputField,
              counterText: '',
              border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(Msg.rMd),
                  borderSide: BorderSide(color: AD.borderControl, width: 1))),
        ),
      ]);
}

class ListingCard extends StatelessWidget {
  final Widget child;
  final Color? color;
  const ListingCard({super.key, required this.child, this.color});
  @override
  Widget build(BuildContext context) => Container(
      width: double.infinity,
      padding: const EdgeInsets.all(Msg.s3),
      decoration: BoxDecoration(
          color: color ?? AD.card,
          border: Border.all(color: AD.borderControl),
          borderRadius: BorderRadius.circular(Msg.rMd)),
      child: child);
}

class StringListEditor extends StatelessWidget {
  final String title;
  final List<dynamic> values;
  final int max;
  final ValueChanged<List<String>> onChanged;
  final String placeholder;
  const StringListEditor(
      {super.key,
      required this.title,
      required this.values,
      required this.max,
      required this.onChanged,
      this.placeholder = 'Add an item'});
  @override
  Widget build(BuildContext context) =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title, style: ADText.sectionLabel(c: AD.textSecondary)),
        const SizedBox(height: Msg.s2),
        ...values.asMap().entries.map((entry) => Padding(
            padding: const EdgeInsets.only(bottom: Msg.s2),
            child: Row(children: [
              Expanded(
                  child: TextFormField(
                      initialValue: textValue(entry.value),
                      maxLength: 80,
                      onChanged: (v) {
                        final next = values.map(textValue).toList();
                        next[entry.key] = v;
                        onChanged(next);
                      },
                      decoration: InputDecoration(
                          hintText: placeholder,
                          counterText: '',
                          filled: true,
                          fillColor: AD.inputField,
                          border: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(Msg.rMd))))),
              IconButton(
                  onPressed: () {
                    final next = values.map(textValue).toList()
                      ..removeAt(entry.key);
                    onChanged(next);
                  },
                  icon: Icon(Icons.close, color: AD.danger)),
            ]))),
        if (values.length < max)
          TextButton.icon(
              onPressed: () => onChanged([...values.map(textValue), '']),
              icon: const Icon(Icons.add),
              label: Text('Add item', style: ADText.rowName())),
        Text('${values.length}/$max',
            style: ADText.statCaption(c: AD.textTertiary)),
      ]);
}

class PairListEditor extends StatelessWidget {
  final String title;
  final List<dynamic> values;
  final int max;
  final String firstKey;
  final String secondKey;
  final String firstLabel;
  final String secondLabel;
  final ValueChanged<List<Map<String, dynamic>>> onChanged;
  const PairListEditor(
      {super.key,
      required this.title,
      required this.values,
      required this.max,
      required this.firstKey,
      required this.secondKey,
      required this.firstLabel,
      required this.secondLabel,
      required this.onChanged});
  @override
  Widget build(BuildContext context) =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title, style: ADText.sectionLabel(c: AD.textSecondary)),
        const SizedBox(height: Msg.s2),
        ...values.asMap().entries.map((entry) {
          final item = draftMap(entry.value);
          void update(String key, String value) {
            final next = values.map((v) => draftMap(v)).toList();
            next[entry.key] = {...next[entry.key], key: value};
            onChanged(next);
          }

          return Padding(
              padding: const EdgeInsets.only(bottom: Msg.s2),
              child: ListingCard(
                  child: Column(children: [
                Row(children: [
                  Expanded(
                      child: Text(
                          '${title.replaceAll(' (up to ${max})', '')} ${entry.key + 1}',
                          style: ADText.statCaption(c: AD.textTertiary))),
                  IconButton(
                      onPressed: () {
                        final next = values.map((v) => draftMap(v)).toList()
                          ..removeAt(entry.key);
                        onChanged(next);
                      },
                      icon: Icon(Icons.close, color: AD.danger))
                ]),
                ListingField(
                    label: firstLabel,
                    value: textValue(item[firstKey]),
                    onChanged: (v) => update(firstKey, v),
                    maxLength: firstKey == 'label' ? 24 : 120),
                const SizedBox(height: Msg.s2),
                ListingField(
                    label: secondLabel,
                    value: textValue(item[secondKey]),
                    onChanged: (v) => update(secondKey, v),
                    maxLines: 3,
                    maxLength: secondKey == 'body' ? 300 : 300),
              ])));
        }),
        if (values.length < max)
          TextButton.icon(
              onPressed: () => onChanged([
                    ...values.map((v) => draftMap(v)),
                    {firstKey: '', secondKey: ''}
                  ]),
              icon: const Icon(Icons.add),
              label: Text('Add', style: ADText.rowName())),
        Text('${values.length}/$max',
            style: ADText.statCaption(c: AD.textTertiary)),
      ]);
}

Widget fullWidthButton(
        {required String label,
        required VoidCallback? onPressed,
        bool loading = false,
        bool destructive = false}) =>
    SizedBox(
        width: double.infinity,
        child: ZineButton(
            label: label,
            onPressed: onPressed,
            loading: loading,
            variant: destructive
                ? ZineButtonVariant.coral
                : ZineButtonVariant.lime));

Widget statusMessage(String message, {bool error = false}) => ListingCard(
    color: error ? AD.destructiveBg : AD.cardHover,
    child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Icon(error ? Icons.error_outline : Icons.info_outline,
          color: error ? AD.danger : AD.textSecondary),
      const SizedBox(width: Msg.s2),
      Expanded(
          child: Text(message,
              style: ADText.preview(c: error ? AD.danger : AD.textPrimary)))
    ]));

import 'package:flutter/material.dart';
import 'shared_widgets.dart';

class ListingStep5HowItWorks extends StatelessWidget {
  final dynamic draft;
  final DraftPatch onPatch;
  final VoidCallback? onUseSuggested;
  const ListingStep5HowItWorks(
      {super.key,
      required this.draft,
      required this.onPatch,
      this.onUseSuggested});
  @override
  Widget build(BuildContext context) =>
      LayoutBuilder(builder: (context, constraints) {
        final items = draftList(draft, 'content_how_it_works');
        return Center(
            child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 760),
                child: ListingSection(
                  title: 'How it works',
                  hint:
                      'Optional — up to 5 short steps explaining what happens once someone books.',
                  action: TextButton(
                      onPressed: onUseSuggested,
                      child: const Text('Use suggested')),
                  child: PairListEditor(
                      title: 'Steps',
                      values: items,
                      max: 5,
                      firstKey: 'label',
                      secondKey: 'body',
                      firstLabel: 'Step name',
                      secondLabel: 'What happens',
                      onChanged: (v) => onPatch({'content_how_it_works': v})),
                )));
      });
}

class ListingStep6HouseRules extends StatelessWidget {
  final dynamic draft;
  final DraftPatch onPatch;
  final VoidCallback? onUseSuggested;
  const ListingStep6HouseRules(
      {super.key,
      required this.draft,
      required this.onPatch,
      this.onUseSuggested});
  @override
  Widget build(BuildContext context) =>
      LayoutBuilder(builder: (context, constraints) {
        final kind = textValue(draftValue(draft, 'kind'));
        final requirements = draftMap(draftValue(draft, 'join_requirements'));
        return Center(
            child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 760),
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      ListingSection(
                          title: 'House rules',
                          hint:
                              'Optional — up to 8 rules, plus a short intro line.',
                          action: TextButton(
                              onPressed: onUseSuggested,
                              child: const Text('Use suggested')),
                          child: Column(children: [
                            ListingField(
                                label: 'Intro line',
                                value: textValue(draftValue(
                                    draft, 'content_house_rules_intro')),
                                maxLines: 2,
                                maxLength: 280,
                                onChanged: (v) =>
                                    onPatch({'content_house_rules_intro': v})),
                            const SizedBox(height: 16),
                            PairListEditor(
                                title: 'Rules',
                                values: draftList(draft, 'content_house_rules'),
                                max: 8,
                                firstKey: 'heading',
                                secondKey: 'body',
                                firstLabel: 'Rule',
                                secondLabel: 'Detail',
                                onChanged: (v) =>
                                    onPatch({'content_house_rules': v})),
                          ])),
                      const SizedBox(height: 24),
                      StringListEditor(
                          title: 'What you get',
                          values: draftList(draft, 'content_what_you_get'),
                          max: 5,
                          onChanged: (v) =>
                              onPatch({'content_what_you_get': v})),
                      const SizedBox(height: 20),
                      LayoutBuilder(builder: (context, c) {
                        final forWho = StringListEditor(
                            title: 'Who this is for',
                            values: draftList(draft, 'content_who_for'),
                            max: 3,
                            onChanged: (v) => onPatch({'content_who_for': v}));
                        final notFor = StringListEditor(
                            title: 'Not for',
                            values: draftList(draft, 'content_not_for'),
                            max: 3,
                            onChanged: (v) => onPatch({'content_not_for': v}));
                        return c.maxWidth > 560
                            ? Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                    Expanded(child: forWho),
                                    const SizedBox(width: 16),
                                    Expanded(child: notFor)
                                  ])
                            : Column(children: [
                                forWho,
                                const SizedBox(height: 20),
                                notFor
                              ]);
                      }),
                      const SizedBox(height: 20),
                      PairListEditor(
                          title: 'FAQ',
                          values: draftList(draft, 'content_faq'),
                          max: 6,
                          firstKey: 'q',
                          secondKey: 'a',
                          firstLabel: 'Question',
                          secondLabel: 'Answer',
                          onChanged: (v) => onPatch({'content_faq': v})),
                      const SizedBox(height: 20),
                      ListingCard(
                          child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                            Text('Join requirements',
                                style: Theme.of(context).textTheme.titleMedium),
                            ...['mic', 'cam', 'listen_only', 'recording']
                                .map((key) => CheckboxListTile(
                                    contentPadding: EdgeInsets.zero,
                                    value: requirements[key] == true,
                                    title: Text(key.replaceAll('_', ' ')),
                                    onChanged: (v) => onPatch({
                                          'join_requirements': {
                                            ...requirements,
                                            key: v == true
                                          }
                                        }))),
                            ListingField(
                                label: 'Join lead time (minutes)',
                                value: textValue(draftValue(
                                    draft, 'content_join_lead_minutes', 5)),
                                keyboardType: TextInputType.number,
                                onChanged: (v) => onPatch({
                                      'content_join_lead_minutes':
                                          int.tryParse(v) ?? 0
                                    }))
                          ])),
                      if (kind == 'consult') ...[
                        const SizedBox(height: 20),
                        ListingField(
                            label: 'Credential',
                            value: textValue(draftValue(draft, 'credential')),
                            hint: 'e.g. Chartered Accountant',
                            maxLength: 40,
                            onChanged: (v) => onPatch({'credential': v})),
                        const SizedBox(height: 16),
                        PairListEditor(
                            title: 'Sample Q&A',
                            values: draftList(draft, 'content_sample_qa'),
                            max: 3,
                            firstKey: 'q',
                            secondKey: 'a',
                            firstLabel: 'Question',
                            secondLabel: 'Answer',
                            onChanged: (v) =>
                                onPatch({'content_sample_qa': v})),
                        const SizedBox(height: 16),
                        ListingField(
                            label: 'Preparation instructions',
                            value: textValue(draftValue(
                                draft, 'commercial_preparation_instructions')),
                            maxLines: 4,
                            maxLength: 600,
                            onChanged: (v) => onPatch(
                                {'commercial_preparation_instructions': v})),
                      ],
                      if (kind == 'ai_agent') ...[
                        const SizedBox(height: 20),
                        StringListEditor(
                            title: 'Can do',
                            values: draftList(draft, 'content_can_do'),
                            max: 3,
                            onChanged: (v) => onPatch({'content_can_do': v})),
                        const SizedBox(height: 16),
                        StringListEditor(
                            title: "Can't do",
                            values: draftList(draft, 'content_cant_do'),
                            max: 3,
                            onChanged: (v) => onPatch({'content_cant_do': v})),
                        const SizedBox(height: 16),
                        PairListEditor(
                            title: 'Sample chat',
                            values: draftList(draft, 'content_sample_chat'),
                            max: 6,
                            firstKey: 'who',
                            secondKey: 'line',
                            firstLabel: 'Who',
                            secondLabel: 'Line',
                            onChanged: (v) =>
                                onPatch({'content_sample_chat': v})),
                      ],
                    ])));
      });
}

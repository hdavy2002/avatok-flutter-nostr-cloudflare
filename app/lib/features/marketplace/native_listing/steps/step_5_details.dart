
import '../../../../core/localization/ui_text.dart';

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
  Widget build(BuildContext context) { UiLocaleScope.watch(context); return
      LayoutBuilder(builder: (context, constraints) {
        final items = draftList(draft, 'content_how_it_works');
        return Center(
            child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 760),
                child: ListingSection(
                  title: uiCopy(UiMessage.m_how_it_works_9c870aa6e5),
                  hint:
                      uiCopy(UiMessage.m_optional_up_to_5_short_baae8e351b),
                  action: TextButton(
                      onPressed: onUseSuggested,
                      child: const UiText(UiMessage.m_use_suggested_55f8e1ad22)),
                  child: PairListEditor(
                      title: uiCopy(UiMessage.m_steps_1de3df70dd),
                      values: items,
                      max: 5,
                      firstKey: 'label',
                      secondKey: 'body',
                      firstLabel: 'Step name',
                      secondLabel: 'What happens',
                      onChanged: (v) => onPatch({'content_how_it_works': v})),
                )));
      }); }
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
  Widget build(BuildContext context) { UiLocaleScope.watch(context); return
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
                          title: uiCopy(UiMessage.m_house_rules_152b8e467b),
                          hint:
                              uiCopy(UiMessage.m_optional_up_to_8_rules_6920c633ec),
                          action: TextButton(
                              onPressed: onUseSuggested,
                              child: const UiText(UiMessage.m_use_suggested_55f8e1ad22)),
                          child: Column(children: [
                            ListingField(
                                label: uiCopy(UiMessage.m_intro_line_81261b7be6),
                                value: textValue(draftValue(
                                    draft, 'content_house_rules_intro')),
                                maxLines: 2,
                                maxLength: 280,
                                onChanged: (v) =>
                                    onPatch({'content_house_rules_intro': v})),
                            const SizedBox(height: 16),
                            PairListEditor(
                                title: uiCopy(UiMessage.m_rules_4228aeb07c),
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
                          title: uiCopy(UiMessage.m_what_you_get_41a1acbef2),
                          values: draftList(draft, 'content_what_you_get'),
                          max: 5,
                          onChanged: (v) =>
                              onPatch({'content_what_you_get': v})),
                      const SizedBox(height: 20),
                      LayoutBuilder(builder: (context, c) {
                        final forWho = StringListEditor(
                            title: uiCopy(UiMessage.m_who_this_is_for_6f7e69bb1f),
                            values: draftList(draft, 'content_who_for'),
                            max: 3,
                            onChanged: (v) => onPatch({'content_who_for': v}));
                        final notFor = StringListEditor(
                            title: uiCopy(UiMessage.m_not_for_9eed17bb0c),
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
                          title: uiCopy(UiMessage.m_faq_dbc468a14b),
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
                            UiText(UiMessage.m_join_requirements_936fd8f737,
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
                                label: uiCopy(UiMessage.m_join_lead_time_minutes_5f4faae526),
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
                            label: uiCopy(UiMessage.m_credential_b1c42b3ce1),
                            value: textValue(draftValue(draft, 'credential')),
                            hint: uiCopy(UiMessage.m_e_g_chartered_accountant_b4f9b41370),
                            maxLength: 40,
                            onChanged: (v) => onPatch({'credential': v})),
                        const SizedBox(height: 16),
                        PairListEditor(
                            title: uiCopy(UiMessage.m_sample_q_a_b82ef0712a),
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
                            label: uiCopy(UiMessage.m_preparation_instructions_032b1c727a),
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
                            title: uiCopy(UiMessage.m_can_do_2de2c8f7e0),
                            values: draftList(draft, 'content_can_do'),
                            max: 3,
                            onChanged: (v) => onPatch({'content_can_do': v})),
                        const SizedBox(height: 16),
                        StringListEditor(
                            title: uiCopy(UiMessage.m_can_t_do_04270bce69),
                            values: draftList(draft, 'content_cant_do'),
                            max: 3,
                            onChanged: (v) => onPatch({'content_cant_do': v})),
                        const SizedBox(height: 16),
                        PairListEditor(
                            title: uiCopy(UiMessage.m_sample_chat_56bd35ad27),
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
      }); }
}

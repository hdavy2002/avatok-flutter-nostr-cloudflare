
import '../../core/localization/ui_text.dart';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/remote_config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import 'native_listing/native_listing_wizard_screen.dart';

/// Opens the Phase 2 creator-service chooser and then the existing hardened
/// listing wizard with the selected commercial kind locked. GetStream is named
/// here only as a product guarantee; no provider credential reaches this UI.
Future<bool?> openCreateServiceChoice(BuildContext context) async {
  Analytics.capture('commercial_service_create_opened');
  final kind = await showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AD.bg,
    shape: const RoundedRectangleBorder(borderRadius: Msg.brSheetTop),
    builder: (_) => const CreateServiceChoiceSheet(),
  );
  if (kind == null || !context.mounted) return null;
  Analytics.capture('commercial_service_kind_selected', {'kind': kind});
  return Navigator.of(context).push<bool>(MaterialPageRoute(
    builder: (_) => NativeListingWizardScreen(
      initialKind: kind,
      source: 'service_choice',
    ),
  ));
}

class CreateServiceChoiceSheet extends StatelessWidget {
  const CreateServiceChoiceSheet({super.key});

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    final live = RemoteConfig.commercialLiveListingsEnabled;
    final consult = RemoteConfig.commercialConsultListingsEnabled;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          Msg.s4,
          Msg.s4,
          Msg.s4,
          Msg.s4 + MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 42,
            height: 4,
            decoration: BoxDecoration(
              color: AD.borderControl,
              borderRadius: Msg.brPill,
            ),
          ),
          const SizedBox(height: Msg.s4),
          Align(
            alignment: Alignment.centerLeft,
            child: UiText(UiMessage.m_what_do_you_want_to_8cdf9f4e38, style: ADText.appTitle()),
          ),
          const SizedBox(height: Msg.s1),
          Align(
            alignment: Alignment.centerLeft,
            child: UiText(
              UiMessage.m_customers_discover_and_pay_through_81bc67e26a,
              style: ADText.preview(),
            ),
          ),
          const SizedBox(height: Msg.s4),
          if (live)
            _ServiceChoice(
              icon: PhosphorIcons.broadcast(PhosphorIconsStyle.bold),
              color: AD.danger,
              title: uiCopy(UiMessage.m_create_a_live_event_003a5f40a1),
              subtitle: uiCopy(UiMessage.m_choose_a_time_and_ticket_267bd53f63),
              badges: const ['One-to-many', 'Free or paid ticket'],
              onTap: () => Navigator.pop(context, 'live_event'),
            ),
          if (live && consult) const SizedBox(height: Msg.s3),
          if (consult)
            _ServiceChoice(
              icon: PhosphorIcons.videoCamera(PhosphorIconsStyle.bold),
              color: AD.tabCalls,
              title: uiCopy(UiMessage.m_offer_a_1_1_consultation_743ac25976),
              subtitle: uiCopy(UiMessage.m_set_your_price_and_duration_2be47a736d),
              badges: const ['Private 1:1', 'Paid booking'],
              onTap: () => Navigator.pop(context, 'consult'),
            ),
          const SizedBox(height: Msg.s3),
          Row(children: [
            PhosphorIcon(
              PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold),
              size: 16,
              color: AD.online,
            ),
            const SizedBox(width: Msg.s2),
            Expanded(
              child: UiText(
                UiMessage.m_a_shared_link_never_replaces_3b98d2145c,
                style: ADText.preview(c: AD.textSecondary),
              ),
            ),
          ]),
        ]),
      ),
    );
  }
}

class _ServiceChoice extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String title, subtitle;
  final List<String> badges;
  final VoidCallback onTap;

  const _ServiceChoice({
    required this.icon,
    required this.color,
    required this.title,
    required this.subtitle,
    required this.badges,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) { UiLocaleScope.watch(context); return Semantics(
        button: true,
        label: '$title. $subtitle',
        child: Material(
          color: AD.card,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Msg.rLg),
            side: BorderSide(color: AD.borderControl),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.all(Msg.s4),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Container(
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(
                    color: color,
                    borderRadius: BorderRadius.circular(Msg.rMd),
                  ),
                  alignment: Alignment.center,
                  child: PhosphorIcon(icon, size: 25, color: AD.onBand(color)),
                ),
                const SizedBox(width: Msg.s3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(title, style: ADText.rowName()),
                      const SizedBox(height: Msg.s1),
                      Text(subtitle, style: ADText.preview()),
                      const SizedBox(height: Msg.s2),
                      Wrap(
                        spacing: Msg.s2,
                        runSpacing: Msg.s1,
                        children: [
                          for (final badge in badges)
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: Msg.s2,
                                vertical: 3,
                              ),
                              decoration: BoxDecoration(
                                color: color.withValues(alpha: 0.14),
                                borderRadius: Msg.brPill,
                              ),
                              child: Text(badge,
                                  style: ADText.preview(c: AD.textPrimary)),
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: Msg.s2),
                PhosphorIcon(
                  PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
                  size: 18,
                  color: AD.textTertiary,
                ),
              ]),
            ),
          ),
        ),
      ); }
}

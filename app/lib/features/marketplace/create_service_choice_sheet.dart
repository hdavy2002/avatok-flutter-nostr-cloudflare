import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/remote_config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../listings/create_listing_flow.dart';

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
    builder: (_) => CreateListingFlow(initialKind: kind),
  ));
}

class CreateServiceChoiceSheet extends StatelessWidget {
  const CreateServiceChoiceSheet({super.key});

  @override
  Widget build(BuildContext context) {
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
            child: Text('What do you want to offer?', style: ADText.appTitle()),
          ),
          const SizedBox(height: Msg.s1),
          Align(
            alignment: Alignment.centerLeft,
            child: Text(
              'Customers discover and pay through Marketplace. Calls and streams run privately through GetStream.',
              style: ADText.preview(),
            ),
          ),
          const SizedBox(height: Msg.s4),
          if (live)
            _ServiceChoice(
              icon: PhosphorIcons.broadcast(PhosphorIconsStyle.bold),
              color: AD.danger,
              title: 'Create a live event',
              subtitle: 'Choose a time and ticket price, then share the public event page. Only entitled accounts enter.',
              badges: const ['One-to-many', 'Free or paid ticket'],
              onTap: () => Navigator.pop(context, 'live_event'),
            ),
          if (live && consult) const SizedBox(height: Msg.s3),
          if (consult)
            _ServiceChoice(
              icon: PhosphorIcons.videoCamera(PhosphorIconsStyle.bold),
              color: AD.tabCalls,
              title: 'Offer a 1:1 consultation',
              subtitle: 'Set your price and duration. Customers choose an available time and pay before joining.',
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
              child: Text(
                'A shared link never replaces payment or an account-bound ticket.',
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
  Widget build(BuildContext context) => Semantics(
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
      );
}

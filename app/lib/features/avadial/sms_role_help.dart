import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/ui/avatok_dark.dart';
import 'avadial_channel.dart';

/// [AVA-SMS-FIX-1] Help sheet for the case where the ROLE_SMS request is
/// AUTO-DENIED by the OS — i.e. the system "Set as default SMS app?" picker
/// never appears and the denied verdict lands within ~2s of the request.
///
/// Two known causes (both observed on the owner's moto edge 70 fusion,
/// Android 16, 2026-07-14 — 17 instant denials, 0 grants in PostHog):
///   1. Android 15+ hard-restricts SEND_SMS/RECEIVE_SMS for apps NOT installed
///      from the Play Store. A sideloaded AvaTOK is disqualified from ROLE_SMS
///      until the user taps App info → ⋮ → "Allow restricted settings".
///   2. After repeated denials Android stops showing the picker entirely
///      (don't-ask-again throttling); the only path left is the OS
///      "Default apps" screen.
///
/// The dialog explains the unlock and deep-links to BOTH remedies. Callers
/// decide when an auto-denial happened (see [isInstantDenial]).
const Duration kSmsRoleInstantDenial = Duration(seconds: 2);

/// True when a denied verdict arrived so fast the system picker can't have
/// been shown to (and read by) a human.
bool isInstantDenial(DateTime? requestedAt) =>
    requestedAt != null &&
    DateTime.now().difference(requestedAt) < kSmsRoleInstantDenial;

Future<void> showSmsRoleRestrictedHelp(BuildContext context) {
  Analytics.capture('avadial_sms_restricted_help_shown', const {});
  return showDialog<void>(
    context: context,
    builder: (ctx) => AlertDialog(
      backgroundColor: AD.popover,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AD.rDialog),
        side: const BorderSide(color: AD.borderControl, width: 1),
      ),
      title: Text('Android blocked the request', style: ADText.threadName()),
      content: Text(
        'Your phone denied the request without asking you — Android restricts '
        'SMS access for apps installed outside the Play Store.\n\n'
        'To unlock it:\n'
        '1. Open AvaTOK’s App info page\n'
        '2. Tap the ⋮ menu → “Allow restricted settings”\n'
        '3. Come back and tap Enable again\n\n'
        'If Android has stopped asking, pick AvaTOK directly under '
        'Default apps → SMS app.',
        style: ADText.preview(),
      ),
      actions: [
        TextButton(
          onPressed: () {
            Navigator.pop(ctx);
            Analytics.capture('avadial_sms_restricted_help_default_apps', const {});
            AvaDialChannel.I.openDefaultAppsSettings();
          },
          child: Text('Default apps', style: ADText.rowName()),
        ),
        AdButton(
          label: 'Open App info',
          variant: AdButtonVariant.teal,
          fontSize: 14,
          onPressed: () {
            Navigator.pop(ctx);
            Analytics.capture('avadial_sms_restricted_help_app_info', const {});
            AvaDialChannel.I.openOwnAppDetails();
          },
        ),
      ],
    ),
  );
}

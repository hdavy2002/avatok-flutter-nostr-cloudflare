import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/brand.dart';
import '../data/repos/config_repo.dart';
import '../demo/theme.dart';

/// Shows the "new version" prompt for [status]. A soft prompt can be dismissed (returns after "Later");
/// a forced one cannot, so the future never completes and the person has to update.
/// Does nothing for [UpdateStatus.none].
Future<void> showUpdatePrompt(BuildContext context, UpdateStatus status) async {
  if (status == UpdateStatus.none) return;
  final forced = status == UpdateStatus.forced;
  await showDialog<void>(
    context: context,
    barrierDismissible: !forced,
    builder: (ctx) => PopScope(
      canPop: !forced,
      child: AlertDialog(
        backgroundColor: C.ivory,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18), side: const BorderSide(color: C.turquoise, width: 3)),
        title: Text(forced ? 'Please update' : 'A new version is ready', style: t(22, color: C.maroon)),
        content: Text(
          forced
              ? 'This version is too old to keep working. Update now to carry on.'
              : 'Update for the newest features and fixes.',
          style: t(16, w: FontWeight.w700, h: 1.35),
        ),
        actions: [
          if (!forced)
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: Text('Later', style: t(16, color: C.muted)),
            ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: C.maroon, minimumSize: const Size(120, 48)),
            onPressed: () async {
              try {
                await launchUrl(
                  Uri.parse('https://play.google.com/store/apps/details?id=${Brand.hfPlayPackageId}'),
                  mode: LaunchMode.externalApplication,
                );
              } catch (_) {
                // Play missing or blocked: the dialog stays so the person can try again
              }
            },
            child: Text('Update', style: t(16, color: C.gold)),
          ),
        ],
      ),
    ),
  );
}

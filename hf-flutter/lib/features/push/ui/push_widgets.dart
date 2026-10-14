import 'package:flutter/material.dart';

import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../data/push_payload.dart';
import 'push_strings.dart';

/// The sheet shown once after sign-in, before the Android notification prompt (spec 2.16).
/// Pops `true` for Allow and `false` for Not now (a swipe or Back pops null, which counts as Not now).
class PushOptInSheet extends StatelessWidget {
  const PushOptInSheet({super.key, required this.host});

  /// Hosts hear about their profile being approved; callers about their favourite host.
  final bool host;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(
          HfSpacing.pageWide,
          0,
          HfSpacing.pageWide,
          HfSpacing.page,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const HfCluster(kind: HfClusterKind.welcome, height: 96),
            const SizedBox(height: 12),
            Text(
              host ? PushStrings.hostTitle : PushStrings.callerTitle,
              style: HfText.of(context, HfText.title),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 8),
            Text(
              PushStrings.body,
              style: HfText.of(context, HfText.body),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(HfSpacing.xxl),
              decoration: BoxDecoration(
                color: HfTint.lavender.bg(context),
                borderRadius: BorderRadius.circular(HfRadius.tile),
              ),
              child: Text(
                'You choose what reaches you. Change notifications any time in Me.',
                style: HfText.note.copyWith(
                  color: HfTint.lavender.ink(context),
                ),
              ),
            ),
            const SizedBox(height: 16),
            HfButton(
              label: PushStrings.allow,
              onPressed: () => Navigator.of(context).pop(true),
            ),
            const SizedBox(height: 4),
            HfButton(
              label: PushStrings.notNow,
              kind: HfButtonKind.text,
              onPressed: () => Navigator.of(context).pop(false),
            ),
          ],
        ),
      ),
    );
  }
}

/// A push that arrived while the app is open: a floating ink banner at the top with "Open" and a close button.
class PushBanner extends StatelessWidget {
  const PushBanner({
    super.key,
    required this.message,
    required this.onOpen,
    required this.onClose,
  });

  final PushMessage message;
  final VoidCallback onOpen;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final top = MediaQuery.paddingOf(context).top;
    final canOpen = message.payload != null;
    return Padding(
      padding: EdgeInsets.fromLTRB(
        HfSpacing.page,
        top + HfSpacing.sm,
        HfSpacing.page,
        0,
      ),
      child: Semantics(
        liveRegion: true,
        container: true,
        child: DecoratedBox(
          decoration: HfSurfaces.card(context, radius: HfRadius.tile),
          child: Material(
            type: MaterialType.transparency,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 4, 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 40,
                    height: 40,
                    margin: const EdgeInsets.only(right: 12),
                    decoration: BoxDecoration(
                      color: HfColors.butter,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: const Icon(
                      Icons.notifications_rounded,
                      color: HfColors.butterDeep,
                      size: 22,
                    ),
                  ),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (message.title.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Text(
                              message.title,
                              style: HfText.of(context, HfText.bodyStrong),
                            ),
                          ),
                        if (message.body.isNotEmpty)
                          Text(
                            message.body,
                            style: HfText.of(context, HfText.note),
                          ),
                        if (canOpen)
                          Align(
                            alignment: Alignment.centerLeft,
                            child: TextButton(
                              style: TextButton.styleFrom(
                                minimumSize: const Size(
                                  HfSpacing.tap,
                                  HfSpacing.tap,
                                ),
                                foregroundColor: Theme.of(context).colorScheme.secondary,
                                textStyle: HfText.button,
                                padding: const EdgeInsets.only(right: 16),
                              ),
                              onPressed: onOpen,
                              child: const Text(PushStrings.bannerOpen),
                            ),
                          ),
                      ],
                    ),
                  ),
                  // No `tooltip:` here: the banner sits above the Navigator, so there is no Overlay for it.
                  Semantics(
                    label: PushStrings.bannerClose,
                    child: IconButton(
                      constraints: const BoxConstraints(
                        minWidth: HfSpacing.tap,
                        minHeight: HfSpacing.tap,
                      ),
                      icon: Icon(
                        Icons.close_rounded,
                        color: Theme.of(context).colorScheme.onSurface,
                      ),
                      onPressed: onClose,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

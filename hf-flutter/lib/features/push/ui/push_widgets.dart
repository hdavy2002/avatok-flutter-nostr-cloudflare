import 'package:flutter/material.dart';

import '../../../core/theme/hf_tokens.dart';
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
        padding: const EdgeInsets.fromLTRB(HfSpacing.page, 12, HfSpacing.page, HfSpacing.page),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 44,
                height: 5,
                decoration: BoxDecoration(color: HfColors.line, borderRadius: BorderRadius.circular(3)),
              ),
            ),
            const SizedBox(height: 20),
            const HfScene(kind: HfSceneKind.welcome, height: 120),
            const SizedBox(height: 16),
            Text(
              host ? PushStrings.hostTitle : PushStrings.callerTitle,
              style: HfText.title,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 8),
            const Text(PushStrings.body, style: HfText.bodyText, textAlign: TextAlign.center),
            const SizedBox(height: 20),
            const HfCard(child: Text('You choose what reaches you. Change notifications any time in Me.', style: HfText.note)),
            const SizedBox(height: 16),
            HfButton(label: PushStrings.allow, onPressed: () => Navigator.of(context).pop(true)),
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

/// A push that arrived while the app is open: a card at the top with "Open" and a close button.
class PushBanner extends StatelessWidget {
  const PushBanner({super.key, required this.message, required this.onOpen, required this.onClose});

  final PushMessage message;
  final VoidCallback onOpen;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final top = MediaQuery.paddingOf(context).top;
    final canOpen = message.payload != null;
    return Padding(
      padding: EdgeInsets.fromLTRB(12, top + 8, 12, 0),
      child: Semantics(
        liveRegion: true,
        container: true,
        child: Material(
          color: HfColors.white,
          elevation: 6,
          shadowColor: const Color(0x3346113E),
          borderRadius: BorderRadius.circular(HfRadius.card),
          child: Container(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(HfRadius.card),
              border: Border.all(color: HfColors.line),
            ),
            padding: const EdgeInsets.fromLTRB(16, 12, 4, 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(padding: const EdgeInsets.all(8), margin: const EdgeInsets.only(right: 10),
                  decoration: BoxDecoration(color: HfColors.butter, borderRadius: BorderRadius.circular(14)),
                  child: const Icon(Icons.notifications_rounded, color: HfColors.ink, size: 24)),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (message.title.isNotEmpty) Text(message.title, style: HfText.bodyStrong),
                      if (message.body.isNotEmpty) Text(message.body, style: HfText.note),
                      if (canOpen)
                        Align(
                          alignment: Alignment.centerLeft,
                          child: TextButton(
                            style: TextButton.styleFrom(
                              minimumSize: const Size(HfSpacing.tap, HfSpacing.tap),
                              foregroundColor: HfColors.orchid,
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
                    constraints: const BoxConstraints(minWidth: HfSpacing.tap, minHeight: HfSpacing.tap),
                    icon: const Icon(Icons.close_rounded, color: HfColors.mauve),
                    onPressed: onClose,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

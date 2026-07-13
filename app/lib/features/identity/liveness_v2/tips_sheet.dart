import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/ui/avatok_dark.dart';

/// "Tips for a good video" bottom sheet (Liveness V2 · plan §8, Agent E P4).
/// Short, actionable zine bullets that map 1:1 to the most common client-side
/// rejections (plan §5A) and server checks (§5B). Opened from the V2 fail screen.
///
/// Pure presentation — no capture state. Fires `liveness_tips_opened` once when
/// shown so the funnel can see how often a failing user reaches for help.
class LivenessTipsSheet {
  static void show(BuildContext context) {
    Analytics.capture('liveness_tips_opened', const {'v': 2});
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AD.overlaySheet,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet)),
        side: BorderSide(color: AD.borderHairline, width: 1),
      ),
      builder: (_) => const _TipsBody(),
    );
  }
}

class _TipsBody extends StatelessWidget {
  const _TipsBody();

  // (icon, tip) — kept short so they read like sticker captions, not paragraphs.
  static final List<(IconData, String)> _tips = [
    (
      PhosphorIcons.sun(PhosphorIconsStyle.bold),
      'Find a well-lit room — daylight or a bright lamp.',
    ),
    (
      PhosphorIcons.lightbulb(PhosphorIconsStyle.bold),
      'Face the light. Don\'t stand with a window or lamp behind you.',
    ),
    (
      PhosphorIcons.userFocus(PhosphorIconsStyle.bold),
      'Take off any mask, sunglasses, or hat covering your face.',
    ),
    (
      PhosphorIcons.user(PhosphorIconsStyle.bold),
      'Make sure only you are in the frame — no one behind you.',
    ),
    (
      PhosphorIcons.deviceMobile(PhosphorIconsStyle.bold),
      'Hold your phone at eye level, an arm\'s length away.',
    ),
    (
      PhosphorIcons.eye(PhosphorIconsStyle.bold),
      'Keep both eyes open and look straight at the camera.',
    ),
    (
      PhosphorIcons.microphone(PhosphorIconsStyle.bold),
      'Speak the phrase clearly and a little louder than usual.',
    ),
  ];

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 12, 24, 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 46,
                height: 5,
                decoration: BoxDecoration(
                  color: AD.borderControl,
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
            ),
            const SizedBox(height: 18),
            Text('Tips for a good video',
                style: ADText.appTitle().copyWith(fontSize: 24)),
            const SizedBox(height: 6),
            Text('A few seconds of setup makes the check pass first time.',
                style: TextStyle(
                  fontFamily: ADText.family,
                  fontWeight: FontWeight.w600,
                  fontSize: 14,
                  height: 1.42,
                  color: AD.textSecondary,
                )),
            const SizedBox(height: 18),
            for (final t in _tips) ...[
              Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Container(
                  width: 34,
                  height: 34,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: AD.primaryBadge,
                    border: Border.all(color: AD.borderControl, width: 1),
                  ),
                  child: PhosphorIcon(t.$1, size: 18, color: AD.textPrimary),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(t.$2,
                        style: TextStyle(
                          fontFamily: ADText.family,
                          fontWeight: FontWeight.w600,
                          fontSize: 14,
                          height: 1.42,
                          color: AD.textSecondary,
                        )),
                  ),
                ),
              ]),
              const SizedBox(height: 14),
            ],
            const SizedBox(height: 6),
            AdButton(
              label: 'Got it',
              fullWidth: true,
              onPressed: () => Navigator.of(context).pop(),
            ),
          ],
        ),
      ),
    );
  }
}

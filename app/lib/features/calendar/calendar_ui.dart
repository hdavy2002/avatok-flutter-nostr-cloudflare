// Shared styling for the calendar screens. The diary, the day editor and the
// availability settings screen used to live in one file; splitting them keeps
// these helpers in ONE place so the audit fixes cannot drift apart again.
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import 'calendar_logic.dart';

TextStyle calTitle(double size) => ADText.threadName()
    .copyWith(fontSize: size, height: 1.1, letterSpacing: -0.2);

TextStyle calSub(double size, {Color c = AD.textSecondary}) =>
    ADText.preview(c: c).copyWith(fontSize: size, height: 1.42);

TextStyle calValue(double size, {FontWeight w = FontWeight.w600}) =>
    ADText.rowName().copyWith(fontSize: size, fontWeight: w);

TextStyle get calLinkStyle => ADText.rowName(c: Msg.accent).copyWith(fontSize: 13);

Widget calendarMessageCard(String message, IconData icon, Color color) =>
    ZineCard(
      radius: Msg.rMd,
      boxShadow: Msg.none,
      padding: const EdgeInsets.all(Msg.s3),
      borderColor: color,
      child: Row(children: [
        PhosphorIcon(icon, size: 20, color: color),
        const SizedBox(width: Msg.s2),
        Expanded(child: Text(message, style: calSub(13, c: color))),
      ]),
    );

/// Maps the widget-free status hint onto the design-system sticker. Unknown
/// statuses stay neutral — never green.
ZineSticker calendarStatusSticker(String label, String status) => ZineSticker(
      label,
      kind: switch (statusStickerHint(status)) {
        ZineStickerKindHint.ok => ZineStickerKind.ok,
        ZineStickerKindHint.no => ZineStickerKind.no,
        ZineStickerKindHint.hint => ZineStickerKind.hint,
        ZineStickerKindHint.plain => ZineStickerKind.plain,
      },
    );

ZineSticker calendarReadinessSticker(GcalReadiness readiness) => ZineSticker(
      readiness.label,
      kind: switch (readiness.state) {
        GcalState.ready => ZineStickerKind.ok,
        GcalState.needsAttention => ZineStickerKind.no,
        GcalState.notConnected => ZineStickerKind.hint,
        GcalState.syncing => ZineStickerKind.hint,
        GcalState.checking => ZineStickerKind.plain,
        GcalState.unknown => ZineStickerKind.hint,
      },
    );

/// Small "Times in <IANA zone>" line. Every card and heading in the diary uses
/// the schedule timezone, so a travelling creator never has to guess which
/// clock a row belongs to.
Widget calendarTimezoneNote(String? timezone, {String? deviceNote}) => Row(
      children: [
        PhosphorIcon(PhosphorIcons.globeHemisphereWest(PhosphorIconsStyle.regular),
            size: 15, color: AD.textSecondary),
        const SizedBox(width: Msg.s1),
        Flexible(
          child: Text(
            deviceNote == null
                ? timezoneLabel(timezone)
                : '${timezoneLabel(timezone)} · $deviceNote',
            style: ADText.statCaption(c: AD.textSecondary),
          ),
        ),
      ],
    );

/// Icon-only action with the 44×44 minimum touch target (accessibility): the
/// bare 18px glyphs used before were far below the platform minimum.
Widget calendarIconAction({
  required IconData icon,
  required Color color,
  required VoidCallback onTap,
  String tooltip = 'Remove',
}) =>
    Tooltip(
      message: tooltip,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: SizedBox(
          width: 44,
          height: 44,
          child: Center(child: PhosphorIcon(icon, size: 18, color: color)),
        ),
      ),
    );

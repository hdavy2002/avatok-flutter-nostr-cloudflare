import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';

/// The private GUARDIAN WARNING UI affordance (Phase 8 — Safety).
///
/// Guardian posts its warnings as `ava_private` messages (only the at-risk user's
/// device ever receives them). The FROZEN `chat_thread.dart` already renders those
/// as lilac "AVA · PRIVATE" bubbles showing the warning text — that path needs no
/// change. This file is the ADDITIVE, RICHER surface a chat screen can OPT to show
/// on top of that bubble: a prominent tappable warning card and a detail sheet with
/// concrete safety actions (block / report / dismiss). It is purely presentational
/// + callback-driven — it does NOT touch the chat pipeline or post anything itself.
///
/// A guardian `ava_private` message carries (in its JSON body envelope):
///   { t:'ava_private', text:<warning>, source:'guardian',
///     meta:{ guardian:true, category:'scam'|'spam'|'grooming'|..., severity:int } }
/// [GuardianWarningInfo.fromMeta] parses that meta so a host screen can build the
/// card; if a screen only has the bubble text it can still construct one with
/// [GuardianWarningInfo.text].

/// The kinds of safety signal Guardian raises.
///
/// G0: 'deepfake' has been REMOVED — media/deepfake scanning is deleted and the
/// server never emits it. A legacy 'deepfake' meta on an old message parses to
/// [GuardianCategory.unknown] (generic Ava-safety rendering).
enum GuardianCategory { scam, spam, grooming, unknown }

GuardianCategory _categoryFromWire(String? s) => switch (s) {
      'scam' => GuardianCategory.scam,
      'spam' => GuardianCategory.spam,
      'grooming' => GuardianCategory.grooming,
      // 'deepfake' (legacy) falls through to unknown.
      _ => GuardianCategory.unknown,
    };

/// Parsed payload for one Guardian warning, built from an `ava_private` body's
/// `meta` block (or directly from a warning string).
@immutable
class GuardianWarningInfo {
  final String text;
  final GuardianCategory category;
  final int severity; // 1 low … 3 high (0 unknown)

  const GuardianWarningInfo({
    required this.text,
    this.category = GuardianCategory.unknown,
    this.severity = 0,
  });

  /// Build from the `ava_private` envelope (the decoded message body map).
  factory GuardianWarningInfo.fromEnvelope(Map<dynamic, dynamic> env) {
    final text = (env['text'] ?? env['body'] ?? '').toString();
    final meta = env['meta'];
    if (meta is Map) {
      return GuardianWarningInfo(
        text: text,
        category: _categoryFromWire(meta['category']?.toString()),
        severity: (meta['severity'] is num) ? (meta['severity'] as num).toInt() : 0,
      );
    }
    return GuardianWarningInfo(text: text);
  }

  /// True when this is actually a Guardian-sourced warning envelope.
  static bool isGuardian(Map<dynamic, dynamic> env) {
    if (env['source'] == 'guardian') return true;
    final meta = env['meta'];
    return meta is Map && meta['guardian'] == true;
  }

  String get title => switch (category) {
        GuardianCategory.grooming => 'Safety warning',
        GuardianCategory.scam => 'Possible scam',
        GuardianCategory.spam => 'Possible spam',
        GuardianCategory.unknown => 'Ava safety',
      };

  IconData get icon => switch (category) {
        GuardianCategory.grooming => PhosphorIcons.warning(PhosphorIconsStyle.fill),
        GuardianCategory.scam => PhosphorIcons.warningCircle(PhosphorIconsStyle.fill),
        GuardianCategory.spam => PhosphorIcons.megaphone(PhosphorIconsStyle.fill),
        GuardianCategory.unknown => PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill),
      };

  /// High-severity (or grooming) warnings use the alert red; lower ones use the
  /// single brand accent so we don't over-alarm on a spam hint.
  ///
  /// [UI-ZINE-DARK-1] Was `Zine.coral` / `Zine.lilac`. The pale lilac was a
  /// near-WHITE poster fill that also served as the card's TEXT colour — on the
  /// near-black card that pairing was unreadable either way round. The dark
  /// system spends colour on exactly two things here: `Msg.error` (red) and
  /// `Msg.accent`, both of which clear 4.5:1 on `AD.card`.
  Color get accent => (severity >= 3 || category == GuardianCategory.grooming)
      ? Msg.error
      : Msg.accent;
}

/// A compact, prominent warning CARD. Drop it just above/below the private bubble
/// in a chat surface (a host screen opts in). Tapping it opens the detail sheet.
class GuardianWarningCard extends StatelessWidget {
  final GuardianWarningInfo info;

  /// Optional safety actions. When provided they appear in the detail sheet.
  final Future<void> Function()? onBlock;
  final Future<void> Function()? onReport;
  final VoidCallback? onDismiss;

  const GuardianWarningCard({
    super.key,
    required this.info,
    this.onBlock,
    this.onReport,
    this.onDismiss,
  });

  @override
  Widget build(BuildContext context) {
    final accent = info.accent;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => GuardianWarningSheet.show(context,
          info: info, onBlock: onBlock, onReport: onReport, onDismiss: onDismiss),
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: Msg.s1),
        padding: const EdgeInsets.all(Msg.s3),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: Msg.brMd,
          border: Border.all(color: accent, width: 1),
          boxShadow: Msg.none,
        ),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          ZineIconBadge(icon: info.icon, color: accent, size: 34),
          const SizedBox(width: Msg.s3),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Flexible(
                    child: Text(info.title,
                        style: ADText.rowName().copyWith(fontSize: 14))),
                const SizedBox(width: Msg.s1),
                _privateTag(),
              ]),
              const SizedBox(height: Msg.s1),
              Text(info.text,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: ADText.preview(c: AD.textSecondary)
                      .copyWith(fontSize: 12)),
              const SizedBox(height: Msg.s1),
              Text('Tap for safety options',
                  style: ADText.tabLabel(c: accent).copyWith(fontSize: 11)),
            ]),
          ),
        ]),
      ),
    );
  }

  // A tag IS one of the shapes Msg.rPill is reserved for.
  //
  // [UI-ZINE-DARK-1] FILL/INK COLLAPSE CAUGHT: this pill was a translucent pale
  // lilac carrying `Zine.ink` (near-BLACK) text. Mapping the ink straight to
  // AD.textPrimary would have put white on a near-white wash; mapping the fill
  // alone would have left black text on a near-black card. Both sides moved:
  // neutral raised surface + secondary ink.
  static Widget _privateTag() => Container(
        padding: const EdgeInsets.symmetric(horizontal: Msg.s1, vertical: 2),
        decoration: BoxDecoration(
          color: AD.cardHover,
          borderRadius: Msg.brPill,
          border: Border.all(color: AD.borderHairline, width: 1),
        ),
        child: Text('Only you',
            style: ADText.statCaption(c: AD.textSecondary).copyWith(fontSize: 10)),
      );
}

/// The detail sheet: full warning text + safety actions. Actions are optional
/// callbacks the host wires to the existing block/report flows; absent ones are
/// hidden. This sheet performs NO destructive action itself.
class GuardianWarningSheet extends StatelessWidget {
  final GuardianWarningInfo info;
  final Future<void> Function()? onBlock;
  final Future<void> Function()? onReport;
  final VoidCallback? onDismiss;

  const GuardianWarningSheet({
    super.key,
    required this.info,
    this.onBlock,
    this.onReport,
    this.onDismiss,
  });

  static Future<void> show(
    BuildContext context, {
    required GuardianWarningInfo info,
    Future<void> Function()? onBlock,
    Future<void> Function()? onReport,
    VoidCallback? onDismiss,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      backgroundColor: AD.overlaySheet,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: Msg.brSheetTop),
      builder: (_) => GuardianWarningSheet(
          info: info, onBlock: onBlock, onReport: onReport, onDismiss: onDismiss),
    );
  }

  @override
  Widget build(BuildContext context) {
    final accent = info.accent;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            ZineIconBadge(icon: info.icon, color: accent, size: 40),
            const SizedBox(width: Msg.s3),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(info.title,
                    style: ADText.threadName().copyWith(fontSize: 18)),
                Text('From Ava — only you can see this',
                    style: ADText.preview(c: AD.textSecondary)
                        .copyWith(fontSize: 12)),
              ]),
            ),
          ]),
          const SizedBox(height: Msg.s4),
          Container(
            padding: const EdgeInsets.all(Msg.s3),
            decoration: BoxDecoration(
              color: AD.card,
              borderRadius: Msg.brMd,
              border: Border.all(color: AD.borderHairline, width: 1),
            ),
            child: Text(info.text,
                style: ADText.bubbleBody(c: AD.textPrimary)
                    .copyWith(fontSize: 14)),
          ),
          const SizedBox(height: Msg.s4),
          if (onBlock != null)
            Padding(
              padding: const EdgeInsets.only(bottom: Msg.s2),
              child: ZineButton(
                label: 'Block this person',
                variant: ZineButtonVariant.coral,
                fullWidth: true,
                icon: PhosphorIcons.prohibit(PhosphorIconsStyle.bold),
                trailingIcon: false,
                onPressed: () async {
                  Navigator.pop(context);
                  await onBlock!();
                },
              ),
            ),
          if (onReport != null)
            Padding(
              padding: const EdgeInsets.only(bottom: Msg.s2),
              child: ZineButton(
                label: 'Report to AvaTOK',
                variant: ZineButtonVariant.blue,
                fullWidth: true,
                icon: PhosphorIcons.flag(PhosphorIconsStyle.bold),
                trailingIcon: false,
                onPressed: () async {
                  Navigator.pop(context);
                  await onReport!();
                },
              ),
            ),
          TextButton(
            onPressed: () {
              Navigator.pop(context);
              onDismiss?.call();
            },
            child: Text('Dismiss',
                style: ADText.rowName(c: AD.textSecondary)
                    .copyWith(fontSize: 14)),
          ),
        ]),
      ),
    );
  }
}

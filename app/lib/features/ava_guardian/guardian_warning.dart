import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/zine.dart';
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
///     meta:{ guardian:true, category:'scam'|'spam'|'grooming'|'deepfake', severity:int } }
/// [GuardianWarningInfo.fromMeta] parses that meta so a host screen can build the
/// card; if a screen only has the bubble text it can still construct one with
/// [GuardianWarningInfo.text].

/// The kinds of safety signal Guardian raises.
enum GuardianCategory { scam, spam, grooming, deepfake, unknown }

GuardianCategory _categoryFromWire(String? s) => switch (s) {
      'scam' => GuardianCategory.scam,
      'spam' => GuardianCategory.spam,
      'grooming' => GuardianCategory.grooming,
      'deepfake' => GuardianCategory.deepfake,
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
        GuardianCategory.deepfake => 'This image may be fake',
        GuardianCategory.unknown => 'Ava safety',
      };

  IconData get icon => switch (category) {
        GuardianCategory.grooming => PhosphorIcons.warning(PhosphorIconsStyle.fill),
        GuardianCategory.scam => PhosphorIcons.warningCircle(PhosphorIconsStyle.fill),
        GuardianCategory.spam => PhosphorIcons.megaphone(PhosphorIconsStyle.fill),
        GuardianCategory.deepfake => PhosphorIcons.imageBroken(PhosphorIconsStyle.fill),
        GuardianCategory.unknown => PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill),
      };

  /// High-severity (or grooming) warnings use the alert/coral accent; lower ones
  /// use the calmer lilac so we don't over-alarm on a spam hint.
  Color get accent =>
      (severity >= 3 || category == GuardianCategory.grooming) ? Zine.coral : Zine.lilac;
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
        margin: const EdgeInsets.symmetric(vertical: 6),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Zine.paper,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: accent, width: 2),
          boxShadow: Zine.shadowXs,
        ),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          ZineIconBadge(icon: info.icon, color: accent, size: 34),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Flexible(child: Text(info.title, style: ZineText.value(size: 13.5))),
                const SizedBox(width: 6),
                _privateTag(),
              ]),
              const SizedBox(height: 3),
              Text(info.text, maxLines: 3, overflow: TextOverflow.ellipsis, style: ZineText.sub(size: 12)),
              const SizedBox(height: 4),
              Text('Tap for safety options', style: ZineText.tag(size: 10.5, color: accent)),
            ]),
          ),
        ]),
      ),
    );
  }

  static Widget _privateTag() => Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        decoration: BoxDecoration(
          color: Zine.lilac.withValues(alpha: 0.18),
          borderRadius: BorderRadius.circular(100),
        ),
        child: Text('ONLY YOU', style: ZineText.tag(size: 8.5, color: Zine.ink)),
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
      backgroundColor: Zine.paper,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
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
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(info.title, style: ZineText.cardTitle(size: 18)),
                Text('From Ava — only you can see this', style: ZineText.sub(size: 11.5)),
              ]),
            ),
          ]),
          const SizedBox(height: 14),
          Container(
            padding: const EdgeInsets.all(13),
            decoration: BoxDecoration(
              color: Zine.paper2,
              borderRadius: BorderRadius.circular(12),
              border: Zine.border,
            ),
            child: Text(info.text, style: ZineText.sub(size: 13.5)),
          ),
          const SizedBox(height: 16),
          if (onBlock != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
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
              padding: const EdgeInsets.only(bottom: 8),
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
            child: Text('Dismiss', style: ZineText.link(size: 14, color: Zine.inkSoft)),
          ),
        ]),
      ),
    );
  }
}

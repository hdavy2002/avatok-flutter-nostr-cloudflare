import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';

/// AvaLaneBubble (Ava Copilot Phase A — plan §5 D3 / §6).
///
/// Renders a PRIVATE-lane Ava message (`kind:"ava"` + `lane:"private"`): the
/// copilot's Moments, doc-action results and Guardian warnings that were written
/// only to THIS user's inbox — the other participant never receives the row.
///
/// Visuals are fixed by owner decision D3: soft orchid fill `#E6D7F5` with
/// `#8E4EC6` accents, an "Ava ✨" author label, and a small info affordance that
/// opens a disclosure sheet ("I'm Ava, your AI assistant. Only you can see this
/// conversation."). A Guardian variant (`body.guardian` present) keeps the same
/// bubble but adds a safety accent (shield + coral edge) so warnings read as
/// warnings without leaving the one private lane (D19).
///
/// The widget is self-contained so chat_thread.dart can drop it into its bubble
/// switch with a one-line call; gestures (long-press menu etc.) are the caller's
/// responsibility — wrap it in a GestureDetector like any other bubble.
class AvaLaneBubble extends StatelessWidget {
  /// D3 palette — the fixed Ava-lane colours (do not theme these away; the
  /// colour IS the disclosure that this bubble is private Ava, not a person).
  static const Color fill = Color(0xFFE6D7F5); // soft orchid
  static const Color accent = Color(0xFF8E4EC6); // orchid accents

  /// Safety accent for the Guardian variant.
  static const Color safety = Color(0xFFD64545);

  /// The message body text.
  final String text;

  /// Rendered timestamp (e.g. "14:02"), shown under the body when non-empty.
  final String time;

  /// Guardian payload (`body.guardian`, e.g. {severity, category}) — when
  /// present the bubble renders the safety variant.
  final Map<String, dynamic>? guardian;

  const AvaLaneBubble({
    super.key,
    required this.text,
    this.time = '',
    this.guardian,
  });

  bool get _isGuardian => guardian != null && guardian!.isNotEmpty;

  @override
  Widget build(BuildContext context) {
    final edge = _isGuardian ? safety : accent;
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: Msg.s2),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        constraints: BoxConstraints(
            maxWidth: MediaQuery.of(context).size.width * 0.78),
        decoration: BoxDecoration(
          color: fill,
          border: Border.all(color: AD.borderControl, width: 1),
          boxShadow: Msg.none,
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(16),
            topRight: Radius.circular(16),
            bottomLeft: Radius.circular(4),
            bottomRight: Radius.circular(16),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            // Author row: "Ava" + sparkle + (guardian shield) + info affordance.
            Padding(
              padding: const EdgeInsets.only(bottom: 3),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Text('Ava',
                    style: ADText.tabLabel(c: edge).copyWith(fontSize: 11)),
                const SizedBox(width: Msg.s1),
                PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
                    size: 11, color: edge),
                if (_isGuardian) ...[
                  const SizedBox(width: Msg.s1),
                  PhosphorIcon(PhosphorIcons.warning(PhosphorIconsStyle.fill),
                      size: 12, color: safety),
                  const SizedBox(width: Msg.s1),
                  Text('Safety',
                      style: ADText.tabLabel(c: safety).copyWith(fontSize: 11)),
                ],
                const SizedBox(width: Msg.s1),
                GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => showAvaLaneInfo(context),
                  child: PhosphorIcon(
                      PhosphorIcons.info(PhosphorIconsStyle.regular),
                      size: 13, color: edge),
                ),
              ]),
            ),
            // Guardian variant: a slim safety strip above the body.
            if (_isGuardian)
              Container(
                margin: const EdgeInsets.only(bottom: 6),
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: safety.withValues(alpha: 0.10),
                  borderRadius: Msg.brSm,
                  border: Border.all(color: safety, width: 1.2),
                ),
                child: Text(
                  _guardianLabel(),
                  // Dark ink: this strip sits on the PALE orchid bubble, not on
                  // the near-black page.
                  style: ADText.statCaption(c: safety),
                ),
              ),
            // [UI-ZINE-DARK-1] `Zine.ink` here was dark text on the PALE orchid
            // bubble fill — mapping it to AD.textPrimary (white) would have made
            // the message body invisible. AD.bubbleInInk is the ink the dark
            // system already uses for its pale lilac incoming bubble.
            Text(text, style: ADText.bubbleBody(c: AD.bubbleInInk)),
            if (time.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 3),
                child: Text(time, style: ADText.bubbleMeta(c: edge)),
              ),
          ],
        ),
      ),
    );
  }

  String _guardianLabel() {
    final cat = (guardian?['category'] ?? '').toString().trim();
    return cat.isEmpty ? 'Heads-up from Ava' : 'Heads-up from Ava · $cat';
  }
}

/// The Ava-lane disclosure sheet (D3 copy, verbatim). Also reachable from any
/// other Ava-lane affordance that needs the same explanation.
void showAvaLaneInfo(BuildContext context) {
  showModalBottomSheet<void>(
    context: context,
    backgroundColor: AD.overlaySheet,
    shape: const RoundedRectangleBorder(borderRadius: Msg.brSheetTop),
    builder: (ctx) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, Msg.s5),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Container(
              width: 36, height: 36, alignment: Alignment.center,
              decoration: BoxDecoration(
                color: AvaLaneBubble.fill,
                shape: BoxShape.circle,
                border: Border.all(color: AD.borderControl, width: 1),
              ),
              child: PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
                  size: 18, color: AvaLaneBubble.accent),
            ),
            const SizedBox(width: Msg.s3),
            Text('Ava', style: ADText.threadName().copyWith(fontSize: 18)),
            const SizedBox(width: Msg.s1),
            PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
                size: 15, color: AvaLaneBubble.accent),
          ]),
          const SizedBox(height: Msg.s4),
          // Sheet copy sits on AD.overlaySheet (near-black) — white ink here,
          // unlike the bubble body above which sits on the pale orchid fill.
          Text(
            "I'm Ava, your AI assistant. Only you can see this conversation.",
            style: ADText.bubbleBody(c: AD.textPrimary),
          ),
          const SizedBox(height: Msg.s2),
          Text(
            'Ava replies here in your private lane — they are never sent to the '
            'other person in this chat.',
            style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 13),
          ),
        ]),
      ),
    ),
  );
}

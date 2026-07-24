import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/brain_recall.dart';
import '../../core/ui/avatok_dark.dart';

/// Citation/source chips — [AVABRAIN-CLIENT-MEM-1] (Product Bible §P1.4).
///
/// Renders a row of small chips for a recall's [BrainCitation]s: a source
/// domain (e.g. "files", "calls", "msg_content") and, on tap, the snippet that
/// grounded the answer. A low-confidence citation (§4.2, confidence < 0.55)
/// gets a hedged/dashed style so the user can see at a glance which sources
/// are "Ava thinks" vs. a solid recall hit.
///
/// STANDALONE WIDGET — intentionally NOT wired into `companion_thread.dart` or
/// `chat_thread.dart` (those files belong to other agents). Integration note
/// for whoever owns those screens:
///
/// ```dart
/// // 1) After a turn, derive citations from the same hits used for the prompt:
/// final citations = citationsFromHits(hits); // from core/brain_recall.dart
/// // 2) Render them under the assistant bubble:
/// if (citations.isNotEmpty) SourceChipsRow(citations: citations),
/// ```
///
/// That's the entire integration surface — this file owns layout/style only.
class SourceChipsRow extends StatelessWidget {
  final List<BrainCitation> citations;
  /// Called when the user taps a chip (e.g. to open the source or show the
  /// snippet in a sheet). If null, tapping a chip just shows the snippet
  /// inline via a lightweight tooltip/expand.
  final void Function(BrainCitation citation)? onTap;

  const SourceChipsRow({super.key, required this.citations, this.onTap});

  @override
  Widget build(BuildContext context) {
    if (citations.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Wrap(
        spacing: 6,
        runSpacing: 6,
        children: [
          for (final c in citations) _SourceChip(citation: c, onTap: onTap),
        ],
      ),
    );
  }
}

class _SourceChip extends StatelessWidget {
  final BrainCitation citation;
  final void Function(BrainCitation citation)? onTap;
  const _SourceChip({required this.citation, this.onTap});

  @override
  Widget build(BuildContext context) {
    final hedged = citation.isLowConfidence;
    final label = citation.sourceDomain.isEmpty ? 'source' : citation.sourceDomain;
    final chip = Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: hedged ? Colors.transparent : AD.card,
        borderRadius: BorderRadius.circular(100),
        border: Border.all(
          color: hedged ? AD.textFaint : AD.borderControl,
          width: 1,
          style: BorderStyle.solid,
        ),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        PhosphorIcon(
          hedged
              ? PhosphorIcons.question(PhosphorIconsStyle.bold)
              : PhosphorIcons.linkSimple(PhosphorIconsStyle.bold),
          size: 11,
          color: hedged ? AD.textTertiary : AD.iconSearch,
        ),
        const SizedBox(width: 4),
        Text(
          label,
          style: ADText.statCaption(c: hedged ? AD.textTertiary : AD.textSecondary),
        ),
      ]),
    );
    return Tooltip(
      message: hedged
          ? 'Ava found a note suggesting this — low confidence.\n${citation.snippet}'
          : citation.snippet,
      textStyle: TextStyle(fontFamily: ADText.family, fontSize: 11.5, color: AD.textPrimary),
      decoration: BoxDecoration(color: AD.popover, borderRadius: BorderRadius.circular(8),
          border: Border.all(color: AD.borderControl, width: 1)),
      child: GestureDetector(
        onTap: onTap == null ? null : () => onTap!(citation),
        behavior: HitTestBehavior.opaque,
        child: chip,
      ),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar.dart';
import '../../core/avavoice_api.dart';
import '../../core/theme.dart';
import '../../core/ui/zine_widgets.dart';
import '../explore/widgets.dart' show CoverImage;

/// AvaVoice brand accent — AI/magic = lilac (design system §AI).
const Color kAvaVoicePurple = Zine.lilac;

String fmtWhenMs(int ms) {
  if (ms <= 0) return '';
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  final now = DateTime.now();
  final sameDay = d.year == now.year && d.month == now.month && d.day == now.day;
  final tomorrow = now.add(const Duration(days: 1));
  final isTomorrow = d.year == tomorrow.year && d.month == tomorrow.month && d.day == tomorrow.day;
  final hh = d.hour.toString().padLeft(2, '0');
  final mm = d.minute.toString().padLeft(2, '0');
  if (sameDay) return 'Today $hh:$mm';
  if (isTomorrow) return 'Tomorrow $hh:$mm';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return '${months[d.month - 1]} ${d.day}, $hh:$mm';
}

/// "Call Now" / "Agent Busy" live chip. busy = coral (white text), free = mint.
class AvailabilityChip extends StatelessWidget {
  final bool busy;
  final bool compact;
  const AvailabilityChip({super.key, required this.busy, this.compact = false});
  @override
  Widget build(BuildContext context) {
    final fill = busy ? Zine.coral : Zine.mint;
    final fg = busy ? Colors.white : Zine.ink;
    final dot = busy ? Colors.white : Zine.mintInk;
    return Container(
      padding: EdgeInsets.symmetric(horizontal: compact ? 8 : 11, vertical: compact ? 3 : 5),
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(100),
        border: Border.all(color: Zine.ink, width: Zine.bw),
        boxShadow: Zine.shadowXs,
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Container(width: 7, height: 7, decoration: BoxDecoration(color: dot, shape: BoxShape.circle)),
        const SizedBox(width: 5),
        Text(busy ? 'AGENT BUSY' : 'CALL NOW',
            style: ZineText.tag(size: compact ? 10 : 11.5, color: fg)),
      ]),
    );
  }
}

class VisionBadge extends StatelessWidget {
  const VisionBadge({super.key});
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          color: Zine.lilac,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: Zine.ink, width: Zine.bw),
          boxShadow: Zine.shadowXs,
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(PhosphorIcons.eye(PhosphorIconsStyle.bold), size: 12, color: Zine.ink),
          const SizedBox(width: 4),
          Text('VISION', style: ZineText.tag(size: 10, color: Zine.ink)),
        ]),
      );
}

class FreeBadge extends StatelessWidget {
  const FreeBadge({super.key});
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          color: Zine.mint,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: Zine.ink, width: Zine.bw),
          boxShadow: Zine.shadowXs,
        ),
        child: Text('FREE', style: ZineText.tag(size: 10, color: Zine.ink)),
      );
}

/// Marketplace agent card.
class AgentCard extends StatelessWidget {
  final VoiceAgent agent;
  final VoidCallback onTap;
  const AgentCard({super.key, required this.agent, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return ZinePressable(
      onTap: onTap,
      radius: BorderRadius.circular(Zine.rSm),
      boxShadow: Zine.shadowXs,
      padding: const EdgeInsets.all(12),
      child: Row(children: [
        // Listing photo (first of 1–5) when present; identicon fallback.
        if (agent.images.isNotEmpty)
          CoverImage(url: agent.images.first, seed: agent.id.hashCode, width: 52, height: 52,
              radius: BorderRadius.circular(12))
        else
          Avatar(seed: agent.id, name: agent.name, size: 52, avatarUrl: agent.avatarUrl),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text(agent.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ZineText.value(size: 15, weight: FontWeight.w800))),
              if (agent.activeCalls != null) AvailabilityChip(busy: agent.busy, compact: true),
            ]),
            const SizedBox(height: 2),
            Text(agent.role, maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ZineText.sub(size: 12.5)),
            const SizedBox(height: 7),
            Row(children: [
              if (agent.isFreeForCallers) ...[const FreeBadge(), const SizedBox(width: 6)],
              if (agent.visionEnabled) ...[const VisionBadge(), const SizedBox(width: 6)],
              Flexible(child: Text(
                agent.isFreeForCallers
                    ? 'Up to ${agent.sessionLimitMin} min'
                    : '${agent.rateLabel} · up to ${agent.sessionLimitMin} min',
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ZineText.sub(size: 11.5),
              )),
            ]),
          ]),
        ),
      ]),
    );
  }
}

/// Searchable language picker (bottom sheet). Returns a BCP-47 code or null.
Future<String?> pickLanguage(BuildContext context, {String? selected}) {
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Zine.paper,
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(Zine.r))),
    builder: (s) => _LanguageSheet(selected: selected),
  );
}

class _LanguageSheet extends StatefulWidget {
  final String? selected;
  const _LanguageSheet({this.selected});
  @override
  State<_LanguageSheet> createState() => _LanguageSheetState();
}

class _LanguageSheetState extends State<_LanguageSheet> {
  String _q = '';
  @override
  Widget build(BuildContext context) {
    final items = kVoiceLanguages
        .where((e) => _q.isEmpty || e.value.toLowerCase().contains(_q.toLowerCase()))
        .toList();
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: SizedBox(
          height: MediaQuery.of(context).size.height * .72,
          child: Column(children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 18, 20, 6),
              child: Text('Which language should the agent speak?', style: ZineText.cardTitle()),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
              child: ZineField(
                hint: 'Search languages',
                leadIcon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
                onChanged: (v) => setState(() => _q = v),
              ),
            ),
            Expanded(
              child: ListView.builder(
                itemCount: items.length,
                itemBuilder: (_, i) {
                  final e = items[i];
                  final sel = e.key == widget.selected;
                  return ListTile(
                    dense: true,
                    leading: PhosphorIcon(
                        sel ? PhosphorIcons.checkCircle(PhosphorIconsStyle.fill) : PhosphorIcons.circle(PhosphorIconsStyle.bold),
                        color: sel ? Zine.lilac : Zine.inkMute, size: 22),
                    title: Text(e.value,
                        style: ZineText.value(size: 14.5, weight: sel ? FontWeight.w900 : FontWeight.w700)),
                    onTap: () => Navigator.pop(context, e.key),
                  );
                },
              ),
            ),
          ]),
        ),
      ),
    );
  }
}

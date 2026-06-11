import 'package:flutter/material.dart';

import '../../core/avatar.dart';
import '../../core/avavoice_api.dart';
import '../../core/theme.dart';
import '../explore/widgets.dart' show CoverImage;

/// AvaVoice brand accent (matches core/apps.dart tile color).
const Color kAvaVoicePurple = Color(0xFFA06AF0);

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

/// "Call Now" / "Agent Busy" live chip.
class AvailabilityChip extends StatelessWidget {
  final bool busy;
  final bool compact;
  const AvailabilityChip({super.key, required this.busy, this.compact = false});
  @override
  Widget build(BuildContext context) {
    final color = busy ? AvaColors.coral : AvaColors.success;
    return Container(
      padding: EdgeInsets.symmetric(horizontal: compact ? 7 : 10, vertical: compact ? 2 : 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: .12),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Container(width: 7, height: 7,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
        const SizedBox(width: 5),
        Text(busy ? 'Agent busy' : 'Call now',
            style: TextStyle(fontSize: compact ? 10 : 12, fontWeight: FontWeight.w800, color: color)),
      ]),
    );
  }
}

class VisionBadge extends StatelessWidget {
  const VisionBadge({super.key});
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
        decoration: BoxDecoration(
            color: kAvaVoicePurple.withValues(alpha: .12),
            borderRadius: BorderRadius.circular(8)),
        child: const Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(Icons.visibility_outlined, size: 12, color: kAvaVoicePurple),
          SizedBox(width: 3),
          Text('Vision', style: TextStyle(fontSize: 10, fontWeight: FontWeight.w800, color: kAvaVoicePurple)),
        ]),
      );
}

class FreeBadge extends StatelessWidget {
  const FreeBadge({super.key});
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
        decoration: BoxDecoration(
            color: AvaColors.success.withValues(alpha: .12),
            borderRadius: BorderRadius.circular(8)),
        child: const Text('FREE',
            style: TextStyle(fontSize: 10, fontWeight: FontWeight.w800, color: AvaColors.success)),
      );
}

/// Marketplace agent card.
class AgentCard extends StatelessWidget {
  final VoiceAgent agent;
  final VoidCallback onTap;
  const AgentCard({super.key, required this.agent, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(16),
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          border: Border.all(color: AvaColors.line),
          borderRadius: BorderRadius.circular(16),
        ),
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
                    style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15))),
                if (agent.activeCalls != null) AvailabilityChip(busy: agent.busy, compact: true),
              ]),
              const SizedBox(height: 2),
              Text(agent.role, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12.5, color: AvaColors.sub)),
              const SizedBox(height: 6),
              Row(children: [
                if (agent.isFreeForCallers) ...[const FreeBadge(), const SizedBox(width: 6)],
                if (agent.visionEnabled) ...[const VisionBadge(), const SizedBox(width: 6)],
                Flexible(child: Text(
                  agent.isFreeForCallers
                      ? 'Up to ${agent.sessionLimitMin} min'
                      : '${agent.rateLabel} · up to ${agent.sessionLimitMin} min',
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 11.5, color: AvaColors.sub, fontWeight: FontWeight.w600),
                )),
              ]),
            ]),
          ),
        ]),
      ),
    );
  }
}

/// Searchable language picker (bottom sheet). Returns a BCP-47 code or null.
Future<String?> pickLanguage(BuildContext context, {String? selected}) {
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
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
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 16, 20, 4),
              child: Text('Which language should the agent speak?',
                  style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
              child: TextField(
                autofocus: false,
                decoration: InputDecoration(
                  hintText: 'Search languages',
                  prefixIcon: const Icon(Icons.search),
                  isDense: true,
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                ),
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
                    leading: Icon(sel ? Icons.radio_button_checked : Icons.radio_button_off,
                        color: sel ? kAvaVoicePurple : AvaColors.sub, size: 20),
                    title: Text(e.value,
                        style: TextStyle(fontWeight: sel ? FontWeight.w800 : FontWeight.w600)),
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

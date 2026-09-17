
import '../../core/localization/ui_text.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/avatar.dart';
import '../../core/avavoice_api.dart';
import '../../core/ui/zine_widgets.dart';
import '../explore/widgets.dart' show CoverImage;

/// AvaVoice brand accent — AI/magic = lilac (design system §AI).
const Color kAvaVoicePurple = AD.tabCalls;

String fmtWhenMs(int ms) {
  if (ms <= 0) return '';
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  final now = DateTime.now();
  final sameDay = d.year == now.year && d.month == now.month && d.day == now.day;
  final tomorrow = now.add(const Duration(days: 1));
  final isTomorrow = d.year == tomorrow.year && d.month == tomorrow.month && d.day == tomorrow.day;
  final hh = d.hour.toString().padLeft(2, '0');
  final mm = d.minute.toString().padLeft(2, '0');
  if (sameDay) return uiCopy(UiMessage.m_today_hh_mm_311c650448, {'hh': (hh).toString(), 'mm': (mm).toString()});
  if (isTomorrow) return uiCopy(UiMessage.m_tomorrow_hh_mm_30dda316ff, {'hh': (hh).toString(), 'mm': (mm).toString()});
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return '${authoredUiCopy(months[d.month - 1])} ${d.day}, $hh:$mm';
}

/// "Call Now" / "Agent Busy" live chip. busy = coral (white text), free = mint.
class AvailabilityChip extends StatelessWidget {
  final bool busy;
  final bool compact;
  const AvailabilityChip({super.key, required this.busy, this.compact = false});
  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    final fill = busy ? AD.danger : AD.online;
    const fg = Colors.white;
    const dot = Colors.white;
    return Container(
      padding: EdgeInsets.symmetric(horizontal: compact ? 8 : 11, vertical: compact ? 3 : 5),
      decoration: BoxDecoration(
        color: fill,
        borderRadius: Msg.brPill,
        border: Border.all(color: AD.borderControl, width: 1),
        boxShadow: Msg.none,
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Container(width: 7, height: 7, decoration: const BoxDecoration(color: dot, shape: BoxShape.circle)),
        const SizedBox(width: Msg.s1),
        Text(busy ? uiCopy(UiMessage.m_agent_busy_f9e486a96d) : uiCopy(UiMessage.m_call_now_2f756f1ec5),
            style: ADText.tabLabel(c: fg).copyWith(fontSize: compact ? 10 : 12, letterSpacing: 0.44)),
      ]),
    );
  }
}

class VisionBadge extends StatelessWidget {
  const VisionBadge({super.key});
  @override
  Widget build(BuildContext context) { UiLocaleScope.watch(context); return Container(
        padding: const EdgeInsets.symmetric(horizontal: Msg.s2, vertical: Msg.s1),
        decoration: BoxDecoration(
          color: AD.tabCalls,
          borderRadius: Msg.brPill,
          border: Border.all(color: AD.borderControl, width: 1),
          boxShadow: Msg.none,
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(PhosphorIcons.eye(PhosphorIconsStyle.regular), size: 12, color: Colors.white),
          const SizedBox(width: 4),
          UiText(UiMessage.m_vision_c587c2601c, style: ADText.tabLabel(c: Colors.white).copyWith(fontSize: 10, letterSpacing: 0.4)),
        ]),
      ); }
}

class FreeBadge extends StatelessWidget {
  const FreeBadge({super.key});
  @override
  Widget build(BuildContext context) { UiLocaleScope.watch(context); return Container(
        padding: const EdgeInsets.symmetric(horizontal: Msg.s2, vertical: Msg.s1),
        decoration: BoxDecoration(
          color: AD.online,
          borderRadius: Msg.brPill,
          border: Border.all(color: AD.borderControl, width: 1),
          boxShadow: Msg.none,
        ),
        child: UiText(UiMessage.m_free_f411a1fb62, style: ADText.tabLabel(c: Colors.white).copyWith(fontSize: 10, letterSpacing: 0.4)),
      ); }
}

/// Marketplace agent card.
class AgentCard extends StatelessWidget {
  final VoiceAgent agent;
  final VoidCallback onTap;
  const AgentCard({super.key, required this.agent, required this.onTap});

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return ZinePressable(
      onTap: onTap,
      radius: BorderRadius.circular(Msg.rLg),
      boxShadow: Msg.none,
      padding: const EdgeInsets.all(12),
      child: Row(children: [
        // Listing photo (first of 1–5) when present; identicon fallback.
        if (agent.images.isNotEmpty)
          CoverImage(url: agent.images.first, seed: agent.id.hashCode, width: 52, height: 52,
              radius: BorderRadius.circular(Msg.rMd))
        else
          Avatar(seed: agent.id, name: agent.name, size: 52, avatarUrl: agent.avatarUrl),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text(agent.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ADText.rowName().copyWith(fontSize: 15, height: 1.3, fontWeight: FontWeight.w600))),
              if (agent.activeCalls != null) AvailabilityChip(busy: agent.busy, compact: true),
            ]),
            const SizedBox(height: 2),
            Text(agent.role, maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ADText.preview().copyWith(fontSize: 13, height: 1.42)),
            const SizedBox(height: Msg.s2),
            Row(children: [
              if (agent.isFreeForCallers) ...[const FreeBadge(), const SizedBox(width: Msg.s1)],
              if (agent.visionEnabled) ...[const VisionBadge(), const SizedBox(width: Msg.s1)],
              Flexible(child: Text(
                agent.isFreeForCallers
                    ? uiCopy(UiMessage.m_up_to_value1_min_6c143a4616, {'value1': (agent.sessionLimitMin).toString()})
                    : uiCopy(UiMessage.m_value1_up_to_value2_min_a9f9173e83, {'value1': (agent.rateLabel).toString(), 'value2': (agent.sessionLimitMin).toString()}),
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ADText.preview().copyWith(fontSize: 12, height: 1.42),
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
    backgroundColor: AD.overlaySheet,
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
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
    UiLocaleScope.watch(context);
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
              padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s5, Msg.s5, Msg.s2),
              child: UiText(UiMessage.m_which_language_should_the_agent_c50d14e029, style: ADText.threadName().copyWith(fontSize: 19, height: 1.1, letterSpacing: -0.2)),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
              child: ZineField(
                hint: uiCopy(UiMessage.m_search_languages_98cdcf4f24),
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
                        color: sel ? AD.tabCalls : AD.textTertiary, size: 22),
                    title: Text(e.value,
                        style: ADText.rowName().copyWith(fontSize: 15, height: 1.3, fontWeight: sel ? FontWeight.w700 : FontWeight.w400)),
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

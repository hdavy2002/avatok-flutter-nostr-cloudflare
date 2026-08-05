import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/avatar.dart';
import '../../core/avavision_api.dart';
import '../../core/ui/zine_widgets.dart';
import '../explore/widgets.dart' show CoverImage;

/// AvaVision brand accent — like AvaVoice, AI/magic = lilac (design system §AI),
/// with coral as the "eyes/vision" highlight.
const Color kAvaVisionPurple = AD.tabCalls;

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
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return '${months[d.month - 1]} ${d.day}, $hh:$mm';
}


/// Sentence case for a display label. Replaces the `.toUpperCase()` the legacy
/// zine stickers applied to everything; call sites pass lowercase strings, so
/// simply dropping the transform would render them lowercase.
String _sentence(String s) =>
    s.isEmpty ? s : '${s[0].toUpperCase()}${s.substring(1)}';

/// Generic zine pill (rounded sticker with ink border + xs hard shadow).
class MiniPill extends StatelessWidget {
  final String text;
  final Color fill, fg;
  final IconData? icon;
  final bool shadow;
  const MiniPill(this.text,
      {super.key, this.fill = AD.card, this.fg = AD.textPrimary, this.icon, this.shadow = true});
  @override
  Widget build(BuildContext context) => Container(
        padding: EdgeInsets.symmetric(horizontal: icon == null ? 8 : 7, vertical: 3),
        decoration: BoxDecoration(
          color: fill,
          borderRadius: Msg.brPill,
          border: Border.all(color: AD.borderControl, width: 1),
          boxShadow: shadow ? Msg.none : null,
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (icon != null) ...[
            PhosphorIcon(icon!, size: 11, color: fg),
            const SizedBox(width: 4),
          ],
          Text(_sentence(text), style: ADText.tabLabel(c: fg).copyWith(fontSize: 10, letterSpacing: 0.4)),
        ]),
      );
}

/// "Call Now" / "Agent Busy" live chip. busy = coral (white text), free = mint.
class AvailabilityChip extends StatelessWidget {
  final bool busy;
  final bool compact;
  const AvailabilityChip({super.key, required this.busy, this.compact = false});
  @override
  Widget build(BuildContext context) {
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
        const SizedBox(width: 5),
        Text(busy ? 'Agent busy' : 'Call now', style: ADText.tabLabel(c: fg).copyWith(fontSize: compact ? 10 : 12, letterSpacing: 0.44)),
      ]),
    );
  }
}

/// The "VISION" sticker — coral eye (the camera/vision highlight).
class VisionBadge extends StatelessWidget {
  const VisionBadge({super.key});
  @override
  Widget build(BuildContext context) => MiniPill('vision',
      fill: AD.tabCalls, fg: Colors.white, icon: PhosphorIcons.eye(PhosphorIconsStyle.regular));
}

class FreeBadge extends StatelessWidget {
  const FreeBadge({super.key});
  @override
  Widget build(BuildContext context) => const MiniPill('free', fill: AD.online, fg: Colors.white);
}

/// Capability badge — e.g. "BODY POSE" with a target icon.
class CapabilityBadge extends StatelessWidget {
  final String capability;
  const CapabilityBadge(this.capability, {super.key});
  @override
  Widget build(BuildContext context) => MiniPill(
        capabilityLabel(capability),
        fill: AD.tabGroups,
        fg: Colors.white,
        icon: PhosphorIcons.personSimpleRun(PhosphorIconsStyle.regular),
      );
}

/// Overlay-style badge — only shown when the agent draws an overlay.
class OverlayBadge extends StatelessWidget {
  final String overlayStyle;
  const OverlayBadge(this.overlayStyle, {super.key});
  @override
  Widget build(BuildContext context) => MiniPill(
        overlayLabel(overlayStyle),
        fill: AD.tabCalls,
        fg: Colors.white,
        icon: PhosphorIcons.scribbleLoop(PhosphorIconsStyle.regular),
      );
}

/// Score-label badge — e.g. "FORMSCORE".
class ScoreBadge extends StatelessWidget {
  final String label;
  const ScoreBadge(this.label, {super.key});
  @override
  Widget build(BuildContext context) => MiniPill(
        label,
        fill: AD.online,
        fg: Colors.white,
        icon: PhosphorIcons.gauge(PhosphorIconsStyle.regular),
      );
}

/// Platform availability badges — Android / iOS / Web.
class PlatformBadges extends StatelessWidget {
  final VisionPlatforms platforms;
  const PlatformBadges(this.platforms, {super.key});
  @override
  Widget build(BuildContext context) {
    final labels = platforms.labels;
    if (labels.isEmpty) return const SizedBox.shrink();
    return MiniPill(labels.join(' · '), fill: AD.card, fg: AD.textSecondary, shadow: false);
  }
}

/// The standard row of vision stickers shown on cards / detail headers.
List<Widget> visionStickers(VisionAgent a, {bool includeAvailability = true, bool compact = false}) {
  return [
    if (includeAvailability && a.activeCalls != null)
      a.busy
          ? const MiniPill('busy', fill: AD.danger, fg: Colors.white)
          : const MiniPill('call now', fill: AD.online, fg: Colors.white),
    if (a.isFreeForCallers) const FreeBadge(),
    CapabilityBadge(a.capability),
    if (a.hasOverlay) OverlayBadge(a.overlayStyle),
    if (a.hasScore && a.scoreLabel != null) ScoreBadge(a.scoreLabel!),
    if (!compact) PlatformBadges(a.platforms),
  ];
}

/// Marketplace agent card.
class AgentCard extends StatelessWidget {
  final VisionAgent agent;
  final VoidCallback onTap;
  const AgentCard({super.key, required this.agent, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final a = agent;
    return ZinePressable(
      onTap: onTap,
      radius: BorderRadius.circular(Msg.rLg),
      boxShadow: Msg.none,
      padding: const EdgeInsets.all(12),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(Msg.rMd),
            border: Border.all(color: AD.borderControl, width: 1),
          ),
          clipBehavior: Clip.antiAlias,
          child: a.images.isNotEmpty
              ? CoverImage(url: a.images.first, seed: a.id.hashCode, width: 52, height: 52)
              : Avatar(seed: a.id, name: a.name, size: 52, avatarUrl: a.avatarUrl),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(
                child: Text(a.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ADText.threadName().copyWith(fontSize: 16, height: 1.1, letterSpacing: -0.2)),
              ),
              const SizedBox(width: 8),
              ZineIconBadge(icon: PhosphorIcons.eye(PhosphorIconsStyle.bold), color: AD.tabCalls, size: 26),
            ]),
            const SizedBox(height: 2),
            Text(a.role, maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.preview().copyWith(fontSize: 13, height: 1.42)),
            const SizedBox(height: 8),
            Wrap(spacing: 6, runSpacing: 6, children: [
              ...visionStickers(a, compact: true),
              MiniPill(
                a.isFreeForCallers ? 'up to ${a.sessionLimitMin} min' : '${a.rateLabel} · ${a.sessionLimitMin} min',
                fill: AD.card,
                fg: AD.textSecondary,
                shadow: false,
              ),
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
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
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
              child: Text('Which language should the agent speak?', style: ADText.threadName().copyWith(fontSize: 19, height: 1.1, letterSpacing: -0.2)),
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

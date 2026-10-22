import 'package:flutter/material.dart';

import 'data.dart';
import 'desi.dart';
import 'theme.dart';
import 'widgets.dart';

/// [HF-APP-DESI-2] Search screen pieces, built to the owner-approved canvas preview "2 · Search" (2026-10-22).
/// Shared by the demo SearchScreen and the real RealSearch so both look the same.

/// Lavender hero ("Kise dhoondh rahe ho?") with the search field sitting half over its bottom edge.
class SearchHeader extends StatelessWidget {
  const SearchHeader({super.key, required this.field});
  final Widget field;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const DesiHero(
        eyebrow: 'Search',
        title: 'Kise dhoondh rahe ho?',
        sub: 'Find an influencer by name, @handle or topic.',
        ghost: 'Khoj',
        tone: DesiTone.lav,
        minHeight: 236,
        art: SizedBox(width: 128, height: 150, child: Art('intro/chhotu.webp', fit: BoxFit.contain)),
      ),
      Transform.translate(
        offset: const Offset(0, -34),
        child: Padding(padding: const EdgeInsets.symmetric(horizontal: 10), child: field),
      ),
    ]);
  }
}

/// White pill search field with a soft shadow.
class SearchPill extends StatelessWidget {
  const SearchPill({super.key, required this.controller, required this.onChanged, this.onSubmitted, this.onClear, this.fieldKey});
  final TextEditingController controller;
  final ValueChanged<String> onChanged;
  final ValueChanged<String>? onSubmitted;
  final VoidCallback? onClear;
  final Key? fieldKey;

  @override
  Widget build(BuildContext context) {
    final empty = controller.text.trim().isEmpty;
    return Container(
      height: 56,
      decoration: BoxDecoration(
        color: C.white,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: C.line, width: 1.5),
        boxShadow: const [BoxShadow(color: Color(0x4D4A1747), offset: Offset(0, 10), blurRadius: 24, spreadRadius: -14)],
      ),
      child: TextField(
        key: fieldKey,
        controller: controller,
        onChanged: onChanged,
        onSubmitted: onSubmitted,
        textInputAction: TextInputAction.search,
        style: t(16, w: FontWeight.w700),
        decoration: InputDecoration(
          filled: false,
          border: InputBorder.none,
          enabledBorder: InputBorder.none,
          focusedBorder: InputBorder.none,
          contentPadding: const EdgeInsets.symmetric(vertical: 16),
          hintText: 'Name, @handle or topic',
          hintStyle: t(16, color: C.muted, w: FontWeight.w700),
          prefixIcon: const Padding(padding: EdgeInsets.only(left: 12), child: Icon(Icons.search_rounded, color: C.lav)),
          suffixIcon: empty || onClear == null
              ? null
              : IconButton(tooltip: 'Clear', icon: const Icon(Icons.close_rounded, color: C.maroon), onPressed: onClear),
        ),
      ),
    );
  }
}

/// Small caps group label with a marigold, e.g. "TRY A TOPIC".
class SearchGroupLabel extends StatelessWidget {
  const SearchGroupLabel(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 2, 4, 8),
        child: Row(children: [
          const Marigold(size: 14, yellow: true),
          const SizedBox(width: 6),
          Text(text.toUpperCase(), style: t(14, color: C.muted, w: FontWeight.w800, ls: .08)),
        ]),
      );
}

const _topicTones = [DesiTone.rani, DesiTone.lav, DesiTone.tea, DesiTone.gold];

/// Multi-colour topic pills. The chosen one turns plum.
class SearchTopics extends StatelessWidget {
  const SearchTopics({super.key, required this.topics, required this.onTap, this.selected, this.keyFor});
  final List<(String id, String label)> topics;
  final ValueChanged<String> onTap;
  final String? selected;
  final Key Function(String id)? keyFor;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const SearchGroupLabel('Try a topic'),
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (var i = 0; i < topics.length; i++)
          _TopicPill(
            key: keyFor?.call(topics[i].$1),
            label: topics[i].$2,
            tone: _topicTones[i % _topicTones.length],
            selected: selected == topics[i].$1,
            onTap: () => onTap(topics[i].$1),
          ),
      ]),
    ]);
  }
}

class _TopicPill extends StatelessWidget {
  const _TopicPill({super.key, required this.label, required this.tone, required this.selected, required this.onTap});
  final String label;
  final DesiTone tone;
  final bool selected;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final text = label.isEmpty ? label : label[0].toUpperCase() + label.substring(1);
    return Semantics(
      button: true,
      selected: selected,
      child: Material(
        color: selected ? C.maroon : desiTint(tone),
        shape: const StadiumBorder(),
        child: InkWell(
          customBorder: const StadiumBorder(),
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 44),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            child: Text(text, style: t(15, color: selected ? C.white : desiInk(tone), w: FontWeight.w800)),
          ),
        ),
      ),
    );
  }
}

/// Pink "Online now" card with a hibiscus corner and a row of ringed portraits with a light-green dot.
class OnlineNowCard extends StatelessWidget {
  const OnlineNowCard({super.key, required this.people, this.listKey, this.emptyText});
  final List<(Influencer who, VoidCallback onTap)> people;
  final Key? listKey;
  final String? emptyText;

  @override
  Widget build(BuildContext context) {
    return DesiCard(
      title: 'Online now',
      note: 'Free to talk right this minute',
      tone: DesiTone.rani,
      corner: DesiCorner.hibiscus,
      padding: const EdgeInsets.fromLTRB(16, 16, 0, 16),
      child: people.isEmpty
          ? Padding(padding: const EdgeInsets.only(right: 16), child: Text(emptyText ?? 'No one is online right now.', style: t(15, color: C.muted, w: FontWeight.w700)))
          : SizedBox(
              height: 98,
              child: ListView(
                key: listKey,
                scrollDirection: Axis.horizontal,
                children: [
                  for (final p in people)
                    Padding(
                      padding: const EdgeInsets.only(right: 14),
                      child: GestureDetector(
                        onTap: p.$2,
                        child: SizedBox(
                          width: 68,
                          child: Column(children: [
                            _OnlineFace(p.$1),
                            const SizedBox(height: 6),
                            Text(p.$1.name.split(' ').first, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(14, w: FontWeight.w800)),
                          ]),
                        ),
                      ),
                    ),
                ],
              ),
            ),
    );
  }
}

class _OnlineFace extends StatelessWidget {
  const _OnlineFace(this.who);
  final Influencer who;
  @override
  Widget build(BuildContext context) => SizedBox(
        width: 66,
        height: 66,
        child: Stack(children: [
          Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(color: C.white, width: 3),
              boxShadow: const [BoxShadow(color: C.marigold, spreadRadius: 2)],
            ),
            child: Avatar(who, size: 60, ring: false),
          ),
          Positioned(
            right: 2,
            bottom: 2,
            child: Container(
              width: 14,
              height: 14,
              decoration: BoxDecoration(color: C.onlineDot, shape: BoxShape.circle, border: Border.all(color: C.white, width: 2)),
            ),
          ),
        ]),
      );
}

/// White card with a marigold corner: offline influencers you can still book.
class BookTimeCard extends StatelessWidget {
  const BookTimeCard({super.key, required this.rows});
  final List<Widget> rows;
  @override
  Widget build(BuildContext context) => DesiCard(
        title: 'Book a time',
        note: 'Offline now, but you can book a slot',
        corner: DesiCorner.marigold,
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 6),
        child: Column(children: rows),
      );
}

/// A person row: ringed portrait, name, handle line, then Online/Offline and rate chips.
class SearchPersonRow extends StatelessWidget {
  const SearchPersonRow({super.key, required this.who, required this.subtitle, required this.online, required this.rate, required this.onTap, this.leading, this.last = false});
  final Influencer who;
  final Widget subtitle;
  final bool online;
  final int rate;
  final VoidCallback onTap;
  final Widget? leading;
  final bool last;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(border: last ? null : const Border(bottom: BorderSide(color: C.line))),
        child: Row(children: [
          Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(color: C.white, width: 3),
              boxShadow: [BoxShadow(color: online ? C.marigold : C.line, spreadRadius: 2)],
            ),
            child: Avatar(who, size: 44, ring: false),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(who.name, style: t(17, w: FontWeight.w800)),
              subtitle,
            ]),
          ),
          if (online)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 4),
              decoration: BoxDecoration(color: C.onlineBg, borderRadius: BorderRadius.circular(999)),
              child: Text('Online', style: t(14, color: C.onlineInk, w: FontWeight.w800)),
            )
          else
            const DesiChip('Offline', tone: DesiTone.white),
          const SizedBox(width: 6),
          DesiChip('₹$rate/min', tone: DesiTone.gold),
        ]),
      ),
    );
  }
}

/// Striped marigold card with the invite badge art: handles fans want, with rank medallions and Invite pills.
class MostWantedCard extends StatelessWidget {
  const MostWantedCard({super.key, required this.rows, this.title = 'Most-wanted, not here yet'});
  final List<Widget> rows;
  final String title;
  @override
  Widget build(BuildContext context) {
    return Stack(clipBehavior: Clip.none, children: [
      DesiCard(
        pattern: DesiPattern.stripes,
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Padding(
            padding: const EdgeInsets.only(right: 70),
            child: DesiTitle(title, yellow: true),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(29, 2, 70, 12),
            child: Text('Tap Invite to vote. We ask the top names to join.', style: t(14, color: C.muted, w: FontWeight.w600)),
          ),
          ...rows,
        ]),
      ),
      Positioned(
        right: -6,
        top: -8,
        child: Transform.rotate(angle: .14, child: const SizedBox(width: 86, height: 86, child: Art('intro/invite-vote-badge.webp', fit: BoxFit.contain))),
      ),
    ]);
  }
}

/// One most-wanted handle: rank medallion (gold, silver, bronze, then plain), handle, votes, Invite / Voted.
class MostWantedRow extends StatelessWidget {
  const MostWantedRow({
    super.key,
    required this.rank,
    required this.handle,
    required this.votes,
    required this.voted,
    required this.onInvite,
    this.platformIcon,
    this.caption,
  });
  final int rank;
  final String handle;
  final int votes;
  final bool voted;
  final VoidCallback? onInvite;
  final Widget? platformIcon;
  final String? caption;

  @override
  Widget build(BuildContext context) {
    final (Gradient? g, Color bg, Color ink) = switch (rank) {
      1 => (const LinearGradient(colors: [Color(0xFFF59E0B), Color(0xFFEA6A12)]), C.marigold, C.white),
      2 => (null, const Color(0xFFB9A7B6), C.white),
      3 => (null, const Color(0xFFC98A5A), C.white),
      _ => (null, C.goldtint, C.amber),
    };
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.fromLTRB(12, 8, 10, 8),
      decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(18), border: Border.all(color: const Color(0xFFF3DFB3))),
      child: Row(children: [
        Container(
          width: 38,
          height: 38,
          alignment: Alignment.center,
          decoration: BoxDecoration(shape: BoxShape.circle, gradient: g, color: g == null ? bg : null),
          child: Text('$rank', style: t(16, color: ink, w: FontWeight.w800)),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              if (platformIcon != null) ...[platformIcon!, const SizedBox(width: 4)],
              Flexible(child: Text(handle, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(16, w: FontWeight.w800))),
            ]),
            Text(caption ?? '${_grouped(votes)} votes', style: t(14, color: C.amber, w: FontWeight.w700)),
          ]),
        ),
        const SizedBox(width: 8),
        Semantics(
          button: true,
          enabled: !voted,
          child: Material(
            color: C.clear,
            child: InkWell(
              customBorder: const StadiumBorder(),
              onTap: voted ? null : onInvite,
              child: Container(
                constraints: const BoxConstraints(minHeight: 44, minWidth: 48),
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(999),
                  gradient: voted ? null : const LinearGradient(colors: [Color(0xFFD81B72), Color(0xFFF0408F)]),
                  color: voted ? C.white : null,
                  border: voted ? Border.all(color: const Color(0xFF9FD3D8), width: 1.5) : null,
                ),
                child: Text(voted ? 'VOTED' : 'INVITE', style: t(15, color: voted ? C.peacock : C.white, w: FontWeight.w800)),
              ),
            ),
          ),
        ),
      ]),
    );
  }

  static String _grouped(int n) => n < 1000 ? '$n' : '${n ~/ 1000},${(n % 1000).toString().padLeft(3, '0')}';
}

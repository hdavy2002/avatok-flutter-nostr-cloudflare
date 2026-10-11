import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../../core/links.dart';
import '../../../../core/strings.dart';
import '../../../../core/theme/hf_theme.dart';
import '../../../../core/widgets/widgets.dart';
import '../../data/host_profile.dart';
import '../../data/host_profile_providers.dart';
import '../../host_profile_strings.dart';
import 'profile_common.dart';

/// Lavender quote card. Shown only when the host has a quote.
class QuoteCard extends StatelessWidget {
  const QuoteCard({super.key, required this.quote, required this.name});

  final String quote;
  final String name;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    return Semantics(
      container: true,
      label: '“$quote” – $name',
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.all(HfSpacing.xxl),
        decoration: BoxDecoration(
          color: HfTint.lavender.bg(context),
          borderRadius: BorderRadius.circular(24),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '“',
              style: HfText.hero.copyWith(
                fontSize: 40,
                height: 0.6,
                color: dark ? HfColors.lavenderLight : HfColors.link,
              ),
            ),
            const SizedBox(height: HfSpacing.sm),
            Text(
              quote,
              style: HfText.section.copyWith(
                fontSize: 19,
                height: 1.35,
                color: HfTint.lavender.valueInk(context),
              ),
            ),
            const SizedBox(height: HfSpacing.sm),
            Text(
              '– $name',
              style: HfText.label.copyWith(
                fontWeight: FontWeight.w400,
                color: HfTint.lavender.ink(context),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Fact {
  const _Fact(this.tint, this.label, this.value);
  final HfTint tint;
  final String label;
  final String value;
}

/// About text plus the 2-column fact tiles: Languages (butter), Style (blush), Space (peach, women-only hosts)
/// and Welcome (lavender, "LGBTQ+ friendly" only when true). "Usually online" has no data on the profile yet.
class AboutSection extends StatelessWidget {
  const AboutSection({super.key, required this.profile});

  final HostProfile profile;

  @override
  Widget build(BuildContext context) {
    final about = profile.aboutPolished;
    final facts = <_Fact>[
      if (profile.languages.isNotEmpty)
        _Fact(
          HfTint.butter,
          HostProfileStrings.languages,
          profile.languages.join(', '),
        ),
      if (profile.styleLabel != null)
        _Fact(HfTint.blush, HostProfileStrings.styleTile, profile.styleLabel!),
      if (profile.womenOnly)
        const _Fact(
          HfTint.peach,
          HostProfileStrings.spaceTile,
          HostProfileStrings.womenOnlyBadge,
        ),
      if (profile.lgbtqFriendly)
        const _Fact(
          HfTint.lavender,
          HostProfileStrings.welcomeTile,
          HostProfileStrings.lgbtqBadge,
        ),
    ];
    if (about == null && facts.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: kProfileSidePad),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (about != null)
            Text(
              about,
              style: HfText.of(context, HfText.body).copyWith(height: 1.6),
            ),
          if (about != null && facts.isNotEmpty)
            const SizedBox(height: HfSpacing.lg),
          for (var i = 0; i < facts.length; i += 2) ...[
            if (i > 0) const SizedBox(height: HfSpacing.sm),
            _FactRow(
              left: facts[i],
              right: i + 1 < facts.length ? facts[i + 1] : null,
            ),
          ],
        ],
      ),
    );
  }
}

class _FactRow extends StatelessWidget {
  const _FactRow({required this.left, this.right});

  final _Fact left;
  final _Fact? right;

  @override
  Widget build(BuildContext context) {
    if (profileBigText(context, 1.5)) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _FactTile(fact: left),
          if (right != null) ...[
            const SizedBox(height: HfSpacing.sm),
            _FactTile(fact: right!),
          ],
        ],
      );
    }
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(child: _FactTile(fact: left)),
          const SizedBox(width: HfSpacing.sm),
          Expanded(
            child: right == null
                ? const SizedBox.shrink()
                : _FactTile(fact: right!),
          ),
        ],
      ),
    );
  }
}

class _FactTile extends StatelessWidget {
  const _FactTile({required this.fact});

  final _Fact fact;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      label: '${fact.label} ${fact.value}',
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.all(HfSpacing.lg),
        decoration: BoxDecoration(
          color: fact.tint.bg(context),
          borderRadius: BorderRadius.circular(HfRadius.tileSmall),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              fact.label,
              style: HfText.label.copyWith(
                fontWeight: FontWeight.w400,
                color: fact.tint.ink(context),
              ),
            ),
            const SizedBox(height: 4),
            Text(
              fact.value,
              style: HfText.badge.copyWith(
                fontSize: 15,
                color: fact.tint.valueInk(context),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// "Let's talk about": outlined topic chips and a friendly line.
class TopicsSection extends StatelessWidget {
  const TopicsSection({super.key, required this.profile, required this.labels});

  final HostProfile profile;
  final Map<String, String> labels;

  @override
  Widget build(BuildContext context) {
    if (profile.topics.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: kProfileSidePad),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SectionTitle(HostProfileStrings.talkAbout),
          const SizedBox(height: HfSpacing.lg),
          Wrap(
            spacing: HfSpacing.sm,
            runSpacing: 0,
            children: [
              for (final t in profile.topics)
                HfChip.outline(label: topicLabel(labels, t)),
            ],
          ),
          const SizedBox(height: HfSpacing.sm),
          Text(
            HostProfileStrings.topicsNote,
            style: HfText.note.copyWith(
              fontSize: 14,
              color: profileMuted(context),
            ),
          ),
        ],
      ),
    );
  }
}

/// "Before you call": three expandable rows (the first open), then the AI / real-host disclosure.
class BeforeYouCall extends StatelessWidget {
  const BeforeYouCall({super.key});

  static const List<(IconData, HfTint)> _looks = [
    (Icons.lock_outline_rounded, HfTint.sky),
    (Icons.tag_rounded, HfTint.blush),
    (Icons.chat_bubble_outline_rounded, HfTint.butter),
  ];

  @override
  Widget build(BuildContext context) {
    const notes = HostProfileStrings.beforeNotes;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: kProfileSidePad),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SectionTitle(HostProfileStrings.beforeYouCall),
          const SizedBox(height: HfSpacing.lg),
          for (var i = 0; i < notes.length; i++) ...[
            if (i > 0) const SizedBox(height: HfSpacing.sm),
            _ExpandRow(
              icon: _looks[i % _looks.length].$1,
              tint: _looks[i % _looks.length].$2,
              title: notes[i].$1,
              body: notes[i].$2,
              initiallyOpen: i == 0,
            ),
          ],
          const SizedBox(height: HfSpacing.md),
          Text(
            HostProfileStrings.disclosure,
            style: HfText.note.copyWith(
              fontSize: 14,
              color: profileMuted(context),
            ),
          ),
        ],
      ),
    );
  }
}

class _ExpandRow extends StatefulWidget {
  const _ExpandRow({
    required this.icon,
    required this.tint,
    required this.title,
    required this.body,
    required this.initiallyOpen,
  });

  final IconData icon;
  final HfTint tint;
  final String title;
  final String body;
  final bool initiallyOpen;

  @override
  State<_ExpandRow> createState() => _ExpandRowState();
}

class _ExpandRowState extends State<_ExpandRow> {
  late bool _open = widget.initiallyOpen;

  @override
  Widget build(BuildContext context) {
    final tint = widget.tint;
    return Container(
      decoration: profileBox(context, radius: HfRadius.control),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(HfRadius.control),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Semantics(
              button: true,
              expanded: _open,
              label: widget.title,
              excludeSemantics: true,
              child: InkWell(
                onTap: () {
                  HapticFeedback.selectionClick();
                  setState(() => _open = !_open);
                },
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: 56),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: HfSpacing.sm,
                    ),
                    child: Row(
                      children: [
                        Container(
                          width: 32,
                          height: 32,
                          decoration: BoxDecoration(
                            color: tint.bg(context),
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: Icon(
                            widget.icon,
                            size: 16,
                            color: tint.ink(context),
                          ),
                        ),
                        const SizedBox(width: HfSpacing.lg),
                        Expanded(
                          child: Text(
                            widget.title,
                            style: HfText.of(
                              context,
                              HfText.badge,
                            ).copyWith(fontSize: 15),
                          ),
                        ),
                        const SizedBox(width: HfSpacing.sm),
                        Icon(
                          _open
                              ? Icons.keyboard_arrow_up_rounded
                              : Icons.keyboard_arrow_down_rounded,
                          size: 20,
                          color: profileMuted(context),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            AnimatedSize(
              duration: HfMotion.of(context, HfMotion.fast),
              curve: HfMotion.curve,
              alignment: Alignment.topCenter,
              child: _open
                  ? Padding(
                      padding: const EdgeInsets.fromLTRB(60, 0, 16, 16),
                      child: Text(
                        widget.body,
                        style: HfText.note.copyWith(
                          fontSize: 14,
                          color: profileMuted(context),
                        ),
                      ),
                    )
                  : const SizedBox(width: double.infinity),
            ),
          ],
        ),
      ),
    );
  }
}

/// "In crisis? Call Tele-MANAS 14416 or 112." with tappable numbers, then "Report this profile".
class CrisisAndReport extends StatelessWidget {
  const CrisisAndReport({super.key, required this.onReport});

  final VoidCallback onReport;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final linkColor = dark ? HfColors.lavenderLight : HfColors.link;
    final style = HfText.badge.copyWith(fontSize: 15, color: linkColor);
    Widget link(String label, VoidCallback onTap, {IconData? icon}) =>
        TextButton(
          onPressed: onTap,
          style: TextButton.styleFrom(
            foregroundColor: linkColor,
            minimumSize: const Size(HfSpacing.tap, HfSpacing.tap),
            padding: const EdgeInsets.symmetric(horizontal: HfSpacing.md),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon != null) ...[
                Icon(icon, size: 18),
                const SizedBox(width: HfSpacing.xs),
              ],
              Flexible(child: Text(label, style: style)),
            ],
          ),
        );
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: kProfileSidePad),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text(
                HostProfileStrings.crisisLead,
                style: HfText.note.copyWith(
                  fontSize: 14,
                  color: profileMuted(context),
                ),
              ),
              link(
                Strings.crisisTeleManasNumber,
                () => LinkOpener.instance.tel(Strings.crisisTeleManasNumber),
              ),
              Text(
                HostProfileStrings.crisisOr,
                style: HfText.note.copyWith(
                  fontSize: 14,
                  color: profileMuted(context),
                ),
              ),
              link(
                Strings.crisisEmergencyNumber,
                () => LinkOpener.instance.tel(Strings.crisisEmergencyNumber),
              ),
            ],
          ),
          link(HostProfileStrings.report, onReport, icon: Icons.flag_outlined),
        ],
      ),
    );
  }
}

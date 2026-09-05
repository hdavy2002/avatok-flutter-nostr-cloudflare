// [POSTER-FIRST-1 2026-09-05] The "More info" sheet — the phone twin of
// web/src/islands/listing/QuickInfo.tsx.
//
// The poster carries a title and a tagline and nothing else, deliberately: no
// price, no duration, no house rules ever pass through an image model, because
// a model that letters "₹250" as "₹25O" turns a cosmetic glitch into a money
// bug. Every one of those facts lives HERE instead, as real text read straight
// off the listing row — selectable, translatable, readable by TalkBack, and
// correct by construction.
//
// It is a bottom sheet rather than a dialog because it is the back of the card
// the user just tapped: it should rise from it, not float over it.
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/listings_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../explore/widgets.dart' show fmtTokens, fmtWhen;

/// Opens the quick-info sheet for [card].
///
/// [onBook] and [onDetails] are supplied by the caller because booking and
/// navigation belong to the screen that owns the card, not to this sheet.
Future<void> showListingQuickInfo(
  BuildContext context,
  ListingCard card, {
  required VoidCallback onDetails,
  VoidCallback? onBook,
}) {
  Analytics.capture('listing_quick_info_open', {
    'listing_id': card.id,
    'kind': card.kind,
    'has_poster': card.hasAiPoster,
  });
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: Colors.transparent,
    isScrollControlled: true,
    builder: (ctx) => _QuickInfoSheet(card: card, onDetails: onDetails, onBook: onBook),
  );
}

class _QuickInfoSheet extends StatelessWidget {
  const _QuickInfoSheet({required this.card, required this.onDetails, this.onBook});

  final ListingCard card;
  final VoidCallback onDetails;
  final VoidCallback? onBook;

  @override
  Widget build(BuildContext context) {
    // A sheet must never be taller than the screen it rises into, and the rules
    // list is creator-supplied so its length is unbounded — cap it and scroll.
    final maxHeight = MediaQuery.sizeOf(context).height * 0.85;
    final rules = _stringList(card.attrs['content_house_rules']);
    final expect = _stringList(card.attrs['content_what_you_get']);
    final when = card.startsAt != null ? fmtWhen(card.startsAt) : null;

    return SafeArea(
      top: false,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxHeight),
        child: Container(
          decoration: BoxDecoration(
            color: AD.card,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(AD.rSheet)),
            border: Border.all(color: AD.borderCard, width: 2),
          ),
          clipBehavior: Clip.antiAlias,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: Msg.s2, bottom: Msg.s1),
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: AD.borderControl,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              Flexible(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s2, Msg.s4, Msg.s4),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // `category` is non-nullable on ListingCard — an empty
                      // string is the "unset" value, not null.
                      if (card.category.isNotEmpty)
                        Text(
                          card.category.toUpperCase(),
                          style: ADText.preview(c: AD.textSecondary)
                              .copyWith(fontWeight: FontWeight.w900, letterSpacing: 1.6),
                        ),
                      const SizedBox(height: Msg.s2),
                      Text(
                        card.title,
                        style: ADText.rowName().copyWith(
                          fontSize: 22,
                          height: 1.15,
                          fontWeight: FontWeight.w900,
                          letterSpacing: 0.6,
                        ),
                      ),
                      if ((card.blurb ?? '').isNotEmpty) ...[
                        const SizedBox(height: Msg.s2),
                        Text(card.blurb!, style: ADText.preview()),
                      ],
                      const SizedBox(height: Msg.s3),
                      Divider(color: AD.borderCard, height: 1),
                      const SizedBox(height: Msg.s3),
                      Wrap(
                        spacing: Msg.s4,
                        runSpacing: Msg.s3,
                        children: [
                          _Fact(label: 'Price', value: fmtTokens(card.effectivePrice)),
                          // durationMin is NULLABLE on ListingCard — an
                          // always-on agent listing has no duration at all.
                          if ((card.durationMin ?? 0) > 0)
                            _Fact(label: 'Duration', value: _duration(card.durationMin!)),
                          if (when != null) _Fact(label: 'Date & time', value: when),
                          if ((card.spokenLang ?? '').isNotEmpty)
                            _Fact(label: 'Language', value: card.spokenLang!),
                          if ((card.location ?? '').isNotEmpty)
                            _Fact(label: 'Location', value: card.location!),
                        ],
                      ),
                      if (expect.isNotEmpty) ...[
                        const SizedBox(height: Msg.s3),
                        Divider(color: AD.borderCard, height: 1),
                        const SizedBox(height: Msg.s3),
                        _Section(label: 'What to expect', items: expect),
                      ],
                      if (rules.isNotEmpty) ...[
                        const SizedBox(height: Msg.s3),
                        Divider(color: AD.borderCard, height: 1),
                        const SizedBox(height: Msg.s3),
                        _Section(label: 'Boundaries & house rules', items: rules),
                      ],
                    ],
                  ),
                ),
              ),
              Container(height: 1, color: AD.borderCard),
              Padding(
                padding: const EdgeInsets.all(Msg.s3),
                child: Row(children: [
                  if (onBook != null) ...[
                    Expanded(
                      child: FilledButton(
                        onPressed: () {
                          Navigator.of(context).pop();
                          onBook!();
                        },
                        child: const Text('Book now'),
                      ),
                    ),
                    const SizedBox(width: Msg.s2),
                  ],
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: () {
                        Navigator.of(context).pop();
                        onDetails();
                      },
                      icon: PhosphorIcon(
                        PhosphorIcons.arrowRight(PhosphorIconsStyle.bold),
                        size: 16,
                      ),
                      label: const Text('Details'),
                    ),
                  ),
                ]),
              ),
            ],
          ),
        ),
      ),
    );
  }

  static List<String> _stringList(dynamic raw) {
    if (raw is! List) return const [];
    return raw
        .map((e) => e?.toString().trim() ?? '')
        .where((e) => e.isNotEmpty)
        .take(6)
        .toList(growable: false);
  }

  static String _duration(int min) {
    if (min < 60) return '$min min';
    final h = min ~/ 60, m = min % 60;
    return m == 0 ? '$h hour${h == 1 ? '' : 's'}' : '$h hr $m min';
  }
}

class _Fact extends StatelessWidget {
  const _Fact({required this.label, required this.value});
  final String label, value;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          label.toUpperCase(),
          style: ADText.preview(c: AD.textSecondary)
              .copyWith(fontWeight: FontWeight.w900, letterSpacing: 1.6),
        ),
        const SizedBox(height: 2),
        Text(
          value,
          style: ADText.rowName().copyWith(fontWeight: FontWeight.w800, letterSpacing: 0.5),
        ),
      ],
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.label, required this.items});
  final String label;
  final List<String> items;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label.toUpperCase(),
          style: ADText.preview(c: AD.textSecondary)
              .copyWith(fontWeight: FontWeight.w900, letterSpacing: 1.6),
        ),
        const SizedBox(height: Msg.s2),
        for (final item in items)
          Padding(
            padding: const EdgeInsets.only(bottom: Msg.s1),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 6, right: Msg.s2),
                  child: Container(
                    width: 5,
                    height: 5,
                    decoration: BoxDecoration(color: AD.iconSearch, shape: BoxShape.circle),
                  ),
                ),
                Expanded(child: Text(item, style: ADText.preview())),
              ],
            ),
          ),
      ],
    );
  }
}

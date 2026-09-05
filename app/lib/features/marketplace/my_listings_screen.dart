import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/cached_image.dart';
import '../../core/listings_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import 'edit_listing_screen.dart';

/// Friendly status label (the raw 'published' shows as 'live' to owners).
///
/// [LIST-EMBED-1 2026-09-05] `pending_review`, `approved` and `rejected` were
/// missing, so they fell through to `default` and the row read the raw column
/// value — "pending_review", with the underscore. That was survivable while the
/// only way in was the web dashboard (which has its own worded states); it is
/// not now that submitting the form lands the creator on THIS screen, where the
/// status line is the entire answer to "did that work?".
String _statusLabel(String s) {
  switch (s) {
    case 'published': return 'live';
    case 'completed': return 'sold';
    case 'cancelled': return 'archived';
    case 'pending_review': return 'Review pending';
    case 'approved': return 'approved — going live shortly';
    case 'rejected': return 'changes requested';
    default: return s;
  }
}

/// Statuses that get a coloured chip rather than a word in the subtitle line —
/// the three a creator has to act on or wait through.
const _kNoticeStatuses = {'pending_review', 'approved', 'rejected'};

Color _statusChipColor(String s) {
  switch (s) {
    case 'approved': return AD.headerFooter; // jodhpur blue — settled, good news
    case 'rejected': return AD.danger;
    default: return AD.haldi; // waiting on us
  }
}

/// AvaMarketplace P1 — owner's listings list. P4 enriches each row with edit /
/// mark-sold / renew actions; here it loads and shows status so the screen is
/// reachable and useful from day one.
class MyListingsScreen extends StatefulWidget {
  const MyListingsScreen({super.key, this.highlightPendingReview = false});

  /// [LIST-EMBED-1] Set when we arrive straight from a submitted listing form.
  /// Shows a one-line banner explaining what happens next, because the creator
  /// has just finished an eight-step form and "Review pending" on a card is a
  /// thin answer on its own. Purely presentational — the card's own status is
  /// still whatever the server says.
  final bool highlightPendingReview;

  @override
  State<MyListingsScreen> createState() => _MyListingsScreenState();
}

class _MyListingsScreenState extends State<MyListingsScreen> {
  late Future<List<ListingCard>> _future;

  @override
  void initState() {
    super.initState();
    Analytics.capture('my_listings_opened');
    _future = ListingsApi.mine();
  }

  void _reload() => setState(() => _future = ListingsApi.mine());

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: AppBar(
        backgroundColor: AD.headerFooter,
        foregroundColor: AD.textPrimary,
        elevation: 0,
        title: Text('My listings', style: ADText.appTitle()),
      ),
      body: Column(children: [
        if (widget.highlightPendingReview) const _SubmittedBanner(),
        Expanded(child: RefreshIndicator(
        onRefresh: () async => _reload(),
        child: FutureBuilder<List<ListingCard>>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return const Center(child: CircularProgressIndicator());
            }
            // Cancelled (deleted) and expired listings live in Archived — keep
            // them OUT of My Listings so they don't appear duplicated (pic 7/9).
            final items = (snap.data ?? const <ListingCard>[])
                .where((c) => c.status != 'cancelled' && !c.isExpired)
                .toList();
            if (items.isEmpty) {
              return ListView(children: [
                const SizedBox(height: 120),
                Center(child: Text('You have no active listings yet.',
                    style: ADText.preview())),
              ]);
            }
            return ListView.separated(
              padding: const EdgeInsets.all(Msg.s3),
              itemCount: items.length,
              separatorBuilder: (_, __) => const SizedBox(height: Msg.s2),
              itemBuilder: (_, i) => _MyListingRow(card: items[i], onChanged: _reload),
            );
          },
        ),
        )),
      ]),
    );
  }
}

/// [LIST-EMBED-1] "We got it, here is what happens next." Shown once, on the
/// hop straight out of the listing form.
class _SubmittedBanner extends StatelessWidget {
  const _SubmittedBanner();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s3, Msg.s4, Msg.s3),
      color: AD.haldi,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Sent for review', style: ADText.rowName()),
        const SizedBox(height: Msg.s1),
        Text(
          'Your listing is with the team. You will get a notification when it goes live.',
          style: ADText.preview(c: AD.textPrimary),
        ),
      ]),
    );
  }
}

class _MyListingRow extends StatelessWidget {
  final ListingCard card;
  final VoidCallback onChanged;
  const _MyListingRow({required this.card, required this.onChanged});

  Future<void> _setStatus(BuildContext context, String status, String event) async {
    Analytics.capture(event, {'listing_id': card.id});
    final res = await ListingsApi.setStatus(card.id, status);
    if (!context.mounted) return;
    if (res['ok'] == true) {
      onChanged();
    } else {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not update listing.')));
    }
  }

  Future<void> _edit(BuildContext context) async {
    // Full Zine-themed editor (pic 5). Editing bumps the listing's content
    // version server-side, reopening the talk-once-per-version gate (Specs §3 B).
    final saved = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => EditListingScreen(listingId: card.id)),
    );
    if (saved == true) onChanged();
  }

  @override
  Widget build(BuildContext context) {
    final sold = card.status == 'completed' || card.status == 'sold';
    return AdCard(
      padding: EdgeInsets.zero,
      child: ListTile(
        leading: card.coverUrl != null
            ? CachedImage(card.coverUrl!, width: 48, height: 48, radius: BorderRadius.circular(Msg.rSm))
            : PhosphorIcon(PhosphorIcons.package(PhosphorIconsStyle.regular), size: 32, color: AD.textTertiary),
        title: Text(card.title, maxLines: 1, overflow: TextOverflow.ellipsis,
            style: ADText.rowName()),
        // [LIST-EMBED-1] A listing waiting on (or turned back by) review gets a
        // chip, not a word buried after a interpunct. This is the line the
        // creator reads the moment the form closes, and "₹500 · pending_review"
        // does not tell them their listing is fine and simply queued.
        subtitle: _kNoticeStatuses.contains(card.status)
            ? Row(children: [
                Flexible(child: Text(card.displayPrice, style: ADText.preview(), overflow: TextOverflow.ellipsis)),
                const SizedBox(width: Msg.s2),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: Msg.s2, vertical: 2),
                  decoration: BoxDecoration(
                    color: _statusChipColor(card.status),
                    borderRadius: Msg.brPill,
                  ),
                  child: Text(
                    _statusLabel(card.status),
                    style: ADText.preview(
                      c: card.status == 'rejected' ? AD.destructiveInk : AD.textPrimary,
                    ),
                  ),
                ),
              ])
            : Text('${card.displayPrice} · ${_statusLabel(card.status)}',
                style: ADText.preview()),
        trailing: PopupMenuButton<String>(
          color: AD.menu,
          iconColor: AD.textSecondary,
          onSelected: (v) {
            switch (v) {
              case 'edit': _edit(context); break;
              case 'sold': _setStatus(context, 'completed', 'listing_marked_sold'); break;
              case 'renew': _setStatus(context, 'live', 'listing_renewed'); break;
              case 'delete': _setStatus(context, 'cancelled', 'listing_deleted'); break;
            }
          },
          itemBuilder: (_) => [
            PopupMenuItem(value: 'edit', child: Text('Edit', style: ADText.rowName())),
            if (!sold) PopupMenuItem(value: 'sold', child: Text('Mark sold', style: ADText.rowName())),
            PopupMenuItem(value: 'renew', child: Text('Renew', style: ADText.rowName())),
            PopupMenuItem(value: 'delete', child: Text('Delete', style: ADText.rowName(c: AD.danger))),
          ],
        ),
      ),
    );
  }
}

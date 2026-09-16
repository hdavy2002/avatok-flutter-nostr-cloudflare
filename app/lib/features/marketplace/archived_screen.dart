
import '../../core/localization/ui_text.dart';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/cached_image.dart';
import '../../core/listings_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/motion/motion.dart';

/// AvaMarketplace — Archived. Shows the owner's expired + cancelled listings with
/// a Restore action (→ draft). Restored drafts appear in the "Drafts" section
/// where they can be re-edited (title/description/price) and re-published, which
/// puts them back in the marketplace with a fresh expiry date.
class ArchivedScreen extends StatefulWidget {
  const ArchivedScreen({super.key});
  @override
  State<ArchivedScreen> createState() => _ArchivedScreenState();
}

class _ArchivedScreenState extends State<ArchivedScreen> {
  late Future<List<ListingCard>> _future;

  @override
  void initState() {
    super.initState();
    Analytics.capture('marketplace_archived_opened');
    _future = ListingsApi.mine();
  }

  void _reload() => setState(() => _future = ListingsApi.mine());

  bool _isArchived(ListingCard c) =>
      c.status == 'cancelled' || c.status == 'completed' || c.status == 'sold' ||
      (c.status != 'draft' && c.isExpired) ||
      // [LISTING-EXPIRY-1] A live show whose date has passed is archived even
      // before the server's expiry cron flips it to completed.
      (c.status != 'draft' && c.isEnded);

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: AppBar(
        backgroundColor: AD.headerFooter,
        foregroundColor: AD.textPrimary,
        elevation: 0,
        title: UiText(UiMessage.m_archived_bdb86505f8, style: ADText.appTitle()),
      ),
      body: RefreshIndicator(
        onRefresh: () async => _reload(),
        child: FutureBuilder<List<ListingCard>>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return const Center(child: CircularProgressIndicator());
            }
            final all = snap.data ?? const <ListingCard>[];
            // Only marketplace listings belong here.
            final mine = all.where((c) => c.isMarketplace).toList();
            final drafts = mine.where((c) => c.status == 'draft').toList();
            final archived = mine.where(_isArchived).toList();
            if (drafts.isEmpty && archived.isEmpty) {
              return ListView(children: [
                const SizedBox(height: 120),
                Center(child: UiText(UiMessage.m_nothing_archived_yet_446f44e5b1, style: ADText.preview())),
              ]);
            }
            return ListView(padding: const EdgeInsets.all(Msg.s3), children: [
              if (drafts.isNotEmpty) ...[
                const _SectionHeader('Restored drafts'),
                for (final c in drafts) _Row(card: c, draft: true, onChanged: _reload),
              ],
              if (archived.isNotEmpty) ...[
                const _SectionHeader('Expired & removed'),
                for (final c in archived) _Row(card: c, draft: false, onChanged: _reload),
              ],
            ]);
          },
        ),
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  final String text;
  const _SectionHeader(this.text);
  @override
  Widget build(BuildContext context) { UiLocaleScope.watch(context); return Padding(
        padding: const EdgeInsets.fromLTRB(Msg.s1, Msg.s3, Msg.s1, Msg.s2),
        child: Text(text, style: ADText.sectionLabel()),
      ); }
}

class _Row extends StatelessWidget {
  final ListingCard card;
  final bool draft;
  final VoidCallback onChanged;
  const _Row({required this.card, required this.draft, required this.onChanged});

  String get _label {
    if (draft) return 'Draft';
    if (card.status == 'cancelled') return 'Removed';
    // [LISTING-EXPIRY-1] A completed SHOW ended; only a goods listing is "Sold".
    if (card.kind == 'live_event' && (card.status == 'completed' || card.isEnded)) return 'Ended';
    if (card.status == 'completed' || card.status == 'sold') return 'Sold';
    if (card.isExpired) return 'Expired';
    return card.status;
  }

  Future<void> _restore(BuildContext context) async {
    Analytics.capture('listing_restored', {'listing_id': card.id});
    final res = await ListingsApi.setStatus(card.id, 'draft');
    if (!context.mounted) return;
    if (res['ok'] == true) {
      onChanged();
    } else {
      showAdToast(context, message: uiCopy(UiMessage.m_could_not_restore_ee978500eb));
    }
  }

  Future<void> _deleteForever(BuildContext context) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AD.popover,
        title: UiText(UiMessage.m_delete_forever_2f3298c7b4, style: ADText.threadName()),
        content: UiText(UiMessage.m_this_permanently_removes_the_listing_852e091c2a,
            style: ADText.preview()),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false),
              child: UiText(UiMessage.m_cancel_19766ed6cc, style: TextStyle(color: AD.textSecondary, fontFamily: ADText.family, fontWeight: FontWeight.w600))),
          AdButton(label: uiCopy(UiMessage.m_delete_e2d0a54968), variant: AdButtonVariant.danger, onPressed: () => Navigator.pop(ctx, true)),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    Analytics.capture('listing_deleted_permanent', {'listing_id': card.id});
    final done = await ListingsApi.cancel(card.id, permanent: true);
    if (!context.mounted) return;
    if (done) {
      onChanged();
    } else {
      showAdToast(context, message: uiCopy(UiMessage.m_could_not_delete_20a52cfad4));
    }
  }

  Future<void> _republish(BuildContext context) async {
    Analytics.capture('listing_republished', {'listing_id': card.id});
    final res = await ListingsApi.publish(card.id);
    if (!context.mounted) return;
    if (res['ok'] == true) {
      showAdToast(context, message: uiCopy(UiMessage.m_re_published_with_a_fresh_caf05c7e77));
      onChanged();
    } else {
      showAdToast(context, message: res['error']?.toString() ?? res['reason']?.toString() ?? 'Could not publish.');
    }
  }

  Future<void> _edit(BuildContext context) async {
    final title = TextEditingController(text: card.title);
    final desc = TextEditingController(text: card.description ?? card.oneLiner);
    final price = TextEditingController(text: card.price.toString());
    InputDecoration deco(String label) => InputDecoration(
          labelText: label,
          labelStyle: TextStyle(color: AD.placeholderOnWhite),
          filled: true,
          fillColor: AD.inputField,
          isDense: true,
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(AD.rInput), borderSide: BorderSide(color: AD.borderControl, width: 1)),
          enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(AD.rInput), borderSide: BorderSide(color: AD.borderControl, width: 1)),
          focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(AD.rInput), borderSide: BorderSide(color: AD.iconSearch, width: 1)),
        );
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AD.overlaySheet,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom + 16, left: 16, right: 16, top: 16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          UiText(UiMessage.m_edit_draft_4452cbdbee, style: ADText.threadName()),
          const SizedBox(height: Msg.s3),
          TextField(controller: title, decoration: deco('Title')),
          const SizedBox(height: Msg.s3),
          TextField(controller: desc, maxLines: 3, decoration: deco('Description')),
          const SizedBox(height: Msg.s3),
          TextField(controller: price, keyboardType: TextInputType.number, decoration: deco('Price')),
          const SizedBox(height: Msg.s3),
          AdButton(label: uiCopy(UiMessage.m_save_1509f561f2), fullWidth: true, onPressed: () => Navigator.of(ctx).pop(true)),
        ]),
      ),
    );
    if (saved != true || !context.mounted) return;
    final ok = await ListingsApi.update(card.id, {
      'title': title.text.trim(),
      'description': desc.text.trim(),
      'price_amount': int.tryParse(price.text.trim()) ?? card.price,
    });
    if (!context.mounted) return;
    showAdToast(context, message: ok ? 'Saved.' : 'Could not save.');
    if (ok) onChanged();
  }

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return AdCard(
      padding: EdgeInsets.zero,
      child: ListTile(
        leading: card.coverUrl != null
            ? CachedImage(card.coverUrl!, width: 48, height: 48, radius: BorderRadius.circular(Msg.rSm))
            : PhosphorIcon(PhosphorIcons.package(PhosphorIconsStyle.regular), size: 32, color: AD.textTertiary),
        title: Text(card.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.rowName()),
        subtitle: Text('${card.displayPrice} · $_label', style: ADText.preview()),
        trailing: draft
            ? Wrap(spacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
                IconButton(tooltip: uiCopy(UiMessage.m_edit_464c4ffd01), icon: PhosphorIcon(PhosphorIcons.pencilSimple(PhosphorIconsStyle.regular), color: AD.textSecondary), onPressed: () => _edit(context)),
                AdButton(label: uiCopy(UiMessage.m_publish_859390eb49), fontSize: 13, onPressed: () => _republish(context)),
              ])
            : Wrap(crossAxisAlignment: WrapCrossAlignment.center, children: [
                TextButton(onPressed: () => _restore(context),
                    child: UiText(UiMessage.m_restore_a76e13b983, style: TextStyle(color: AD.iconSearch, fontFamily: ADText.family, fontWeight: FontWeight.w600))),
                IconButton(tooltip: uiCopy(UiMessage.m_delete_forever_42b4896de1), icon: PhosphorIcon(PhosphorIcons.trash(PhosphorIconsStyle.regular), color: AD.danger), onPressed: () => _deleteForever(context)),
              ]),
      ),
    );
  }
}

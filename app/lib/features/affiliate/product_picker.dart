import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'affiliate_api.dart';
import 'link_created_sheet.dart';
import 'widgets.dart';

/// Product Picker — browse/search promotable listings across AvaLive,
/// AvaConsult and AvaVoice; tap "Create my link" to mint the link + QR.
class ProductPickerScreen extends StatefulWidget {
  const ProductPickerScreen({super.key});
  @override
  State<ProductPickerScreen> createState() => _ProductPickerScreenState();
}

class _ProductPickerScreenState extends State<ProductPickerScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: kAffApps.length, vsync: this);
  final Map<String, List<AffiliateListing>> _byApp = {};
  final Set<String> _loadingApps = {};
  String _q = '';
  String? _creatingId; // listing currently minting a link

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avaaffiliate', 'product_picker');
    _tabs.addListener(() {
      if (mounted) setState(() {}); // repaint the chip row
      if (!_tabs.indexIsChanging) _load(kAffApps[_tabs.index].key);
    });
    _load(kAffApps.first.key);
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  Future<void> _load(String appKey) async {
    setState(() => _loadingApps.add(appKey));
    try {
      final l = await AffiliateApi.listings(app: appKey, q: _q.isEmpty ? null : _q);
      if (!mounted) return;
      setState(() => _byApp[appKey] = l);
    } catch (_) {
      if (mounted) setState(() => _byApp.putIfAbsent(appKey, () => []));
    } finally {
      if (mounted) setState(() => _loadingApps.remove(appKey));
    }
  }

  Future<void> _createLink(AffiliateListing l) async {
    setState(() => _creatingId = l.id);
    final link = await AffiliateApi.createLink(l.id);
    if (!mounted) return;
    setState(() => _creatingId = null);
    if (link == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Could not create the link — please try again.')));
      return;
    }
    Analytics.capture('affiliate_link_created', {
      'link_id': link.id, 'listing_id': l.id, 'app': l.app, 'listing_price': l.price,
    });
    await showLinkCreatedSheet(context, link);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'Pick a product', markWord: 'product', tag: 'promote & earn'),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 14, 18, 10),
          child: ZineField(
            hint: 'Search listings or creators…',
            leadIcon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
            onSubmitted: (v) {
              _q = v;
              _load(kAffApps[_tabs.index].key);
            },
          ),
        ),
        // App chips drive the existing TabController (§7.4).
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 0, 18, 10),
          child: Row(children: [
            for (var i = 0; i < kAffApps.length; i++) ...[
              Expanded(child: ZineChip(
                label: kAffApps[i].label,
                active: _tabs.index == i,
                onTap: () => _tabs.animateTo(i),
              )),
              if (i != kAffApps.length - 1) const SizedBox(width: 9),
            ],
          ]),
        ),
        Expanded(
          child: TabBarView(controller: _tabs, children: [
            for (final a in kAffApps) _list(a.key),
          ]),
        ),
      ]),
    );
  }

  Widget _list(String appKey) {
    final items = _byApp[appKey];
    if (items == null || _loadingApps.contains(appKey)) {
      return const Center(child: CircularProgressIndicator(color: Zine.blueInk));
    }
    if (items.isEmpty) {
      return AffEmpty(_q.isEmpty
          ? 'No promotable listings here yet.\nCheck back soon!'
          : 'Nothing matches "$_q".');
    }
    return RefreshIndicator(
      onRefresh: () => _load(appKey),
      color: Zine.blueInk,
      child: ListView.separated(
        padding: const EdgeInsets.fromLTRB(18, 10, 18, 24),
        itemCount: items.length,
        separatorBuilder: (_, __) => const SizedBox(height: 12),
        itemBuilder: (_, i) => ListingPickCard(
          listing: items[i],
          busy: _creatingId == items[i].id,
          onCreateLink: () => _createLink(items[i]),
        ),
      ),
    );
  }
}

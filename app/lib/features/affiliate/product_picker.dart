import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/theme.dart';
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
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink,
        title: const Text('Pick a product to promote'),
        bottom: TabBar(
          controller: _tabs,
          labelColor: kAffiliateOrange,
          indicatorColor: kAffiliateOrange,
          unselectedLabelColor: AvaColors.sub,
          labelStyle: const TextStyle(fontWeight: FontWeight.w800),
          tabs: [for (final a in kAffApps) Tab(text: a.label)],
        ),
      ),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
          child: TextField(
            decoration: InputDecoration(
              hintText: 'Search listings or creators…',
              prefixIcon: const Icon(Icons.search),
              isDense: true,
              filled: true, fillColor: AvaColors.soft,
              border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(14), borderSide: BorderSide.none),
            ),
            onSubmitted: (v) {
              _q = v;
              _load(kAffApps[_tabs.index].key);
            },
          ),
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
      return const Center(child: CircularProgressIndicator());
    }
    if (items.isEmpty) {
      return AffEmpty(_q.isEmpty
          ? 'No promotable listings here yet.\nCheck back soon!'
          : 'Nothing matches "$_q".');
    }
    return RefreshIndicator(
      onRefresh: () => _load(appKey),
      child: ListView.separated(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 24),
        itemCount: items.length,
        separatorBuilder: (_, __) => const SizedBox(height: 10),
        itemBuilder: (_, i) => ListingPickCard(
          listing: items[i],
          busy: _creatingId == items[i].id,
          onCreateLink: () => _createLink(items[i]),
        ),
      ),
    );
  }
}

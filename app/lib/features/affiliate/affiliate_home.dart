import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/remote_config.dart';
import '../../core/theme.dart';
import '../identity/identity_screen.dart';
import 'affiliate_api.dart';
import 'earnings_screen.dart';
import 'link_detail_screen.dart';
import 'product_picker.dart';
import 'widgets.dart';

/// AvaAffiliate landing — Spec: Specs/proposals/PROPOSAL-AVA-AFFILIATE.md §7.
/// Not yet an affiliate → "Earn 10% for life" hero + Become an Affiliate.
/// Already an affiliate → the Dashboard (headline cards + per-link list).
/// Everything gated by the `avaAffiliateEnabled` kill switch.
class AffiliateHomeScreen extends StatefulWidget {
  const AffiliateHomeScreen({super.key});
  @override
  State<AffiliateHomeScreen> createState() => _AffiliateHomeScreenState();
}

class _AffiliateHomeScreenState extends State<AffiliateHomeScreen> {
  AffiliateMe? _me;       // null until first paint (cache or network)
  bool _meKnown = false;  // true once we know affiliate-or-not for sure
  bool _loadFailed = false; // network down AND nothing cached
  List<AffiliateLink>? _links;
  bool _registering = false;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avaaffiliate', 'home');
    _load();
  }

  Future<void> _load() async {
    // Instant paint from the per-account cache, then server truth.
    final cached = await AffiliateApi.cachedMe();
    if (mounted && cached != null && _me == null) setState(() => _me = cached);
    final me = await AffiliateApi.me();
    if (!mounted) return;
    if (me != null) {
      setState(() { _me = me; _meKnown = true; });
      if (me.affiliate != null) {
        Analytics.capture('affiliate_dashboard_viewed', {
          'links': _links?.length ?? -1,
          'lifetime_coins': me.totals.lifetimeCoins,
        });
        _loadLinks();
      }
    } else {
      setState(() {
        _meKnown = _me != null;
        _loadFailed = _me == null;
      });
      if (_me?.affiliate != null) _loadLinks();
    }
  }

  Future<void> _loadLinks() async {
    try {
      final l = await AffiliateApi.links();
      if (mounted) setState(() => _links = l);
    } catch (_) {
      if (mounted) setState(() => _links ??= []);
    }
  }

  Future<void> _register() async {
    setState(() => _registering = true);
    Analytics.capture('affiliate_signup_started', {});
    final r = await AffiliateApi.register();
    if (!mounted) return;
    setState(() => _registering = false);
    if (r['ok'] == true) {
      Analytics.capture('affiliate_signup_completed', {});
      setState(() { _me = r['me'] as AffiliateMe; _meKnown = true; _links = []; });
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Welcome aboard! Pick a product to start earning.')));
      _openPicker();
      return;
    }
    if (r['status'] == 403) {
      // Below Trust Ladder L1 → route into the existing email-verify upgrade
      // flow (AvaIdentity is the one-stop identity hub).
      final go = await showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
          title: const Text('Verify your email first'),
          content: const Text(
              'Becoming an affiliate just needs a verified email + password '
              '(free, takes a minute). Verify now?'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Not now')),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Verify email')),
          ],
        ),
      );
      if (go == true && mounted) {
        await Navigator.push(context,
            MaterialPageRoute(builder: (_) => const IdentityScreen()));
        if (mounted) _load();
      }
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(r['error'] == 'network'
            ? 'No connection — please try again.'
            : 'Could not register right now — please try again later.')));
  }

  void _openPicker() {
    Navigator.push(context,
            MaterialPageRoute(builder: (_) => const ProductPickerScreen()))
        .then((_) => _load());
  }

  bool get _isAffiliate => _me?.affiliate != null;

  @override
  Widget build(BuildContext context) {
    if (!RemoteConfig.avaAffiliateEnabled) {
      return Scaffold(
        appBar: AppBar(title: const Text('AvaAffiliate')),
        body: const AffEmpty(
            'AvaAffiliate is not available yet. Please check back soon.'),
      );
    }
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink,
        title: Row(children: [
          Container(width: 30, height: 30,
              decoration: BoxDecoration(
                  color: kAffiliateOrange.withValues(alpha: .14),
                  borderRadius: BorderRadius.circular(9)),
              child: const Icon(Icons.campaign, size: 18, color: kAffiliateOrange)),
          const SizedBox(width: 10),
          const Text('AvaAffiliate'),
        ]),
        actions: [
          if (_isAffiliate)
            IconButton(
              tooltip: 'Earnings & payout',
              icon: const Icon(Icons.payments_outlined),
              onPressed: () => Navigator.push(context, MaterialPageRoute(
                  builder: (_) => AffiliateEarningsScreen(
                      totals: _me?.totals ?? const AffiliateTotals.zero()))),
            ),
        ],
      ),
      body: _loadFailed && _me == null
          ? Center(
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                const Text('Could not reach the server.',
                    style: TextStyle(color: AvaColors.sub)),
                const SizedBox(height: 10),
                OutlinedButton(
                    onPressed: () { setState(() => _loadFailed = false); _load(); },
                    child: const Text('Retry')),
              ]),
            )
          : !_meKnown && _me == null
              ? const Center(child: CircularProgressIndicator())
              : _isAffiliate
                  ? _dashboard()
                  : _landing(),
    );
  }

  // ── landing (not an affiliate yet) ─────────────────────────────────────────
  Widget _landing() {
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 32),
      children: [
        Container(
          padding: const EdgeInsets.all(22),
          decoration: BoxDecoration(
            gradient: kAffiliateGradient,
            borderRadius: BorderRadius.circular(22),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Icon(Icons.campaign, color: Colors.white, size: 38),
            const SizedBox(height: 12),
            Text('Earn 10% for life',
                style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                    color: Colors.white, fontWeight: FontWeight.w800)),
            const SizedBox(height: 8),
            const Text(
              'Promote any creator listing on AvaLive, AvaConsult or AvaVoice. '
              'Every user who joins through your link earns you 10% of '
              'everything they ever spend on it — paid instantly to your AvaWallet.',
              style: TextStyle(color: Colors.white, fontSize: 13.5, height: 1.45,
                  fontWeight: FontWeight.w600),
            ),
          ]),
        ),
        const SizedBox(height: 20),
        _how(Icons.storefront, 'Pick a product',
            'Browse listings across the three apps and grab your unique link + QR.'),
        _how(Icons.ios_share, 'Share anywhere',
            'Stories, group chats, print the QR — every signup binds to you for life.'),
        _how(Icons.account_balance_wallet, 'Get paid instantly',
            'Commission lands in your AvaWallet the moment a referred purchase settles. The creator\'s share is never touched.'),
        const SizedBox(height: 20),
        FilledButton(
          style: FilledButton.styleFrom(backgroundColor: kAffiliateOrange,
              padding: const EdgeInsets.symmetric(vertical: 16)),
          onPressed: _registering ? null : _register,
          child: _registering
              ? const SizedBox(width: 20, height: 20,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
              : const Text('Become an Affiliate'),
        ),
        const SizedBox(height: 8),
        const Text('Free to join. All you need is a verified email.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, color: AvaColors.sub)),
      ],
    );
  }

  Widget _how(IconData icon, String title, String body) => Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Container(width: 40, height: 40,
              decoration: BoxDecoration(
                  color: kAffiliateOrange.withValues(alpha: .12),
                  borderRadius: BorderRadius.circular(12)),
              child: Icon(icon, color: kAffiliateOrange, size: 20)),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14.5)),
            const SizedBox(height: 2),
            Text(body, style: const TextStyle(fontSize: 12.5, color: AvaColors.sub, height: 1.35)),
          ])),
        ]),
      );

  // ── dashboard (affiliate) ──────────────────────────────────────────────────
  Widget _dashboard() {
    final t = _me?.totals ?? const AffiliateTotals.zero();
    final code = _me?.affiliate?.code ?? '';
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
        children: [
          if (code.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Text('Affiliate code: $code',
                  style: const TextStyle(fontSize: 12, color: AvaColors.sub,
                      fontWeight: FontWeight.w700)),
            ),
          Row(children: [
            Expanded(child: StatCard(label: 'Lifetime earned', icon: Icons.emoji_events,
                color: kAffiliateOrange, value: affCoinsLabel(t.lifetimeCoins),
                sub: '${t.lifetimeCoins} coins')),
            const SizedBox(width: 10),
            Expanded(child: StatCard(label: 'This month', icon: Icons.calendar_month,
                color: AvaColors.brand, value: affCoinsLabel(t.monthCoins))),
          ]),
          const SizedBox(height: 10),
          Row(children: [
            Expanded(child: StatCard(label: 'Held (refund window)', icon: Icons.hourglass_top,
                color: AvaColors.sub, value: affCoinsLabel(t.heldCoins))),
            const SizedBox(width: 10),
            Expanded(child: StatCard(label: 'Referred users', icon: Icons.group,
                color: AvaColors.success, value: '${t.referredUsers}')),
          ]),
          const SizedBox(height: 14),
          FilledButton.icon(
            style: FilledButton.styleFrom(backgroundColor: kAffiliateOrange,
                padding: const EdgeInsets.symmetric(vertical: 14)),
            icon: const Icon(Icons.add_link, size: 18),
            label: const Text('Promote a new product'),
            onPressed: _openPicker,
          ),
          const SizedBox(height: 20),
          Row(children: [
            const Text('My links',
                style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
            const Spacer(),
            TextButton(
              onPressed: () => Navigator.push(context, MaterialPageRoute(
                  builder: (_) => AffiliateEarningsScreen(totals: t))),
              child: const Text('Earnings →', style: TextStyle(fontSize: 12.5)),
            ),
          ]),
          if (_links == null)
            const Padding(padding: EdgeInsets.all(28),
                child: Center(child: CircularProgressIndicator()))
          else if (_links!.isEmpty)
            const AffEmpty('No links yet.\nPromote a product to mint your first link + QR.')
          else
            ...(_links!..sort((a, b) => b.earnedCoins.compareTo(a.earnedCoins)))
                .map((l) => LinkRow(
                      link: l,
                      onTap: () => Navigator.push(context, MaterialPageRoute(
                              builder: (_) => LinkDetailScreen(link: l)))
                          .then((_) => _load()),
                    )),
        ],
      ),
    );
  }
}

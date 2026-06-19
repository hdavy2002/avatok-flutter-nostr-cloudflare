import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/remote_config.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../identity/identity_screen.dart';
import 'affiliate_api.dart';
import 'earnings_screen.dart';
import 'link_detail_screen.dart';
import 'product_picker.dart';

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
          backgroundColor: Zine.card,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Zine.r),
            side: const BorderSide(color: Zine.ink, width: Zine.bw),
          ),
          title: Text('Verify your email first', style: ZineText.cardTitle()),
          content: Text(
              'Becoming an affiliate just needs a verified email + password '
              '(free, takes a minute). Verify now?',
              style: ZineText.sub(size: 14)),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false),
                child: Text('Not now', style: ZineText.link(size: 14, color: Zine.inkSoft))),
            ZineButton(label: 'Verify email', fontSize: 15,
                onPressed: () => Navigator.pop(c, true)),
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

  /// Phosphor icon + accent per promotable app (zine accent rotation).
  (IconData, Color, String) _appMeta(String key) => switch (key) {
        'avalive' => (PhosphorIcons.broadcast(PhosphorIconsStyle.bold), Zine.coral, 'AvaLive'),
        'avaconsult' => (PhosphorIcons.videoCamera(PhosphorIconsStyle.bold), Zine.blue, 'AvaConsult'),
        'avavoice' => (PhosphorIcons.microphone(PhosphorIconsStyle.bold), Zine.lilac, 'AvaVoice'),
        _ => (PhosphorIcons.broadcast(PhosphorIconsStyle.bold), Zine.coral, 'AvaLive'),
      };

  @override
  Widget build(BuildContext context) {
    if (!RemoteConfig.avaAffiliateEnabled) {
      return Scaffold(
        backgroundColor: Zine.paper,
        appBar: const ZineAppBar(title: 'AvaAffiliate', markWord: 'Affiliate'),
        body: Center(
          child: ZineEmptyState(
            icon: PhosphorIcons.megaphone(PhosphorIconsStyle.bold),
            text: 'AvaAffiliate is not available yet. Please check back soon.',
          ),
        ),
      );
    }
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: 'AvaAffiliate',
        markWord: 'Affiliate',
        tag: 'earn 10% for life',
        actions: [
          if (_isAffiliate)
            ZineBackButton(
              icon: PhosphorIcons.coins(PhosphorIconsStyle.bold),
              onTap: () => Navigator.push(context, MaterialPageRoute(
                  builder: (_) => AffiliateEarningsScreen(
                      totals: _me?.totals ?? const AffiliateTotals.zero()))),
            ),
        ],
      ),
      body: _loadFailed && _me == null
          ? Center(
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                ZineEmptyState(
                  icon: PhosphorIcons.wifiSlash(PhosphorIconsStyle.bold),
                  text: 'Could not reach the server.',
                ),
                const SizedBox(height: 14),
                ZineButton(
                  label: 'Retry',
                  variant: ZineButtonVariant.ghost,
                  fontSize: 16,
                  onPressed: () { setState(() => _loadFailed = false); _load(); },
                ),
              ]),
            )
          : !_meKnown && _me == null
              ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
              : _isAffiliate
                  ? _dashboard()
                  : _landing(),
    );
  }

  // ── landing (not an affiliate yet) ─────────────────────────────────────────
  Widget _landing() {
    return ListView(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 32),
      children: [
        // Hero — mint money card (§7.3 accent fill), hard offset shadow.
        ZineCard(
          color: Zine.mint,
          padding: const EdgeInsets.all(20),
          boxShadow: Zine.shadow,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ZineIconBadge(icon: PhosphorIcons.megaphone(PhosphorIconsStyle.bold),
                color: Zine.card, size: 42),
            const SizedBox(height: 14),
            Text('Earn 10% for life', style: ZineText.hero(size: 30)),
            const SizedBox(height: 10),
            Text(
              'Promote any creator listing on AvaLive, AvaConsult or AvaVoice. '
              'Every user who joins through your link earns you 10% of '
              'everything they ever spend on it — paid instantly to your AvaWallet.',
              style: ZineText.sub(size: 13.5, color: Zine.ink),
            ),
          ]),
        ),
        const SizedBox(height: 22),
        _how(PhosphorIcons.storefront(PhosphorIconsStyle.bold), Zine.blue, 'Pick a product',
            'Browse listings across the three apps and grab your unique link + QR.'),
        _how(PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold), Zine.lilac, 'Share anywhere',
            'Stories, group chats, print the QR — every signup binds to you for life.'),
        _how(PhosphorIcons.wallet(PhosphorIconsStyle.bold), Zine.mint, 'Get paid instantly',
            'Commission lands in your AvaWallet the moment a referred purchase settles. The creator\'s share is never touched.'),
        const SizedBox(height: 20),
        ZineButton(
          label: 'Become an Affiliate',
          fullWidth: true,
          fontSize: 21,
          loading: _registering,
          onPressed: _registering ? null : _register,
        ),
        const SizedBox(height: 10),
        Text('FREE TO JOIN. ALL YOU NEED IS A VERIFIED EMAIL.',
            textAlign: TextAlign.center,
            style: ZineText.kicker(size: 10, color: Zine.inkMute)),
      ],
    );
  }

  Widget _how(IconData icon, Color accent, String title, String body) => Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          ZineIconBadge(icon: icon, color: accent, size: 40),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ZineText.cardTitle(size: 16)),
            const SizedBox(height: 3),
            Text(body, style: ZineText.sub(size: 12.5)),
          ])),
        ]),
      );

  // ── dashboard (affiliate) ──────────────────────────────────────────────────
  Widget _dashboard() {
    final t = _me?.totals ?? const AffiliateTotals.zero();
    final code = _me?.affiliate?.code ?? '';
    return RefreshIndicator(
      onRefresh: _load,
      color: Zine.blueInk,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(18, 14, 18, 32),
        children: [
          // Share-code row with copy button (bordered circle).
          if (code.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: ZineCard(
                radius: Zine.rSm,
                padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
                boxShadow: Zine.shadowXs,
                child: Row(children: [
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('AFFILIATE CODE', style: ZineText.kicker(size: 9.5)),
                      const SizedBox(height: 2),
                      Text(code, maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: ZineText.tag(size: 15)),
                    ]),
                  ),
                  ZineBackButton(
                    icon: PhosphorIcons.copy(PhosphorIconsStyle.bold),
                    onTap: () {
                      Clipboard.setData(ClipboardData(text: code));
                      ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('Affiliate code copied.')));
                    },
                  ),
                ]),
              ),
            ),
          // Metric cards (§7.11) — accent rotation.
          Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Expanded(child: _stat('Lifetime earned', affCoinsLabel(t.lifetimeCoins),
                PhosphorIcons.trophy(PhosphorIconsStyle.bold), Zine.mint,
                money: true, sub: '${t.lifetimeCoins} coins')),
            const SizedBox(width: 12),
            Expanded(child: _stat('This month', affCoinsLabel(t.monthCoins),
                PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold), Zine.lime, money: true)),
          ]),
          const SizedBox(height: 12),
          Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Expanded(child: _stat('Held (refund window)', affCoinsLabel(t.heldCoins),
                PhosphorIcons.hourglass(PhosphorIconsStyle.bold), Zine.lilac)),
            const SizedBox(width: 12),
            Expanded(child: _stat('Referred users', '${t.referredUsers}',
                PhosphorIcons.usersThree(PhosphorIconsStyle.bold), Zine.blue)),
          ]),
          const SizedBox(height: 16),
          ZineButton(
            label: 'Promote a new product',
            fullWidth: true,
            icon: PhosphorIcons.linkSimple(PhosphorIconsStyle.bold),
            trailingIcon: false,
            onPressed: _openPicker,
          ),
          const SizedBox(height: 24),
          Row(children: [
            Expanded(child: Text('MY LINKS', style: ZineText.kicker(size: 11.5))),
            ZineLink('EARNINGS →', onTap: () => Navigator.push(context, MaterialPageRoute(
                builder: (_) => AffiliateEarningsScreen(totals: t)))),
          ]),
          const SizedBox(height: 10),
          if (_links == null)
            const Padding(padding: EdgeInsets.all(28),
                child: Center(child: CircularProgressIndicator(color: Zine.blueInk)))
          else if (_links!.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 20),
              child: Center(
                child: ZineEmptyState(
                  icon: PhosphorIcons.linkSimple(PhosphorIconsStyle.bold),
                  text: 'No links yet.\nPromote a product to mint your first link + QR.',
                ),
              ),
            )
          else
            ...(_links!..sort((a, b) => b.earnedCoins.compareTo(a.earnedCoins)))
                .map(_linkRow),
        ],
      ),
    );
  }

  /// Metric card (§7.11): icon badge + Nunito number + mono caption.
  Widget _stat(String label, String value, IconData icon, Color accent,
          {bool money = false, String? sub}) =>
      ZineCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.all(14),
        boxShadow: Zine.shadowXs,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          ZineIconBadge(icon: icon, color: accent, size: 30),
          const SizedBox(height: 10),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(value, style: ZineText.stat(size: 24, color: money ? Zine.mintInk : Zine.ink)),
          ),
          const SizedBox(height: 3),
          Text(label.toUpperCase(), maxLines: 1, overflow: TextOverflow.ellipsis,
              style: ZineText.kicker(size: 9.5)),
          if (sub != null)
            Text(sub.toUpperCase(), style: ZineText.kicker(size: 9, color: Zine.inkMute)),
        ]),
      );

  /// Per-link performance row — zine card row.
  Widget _linkRow(AffiliateLink l) {
    final (icon, accent, _) = _appMeta(l.app);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: ZineCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.all(12),
        boxShadow: Zine.shadowXs,
        onTap: () => Navigator.push(context, MaterialPageRoute(
                builder: (_) => LinkDetailScreen(link: l)))
            .then((_) => _load()),
        child: Row(children: [
          ZineIconBadge(icon: icon, color: accent, size: 40),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(
                  child: Text(l.title, maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: ZineText.value(size: 14)),
                ),
                if (l.paused) ...[
                  const SizedBox(width: 6),
                  const ZineSticker('paused', kind: ZineStickerKind.hint),
                ],
              ]),
              const SizedBox(height: 3),
              Text('${l.clicks} clicks · ${l.binds} referred'.toUpperCase(),
                  style: ZineText.kicker(size: 9.5, color: Zine.inkMute)),
            ]),
          ),
          const SizedBox(width: 10),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text(affCoinsLabel(l.earnedCoins),
                style: ZineText.value(size: 14.5, weight: FontWeight.w900, color: Zine.mintInk)),
            Text('EARNED', style: ZineText.kicker(size: 9, color: Zine.inkMute)),
          ]),
        ]),
      ),
    );
  }
}

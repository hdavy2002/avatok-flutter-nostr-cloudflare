import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/subscribe_api.dart';
import '../../core/play_billing.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// SubscribeScreen — Phase 1 plans (Free / Plus / Pro / Max).
///
/// Renders the SERVER-OWNED plan matrix as four cards and starts checkout:
///   • Web    → opens the Stripe subscription checkout URL.
///   • Android→ Google Play Billing (native; wiring pending — shows a notice).
/// While `billingEnabled` is off server-side, checkout returns a friendly
/// "launching soon" notice so the screen works as a preview today.
class SubscribeScreen extends StatefulWidget {
  const SubscribeScreen({super.key});
  @override
  State<SubscribeScreen> createState() => _SubscribeScreenState();
}

class _SubscribeScreenState extends State<SubscribeScreen> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _plans = const [];
  int _currentTier = 0;
  String _currentStatus = 'none';
  int? _busyTier; // tier whose button is mid-checkout

  static const _accents = [Zine.card, Zine.mint, Zine.blue, Zine.lilac];

  @override
  void initState() {
    super.initState();
    // Android: listen for native Play Billing results. On success the server has
    // already flipped the tier, so we just refresh the screen.
    if (!kIsWeb) {
      PlayBilling.instance.start(
        onNotice: _notice,
        onEntitled: (_) { if (mounted) _load(); },
      );
    }
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final r = await SubscribeApi.plans();
      final plans = (r['plans'] as List?)?.cast<Map<String, dynamic>>() ?? const [];
      final cur = (r['current'] as Map?)?.cast<String, dynamic>() ?? const {};
      if (!mounted) return;
      setState(() {
        _plans = plans;
        _currentTier = (cur['tier'] as num?)?.toInt() ?? 0;
        _currentStatus = (cur['status'] as String?) ?? 'none';
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() { _error = 'Could not load plans. Pull to retry.'; _loading = false; });
    }
  }

  Future<void> _subscribe(int tier) async {
    setState(() => _busyTier = tier);
    try {
      final platform = kIsWeb ? 'web' : 'android';
      final r = await SubscribeApi.checkout(tier, platform: platform);
      final reason = r['reason'];
      if (reason == 'billing_disabled') {
        _notice('Subscriptions are launching soon — thanks for the interest!');
      } else if (platform == 'web' && r['checkout_url'] is String) {
        final uri = Uri.parse(r['checkout_url'] as String);
        if (await canLaunchUrl(uri)) await launchUrl(uri, mode: LaunchMode.externalApplication);
      } else if (platform == 'android' && r['play_product_id'] is String) {
        // Launch native Play Billing; the purchase result arrives async on the
        // PlayBilling stream, which verifies server-side then refreshes via _load.
        final launched = await PlayBilling.instance.buy(r['play_product_id'] as String);
        if (!launched) _notice('Couldn’t open Google Play checkout. Please try again.');
      } else if (r['error'] != null) {
        _notice(r['error'].toString());
      }
    } catch (_) {
      _notice('Something went wrong starting checkout.');
    } finally {
      if (mounted) setState(() => _busyTier = null);
    }
  }

  void _notice(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      body: SafeArea(
        child: Column(children: [
          // Header
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 6),
            child: Row(children: [
              ZineBackButton(
                icon: PhosphorIcons.caretLeft(PhosphorIconsStyle.bold),
                onTap: () => Navigator.maybePop(context),
              ),
              const SizedBox(width: 10),
              Text('Subscribe', style: ZineText.cardTitle(size: 20)),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 0, 18, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                'Pick a plan. Upgrade or cancel anytime.',
                style: ZineText.sub(size: 13, color: Zine.inkSoft),
              ),
            ),
          ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _error != null
                    ? _ErrorState(message: _error!, onRetry: _load)
                    : RefreshIndicator(
                        onRefresh: _load,
                        child: ListView(
                          padding: const EdgeInsets.fromLTRB(14, 4, 14, 24),
                          children: [
                            for (var i = 0; i < _plans.length; i++)
                              _planCard(_plans[i], _accents[i % _accents.length]),
                          ],
                        ),
                      ),
          ),
        ]),
      ),
    );
  }

  Widget _planCard(Map<String, dynamic> plan, Color accent) {
    final tier = (plan['id'] as num?)?.toInt() ?? 0;
    final name = (plan['name'] as String?) ?? 'Plan';
    final price = (plan['priceUsd'] as num?)?.toDouble() ?? 0;
    final isCurrent = tier == _currentTier;
    final lines = _featureLines(plan);

    return Container(
      margin: const EdgeInsets.symmetric(vertical: 7),
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      decoration: BoxDecoration(
        color: isCurrent ? Zine.lime : Zine.card,
        borderRadius: BorderRadius.circular(Zine.rSm),
        border: Border.all(color: Zine.ink, width: Zine.bw),
        boxShadow: Zine.shadowSm,
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(icon: _iconFor(tier), color: accent),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(name, style: ZineText.cardTitle(size: 18)),
              Text(
                price == 0 ? 'Free forever' : '\$${price.toStringAsFixed(0)} / month',
                style: ZineText.tag(size: 12.5, color: Zine.inkSoft),
              ),
            ]),
          ),
          if (isCurrent)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                color: Zine.mint,
                borderRadius: BorderRadius.circular(100),
                border: Border.all(color: Zine.ink, width: Zine.bw),
              ),
              child: Text(
                _currentStatus == 'canceled' ? 'ENDING' : 'YOUR PLAN',
                style: ZineText.tag(size: 10.5, color: Zine.mintInk),
              ),
            ),
        ]),
        const SizedBox(height: 12),
        for (final l in lines)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), size: 14, color: Zine.inkSoft),
              const SizedBox(width: 8),
              Expanded(child: Text(l, style: ZineText.value(size: 13.5))),
            ]),
          ),
        const SizedBox(height: 8),
        if (!isCurrent && tier > 0) _cta(tier),
        if (tier == 0 && !isCurrent)
          Text('Always available', style: ZineText.tag(size: 11.5, color: Zine.inkSoft)),
      ]),
    );
  }

  Widget _cta(int tier) {
    final busy = _busyTier == tier;
    final upgrade = tier > _currentTier;
    return SizedBox(
      width: double.infinity,
      child: ZinePressable(
        onTap: busy ? null : () => _subscribe(tier),
        color: Zine.ink,
        radius: BorderRadius.circular(Zine.rSm),
        boxShadow: Zine.shadowXs,
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Center(
          child: busy
              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Zine.paper))
              : Text(
                  upgrade ? 'Upgrade to this plan' : 'Switch to this plan',
                  style: ZineText.value(size: 14.5, color: Zine.paper),
                ),
        ),
      ),
    );
  }

  // Plain-language feature lines. Ava text chat is unlimited on every tier and is
  // folded into the first line (never shown as a meter — text is cheap; we only
  // surface the costly things: AI images, AI voice/translation minutes, group
  // video calls).
  List<String> _featureLines(Map<String, dynamic> plan) {
    final caps = (plan['caps'] as Map?)?.cast<String, dynamic>() ?? const {};
    final features = (plan['features'] as Map?)?.cast<String, dynamic>() ?? const {};
    final confSize = (plan['confParticipants'] as num?)?.toInt() ?? 0;

    final out = <String>['Unlimited messaging, calls & Ava AI chat'];

    final img = caps['image'];
    out.add(img == null ? 'Unlimited AI images' : '$img AI images / day');

    final vm = caps['voice_min'];
    out.add(vm == null ? 'Unlimited AI voice-call minutes' : '$vm AI voice-call minutes / day');

    final rc = caps['recept'];
    out.add(rc == null ? 'Unlimited AI receptionist calls' : '$rc AI receptionist calls / day');

    final tr = caps['translate_min'];
    if (tr == null) {
      out.add('Unlimited live-translation minutes');
    } else if (tr > 0) {
      out.add('$tr live-translation minutes / day');
    }

    if (confSize > 0) {
      final cm = caps['conf_min'];
      final mins = cm == null ? 'unlimited minutes' : '$cm min/day';
      out.add('Group video calls up to $confSize people ($mins)');
    }

    if (features['premiumImageModel'] == true) out.add('Premium image model (Nano Banana)');
    if (features['fileAnalysis'] == true) out.add('Analyze PDFs & Excel sheets in chat');
    if (features['webSearch'] == true) out.add('Web search + memory');
    return out;
  }

  IconData _iconFor(int tier) {
    switch (tier) {
      case 1: return PhosphorIcons.rocketLaunch(PhosphorIconsStyle.bold);
      case 2: return PhosphorIcons.crown(PhosphorIconsStyle.bold);
      case 3: return PhosphorIcons.diamond(PhosphorIconsStyle.bold);
      default: return PhosphorIcons.sparkle(PhosphorIconsStyle.bold);
    }
  }
}

class _ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;
  const _ErrorState({required this.message, required this.onRetry});
  @override
  Widget build(BuildContext context) {
    return ListView(
      children: [
        const SizedBox(height: 80),
        Center(child: Text(message, style: ZineText.sub(size: 14, color: Zine.inkSoft))),
        const SizedBox(height: 14),
        Center(
          child: ZinePressable(
            onTap: onRetry,
            color: Zine.card,
            radius: BorderRadius.circular(Zine.rSm),
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
            child: Text('Retry', style: ZineText.value(size: 14)),
          ),
        ),
      ],
    );
  }
}

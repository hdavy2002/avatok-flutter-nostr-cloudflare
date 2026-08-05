import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/subscribe_api.dart';
import '../../core/play_billing.dart';
// [UI-DS-SWEEP-1] migrated off core/ui/zine.dart onto AD / ADText / Msg.
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
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

  static const _accents = [AD.card, AD.online, AD.newGroup, AD.micIdleBg];

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
      backgroundColor: AD.bg,
      body: SafeArea(
        child: Column(children: [
          // Header
          Padding(
            padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s3, Msg.s4, Msg.s2),
            child: Row(children: [
              ZineBackButton(
                icon: PhosphorIcons.caretLeft(PhosphorIconsStyle.bold),
                onTap: () => Navigator.maybePop(context),
              ),
              const SizedBox(width: Msg.s3),
              Text('Subscribe', style: ADText.appTitle()),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(Msg.s4, 0, Msg.s4, Msg.s2),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                'Pick a plan. Upgrade or cancel anytime.',
                style: ADText.preview(c: AD.textSecondary),
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
                          padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s1, Msg.s4, Msg.s5),
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
      margin: const EdgeInsets.symmetric(vertical: Msg.s2),
      padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, Msg.s4),
      decoration: BoxDecoration(
        // [UI-DS-SWEEP-1] The current plan is marked with an accent TINT + an
        // accent border, not a solid accent fill. A solid fill would put white
        // body text straight on the accent (~2.6:1) — the old light theme got
        // away with it because its ink was dark.
        color: isCurrent ? AD.primaryBadge.withValues(alpha: 0.16) : AD.card,
        borderRadius: BorderRadius.circular(Msg.rLg),
        border: Border.all(
            color: isCurrent ? AD.primaryBadge : AD.borderCard, width: 1),
        boxShadow: const <BoxShadow>[],
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(icon: _iconFor(tier), color: accent),
          const SizedBox(width: Msg.s3),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(name, style: ADText.appTitle()),
              Text(
                price == 0 ? 'Free forever' : '\$${price.toStringAsFixed(0)} / month',
                style: ADText.sectionLabel(c: AD.textSecondary),
              ),
            ]),
          ),
          if (isCurrent)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s1),
              decoration: BoxDecoration(
                color: AD.online,
                borderRadius: Msg.brPill,
                border: Border.all(color: AD.borderCard, width: 1),
              ),
              child: Text(
                _currentStatus == 'canceled' ? 'Ending' : 'Your plan',
                // Dark ink ON the green fill — NOT AD.online, which would be
                // green-on-green and invisible.
                style: ADText.sectionLabel(c: AD.textOnInput),
              ),
            ),
        ]),
        const SizedBox(height: Msg.s3),
        for (final l in lines)
          Padding(
            padding: const EdgeInsets.only(bottom: Msg.s2),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), size: 14, color: AD.textSecondary),
              const SizedBox(width: Msg.s2),
              Expanded(child: Text(l, style: ADText.rowName())),
            ]),
          ),
        const SizedBox(height: Msg.s2),
        if (!isCurrent && tier > 0) _cta(tier),
        if (tier == 0 && !isCurrent)
          Text('Always available', style: ADText.sectionLabel(c: AD.textSecondary)),
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
        color: AD.textPrimary,
        radius: BorderRadius.circular(Msg.rLg),
        boxShadow: const <BoxShadow>[],
        padding: const EdgeInsets.symmetric(vertical: Msg.s3),
        child: Center(
          child: busy
              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: AD.bg))
              : Text(
                  upgrade ? 'Upgrade to this plan' : 'Switch to this plan',
                  style: ADText.rowName(c: AD.bg),
                ),
        ),
      ),
    );
  }

  // Plain-language feature lines. Human messaging and human 1:1/group calls are
  // permanently free on every tier. Only AI/provider-backed features are metered.
  List<String> _featureLines(Map<String, dynamic> plan) {
    final caps = (plan['caps'] as Map?)?.cast<String, dynamic>() ?? const {};
    final features = (plan['features'] as Map?)?.cast<String, dynamic>() ?? const {};
    final confSize = (plan['confParticipants'] as num?)?.toInt() ?? 0;

    final out = <String>['Unlimited messaging and audio/video calls'];

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
      out.add('Group audio/video calls up to $confSize people');
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
        Center(child: Text(message, style: ADText.preview(c: AD.textSecondary))),
        const SizedBox(height: Msg.s4),
        Center(
          child: ZinePressable(
            onTap: onRetry,
            color: AD.card,
            radius: BorderRadius.circular(Msg.rLg),
            padding: const EdgeInsets.symmetric(horizontal: Msg.s5, vertical: Msg.s3),
            child: Text('Retry', style: ADText.rowName()),
          ),
        ),
      ],
    );
  }
}

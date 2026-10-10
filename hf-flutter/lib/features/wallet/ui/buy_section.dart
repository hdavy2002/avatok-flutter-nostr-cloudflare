import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_error.dart';
import '../../../core/format/money.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../billing/purchase_controller.dart';
import '../data/pack_offer.dart';
import '../data/wallet_models.dart';
import '../wallet_providers.dart';

/// Copy of the Buy tokens section.
abstract final class BuyCopy {
  static const String title = 'Buy tokens';
  static const String comingSoon = 'Buying tokens is coming soon';
  static const String comingSoonBody = 'We will let you know here as soon as you can add tokens.';
  static const String noStore = 'Google Play is not available on this device, so tokens cannot be bought here.';
  static const String noPrices = 'We could not load the prices from Google Play.';
  static const String unavailable = 'Not available';
  static const String loading = 'Loading token packs…';
  static const String preparing = 'Getting ready…';
  static const String verifying = 'Confirming your payment…';
  static const String areYouSure = 'Are you sure?';
  static const String yesBuy = 'Yes, buy';
  static const String cancel = 'Cancel';
  static const String paidViaPlay = 'You pay through Google Play.';
}

/// The packs, with Google Play's own price on each button, and the whole buy flow.
class BuySection extends ConsumerWidget {
  const BuySection({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final offers = ref.watch(packOffersProvider);
    final purchase = ref.watch(purchaseControllerProvider);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(BuyCopy.title, style: HfText.title),
        const SizedBox(height: HfSpacing.gap),
        offers.when(
          skipLoadingOnReload: true,
          skipLoadingOnRefresh: true,
          loading: () => const _Plain(text: BuyCopy.loading, loading: true),
          error: (e, _) => HfCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  e is ApiError ? e.userMessage : 'We could not load the token packs. Please try again.',
                  style: HfText.bodyText,
                ),
                const SizedBox(height: 12),
                HfButton(label: 'Try again', kind: HfButtonKind.secondary, onPressed: () => ref.invalidate(packOffersProvider)),
              ],
            ),
          ),
          data: (o) => _Packs(offers: o, purchase: purchase),
        ),
      ],
    );
  }
}

class _Plain extends StatelessWidget {
  const _Plain({required this.text, this.loading = false});

  final String text;
  final bool loading;

  @override
  Widget build(BuildContext context) => HfCard(
        child: Row(
          children: [
            if (loading) ...[
              const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2.5)),
              const SizedBox(width: 12),
            ],
            Expanded(child: Text(text, style: HfText.bodyText)),
          ],
        ),
      );
}

class _Packs extends ConsumerWidget {
  const _Packs({required this.offers, required this.purchase});

  final PackOffers offers;
  final PurchaseState purchase;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!offers.enabled || offers.offers.isEmpty) {
      return HfCard(
        color: HfColors.butter,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(BuyCopy.comingSoon, style: HfText.subtitle),
            const SizedBox(height: 6),
            Text(BuyCopy.comingSoonBody, style: HfText.bodyText.copyWith(color: HfColors.mauve)),
          ],
        ),
      );
    }
    final phaseText = switch (purchase.phase) {
      PurchasePhase.preparing => BuyCopy.preparing,
      PurchasePhase.verifying => BuyCopy.verifying,
      _ => null,
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (!offers.storeAvailable) ...[
          const _Plain(text: BuyCopy.noStore),
          const SizedBox(height: HfSpacing.gap),
        ],
        if (offers.storeError) ...[
          HfCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(BuyCopy.noPrices, style: HfText.bodyText),
                const SizedBox(height: 12),
                HfButton(label: 'Try again', kind: HfButtonKind.secondary, onPressed: () => ref.invalidate(packOffersProvider)),
              ],
            ),
          ),
          const SizedBox(height: HfSpacing.gap),
        ],
        if (phaseText != null) ...[
          _Plain(text: phaseText, loading: true),
          const SizedBox(height: HfSpacing.gap),
        ],
        for (final o in offers.offers) ...[
          _PackCard(offer: o, enabled: offers.storeAvailable && !purchase.busy && o.store != null),
          const SizedBox(height: HfSpacing.gap),
        ],
        const Text(BuyCopy.paidViaPlay, style: HfText.note),
      ],
    );
  }
}

class _PackCard extends ConsumerWidget {
  const _PackCard({required this.offer, required this.enabled});

  final PackOffer offer;
  final bool enabled;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final per = offer.pack.redemptionPaisePerToken;
    final price = offer.priceText ?? BuyCopy.unavailable;
    return HfCard(
      key: ValueKey<String>('pack-${offer.productId}'),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(tokensPlain(offer.pack.tokens), style: HfText.subtitle),
                if (per != null) ...[
                  const SizedBox(height: 4),
                  Text('Each token worth ${Money.paise(per)} of call time', style: HfText.note),
                ],
              ],
            ),
          ),
          const SizedBox(width: 12),
          // The label is Play's own price string. No price is ever typed or taken from our server.
          HfButton(
            key: ValueKey<String>('buy-${offer.productId}'),
            label: price,
            expand: false,
            onPressed: enabled ? () => _buy(context, ref) : null,
          ),
        ],
      ),
    );
  }

  Future<void> _buy(BuildContext context, WidgetRef ref) {
    return ref.read(purchaseControllerProvider.notifier).buy(
      offer,
      confirm: (prepared, pricePaise) async {
        if (!context.mounted) return false;
        final ok = await showDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text(BuyCopy.areYouSure),
            content: Text(
              'You are about to buy ${tokensPlain(offer.pack.tokens)} for ${offer.priceText ?? ''}. You pay through Google Play.',
              style: HfText.bodyText,
            ),
            actions: [
              TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text(BuyCopy.cancel)),
              ElevatedButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text(BuyCopy.yesBuy)),
            ],
          ),
        );
        return ok == true;
      },
    );
  }
}

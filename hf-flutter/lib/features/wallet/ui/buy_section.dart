import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_error.dart';
import '../../../core/format/money.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../billing/purchase_controller.dart';
import '../data/pack_offer.dart';
import '../wallet_providers.dart';
import 'wallet_surface.dart';

/// Copy of the Add money section.
abstract final class BuyCopy {
  static const String title = 'Add money';
  static const String comingSoon = 'Adding money is coming soon';
  static const String comingSoonBody =
      'We will let you know here as soon as you can add money.';
  static const String noStore =
      'Google Play is not available on this device, so you cannot add money here.';
  static const String noPrices =
      'We could not load the prices from Google Play.';
  static const String unavailable = 'Not available';
  static const String loading = 'Loading packs…';
  static const String preparing = 'Getting ready…';
  static const String verifying = 'Confirming your payment…';
  static const String areYouSure = 'Are you sure?';
  static const String yesBuy = 'Yes, buy';
  static const String cancel = 'Cancel';
  static const String paidViaPlay = 'Paid via Google Play';
  static const String popular = 'Popular';

  /// HF-GST-NOTE-1 / rulebook HF-PAY-19 (owner decision 2026-10-11): pack prices include 18% GST.
  /// Wording follows the Wallet mockup.
  static const String gstSubtitle = 'Price includes 18% GST.';
}

/// Gap between pack tiles (mockup: 10).
const double _gridGap = 10;

/// Width / height of a pack tile (mockup grid). The tile is never shorter than 108.
const double _tileAspect = 1.42;

/// Tile colours in mockup order: sky, butter, peach, lavender.
const List<HfTint> _tileTints = [
  HfTint.sky,
  HfTint.butter,
  HfTint.peach,
  HfTint.lavender,
];

/// Marks the pack the mockup calls "Popular" (the one that adds Rs 204). A badge only: it never decides a price.
bool _isPopular(PackOffer o) =>
    o.pack.creditPaise == 20400 || o.store?.priceMicros == 240000000;

const List<int> _cataloguePricesPaise = <int>[12000, 24000, 36000, 50000];

/// The approved four-pack catalogue in visual order. Values still come from
/// the live server/Play join; an unavailable configured pack is never invented.
List<PackOffer> _catalogueOffers(List<PackOffer> all) {
  final ordered = <PackOffer>[];
  for (final amount in _cataloguePricesPaise) {
    for (final offer in all) {
      final paid = offer.breakdown?.paidPaise ?? offer.pack.pricePaise;
      if (paid == amount && !ordered.contains(offer)) {
        ordered.add(offer);
        break;
      }
    }
  }
  if (ordered.length == _cataloguePricesPaise.length) return ordered;
  return all.take(4).toList();
}

/// "Add money": the packs as 2x2 tiles with Google Play's own price, one Pay button, and the whole buy flow.
class BuySection extends ConsumerWidget {
  const BuySection({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final offers = ref.watch(packOffersProvider);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            const Flexible(child: WalletSectionTitle(BuyCopy.title)),
            const SizedBox(width: HfSpacing.lg),
            Flexible(
              child: Text(
                BuyCopy.paidViaPlay,
                textAlign: TextAlign.end,
                style: HfText.of(
                  context,
                  HfText.label,
                ).copyWith(fontWeight: FontWeight.w400),
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),
        offers.when(
          skipLoadingOnReload: true,
          skipLoadingOnRefresh: true,
          loading: () => const _PacksSkeleton(),
          error: (e, _) => _Message(
            text: e is ApiError
                ? e.userMessage
                : 'We could not load the packs. Please try again.',
            onRetry: () => ref.invalidate(packOffersProvider),
          ),
          data: (o) => _Packs(offers: o),
        ),
      ],
    );
  }
}

class _PacksSkeleton extends StatelessWidget {
  const _PacksSkeleton();

  @override
  Widget build(BuildContext context) {
    Widget tile() => const Expanded(
      child: HfSkeleton.box(height: 88, radius: HfRadius.tile),
    );
    return Semantics(
      label: BuyCopy.loading,
      child: Column(
        children: [
          Row(
            children: [
              tile(),
              const SizedBox(width: HfSpacing.md),
              tile(),
            ],
          ),
          const SizedBox(height: HfSpacing.md),
          Row(
            children: [
              tile(),
              const SizedBox(width: HfSpacing.md),
              tile(),
            ],
          ),
          const SizedBox(height: 16),
          const HfSkeleton.box(height: 56, radius: HfRadius.control),
        ],
      ),
    );
  }
}

class _Message extends StatelessWidget {
  const _Message({required this.text, this.onRetry}) : loading = false;

  final String text;
  final VoidCallback? onRetry;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    return WalletSurface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              if (loading) ...[
                const SizedBox(
                  height: 22,
                  width: 22,
                  child: CircularProgressIndicator(strokeWidth: 2.5),
                ),
                const SizedBox(width: 12),
              ],
              Expanded(
                child: Text(text, style: HfText.of(context, HfText.body)),
              ),
            ],
          ),
          if (onRetry != null) ...[
            const SizedBox(height: 12),
            HfButton(
              label: 'Try again',
              kind: HfButtonKind.secondary,
              onPressed: onRetry,
            ),
          ],
        ],
      ),
    );
  }
}

class _Packs extends ConsumerStatefulWidget {
  const _Packs({required this.offers});

  final PackOffers offers;

  @override
  ConsumerState<_Packs> createState() => _PacksState();
}

class _PacksState extends ConsumerState<_Packs> {
  String? _picked;

  /// Double-tap guard: true from the tap until the buy flow has handed over to Play.
  bool _starting = false;

  /// The tapped pack; else the popular one; else the first one Play can sell; else the first.
  PackOffer? _selected(List<PackOffer> all) {
    if (all.isEmpty) return null;
    for (final o in all) {
      if (o.productId == _picked) return o;
    }
    for (final o in all) {
      if (_isPopular(o) && o.store != null) return o;
    }
    for (final o in all) {
      if (o.store != null) return o;
    }
    return all.first;
  }

  Future<void> _pay(PackOffer offer) async {
    if (_starting) return;
    setState(() => _starting = true);
    try {
      await ref
          .read(purchaseControllerProvider.notifier)
          .buy(
            offer,
            confirm: (prepared, pricePaise) async {
              if (!mounted) return false;
              final ok = await showDialog<bool>(
                context: context,
                builder: (ctx) => AlertDialog(
                  title: const Text(BuyCopy.areYouSure),
                  content: Text(
                    offer.breakdown != null
                        ? 'You are about to add ${offer.breakdown!.wallet} to your wallet.\n\n${offer.breakdown!.lines}\n\nYou pay through Google Play.'
                        : 'You are about to add money to your wallet. You pay ${offer.priceText ?? ''} (includes 18% GST) through Google Play.',
                    key: const ValueKey<String>('confirm-breakdown'),
                    style: HfText.body,
                  ),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.of(ctx).pop(false),
                      child: const Text(BuyCopy.cancel),
                    ),
                    ElevatedButton(
                      onPressed: () => Navigator.of(ctx).pop(true),
                      child: const Text(BuyCopy.yesBuy),
                    ),
                  ],
                ),
              );
              return ok == true;
            },
          );
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final offers = widget.offers;
    final purchase = ref.watch(purchaseControllerProvider);
    if (!offers.enabled || offers.offers.isEmpty) {
      return WalletSurface(
        color: HfTint.butter.bg(context),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              BuyCopy.comingSoon,
              style: HfText.subsection.copyWith(
                color: HfTint.butter.valueInk(context),
              ),
            ),
            const SizedBox(height: 6),
            Text(
              BuyCopy.comingSoonBody,
              style: HfText.body.copyWith(color: HfTint.butter.ink(context)),
            ),
          ],
        ),
      );
    }
    final phaseText = switch (purchase.phase) {
      PurchasePhase.preparing => BuyCopy.preparing,
      PurchasePhase.verifying => BuyCopy.verifying,
      _ => null,
    };
    final working = _starting || purchase.phase != PurchasePhase.idle;
    final catalogue = _catalogueOffers(offers.offers);
    final selected = _selected(catalogue);
    final price = selected?.priceText;
    final canPay =
        selected != null && price != null && offers.storeAvailable && !working;
    final tilesEnabled = offers.storeAvailable && !working;

    final tiles = <Widget>[
      for (var i = 0; i < catalogue.length; i++)
        _PackTile(
          offer: catalogue[i],
          tint: _tileTints[i % _tileTints.length],
          selected: catalogue[i].productId == selected?.productId,
          popular: _isPopular(catalogue[i]),
          onTap: tilesEnabled
              ? () {
                  HapticFeedback.selectionClick();
                  setState(() => _picked = catalogue[i].productId);
                }
              : null,
        ),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (!offers.storeAvailable) ...[
          const _Message(text: BuyCopy.noStore),
          const SizedBox(height: 16),
        ],
        if (offers.storeError) ...[
          _Message(
            text: BuyCopy.noPrices,
            onRetry: () => ref.invalidate(packOffersProvider),
          ),
          const SizedBox(height: 16),
        ],
        // Room for the "Popular" badge that overlaps the top edge of its tile.
        const SizedBox(height: 6),
        for (var i = 0; i < tiles.length; i += 2) ...[
          if (i > 0) const SizedBox(height: _gridGap),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: tiles[i]),
              const SizedBox(width: _gridGap),
              Expanded(
                child: i + 1 < tiles.length ? tiles[i + 1] : const SizedBox(),
              ),
            ],
          ),
        ],
        const SizedBox(height: 16),
        if (phaseText != null) ...[
          Semantics(
            liveRegion: true,
            child: Text(
              phaseText,
              textAlign: TextAlign.center,
              style: HfText.of(context, HfText.note),
            ),
          ),
          const SizedBox(height: HfSpacing.sm),
        ],
        // The label carries Play's own price string. No price is ever typed or taken from our server.
        HfButton(
          key: const ValueKey<String>('pay-button'),
          label: price == null
              ? 'Pay with Google Play'
              : 'Pay $price with Google Play',
          loading: working,
          onPressed: canPay ? () => _pay(selected) : null,
        ),
        const SizedBox(height: HfSpacing.md),
        Text(
          BuyCopy.gstSubtitle,
          key: const ValueKey<String>('gst-subtitle'),
          textAlign: TextAlign.center,
          style: HfText.of(
            context,
            HfText.label,
          ).copyWith(fontWeight: FontWeight.w400),
        ),
      ],
    );
  }
}

class _PackTile extends StatelessWidget {
  const _PackTile({
    required this.offer,
    required this.tint,
    required this.selected,
    required this.popular,
    required this.onTap,
  });

  final PackOffer offer;
  final HfTint tint;
  final bool selected;
  final bool popular;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final price = offer.priceText;
    final breakdown = offer.breakdown;
    final legacyCredit = offer.pack.creditPaise;
    final border = selected
        ? (dark ? HfColors.lavenderLight : HfColors.ink)
        : Colors.transparent;
    final label = price == null ? BuyCopy.unavailable : price;
    final semantic = [
      label,
      if (breakdown != null) breakdown.line,
      if (popular) BuyCopy.popular,
    ].join(', ');
    final radius = BorderRadius.circular(HfRadius.tile);
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Semantics(
          button: true,
          selected: selected,
          enabled: onTap != null,
          label: semantic,
          excludeSemantics: true,
          onTap: onTap,
          child: AspectRatio(
            aspectRatio: _tileAspect,
            child: AnimatedContainer(
              key: ValueKey<String>('buy-${offer.productId}'),
              duration: HfMotion.of(context, HfMotion.fast),
              curve: HfMotion.curve,
              constraints: const BoxConstraints(minHeight: 108),
              decoration: BoxDecoration(
                color: tint.bg(context),
                borderRadius: radius,
                border: Border.all(color: border, width: 3),
              ),
              child: Material(
                type: MaterialType.transparency,
                child: InkWell(
                  borderRadius: radius,
                  onTap: onTap,
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: FittedBox(
                        fit: BoxFit.scaleDown,
                        alignment: Alignment.centerLeft,
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              label,
                              style: HfText.stat.copyWith(
                                fontSize: 24,
                                color: tint.valueInk(context),
                              ),
                            ),
                            if (breakdown != null) ...[
                              const SizedBox(height: 4),
                              Text(
                                '+ ${breakdown.wallet} to wallet',
                                key: ValueKey<String>('gst-${offer.productId}'),
                                style: HfText.note.copyWith(
                                  color: tint.ink(context),
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ] else if (legacyCredit != null) ...[
                              const SizedBox(height: 4),
                              Text(
                                'Added to wallet ${formatPaise(legacyCredit)}',
                                style: HfText.note.copyWith(
                                  color: tint.valueInk(context),
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        if (popular)
          Positioned(
            top: -10,
            right: 14,
            child: IgnorePointer(
              child: ExcludeSemantics(
                child: Container(
                  key: ValueKey<String>('popular-${offer.productId}'),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 9,
                    vertical: 3,
                  ),
                  decoration: BoxDecoration(
                    color: dark ? HfColors.lavenderLight : HfColors.ink,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(
                    BuyCopy.popular,
                    style: HfText.badge.copyWith(
                      color: dark ? HfColors.ink : HfColors.white,
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

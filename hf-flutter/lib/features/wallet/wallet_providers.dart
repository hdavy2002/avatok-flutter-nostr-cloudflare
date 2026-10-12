import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/auth/session.dart';
import 'billing/billing_adapter.dart';
import 'billing/play_billing_adapter.dart';
import 'billing/purchase_controller.dart';
import '../call/data/call_api.dart';
import '../explore/data/host_card.dart';
import '../explore/data/hosts_repository.dart';
import 'data/pack_offer.dart';
import 'data/wallet_api.dart';
import 'data/wallet_models.dart';

/// The value of an [AsyncValue] when it has one (also while reloading), else null. Never throws.
T? valueOf<T>(AsyncValue<T> v) => v.hasValue ? v.requireValue : null;

/// The Wallet's typed API. Tests override [apiClientProvider] with a FakeApiClient.
final walletApiProvider = Provider<WalletApi>(
  (ref) => WalletApi(ref.watch(apiClientProvider)),
);

/// Google Play Billing. Tests override this with a fake adapter.
final billingAdapterProvider = Provider<BillingAdapter>(
  (ref) => PlayBillingAdapter(),
);

/// Waits between tries when verify cannot be reached (Play or our server is busy). Tests use an empty list.
final purchaseRetryDelaysProvider = Provider<List<Duration>>(
  (ref) => const <Duration>[Duration(seconds: 2), Duration(seconds: 6)],
);

/// Money is never cached: each of these reads the server live, every time the screen opens.
final walletProvider = FutureProvider.autoDispose<WalletData>(
  (ref) => ref.watch(walletApiProvider).wallet(),
);

/// The per-minute rate (rupees) of the host the person last called, read from the account's prefs
/// (`hf.last_call_rate.v1`, written by the call API). Null when there has been no call yet.
final lastCallRateProvider = FutureProvider.autoDispose<num?>(
  (ref) => const LastCallRateStore().read(),
);

/// The rate the Wallet uses for "About N minutes at Rs R/min": the last
/// call's rate, else the cheapest host in the saved live host lists. It stays
/// null when the app has no observed rate; the UI then omits the estimate.
final walletRateProvider = FutureProvider.autoDispose<num?>((ref) async {
  final last = await ref.watch(lastCallRateProvider.future);
  if (last != null && last > 0) return last;
  final cache = ref.watch(jsonCacheProvider);
  num? cheapest;
  for (final key in const [kExploreCacheKey, kOnlineCacheKey]) {
    final entry = await cache.read(key);
    final data = entry?.data;
    if (data is! Map) continue;
    for (final h in HostsPage.fromJson(data['page']).items) {
      if (h.pricePerMin > 0 && (cheapest == null || h.pricePerMin < cheapest)) {
        cheapest = h.pricePerMin;
      }
    }
  }
  return cheapest;
});

final refundsProvider = FutureProvider.autoDispose<RefundsInfo>(
  (ref) => ref.watch(walletApiProvider).refunds(),
);

final receiptsProvider = FutureProvider.autoDispose<List<WalletReceipt>>(
  (ref) => ref.watch(walletApiProvider).receipts(),
);

/// Server packs merged with Play's product details (the localized price strings).
final packOffersProvider = FutureProvider.autoDispose<PackOffers>((ref) async {
  final catalog = await ref.watch(walletApiProvider).products();
  if (!catalog.enabled || catalog.packs.isEmpty) {
    return PackOffers(enabled: catalog.enabled, offers: const <PackOffer>[]);
  }
  final billing = ref.watch(billingAdapterProvider);
  if (!await billing.isAvailable()) {
    return PackOffers(
      enabled: true,
      storeAvailable: false,
      offers: [for (final p in catalog.packs) PackOffer(pack: p)],
    );
  }
  try {
    final found = await billing.queryProducts({
      for (final p in catalog.packs) p.productId,
    });
    return PackOffers(
      enabled: true,
      offers: [
        for (final p in catalog.packs)
          PackOffer(pack: p, store: found[p.productId]),
      ],
    );
  } catch (_) {
    return PackOffers(
      enabled: true,
      storeError: true,
      offers: [for (final p in catalog.packs) PackOffer(pack: p)],
    );
  }
});

/// Lives for the whole app: it listens to Play's purchase stream and finishes purchases with the server.
final purchaseControllerProvider =
    NotifierProvider<PurchaseController, PurchaseState>(PurchaseController.new);

/// Watched once, near the root of the app: when a person is signed in it starts the purchase listener and
/// asks Play for purchases that were never finished (recovery on start). The controller repeats that on
/// every app resume.
final purchaseRecoveryProvider = Provider<void>((ref) {
  final signedIn = ref.watch(sessionProvider.select((s) => s.isSignedIn));
  if (!signedIn) return;
  Future<void>.microtask(() async {
    try {
      await ref.read(purchaseControllerProvider.notifier).recover();
    } catch (_) {
      // recovery is best effort; the next resume tries again
    }
  });
});

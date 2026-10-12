import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/auth/hf_me.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/features/wallet/billing/billing_adapter.dart';
import 'package:hf_app/features/wallet/billing/purchase_controller.dart';
import 'package:hf_app/features/wallet/data/pack_offer.dart';
import 'package:hf_app/features/wallet/data/wallet_models.dart';
import 'package:hf_app/features/wallet/wallet_providers.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';
import '../../support/fake_billing.dart';
import 'wallet_support.dart';

class SwitchingSession extends StubSession {
  SwitchingSession() : super(const SessionState(
    status: SessionStatus.signedIn, me: HfMe(uid: 'account-a')));

  void use(String uid) => state = SessionState(
    status: SessionStatus.signedIn, me: HfMe(uid: uid));
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late FakeApiClient api;
  late FakeBillingAdapter billing;
  late ProviderContainer container;
  late PurchaseController controller;
  late SwitchingSession session;
  Future<void> flush() async {
    for (var i = 0; i < 6; i++) { await Future<void>.delayed(Duration.zero); }
  }
  PackOffer offer() => PackOffer(
    pack: TokenPack.fromJson({'productId': 'hf_tokens_100', 'pricePaise': 12000}),
    store: billing.products['hf_tokens_100']);

  setUp(() {
    api = walletApi();
    billing = FakeBillingAdapter();
    session = SwitchingSession();
    container = ProviderContainer(overrides: [
      sessionProvider.overrideWith(() => session),
      apiClientProvider.overrideWithValue(api),
      billingAdapterProvider.overrideWithValue(billing),
      purchaseRetryDelaysProvider.overrideWithValue(const []),
    ]);
    controller = container.read(purchaseControllerProvider.notifier);
  });
  tearDown(() => container.dispose());

  test('late prepare cannot open a Play sheet for the next account', () async {
    final response = Completer<Object?>();
    api.on('POST', '/api/hf/tokens/play/prepare', (_) => response.future);
    final buying = controller.buy(offer(), confirm: (_, __) async => true);
    await flush();
    expect(controller.hasActivePurchase, isTrue);
    session.use('account-b');
    response.complete(prepareAnswer('hf_tokens_100'));
    await buying;
    expect(billing.boughtProductIds, isEmpty);
    expect(container.read(purchaseControllerProvider).phase, PurchasePhase.idle);
    expect(container.read(purchaseControllerProvider).notice, isNull);
  });

  test('late verify neither shows account A credit to B nor suppresses B recovery', () async {
    final response = Completer<Object?>();
    api.on('POST', '/api/hf/tokens/play/verify', (_) => response.future);
    controller.start();
    const purchase = StorePurchase(productId: 'hf_tokens_100', purchaseToken: 'token-a', status: StorePurchaseStatus.purchased);
    billing.emit(purchase);
    await flush();
    expect(controller.hasActivePurchase, isTrue);
    session.use('account-b');
    response.complete(verifyAnswer());
    await flush();
    expect(container.read(purchaseControllerProvider).notice, isNull);
    expect(controller.hasActivePurchase, isFalse);
    api.onJson('POST', '/api/hf/tokens/play/verify', verifyAnswer(duplicate: true));
    billing.emit(purchase);
    await flush();
    expect(api.callsTo('POST', '/api/hf/tokens/play/verify'), hasLength(2));
    expect(container.read(purchaseControllerProvider).notice, isNull);
  });

  test('account switch during confirmation cancels continuation', () async {
    api.onJson('POST', '/api/hf/tokens/play/prepare', {
      ...prepareAnswer('hf_tokens_100'), 'confirmAbovePaise': 1,
    });
    final confirm = Completer<bool>();
    final buying = controller.buy(offer(), confirm: (_, __) => confirm.future);
    await flush();
    session.use('account-b');
    confirm.complete(true);
    await buying;
    expect(billing.boughtProductIds, isEmpty);
  });

  test('an open Play sheet counts as active and rejects a duplicate purchase', () async {
    await controller.buy(offer(), confirm: (_, __) async => true);
    expect(container.read(purchaseControllerProvider).phase, PurchasePhase.awaitingSheet);
    expect(controller.hasActivePurchase, isTrue);
    await controller.buy(offer(), confirm: (_, __) async => true);
    expect(billing.boughtProductIds, hasLength(1));
  });
}

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/format/money.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/core/widgets/widgets.dart';
import 'package:hf_app/features/call/data/call_models.dart';
import 'package:hf_app/features/wallet/billing/billing_adapter.dart';
import 'package:hf_app/features/wallet/ui/wallet_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'features/call/call_harness.dart';
import 'features/wallet/wallet_support.dart';
import 'support/fake_api_client.dart';

/// HF-MOTION-C: the call confirm sheet, call screen (ringing, connected, summary), review and Wallet motion.
/// Behaviour checks always run; the `callwallet-*.png` captures are written only in the CI runtime
/// (EXPORT_DESIGN_REVIEW), like the other design reviews.
const _export = bool.fromEnvironment('EXPORT_DESIGN_REVIEW');

const String _statusPath = '/api/hf/calls/c1';

Future<void> _loadFonts() async {
  final icons = FontLoader('MaterialIcons')
    ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
  await icons.load();
  for (final family in ['Nunito', 'Comfortaa']) {
    final loader = FontLoader(family);
    final weights = family == 'Nunito'
        ? ['Regular', 'SemiBold', 'Bold', 'ExtraBold']
        : ['Regular', 'Medium', 'Bold'];
    for (final weight in weights) {
      loader.addFont(rootBundle.load('assets/fonts/$family-$weight.ttf'));
    }
    await loader.load();
  }
}

Future<void> _capture(WidgetTester tester, String name) async {
  if (!_export) return;
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    find.byType(RepaintBoundary).first,
  );
  await tester.runAsync(() async {
    final pixels = await boundary.toImage(pixelRatio: 1);
    try {
      final bytes = await pixels.toByteData(format: ui.ImageByteFormat.png);
      if (bytes == null) throw StateError('PNG capture failed');
      final folder = Directory('test_output/design_review');
      await folder.create(recursive: true);
      await File(
        '${folder.path}/callwallet-$name.png',
      ).writeAsBytes(bytes.buffer.asUint8List());
    } finally {
      pixels.dispose();
    }
  });
}

void _setSize(WidgetTester tester, Size size) {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
}

void _reduceMotion(WidgetTester tester) {
  tester.platformDispatcher.accessibilityFeaturesTestValue =
      const FakeAccessibilityFeatures(disableAnimations: true);
  addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
}

/// Decodes the beaver images a capture shows, so the PNG is not blank where the beaver stands. Errors are
/// ignored: a capture never fails because an image did not decode.
Future<void> _precacheBeavers(
  WidgetTester tester,
  List<BeaverPose> poses,
) async {
  final finder = find.byType(Scaffold);
  if (finder.evaluate().isEmpty) return;
  final context = tester.element(finder.first);
  await tester.runAsync(() async {
    for (final pose in poses) {
      for (final asset in [pose.stillAsset, pose.animatedAsset]) {
        await precacheImage(
          AssetImage(asset),
          context,
          onError: (_, __) {},
        );
      }
    }
  });
  await tester.pump();
}

FakeApiClient _confirmApi() => FakeApiClient()
  ..onJson('GET', '/api/config', {'hfCallsEnabled': true})
  ..onJson('GET', '/api/hosts/public/asha', {
    'slug': 'asha',
    'displayName': 'Asha Verma',
    'topics': ['stress', 'career'],
  })
  ..onJson('GET', '/api/hf/options', {
    'topics': [
      {'slug': 'stress', 'label': 'Tension'},
      {'slug': 'career', 'label': 'Career'},
    ],
  })
  ..onJson('GET', '/api/hf/wallet/estimate', {
    'mode': 'tokens',
    'ratePerMinRupees': 3.99,
    'aboutText': 'about 42 min',
    'affordableSeconds': 2520,
    'canStart': true,
    'hasDebt': false,
    'balance': '168.34',
    'plan': 'standard',
    'priceTiers': [
      {'fromMin': 0, 'toMin': 30, 'paisePerMin': 399},
      {'fromMin': 30, 'toMin': 60, 'paisePerMin': 350},
      {'fromMin': 60, 'paisePerMin': 325},
    ],
  });

/// Seconds since the epoch, [seconds] before the harness clock's "now".
int _connectedAgo(int seconds) =>
    DateTime.utc(2026, 10, 10, 12)
        .subtract(Duration(seconds: seconds))
        .millisecondsSinceEpoch ~/
    1000;

Map<String, Object?> _completed() => callJson(
  'completed',
  billedMinutes: 13,
  endReason: 'caller_hangup',
  canReview: true,
  extra: {
    'plan': 'standard',
    'billableSeconds': 724,
    'chargedPaise': 5187,
    'charged': '₹51.87',
  },
);

FakeApiClient _reviewApi() => FakeApiClient()
  ..onJson('GET', '/api/hosts/public/asha', {'topics': <String>[]})
  ..onJson('GET', '/api/hf/options', {'topics': <Object>[]})
  ..onJson('GET', _statusPath, _completed())
  ..onJson('POST', '$_statusPath/review', {'ok': true});

Finder get _stars => find.byWidgetPredicate(
  (w) =>
      w is Icon &&
      (w.icon == Icons.star_rounded || w.icon == Icons.star_outline_rounded),
);

Future<void> _send(WidgetTester tester) async {
  await tester.scrollUntilVisible(
    find.text('Send review'),
    300,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.tap(find.text('Send review'));
  await tester.pump();
  await tester.pump();
}

/// Buys the ₹120 pack and pumps in small steps; returns true if the top-up flash was ever on screen.
Future<bool> _buyAndWatchFlash(WidgetTester tester) async {
  await selectAndPay(tester, 'hf_rupees_120');
  var flashed = false;
  for (var i = 0; i < 80; i++) {
    await tester.pump(const Duration(milliseconds: 40));
    if (find.byKey(const ValueKey<String>('top-up-flash')).evaluate().isNotEmpty) {
      flashed = true;
    }
  }
  return flashed;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(_loadFonts);
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('confirm sheet', () {
    testWidgets('reduced motion: price and wallet show their final text at once', (
      tester,
    ) async {
      prepareStorage();
      _reduceMotion(tester);
      await pumpCallApp(tester, api: _confirmApi(), location: '/call/new?host=asha');
      expect(find.text('₹3.99/min'), findsOneWidget);
      expect(find.text('Your wallet ₹168.34'), findsOneWidget);
      expect(find.text('about 42 min'), findsOneWidget);
      expect(find.byType(BeaverGuide), findsNothing, reason: 'no beaver on the sheet');
      await closeApp(tester);
    });

    testWidgets('price and wallet count up and land on the exact API text', (
      tester,
    ) async {
      prepareStorage();
      await pumpCallApp(tester, api: _confirmApi(), location: '/call/new?host=asha');
      expect(find.byType(CountUpText), findsNWidgets(3));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('₹3.99/min'), findsOneWidget);
      expect(find.text('Your wallet ₹168.34'), findsOneWidget);
      expect(find.text('about 42 min'), findsOneWidget);
      await closeApp(tester);
    });
  });

  group('call screen', () {
    testWidgets('ringing: ripples, one beaver with the status copy, Cancel tappable at once', (
      tester,
    ) async {
      prepareStorage();
      final api = FakeApiClient()
        ..onJson('GET', _statusPath, callJson('ringing_host'));
      await pumpCallApp(tester, api: api);
      expect(find.text('Cancel call').hitTestable(), findsOneWidget);
      expect(find.byType(RippleRings), findsOneWidget);
      expect(find.byType(BeaverGuide), findsOneWidget);
      final beaver = tester.widget<BeaverGuide>(find.byType(BeaverGuide));
      expect(beaver.pose, BeaverPose.phoneTalk);
      expect(beaver.message, CallStrings.yourPhoneWillRing);
      await closeApp(tester);
    });

    testWidgets('host said yes flashes, connected switches the beaver; End call never hidden', (
      tester,
    ) async {
      prepareStorage();
      final api = FakeApiClient()
        ..on(
          'GET',
          _statusPath,
          statusSequence([
            callJson('ringing_caller'),
            callJson('connected', connectedAt: _connectedAgo(65)),
          ]),
        );
      await pumpCallApp(tester, api: api);
      expect(find.text('Asha said yes'), findsOneWidget);
      await pollOnce(tester);
      expect(find.text('Connected'), findsOneWidget);
      // Straight after the switch, while the hill is still rising, the controls are already usable.
      expect(find.text('End call').hitTestable(), findsOneWidget);
      expect(find.text(CallStrings.endFromPhone).hitTestable(), findsOneWidget);
      expect(find.byType(SunHill), findsOneWidget);
      final beaver = tester.widget<BeaverGuide>(find.byType(BeaverGuide));
      expect(beaver.pose, BeaverPose.phoneLaugh);
      expect(find.byType(BeaverGuide), findsOneWidget);
      expect(
        tester.widget<Text>(find.byKey(const ValueKey<String>('call-clock'))).data,
        '01:05',
      );
      await closeApp(tester);
    });

    testWidgets('summary: ribbon, thumbs-up beaver, values exact after the count-up', (
      tester,
    ) async {
      prepareStorage();
      final api = FakeApiClient()..onJson('GET', _statusPath, _completed());
      await pumpCallApp(tester, api: api);
      expect(find.byType(RibbonSweep), findsOneWidget);
      expect(find.text(CallStrings.greatChat), findsOneWidget);
      expect(find.text('Call ended'), findsOneWidget);
      final beaver = tester.widget<BeaverGuide>(find.byType(BeaverGuide));
      expect(beaver.pose, BeaverPose.thumbs);
      await tester.pump(const Duration(seconds: 1));
      expect(find.text(Money.duration(724)), findsOneWidget);
      expect(find.text(formatPaise(5187)), findsOneWidget);
      expect(find.text('Rate your call'), findsOneWidget);
      await closeApp(tester);
    });

    testWidgets('summary with reduced motion: final values at once', (tester) async {
      prepareStorage();
      _reduceMotion(tester);
      final api = FakeApiClient()
        ..onJson(
          'GET',
          _statusPath,
          callJson('completed', billedMinutes: 3, chargedRupees: 36, canReview: true),
        );
      await pumpCallApp(tester, api: api);
      expect(find.text('3 min'), findsOneWidget);
      expect(find.text('₹36.00'), findsOneWidget);
      expect(find.text(CallStrings.greatChat), findsOneWidget);
      await closeApp(tester);
    });

    testWidgets('a missed call stays calm: no ribbon, no beaver', (tester) async {
      prepareStorage();
      final api = FakeApiClient()
        ..onJson('GET', _statusPath, callJson('no_answer'));
      await pumpCallApp(tester, api: api);
      expect(find.byType(RibbonSweep), findsNothing);
      expect(find.byType(BeaverGuide), findsNothing);
      expect(find.text('You were not charged.'), findsOneWidget);
      await closeApp(tester);
    });
  });

  group('review', () {
    testWidgets('stars fill one by one with sparkles; five stars fire confetti; still submits', (
      tester,
    ) async {
      prepareStorage();
      final api = _reviewApi();
      await pumpCallApp(tester, api: api, location: '/review/call/c1');
      await tester.tap(_stars.at(4));
      await tester.pump();
      // All five icons are filled at once (order kept); the later ones are still grey, waiting their turn.
      expect(find.byIcon(Icons.star_rounded), findsNWidgets(5));
      await tester.pump(const Duration(milliseconds: 60));
      expect(find.byType(HfLottie), findsWidgets);
      expect(find.byKey(ConfettiBurst.paintKey), findsOneWidget);
      final last = tester.widget<Icon>(_stars.at(4));
      expect(last.color, isNot(HfColors.star), reason: 'the fifth star fills last');
      await tester.pump(const Duration(seconds: 2));
      for (var i = 0; i < 5; i++) {
        expect(tester.widget<Icon>(_stars.at(i)).color, HfColors.star);
      }
      expect(find.byType(HfLottie), findsNothing, reason: 'sparkles are cleared');
      expect(find.text('Really good'), findsOneWidget);
      await _send(tester);
      expect(api.callsTo('POST', '$_statusPath/review').single.body, {'stars': 5});
      expect(find.text('Your review was sent'), findsOneWidget);
      final beaver = tester.widget<BeaverGuide>(find.byType(BeaverGuide));
      expect(beaver.pose, BeaverPose.celebrate);
      expect(find.byType(HfLottie), findsOneWidget, reason: 'the heart pop');
      await closeApp(tester);
    });

    testWidgets('reduced motion: stars fill at once, no sparkles, rules unchanged', (
      tester,
    ) async {
      prepareStorage();
      _reduceMotion(tester);
      final api = _reviewApi();
      await pumpCallApp(tester, api: api, location: '/review/call/c1');
      await tester.tap(_stars.at(3));
      await tester.pump();
      for (var i = 0; i < 4; i++) {
        expect(tester.widget<Icon>(_stars.at(i)).color, HfColors.star);
      }
      expect(find.byType(HfLottie), findsNothing);
      await tester.enterText(find.byType(TextField), 'Call me on 9876543210 please');
      await _send(tester);
      expect(api.callsTo('POST', '$_statusPath/review'), isEmpty);
      await closeApp(tester);
    });
  });

  group('wallet', () {
    testWidgets('balance counts up to the exact text; packs reveal; top-up celebrates', (
      tester,
    ) async {
      final billing = walletBilling()
        ..answerWith(StorePurchaseStatus.purchased, token: 'tok-abc');
      final api = walletApi(wallet: rupeeWallet(testPaise: 0));
      await pumpWallet(tester, api: api, billing: billing);
      expect(
        tester.widget<Text>(find.byKey(const ValueKey<String>('balance-total'))).data,
        formatPaise(4520),
      );
      expect(find.byType(StaggeredReveal), findsOneWidget);
      expect(find.byType(BeaverGuide), findsNothing);
      expect(await _buyAndWatchFlash(tester), isTrue);
      await tester.pumpAndSettle();
      final beaver = tester.widget<BeaverGuide>(find.byType(BeaverGuide));
      expect(beaver.pose, BeaverPose.celebrate);
      expect(beaver.message, WalletCopy.topUpCheer);
      expect(find.byKey(const ValueKey<String>('top-up-flash')), findsNothing);
    });

    testWidgets('reduced motion: no flash, the beaver still cheers', (tester) async {
      _reduceMotion(tester);
      final billing = walletBilling()
        ..answerWith(StorePurchaseStatus.purchased, token: 'tok-abc');
      await pumpWallet(tester, api: walletApi(), billing: billing);
      expect(await _buyAndWatchFlash(tester), isFalse);
      await tester.pumpAndSettle();
      expect(find.byType(BeaverGuide), findsOneWidget);
    });

    testWidgets('low balance glows amber, breathes a little, then rests', (tester) async {
      await pumpWallet(
        tester,
        api: walletApi(wallet: rupeeWallet(balancePaise: 0, testPaise: 0)),
        billing: walletBilling(),
      );
      // pumpWallet settled, so the breathing stopped on its own.
      expect(find.byKey(const ValueKey<String>('low-balance-glow')), findsOneWidget);
    });

    testWidgets('a healthy balance has no glow', (tester) async {
      await pumpWallet(
        tester,
        api: walletApi(wallet: rupeeWallet(balancePaise: 500000, testPaise: 0)),
        billing: walletBilling(),
      );
      expect(find.byKey(const ValueKey<String>('low-balance-glow')), findsNothing);
    });
  });

  // ---------------------------------------------------------------------------------------- captures
  for (final size in [const Size(320, 640), const Size(425, 916)]) {
    final label = '${size.width.toInt()}x${size.height.toInt()}';

    testWidgets('capture confirm sheet $label', (tester) async {
      prepareStorage();
      await pumpCallApp(tester, api: _confirmApi(), location: '/call/new?host=asha');
      _setSize(tester, size);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pump(const Duration(seconds: 1));
      expect(tester.takeException(), isNull);
      await _capture(tester, 'confirm-$label');
      await closeApp(tester);
    });

    testWidgets('capture ringing $label', (tester) async {
      prepareStorage();
      final api = FakeApiClient()
        ..onJson('GET', _statusPath, callJson('ringing_host'));
      await pumpCallApp(tester, api: api);
      _setSize(tester, size);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await _precacheBeavers(tester, [BeaverPose.phoneTalk]);
      await tester.pump(const Duration(milliseconds: 900));
      expect(tester.takeException(), isNull);
      expect(find.text('Cancel call').hitTestable(), findsOneWidget);
      await _capture(tester, 'ringing-$label');
      await closeApp(tester);
    });

    testWidgets('capture connected $label', (tester) async {
      prepareStorage();
      _reduceMotion(tester);
      final api = FakeApiClient()
        ..onJson(
          'GET',
          _statusPath,
          callJson(
            'connected',
            connectedAt: _connectedAgo(724),
            extra: {
              'plan': 'standard',
              'rate': 3.99,
              'rateTiers': [
                {'fromMin': 0, 'toMin': 30, 'paisePerMin': 399},
                {'fromMin': 30, 'toMin': 60, 'paisePerMin': 350},
                {'fromMin': 60, 'paisePerMin': 325},
              ],
            },
          ),
        );
      await pumpCallApp(tester, api: api);
      _setSize(tester, size);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await _precacheBeavers(tester, [BeaverPose.phoneLaugh]);
      await tester.pump(const Duration(milliseconds: 300));
      expect(tester.takeException(), isNull);
      expect(find.text('End call').hitTestable(), findsOneWidget);
      await _capture(tester, 'connected-$label');
      await closeApp(tester);
    });

    testWidgets('capture summary $label', (tester) async {
      prepareStorage();
      _reduceMotion(tester);
      final api = FakeApiClient()..onJson('GET', _statusPath, _completed());
      await pumpCallApp(tester, api: api);
      _setSize(tester, size);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await _precacheBeavers(tester, [BeaverPose.thumbs]);
      await tester.pump(const Duration(milliseconds: 300));
      expect(tester.takeException(), isNull);
      await _capture(tester, 'summary-$label');
      await closeApp(tester);
    });

    testWidgets('capture review 5-star and thanks $label', (tester) async {
      prepareStorage();
      final api = _reviewApi();
      await pumpCallApp(tester, api: api, location: '/review/call/c1');
      _setSize(tester, size);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pump();
      await tester.tap(_stars.at(4));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 420));
      expect(tester.takeException(), isNull);
      await _capture(tester, 'review-5star-$label');
      await tester.pump(const Duration(seconds: 2));
      await _send(tester);
      await _precacheBeavers(tester, [BeaverPose.celebrate]);
      await tester.pump(const Duration(milliseconds: 700));
      expect(tester.takeException(), isNull);
      expect(find.text('Your review was sent'), findsOneWidget);
      await _capture(tester, 'review-thanks-$label');
      await closeApp(tester);
    });

    testWidgets('capture wallet $label', (tester) async {
      _reduceMotion(tester);
      await pumpWallet(tester, api: walletApi(), billing: walletBilling());
      _setSize(tester, size);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await _capture(tester, 'wallet-$label');
    });

    testWidgets('capture wallet top-up success $label', (tester) async {
      final billing = walletBilling()
        ..answerWith(StorePurchaseStatus.purchased, token: 'tok-abc');
      await pumpWallet(tester, api: walletApi(), billing: billing);
      await _precacheBeavers(tester, [BeaverPose.celebrate]);
      // Pay on the tall test phone (every tile on screen), then shrink to the capture size.
      await selectAndPay(tester, 'hf_rupees_120');
      _setSize(tester, size);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      // Catch the moment the yellow flash and the confetti are on screen.
      var caught = false;
      for (var i = 0; i < 80 && !caught; i++) {
        await tester.pump(const Duration(milliseconds: 20));
        caught = find
            .byKey(const ValueKey<String>('top-up-flash'))
            .evaluate()
            .isNotEmpty;
      }
      expect(caught, isTrue, reason: 'the top-up flash played');
      // Back to the top: the cheering beaver sits above the notice.
      tester
          .state<ScrollableState>(find.byType(Scrollable).first)
          .position
          .jumpTo(0);
      await tester.pump(const Duration(milliseconds: 60));
      expect(tester.takeException(), isNull);
      await _capture(tester, 'wallet-topup-$label');
      await tester.pumpAndSettle();
    });
  }
}

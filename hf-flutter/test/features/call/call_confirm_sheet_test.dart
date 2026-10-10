import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/features/call/data/call_api.dart';
import 'package:hf_app/features/call/data/call_models.dart';
import 'package:hf_app/features/call/ui/call_confirm_sheet.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';
import 'call_harness.dart';

const _estimatePath = '/api/hf/wallet/estimate';

Map<String, Object?> _tokenEstimate({bool canStart = true, bool hasDebt = false, String about = 'about 3 min 20 s'}) => {
      'mode': 'tokens',
      'ratePerMinRupees': 12,
      'tokensPerMinute': '15.00',
      'aboutText': about,
      'affordableSeconds': 200,
      'canStart': canStart,
      'hasDebt': hasDebt,
      'balance': '45.20',
    };

class _Sheet {
  _Sheet(this.api, this.outcomes);
  final FakeApiClient api;
  final List<CallSheetOutcome> outcomes;
}

Future<_Sheet> _pumpSheet(
  WidgetTester tester, {
  Map<String, Object?>? estimate,
  String? lane,
  void Function(FakeApiClient api)? stub,
}) async {
  usePhoneScreen(tester);
  final api = FakeApiClient()
    ..onJson('GET', '/api/config', {'hfCallsEnabled': true})
    ..onJson('GET', _estimatePath, estimate ?? _tokenEstimate());
  stub?.call(api);
  final outcomes = <CallSheetOutcome>[];
  final container = ProviderContainer(overrides: [
    sessionProvider.overrideWith(() => StubSession(signedInState())),
    apiClientProvider.overrideWithValue(api),
    secureStoreProvider.overrideWithValue(MemoryKeyValueStore()),
  ]);
  addTearDown(container.dispose);
  await tester.pumpWidget(UncontrolledProviderScope(
    container: container,
    child: MaterialApp(
      theme: buildHfTheme(),
      home: Scaffold(
        body: CallConfirmSheet(slug: 'asha', hostName: 'Asha Verma', lane: lane, onOutcome: outcomes.add),
      ),
    ),
  ));
  await tester.pump();
  await tester.pump();
  return _Sheet(api, outcomes);
}

Future<void> _tapText(WidgetTester tester, String text) async {
  await tester.ensureVisible(find.text(text));
  await tester.tap(find.text(text));
  await tester.pump();
  await tester.pump();
}

void main() {
  testWidgets('shows host, price, estimate, the 2-minute rule and the safety reminder', (tester) async {
    prepareStorage();
    await _pumpSheet(tester);
    expect(find.text('Call Asha Verma'), findsOneWidget);
    expect(find.text('₹12/min'), findsOneWidget);
    expect(find.textContaining('tokens'), findsNothing);
    expect(find.text('Estimate: about 3 min 20 s with your balance'), findsOneWidget);
    expect(find.textContaining('2 minutes of balance'), findsOneWidget);
    expect(find.textContaining('Your phone will ring'), findsOneWidget);
    expect(find.textContaining('number stays private'), findsOneWidget);
    expect(find.textContaining('14416'), findsOneWidget);
    expect(find.textContaining('Press # at any time to end the call and block'), findsOneWidget);
    expect(find.text('Start call'), findsOneWidget);
  });

  testWidgets('old rupee mode shows the rate only', (tester) async {
    prepareStorage();
    await _pumpSheet(tester, estimate: {'mode': 'inr', 'ratePerMinRupees': 10});
    expect(find.text('₹10/min'), findsOneWidget);
    expect(find.textContaining('tokens/min'), findsNothing);
    expect(find.textContaining('Estimate:'), findsNothing);
    expect(find.text('Start call'), findsOneWidget);
  });

  testWidgets('Start call posts the host slug (and the lane when given) and remembers the call', (tester) async {
    prepareStorage();
    final s = await _pumpSheet(tester, lane: 'lgbtq', stub: (api) {
      api.onJson('POST', '/api/hf/calls', {'ok': true, 'callId': 'call-77', 'status': 'ringing_host', 'rate': 12, 'maxMinutes': 3, 'mode': 'tokens'});
    });
    await _tapText(tester, 'Start call');
    final posts = s.api.callsTo('POST', '/api/hf/calls');
    expect(posts, hasLength(1));
    expect(posts.first.body, {'hostSlug': 'asha', 'lane': 'lgbtq'});
    expect(s.outcomes, hasLength(1));
    expect(s.outcomes.first.action, CallSheetAction.started);
    expect(s.outcomes.first.value, 'call-77');
    final container = ProviderScope.containerOf(tester.element(find.byType(CallConfirmSheet)));
    expect(await tester.runAsync(container.read(activeCallStoreProvider).read), 'call-77');
  });

  testWidgets('no lane key when the lane is not given', (tester) async {
    prepareStorage();
    final s = await _pumpSheet(tester, stub: (api) {
      api.onJson('POST', '/api/hf/calls', {'ok': true, 'callId': 'call-78', 'status': 'ringing_host', 'rate': 12, 'maxMinutes': 3});
    });
    await _tapText(tester, 'Start call');
    expect(s.api.callsTo('POST', '/api/hf/calls').first.body, {'hostSlug': 'asha'});
  });

  testWidgets('not enough balance: Add money opens the Wallet, no Start call', (tester) async {
    prepareStorage();
    final s = await _pumpSheet(tester, estimate: _tokenEstimate(canStart: false, about: 'add tokens to call'));
    expect(find.text('Start call'), findsNothing);
    expect(find.textContaining('Estimate:'), findsNothing);
    await _tapText(tester, CallStrings.addTokens);
    expect(s.outcomes.single.action, CallSheetAction.wallet);
    expect(s.api.callsTo('POST', '/api/hf/calls'), isEmpty);
  });

  testWidgets('money owed: Clear what you owe opens the Wallet', (tester) async {
    prepareStorage();
    final s = await _pumpSheet(tester, estimate: _tokenEstimate(hasDebt: true));
    expect(find.text('Please clear the amount owed before calling.'), findsOneWidget);
    expect(find.text('Start call'), findsNothing);
    await _tapText(tester, CallStrings.clearWhatYouOwe);
    expect(s.outcomes.single.action, CallSheetAction.wallet);
  });

  testWidgets('calls flag off: Calls open soon, nothing to tap', (tester) async {
    prepareStorage();
    usePhoneScreen(tester);
    final api = FakeApiClient()
      ..onJson('GET', '/api/config', {'hfCallsEnabled': false})
      ..onJson('GET', _estimatePath, _tokenEstimate());
    final container = ProviderContainer(overrides: [
      sessionProvider.overrideWith(() => StubSession(signedInState())),
      apiClientProvider.overrideWithValue(api),
      secureStoreProvider.overrideWithValue(MemoryKeyValueStore()),
    ]);
    addTearDown(container.dispose);
    await tester.pumpWidget(UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        theme: buildHfTheme(),
        home: Scaffold(body: CallConfirmSheet(slug: 'asha', hostName: 'Asha', onOutcome: (_) {})),
      ),
    ));
    await tester.pump();
    await tester.pump();
    expect(find.text(CallStrings.callsOpenSoon), findsOneWidget);
    expect(find.text('Start call'), findsNothing);
  });

  testWidgets('estimate flag off (404 not_enabled) shows Calls open soon', (tester) async {
    prepareStorage();
    await _pumpSheet(tester, stub: (api) {
      api.onError('GET', _estimatePath, const ApiError(status: 404, code: 'not_enabled', message: 'Calls are not open yet.'));
    });
    expect(find.text(CallStrings.callsOpenSoon), findsOneWidget);
    expect(find.text('Start call'), findsNothing);
  });

  testWidgets('estimate fails: message and Try again', (tester) async {
    prepareStorage();
    var n = 0;
    await _pumpSheet(tester, stub: (api) {
      api.on('GET', _estimatePath, (_) {
        n++;
        if (n == 1) throw ApiError.network();
        return _tokenEstimate();
      });
    });
    expect(find.text('No internet. Check your connection.'), findsOneWidget);
    await _tapText(tester, 'Try again');
    expect(find.text('₹12/min'), findsOneWidget);
  });

  group('start errors', () {
    // code, status, extra body fields, message the screen must show, the action button (null = none), outcome of that button
    final cases = <(String, int, Map<String, Object?>, String, String?, CallSheetAction?)>[
      ('low_balance', 402, {'message': 'You need about ₹2.00 more in your wallet to start this call.', 'shortfallTokens': '2.00', 'shortfallPaise': 200},
          'You need about ₹2.00 more in your wallet to start this call.', CallStrings.addTokens, CallSheetAction.wallet),
      ('debt_open', 409, {'message': 'Please clear the amount owed before calling'},
          'Please clear the amount owed before calling', CallStrings.clearWhatYouOwe, CallSheetAction.wallet),
      ('lane_required', 403, {'message': 'Please verify to use this lane.', 'lane': 'lgbtq'},
          'Please verify to use this lane.', CallStrings.verifyToCall, CallSheetAction.lane),
      ('not_verified', 403, {'message': 'Please verify your WhatsApp number first.'},
          'Please verify your WhatsApp number first.', CallStrings.signInAgain, CallSheetAction.signIn),
      ('account_closing', 409, {'message': 'Your account is being closed.'}, 'Your account is being closed.', null, null),
      ('calls_not_ready', 503, {'message': "Calls aren't ready yet. Please try again later."},
          "Calls aren't ready yet. Please try again later.", null, null),
      ('not_enabled', 404, {'message': 'Calls are not open yet.'}, 'This is not open yet. Please check back soon.', null, null),
      ('wallet_busy', 503, {'message': "We couldn't check your balance. Please try again."},
          "We couldn't check your balance. Please try again.", 'Try again', null),
      ('call_failed', 502, {'message': "We couldn't place the call. Please try again."},
          "We couldn't place the call. Please try again.", 'Try again', null),
      ('rate_limited', 429, {'message': 'Too many tries.'}, 'Too many tries.', 'Try again', null),
    ];
    for (final c in cases) {
      testWidgets(c.$1, (tester) async {
        prepareStorage();
        final s = await _pumpSheet(tester, stub: (api) {
          api.onError('POST', '/api/hf/calls', ApiError(status: c.$2, code: c.$1, message: c.$3['message'] as String?, extra: {
            for (final e in c.$3.entries)
              if (e.key != 'message') e.key: e.value,
          }));
        });
        await _tapText(tester, 'Start call');
        expect(find.text(c.$4), findsOneWidget, reason: 'message for ${c.$1}');
        expect(s.outcomes, isEmpty, reason: 'the sheet stays open on an error');
        final label = c.$5;
        if (label != null) {
          expect(find.text(label), findsOneWidget);
          if (c.$6 != null) {
            await _tapText(tester, label);
            expect(s.outcomes.single.action, c.$6);
            if (c.$6 == CallSheetAction.lane) expect(s.outcomes.single.value, 'lgbtq');
          }
        } else {
          // Nothing to do but read the message: no second Start call either.
          expect(find.text('Start call'), findsNothing);
        }
      });
    }

    testWidgets('network failure: Try again starts the call', (tester) async {
      prepareStorage();
      var n = 0;
      final s = await _pumpSheet(tester, stub: (api) {
        api.on('POST', '/api/hf/calls', (_) {
          n++;
          if (n == 1) throw ApiError.network();
          return {'ok': true, 'callId': 'call-9', 'status': 'ringing_host', 'rate': 12, 'maxMinutes': 3};
        });
      });
      await _tapText(tester, 'Start call');
      expect(find.text('No internet. Check your connection.'), findsOneWidget);
      await _tapText(tester, 'Try again');
      expect(s.outcomes.single.action, CallSheetAction.started);
      expect(s.outcomes.single.value, 'call-9');
    });

    testWidgets('host_unavailable: calm sentence (never a rejection) and Notify me', (tester) async {
      prepareStorage();
      final s = await _pumpSheet(tester, stub: (api) {
        api.onError('POST', '/api/hf/calls',
            const ApiError(status: 409, code: 'host_unavailable', message: 'Some other server text.'));
        api.onJson('POST', '/api/hf/hosts/asha/notify', {'ok': true, 'subscribed': true});
      });
      await _tapText(tester, 'Start call');
      expect(find.text("This host isn't available right now."), findsOneWidget);
      expect(find.text('Some other server text.'), findsNothing);
      await _tapText(tester, 'Notify me');
      expect(s.api.callsTo('POST', '/api/hf/hosts/asha/notify'), hasLength(1));
      expect(find.text("We'll WhatsApp you when Asha is free."), findsOneWidget);
    });

    testWidgets('Notify me that needs a verified WhatsApp shows the server message', (tester) async {
      prepareStorage();
      await _pumpSheet(tester, stub: (api) {
        api.onError('POST', '/api/hf/calls', const ApiError(status: 409, code: 'host_unavailable'));
        api.onError('POST', '/api/hf/hosts/asha/notify',
            const ApiError(status: 403, code: 'not_verified', message: 'Please verify your WhatsApp number first.'));
      });
      await _tapText(tester, 'Start call');
      await _tapText(tester, 'Notify me');
      expect(find.text('Please verify your WhatsApp number first.'), findsOneWidget);
    });

    testWidgets('call_in_progress: Go to my call resumes the stored call', (tester) async {
      prepareStorage(activeCallId: 'call-old');
      final s = await _pumpSheet(tester, stub: (api) {
        api.onError('POST', '/api/hf/calls',
            const ApiError(status: 409, code: 'call_in_progress', message: 'You already have a call in progress.'));
      });
      await _tapText(tester, 'Start call');
      expect(find.text('You already have a call in progress.'), findsOneWidget);
      await _tapText(tester, CallStrings.goToMyCall);
      expect(s.outcomes.single.action, CallSheetAction.openCall);
      expect(s.outcomes.single.value, 'call-old');
    });
  });
}

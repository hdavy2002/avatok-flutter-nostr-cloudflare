import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/storage/account_storage.dart';
import 'package:hf_app/features/call/data/call_api.dart';
import 'package:hf_app/features/call/data/call_models.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/fake_api_client.dart';
import 'call_harness.dart';

const _statusPath = '/api/hf/calls/c1';

void main() {
  testWidgets('follows ringing_host, ringing_caller, connected, completed, then stops polling', (tester) async {
    prepareStorage();
    final api = FakeApiClient();
    late CallTestApp app;
    // connectedAt is set from the fake clock below (65 s before "now").
    final connectedAtSeconds = DateTime.utc(2026, 10, 10, 12).subtract(const Duration(seconds: 65)).millisecondsSinceEpoch ~/ 1000;
    api.on('GET', _statusPath, statusSequence([
      callJson('ringing_host'),
      callJson('ringing_caller'),
      callJson('connected', connectedAt: connectedAtSeconds),
      callJson('completed',
          connectedAt: connectedAtSeconds, billedMinutes: 3, chargedRupees: 36, endReason: 'caller_hangup', canReview: true),
    ]));

    app = await pumpCallApp(tester, api: api);
    expect(find.text('Your phone will ring in a few seconds'), findsOneWidget);
    expect(find.text("Ringing Asha… If they don't pick up, you won't be charged."), findsOneWidget);
    expect(find.text('Cancel call'), findsOneWidget);

    await pollOnce(tester);
    expect(find.text('Asha said yes. Your phone will ring now. Pick it up.'), findsOneWidget);
    expect(find.text('Cancel call'), findsOneWidget);

    await pollOnce(tester);
    expect(find.text('Connected'), findsOneWidget);
    expect(find.text('Cancel call'), findsNothing, reason: 'cancel is only offered before the call connects');
    expect(find.byKey(const ValueKey<String>('call-clock')), findsOneWidget);
    expect(tester.widget<Text>(find.byKey(const ValueKey<String>('call-clock'))).data, '01:05');
    // The clock ticks once a second from the server's start time.
    app.clock.now = app.clock.now.add(const Duration(seconds: 5));
    await tester.pump(const Duration(seconds: 1));
    expect(tester.widget<Text>(find.byKey(const ValueKey<String>('call-clock'))).data, '01:10');

    await pollOnce(tester);
    expect(find.text('Call ended'), findsOneWidget);
    expect(find.text('You ended the call.'), findsOneWidget);
    expect(find.text('3 min'), findsOneWidget);
    expect(find.text('₹36'), findsOneWidget);
    expect(find.text('Rate your call'), findsOneWidget);
    expect(find.text('Done'), findsOneWidget);

    final polls = api.callsTo('GET', _statusPath).length;
    expect(polls, 4);
    await tester.pump(const Duration(seconds: 20));
    expect(api.callsTo('GET', _statusPath), hasLength(polls), reason: 'a terminal status stops polling');
    await closeApp(tester);
  });

  testWidgets('a token call shows exact time and tokens spent', (tester) async {
    prepareStorage();
    final api = FakeApiClient()
      ..onJson('GET', _statusPath, callJson('completed',
          billedMinutes: 2, chargedRupees: 0, endReason: 'host_hangup', canReview: false,
          extra: {'billableSeconds': 72, 'tokensSpent': '1.20'}));
    await pumpCallApp(tester, api: api);
    expect(find.text('1 min 12 s'), findsOneWidget);
    expect(find.text('1.20 tokens'), findsOneWidget);
    expect(find.text('Asha ended the call.'), findsOneWidget);
    expect(find.text('Rate your call'), findsNothing, reason: 'canReview is false');
    await closeApp(tester);
  });

  group('terminal statuses', () {
    final cases = <String, (Map<String, Object?>, List<String>)>{
      'host_declined': (callJson('host_declined'), ["This host isn't available right now.", 'You were not charged.']),
      'blocked': (callJson('blocked'), ["This host isn't available right now.", 'You were not charged.']),
      'no_answer': (callJson('no_answer'), ["Asha didn't pick up.", 'You were not charged.']),
      'caller_no_answer': (callJson('caller_no_answer'), ["We couldn't reach your phone.", 'You were not charged.']),
      'failed': (callJson('failed', endReason: 'error'), ["The call couldn't connect.", 'The call ended because of a problem.']),
    };
    for (final e in cases.entries) {
      testWidgets(e.key, (tester) async {
        prepareStorage();
        final api = FakeApiClient()..onJson('GET', _statusPath, e.value.$1);
        await pumpCallApp(tester, api: api);
        for (final text in e.value.$2) {
          expect(find.text(text), findsOneWidget, reason: text);
        }
        expect(find.text('Done'), findsOneWidget);
        expect(find.text('Rate your call'), findsNothing);
        await tester.pump(const Duration(seconds: 10));
        expect(api.callsTo('GET', _statusPath), hasLength(1));
        await closeApp(tester);
      });
    }
  });

  testWidgets('Cancel call posts the cancel and shows the cancelled summary', (tester) async {
    prepareStorage();
    final api = FakeApiClient();
    var cancelled = false;
    api.on('GET', _statusPath, (_) => cancelled ? callJson('failed', endReason: 'caller_hangup') : callJson('ringing_host'));
    api.on('POST', '$_statusPath/cancel', (_) {
      cancelled = true;
      return {'ok': true, 'status': 'failed'};
    });
    await pumpCallApp(tester, api: api);
    await tester.tap(find.text('Cancel call'));
    await tester.pump();
    await tester.pump();
    expect(api.callsTo('POST', '$_statusPath/cancel'), hasLength(1));
    expect(find.text('Call cancelled.'), findsOneWidget);
    expect(find.text('You were not charged.'), findsOneWidget);
    await closeApp(tester);
  });

  testWidgets('Cancel too late: 409 already_connected shows the connected call', (tester) async {
    prepareStorage();
    final api = FakeApiClient();
    var connected = false;
    api.on('GET', _statusPath, (_) => connected ? callJson('connected') : callJson('ringing_caller'));
    api.on('POST', '$_statusPath/cancel', (_) {
      connected = true;
      throw const ApiError(status: 409, code: 'already_connected', message: 'The call is already connected.');
    });
    await pumpCallApp(tester, api: api);
    await tester.tap(find.text('Cancel call'));
    await tester.pump();
    await tester.pump();
    expect(find.text(CallStrings.tooLateToCancel), findsOneWidget);
    expect(find.text('Connected'), findsOneWidget);
    expect(find.text('Cancel call'), findsNothing);
    await closeApp(tester);
  });

  testWidgets('polling pauses in the background and polls again at once on resume', (tester) async {
    prepareStorage();
    final api = FakeApiClient()..onJson('GET', _statusPath, callJson('ringing_host'));
    await pumpCallApp(tester, api: api);
    expect(api.callsTo('GET', _statusPath), hasLength(1));

    final binding = tester.binding;
    binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump(const Duration(seconds: 30));
    expect(api.callsTo('GET', _statusPath), hasLength(1), reason: 'no polling in the background');

    binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(api.callsTo('GET', _statusPath), hasLength(2), reason: 'a poll right after resume');
    await pollOnce(tester);
    expect(api.callsTo('GET', _statusPath), hasLength(3), reason: 'then every 2 s again');
    await closeApp(tester);
  });

  testWidgets('keeps polling through network errors and says so after a few misses', (tester) async {
    prepareStorage();
    final api = FakeApiClient();
    var n = 0;
    api.on('GET', _statusPath, (_) {
      n++;
      if (n <= 3) throw ApiError.network();
      return callJson('connected');
    });
    await pumpCallApp(tester, api: api);
    await pollOnce(tester);
    await pollOnce(tester);
    expect(find.text(CallStrings.connectionTrouble), findsOneWidget);
    await pollOnce(tester);
    expect(find.text('Connected'), findsOneWidget);
    await closeApp(tester);
  });

  testWidgets('an unknown call (404) stops polling and offers Home', (tester) async {
    prepareStorage(activeCallId: 'c1');
    final api = FakeApiClient()
      ..onError('GET', _statusPath, const ApiError(status: 404, code: 'not_found', message: 'Call not found.'));
    final app = await pumpCallApp(tester, api: api);
    expect(find.text(CallStrings.callNotFound), findsOneWidget);
    await tester.pump(const Duration(seconds: 10));
    expect(api.callsTo('GET', _statusPath), hasLength(1));
    final stored = await tester.runAsync(() => app.container.read(activeCallStoreProvider).read());
    expect(stored, isNull, reason: 'a call the server does not know is forgotten');
    await tester.tap(find.text('Go to Home'));
    await tester.pump();
    await tester.pump();
    expect(find.text('HOME PAGE'), findsOneWidget);
    await closeApp(tester);
  });

  group('resume from the persisted call id', () {
    testWidgets('the open call id is saved, and forgotten when the call ends', (tester) async {
      prepareStorage();
      final api = FakeApiClient()
        ..on('GET', _statusPath, statusSequence([callJson('ringing_host'), callJson('completed', billedMinutes: 1, chargedRupees: 12)]));
      final app = await pumpCallApp(tester, api: api);
      final store = app.container.read(activeCallStoreProvider);
      expect(await tester.runAsync(store.read), 'c1');
      await pollOnce(tester);
      expect(find.text('Call ended'), findsOneWidget);
      expect(await tester.runAsync(store.read), isNull);
      await closeApp(tester);
    });

    testWidgets('a stored id that is still ringing resumes: provider answers the id, screen shows the call', (tester) async {
      prepareStorage(activeCallId: 'c1');
      final api = FakeApiClient()..onJson('GET', _statusPath, callJson('ringing_caller'));
      final app = await pumpCallApp(tester, api: api, location: '/');
      final id = await tester.runAsync(() => app.container.read(activeCallResumeProvider.future));
      expect(id, 'c1');
      app.router.go('/call/$id');
      await tester.pump();
      await tester.pump();
      await tester.pump();
      expect(find.text('Asha said yes. Your phone will ring now. Pick it up.'), findsOneWidget);
      await closeApp(tester);
    });

    testWidgets('a stored id whose call already ended is cleared and not resumed', (tester) async {
      prepareStorage(activeCallId: 'c1');
      final api = FakeApiClient()..onJson('GET', _statusPath, callJson('completed', billedMinutes: 2));
      final app = await pumpCallApp(tester, api: api, location: '/');
      final id = await tester.runAsync(() => app.container.read(activeCallResumeProvider.future));
      expect(id, isNull);
      expect(await tester.runAsync(app.container.read(activeCallStoreProvider).read), isNull);
      await closeApp(tester);
    });

    testWidgets('offline at start keeps the id (the call may still be live)', (tester) async {
      prepareStorage(activeCallId: 'c1');
      final api = FakeApiClient()..onError('GET', _statusPath, ApiError.network());
      final app = await pumpCallApp(tester, api: api, location: '/');
      final id = await tester.runAsync(() => app.container.read(activeCallResumeProvider.future));
      expect(id, 'c1');
      await closeApp(tester);
    });

    testWidgets('nothing stored means nothing to resume, and no request is made', (tester) async {
      prepareStorage();
      final api = FakeApiClient();
      final app = await pumpCallApp(tester, api: api, location: '/');
      final id = await tester.runAsync(() => app.container.read(activeCallResumeProvider.future));
      expect(id, isNull);
      expect(api.calls, isEmpty);
      await closeApp(tester);
    });

    testWidgets('storage is account scoped: another account sees no active call', (tester) async {
      prepareStorage();
      final app = await pumpCallApp(tester, api: FakeApiClient(), location: '/');
      final store = app.container.read(activeCallStoreProvider);
      await tester.runAsync(() => store.save('c9'));
      final prefs = await tester.runAsync(SharedPreferences.getInstance);
      expect(prefs!.getKeys(), contains('hf.active_call.v1_user_test'));
      expect(await tester.runAsync(store.read), 'c9');
      AccountScope.id = 'user_other';
      expect(await tester.runAsync(store.read), isNull);
      await closeApp(tester);
    });
  });

  testWidgets('Rate your call opens the review screen for this call', (tester) async {
    prepareStorage();
    final api = FakeApiClient()
      ..onJson('GET', _statusPath, callJson('completed', billedMinutes: 3, chargedRupees: 36, canReview: true))
      ..onJson('GET', '/api/hosts/public/asha', {'topics': <String>[]})
      ..onJson('GET', '/api/hf/options', {'topics': <Object>[]});
    await pumpCallApp(tester, api: api);
    await tester.tap(find.text('Rate your call'));
    await tester.pump();
    await tester.pump();
    await tester.pump();
    expect(find.text('Send review'), findsOneWidget);
    await closeApp(tester);
  });
}

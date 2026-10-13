import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/fake_api_client.dart';
import 'me_test_support.dart';

void main() {
  const row = ValueKey<String>('me-offline-reminders');
  late MeEvents events;
  setUp(() {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    events = MeEvents()..install();
  });
  tearDown(() => events.remove());

  bool switchOn(WidgetTester t) => t.widget<Switch>(find.byKey(row)).value;

  testWidgets('hidden for a person who is not a host', (tester) async {
    final api = FakeApiClient();
    await pumpMe(tester, session: meSession(), api: api);
    await tester.pumpAndSettle();
    expect(find.byKey(row), findsNothing);
    expect(api.callsTo('GET', '/api/hosts/me/presence'), isEmpty);
  });

  testWidgets('host: reads nudgesPaused, toggling sends the PUT body', (
    tester,
  ) async {
    final api = FakeApiClient()
      ..onJson('GET', '/api/hosts/me/presence', {
        'presence': 'offline',
        'nudgesPaused': false,
      })
      ..on(
        'PUT',
        '/api/hosts/me/presence/nudges',
        (c) => {'ok': true, 'paused': (c.body as Map)['paused']},
      );
    await pumpMe(
      tester,
      session: meSession(hostStatus: 'live'),
      api: api,
    );
    await tester.pumpAndSettle();
    expect(find.text('Offline reminders'), findsOneWidget);
    expect(
      find.text("A WhatsApp nudge every 3 hours while you're offline"),
      findsOneWidget,
    );
    expect(switchOn(tester), isTrue);

    await tapKeyed(tester, 'me-offline-reminders');
    await tester.pumpAndSettle();

    final puts = api.callsTo('PUT', '/api/hosts/me/presence/nudges');
    expect(puts, hasLength(1));
    expect(puts.single.body, {'paused': true});
    expect(switchOn(tester), isFalse);
    expect(events.named('hf_presence_nudge_toggle'), [
      {'on': false, 'outcome': 'ok'},
    ]);
  });

  testWidgets('host: a failed save flips back and shows a snackbar', (
    tester,
  ) async {
    final api = FakeApiClient()
      ..onJson('GET', '/api/hosts/me/presence', {
        'presence': 'offline',
        'nudgesPaused': true,
      })
      ..onError(
        'PUT',
        '/api/hosts/me/presence/nudges',
        const ApiError(status: 500, code: 'boom'),
      );
    await pumpMe(
      tester,
      session: meSession(hostStatus: 'live'),
      api: api,
    );
    await tester.pumpAndSettle();
    expect(switchOn(tester), isFalse);

    await tapKeyed(tester, 'me-offline-reminders');
    await tester.pumpAndSettle();

    expect(switchOn(tester), isFalse);
    expect(
      find.text("We couldn't update that. Please try again."),
      findsOneWidget,
    );
    expect(events.named('hf_presence_nudge_toggle'), [
      {'on': true, 'outcome': 'failed'},
    ]);
  });
}

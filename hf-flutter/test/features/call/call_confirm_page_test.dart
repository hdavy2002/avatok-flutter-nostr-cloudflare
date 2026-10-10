import 'package:flutter_test/flutter_test.dart';

import '../../support/fake_api_client.dart';
import 'call_harness.dart';

FakeApiClient _api() => FakeApiClient()
  ..onJson('GET', '/api/config', {'hfCallsEnabled': true})
  ..onJson('GET', '/api/hosts/public/asha', {'slug': 'asha', 'displayName': 'Asha Verma'})
  ..onJson('GET', '/api/hf/wallet/estimate', {
    'mode': 'tokens', 'ratePerMinRupees': 12, 'tokensPerMinute': '15.00', 'aboutText': 'about 3 min 20 s',
    'affordableSeconds': 200, 'canStart': true, 'hasDebt': false, 'balance': '45.20',
  })
  ..onJson('GET', '/api/hf/calls/call-new1', callJson('ringing_host', id: 'call-new1'));

void main() {
  testWidgets('/call/new?host=<slug> is the confirm step: host name, price, safety, Start call', (tester) async {
    prepareStorage();
    final api = _api();
    await pumpCallApp(tester, api: api, location: '/call/new?host=asha');
    expect(find.text('Call Asha Verma'), findsOneWidget);
    expect(find.text('₹12/min'), findsOneWidget);
    expect(find.text('Estimate: about 3 min 20 s with your balance'), findsOneWidget);
    expect(find.textContaining('14416'), findsOneWidget);
    expect(api.callsTo('GET', '/api/hf/wallet/estimate').single.query, {'host': 'asha'});
    await closeApp(tester);
  });

  testWidgets('Start call replaces the page with the call screen and remembers the call', (tester) async {
    prepareStorage();
    final api = _api()
      ..onJson('POST', '/api/hf/calls', {'ok': true, 'callId': 'call-new1', 'status': 'ringing_host', 'rate': 12, 'maxMinutes': 3});
    await pumpCallApp(tester, api: api, location: '/call/new?host=asha');
    await tester.ensureVisible(find.text('Start call'));
    await tester.tap(find.text('Start call'));
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(api.callsTo('POST', '/api/hf/calls').single.body, {'hostSlug': 'asha'});
    expect(find.text('Your phone will ring in a few seconds'), findsOneWidget);
    await closeApp(tester);
  });

  testWidgets('the LGBTQ+ lane is passed on, other lane values are ignored', (tester) async {
    prepareStorage();
    final api = _api()
      ..onJson('POST', '/api/hf/calls', {'ok': true, 'callId': 'call-new1', 'status': 'ringing_host', 'rate': 12, 'maxMinutes': 3});
    await pumpCallApp(tester, api: api, location: '/call/new?host=asha&lane=lgbtq');
    await tester.ensureVisible(find.text('Start call'));
    await tester.tap(find.text('Start call'));
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(api.callsTo('POST', '/api/hf/calls').single.body, {'hostSlug': 'asha', 'lane': 'lgbtq'});
    await closeApp(tester);
  });

  testWidgets('without a host there is nothing to confirm', (tester) async {
    prepareStorage();
    final api = FakeApiClient();
    await pumpCallApp(tester, api: api, location: '/call/new');
    expect(find.text('Choose someone to call first.'), findsOneWidget);
    expect(api.calls, isEmpty);
    await closeApp(tester);
  });

  testWidgets('Not now goes back', (tester) async {
    prepareStorage();
    await pumpCallApp(tester, api: _api(), location: '/call/new?host=asha');
    await tester.ensureVisible(find.text('Not now'));
    await tester.tap(find.text('Not now'));
    await tester.pump();
    await tester.pump();
    expect(find.text('HOME PAGE'), findsOneWidget);
    await closeApp(tester);
  });

  testWidgets('a host name that cannot be read still lets the call be confirmed', (tester) async {
    prepareStorage();
    final api = _api()..onJson('GET', '/api/hosts/public/asha', <String, Object?>{});
    await pumpCallApp(tester, api: api, location: '/call/new?host=asha');
    expect(find.text('Call your host'), findsOneWidget);
    expect(find.text('Start call'), findsOneWidget);
    await closeApp(tester);
  });
}

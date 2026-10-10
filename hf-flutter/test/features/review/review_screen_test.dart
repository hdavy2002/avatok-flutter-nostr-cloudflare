import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';
import '../call/call_harness.dart';

const _callPath = '/api/hf/calls/c1';
const _token = 'tok_abcdefghijklmnop';
const _tokenPath = '/api/hf/review/$_token';

FakeApiClient _callApi({bool canReview = true, bool topics = true}) {
  final api = FakeApiClient()
    ..onJson('GET', _callPath, callJson('completed', billedMinutes: 3, chargedRupees: 36, canReview: canReview))
    ..onJson('GET', '/api/hosts/public/asha', {'topics': topics ? ['stress', 'career'] : <String>[]})
    ..onJson('GET', '/api/hf/options', {
      'topics': [
        {'slug': 'stress', 'label': 'Tension'},
        {'slug': 'career', 'label': 'Career'},
        {'slug': 'other', 'label': 'Something else'},
      ],
    });
  return api;
}

FakeApiClient _tokenApi({bool already = false}) {
  final api = FakeApiClient()
    ..onJson('GET', _tokenPath, {
      'hostName': 'Asha Verma', 'hostSlug': 'asha', 'callDate': '9 Oct', 'minutes': 5, 'alreadyReviewed': already,
    })
    ..onJson('GET', '/api/hosts/public/asha', {'topics': <String>[]})
    ..onJson('GET', '/api/hf/options', {'topics': <Object>[]});
  return api;
}

Future<void> _tapStar(WidgetTester tester, int n) async {
  // The five star icons keep their order whether filled or not.
  final stars = find.byWidgetPredicate(
      (w) => w is Icon && (w.icon == Icons.star_rounded || w.icon == Icons.star_outline_rounded));
  await tester.tap(stars.at(n - 1));
  await tester.pump();
}

Future<void> _send(WidgetTester tester) async {
  await tester.scrollUntilVisible(find.text('Send review'), 300, scrollable: find.byType(Scrollable).first);
  await tester.tap(find.text('Send review'));
  await tester.pump();
  await tester.pump();
}

void main() {
  group('signed-in path (from the call screen)', () {
    testWidgets('shows stars, text, host topics only, and the checked-first-name note', (tester) async {
      prepareStorage();
      await pumpCallApp(tester, api: _callApi(), location: '/review/call/c1');
      expect(find.text('How was your call with Asha?'), findsOneWidget);
      expect(find.byIcon(Icons.star_outline_rounded), findsNWidgets(5));
      expect(find.text('0/500'), findsOneWidget);
      expect(find.text('Tension'), findsOneWidget);
      expect(find.text('Career'), findsOneWidget);
      expect(find.text('Something else'), findsNothing, reason: 'only the host topics are offered');
      expect(find.text('Reviews are checked before they appear. Only your first name is shown.'), findsOneWidget);
      await closeApp(tester);
    });

    testWidgets('sends stars, text and topic to the call review route', (tester) async {
      prepareStorage();
      final api = _callApi()..onJson('POST', '$_callPath/review', {'ok': true});
      await pumpCallApp(tester, api: api, location: '/review/call/c1');
      await _tapStar(tester, 4);
      expect(find.byIcon(Icons.star_rounded), findsNWidgets(4));
      expect(find.text('Good'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'Very kind and patient listener');
      await tester.tap(find.text('Tension'));
      await tester.pump();
      await _send(tester);
      final posts = api.callsTo('POST', '$_callPath/review');
      expect(posts, hasLength(1));
      expect(posts.first.body, {'stars': 4, 'text': 'Very kind and patient listener', 'topic': 'stress'});
      expect(posts.first.auth, isTrue);
      expect(find.text('Thank you!'), findsOneWidget);
      expect(find.textContaining('Only your first name is shown.'), findsOneWidget);
      expect(find.text("See Asha's page"), findsOneWidget);
      await closeApp(tester);
    });

    testWidgets('stars only is enough', (tester) async {
      prepareStorage();
      final api = _callApi(topics: false)..onJson('POST', '$_callPath/review', {'ok': true});
      await pumpCallApp(tester, api: api, location: '/review/call/c1');
      await _tapStar(tester, 5);
      await _send(tester);
      expect(api.callsTo('POST', '$_callPath/review').first.body, {'stars': 5});
      expect(find.text('Thank you!'), findsOneWidget);
      await closeApp(tester);
    });

    testWidgets('no stars: asks for a star and sends nothing', (tester) async {
      prepareStorage();
      final api = _callApi();
      await pumpCallApp(tester, api: api, location: '/review/call/c1');
      await _send(tester);
      expect(find.text('Please tap a star first.'), findsOneWidget);
      expect(api.callsTo('POST', '$_callPath/review'), isEmpty);
      // tapping a star clears the message
      await tester.tap(find.byIcon(Icons.star_outline_rounded).first);
      await tester.pump();
      expect(find.text('Please tap a star first.'), findsNothing);
      await closeApp(tester);
    });

    testWidgets('a phone number, email or link is refused on the phone', (tester) async {
      prepareStorage();
      final api = _callApi();
      await pumpCallApp(tester, api: api, location: '/review/call/c1');
      await _tapStar(tester, 5);
      for (final t in ['call me on 9876543210', 'mail me at asha@example.com', 'see https://example.com']) {
        await tester.enterText(find.byType(TextField), t);
        await _send(tester);
        expect(find.textContaining('Please remove phone numbers, emails or links'), findsOneWidget, reason: t);
      }
      expect(api.callsTo('POST', '$_callPath/review'), isEmpty);
      await closeApp(tester);
    });

    testWidgets('text that is too short is refused on the phone', (tester) async {
      prepareStorage();
      final api = _callApi();
      await pumpCallApp(tester, api: api, location: '/review/call/c1');
      await _tapStar(tester, 3);
      await tester.enterText(find.byType(TextField), 'ok');
      await _send(tester);
      expect(find.text('Write a few words, or leave the text empty.'), findsOneWidget);
      expect(api.callsTo('POST', '$_callPath/review'), isEmpty);
      await closeApp(tester);
    });

    testWidgets('the text stops at 500 characters', (tester) async {
      prepareStorage();
      await pumpCallApp(tester, api: _callApi(), location: '/review/call/c1');
      await tester.enterText(find.byType(TextField), 'ab' * 300);
      await tester.pump();
      expect(find.text('500/500'), findsOneWidget);
      await closeApp(tester);
    });

    testWidgets('the server can still refuse: its message shows and the form stays', (tester) async {
      prepareStorage();
      final api = _callApi()
        ..onError('POST', '$_callPath/review',
            const ApiError(status: 422, code: 'contact_details', message: 'Please remove phone numbers, links and handles from your review.'));
      await pumpCallApp(tester, api: api, location: '/review/call/c1');
      await _tapStar(tester, 5);
      await tester.enterText(find.byType(TextField), 'Lovely and calm person');
      await _send(tester);
      expect(find.textContaining('Please remove phone numbers, emails or links'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('Send review'), 300, scrollable: find.byType(Scrollable).first);
      expect(find.text('Send review'), findsOneWidget);
      expect(find.text('Thank you!'), findsNothing);
      await closeApp(tester);
    });

    testWidgets('a network failure keeps what was typed and shows the message', (tester) async {
      prepareStorage();
      final api = _callApi()..onError('POST', '$_callPath/review', ApiError.network());
      await pumpCallApp(tester, api: api, location: '/review/call/c1');
      await _tapStar(tester, 5);
      await tester.enterText(find.byType(TextField), 'Lovely and calm person');
      await _send(tester);
      expect(find.text('No internet. Check your connection.'), findsOneWidget);
      expect(find.text('Lovely and calm person'), findsOneWidget);
      await closeApp(tester);
    });

    testWidgets('409 already_reviewed shows the thanks message', (tester) async {
      prepareStorage();
      final api = _callApi()
        ..onError('POST', '$_callPath/review', const ApiError(status: 409, code: 'already_reviewed', message: 'You already reviewed this call.'));
      await pumpCallApp(tester, api: api, location: '/review/call/c1');
      await _tapStar(tester, 5);
      await _send(tester);
      expect(find.text('Thanks, you already reviewed this call.'), findsOneWidget);
      await closeApp(tester);
    });

    testWidgets('a call that cannot be reviewed says so', (tester) async {
      prepareStorage();
      await pumpCallApp(tester, api: _callApi(canReview: false), location: '/review/call/c1');
      expect(find.textContaining('can no longer be reviewed'), findsOneWidget);
      expect(find.text('Send review'), findsNothing);
      await closeApp(tester);
    });

    testWidgets('after thanks, See the page opens the host profile', (tester) async {
      prepareStorage();
      final api = _callApi(topics: false)..onJson('POST', '$_callPath/review', {'ok': true});
      await pumpCallApp(tester, api: api, location: '/review/call/c1');
      await _tapStar(tester, 5);
      await _send(tester);
      await tester.tap(find.text("See Asha's page"));
      await tester.pump();
      await tester.pump();
      expect(find.text('PROFILE asha'), findsOneWidget);
      await closeApp(tester);
    });
  });

  group('WhatsApp link path (no sign-in)', () {
    testWidgets('works signed out: reads and posts the review without a bearer token', (tester) async {
      prepareStorage();
      final api = _tokenApi()..onJson('POST', _tokenPath, {'ok': true});
      await pumpCallApp(tester, api: api, location: '/review/$_token', session: signedOutState());
      expect(find.text('How was your call with Asha?'), findsOneWidget);
      expect(find.text('9 Oct · 5 min'), findsOneWidget);
      expect(find.text('SIGN IN PAGE'), findsNothing);
      expect(api.callsTo('GET', _tokenPath).first.auth, isFalse);
      await _tapStar(tester, 5);
      await tester.enterText(find.byType(TextField), 'Gentle and wise, thank you');
      await _send(tester);
      final posts = api.callsTo('POST', _tokenPath);
      expect(posts, hasLength(1));
      expect(posts.first.auth, isFalse);
      expect(posts.first.body, {'stars': 5, 'text': 'Gentle and wise, thank you'});
      expect(find.text('Thank you!'), findsOneWidget);
      await closeApp(tester);
    });

    testWidgets('already reviewed: thanks, no form', (tester) async {
      prepareStorage();
      await pumpCallApp(tester, api: _tokenApi(already: true), location: '/review/$_token', session: signedOutState());
      expect(find.text('Thanks, you already reviewed this call.'), findsOneWidget);
      expect(find.text('Send review'), findsNothing);
      await closeApp(tester);
    });

    testWidgets('an unknown link (404) is friendly', (tester) async {
      prepareStorage();
      final api = FakeApiClient()
        ..onError('GET', _tokenPath, const ApiError(status: 404, code: 'not_found', message: "This review link isn't valid."));
      await pumpCallApp(tester, api: api, location: '/review/$_token', session: signedOutState());
      expect(find.text("This review link isn't valid."), findsOneWidget);
      expect(find.text('Send review'), findsNothing);
      await closeApp(tester);
    });

    testWidgets('an expired link (410) is friendly', (tester) async {
      prepareStorage();
      final api = FakeApiClient()
        ..onError('GET', _tokenPath, const ApiError(status: 410, code: 'expired', message: 'This review link has expired.'));
      await pumpCallApp(tester, api: api, location: '/review/$_token', session: signedOutState());
      expect(find.textContaining('This review link has expired'), findsOneWidget);
      expect(find.text('Send review'), findsNothing);
      await closeApp(tester);
    });

    testWidgets('the link expiring while typing shows the expired message', (tester) async {
      prepareStorage();
      final api = _tokenApi()
        ..onError('POST', _tokenPath, const ApiError(status: 410, code: 'expired', message: 'This review link has expired.'));
      await pumpCallApp(tester, api: api, location: '/review/$_token', session: signedOutState());
      await _tapStar(tester, 4);
      await _send(tester);
      expect(find.textContaining('This review link has expired'), findsOneWidget);
      await closeApp(tester);
    });

    testWidgets('a connection problem offers Try again', (tester) async {
      prepareStorage();
      var n = 0;
      final api = _tokenApi();
      api.on('GET', _tokenPath, (_) {
        n++;
        if (n == 1) throw ApiError.network();
        return {'hostName': 'Asha Verma', 'hostSlug': 'asha', 'callDate': '9 Oct', 'minutes': 5, 'alreadyReviewed': false};
      });
      await pumpCallApp(tester, api: api, location: '/review/$_token', session: signedOutState());
      expect(find.text('No internet. Check your connection.'), findsOneWidget);
      await tester.tap(find.text('Try again'));
      await tester.pump();
      await tester.pump();
      await tester.pump();
      expect(find.text('Send review'), findsOneWidget);
      await closeApp(tester);
    });
  });
}

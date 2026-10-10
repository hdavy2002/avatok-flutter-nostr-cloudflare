import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/features/me/data/notification_control.dart';
import 'package:hf_app/features/me/ui/me_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';
import '../../support/kyc_fakes.dart' show FakeLinkOpener;
import 'me_test_support.dart';

const _patchMe = '/api/hf/me';

Finder _key(String k) => find.byKey(ValueKey<String>(k));

void main() {
  late FakeApiClient api;
  late MeEvents events;

  setUp(() {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    api = FakeApiClient();
    events = MeEvents()..install();
  });

  tearDown(() => events.remove());

  group('signed out', () {
    testWidgets('shows the sign-in card, the help and legal links, and no account actions', (tester) async {
      usePhoneScreen(tester);
      final container = ProviderContainer(overrides: [
        sessionProvider.overrideWith(() => RecordingSession(signedOutState())),
        notificationControlProvider.overrideWithValue(FakeNotificationControl()),
      ]);
      addTearDown(container.dispose);
      await tester.pumpWidget(UncontrolledProviderScope(
        container: container,
        child: MaterialApp(theme: buildHfTheme(), home: const MeScreen()),
      ));
      await tester.pumpAndSettle();

      expect(_key('me-sign-in'), findsOneWidget);
      expect(find.text(MeCopy.signInBody), findsOneWidget);
      for (final l in MeCopy.links) {
        expect(_key('me-link-${l.$1}'), findsOneWidget, reason: l.$2);
      }
      expect(_key('me-sign-out'), findsNothing);
      expect(_key('me-delete'), findsNothing);
      expect(_key('me-edit-name'), findsNothing);
      expect(events.named('hf_app_me_viewed'), [
        {'signed_in': false},
      ]);
    });
  });

  group('signed in', () {
    testWidgets('shows the name, the masked WhatsApp number, spaces and the host link', (tester) async {
      await pumpMe(tester, session: meSession(women: true, hostStatus: null), api: api);

      expect(find.text('Asha'), findsOneWidget);
      expect(find.text('WhatsApp ******3210'), findsOneWidget);
      // The full number is never shown.
      expect(find.textContaining('+91'), findsNothing);

      expect(find.descendant(of: _key('me-lane-women'), matching: find.text(MeCopy.youAreIn)), findsOneWidget);
      expect(_key('me-lane-women-leave'), findsOneWidget);
      expect(find.descendant(of: _key('me-lane-lgbtq'), matching: find.text(MeCopy.notJoined)), findsOneWidget);
      expect(_key('me-lane-lgbtq-join'), findsOneWidget);

      expect(_key('me-become-host'), findsOneWidget);
      expect(_key('me-host'), findsNothing);
      expect(_key('me-sign-out'), findsOneWidget);
      expect(_key('me-delete'), findsOneWidget);
      expect(events.named('hf_app_me_viewed'), [
        {'signed_in': true},
      ]);
    });

    testWidgets('a person with a host profile sees the dashboard link, not Become a host', (tester) async {
      await pumpMe(tester, session: meSession(hostStatus: 'live'), api: api);
      expect(_key('me-host'), findsOneWidget);
      expect(find.text(MeCopy.hostDashboard), findsOneWidget);
      expect(_key('me-become-host'), findsNothing);
    });

    testWidgets('no name yet asks for one', (tester) async {
      await pumpMe(tester, session: meSession(name: null), api: api);
      expect(find.text(MeCopy.noName), findsOneWidget);
    });

    testWidgets('a closing account shows the status card', (tester) async {
      await pumpMe(tester, session: meSession(closing: true), api: api);
      expect(_key('me-closing'), findsOneWidget);
      expect(find.text(MeCopy.closingTitle), findsOneWidget);
    });
  });

  group('name', () {
    Future<void> openSheet(WidgetTester tester) async {
      await tapKeyed(tester, 'me-edit-name', ms: 600);
      expect(_key('name-field'), findsOneWidget);
    }

    testWidgets('saves a new name with PATCH and shows it at once', (tester) async {
      api.on('PATCH', _patchMe, (call) => {'ok': true, 'displayName': (call.body as Map)['displayName']});
      final container = await pumpMe(tester, session: meSession(), api: api);
      await openSheet(tester);

      await tester.enterText(_key('name-field'), '  Asha Rao ');
      await tapKeyed(tester, 'name-save', ms: 800);

      expect(api.callsTo('PATCH', _patchMe), hasLength(1));
      expect((api.callsTo('PATCH', _patchMe).single.body as Map)['displayName'], 'Asha Rao');
      expect(_key('name-field'), findsNothing); // the sheet closed
      expect(find.text('Asha Rao'), findsOneWidget);
      expect((container.read(sessionProvider.notifier) as RecordingSession).refreshes, 1);
      expect(events.named('hf_app_name_updated'), [
        {'outcome': 'ok'},
      ]);
    });

    testWidgets("the worker's validation message shows under the field and the sheet stays open", (tester) async {
      api.onError(
        'PATCH',
        _patchMe,
        const ApiError(
          status: 400,
          code: 'invalid_field',
          message: "Your name can't have numbers in it.",
          field: 'displayName',
        ),
      );
      await pumpMe(tester, session: meSession(), api: api);
      await openSheet(tester);

      await tester.enterText(_key('name-field'), 'Asha 99');
      await tapKeyed(tester, 'name-save', ms: 400);

      expect(find.text("Your name can't have numbers in it."), findsOneWidget);
      expect(_key('name-field'), findsOneWidget);
      expect(find.text('Asha'), findsOneWidget); // the old name is still shown behind the sheet
      expect(events.named('hf_app_name_updated'), [
        {'outcome': 'failed', 'reason': 'invalid_field', 'status': 400},
      ]);

      // Typing again clears the message.
      await tester.enterText(_key('name-field'), 'Asha R');
      await tester.pump();
      expect(find.text("Your name can't have numbers in it."), findsNothing);
    });

    testWidgets('an empty name is refused on the phone, without calling the worker', (tester) async {
      await pumpMe(tester, session: meSession(), api: api);
      await openSheet(tester);

      await tester.enterText(_key('name-field'), '   ');
      await tapKeyed(tester, 'name-save', ms: 300);

      expect(find.text('Please enter your name.'), findsOneWidget);
      expect(api.callsTo('PATCH', _patchMe), isEmpty);
      expect(events.named('hf_app_name_updated'), [
        {'outcome': 'failed', 'reason': 'empty'},
      ]);
    });

    testWidgets('no internet shows the offline message', (tester) async {
      api.onError('PATCH', _patchMe, ApiError.network());
      await pumpMe(tester, session: meSession(), api: api);
      await openSheet(tester);

      await tester.enterText(_key('name-field'), 'Asha Rao');
      await tapKeyed(tester, 'name-save', ms: 400);

      expect(find.text('No internet. Check your connection.'), findsOneWidget);
    });
  });

  group('spaces', () {
    testWidgets('Leave asks first, then calls DELETE and shows Not joined', (tester) async {
      api.onJson('DELETE', '/api/hf/lanes/women', {'ok': true});
      await pumpMe(tester, session: meSession(women: true), api: api);

      await tapKeyed(tester, 'me-lane-women-leave', ms: 400);
      expect(find.text(MeCopy.leaveTitle), findsOneWidget);
      expect(api.callsTo('DELETE', '/api/hf/lanes/women'), isEmpty);

      await tapKeyed(tester, 'me-leave-confirm', ms: 600);
      expect(api.callsTo('DELETE', '/api/hf/lanes/women'), hasLength(1));
      expect(find.descendant(of: _key('me-lane-women'), matching: find.text(MeCopy.notJoined)), findsOneWidget);
      expect(_key('me-lane-women-join'), findsOneWidget);
    });

    testWidgets('Stay on the question leaves everything as it was', (tester) async {
      await pumpMe(tester, session: meSession(women: true), api: api);
      await tapKeyed(tester, 'me-lane-women-leave', ms: 400);
      await tester.tap(find.text(MeCopy.leaveStay));
      await pumpFor(tester, 400);
      expect(api.calls, isEmpty);
      expect(_key('me-lane-women-leave'), findsOneWidget);
    });

    testWidgets('a failed leave shows the message and keeps the space', (tester) async {
      api.onError('DELETE', '/api/hf/lanes/women', const ApiError(status: 500, code: 'internal_error', message: 'Please try again.'));
      await pumpMe(tester, session: meSession(women: true), api: api);
      await tapKeyed(tester, 'me-lane-women-leave', ms: 400);
      await tapKeyed(tester, 'me-leave-confirm', ms: 600);
      expect(find.text('Please try again.'), findsOneWidget);
      expect(find.descendant(of: _key('me-lane-women'), matching: find.text(MeCopy.youAreIn)), findsOneWidget);
    });

    testWidgets('Join opens the lane screen', (tester) async {
      api.onJson('GET', '/api/hf/lanes/me', {
        'whatsappVerified': true,
        'aadhaarVerified': false,
        'gender': null,
        'lanes': {
          'women': {'eligible': false, 'granted': false},
          'lgbtq': {'declared': false, 'granted': false},
        },
      });
      await pumpMe(tester, session: meSession(), api: api);
      await tapKeyed(tester, 'me-lane-lgbtq-join', ms: 600);
      expect(api.callsTo('GET', '/api/hf/lanes/me'), isNotEmpty);
    });
  });

  group('notifications', () {
    testWidgets('the switch shows the permission and asks for it when turned on', (tester) async {
      final control = FakeNotificationControl(enabled: false);
      await pumpMe(
        tester,
        session: meSession(),
        api: api,
        notifications: control,
      );
      expect(tester.widget<Switch>(_key('me-notifications')).value, isFalse);

      await tapKeyed(tester, 'me-notifications', ms: 300);
      expect(control.requests, [true]);
      expect(tester.widget<Switch>(_key('me-notifications')).value, isTrue);

      await tapKeyed(tester, 'me-notifications', ms: 300);
      expect(control.requests, [true, false]);
      expect(tester.widget<Switch>(_key('me-notifications')).value, isFalse);
    });

    testWidgets('when the phone settings must finish the change, the switch keeps the real state', (tester) async {
      final control = FakeNotificationControl(enabled: false, canChange: false);
      await pumpMe(
        tester,
        session: meSession(),
        api: api,
        notifications: control,
      );
      await tapKeyed(tester, 'me-notifications', ms: 300);
      expect(control.requests, [true]);
      expect(tester.widget<Switch>(_key('me-notifications')).value, isFalse);
    });
  });

  group('help and legal', () {
    testWidgets('every link opens its site page in a Custom Tab', (tester) async {
      final links = FakeLinkOpener();
      await pumpMe(tester, session: meSession(), api: api, links: links);
      for (final l in MeCopy.links) {
        await tapKeyed(tester, 'me-link-${l.$1}', ms: 100);
      }
      expect(links.sitePaths, [for (final l in MeCopy.links) l.$3]);
      expect(links.sitePaths, containsAll(<String>['/terms', '/privacy', '/safety', '/grievance', '/community-guidelines', '/data-deletion', '/help']));
    });

    testWidgets('a page that cannot open says so', (tester) async {
      final links = _ClosedLinks();
      await pumpMe(tester, session: meSession(), api: api, links: links);
      await tapKeyed(tester, 'me-link-terms', ms: 300);
      expect(find.text(MeCopy.couldNotOpenPage), findsOneWidget);
    });
  });

  group('sign out and delete', () {
    testWidgets('Sign out goes Home and signs out', (tester) async {
      final container = await pumpMe(tester, session: meSession(), api: api);
      await tapKeyed(tester, 'me-sign-out', ms: 600);
      final session = container.read(sessionProvider.notifier) as RecordingSession;
      expect(session.signOuts, 1);
      expect(container.read(sessionProvider).isSignedIn, isFalse);
      expect(_key('me-sign-out'), findsNothing);
    });

    testWidgets('Delete my account opens the delete screen', (tester) async {
      api.onJson('GET', '/api/hf/account/exit', {'decision': 'delete', 'gateEnabled': true});
      await pumpMe(tester, session: meSession(), api: api);
      await tapKeyed(tester, 'me-delete', ms: 600);
      expect(api.callsTo('GET', '/api/hf/account/exit'), hasLength(1));
      expect(_key('delete-path'), findsOneWidget);
    });
  });
}

class _ClosedLinks extends FakeLinkOpener {
  _ClosedLinks() : super(result: false);

  @override
  Future<bool> site(String path) async => false;
}

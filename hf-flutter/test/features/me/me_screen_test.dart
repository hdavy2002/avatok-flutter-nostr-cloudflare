import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/router/app_router.dart';
import 'package:hf_app/core/router/routes.dart';
import 'package:hf_app/features/welcome/data/ack_service.dart';
import 'package:hf_app/core/auth/hf_me.dart';
import 'package:hf_app/core/auth/clerk_client.dart';
import 'package:hf_app/core/theme/theme_mode_store.dart';
import 'package:hf_app/core/widgets/hf_floating_nav.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/features/me/data/notification_control.dart';
import 'package:hf_app/features/me/ui/me_screen.dart';
import 'package:hf_app/features/call/data/call_api.dart';
import 'package:hf_app/features/wallet/billing/purchase_controller.dart';
import 'package:hf_app/features/wallet/wallet_providers.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';
import '../../support/kyc_fakes.dart' show FakeLinkOpener;
import 'me_test_support.dart';

const _patchMe = '/api/hf/me';

Finder _key(String k) => find.byKey(ValueKey<String>(k));

class _OpenPurchase extends PurchaseController {
  @override
  PurchaseState build() => const PurchaseState(phase: PurchasePhase.awaitingSheet);
}

class _ActiveCall extends ActiveCallStore {
  @override
  Future<String?> read() async => 'active-call';
}

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
    testWidgets(
      'shows the sign-in card, the help and legal links, and no account actions',
      (tester) async {
        usePhoneScreen(tester);
        final container = ProviderContainer(
          overrides: [
            sessionProvider.overrideWith(
              () => RecordingSession(signedOutState()),
            ),
            notificationControlProvider.overrideWithValue(
              FakeNotificationControl(),
            ),
          ],
        );
        addTearDown(container.dispose);
        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: MaterialApp(theme: buildHfTheme(), home: const MeScreen()),
          ),
        );
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
      },
    );
  });

  group('signed in', () {
    testWidgets('switching accounts is blocked while the Play sheet is active', (tester) async {
      final c = await pumpMe(tester, session: meSession(), api: api, overrides: [
        purchaseControllerProvider.overrideWith(_OpenPurchase.new),
      ]);
      await tapKeyed(tester, 'me-switch-account');
      expect((c.read(sessionProvider.notifier) as RecordingSession).signOuts, 0);
      expect(find.text('Finish your purchase before leaving this account.'), findsOneWidget);
    });

    testWidgets('switching accounts is blocked while a call is connected', (tester) async {
      api.onJson('GET', '/api/hf/calls/active-call', {'id': 'active-call', 'status': 'connected'});
      final c = await pumpMe(tester, session: meSession(), api: api, overrides: [
        activeCallStoreProvider.overrideWithValue(_ActiveCall()),
      ]);
      await tapKeyed(tester, 'me-switch-account');
      expect((c.read(sessionProvider.notifier) as RecordingSession).signOuts, 0);
      expect(find.text('Finish your active call before leaving this account.'), findsOneWidget);
    });

    testWidgets('an unreachable active call check cannot silently permit switching', (tester) async {
      api.onError('GET', '/api/hf/calls/active-call', ApiError.network());
      final c = await pumpMe(tester, session: meSession(), api: api, overrides: [
        activeCallStoreProvider.overrideWithValue(_ActiveCall()),
      ]);
      await tapKeyed(tester, 'me-switch-account');
      expect((c.read(sessionProvider.notifier) as RecordingSession).signOuts, 0);
      expect(find.text('We could not confirm that your call ended. Please try again.'), findsOneWidget);
    });
    testWidgets(
      'shows the name, the masked WhatsApp number, spaces and the host link',
      (tester) async {
        await pumpMe(
          tester,
          session: meSession(women: true, hostStatus: null),
          api: api,
        );

        expect(find.text('Asha'), findsOneWidget);
        expect(find.text('WhatsApp ******3210'), findsOneWidget);
        // The full number is never shown.
        expect(find.textContaining('+91'), findsNothing);

        expect(
          find.descendant(
            of: _key('me-lane-women'),
            matching: find.text(MeCopy.youAreIn),
          ),
          findsOneWidget,
        );
        expect(_key('me-lane-women-leave'), findsOneWidget);
        expect(
          find.descendant(
            of: _key('me-lane-lgbtq'),
            matching: find.text(MeCopy.notJoined),
          ),
          findsOneWidget,
        );
        expect(_key('me-lane-lgbtq-join'), findsOneWidget);

        expect(_key('me-become-host'), findsOneWidget);
        expect(_key('me-host'), findsNothing);
        expect(_key('me-sign-out'), findsOneWidget);
        expect(_key('me-delete'), findsOneWidget);
        expect(events.named('hf_app_me_viewed'), [
          {'signed_in': true},
        ]);
      },
    );

    testWidgets(
      'a person with a host profile sees the dashboard link, not Become a host',
      (tester) async {
        await pumpMe(
          tester,
          session: meSession(hostStatus: 'live'),
          api: api,
        );
        expect(_key('me-host'), findsOneWidget);
        expect(find.text(MeCopy.hostDashboard), findsOneWidget);
        expect(_key('me-become-host'), findsNothing);
      },
    );

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

  group('profile presentation', () {
    for (final mode in [ThemeMode.light, ThemeMode.dark]) {
      testWidgets('320 px and 2x text keeps long identity and actions usable in $mode', (tester) async {
        tester.platformDispatcher.textScaleFactorTestValue = 2;
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        const name = 'Asha With A Long Family Name That Wraps';
        const username = 'a_very_long_permanent_username_for_this_account';
        final c = await pumpMe(tester, api: api, session: const SessionState(
          status: SessionStatus.signedIn,
          me: HfMe(uid: 'profile-long', displayName: name, username: username,
              ackVersion: 'hf-ack-v1'),
        ));
        tester.view.physicalSize = const Size(960, 2400);
        await c.read(themeModeProvider.notifier).set(mode);
        await tester.pumpAndSettle();

        expect(tester.takeException(), isNull);
        expect(find.text(name), findsOneWidget);
        expect(find.text('@$username'), findsOneWidget);
        expect(_key('me-phone'), findsNothing);
        expect(_key('me-avatar-fallback'), findsOneWidget);
        expect(find.text('Identity verified'), findsNothing);
        expect(find.text('WhatsApp verified'), findsNothing);
        final page = tester.widget<Scaffold>(find.descendant(
          of: find.byType(MeScreen), matching: find.byType(Scaffold)).first);
        expect(page.backgroundColor,
            mode == ThemeMode.dark ? const Color(0xFF000000) : const Color(0xFFF6F3EE));
        final summary = tester.widget<Container>(_key('me-summary'));
        expect((summary.decoration! as BoxDecoration).color,
            mode == ThemeMode.dark ? const Color(0xFF343438) : const Color(0xFFFFFDF9));

        await tester.tap(_key('me-appearance-settings'));
        await tester.pumpAndSettle();
        expect(tester.getTopLeft(find.text(MeCopy.appearanceTitle)).dy, greaterThan(0));
        await tester.ensureVisible(_key('me-appearance-dark'));
        await tester.pumpAndSettle();
        expect(tester.getSize(_key('me-appearance-dark')).height, greaterThanOrEqualTo(48));
        await tester.ensureVisible(_key('me-delete'));
        await tester.pumpAndSettle();
        final scrollable = tester.state<ScrollableState>(find.descendant(
          of: find.byType(MeScreen), matching: find.byType(Scrollable)).first);
        scrollable.position.jumpTo(scrollable.position.maxScrollExtent);
        await tester.pump();
        expect(tester.getBottomLeft(_key('me-delete')).dy,
            lessThanOrEqualTo(tester.getTopLeft(find.byType(HfFloatingNav)).dy));
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('Appearance uses the saved provider and System follows the phone', (tester) async {
      SharedPreferences.setMockInitialValues({kThemeModePrefKey: 'light'});
      var c = await pumpMe(tester, session: meSession(), api: api);
      expect(c.read(themeModeProvider), ThemeMode.light);
      await tester.tap(_key('me-appearance-settings'));
      await tester.pumpAndSettle();
      await tapKeyed(tester, 'me-appearance-dark');
      expect(c.read(themeModeProvider), ThemeMode.dark);
      expect((await SharedPreferences.getInstance()).getString(kThemeModePrefKey), 'dark');
      final selected = tester.widget<OutlinedButton>(_key('me-appearance-dark'));
      expect(selected.style!.backgroundColor!.resolve({}), const Color(0xFFE7E1FF));
      expect(selected.style!.foregroundColor!.resolve({}), const Color(0xFF1D1A33));

      c = await pumpMe(tester, session: meSession(), api: api);
      expect(c.read(themeModeProvider), ThemeMode.dark);

      tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
      addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
      await tapKeyed(tester, 'me-appearance-system');
      expect(c.read(themeModeProvider), ThemeMode.system);
      expect(Theme.of(tester.element(_key('me-name'))).brightness, Brightness.dark);
      tester.platformDispatcher.platformBrightnessTestValue = Brightness.light;
      await tester.pumpAndSettle();
      expect(Theme.of(tester.element(_key('me-name'))).brightness, Brightness.light);
    });

    testWidgets('missing session profile uses an honest fallback', (tester) async {
      // Consent is account-bound; a missing profile must not fabricate it.
      // This account accepted earlier, so the router may open Me while /me is unavailable.
      SharedPreferences.setMockInitialValues({
        '${AckService.storageKey}_profile-missing': 'hf-ack-v1',
      });
      await pumpMe(tester, api: api, session: const SessionState(
        status: SessionStatus.signedIn,
        user: ClerkUser(id: 'profile-missing'),
      ));
      expect(find.text(MeCopy.noName), findsOneWidget);
      expect(_key('me-avatar-fallback'), findsOneWidget);
      expect(_key('me-phone'), findsNothing);
      expect(_key('me-username'), findsNothing);
      expect(find.text('Identity verified'), findsNothing);
      expect(find.text('WhatsApp verified'), findsNothing);
      expect(_key('me-appearance'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('name', () {
    Future<void> openSheet(WidgetTester tester) async {
      await tapKeyed(tester, 'me-edit-name', ms: 600);
      expect(_key('name-field'), findsOneWidget);
    }

    testWidgets('saves a new name with PATCH and shows it at once', (
      tester,
    ) async {
      api.on(
        'PATCH',
        _patchMe,
        (call) => {
          'ok': true,
          'displayName': (call.body as Map)['displayName'],
        },
      );
      final container = await pumpMe(tester, session: meSession(), api: api);
      await openSheet(tester);

      await tester.enterText(_key('name-field'), '  Asha Rao ');
      await tapKeyed(tester, 'name-save', ms: 800);

      expect(api.callsTo('PATCH', _patchMe), hasLength(1));
      expect(
        (api.callsTo('PATCH', _patchMe).single.body as Map)['displayName'],
        'Asha Rao',
      );
      expect(_key('name-field'), findsNothing); // the sheet closed
      expect(find.text('Asha Rao'), findsOneWidget);
      expect(
        (container.read(sessionProvider.notifier) as RecordingSession)
            .refreshes,
        1,
      );
      expect(events.named('hf_app_name_updated'), [
        {'outcome': 'ok'},
      ]);
    });

    testWidgets(
      "the worker's validation message shows under the field and the sheet stays open",
      (tester) async {
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

        expect(
          find.text("Your name can't have numbers in it."),
          findsOneWidget,
        );
        expect(_key('name-field'), findsOneWidget);
        expect(
          find.text('Asha'),
          findsOneWidget,
        ); // the old name is still shown behind the sheet
        expect(events.named('hf_app_name_updated'), [
          {'outcome': 'failed', 'reason': 'invalid_field', 'status': 400},
        ]);

        // Typing again clears the message.
        await tester.enterText(_key('name-field'), 'Asha R');
        await tester.pump();
        expect(find.text("Your name can't have numbers in it."), findsNothing);
      },
    );

    testWidgets(
      'an empty name is refused on the phone, without calling the worker',
      (tester) async {
        await pumpMe(tester, session: meSession(), api: api);
        await openSheet(tester);

        await tester.enterText(_key('name-field'), '   ');
        await tapKeyed(tester, 'name-save', ms: 300);

        expect(find.text('Please enter your name.'), findsOneWidget);
        expect(api.callsTo('PATCH', _patchMe), isEmpty);
        expect(events.named('hf_app_name_updated'), [
          {'outcome': 'failed', 'reason': 'empty'},
        ]);
      },
    );

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
    testWidgets('Leave asks first, then calls DELETE and shows Not joined', (
      tester,
    ) async {
      api.onJson('DELETE', '/api/hf/lanes/women', {'ok': true});
      await pumpMe(tester, session: meSession(women: true), api: api);

      await tapKeyed(tester, 'me-lane-women-leave', ms: 400);
      expect(find.text(MeCopy.leaveTitle), findsOneWidget);
      expect(api.callsTo('DELETE', '/api/hf/lanes/women'), isEmpty);

      await tapKeyed(tester, 'me-leave-confirm', ms: 600);
      expect(api.callsTo('DELETE', '/api/hf/lanes/women'), hasLength(1));
      expect(
        find.descendant(
          of: _key('me-lane-women'),
          matching: find.text(MeCopy.notJoined),
        ),
        findsOneWidget,
      );
      expect(_key('me-lane-women-join'), findsOneWidget);
    });

    testWidgets('Stay on the question leaves everything as it was', (
      tester,
    ) async {
      await pumpMe(tester, session: meSession(women: true), api: api);
      await tapKeyed(tester, 'me-lane-women-leave', ms: 400);
      await tester.tap(find.text(MeCopy.leaveStay));
      await pumpFor(tester, 400);
      expect(
        api.calls.where((call) => call.method != 'GET'),
        isEmpty,
        reason: 'Staying must not change any account data.',
      );
      expect(api.callsTo('DELETE', '/api/hf/lanes/women'), isEmpty);
      expect(_key('me-lane-women-leave'), findsOneWidget);
    });

    testWidgets('a failed leave shows the message and keeps the space', (
      tester,
    ) async {
      api.onError(
        'DELETE',
        '/api/hf/lanes/women',
        const ApiError(
          status: 500,
          code: 'internal_error',
          message: 'Please try again.',
        ),
      );
      await pumpMe(tester, session: meSession(women: true), api: api);
      await tapKeyed(tester, 'me-lane-women-leave', ms: 400);
      await tapKeyed(tester, 'me-leave-confirm', ms: 600);
      expect(find.text('Please try again.'), findsOneWidget);
      expect(
        find.descendant(
          of: _key('me-lane-women'),
          matching: find.text(MeCopy.youAreIn),
        ),
        findsOneWidget,
      );
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
    testWidgets(
      'the switch shows the permission and asks for it when turned on',
      (tester) async {
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
      },
    );

    testWidgets(
      'when the phone settings must finish the change, the switch keeps the real state',
      (tester) async {
        final control = FakeNotificationControl(
          enabled: false,
          canChange: false,
        );
        await pumpMe(
          tester,
          session: meSession(),
          api: api,
          notifications: control,
        );
        await tapKeyed(tester, 'me-notifications', ms: 300);
        expect(control.requests, [true]);
        expect(tester.widget<Switch>(_key('me-notifications')).value, isFalse);
      },
    );
  });

  group('help and legal', () {
    testWidgets('every link opens its site page in a Custom Tab', (
      tester,
    ) async {
      final links = FakeLinkOpener();
      await pumpMe(tester, session: meSession(), api: api, links: links);
      for (final l in MeCopy.links) {
        await tapKeyed(tester, 'me-link-${l.$1}', ms: 100);
      }
      expect(links.sitePaths, [for (final l in MeCopy.links) l.$3]);
      expect(
        links.sitePaths,
        containsAll(<String>[
          '/terms',
          '/privacy',
          '/safety',
          '/grievance',
          '/community-guidelines',
          '/data-deletion',
          '/help',
        ]),
      );
    });

    testWidgets('a page that cannot open says so', (tester) async {
      final links = _ClosedLinks();
      await pumpMe(tester, session: meSession(), api: api, links: links);
      await tapKeyed(tester, 'me-link-terms', ms: 300);
      expect(find.text(MeCopy.couldNotOpenPage), findsOneWidget);
    });
  });

  group('sign out and delete', () {
    testWidgets('Sign out goes to Explore and signs out', (tester) async {
      final container = await pumpMe(tester, session: meSession(), api: api);
      await tapKeyed(tester, 'me-sign-out', ms: 600);
      final session =
          container.read(sessionProvider.notifier) as RecordingSession;
      expect(session.signOuts, 1);
      expect(container.read(sessionProvider).isSignedIn, isFalse);
      expect(container.read(appRouterProvider).routeInformationProvider.value.uri.path,
        Routes.explore);
      expect(_key('me-sign-out'), findsNothing);
    });

    testWidgets('Delete my account opens the delete screen', (tester) async {
      api.onJson('GET', '/api/hf/account/exit', {
        'decision': 'delete',
        'gateEnabled': true,
      });
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

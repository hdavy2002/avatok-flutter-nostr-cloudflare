import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/app.dart';
import 'package:hf_app/core/auth/hf_me.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/boot.dart';
import 'package:hf_app/core/links.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:hf_app/features/me/data/me_telemetry.dart';
import 'package:hf_app/features/me/data/notification_control.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';
import '../../support/kyc_fakes.dart' show FakeLinkOpener;

/// A stub session that also records sign-out and reload calls.
class RecordingSession extends StubSession {
  RecordingSession(super.initial);

  int signOuts = 0;
  int refreshes = 0;

  @override
  Future<void> signOut() async {
    signOuts += 1;
    state = const SessionState.signedOut();
  }

  @override
  Future<void> refreshMe() async {
    refreshes += 1;
  }
}

/// A signed-in session with the fields the Me screen shows.
SessionState meSession({
  String? name = 'Asha',
  String? phone = '******3210',
  bool women = false,
  bool lgbtq = false,
  String? hostStatus,
  bool closing = false,
}) =>
    SessionState(
      status: SessionStatus.signedIn,
      me: HfMe(
        uid: 'user_test',
        displayName: name,
        phoneMasked: phone,
        womenLane: women,
        lgbtqLane: lgbtq,
        closing: closing,
        host: hostStatus == null ? null : HfMeHost(status: hostStatus, slug: 'asha'),
      ),
    );

/// Notifications that never touch the phone.
class FakeNotificationControl extends NotificationControl {
  FakeNotificationControl({this.enabled = false, this.canChange = true});

  bool enabled;

  /// False: the change needs the phone's settings (they were "opened"), so nothing changes in the app.
  final bool canChange;
  final List<bool> requests = <bool>[];

  @override
  Future<bool> isEnabled() async => enabled;

  @override
  Future<bool> setEnabled(bool on) async {
    requests.add(on);
    if (canChange) {
      enabled = on;
      return true;
    }
    return false;
  }
}

/// Telemetry of the Me screen, as `(event, props)`.
class MeEvents {
  final List<(String, Map<String, Object>)> events = <(String, Map<String, Object>)>[];

  void install() => MeTelemetry.sink = (event, props) async => events.add((event, props));

  void remove() => MeTelemetry.resetSink();

  List<Map<String, Object>> named(String name) => [for (final e in events) if (e.$1 == name) e.$2];
}

/// Pumps the whole app at [location] with a recording session, a fake API and any extra overrides.
Future<ProviderContainer> pumpMe(
  WidgetTester tester, {
  required SessionState session,
  required FakeApiClient api,
  String location = '/me',
  List<Override> overrides = const <Override>[],
  FakeLinkOpener? links,
  NotificationControl? notifications,
}) async {
  usePhoneScreen(tester);
  if (links != null) {
    LinkOpener.instance = links;
    addTearDown(() => LinkOpener.instance = const LinkOpener());
  }
  final container = ProviderContainer(overrides: <Override>[
    sessionProvider.overrideWith(() => RecordingSession(session)),
    apiClientProvider.overrideWithValue(api),
    secureStoreProvider.overrideWithValue(MemoryKeyValueStore()),
    initialLocationProvider.overrideWithValue(location),
    notificationControlProvider.overrideWithValue(notifications ?? FakeNotificationControl()),
    ...overrides,
  ]);
  addTearDown(container.dispose);
  await tester.pumpWidget(UncontrolledProviderScope(
    container: container,
    child: const HfApp(listenForLinks: false),
  ));
  await tester.pumpAndSettle();
  return container;
}

/// Lets futures, sheets and dialogs finish without waiting for spinners to stop.
Future<void> pumpFor(WidgetTester tester, [int ms = 500]) async {
  for (var t = 0; t < ms; t += 50) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

/// Taps a keyed widget (scrolling it into view first) and lets the app react.
Future<void> tapKeyed(WidgetTester tester, String key, {int ms = 500}) async {
  final f = find.byKey(ValueKey<String>(key));
  expect(f, findsOneWidget, reason: 'no widget with key $key');
  await tester.ensureVisible(f);
  await tester.pump();
  await tester.tap(f);
  await pumpFor(tester, ms);
}

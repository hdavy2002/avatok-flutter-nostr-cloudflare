import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/app.dart';
import 'package:hf_app/core/auth/hf_me.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/boot.dart';
import 'package:hf_app/core/router/routes.dart';
import 'package:hf_app/core/storage/secure_store.dart';

import 'fake_api_client.dart';

/// A session that starts in a given state and never calls the network.
class StubSession extends SessionController {
  StubSession(this.initial);
  final SessionState initial;

  @override
  SessionState build() => initial;

  @override
  Future<void> restore() async {}

  @override
  Future<void> refreshMe() async {}
}

SessionState signedOutState() => const SessionState.signedOut();

SessionState signedInState({bool host = false}) => SessionState(
      status: SessionStatus.signedIn,
      me: HfMe(uid: 'user_test', host: host ? const HfMeHost(status: 'live', slug: 'asha') : null),
    );

/// Phone-sized screen (360x800 dp at 3x) so layout checks look like a real phone.
void usePhoneScreen(WidgetTester tester) {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

/// Pumps the whole app at [location] with a stub session and a fake API.
/// Returns the container so a test can read providers or call `ref.read(appRouterProvider).go(...)`.
Future<ProviderContainer> pumpApp(
  WidgetTester tester, {
  SessionState? session,
  String location = Routes.home,
  FakeApiClient? api,
}) async {
  usePhoneScreen(tester);
  final container = ProviderContainer(overrides: [
    sessionProvider.overrideWith(() => StubSession(session ?? signedOutState())),
    apiClientProvider.overrideWithValue(api ?? FakeApiClient()),
    secureStoreProvider.overrideWithValue(MemoryKeyValueStore()),
    initialLocationProvider.overrideWithValue(location),
  ]);
  addTearDown(container.dispose);
  await tester.pumpWidget(UncontrolledProviderScope(
    container: container,
    child: const HfApp(listenForLinks: false),
  ));
  await tester.pumpAndSettle();
  return container;
}

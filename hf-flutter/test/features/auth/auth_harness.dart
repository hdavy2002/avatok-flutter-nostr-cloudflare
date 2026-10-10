import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/links.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:hf_app/core/theme/hf_theme.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';
import '../../support/fake_clerk.dart';

/// A few frames, so futures that chain through several awaits (fake API, shared preferences) finish.
Future<void> settle(WidgetTester tester, [int frames = 6]) async {
  for (var i = 0; i < frames; i++) {
    await tester.pump(const Duration(milliseconds: 30));
  }
}

/// Pumps [router] inside a ProviderScope with the fake API and Clerk. The scope lives in the widget tree, so
/// ending the test disposes it (and every timer a screen started).
Future<void> pumpRouter(
  WidgetTester tester,
  GoRouter router, {
  required FakeApiClient api,
  FakeClerk? clerk,
  SessionState? stubSession,
}) async {
  usePhoneScreen(tester);
  addTearDown(router.dispose);
  await tester.pumpWidget(ProviderScope(
    overrides: [
      apiClientProvider.overrideWithValue(api),
      clerkProvider.overrideWithValue(clerk ?? FakeClerk()),
      secureStoreProvider.overrideWithValue(MemoryKeyValueStore()),
      if (stubSession != null) sessionProvider.overrideWith(() => StubSession(stubSession)),
    ],
    child: MaterialApp.router(theme: buildHfTheme(), routerConfig: router),
  ));
  await settle(tester);
}

String locationOf(GoRouter router) => router.routeInformationProvider.value.uri.toString();

/// Every piece of text on screen is 14 sp or bigger (owner rule).
void expectNoTinyText(WidgetTester tester) {
  for (final rt in tester.widgetList<RichText>(find.byType(RichText))) {
    final size = rt.text.style?.fontSize;
    if (size != null) {
      expect(size, greaterThanOrEqualTo(14), reason: 'text "${rt.text.toPlainText()}" is below 14 sp');
    }
  }
}

/// Records what the app asked to open outside itself.
class RecordingLinks extends LinkOpener {
  final List<Uri> tabs = <Uri>[];
  final List<String> tels = <String>[];

  @override
  Future<bool> customTab(Uri uri) async {
    tabs.add(uri);
    return true;
  }

  @override
  Future<bool> tel(String number) async {
    tels.add(number);
    return true;
  }
}

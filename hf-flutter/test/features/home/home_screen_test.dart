import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/router/app_router.dart';
import 'package:hf_app/core/widgets/widgets.dart';
import 'package:hf_app/features/auth/ui/sign_in_screen.dart';
import 'package:hf_app/features/explore/ui/explore_screen.dart';
import 'package:hf_app/features/welcome/ui/welcome_screen.dart';
import '../explore/explore_test_support.dart';

void main() {
  testWidgets('guest home is the marketplace without account onboarding', (tester) async {
    final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([hostJson('asha', name: 'Asha')]));
    await pumpScreen(tester, api: api, location: '/', size: const Size(360, 3000));
    expect(find.byType(ExploreScreen), findsOneWidget);
    expect(find.byType(SignInScreen), findsNothing);
    expect(find.byType(WelcomeScreen), findsNothing);
    expect(find.text('Asha'), findsOneWidget);
    expect(find.text('Who feels like your kind of company?'), findsOneWidget);
    expect(find.text('Women-only'), findsOneWidget);
    expect(find.text('LGBTQ+'), findsOneWidget);
    expect(api.callsTo('GET', '/api/hf/hosts').first.query!['online'], isNull);
  });

  testWidgets('mood choices use server topic groups', (tester) async {
    final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([hostJson('asha')]));
    final container = await pumpScreen(tester, api: api, location: '/', size: const Size(360, 3000));
    await tester.tap(find.byKey(const ValueKey<String>('mood-tension')));
    await tester.pumpAndSettle();
    expect(container.read(appRouterProvider).routeInformationProvider.value.uri.queryParameters['topics'], 'tension-a');
    expect(api.callsTo('GET', '/api/hf/hosts').any((c) => c.query!['topic']=='tension-a'), isTrue);
  });

  testWidgets('search honestly filters loaded profiles and can be cleared', (tester) async {
    final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([
      hostJson('asha', name: 'Asha'), hostJson('bela', name: 'Bela')]));
    await pumpScreen(tester, api: api, location: '/', size: const Size(360, 4000));
    await tester.enterText(find.byType(TextField), 'Bela');
    await tester.pumpAndSettle();
    expect(find.text('Bela'), findsWidgets);
    expect(find.text('Asha'), findsNothing);
    await tester.enterText(find.byType(TextField), 'no match');
    await tester.pumpAndSettle();
    expect(find.text('No matching hosts shown yet.'), findsOneWidget);
    await tester.tap(find.byTooltip('Clear search'));
    await tester.pumpAndSettle();
    expect(find.text('Asha'), findsOneWidget);
  });

  testWidgets('home forwards incoming filter queries', (tester) async {
    final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([hostJson('asha')]));
    await pumpScreen(tester, api: api, location: '/?lang=hi&online=1', size: const Size(360, 3000));
    final query = api.callsTo('GET', '/api/hf/hosts').first.query!;
    expect(query['lang'], 'hi');
    expect(query['online'], '1');
  });

  testWidgets('bento marketplace adapts to 320 width and double-size text', (tester) async {
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([
      hostJson('asha', name: 'Asha with a long name', intro: 'https://x/a.m4a')]));
    await pumpScreen(tester, api: api, location: '/', size: const Size(320, 5000));
    expect(find.byType(HfScene), findsWidgets);
    expect(tester.takeException(), isNull);
  });
}

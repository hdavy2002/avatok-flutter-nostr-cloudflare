import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:hf_app/demo/screens/intro.dart';
import 'package:hf_app/demo/state.dart';
import 'package:hf_app/data/intro_store.dart';
import 'package:hf_app/data/auth/clerk_client.dart';
import 'package:hf_app/data/auth/key_value_store.dart';

class _Store implements KeyValueStore {
  _Store(this.token);
  final String? token;
  @override
  Future<String?> read(String key) async => token;
  @override
  Future<void> write(String key, String value) async {}
  @override
  Future<void> delete(String key) async {}
  @override
  Future<void> deleteAll() async {}
}

void main() {
  setUp(() { SharedPreferences.setMockInitialValues({}); demo.introSeen = false; demo.signOut(); });
  test('local credential hint reads secure storage without network', () async {
    expect(await ClerkClient.hasLocalCredential(store: _Store(null)), isFalse);
    expect(await ClerkClient.hasLocalCredential(store: _Store('saved')), isTrue);
  });
  for (final savedCredential in [false, true]) {
    testWidgets('slow boot with saved credential=$savedCredential chooses correct first route', (tester) async {
      final pending = Completer<void>();
      final router = GoRouter(routes: [
        GoRoute(path: '/', builder: (_, __) => SplashScreen(boot: () => pending.future, hasLocalCredential: () async => savedCredential)),
        GoRoute(path: '/intro', builder: (_, __) => const Scaffold(body: Text('INTRO ROUTE'))),
        GoRoute(path: '/reels', builder: (_, __) => const Scaffold(body: Text('REELS ROUTE'))),
      ]);
      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pump(const Duration(seconds: 2));
      await tester.pumpAndSettle();
      expect(find.text(savedCredential ? 'REELS ROUTE' : 'INTRO ROUTE'), findsOneWidget);
      expect(await IntroStore.read(), isTrue);
      pending.complete();
      await tester.pumpWidget(const SizedBox());
      router.dispose();
    });
  }
}

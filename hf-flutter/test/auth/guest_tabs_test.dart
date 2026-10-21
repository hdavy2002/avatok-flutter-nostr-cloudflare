import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/demo/screens/search.dart';
import 'package:hf_app/demo/screens/favourites.dart';
import 'package:hf_app/demo/state.dart';
import 'package:hf_app/demo/presence_bridge.dart';
import 'package:hf_app/demo/search_real.dart';
import 'package:hf_app/demo/favourites_real.dart';
import 'package:hf_app/demo/screens/me.dart';
import 'package:hf_app/data/services.dart';
import 'package:hf_app/data/auth/clerk_client.dart';
import 'package:hf_app/data/repos/search_repo.dart';
import 'package:hf_app/data/repos/favourites_repo.dart';
import 'signup_test.dart' show FakeApiClient;

void main() {
  setUp(() { demo.signOut(); Services.instance.user = null; });
  tearDown(() { Services.instance.user = null; PresenceBridge.forceReal = false; });
  testWidgets('late Clerk restore opens guest tabs before me has loaded, and logout closes them', (tester) async {
    PresenceBridge.forceReal = true;
    final api = FakeApiClient({});
    for (final entry in <Widget, Type>{
      SearchScreen(repo: SearchRepo(api)): RealSearch,
      FavouritesScreen(repo: FavouritesRepo(api)): RealFavourites,
    }.entries) {
      await tester.pumpWidget(MaterialApp(home: entry.key));
      expect(find.text('Log in'), findsOneWidget);
      Services.instance.user = const ClerkUser(id: 'restored_user');
      await tester.pump();
      expect(demo.signedIn, isFalse);
      expect(find.byType(entry.value), findsOneWidget);
      expect(find.text('Create account'), findsNothing);
      Services.instance.user = null;
      await tester.pump();
      expect(find.text('Log in'), findsOneWidget);
      expect(find.byType(entry.value), findsNothing);
      await tester.pumpWidget(const SizedBox());
    }
  });
  testWidgets('guest Me fits a short viewport with large text', (tester) async {
    tester.view.physicalSize = const Size(360, 600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(1.5)),
      child: child!,
    ), home: const MeScreen()));
    await tester.pump();
    expect(tester.takeException(), isNull);
  });
  for (final entry in <String, Widget>{
    'search': const SearchScreen(),
    'favourites': const FavouritesScreen(),
  }.entries) {
    testWidgets('guest ${entry.key} offers account entry without loading a list', (tester) async {
      await tester.pumpWidget(MaterialApp(home: entry.value));
      await tester.pump();
      expect(find.text('Log in'), findsOneWidget);
      expect(find.text('Create account'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      expect(find.byType(GridView), findsNothing);
      expect(find.text('Online now'), findsNothing);
      expect(tester.takeException(), isNull);
    });
  }
}

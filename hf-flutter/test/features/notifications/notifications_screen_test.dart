import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/core/widgets/widgets.dart';
import 'package:hf_app/features/explore/widgets/browse_motion.dart';
import 'package:hf_app/features/notifications/ui/notifications_screen.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';

Map<String, Object?> note(String id, {bool read = false}) => {
  'id': id,
  'title': 'Title $id',
  'body': 'Body of $id',
  'read': read,
  'created_at': 1760000000000,
};

FakeApiClient notesApi(List<Map<String, Object?>> items) => FakeApiClient()
  ..onJson('GET', '/api/notifications', {'items': items})
  ..onJson('POST', '/api/notifications/read', {'ok': true})
  ..onJson('GET', '/api/notifications/unread', {'unread': 0})
  ..onJson('DELETE', '/api/notifications', {'ok': true});

/// Pumps the notifications screen alone (signed in). [reduced] turns animations off like the phone setting.
Future<void> pumpNotes(
  WidgetTester tester,
  FakeApiClient api, {
  bool reduced = true,
  Size size = const Size(360, 800),
  double textScale = 1,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sessionProvider.overrideWith(() => StubSession(signedInState())),
        apiClientProvider.overrideWithValue(api),
      ],
      child: MaterialApp(
        theme: buildHfTheme(),
        home: Builder(
          builder: (context) => MediaQuery(
            data: MediaQuery.of(context).copyWith(
              disableAnimations: reduced,
              textScaler: TextScaler.linear(textScale),
            ),
            child: const NotificationsScreen(),
          ),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('loading shows the bouncing dots', (tester) async {
    await pumpNotes(tester, notesApi([note('a')]));
    expect(find.byType(HfLoader), findsOneWidget);
    expect(find.text('Loading notifications…'), findsOneWidget);
    await tester.pumpAndSettle();
    expect(find.text('Title a'), findsOneWidget);
  });

  testWidgets('empty: the sleepy beaver says there is nothing', (tester) async {
    await pumpNotes(tester, notesApi(const []));
    await tester.pumpAndSettle();
    final beaver = tester.widget<BeaverGuide>(
      find.byKey(kStatePanelBeaverKey),
    );
    expect(beaver.pose, BeaverPose.sleepy);
    expect(find.text('No notifications right now.'), findsOneWidget);
    expect(find.byType(SpeechBubble), findsOneWidget);
  });

  testWidgets('unread rows carry a pulsing dot; read rows do not', (
    tester,
  ) async {
    await pumpNotes(tester, notesApi([note('a'), note('b', read: true)]));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey<String>('unread-pulse')),
      findsOneWidget,
    );
    expect(find.bySemanticsLabel(RegExp('Unread')), findsOneWidget);
    expect(find.byType(RiseIn), findsNWidgets(2));
  });

  testWidgets('rows slide in on first appearance only', (tester) async {
    final api = notesApi([note('a'), note('b'), note('c')]);
    await pumpNotes(tester, api, reduced: false);
    // Let the list load (the loader and the unread dots loop, so pump, never settle).
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    final row = find.byKey(const ValueKey<String>('notification-a'));
    expect(row, findsOneWidget);
    expect(
      find.descendant(of: row, matching: find.byType(Opacity)),
      findsWidgets,
    );
    await tester.pump(const Duration(milliseconds: 900));
    expect(
      find.descendant(of: row, matching: find.byType(Opacity)),
      findsNothing,
    );
    // Pull to refresh: same ids, no replay.
    await tester.drag(find.byType(ListView), const Offset(0, 300));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));
    expect(
      find.descendant(of: row, matching: find.byType(Opacity)),
      findsNothing,
    );
    expect(api.callsTo('GET', '/api/notifications').length, greaterThan(1));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('pull to refresh uses the warm colours', (tester) async {
    await pumpNotes(tester, notesApi([note('a')]));
    await tester.pumpAndSettle();
    final indicator = tester.widget<RefreshIndicator>(
      find.byType(RefreshIndicator),
    );
    expect(indicator.color, HfColors.deepOrange);
    expect(indicator.backgroundColor, HfColors.butter);
  });

  for (final empty in [false, true]) {
    testWidgets('320 px with 2x text lays out (empty: $empty)', (tester) async {
      await pumpNotes(
        tester,
        notesApi(empty ? const [] : [note('a'), note('b', read: true)]),
        size: const Size(320, 640),
        textScale: 2,
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });
  }
}

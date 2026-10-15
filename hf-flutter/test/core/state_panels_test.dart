import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/strings.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/core/widgets/widgets.dart';

Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  bool reduced = false,
  Size size = const Size(360, 800),
  double textScale = 1,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      theme: buildHfTheme(),
      home: Builder(
        builder: (context) => MediaQuery(
          data: MediaQuery.of(context).copyWith(
            disableAnimations: reduced,
            textScaler: TextScaler.linear(textScale),
          ),
          child: Scaffold(body: child),
        ),
      ),
    ),
  );
}

List<String> _assetNames(WidgetTester tester) => tester
    .widgetList<Image>(find.byType(Image))
    .map((i) => i.image)
    .whereType<AssetImage>()
    .map((a) => a.assetName)
    .toList();

void main() {
  group('LoadingPanel', () {
    testWidgets('bouncing dots replace the spinner; message and label stay', (
      tester,
    ) async {
      await _pump(tester, const LoadingPanel(message: 'Finding people…'));
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.byType(HfLoader), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(find.text('Finding people…'), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('Finding people')), findsWidgets);
    });

    testWidgets('a skeleton still replaces the loader', (tester) async {
      await _pump(
        tester,
        const LoadingPanel(skeleton: SizedBox(key: Key('sk'), height: 40)),
      );
      expect(find.byKey(const Key('sk')), findsOneWidget);
      expect(find.byType(HfLoader), findsNothing);
    });

    testWidgets('reduced motion: dots sit still so the frame settles', (
      tester,
    ) async {
      await _pump(tester, const LoadingPanel(), reduced: true);
      await tester.pumpAndSettle();
      expect(find.byType(HfLoader), findsOneWidget);
      expect(find.text(Strings.loadingDefault), findsOneWidget);
    });
  });

  group('EmptyPanel', () {
    testWidgets('sleepy beaver says the message in a bubble; action works', (
      tester,
    ) async {
      var taps = 0;
      await _pump(
        tester,
        EmptyPanel(
          message: 'No notifications right now.',
          icon: Icons.notifications_none_rounded,
          actionLabel: 'Explore hosts',
          onAction: () => taps++,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(kStatePanelBeaverKey), findsOneWidget);
      final beaver = tester.widget<BeaverGuide>(
        find.byKey(kStatePanelBeaverKey),
      );
      expect(beaver.pose, BeaverPose.sleepy);
      expect(beaver.size, kStatePanelBeaverSize);
      expect(find.byType(SpeechBubble), findsOneWidget);
      expect(find.text('No notifications right now.'), findsOneWidget);
      expect(
        find.bySemanticsLabel('No notifications right now.'),
        findsWidgets,
      );
      // The beaver is decoration: screen readers hear the message, not the mascot.
      expect(
        find.bySemanticsLabel(BeaverGuide.defaultSemanticLabel),
        findsNothing,
      );
      await tester.tap(find.text('Explore hosts'));
      expect(taps, 1);
    });

    testWidgets('reduced motion: still beaver and the whole message at once', (
      tester,
    ) async {
      await _pump(
        tester,
        const EmptyPanel(message: 'Nothing here yet. Check back soon.'),
        reduced: true,
      );
      await tester.pump();
      expect(_assetNames(tester), [BeaverPose.sleepy.stillAsset]);
      final text = tester.widget<Text>(find.byKey(SpeechBubble.textKey));
      final span = text.textSpan! as TextSpan;
      expect(
        (span.children!.first as TextSpan).text,
        'Nothing here yet. Check back soon.',
      );
    });
  });

  group('ErrorPanel', () {
    testWidgets('oops beaver, the same message and Try again', (tester) async {
      var retries = 0;
      await _pump(
        tester,
        ErrorPanel(
          error: const ApiError(status: 500, code: 'http_500'),
          onRetry: () => retries++,
        ),
      );
      await tester.pumpAndSettle();
      final beaver = tester.widget<BeaverGuide>(
        find.byKey(kStatePanelBeaverKey),
      );
      expect(beaver.pose, BeaverPose.oops);
      expect(find.text(Strings.somethingWrong), findsOneWidget);
      await tester.tap(find.text(Strings.tryAgain));
      expect(retries, 1);
    });

    testWidgets('offline keeps the no-internet message and its icon', (
      tester,
    ) async {
      await _pump(tester, ErrorPanel(error: ApiError.network(), onRetry: () {}));
      await tester.pumpAndSettle();
      expect(find.text('No internet. Check your connection.'), findsOneWidget);
      expect(find.byIcon(Icons.wifi_off_rounded), findsOneWidget);
    });

    testWidgets('no retry callback: no button', (tester) async {
      await _pump(tester, const ErrorPanel(message: 'Custom message'));
      await tester.pumpAndSettle();
      expect(find.text('Custom message'), findsOneWidget);
      expect(find.text(Strings.tryAgain), findsNothing);
    });
  });

  group('layout', () {
    for (final reduced in [false, true]) {
      testWidgets('320 px with 2x text lays out (reduced: $reduced)', (
        tester,
      ) async {
        for (final panel in <Widget>[
          const LoadingPanel(),
          EmptyPanel(
            message: 'No hosts match these filters. Try fewer filters.',
            actionLabel: 'Clear filters',
            onAction: () {},
          ),
          ErrorPanel(error: ApiError.network(), onRetry: () {}),
          const ComingSoonPanel(),
        ]) {
          await _pump(
            tester,
            panel,
            reduced: reduced,
            size: const Size(320, 640),
            textScale: 2,
          );
          await tester.pump(const Duration(seconds: 2));
          expect(tester.takeException(), isNull);
        }
      });
    }

    testWidgets('buttons keep a 48 dp target', (tester) async {
      await _pump(tester, ErrorPanel(error: ApiError.network(), onRetry: () {}));
      await tester.pumpAndSettle();
      final size = tester.getSize(
        find.ancestor(
          of: find.text(Strings.tryAgain),
          matching: find.byType(HfButton),
        ),
      );
      expect(size.height, greaterThanOrEqualTo(48));
    });
  });
}

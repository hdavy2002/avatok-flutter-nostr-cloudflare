import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/config/flags.dart';
import 'package:hf_app/core/widgets/widgets.dart';
import 'package:hf_app/features/explore/widgets/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'explore_test_support.dart';

HostCard card(
  String slug, {
  String status = 'online',
  String? intro,
  double? rating = 4.5,
  int reviews = 3,
}) => HostCard.tryParse(
  hostJson(
    slug,
    status: status,
    intro: intro,
    rating: rating,
    reviews: reviews,
  ),
)!;

Future<FakeIntroAudio> pumpCards(
  WidgetTester tester,
  List<Widget> cards,
) async {
  final audio = FakeIntroAudio();
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        introAudioProvider.overrideWithValue(audio),
        flagsProvider.overrideWith((ref) async => HfFlags.unknown),
      ],
      child: MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(child: Column(children: cards)),
        ),
      ),
    ),
  );
  await tester.pump();
  return audio;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  testWidgets(
    'only one intro plays at a time: starting B stops A, tapping B again pauses it',
    (tester) async {
      final a = card('a', intro: 'https://x/a.m4a');
      final b = card('b', intro: 'https://x/b.m4a');
      final audio = await pumpCards(tester, [
        HostCardView(host: a, animate: false),
        HostCardView(host: b, animate: false),
      ]);
      final playA = find.byKey(const ValueKey<String>('intro-a'));
      final playB = find.byKey(const ValueKey<String>('intro-b'));

      expect(find.byIcon(Icons.play_arrow_rounded), findsNWidgets(2));
      await tester.ensureVisible(playA);
      await tester.tap(playA);
      await tester.pump();
      expect(audio.played, ['https://x/a.m4a']);
      expect(find.byIcon(Icons.pause_rounded), findsOneWidget);

      await tester.ensureVisible(playB);
      await tester.tap(playB);
      await tester.pump();
      expect(audio.played, ['https://x/a.m4a', 'https://x/b.m4a']);
      // A went back to "play"; only B shows "pause".
      expect(find.byIcon(Icons.pause_rounded), findsOneWidget);
      expect(
        find.descendant(of: playB, matching: find.byIcon(Icons.pause_rounded)),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: playA,
          matching: find.byIcon(Icons.play_arrow_rounded),
        ),
        findsOneWidget,
      );

      await tester.ensureVisible(playB);
      await tester.tap(playB);
      await tester.pump();
      expect(audio.pauses, 1);
      expect(find.byIcon(Icons.pause_rounded), findsNothing);
    },
  );

  testWidgets('when the clip ends the button goes back to play', (
    tester,
  ) async {
    final audio = await pumpCards(tester, [
      HostCardView(host: card('a', intro: 'https://x/a.m4a'), animate: false),
    ]);
    await tester.tap(find.byKey(const ValueKey<String>('intro-a')));
    await tester.pump();
    expect(find.byIcon(Icons.pause_rounded), findsOneWidget);
    audio.finish();
    await tester.pump();
    expect(find.byIcon(Icons.pause_rounded), findsNothing);
    expect(find.byIcon(Icons.play_arrow_rounded), findsOneWidget);
  });

  testWidgets(
    'a host with no intro has no voice bar; the length shows in m:ss on the bar',
    (tester) async {
      await pumpCards(tester, [
        HostCardView(host: card('a'), animate: false),
        HostCardView(host: card('b', intro: 'https://x/b.m4a'), animate: false),
      ]);
      expect(find.byKey(const ValueKey<String>('intro-a')), findsNothing);
      expect(find.byKey(const ValueKey<String>('intro-b')), findsOneWidget);
      expect(find.text('0:12'), findsOneWidget);
      expect(find.text('Voice intro'), findsOneWidget);
    },
  );

  testWidgets('the voice bar is a 48 dp tap target', (tester) async {
    await pumpCards(tester, [
      HostCardView(host: card('a', intro: 'https://x/a.m4a'), animate: false),
    ]);
    final size = tester.getSize(find.byKey(const ValueKey<String>('intro-a')));
    expect(size.height, greaterThanOrEqualTo(48));
  });

  testWidgets(
    'the voice bar says Her voice or His voice by gender, and its waveform depends only on the slug',
    (tester) async {
      const her = HostCard(
        slug: 'her',
        displayName: 'Her',
        gender: 'female',
        introAudioUrl: 'https://x/h.m4a',
        introSeconds: 20,
      );
      const him = HostCard(
        slug: 'him',
        displayName: 'Him',
        gender: 'male',
        introAudioUrl: 'https://x/m.m4a',
        introSeconds: 65,
      );
      await pumpCards(tester, [
        const HostCardView(host: her, animate: false),
        const HostCardView(host: him, animate: false),
      ]);
      expect(find.text('Her voice'), findsOneWidget);
      expect(find.text('His voice'), findsOneWidget);
      expect(find.text('0:20'), findsOneWidget);
      expect(find.text('1:05'), findsOneWidget);
      expect(hostWaveHeights('her'), hostWaveHeights('her'));
      expect(hostWaveHeights('her'), isNot(hostWaveHeights('him')));
      expect(hostWaveHeights('her'), hasLength(20));
      expect(hostWaveHeights('her').every((h) => h >= 30 && h <= 100), isTrue);
    },
  );

  testWidgets(
    'a card has four tiles, topic chips with a +N chip, the price bar and the right action',
    (tester) async {
      final many = HostCard.tryParse(
        hostJson('many', status: 'online', topics: ['a', 'b', 'c', 'd', 'e']),
      )!;
      await pumpCards(tester, [
        HostCardView(host: many, animate: false),
        HostCardView(host: card('busy', status: 'busy'), animate: false),
        HostCardView(host: card('off', status: 'offline'), animate: false),
      ]);
      expect(find.byType(HfTile), findsNWidgets(12));
      expect(find.text('talked to'), findsNWidgets(3));
      expect(find.text('regulars'), findsNWidgets(3));
      expect(find.text('Hindi, English'), findsNWidgets(3));
      expect(find.text('Warm'), findsNWidgets(3));
      expect(find.text('+2'), findsOneWidget);
      expect(
        find.text('₹10'),
        findsNothing,
      ); // the rupee amount and "/min" are one rich text
      expect(find.textContaining('10 min ≈ ₹100'), findsNWidgets(3));
      // Online: the dark Call now. Busy and offline: the white Notify me with a bell.
      expect(find.text('Call now'), findsOneWidget);
      expect(find.text('Notify me'), findsNWidgets(2));
      expect(find.byIcon(Icons.call_rounded), findsOneWidget);
      expect(find.byIcon(Icons.notifications_none_rounded), findsNWidgets(2));
      expect(find.byType(HfVerifiedBadge), findsNWidgets(3));
    },
  );

  testWidgets('calls switched off: the action is a disabled Calls open soon', (
    tester,
  ) async {
    final audio = FakeIntroAudio();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          introAudioProvider.overrideWithValue(audio),
          flagsProvider.overrideWith((ref) async => HfFlags.allOff),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: HostCardView(host: card('a'), animate: false),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
    expect(find.text('Calls open soon'), findsOneWidget);
    expect(find.text('Call now'), findsNothing);
  });

  testWidgets('the heart saves a host on the phone only', (tester) async {
    await pumpCards(tester, [HostCardView(host: card('a'), animate: false)]);
    expect(find.byIcon(Icons.favorite_border_rounded), findsOneWidget);
    await tester.tap(find.byIcon(Icons.favorite_border_rounded));
    await tester.pump();
    expect(find.byIcon(Icons.favorite_rounded), findsOneWidget);
    await tester.tap(find.byIcon(Icons.favorite_rounded));
    await tester.pump();
    expect(find.byIcon(Icons.favorite_border_rounded), findsOneWidget);
  });

  testWidgets('status labels wrap in a narrow card at double text size', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MediaQuery(
            data: MediaQueryData(textScaler: TextScaler.linear(2)),
            child: SizedBox(
              width: 144,
              child: Column(
                children: [
                  StatusPill(presence: HostPresence.online, animate: false),
                  StatusPill(presence: HostPresence.busy, animate: false),
                  StatusPill(presence: HostPresence.offline, animate: false),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    expect(find.text('Online now'), findsOneWidget);
    expect(find.text('On a call'), findsOneWidget);
    expect(find.text('Offline'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('every status has a distinct labelled pill', (tester) async {
    await pumpCards(tester, [
      HostCardView(host: card('a', status: 'online'), animate: false),
      HostCardView(host: card('b', status: 'busy'), animate: false),
      HostCardView(host: card('c', status: 'offline'), animate: false),
    ]);
    expect(find.text('Online now'), findsOneWidget);
    expect(find.text('On a call'), findsOneWidget);
    expect(find.text('Offline'), findsOneWidget);
    expect(find.byType(HfStatusPill), findsNWidgets(3));
  });

  testWidgets(
    'rating shows stars and count, or New for an unrated host; the AI avatar label is always there',
    (tester) async {
      await pumpCards(tester, [
        HostCardView(host: card('a', rating: 4.5, reviews: 3), animate: false),
        HostCardView(host: card('b', rating: null, reviews: 0), animate: false),
      ]);
      expect(find.textContaining('4.5'), findsOneWidget);
      expect(find.text('New'), findsOneWidget);
      expect(find.text('AI avatar'), findsNWidgets(2));
    },
  );

  testWidgets(
    'the mini card (Online now strip) shows name, price, status and the AI avatar label',
    (tester) async {
      await pumpCards(tester, [HostMiniCard(host: card('a'), animate: false)]);
      expect(find.text('Host a'), findsOneWidget);
      expect(find.text('₹10/min'), findsOneWidget);
      expect(find.text('Online now'), findsOneWidget);
      expect(find.text('AI avatar'), findsOneWidget);
    },
  );

  testWidgets('tap on a card runs onTap', (tester) async {
    var taps = 0;
    await pumpCards(tester, [
      HostCardView(host: card('a'), animate: false, onTap: () => taps++),
    ]);
    await tester.tap(find.text('Host a'));
    expect(taps, 1);
  });
}

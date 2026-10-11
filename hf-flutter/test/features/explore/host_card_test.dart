import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/widgets/status_pill.dart';
import 'package:hf_app/core/config/flags.dart';
import 'package:hf_app/features/explore/widgets/widgets.dart';

import 'explore_test_support.dart';

HostCard card(String slug, {String status = 'online', String? intro, double? rating = 4.5, int reviews = 3}) =>
    HostCard.tryParse(hostJson(slug, status: status, intro: intro, rating: rating, reviews: reviews))!;

Future<FakeIntroAudio> pumpCards(WidgetTester tester, List<Widget> cards) async {
  final audio = FakeIntroAudio();
  await tester.pumpWidget(ProviderScope(
    overrides: [introAudioProvider.overrideWithValue(audio),
      flagsProvider.overrideWith((ref) async => HfFlags.unknown)],
    child: MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(child: Column(children: cards)),
      ),
    ),
  ));
  await tester.pump();
  return audio;
}

void main() {
  testWidgets('only one intro plays at a time: starting B stops A, tapping B again pauses it', (tester) async {
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
    expect(find.descendant(of: playB, matching: find.byIcon(Icons.pause_rounded)), findsOneWidget);
    expect(find.descendant(of: playA, matching: find.byIcon(Icons.play_arrow_rounded)), findsOneWidget);

    await tester.ensureVisible(playB);
    await tester.tap(playB);
    await tester.pump();
    expect(audio.pauses, 1);
    expect(find.byIcon(Icons.pause_rounded), findsNothing);
  });

  testWidgets('when the clip ends the button goes back to play', (tester) async {
    final audio = await pumpCards(tester, [HostCardView(host: card('a', intro: 'https://x/a.m4a'), animate: false)]);
    await tester.tap(find.byKey(const ValueKey<String>('intro-a')));
    await tester.pump();
    expect(find.byIcon(Icons.pause_rounded), findsOneWidget);
    audio.finish();
    await tester.pump();
    expect(find.byIcon(Icons.pause_rounded), findsNothing);
    expect(find.byIcon(Icons.play_arrow_rounded), findsOneWidget);
  });

  testWidgets('a host with no intro has no play button; the length shows beside the button', (tester) async {
    await pumpCards(tester, [
      HostCardView(host: card('a'), animate: false),
      HostCardView(host: card('b', intro: 'https://x/b.m4a'), animate: false),
    ]);
    expect(find.byKey(const ValueKey<String>('intro-a')), findsNothing);
    expect(find.byKey(const ValueKey<String>('intro-b')), findsOneWidget);
    expect(find.text('12s'), findsOneWidget);
  });

  testWidgets('the play button is at least 48 dp', (tester) async {
    await pumpCards(tester, [HostCardView(host: card('a', intro: 'https://x/a.m4a'), animate: false)]);
    final size = tester.getSize(find.byKey(const ValueKey<String>('intro-a')));
    expect(size.width, greaterThanOrEqualTo(48));
    expect(size.height, greaterThanOrEqualTo(48));
  });

  testWidgets('status labels wrap in a narrow card at double text size', (tester) async {
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: MediaQuery(
      data: const MediaQueryData(textScaler: TextScaler.linear(2)),
      child: const SizedBox(width: 144, child: Column(children: [
        StatusPill(presence: HostPresence.online, animate: false),
        StatusPill(presence: HostPresence.busy, animate: false),
        StatusPill(presence: HostPresence.offline, animate: false),
      ])),
    ))));
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
    expect(find.byType(StatusPill), findsNWidgets(3));
  });

  testWidgets('rating shows stars and count, or New for an unrated host; the AI avatar label is always there',
      (tester) async {
    await pumpCards(tester, [
      HostCardView(host: card('a', rating: 4.5, reviews: 3), animate: false),
      HostCardView(host: card('b', rating: null, reviews: 0), animate: false),
    ]);
    expect(find.textContaining('4.5'), findsOneWidget);
    expect(find.text('New'), findsOneWidget);
    expect(find.text('AI avatar'), findsNWidgets(2));
  });

  testWidgets('the mini card (Online now strip) shows name, price, status and the AI avatar label', (tester) async {
    await pumpCards(tester, [HostMiniCard(host: card('a'), animate: false)]);
    expect(find.text('Host a'), findsOneWidget);
    expect(find.text('₹10/min'), findsOneWidget);
    expect(find.text('Online now'), findsOneWidget);
    expect(find.text('AI avatar'), findsOneWidget);
  });

  testWidgets('tap on a card runs onTap', (tester) async {
    var taps = 0;
    await pumpCards(tester, [HostCardView(host: card('a'), animate: false, onTap: () => taps++)]);
    await tester.tap(find.text('Host a'));
    expect(taps, 1);
  });
}

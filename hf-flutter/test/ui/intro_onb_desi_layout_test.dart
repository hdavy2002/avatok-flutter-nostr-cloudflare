import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/models/intro_onboarding.dart';
import 'package:hf_app/data/models/queue.dart';
import 'package:hf_app/data/models/reel.dart';
import 'package:hf_app/demo/data.dart';
import 'package:hf_app/demo/desi.dart';
import 'package:hf_app/demo/intro_reel_overlay.dart';
import 'package:hf_app/demo/screens/onboarding/intro_onb_finish.dart';
import 'package:hf_app/demo/screens/onboarding/intro_onb_steps.dart';
import 'package:hf_app/demo/space_kit.dart';
import 'package:hf_app/demo/theme.dart';

// [HF-DESI-ONB] The desi restyle of the influencer onboarding and the intro-reel overlay: every step lays out on a 390x844
// phone (and a small 320x640 one) without a RenderFlex overflow, and the main button is the solid saffron gota-patti pill.

const _config = OnbConfig(
  categories: [
    OnbCategory(id: 'astrology', label: 'Astrology'),
    OnbCategory(id: 'teacher', label: 'Teacher'),
    OnbCategory(id: 'traveller', label: 'Traveller'),
    OnbCategory(id: 'cook', label: 'Cook'),
    OnbCategory(id: 'fitness', label: 'Fitness'),
    OnbCategory(id: 'music', label: 'Music'),
    OnbCategory(id: 'listener', label: 'Listener', sensitive: true),
    OnbCategory(id: 'prayer', label: 'Prayer', sensitive: true),
    OnbCategory(id: kWomenToWomenId, label: 'Women-to-Women', sensitive: true),
  ],
  langs: ['hi', 'en'],
);

Future<void> _pump(WidgetTester tester, Widget screen, Size size) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(debugShowCheckedModeBanner: false, theme: buildTheme(), home: screen));
  await tester.pump();
}

void main() {
  final screens = <String, Widget Function()>{
    'categories': () => OnbCategoriesStep(
          config: _config,
          selected: const ['astrology', 'cook'],
          womenBlocked: false,
          notice: null,
          onToggle: (_) {},
          onNext: () {},
          onBack: () {},
        ),
    'aadhaar': () => OnbAadhaarStep(reason: 'you picked Women-to-Women', womenPicked: true, whatsappVerified: false, onVerified: () {}, onBack: () {}),
    'prep': () => OnbPrepStep(
          langs: const ['hi', 'en'],
          categories: const [OnbCategory(id: 'astrology', label: 'Astrology'), OnbCategory(id: 'cook', label: 'Cook')],
          lang: 'hi',
          topic: 'astrology',
          onLang: (_) {},
          onTopic: (_) {},
          onReady: () {},
          onBack: () {},
          notice: 'Your last video was too short.',
          onKeep: () {},
        ),
    'profile': () => OnbProfileStep(
          name: 'Priya',
          about: 'Kundli reading',
          rate: 12,
          photoUrl: null,
          locked: false,
          busy: false,
          error: null,
          onPhoto: () {},
          onChanged: (_, __, ___) {},
          onNext: (_, __, ___) {},
          onBack: () {},
        ),
    'option': () => OnbOptionStep(selected: 'B', busy: false, error: null, onPick: (_) {}, onSlots: () {}, onSubmit: () {}, onBack: () {}),
    'sent': () => OnbSentScreen(onHome: () {}),
    'rejected': () => OnbRejectedScreen(
          reasons: const [OnbReason(code: 'face', text: 'We could not see your face clearly.')],
          note: 'Please record in good light.',
          onFix: () {},
          onHome: () {},
        ),
    'approved': () => OnbApprovedScreen(onDashboard: () {}),
  };

  for (final size in const [Size(390, 844), Size(320, 640)]) {
    for (final e in screens.entries) {
      testWidgets('${e.key} lays out at ${size.width.toInt()}x${size.height.toInt()}', (tester) async {
        await _pump(tester, e.value(), size);
        expect(tester.takeException(), isNull);
        expect(find.byType(GotaButton), findsWidgets);
        expect(find.byType(Marigold), findsWidgets);
      });
    }
  }

  testWidgets('main button is solid saffron with no gradient', (tester) async {
    await _pump(tester, screens['option']!(), const Size(390, 844));
    final box = tester.widgetList<Container>(find.descendant(of: find.byType(GotaButton), matching: find.byType(Container))).first;
    final deco = box.decoration! as BoxDecoration;
    expect(deco.color, Gota.saffron);
    expect(deco.gradient, isNull);
  });

  testWidgets('intro reel overlay lays out with two buttons and a women tag', (tester) async {
    const reel = FeedReel(
      id: 'r1',
      kind: 'intro',
      host: ReelHost(slug: 'arjun', name: 'Arjun Mehta', ratePaise: 1500, callState: HostCallState.onCall, queueWaiting: 2),
      description: 'Home workouts and job-switch advice.',
      mainAction: 'queue_or_book',
      womenOnly: true,
      socials: [ReelSocial(platform: 'instagram', handle: '@arjun', url: 'https://instagram.com/arjun')],
      categories: [ReelCategory(id: 'fitness', label: 'Fitness'), ReelCategory(id: 'career', label: 'Career')],
    );
    await _pump(
      tester,
      Scaffold(
        backgroundColor: C.cinema,
        body: Stack(children: [
          IntroReelOverlay(
            reel: reel,
            who: influencers.first,
            rail: const SizedBox(height: 200),
            onProfile: () {},
            onSocial: (_) {},
            onCall: () {},
            onQueue: () {},
            onBook: () {},
          ),
        ]),
      ),
      const Size(390, 844),
    );
    expect(tester.takeException(), isNull);
    expect(find.byKey(const ValueKey('intro-book')), findsOneWidget);
    expect(find.byKey(const ValueKey('intro-women-tag')), findsOneWidget);
  });

  testWidgets('verified-owner sheet and women-only gate lay out', (tester) async {
    const reel = FeedReel(
      id: 'r2',
      kind: 'intro',
      host: ReelHost(slug: 'priya', name: 'Priya Sharma'),
      socials: [
        ReelSocial(platform: 'youtube', handle: '@priyacooks', url: 'https://youtube.com/@priyacooks', followers: 12400),
        ReelSocial(platform: 'instagram', handle: '@priya.kundli', url: 'https://instagram.com/priya.kundli', followers: 8900),
        ReelSocial(platform: 'facebook', handle: 'Priya Sharma Astrology', url: 'https://facebook.com/priya', followers: 5100),
      ],
    );
    late BuildContext ctx;
    await _pump(tester, Scaffold(body: Builder(builder: (c) {
      ctx = c;
      return const SizedBox.expand();
    })), const Size(390, 844));
    unawaited(showIntroInfoSheet(ctx, reel: reel, who: influencers.first));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.byKey(const ValueKey('intro-info-open-facebook')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('intro-info-close')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('intro-info-sheet')), findsNothing);

    final gate = showWomenOnlyGate(ctx, need: 'aadhaar');
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.byKey(const ValueKey('women-gate-verify')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('women-gate-close')));
    await tester.pumpAndSettle();
    expect(await gate, isFalse);
  });
}

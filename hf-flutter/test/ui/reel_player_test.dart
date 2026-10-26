import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/models/reel.dart';
import 'package:hf_app/data/telemetry.dart';
import 'package:hf_app/demo/reel_player.dart';
import 'package:hf_app/demo/screens/creator_page.dart';

// [HF-REEL-PLAYER-2] The controllable embed player: a transparent tap layer toggles the video underneath, a failed
// embed turns into the poster card with "Watch on ...", and a creator page thumbnail opens the playing viewer.

FeedReel _reel(String id, {String platform = 'instagram'}) => FeedReel(
  id: id,
  host: const ReelHost(slug: '', name: 'Nova', handle: '@nova'),
  platform: platform,
  url: platform == 'instagram'
      ? 'https://www.instagram.com/reel/Cx12345/'
      : 'https://www.youtube.com/shorts/abc12345',
  embedUrl: platform == 'instagram'
      ? 'https://www.instagram.com/reel/Cx12345/embed'
      : 'https://www.youtube.com/embed/abc12345',
  views: 10,
);

void main() {
  test('original provider links resolve to official playable embeds', () {
    FeedReel source(String url) => FeedReel(
      id: 'original',
      host: const ReelHost(slug: '', name: 'Nova'),
      url: url,
    );
    expect(
      ReelPlayer.sourceFor(source('https://youtu.be/abc12345')),
      'https://www.youtube.com/embed/abc12345',
    );
    expect(
      ReelPlayer.sourceFor(source('https://www.youtube.com/shorts/abc12345')),
      'https://www.youtube.com/embed/abc12345',
    );
    expect(
      ReelPlayer.sourceFor(source('https://www.instagram.com/reel/Cx12345/')),
      'https://www.instagram.com/reel/Cx12345/embed/',
    );
    expect(
      ReelPlayer.sourceFor(
        source('https://youtube.com.evil.test/embed/abc12345'),
      ),
      isNull,
    );
  });

  late List<String> js;
  late StreamController<String> msgs;
  late List<Uri> launched;
  late List<(String, Map<String, Object?>)> events;
  late TelemetrySink oldSink;

  setUp(() {
    js = [];
    launched = [];
    events = [];
    msgs = StreamController<String>.broadcast(
      sync: true,
    ); // sync: the rebuild must be scheduled before tester.pump looks for a frame
    ReelPlayer.testRunJs = js.add;
    ReelPlayer.testMessages = msgs;
    ReelPlayer.testLaunch = launched.add;
    oldSink = Telemetry.sink;
    Telemetry.sink = (e, p) => events.add((e, p));
  });
  tearDown(() {
    ReelPlayer.testRunJs = null;
    ReelPlayer.testMessages = null;
    ReelPlayer.testLaunch = null;
    ReelPlayer.testPlayer = null;
    Telemetry.sink = oldSink;
    msgs.close();
  });

  Future<void> pumpPlayer(
    WidgetTester tester,
    FeedReel r, {
    bool active = true,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ReelPlayer(reel: r, active: active),
        ),
      ),
    );
    await tester.pump();
  }

  testWidgets(
    'a tap on the transparent layer toggles the video underneath, and nothing is drawn over it',
    (tester) async {
      await pumpPlayer(tester, _reel('a'));
      expect(
        find.byKey(const ValueKey('reel-open-ig')),
        findsNothing,
      ); // HF-REEL-NOIG-1
      await tester.tap(find.byKey(const ValueKey('reel-tap')));
      await tester.pump();
      expect(js.where((s) => s.contains('hfToggle')), hasLength(1));
      // Instagram's own play control is hidden: this is the one paused symbol
      expect(find.byKey(const ValueKey('reel-glyph')), findsOneWidget);
      expect(find.byIcon(Icons.play_arrow_rounded), findsOneWidget);
    },
  );

  testWidgets('YouTube: the tap only toggles, no glyph, no Instagram chip', (
    tester,
  ) async {
    await pumpPlayer(tester, _reel('y', platform: 'youtube'));
    await tester.tap(find.byKey(const ValueKey('reel-tap')));
    await tester.pump();
    expect(js.where((s) => s.contains('hfToggle')), hasLength(1));
    expect(find.byKey(const ValueKey('reel-glyph')), findsNothing);
    expect(find.byKey(const ValueKey('reel-open-ig')), findsNothing);
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('ready player honours inactive state', (tester) async {
    await pumpPlayer(tester, _reel('inactive'), active: false);
    msgs.add('ready');
    expect(js.last, contains('hfSet(false)'));
  });

  testWidgets('going inactive pauses the video in place', (tester) async {
    await pumpPlayer(tester, _reel('a'));
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: ReelPlayer(reel: _reel('a'), active: false)),
      ),
    );
    expect(js.last, contains('hfSet(false)'));
  });

  testWidgets(
    'an embed error shows the poster with a plain note (no link out) and reports it',
    (tester) async {
      await pumpPlayer(tester, _reel('y', platform: 'youtube'));
      msgs.add('error:101');
      await tester.pump();
      expect(find.byKey(const ValueKey('reel-fallback')), findsOneWidget);
      expect(find.text('Watch on YouTube'), findsNothing); // [HF-REEL-OWN-1] never sent to YouTube
      expect(find.text('This video cannot play here. Swipe up for the next one.'), findsOneWidget);
      expect(find.byKey(const ValueKey('reel-tap')), findsNothing);
      expect(events.where((e) => e.$1 == 'hf_reel_play_fail').single.$2, {
        'platform': 'youtube',
        'reason': '101',
      });
      expect(find.byKey(const ValueKey('reel-fallback-open')), findsNothing);
      expect(launched, isEmpty);
    },
  );

  testWidgets(
    'Instagram: no video found shows the poster note, never a link to Instagram',
    (tester) async {
      await pumpPlayer(tester, _reel('a'));
      msgs.add('error:novideo');
      await tester.pump();
      expect(find.text('Watch on Instagram'), findsNothing); // [HF-REEL-OWN-1]
      expect(events.single.$2, {'platform': 'instagram', 'reason': 'novideo'});
      expect(launched, isEmpty);
    },
  );

  testWidgets(
    'creator page: tapping a thumbnail opens the full-screen viewer with a live player',
    (tester) async {
      tester.view.physicalSize = const Size(900, 2000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final reels = [_reel('r1'), _reel('r2', platform: 'youtube')];
      await tester.pumpWidget(
        MaterialApp(
          home: InviteProfileScreen(
            creator: const InviteCreator(
              platform: 'instagram',
              handle: '@nova',
              name: 'Nova',
            ),
            reels: reels,
          ),
        ),
      );
      await tester.pump();
      await tester.ensureVisible(find.byKey(const ValueKey('video-r1')));
      await tester.tap(find.byKey(const ValueKey('video-r1')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('preview-close')), findsOneWidget); // [HF-REEL-CALL-2] light preview
      expect(find.byKey(const ValueKey('preview-mute')), findsOneWidget);
      expect(find.byKey(const ValueKey('reel-call-bar')), findsNothing);
      expect(find.byKey(const ValueKey('reel-tap')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('reel-tap')));
      expect(js.where((s) => s.contains('hfToggle')), hasLength(1));
      await tester.pump(const Duration(seconds: 1));
    },
  );

  // [HF-REEL-OVERLAY-APP-1]
  testWidgets('YouTube: the tap layer covers the whole player except a hole over YouTube\'s own mute icon', (tester) async {
    await pumpPlayer(tester, _reel('y', platform: 'youtube'));
    final player = tester.getRect(find.byType(ReelPlayer));
    expect(find.byKey(const ValueKey('reel-tap')), findsOneWidget);
    // the sound icon (top right) is not ours: the tap reaches YouTube underneath
    await tester.tapAt(Offset(player.right - 76, player.top + 32));
    await tester.pump();
    expect(js.where((s) => s.contains('hfToggle')), isEmpty);
    // the menu, further right, and the title area stay covered: a tap there is play / pause
    await tester.tapAt(Offset(player.right - 34, player.top + 22));
    await tester.pump();
    expect(js.where((s) => s.contains('hfToggle')), hasLength(1));
    await tester.tapAt(Offset(player.left + 40, player.bottom - 40));
    await tester.pump();
    expect(js.where((s) => s.contains('hfToggle')), hasLength(2));
    // the page says where the player is: the hole follows it
    msgs.add('rect:0,0,${player.width},${player.height},${player.width},${player.height}');
    await tester.pump();
    await tester.tapAt(Offset(player.right - 76, player.top + 32));
    await tester.pump();
    expect(js.where((s) => s.contains('hfToggle')), hasLength(2));
  });

  testWidgets('Instagram: the tap layer is the whole player and exactly one play symbol shows when paused', (tester) async {
    await pumpPlayer(tester, _reel('i'));
    final player = tester.getRect(find.byType(ReelPlayer));
    final tap = tester.getRect(find.byKey(const ValueKey('reel-tap')));
    expect(tap, player);
    expect(find.byKey(const ValueKey('reel-glyph')), findsNothing);
    await tester.tapAt(Offset(player.right - 76, player.top + 32));
    await tester.pump();
    expect(js.where((s) => s.contains('hfToggle')), hasLength(1));
    expect(find.byKey(const ValueKey('reel-glyph')), findsOneWidget);
    expect(find.byIcon(Icons.play_arrow_rounded), findsOneWidget);
  });
}

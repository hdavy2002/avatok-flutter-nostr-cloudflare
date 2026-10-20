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
      url: platform == 'instagram' ? 'https://www.instagram.com/reel/Cx12345/' : 'https://www.youtube.com/shorts/abc12345',
      embedUrl: platform == 'instagram' ? 'https://www.instagram.com/reel/Cx12345/embed' : 'https://www.youtube.com/embed/abc12345',
      views: 10,
    );

void main() {
  late List<String> js;
  late StreamController<String> msgs;
  late List<Uri> launched;
  late List<(String, Map<String, Object?>)> events;
  late TelemetrySink oldSink;

  setUp(() {
    js = [];
    launched = [];
    events = [];
    msgs = StreamController<String>.broadcast();
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

  Future<void> pumpPlayer(WidgetTester tester, FeedReel r, {bool active = true}) async {
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: ReelPlayer(reel: r, active: active))));
    await tester.pump();
  }

  testWidgets('a tap on the transparent layer toggles the video underneath (Instagram shows our glyph)', (tester) async {
    await pumpPlayer(tester, _reel('a'));
    expect(find.byKey(const ValueKey('reel-open-ig')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('reel-tap')));
    await tester.pump();
    expect(js.where((s) => s.contains('hfToggle')), hasLength(1));
    expect(find.byIcon(Icons.play_arrow_rounded), findsOneWidget); // now paused: our glyph says play
    var glyph = tester.widget<AnimatedOpacity>(find.byKey(const ValueKey('reel-glyph')));
    expect(glyph.opacity, 1);
    await tester.pump(const Duration(milliseconds: 700));
    glyph = tester.widget<AnimatedOpacity>(find.byKey(const ValueKey('reel-glyph')));
    expect(glyph.opacity, 0);
    msgs.add('playing');
    await tester.pump();
    expect(find.byIcon(Icons.pause_rounded), findsOneWidget);
  });

  testWidgets('YouTube: the tap only toggles, nothing is drawn over the player', (tester) async {
    await pumpPlayer(tester, _reel('y', platform: 'youtube'));
    await tester.tap(find.byKey(const ValueKey('reel-tap')));
    await tester.pump();
    expect(js.where((s) => s.contains('hfToggle')), hasLength(1));
    expect(find.byKey(const ValueKey('reel-glyph')), findsNothing);
    expect(find.byKey(const ValueKey('reel-open-ig')), findsNothing);
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('going inactive pauses the video in place', (tester) async {
    await pumpPlayer(tester, _reel('a'));
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: ReelPlayer(reel: _reel('a'), active: false))));
    expect(js.last, contains('hfSet(false)'));
  });

  testWidgets('an embed error shows the poster card with Watch on ... and reports it', (tester) async {
    await pumpPlayer(tester, _reel('y', platform: 'youtube'));
    msgs.add('error:101');
    await tester.pump();
    expect(find.byKey(const ValueKey('reel-fallback')), findsOneWidget);
    expect(find.text('Watch on YouTube'), findsOneWidget);
    expect(find.byKey(const ValueKey('reel-tap')), findsNothing);
    expect(events.where((e) => e.$1 == 'hf_reel_play_fail').single.$2, {'platform': 'youtube', 'reason': '101'});
    await tester.tap(find.byKey(const ValueKey('reel-fallback-open')));
    expect(launched.single.toString(), 'https://www.youtube.com/shorts/abc12345');
  });

  testWidgets('Instagram: no video found shows Watch on Instagram; Open in Instagram launches the reel', (tester) async {
    await pumpPlayer(tester, _reel('a'));
    await tester.tap(find.byKey(const ValueKey('reel-open-ig')));
    expect(launched.single.toString(), 'https://www.instagram.com/reel/Cx12345/');
    msgs.add('error:novideo');
    await tester.pump();
    expect(find.text('Watch on Instagram'), findsOneWidget);
    expect(events.single.$2, {'platform': 'instagram', 'reason': 'novideo'});
  });

  testWidgets('creator page: tapping a thumbnail opens the full-screen viewer with a live player', (tester) async {
    tester.view.physicalSize = const Size(900, 2000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final reels = [_reel('r1'), _reel('r2', platform: 'youtube')];
    await tester.pumpWidget(MaterialApp(
      home: InviteProfileScreen(creator: const InviteCreator(platform: 'instagram', handle: '@nova', name: 'Nova'), reels: reels),
    ));
    await tester.pump();
    await tester.ensureVisible(find.byKey(const ValueKey('video-r1')));
    await tester.tap(find.byKey(const ValueKey('video-r1')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('viewer-close')), findsOneWidget);
    expect(find.byKey(const ValueKey('reel-tap')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('reel-tap')));
    expect(js.where((s) => s.contains('hfToggle')), hasLength(1));
    await tester.pump(const Duration(seconds: 1));
  });
}

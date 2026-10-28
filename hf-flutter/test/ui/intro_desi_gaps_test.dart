import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/models/reel.dart';
import 'package:hf_app/data/presence_store.dart';
import 'package:hf_app/data/repos/bookings_repo.dart';
import 'package:hf_app/data/repos/presence_repo.dart';
import 'package:hf_app/demo/data.dart';
import 'package:hf_app/demo/desi.dart';
import 'package:hf_app/demo/intro_home_kit.dart';
import 'package:hf_app/demo/intro_reel_overlay.dart';
import 'package:hf_app/demo/screens/onboarding/intro_onb_finish.dart';
import 'package:hf_app/demo/screens/onboarding/intro_onb_kit.dart';
import 'package:hf_app/demo/screens/onboarding/intro_onb_steps.dart';
import 'package:hf_app/demo/theme.dart';
import 'package:hf_app/demo/verified_tick.dart';

// [HF-DESI-GAPS] The four gaps closed after the desi onboarding restyle: the Aadhaar "How it works" card, her video still on
// "Sent for approval", the in queue / bookings today / per min tiles on the influencer Home, and the green verified tick on
// intro reels. Each lays out at 390 and 320 wide without an overflow.

typedef _Handler = Object? Function(String method, String path, Map<String, Object?>? query);

class _FakeApi extends ApiClient {
  _FakeApi(this.handler) : super(origin: 'https://api.test');
  final _Handler handler;

  @override
  Future<Object?> request(String method, String path,
      {Map<String, Object?>? query, Object? body, bool auth = true, Map<String, String>? headers}) async {
    final out = handler(method, path, query);
    if (out is ApiException) throw out;
    return out;
  }
}

// 1x1 transparent PNG
final Uint8List _png = base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');

const _sizes = [Size(390, 844), Size(320, 640)];

Future<void> _pump(WidgetTester tester, Widget screen, Size size) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(debugShowCheckedModeBanner: false, theme: buildTheme(), home: screen));
  await tester.pump();
}

ApiException _boom() => const ApiException(kind: ApiFailure.http, status: 404, code: 'not_found');

void main() {
  for (final size in _sizes) {
    final w = size.width.toInt();

    testWidgets('Aadhaar step shows How it works, the Women note and the lock line at $w', (tester) async {
      await _pump(tester, OnbAadhaarStep(reason: 'you picked Women-to-Women', womenPicked: true, whatsappVerified: true, onVerified: () {}, onBack: () {}), size);
      expect(tester.takeException(), isNull);
      expect(find.byKey(const ValueKey('onb-aadhaar-how')), findsOneWidget);
      expect(find.byType(OnbNumberedStep), findsNWidgets(3));
      expect(find.byType(RangoliNumber), findsNWidgets(3));
      expect(find.textContaining('DigiLocker'), findsNothing); // the form is the Aadhaar OTP, not DigiLocker
      expect(find.text('♀ Women-to-Women'), findsOneWidget);
      await tester.scrollUntilVisible(find.byKey(const ValueKey('onb-aadhaar-lock')), 200, scrollable: find.byType(Scrollable).first);
      expect(find.text('🔒 We never show your Aadhaar number to anyone.'), findsOneWidget);
    });

    testWidgets('Sent for approval shows her video still in the gold frame at $w', (tester) async {
      await _pump(tester, OnbSentScreen(onHome: () {}, posterBytes: _png), size);
      expect(tester.takeException(), isNull);
      final frame = find.byKey(const ValueKey('onb-sent-poster'));
      expect(frame, findsOneWidget);
      final deco = tester.widget<Container>(frame).decoration! as BoxDecoration;
      expect((deco.border! as Border).top.color, const Color(0xFFF59E0B));
      expect((deco.border! as Border).top.width, 4);
      expect(find.byIcon(Icons.play_arrow_rounded), findsOneWidget);
    });

    testWidgets('Home tiles show queue, bookings today and rate at $w', (tester) async {
      final api = _FakeApi((m, p, q) {
        if (p == '/api/hf/bookings') {
          expect(q?['day'], IntroHomeTiles.istToday());
          return {
            'bookings': [
              {'id': 'b1', 'status': 'confirmed', 'startAt': '2026-10-29T10:00:00Z'},
              {'id': 'b2', 'status': 'pending_approval', 'startAt': '2026-10-29T11:00:00Z'},
              {'id': 'b3', 'status': 'cancelled', 'startAt': '2026-10-29T12:00:00Z'},
            ],
          };
        }
        if (p == '/api/hf/hosts/me/rate') return {'ratePerMin': 12, 'minRate': 5, 'maxRate': 200, 'editable': true, 'hostGetsPerMinPaise': 900};
        return _boom();
      });
      final presence = PresenceStore(PresenceRepo(api))..queueWaiting = 3;
      await _pump(
        tester,
        Scaffold(backgroundColor: C.page, body: Padding(padding: const EdgeInsets.all(16), child: IntroHomeTiles(presence: presence, showQueue: true, bookings: BookingsRepo(api)))),
        size,
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.text('3'), findsOneWidget);
      expect(find.text('in queue'), findsOneWidget);
      expect(find.text('2'), findsOneWidget);
      expect(find.text('bookings today'), findsOneWidget);
      expect(find.text('₹12'), findsOneWidget);
      expect(find.text('per min'), findsOneWidget);
    });
  }

  testWidgets('Sent for approval falls back to the icon badge without a still', (tester) async {
    await _pump(tester, OnbSentScreen(onHome: () {}), const Size(390, 844));
    expect(find.byKey(const ValueKey('onb-sent-poster')), findsNothing);
    expect(find.byIcon(Icons.mark_email_read_rounded), findsOneWidget);
  });

  testWidgets('Home tiles hide what the server cannot give (no fake numbers)', (tester) async {
    final api = _FakeApi((m, p, q) => _boom());
    await _pump(
      tester,
      Scaffold(body: IntroHomeTiles(presence: PresenceStore(PresenceRepo(api)), showQueue: false, bookings: BookingsRepo(api))),
      const Size(390, 844),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('home-tile-queue')), findsNothing);
    expect(find.byKey(const ValueKey('home-tile-bookings')), findsNothing);
    expect(find.byKey(const ValueKey('home-tile-rate')), findsNothing);
  });

  testWidgets('verified tick is green #3FA868 on the intro overlay and the Verified owner sheet', (tester) async {
    const reel = FeedReel(
      id: 'r1',
      kind: 'intro',
      host: ReelHost(slug: 'priya', name: 'Priya Sharma', ratePaise: 1200),
      mainAction: 'call',
      socials: [ReelSocial(platform: 'youtube', handle: '@priyacooks', url: 'https://youtube.com/@priyacooks', followers: 12400)],
    );
    late BuildContext ctx;
    await _pump(
      tester,
      Scaffold(
        backgroundColor: C.cinema,
        body: Builder(builder: (c) {
          ctx = c;
          return Stack(children: [
            IntroReelOverlay(reel: reel, who: influencers.first, rail: const SizedBox(height: 100), onProfile: () {}, onSocial: (_) {}, onCall: () {}, onQueue: () {}, onBook: () {}),
          ]);
        }),
      ),
      const Size(390, 844),
    );
    Color dotColor(Finder tick) {
      final box = tester.widget<Container>(find.descendant(of: tick, matching: find.byType(Container)).first);
      return (box.decoration! as BoxDecoration).color!;
    }

    expect(dotColor(find.byType(VerifiedTick).first), const Color(0xFF3FA868));
    final sheet = showIntroInfoSheet(ctx, reel: reel, who: influencers.first);
    await tester.pumpAndSettle();
    final inSheet = find.descendant(of: find.byKey(const ValueKey('intro-info-sheet')), matching: find.byType(VerifiedTick));
    expect(dotColor(inSheet), const Color(0xFF3FA868));
    await tester.tap(find.byKey(const ValueKey('intro-info-close')));
    await tester.pumpAndSettle();
    expect(await sheet, isNull);
  });

  testWidgets('other screens keep the green (KYC) / lavender (channel) tick rule', (tester) async {
    await _pump(tester, const Scaffold(body: VerifiedTick(name: 'Sana', videoKyc: false, channel: true, surface: 'test', interactive: false)), const Size(390, 844));
    final box = tester.widget<Container>(find.descendant(of: find.byType(VerifiedTick), matching: find.byType(Container)).first);
    expect((box.decoration! as BoxDecoration).color, C.lav);
  });
}

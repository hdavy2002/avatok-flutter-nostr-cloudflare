import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/intro_flags.dart';
import 'package:hf_app/data/photos_gate.dart';
import 'package:hf_app/data/repos/my_photos_repo.dart';
import 'package:hf_app/data/telemetry.dart';
import 'package:hf_app/demo/screens/my_photos.dart';
import 'package:hf_app/demo/screens/photo_crop_editor.dart';
import 'package:image/image.dart' as im;

/// [HF-PHOTO-CROP-APP] crop maths, the cropping isolate function, the photos-required gate and the two new screens.

Uint8List _png(int w, int h, {bool halves = false}) {
  final img = im.Image(width: w, height: h);
  if (halves) {
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (x < w ~/ 2) {
          img.setPixelRgb(x, y, 255, 0, 0);
        } else {
          img.setPixelRgb(x, y, 0, 0, 255);
        }
      }
    }
  }
  return Uint8List.fromList(im.encodePng(img));
}

class _FakeApi extends ApiClient {
  _FakeApi(this.handler) : super(origin: 'https://api.test');

  Object? Function(String method, String path) handler;

  @override
  Future<Object?> request(String method, String path,
      {Map<String, Object?>? query, Object? body, bool auth = true, Map<String, String>? headers}) async {
    final out = handler(method, path);
    if (out is ApiException) throw out;
    return out;
  }
}

class _Repo extends MyPhotosRepo {
  _Repo(this.next) : super(_FakeApi((_, __) => null));

  Object next;
  int loads = 0;

  @override
  Future<MyPhotos> load() async {
    loads++;
    final n = next;
    if (n is Exception) throw n;
    return n as MyPhotos;
  }
}

PhotosGate _gate(_Repo repo, {bool signedIn = true, bool flag = true}) =>
    PhotosGate(repo: () => repo, signedIn: () => signedIn, flagOn: () => flag, loadFlags: () async {});

void main() {
  group('CropMath', () {
    test('zoom 1 just covers the frame and the picture cannot be dragged off its edges', () {
      final m = CropMath(imageW: 4000, imageH: 3000, frameW: 300, frameH: 100);
      expect(m.minScale, closeTo(0.075, 1e-9));
      expect(m.visW, closeTo(4000, 1e-6));
      expect(m.visH, closeTo(1333.33, 0.01));
      m.pan(0, 100000); // finger drags down: the picture follows until its top edge meets the frame
      expect(m.src.top, closeTo(0, 1e-6));
      m.pan(0, -100000);
      expect(m.src.bottom, closeTo(3000, 1e-6));
      m.pan(100000, 0); // already as wide as the picture: nothing to move
      expect(m.src.left, closeTo(0, 1e-6));
    });

    test('zoom is clamped between cover-fit and the maximum, and pan stays inside', () {
      final m = CropMath(imageW: 800, imageH: 400, frameW: 200, frameH: 200);
      m.setZoom(0.2);
      expect(m.zoom, 1);
      m.setZoom(99);
      expect(m.zoom, m.maxZoom);
      m.setZoom(2);
      expect(m.left, closeTo(0.375, 1e-9)); // a 200 px window, centred on an 800 px picture
      m.pan(-100000, 0);
      expect(m.right, closeTo(1, 1e-9));
      m.pan(100000, 0);
      expect(m.left, closeTo(0, 1e-9));
      m.reset();
      expect(m.zoom, 1);
      expect(m.left, closeTo(0.25, 1e-9));
      expect(m.right, closeTo(0.75, 1e-9));
      expect(m.top, closeTo(0, 1e-9));
      expect(m.bottom, closeTo(1, 1e-9));
    });
  });

  group('cropPhoto', () {
    test('profile: crops exactly the framed square', () {
      // left half red, right half blue; frame the right half
      final (bytes, problem) = cropPhoto((_png(800, 400, halves: true), PhotoKind.profile.index, 0.5, 0.0, 1.0, 1.0));
      expect(problem, isNull);
      final out = im.decodeJpg(bytes!)!;
      expect((out.width, out.height), (400, 400));
      final p = out.getPixel(200, 200);
      expect(p.b, greaterThan(200));
      expect(p.r, lessThan(60));
    });

    test('profile: capped at 1080, raised to 200', () {
      final big = cropPhoto((_png(3000, 2000), PhotoKind.profile.index, 0.0, 0.0, 1.0, 1.0));
      final o1 = im.decodeJpg(big.$1!)!;
      expect((o1.width, o1.height), (1080, 1080));
      final tiny = cropPhoto((_png(400, 400), PhotoKind.profile.index, 0.0, 0.0, 0.25, 0.25));
      final o2 = im.decodeJpg(tiny.$1!)!;
      expect((o2.width, o2.height), (200, 200));
    });

    test('cover: 3 to 1, 1500 x 500 when the source is big enough', () {
      final full = cropPhoto((_png(3200, 1200), PhotoKind.cover.index, 0.0, 0.0, 1.0, 1.0));
      final o1 = im.decodeJpg(full.$1!)!;
      expect((o1.width, o1.height), (1500, 500));
      final zoomed = cropPhoto((_png(3200, 1200), PhotoKind.cover.index, 0.25, 0.25, 0.75, 0.5));
      final o2 = im.decodeJpg(zoomed.$1!)!;
      expect((o2.width, o2.height), (1500, 500));
    });

    test('cover: source-limited width, and never under 640 wide', () {
      final small = cropPhoto((_png(1000, 400), PhotoKind.cover.index, 0.0, 0.0, 1.0, 1.0));
      final o1 = im.decodeJpg(small.$1!)!;
      expect((o1.width, o1.height), (1000, 333));
      final zoomedIn = cropPhoto((_png(700, 300), PhotoKind.cover.index, 0.0, 0.0, 0.5, 1.0));
      final o2 = im.decodeJpg(zoomedIn.$1!)!;
      expect((o2.width, o2.height), (640, 213));
    });

    test('too small and unreadable pictures give the same problem codes as shrinkPhoto', () {
      expect(cropPhoto((_png(150, 400), PhotoKind.profile.index, 0.0, 0.0, 1.0, 1.0)).$2, 'small');
      expect(cropPhoto((_png(600, 300), PhotoKind.cover.index, 0.0, 0.0, 1.0, 1.0)).$2, 'small');
      expect(cropPhoto((Uint8List.fromList([1, 2, 3]), PhotoKind.cover.index, 0.0, 0.0, 1.0, 1.0)).$2, 'bad');
    });
  });

  group('MyPhotos and flags', () {
    test('photos_complete and photos_missing are read; an older server falls back to the two slots', () {
      final p = MyPhotos.fromJson({
        'photos_complete': false,
        'photos_missing': ['cover'],
        'photos': {
          'profile': {'url': 'https://x/p.jpg'},
          'cover': {'url': null, 'checking': false, 'refused': 'No.'},
        },
      });
      expect(p.photosComplete, isFalse);
      expect(p.isComplete, isFalse);
      expect(p.photosMissing, ['cover']);
      final old = MyPhotos.fromJson({
        'photos': {
          'profile': {'url': 'https://x/p.jpg'},
          'cover': {'url': 'https://x/c.jpg'},
        },
      });
      expect(old.photosComplete, isNull);
      expect(old.isComplete, isTrue);
      expect(MyPhotos.fromJson({}).isComplete, isFalse);
    });

    test('hfPhotosRequiredEnabled is read like the other flags and the new events are in the catalog', () {
      IntroFlags.reset();
      expect(IntroFlags.photosRequired, isFalse);
      IntroFlags.apply({'hfPhotosRequiredEnabled': true});
      expect(IntroFlags.photosRequired, isTrue);
      IntroFlags.reset();
      expect(IntroFlags.photosRequired, isFalse);
      expect(Telemetry.catalogEvents,
          containsAll(['hf_photo_crop', 'hf_photo_onboarding_shown', 'hf_photo_onboarding_done', 'hf_photo_gate_redirect']));
    });
  });

  group('PhotosGate', () {
    test('blocks when the server says photos are incomplete, lets go when complete', () async {
      final repo = _Repo(const MyPhotos(photosComplete: false, photosMissing: ['profile', 'cover']));
      final g = _gate(repo);
      var changes = 0;
      g.addListener(() => changes++);
      await g.refresh();
      expect(g.blocking, isTrue);
      expect(g.missing, ['profile', 'cover']);
      expect(changes, 1);
      repo.next = const MyPhotos(photosComplete: true);
      await g.refresh();
      expect(g.blocking, isFalse);
      expect(changes, 2);
    });

    test('fails open when the status call errors, when signed out, and when the flag is off', () async {
      final repo = _Repo(const MyPhotos(photosComplete: false));
      final g = _gate(repo);
      await g.refresh();
      expect(g.blocking, isTrue);
      repo.next = ApiException.offline();
      await g.refresh();
      expect(g.blocking, isFalse);

      final out = _gate(_Repo(const MyPhotos(photosComplete: false)), signedIn: false);
      await out.refresh();
      expect(out.blocking, isFalse);

      final off = _Repo(const MyPhotos(photosComplete: false));
      final flagOff = _gate(off, flag: false);
      await flagOff.refresh();
      expect(flagOff.blocking, isFalse);
      expect(off.loads, 0); // flag off: not even a status call
    });

    test('a 403 photos_required blocks at once, even with the flag off, and hands over the server message once', () async {
      final repo = _Repo(const MyPhotos(photosComplete: false));
      final g = _gate(repo, flag: false);
      final e = ApiException.fromResponse(403, '{"error":"photos_required","message":"Add your photos first.","missing":["cover"]}');
      await expectLater(PhotosGate.watch<void>(Future<void>.error(e)), throwsA(isA<ApiException>()));
      PhotosGate.instance.reset();
      g.markRequired(e);
      expect(g.blocking, isTrue);
      expect(g.missing, ['cover']);
      expect(g.takeMessage(), 'Add your photos first.');
      expect(g.takeMessage(), isNull);
    });

    test('redirect: every route except the exempt ones goes to the setup screen, never in a loop', () async {
      final g = _gate(_Repo(const MyPhotos(photosComplete: false)));
      expect(photosGateRedirect(g, '/reels'), isNull); // nothing known yet
      await g.refresh();
      for (final p in ['/reels', '/me', '/profile/abc', '/book/abc', '/call/1', '/wallet', '/inf/home', '/h/abc']) {
        expect(photosGateRedirect(g, p), '/onboarding/photos', reason: p);
      }
      for (final p in [
        '/onboarding/photos',
        '/splash',
        '/intro',
        '/settings',
        '/settings/profile',
        '/help',
        '/page/terms',
        '/support',
        '/support/HF-10234',
      ]) {
        expect(photosGateRedirect(g, p), isNull, reason: p);
      }
    });
  });

  group('screens', () {
    void bigScreen(WidgetTester tester) {
      tester.view.physicalSize = const Size(800, 3200);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
    }

    Widget host(Widget Function(BuildContext) open) => MaterialApp(home: Builder(builder: open));

    testWidgets('editor: profile hint, Use this photo answers the visible square', (tester) async {
      bigScreen(tester);
      final png = _png(800, 400);
      PhotoCropResult? got;
      await tester.pumpWidget(host((c) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () async => got = await Navigator.of(c).push<PhotoCropResult>(
                  MaterialPageRoute<PhotoCropResult>(builder: (_) => PhotoCropEditor(bytes: png, kind: PhotoKind.profile)),
                ),
                child: const Text('open'),
              ),
            ),
          )));
      await tester.tap(find.text('open'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 300)));
      await tester.pump();
      expect(find.text('Adjust your photo'), findsOneWidget);
      expect(find.text('Move and zoom so your face is in the circle.'), findsOneWidget);
      await tester.tap(find.text('Use this photo'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(got, isNotNull);
      expect(got!.another, isFalse);
      expect(got!.left, closeTo(0.25, 1e-6));
      expect(got!.right, closeTo(0.75, 1e-6));
      expect(got!.top, closeTo(0, 1e-6));
      expect(got!.bottom, closeTo(1, 1e-6));
    });

    testWidgets('editor: cover hint and Choose another', (tester) async {
      bigScreen(tester);
      final png = _png(1200, 400);
      PhotoCropResult? got;
      await tester.pumpWidget(host((c) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () async => got = await Navigator.of(c).push<PhotoCropResult>(
                  MaterialPageRoute<PhotoCropResult>(builder: (_) => PhotoCropEditor(bytes: png, kind: PhotoKind.cover)),
                ),
                child: const Text('open'),
              ),
            ),
          )));
      await tester.tap(find.text('open'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 300)));
      await tester.pump();
      expect(find.text('Move and zoom to pick the part you want.'), findsOneWidget);
      await tester.tap(find.text('Choose another'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(got?.another, isTrue);
    });

    testWidgets('onboarding: both slots needed, Continue stays off, a refusal shows the server sentence', (tester) async {
      bigScreen(tester);
      IntroFlags.markLoadedForTest();
      addTearDown(IntroFlags.reset);
      const sentence = "We couldn't see a clear face in this photo. Please choose one where your face is clear.";
      final api = _FakeApi((m, p) => {
            'ok': true,
            'photos_complete': false,
            'photos_missing': ['profile', 'cover'],
            'photos': {
              'profile': {'url': null, 'checking': false, 'refused': sentence},
              'cover': {'url': null, 'checking': false, 'refused': null},
            },
          });
      final repo = MyPhotosRepo(api);
      await tester.pumpWidget(MaterialApp(home: MyPhotosScreen(onboarding: true, repo: repo, gate: _gate(_Repo(const MyPhotos())))));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Add your photos'), findsWidgets);
      expect(find.text('Profile photo'), findsWidgets);
      expect(find.text('Cover photo'), findsWidgets);
      expect(find.text('Why your photo was not accepted'), findsOneWidget);
      expect(find.text(sentence), findsOneWidget);
      expect(find.text('Choose another photo'), findsOneWidget);
      final cont = tester.widget<PhotoButton>(find.widgetWithText(PhotoButton, 'Continue'));
      expect(cont.onTap, isNull);
    });
  });
}

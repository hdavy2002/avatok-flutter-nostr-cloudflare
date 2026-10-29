import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/intro_flags.dart';
import 'package:hf_app/data/models/booking.dart';
import 'package:hf_app/data/repos/my_photos_repo.dart';
import 'package:hf_app/data/telemetry.dart';
import 'package:hf_app/demo/screens/my_photos.dart';
import 'package:image/image.dart' as im;

Uint8List _png(int w, int h) => Uint8List.fromList(im.encodePng(im.Image(width: w, height: h)));

void main() {
  group('shrinkPhoto', () {
    test('profile: centre-crops to a square and caps at 1080', () {
      final (bytes, problem) = shrinkPhoto((_png(3000, 2000), PhotoKind.profile.index));
      expect(problem, isNull);
      final out = im.decodeJpg(bytes!)!;
      expect(out.width, 1080);
      expect(out.height, 1080);
    });

    test('profile: a small square is kept as it is', () {
      final (bytes, _) = shrinkPhoto((_png(400, 300), PhotoKind.profile.index));
      final out = im.decodeJpg(bytes!)!;
      expect((out.width, out.height), (300, 300));
    });

    test('profile: under 200 px is refused as small', () {
      final (bytes, problem) = shrinkPhoto((_png(150, 400), PhotoKind.profile.index));
      expect(bytes, isNull);
      expect(problem, 'small');
    });

    test('cover: width capped at 1600, aspect kept', () {
      final (bytes, _) = shrinkPhoto((_png(3200, 1000), PhotoKind.cover.index));
      final out = im.decodeJpg(bytes!)!;
      expect(out.width, 1600);
      expect(out.height, 500);
    });

    test('cover: never shrunk under 200 high', () {
      final (bytes, _) = shrinkPhoto((_png(8000, 400), PhotoKind.cover.index));
      final out = im.decodeJpg(bytes!)!;
      expect(out.height, greaterThanOrEqualTo(200));
    });

    test('cover: under 640 x 200 is small, garbage is bad', () {
      expect(shrinkPhoto((_png(600, 300), PhotoKind.cover.index)).$2, 'small');
      expect(shrinkPhoto((Uint8List.fromList([1, 2, 3]), PhotoKind.cover.index)).$2, 'bad');
    });
  });

  test('MyPhotos parses slots, refused sentence and tolerates gaps', () {
    final p = MyPhotos.fromJson({
      'ok': true,
      'photos': {
        'profile': {'url': 'https://x/p.jpg', 'checking': false, 'refused': 'No nudity please.'},
        'cover': {'url': null, 'checking': true, 'refused': null},
      },
    });
    expect(p.profile.url, 'https://x/p.jpg');
    expect(p.profile.refused, 'No nudity please.');
    expect(p.cover.checking, isTrue);
    expect(p.cover.url, isNull);
    expect(MyPhotos.fromJson({}).profile.url, isNull);
  });

  test('influencer booking carries customerPhotoUrl', () {
    final b = AppBooking.fromJson({'id': '1', 'status': 'confirmed', 'startAt': '2026-10-30T10:00:00Z', 'customerHandle': 'priya', 'customerPhotoUrl': 'https://x/f.jpg'});
    expect(b.customerPhotoUrl, 'https://x/f.jpg');
    expect(AppBooking.fromJson({'id': '2', 'status': 'confirmed', 'customerHandle': 'a'}).customerPhotoUrl, isNull);
  });

  test('flag and telemetry catalog', () {
    IntroFlags.reset();
    expect(IntroFlags.photoModeration, isFalse);
    IntroFlags.apply({'hfPhotoModerationEnabled': true});
    expect(IntroFlags.photoModeration, isTrue);
    IntroFlags.reset();
    expect(Telemetry.catalogEvents, containsAll(['hf_photo_pick', 'hf_photo_upload_app', 'hf_photo_result_app']));
  });
}

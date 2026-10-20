import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/deep_links.dart';
import 'package:hf_app/data/telemetry.dart';

void main() {
  group('push payload paths [HF-BOOK-APPROVE-PUSH]', () {
    test('/bookings/<id> opens one booking, anonymised for telemetry', () {
      final t = linkTargetForPath('/bookings/bk_abcdef123456');
      expect(t?.location, '/bookings/bk_abcdef123456');
      expect(t?.telemetryPath, '/bookings/:id');
    });

    test('app-friendly influencer and fan paths are accepted', () {
      expect(linkTargetForPath('/inf/bookings')?.location, '/inf/bookings');
      expect(linkTargetForPath('/inf/availability')?.location, '/inf/availability');
      expect(linkTargetForPath('/bookings')?.location, '/bookings');
    });

    test('older web-style push paths still land on an influencer screen', () {
      expect(linkTargetForPath('/dashboard/appointments')?.location, '/inf/bookings');
      expect(linkTargetForPath('/host')?.location, '/inf/status');
      expect(linkTargetForPath('/hosts/dashboard')?.location, '/inf/home');
    });

    test('unsafe or unknown paths are ignored', () {
      expect(linkTargetForPath('//evil.example/bookings/bk_abcdef123456'), isNull);
      expect(linkTargetForPath('https://evil.example/bookings/bk_abcdef123456'), isNull);
      expect(linkTargetForPath('/admin/bookings'), isNull);
      expect(linkTargetForPath('/bookings/x'), isNull);
      expect(linkTargetForPath('/inf/secret'), isNull);
      expect(linkTargetForPath(r'/bookings\bk_abcdef123456'), isNull);
    });
  });

  test('push telemetry events are in the catalog and carry path + state', () {
    expect(Telemetry.catalogEvents, containsAll(['hf_app_push_opened', 'hf_push_registered']));
    final seen = <String>[];
    final before = Telemetry.sink;
    Telemetry.sink = (e, p) => seen.add('$e:${p['path']}:${p['state']}');
    addTearDown(() => Telemetry.sink = before);
    Telemetry.pushOpened(path: '/bookings/:id', state: 'cold');
    expect(seen, ['hf_app_push_opened:/bookings/:id:cold']);
  });
}

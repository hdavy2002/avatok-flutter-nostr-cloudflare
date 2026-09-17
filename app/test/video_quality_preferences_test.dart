import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:avatok_call/core/calls/video_quality_policy.dart';
import 'package:avatok_call/core/calls/video_quality_preferences.dart';
import 'package:avatok_call/identity/identity.dart' show AccountScope;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    AccountScope.id = 'parent';
  });
  tearDown(() => AccountScope.id = null);

  test('pending writes stay with captured account across account switch', () async {
    final parent = VideoQualityPreferences();
    final pending = parent.save(VideoQualityMode.best);
    AccountScope.id = 'child';
    final child = VideoQualityPreferences();
    await pending;
    expect(await child.load(), VideoQualityMode.auto);
    expect(await parent.load(), VideoQualityMode.best);
    await child.save(VideoQualityMode.dataSaver);
    expect(await parent.load(), VideoQualityMode.best);
    expect(await child.load(), VideoQualityMode.dataSaver);
  });

  test('guest never inherits a global or another account preference', () async {
    SharedPreferences.setMockInitialValues({'video_quality_mode_v1': 'best'});
    AccountScope.id = null;
    final guest = VideoQualityPreferences();
    expect(guest.storageKey, 'video_quality_mode_v1_guest');
    expect(await guest.load(), VideoQualityMode.auto);
  });

  test('rapid selections persist in order', () async {
    final preferences = VideoQualityPreferences();
    await Future.wait([
      preferences.save(VideoQualityMode.best),
      preferences.save(VideoQualityMode.dataSaver),
      preferences.save(VideoQualityMode.auto),
    ]);
    expect(await preferences.load(), VideoQualityMode.auto);
  });
}

import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/features/home/ui/home_copy.dart';

void main() {
  group('HomeCopy.greeting', () {
    test('follows the time of day', () {
      expect(
        HomeCopy.greeting('Davy', now: DateTime(2026, 10, 11, 5)),
        'Good morning, Davy',
      );
      expect(
        HomeCopy.greeting('Davy', now: DateTime(2026, 10, 11, 11, 59)),
        'Good morning, Davy',
      );
      expect(
        HomeCopy.greeting('Davy', now: DateTime(2026, 10, 11, 12)),
        'Good afternoon, Davy',
      );
      expect(
        HomeCopy.greeting('Davy', now: DateTime(2026, 10, 11, 16, 59)),
        'Good afternoon, Davy',
      );
      expect(
        HomeCopy.greeting('Davy', now: DateTime(2026, 10, 11, 17)),
        'Good evening, Davy',
      );
      expect(
        HomeCopy.greeting('Davy', now: DateTime(2026, 10, 11, 2)),
        'Good evening, Davy',
      );
    });

    test('a guest has no name', () {
      expect(
        HomeCopy.greeting(null, now: DateTime(2026, 10, 11, 19)),
        'Good evening',
      );
      expect(
        HomeCopy.greeting('  ', now: DateTime(2026, 10, 11, 19)),
        'Good evening',
      );
    });
  });
}

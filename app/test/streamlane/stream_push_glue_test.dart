// STREAM-LANE. Tests the real, pure discriminator in
// lib/streamlane/stream_push_glue.dart (SDK-free by design — see its library
// comment). Foreground handling respects the hydrated feature flag. A Firebase
// background isolate has no hydrated RemoteConfig, so genuine provider pushes
// must enter fail-closed credential recovery instead of reading the false
// compile-time default and silently losing the ring.
import 'package:flutter_test/flutter_test.dart';

import 'package:avatok_call/streamlane/stream_push_glue.dart';

void main() {
  group('isStreamPush', () {
    test('true for a Stream Video envelope', () {
      expect(isStreamPush({'sender': 'stream.video', 'type': 'call.ring'}),
          isTrue);
    });

    test('false for old-lane call pushes', () {
      expect(isStreamPush({'type': 'call', 'callId': 'avatok-123'}), isFalse);
    });

    test('false for empty / missing sender', () {
      expect(isStreamPush({}), isFalse);
      expect(isStreamPush({'sender': ''}), isFalse);
      expect(isStreamPush({'sender': 'someone.else'}), isFalse);
    });
  });

  group('flag-off non-interference (default config)', () {
    test('handleStreamPush refuses even a genuine Stream push', () {
      expect(handleStreamPush({'sender': 'stream.video'}), isFalse);
    });

    test('background recovery accepts a genuine Stream push without config',
        () async {
      expect(
          await handleStreamPushBackground({'sender': 'stream.video'}), isTrue);
    });

    test('both refuse non-Stream pushes regardless of flag', () async {
      expect(handleStreamPush({'type': 'call'}), isFalse);
      expect(await handleStreamPushBackground({'type': 'call'}), isFalse);
    });
  });
}

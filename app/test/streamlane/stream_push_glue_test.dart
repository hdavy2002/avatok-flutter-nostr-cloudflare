// STREAM-LANE. Tests the real, pure discriminator in
// lib/streamlane/stream_push_glue.dart (SDK-free by design — see its library
// comment). With remote config unset in tests, `streamCallsEnabled` defaults
// to false, so the handle* wrappers must refuse even genuine Stream pushes:
// that IS the non-interference contract this lane ships under.
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

    test('handleStreamPushBackground refuses even a genuine Stream push',
        () async {
      expect(await handleStreamPushBackground({'sender': 'stream.video'}),
          isFalse);
    });

    test('both refuse non-Stream pushes regardless of flag', () async {
      expect(handleStreamPush({'type': 'call'}), isFalse);
      expect(await handleStreamPushBackground({'type': 'call'}), isFalse);
    });
  });
}

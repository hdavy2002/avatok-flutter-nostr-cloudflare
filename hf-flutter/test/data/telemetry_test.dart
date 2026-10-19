import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/telemetry.dart';

void main() {
  test('scrub drops personal keys and values, keeps plain ones', () {
    final out = Telemetry.cleanForTest({
      'phone': '+91 98765 43210',
      'whatsapp_number': '9876543210',
      'email': 'a@b.com',
      'name': 'Meera',
      'display_name': 'Meera Joshi',
      'otp_code': '123456',
      'note': 'free text',
      'free_text': 'mail me at someone@example.com',
      'ring': 'call 98765 43210 now',
      'platform': 'instagram',
      'ms': 120,
      'ok': true,
      'status': 200,
      'nothing': null,
    });
    expect(out.keys.toSet(), {'platform', 'ms', 'ok', 'status'});
  });

  test('catalog holds the crash event and every event the app sends today', () {
    expect(Telemetry.catalogEvents, containsAll(['app_crash', 'api_error', 'hf_app_open', 'hf_topup_started', 'hf_app_call_started']));
  });

  test('crash reporter sends app_crash once per distinct error and never throws', () {
    final seen = <String>[];
    final before = Telemetry.sink;
    Telemetry.sink = (e, p) => seen.add('$e:${p['source']}:${p['error_type']}');
    addTearDown(() => Telemetry.sink = before);
    final stack = StackTrace.fromString('#0 main (package:hf_app/main.dart:1:1)\n#1 other (package:hf_app/x.dart:2:2)');
    Telemetry.crash(StateError('secret typed text'), stack, source: 'zone');
    Telemetry.crash(StateError('secret typed text again'), stack, source: 'zone'); // same type + top frame: de-duplicated
    Telemetry.crash(FormatException('x'), stack, source: 'platform', fatal: true);
    expect(seen, ['app_crash:zone:StateError', 'app_crash:platform:FormatException']);
  });
}

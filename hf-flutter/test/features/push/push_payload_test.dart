import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/router/deep_links.dart';
import 'package:hf_app/features/push/data/push_payload.dart';

import 'push_support.dart';

void main() {
  group('payload kind -> route (all 7 kinds, spec 2.16)', () {
    // kind, data.path from the worker, the app route it must open
    const table = <(String, String, String)>[
      ('notify_me', '/h/asha', '/h/asha'),
      ('host_approved', '/hosts/dashboard', '/host'),
      ('host_changes', '/hosts/dashboard', '/host'),
      ('withdrawal_approved', '/hosts/dashboard', '/host'),
      ('withdrawal_paid', '/hosts/dashboard', '/host'),
      ('low_balance', '/wallet', '/wallet'),
      ('review_request', '/review/tok123', '/review/tok123'),
    ];

    for (final row in table) {
      test('${row.$1} opens ${row.$3}', () {
        final payload = workerPush(row.$1, row.$2).payload;
        expect(payload, isNotNull);
        expect(payload!.kind.wire, row.$1);
        final target = payload.target;
        expect(target, isA<OpenRoute>());
        expect((target as OpenRoute).location, row.$3);
      });
    }

    test('the table covers every kind the app knows', () {
      final known = PushKind.values.where((k) => k != PushKind.other).map((k) => k.wire).toSet();
      expect(table.map((r) => r.$1).toSet(), known);
      expect(kindPaths.keys.toSet(), known);
    });

    test('a slug with odd characters is kept whole', () {
      final t = workerPush('notify_me', '/h/asha-k').payload!.target as OpenRoute;
      expect(t.location, '/h/asha-k');
    });
  });

  group('payload validation', () {
    test('data of another sender is ignored', () {
      expect(PushPayload.fromData({'type': 'something_else', 'kind': 'notify_me', 'path': '/h/a'}), isNull);
    });

    test('a missing type is accepted (older worker)', () {
      expect(PushPayload.fromData({'kind': 'low_balance', 'path': '/wallet'}), isNotNull);
    });

    test('a push can never leave the site', () {
      expect(PushPayload.fromData({'type': 'hf_push', 'kind': 'notify_me', 'path': 'https://evil.example/x'}), isNull);
      expect(PushPayload.fromData({'type': 'hf_push', 'kind': 'notify_me', 'path': '//evil.example/x'}), isNull);
    });

    test('no path: kinds without an id still have a home', () {
      expect(PushPayload.fromData({'type': 'hf_push', 'kind': 'host_approved'})!.path, '/hosts/dashboard');
      expect(PushPayload.fromData({'type': 'hf_push', 'kind': 'withdrawal_paid'})!.path, '/hosts/dashboard');
      expect(PushPayload.fromData({'type': 'hf_push', 'kind': 'low_balance'})!.path, '/wallet');
    });

    test('no path: kinds that need a slug or a token do nothing', () {
      expect(PushPayload.fromData({'type': 'hf_push', 'kind': 'notify_me'}), isNull);
      expect(PushPayload.fromData({'type': 'hf_push', 'kind': 'review_request'}), isNull);
    });

    test('an unknown kind still opens its path and is recorded as other', () {
      final p = PushPayload.fromData({'type': 'hf_push', 'kind': 'brand_new_kind', 'path': '/wallet'})!;
      expect(p.kind, PushKind.other);
      expect(p.kind.wire, 'other');
      expect(p.target, isA<OpenRoute>());
    });

    test('a path with no screen opens the site page in a Custom Tab', () {
      final p = PushPayload.fromData({'type': 'hf_push', 'kind': 'other', 'path': '/terms'})!;
      expect(p.target, isA<OpenCustomTab>());
    });

    test('toString never carries a slug or token', () {
      final text = workerPush('review_request', '/review/secrettoken').payload.toString();
      expect(text.contains('secrettoken'), isFalse);
    });
  });
}

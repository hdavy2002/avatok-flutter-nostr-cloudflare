import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/models/me.dart';
import 'package:hf_app/data/repos/policy_repo.dart';
import 'package:hf_app/data/repos/settings_repo.dart';

typedef Handler = Object? Function(String method, String path, Object? body);

class FakeApiClient extends ApiClient {
  FakeApiClient(this.handler) : super(origin: 'https://api.test');

  Handler handler;
  final List<String> calls = [];
  final List<Object?> bodies = [];

  @override
  Future<Object?> request(String method, String path,
      {Map<String, Object?>? query, Object? body, bool auth = true, Map<String, String>? headers}) async {
    calls.add('$method $path');
    bodies.add(body);
    final out = handler(method, path, body);
    if (out is ApiException) throw out;
    return out;
  }
}

Map<String, Object?> _pendingJson({bool required = true, List<String> policies = const ['terms', 'privacy']}) => {
      'required': required,
      'note': 'We now call payouts “withdrawals” and send money only to UPI.',
      'pending': [
        for (final p in policies) {'policy': p, 'path': '/$p', 'version': 'sha256:$p'},
      ],
    };

void main() {
  group('Me.fromJson [HF-APP-PARITY-PROFILE]', () {
    test('reads first name, last name and the handle (server field username)', () {
      final me = Me.fromJson({'uid': 'u1', 'displayName': 'Asha R.', 'firstName': 'Asha', 'lastName': 'Rao', 'username': 'asha_rao'});
      expect(me.firstName, 'Asha');
      expect(me.lastName, 'Rao');
      expect(me.handle, 'asha_rao');
      expect(me.name, 'Asha R.');
    });

    test('missing or blank parts are null; a leading @ is dropped; old answers still parse', () {
      final blank = Me.fromJson({'uid': 'u1', 'firstName': '  ', 'lastName': null, 'username': '@meena'});
      expect(blank.firstName, isNull);
      expect(blank.lastName, isNull);
      expect(blank.handle, 'meena');
      final old = Me.fromJson({'uid': 'u2', 'displayName': 'Meena'});
      expect(old.firstName, isNull);
      expect(old.handle, isNull);
      expect(old.name, 'Meena');
    });
  });

  group('influencerFacingName', () {
    test('the saved name wins; otherwise the first name', () {
      expect(influencerFacingName('Asha R.', 'Asha'), 'Asha R.');
      expect(influencerFacingName(null, '  Asha  '), 'Asha');
      expect(influencerFacingName('  ', 'Asha'), 'Asha');
    });
    test('nothing at all gives an empty line', () {
      expect(influencerFacingName(null, null), '');
      expect(influencerFacingName('', ' '), '');
    });
  });

  group('CloseState parsing [HF-APP-PARITY-PROFILE]', () {
    test('reads heldReleaseAt and the payout UTR', () {
      final s = CloseState.fromJson({
        'decision': 'exit',
        'held': 120.5,
        'heldReleaseAt': 1793000000000,
        'exit': {'status': 'waiting_hold'},
        'payout': {'amount': 800, 'status': 'paid', 'utr': ' 412345678901 '},
        'refund': {'amount': 10, 'status': 'refunded', 'utr': null},
      });
      expect(s.heldReleaseAt, 1793000000000);
      expect(s.payout!.utr, '412345678901');
      expect(s.refund!.utr, isNull);
      expect(s.closureActive, isTrue);
    });
    test('without the field it is null and nothing else changes', () {
      final s = CloseState.fromJson({'decision': 'delete'});
      expect(s.heldReleaseAt, isNull);
      expect(s.payout, isNull);
      expect(s.mustSettleFirst, isFalse);
    });
  });

  group('ProfileData and SettingsRepo', () {
    test('profile() reads names, handle and the influencer-facing name', () async {
      final api = FakeApiClient((m, p, b) => {'ok': true, 'firstName': 'Asha', 'lastName': 'Rao', 'username': 'asha', 'displayName': 'Asha R.'});
      final d = await SettingsRepo(api).profile();
      expect(api.calls, ['GET /api/hf/me/profile']);
      expect([d.firstName, d.lastName, d.handle, d.displayName], ['Asha', 'Rao', 'asha', 'Asha R.']);
    });
    test('saveProfileNames PUTs only the two names, trimmed', () async {
      final api = FakeApiClient((m, p, b) => {'ok': true, 'firstName': 'Asha', 'lastName': 'Rao', 'username': 'asha'});
      await SettingsRepo(api).saveProfileNames(firstName: ' Asha ', lastName: 'Rao ');
      expect(api.calls, ['PUT /api/hf/me/profile']);
      expect(api.bodies.single, {'firstName': 'Asha', 'lastName': 'Rao'});
    });
  });

  group('PolicyUpdate parsing', () {
    test('required with items blocks; the note and versions are kept', () {
      final u = PolicyUpdate.fromJson(_pendingJson());
      expect(u.blocks, isTrue);
      expect(u.pending.map((e) => e.policy), ['terms', 'privacy']);
      expect(u.pending.first.version, 'sha256:terms');
      expect(u.pending.first.title, 'Terms of use');
      expect(u.note, contains('withdrawals'));
    });
    test('not required, or nothing pending, never blocks', () {
      expect(PolicyUpdate.fromJson(_pendingJson(required: false)).blocks, isFalse);
      expect(PolicyUpdate.fromJson({'required': true, 'pending': []}).blocks, isFalse);
      expect(PolicyUpdate.fromJson({}).blocks, isFalse);
      expect(PolicyUpdate.fromJson({'required': true, 'pending': [{'policy': 'terms'}]}).blocks, isFalse); // no version: ignored
    });
  });

  group('PolicyGateController', () {
    test('signed out: never asks, never blocks', () async {
      final api = FakeApiClient((m, p, b) => _pendingJson());
      final c = PolicyGateController(PolicyRepo(api));
      await c.check(null);
      expect(api.calls, isEmpty);
      expect(c.blocked, isFalse);
    });

    test('signed in with an update pending: blocks, and asks only once per account', () async {
      final api = FakeApiClient((m, p, b) => _pendingJson());
      final c = PolicyGateController(PolicyRepo(api));
      await c.check('u1');
      await c.check('u1');
      await c.check('u1');
      expect(c.blocked, isTrue);
      expect(api.calls, ['GET /api/hf/me/policy-update']);
    });

    test('signed in with nothing pending: does not block', () async {
      final api = FakeApiClient((m, p, b) => _pendingJson(required: false, policies: const []));
      final c = PolicyGateController(PolicyRepo(api));
      await c.check('u1');
      expect(c.blocked, isFalse);
    });

    test('a failed check never blocks and does not loop', () async {
      final api = FakeApiClient((m, p, b) => const ApiException(kind: ApiFailure.offline, code: 'network'));
      final c = PolicyGateController(PolicyRepo(api));
      await c.check('u1');
      await c.check('u1');
      expect(c.blocked, isFalse);
      expect(api.calls.length, 1);
    });

    test('I agree posts the exact versions shown and unblocks', () async {
      final api = FakeApiClient((m, p, b) => m == 'POST' ? {'ok': true, 'required': false} : _pendingJson());
      final c = PolicyGateController(PolicyRepo(api));
      await c.check('u1');
      await c.accept();
      expect(api.calls, ['GET /api/hf/me/policy-update', 'POST /api/hf/me/policy-update']);
      expect(api.bodies.last, {
        'acceptedPolicyVersions': {'terms': 'sha256:terms', 'privacy': 'sha256:privacy'},
      });
      expect(c.blocked, isFalse);
      expect(c.error, isNull);
    });

    test('an error on agree keeps the prompt, shows the message, and retry works', () async {
      var fail = true;
      final api = FakeApiClient((m, p, b) {
        if (m == 'POST') {
          return fail ? const ApiException(kind: ApiFailure.http, status: 503, code: 'http_503', message: 'Please try again.') : {'ok': true};
        }
        return _pendingJson();
      });
      final c = PolicyGateController(PolicyRepo(api));
      await c.check('u1');
      await c.accept();
      expect(c.blocked, isTrue);
      expect(c.error, 'Please try again.');
      expect(c.accepting, isFalse);
      fail = false;
      await c.accept();
      expect(c.blocked, isFalse);
      expect(c.error, isNull);
    });

    test('a double tap posts once', () async {
      final api = FakeApiClient((m, p, b) => m == 'POST' ? {'ok': true} : _pendingJson());
      final c = PolicyGateController(PolicyRepo(api));
      await c.check('u1');
      final a = c.accept();
      final b = c.accept();
      await Future.wait([a, b]);
      expect(api.calls.where((x) => x.startsWith('POST')).length, 1);
    });

    test('signing out clears the prompt; the next account is asked afresh', () async {
      final api = FakeApiClient((m, p, b) => _pendingJson());
      final c = PolicyGateController(PolicyRepo(api));
      await c.check('u1');
      expect(c.blocked, isTrue);
      await c.check(null);
      expect(c.blocked, isFalse);
      await c.check('u2');
      expect(c.blocked, isTrue);
      expect(api.calls.length, 2);
    });

    test('pins that moved (409) are re-read so the next tap accepts the new ones', () async {
      var version = 'sha256:old';
      final api = FakeApiClient((m, p, b) {
        if (m == 'POST') {
          return const ApiException(kind: ApiFailure.http, status: 409, code: 'policy_versions_required', message: 'The agreements changed.');
        }
        return {
          'required': true,
          'pending': [
            {'policy': 'terms', 'path': '/terms', 'version': version},
          ],
        };
      });
      final c = PolicyGateController(PolicyRepo(api));
      await c.check('u1');
      version = 'sha256:new';
      await c.accept();
      expect(c.blocked, isTrue);
      expect(c.pending!.pending.single.version, 'sha256:new');
      expect(c.error, 'The agreements changed.');
    });
  });
}

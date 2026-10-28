import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/repos/call_safety_repo.dart';

/// [HF-CALL-SAFETY-APP] The safety contract: GET /api/hf/safety/me, the appeal, the rules acceptance and the post-call report.
class _FakeApi extends ApiClient {
  _FakeApi(this.handler) : super(origin: 'https://api.test');

  Object? Function(String method, String path, Object? body) handler;
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

void main() {
  group('SafetyMe', () {
    test('reads the contract shape', () {
      final me = SafetyMe.fromJson({
        'status': 'active',
        'activeStrikes': 1,
        'strikesToPause': 3,
        'reviewDueAt': null,
        'heldPaise': 0,
        'rulesAccepted': true,
        'rulesVersion': 2,
        'recordingEnabled': true,
        'strikes': [
          {
            'id': 's1',
            'reason': 'selling',
            'reasonText': 'Selling on a call',
            'callAt': 1790000000000,
            'quote': 'buy it from me',
            'expiresAt': 1797000000000,
            'removedAt': null,
            'removedWhy': null,
            'appealStatus': null,
            'canAppeal': true,
          },
        ],
      });
      expect(me.isPaused, false);
      expect(me.activeStrikes, 1);
      expect(me.rulesVersion, 2);
      expect(me.strikes.single.canAppeal, true);
      expect(me.strikes.single.quote, 'buy it from me');
      expect(me.strikes.single.removed, false);
    });

    test('is forgiving about missing and odd fields', () {
      final me = SafetyMe.fromJson({'status': 'weird', 'strikesToPause': 0, 'strikes': 'nope'});
      expect(me.status, 'active');
      expect(me.strikesToPause, 3);
      expect(me.strikes, isEmpty);
      expect(me.rulesAccepted, false);
    });

    test('paused and banned are told apart', () {
      expect(SafetyMe.fromJson({'status': 'paused'}).isPaused, true);
      expect(SafetyMe.fromJson({'status': 'banned'}).isBanned, true);
    });

    test('seconds are lifted to milliseconds and zero is nothing', () {
      expect(safetyMs(1790000000), 1790000000000);
      expect(safetyMs(1790000000000), 1790000000000);
      expect(safetyMs(0), isNull);
      expect(safetyMs(null), isNull);
    });
  });

  group('SafetyStrike', () {
    test('a missing reasonText falls back to the plain title', () {
      final s = SafetyStrike.fromJson({'id': 'a', 'reason': 'outside_payment'});
      expect(s.reasonText, kStrikeReasonTitles['outside_payment']);
    });

    test('removed and expired strikes do not count', () {
      const now = 1000000000000;
      final live = SafetyStrike.fromJson({'id': 'a', 'reason': 'abuse', 'expiresAt': now + 5000});
      final gone = SafetyStrike.fromJson({'id': 'b', 'reason': 'abuse', 'expiresAt': now + 5000, 'removedAt': now - 1});
      final old = SafetyStrike.fromJson({'id': 'c', 'reason': 'abuse', 'expiresAt': now - 1});
      expect(live.isActiveAt(now), true);
      expect(gone.isActiveAt(now), false);
      expect(old.isActiveAt(now), false);
    });
  });

  group('CallSafetyRepo', () {
    test('me() calls GET /api/hf/safety/me', () async {
      final api = _FakeApi((m, p, b) => {'status': 'active', 'activeStrikes': 2});
      final me = await CallSafetyRepo(api).me();
      expect(api.calls, ['GET /api/hf/safety/me']);
      expect(me.activeStrikes, 2);
    });

    test('appeal() posts the trimmed message to the strike', () async {
      final api = _FakeApi((m, p, b) => {'ok': true, 'appealStatus': 'open'});
      await CallSafetyRepo(api).appeal('s 1', '  it was a joke  ');
      expect(api.calls, ['POST /api/hf/safety/strikes/s%201/appeal']);
      expect(api.bodies.single, {'message': 'it was a joke'});
    });

    test('appeal() surfaces a second appeal as an ApiException', () async {
      final api = _FakeApi((m, p, b) => const ApiException(kind: ApiFailure.http, status: 409, code: 'already_appealed'));
      await expectLater(CallSafetyRepo(api).appeal('s1', 'again'), throwsA(isA<ApiException>()));
    });

    test('acceptRules() posts the version', () async {
      final api = _FakeApi((m, p, b) => {'ok': true});
      await CallSafetyRepo(api).acceptRules(3);
      expect(api.calls, ['POST /api/hf/safety/rules/accept']);
      expect(api.bodies.single, {'version': 3});
    });

    test('reportCall() posts the reasons and only a non-empty note', () async {
      final api = _FakeApi((m, p, b) => {'ok': true});
      await CallSafetyRepo(api).reportCall('c1', ['selling', 'asked_number']);
      await CallSafetyRepo(api).reportCall('c2', ['abusive'], note: '  shouted at me ');
      expect(api.calls, ['POST /api/hf/calls/c1/report', 'POST /api/hf/calls/c2/report']);
      expect(api.bodies[0], {'reasons': ['selling', 'asked_number']});
      expect(api.bodies[1], {'reasons': ['abusive'], 'note': 'shouted at me'});
    });

    test('the post-call reasons are the four the server accepts', () {
      expect(kCallReportReasons.map((r) => r.key), ['selling', 'outside_payment', 'asked_number', 'abusive']);
    });
  });
}

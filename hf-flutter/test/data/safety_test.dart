import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/repos/safety_repo.dart';

/// [HF-APP-PARITY-SAFETY] Report a person, block / unblock and the hearts / waiting counts, against the worker contract in
/// worker/src/routes/hf_reports.ts and hf_dash_v3.ts / hf_dash_summary.ts.
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
  group('reasons', () {
    test('are the four the worker accepts for a block', () {
      expect(reportReasons.map((r) => r.key), ['rude', 'money_or_otp', 'inappropriate', 'other']);
      for (final r in reportReasons) {
        expect(r.label.length, greaterThan(5));
      }
    });

    test('details start with the reason and always pass the 10-character minimum', () {
      for (final r in reportReasons) {
        expect(reportDetails(r, '').length, greaterThanOrEqualTo(10));
      }
      expect(reportDetails(reportReasons.first, '  he shouted  '), 'Reason: Rude or abusive\nhe shouted');
    });
  });

  group('models', () {
    test('receipt reads the reference and quotes it', () {
      final r = ReportReceipt.fromJson({'ok': true, 'id': 'HF-R-1A2B3C4D'});
      expect(r.id, 'HF-R-1A2B3C4D');
      expect(r.message, contains('Report received. Reference HF-R-1A2B3C4D.'));
    });

    test('receipt without an id still says it was received', () {
      expect(ReportReceipt.fromJson({'ok': true}).message, startsWith('Report received.'));
    });

    test('blocked person tolerates missing fields', () {
      final b = BlockedPerson.fromJson({'key': 'abc', 'slug': 'maya'});
      expect(b.name, 'Someone');
      expect(b.slug, 'maya');
    });

    test('counts read hearts and waiting, and null for a fan', () {
      final c = FraandsCounts.fromJson({'fraands': {'saved': 3, 'hearts': 12, 'waiting': 4}});
      expect(c.hearts, 12);
      expect(c.waiting, 4);
      final fan = FraandsCounts.fromJson({'fraands': {'saved': 3, 'hearts': null, 'waiting': null}});
      expect(fan.hearts, isNull);
      expect(fan.waiting, isNull);
      expect(FraandsCounts.fromJson({'ok': true}).hearts, isNull);
    });
  });

  group('SafetyRepo', () {
    test('report posts the four fields the worker needs', () async {
      final api = _FakeApi((m, p, b) => {'ok': true, 'id': 'HF-R-00000001'});
      final r = await SafetyRepo(api).report(contact: ' a@b.in ', profile: 'Maya', call: 'call_abc12345', reason: reportReasons[1], note: 'asked for an OTP');
      expect(r.id, 'HF-R-00000001');
      expect(api.calls.single, 'POST /api/hf/reports');
      final body = api.bodies.single as Map;
      expect(body['contact'], 'a@b.in');
      expect(body['profile'], 'Maya');
      expect(body['call'], 'call_abc12345');
      expect(body['details'], 'Reason: Asked me for money or an OTP\nasked for an OTP');
    });

    test('a report from a profile names no call', () async {
      final api = _FakeApi((m, p, b) => {'ok': true, 'id': 'HF-R-00000002'});
      await SafetyRepo(api).report(contact: 'a@b.in', profile: 'Maya', call: '', reason: reportReasons.last);
      expect((api.bodies.single as Map)['call'], reportNoCall);
    });

    test('a long note is cut to the note limit', () async {
      final api = _FakeApi((m, p, b) => {'ok': true, 'id': 'x'});
      await SafetyRepo(api).report(contact: 'a@b.in', profile: 'Maya', call: 'c1', reason: reportReasons.last, note: 'a' * 900);
      final details = (api.bodies.single as Map)['details'] as String;
      expect(details.length, lessThanOrEqualTo('Reason: Something else\n'.length + reportNoteMax));
    });

    test('a server refusal reaches the caller with its own words', () async {
      final api = _FakeApi((m, p, b) => ApiException(kind: ApiFailure.http, status: 400, code: 'invalid_field', message: 'Please add the call ID.'));
      await expectLater(
        SafetyRepo(api).report(contact: 'a@b.in', profile: 'Maya', call: 'c1', reason: reportReasons.last),
        throwsA(isA<ApiException>().having((e) => e.userMessage, 'userMessage', 'Please add the call ID.')),
      );
    });

    test('block posts the reason to the call', () async {
      final api = _FakeApi((m, p, b) => {'ok': true});
      await SafetyRepo(api).block('call_abc12345', reason: 'rude');
      expect(api.calls.single, 'POST /api/hf/calls/call_abc12345/block');
      expect((api.bodies.single as Map)['reason'], 'rude');
    });

    test('blocks list and unblock', () async {
      final api = _FakeApi((m, p, b) => m == 'GET'
          ? {'ok': true, 'items': [{'key': 'k1', 'name': 'Maya', 'slug': 'maya', 'at': 1}]}
          : {'ok': true});
      final repo = SafetyRepo(api);
      final list = await repo.blocks();
      expect(list.single.name, 'Maya');
      await repo.unblock(list.single.key);
      expect(api.calls, ['GET /api/hf/blocks', 'DELETE /api/hf/blocks/k1']);
    });

    test('fraandsCounts reads the summary', () async {
      final api = _FakeApi((m, p, b) => {'ok': true, 'role': 'host', 'fraands': {'saved': 0, 'hearts': 7, 'waiting': 2}});
      final c = await SafetyRepo(api).fraandsCounts();
      expect(api.calls.single, 'GET /api/hf/me/summary');
      expect(c.hearts, 7);
      expect(c.waiting, 2);
    });
  });
}

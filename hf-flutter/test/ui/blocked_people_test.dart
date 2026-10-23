import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/repos/safety_repo.dart';
import 'package:hf_app/demo/screens/blocked_people.dart';

/// [HF-BLOCK-PROFILE-1] The Blocked people screen: list, empty, error with retry, and Unblock after a confirm.
class _FakeApi extends ApiClient {
  _FakeApi(this.handler) : super(origin: 'https://api.test');

  Object? Function(String method, String path, Object? body) handler;
  final List<String> calls = [];

  @override
  Future<Object?> request(String method, String path,
      {Map<String, Object?>? query, Object? body, bool auth = true, Map<String, String>? headers}) async {
    calls.add('$method $path');
    final out = handler(method, path, body);
    if (out is ApiException) throw out;
    return out;
  }
}

Map<String, Object?> _list(List<Map<String, Object?>> items) => {'ok': true, 'items': items};

Future<void> _pump(WidgetTester tester, _FakeApi api) async {
  tester.view.physicalSize = const Size(900, 2200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(home: BlockedPeopleScreen(repo: SafetyRepo(api))));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('lists blocked people with name and handle', (tester) async {
    final api = _FakeApi((m, p, b) => _list([
          {'key': 'k1', 'name': 'Maya', 'slug': 'maya', 'at': 1},
          {'key': 'k2', 'name': 'Ravi', 'slug': null, 'at': 2},
        ]));
    await _pump(tester, api);
    expect(find.text('Maya'), findsOneWidget);
    expect(find.text('@maya'), findsOneWidget);
    expect(find.text('Ravi'), findsOneWidget);
    expect(find.text('Unblock'), findsNWidgets(2));
  });

  testWidgets('empty list says you have not blocked anyone', (tester) async {
    await _pump(tester, _FakeApi((m, p, b) => _list([])));
    expect(find.text('You haven\'t blocked anyone'), findsOneWidget);
  });

  testWidgets('a failed load shows Try again, which loads again', (tester) async {
    var fail = true;
    final api = _FakeApi((m, p, b) => fail
        ? ApiException(kind: ApiFailure.http, status: 500, code: 'internal_error', message: 'Something went wrong.')
        : _list([
            {'key': 'k1', 'name': 'Maya', 'slug': 'maya', 'at': 1},
          ]));
    await _pump(tester, api);
    expect(find.text('Try again'), findsOneWidget);
    fail = false;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('Maya'), findsOneWidget);
  });

  testWidgets('Unblock asks first, then removes the person', (tester) async {
    final api = _FakeApi((m, p, b) => m == 'DELETE'
        ? {'ok': true}
        : _list([
            {'key': 'k1', 'name': 'Maya', 'slug': 'maya', 'at': 1},
          ]));
    await _pump(tester, api);
    await tester.tap(find.text('Unblock'));
    await tester.pumpAndSettle();
    expect(find.text('Unblock Maya?'), findsOneWidget);
    expect(api.calls, ['GET /api/hf/blocks']);
    await tester.tap(find.text('Unblock').last);
    await tester.pumpAndSettle();
    expect(api.calls, ['GET /api/hf/blocks', 'DELETE /api/hf/blocks/k1']);
    expect(find.text('Maya'), findsNothing);
    expect(find.text('You haven\'t blocked anyone'), findsOneWidget);
  });
}

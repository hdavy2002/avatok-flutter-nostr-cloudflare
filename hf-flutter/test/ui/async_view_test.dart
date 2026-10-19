import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/ui/async_view.dart';

Widget _host(AsyncState<List<int>> state, {VoidCallback? onRetry}) => MaterialApp(
      home: Scaffold(
        body: AsyncView<List<int>>(
          state: state,
          onRetry: onRetry,
          emptyTitle: 'No reels yet',
          emptyMessage: 'Check back soon.',
          builder: (_, v) => Text('items: ${v.length}'),
        ),
      ),
    );

void main() {
  testWidgets('loading shows a spinner', (tester) async {
    await tester.pumpWidget(_host(AsyncLoading<List<int>>()));
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });

  testWidgets('content shows the builder', (tester) async {
    await tester.pumpWidget(_host(const AsyncData<List<int>>([1, 2, 3])));
    expect(find.text('items: 3'), findsOneWidget);
  });

  testWidgets('empty shows the empty panel', (tester) async {
    await tester.pumpWidget(_host(const AsyncData<List<int>>([])));
    expect(find.text('No reels yet'), findsOneWidget);
    expect(find.text('Check back soon.'), findsOneWidget);
    expect(find.textContaining('items:'), findsNothing);
  });

  testWidgets('offline error shows the exact text and Try again works', (tester) async {
    var taps = 0;
    await tester.pumpWidget(_host(AsyncFailure<List<int>>(ApiException.offline()), onRetry: () => taps++));
    expect(find.text('No internet. Check your connection.'), findsOneWidget);
    await tester.tap(find.text('Try again'));
    expect(taps, 1);
  });

  testWidgets('server error shows its message, other errors the generic one', (tester) async {
    await tester.pumpWidget(_host(AsyncFailure<List<int>>(ApiException.fromResponse(500, '{"error":"x","message":"Kitchen is on fire."}')), onRetry: () {}));
    expect(find.text('Kitchen is on fire.'), findsOneWidget);
    await tester.pumpWidget(_host(AsyncFailure<List<int>>(StateError('boom')), onRetry: () {}));
    expect(find.text('Something went wrong. Please try again.'), findsOneWidget);
  });

  testWidgets('no Try again button without onRetry', (tester) async {
    await tester.pumpWidget(_host(AsyncFailure<List<int>>(ApiException.offline())));
    expect(find.text('Try again'), findsNothing);
  });

  testWidgets('AsyncLoader goes loading -> content, and failure -> retry -> content', (tester) async {
    var calls = 0;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: AsyncLoader<List<int>>(
          load: () async {
            calls++;
            if (calls == 1) throw ApiException.offline();
            return [1, 2];
          },
          builder: (_, v) => Text('items: ${v.length}'),
        ),
      ),
    ));
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    await tester.pumpAndSettle();
    expect(find.text('No internet. Check your connection.'), findsOneWidget);
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('items: 2'), findsOneWidget);
  });
}

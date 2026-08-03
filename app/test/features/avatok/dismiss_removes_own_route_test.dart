/// [CALL-DISMISS-SELF-1 2026-08-03] Regression test for the build-10499 outage.
///
/// A ring screen that dismisses itself AFTER something else has been pushed on
/// top of it must remove ITSELF, not whatever is currently topmost.
///
/// What happened: [CALL-ACCEPT-GAP-1] moved the accept dismissal to after the
/// CallScreen push (so there is no blank gap between the two screens), while
/// `_dismiss` still called `Navigator.of(context).pop()`. Pop is a STACK
/// operation — it removed the CallScreen that had just been pushed. Prod call
/// avatok-47c9070a: `call_accept_screen_opened` 15:43:57.418,
/// `business_call_screen_dismissed` 15:43:57.419. The call screen was destroyed
/// before its first build, the ring screen stayed up frozen, and the caller
/// dropped 15.7 s later having never connected.
///
/// The two tests below are deliberately behavioural rather than string matches
/// on the source: the previous contract test for this area asserted code SHAPE
/// and consequently could not see a real defect (it passed for a version of the
/// accept path that did nothing at all). This pumps a real Navigator.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// Mirrors the exact removal logic in
/// `incoming_business_call_screen.dart _dismiss()`.
void dismissSelf(BuildContext context) {
  final nav = Navigator.of(context);
  final route = ModalRoute.of(context);
  if (route == null || !route.isActive) return;
  if (route.isCurrent) {
    nav.pop();
  } else {
    nav.removeRoute(route);
  }
}

class _Ring extends StatelessWidget {
  const _Ring();
  @override
  Widget build(BuildContext context) => const Scaffold(body: Text('RING'));
}

class _Call extends StatelessWidget {
  const _Call();
  @override
  Widget build(BuildContext context) => const Scaffold(body: Text('CALL'));
}

void main() {
  testWidgets(
      'dismissing while buried removes the ring screen and LEAVES the call screen',
      (tester) async {
    final navKey = GlobalKey<NavigatorState>();
    await tester.pumpWidget(MaterialApp(
      navigatorKey: navKey,
      home: const Scaffold(body: Text('HOME')),
    ));

    // The ring arrives.
    late BuildContext ringContext;
    navKey.currentState!.push(MaterialPageRoute(builder: (c) {
      ringContext = c;
      return const _Ring();
    }));
    await tester.pumpAndSettle();
    expect(find.text('RING'), findsOneWidget);

    // Accept: the call screen is pushed ON TOP, and only then does the ring
    // screen dismiss itself — the ordering that caused the outage.
    navKey.currentState!.push(MaterialPageRoute(builder: (_) => const _Call()));
    await tester.pumpAndSettle();

    dismissSelf(ringContext);
    await tester.pumpAndSettle();

    // THE REGRESSION: with `pop()` this found nothing — the call screen was
    // removed and the ring screen survived, which is exactly backwards.
    expect(find.text('CALL'), findsOneWidget,
        reason: 'the call screen must survive the ring screen dismissing itself');
    expect(find.text('RING'), findsNothing,
        reason: 'the ring screen must actually be gone, not merely covered');

    // And the call screen must be genuinely on top — popping it returns HOME,
    // proving the ring route is off the stack rather than hiding beneath it.
    navKey.currentState!.pop();
    await tester.pumpAndSettle();
    expect(find.text('HOME'), findsOneWidget);
  });

  testWidgets('dismissing while on top still closes normally', (tester) async {
    final navKey = GlobalKey<NavigatorState>();
    await tester.pumpWidget(MaterialApp(
      navigatorKey: navKey,
      home: const Scaffold(body: Text('HOME')),
    ));

    late BuildContext ringContext;
    navKey.currentState!.push(MaterialPageRoute(builder: (c) {
      ringContext = c;
      return const _Ring();
    }));
    await tester.pumpAndSettle();

    // Decline / timeout / caller-cancel: nothing was pushed on top, so this is
    // the ordinary case and must behave exactly as it always did.
    dismissSelf(ringContext);
    await tester.pumpAndSettle();

    expect(find.text('RING'), findsNothing);
    expect(find.text('HOME'), findsOneWidget);
  });
}

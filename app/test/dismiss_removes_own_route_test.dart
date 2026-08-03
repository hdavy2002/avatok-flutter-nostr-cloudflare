// [CALL-ACCEPT-FLASH-1] Pins the "accept flash" fix's route-removal contract:
// when the branded incoming-ring route (`IncomingBusinessCallScreen`) is
// dismissed WHILE a route has already been pushed on top of it (CallScreen,
// via `PushService.acceptRingingCall`), it must NOT be torn out of the
// Navigator immediately — that used to remove it un-animated on the very
// next frame after the covering route was pushed, while that route's own
// ~300ms ZoomPageTransition was still mid-flight, which showed as a visible
// flash of whatever the Navigator painted underneath in the gap. It must
// wait for the covering route's entrance transition to actually finish.
//
// This exercises `deferredRemoveRoute` — extracted to a top-level function in
// `incoming_business_call_screen.dart` specifically so this contract is
// testable with a minimal Navigator and two placeholder routes, without
// dragging in the plugin-backed real screens (`IncomingBusinessCallScreen`
// itself needs PushService/flutter_callkit_incoming; the real covering route
// is `CallScreen`, which needs the webrtc stack) that a plain widget test
// can't safely mount.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:avatok_call/features/avatok/incoming_business_call_screen.dart'
    show deferredRemoveRoute;

class _RingPlaceholder extends StatelessWidget {
  const _RingPlaceholder();
  @override
  Widget build(BuildContext context) =>
      const Scaffold(body: Center(child: Text('ring')));
}

class _CallScreenPlaceholder extends StatelessWidget {
  const _CallScreenPlaceholder();
  @override
  Widget build(BuildContext context) =>
      const Scaffold(body: Center(child: Text('call')));
}

void main() {
  testWidgets(
      'deferredRemoveRoute does NOT remove the ring route 1ms after the '
      'covering route (CallScreen) was pushed — it must survive the '
      'mid-transition window that used to flash', (tester) async {
    final navKey = GlobalKey<NavigatorState>();
    await tester.pumpWidget(MaterialApp(
      navigatorKey: navKey,
      home: const _RingPlaceholder(),
    ));
    await tester.pump();
    expect(find.byType(_RingPlaceholder), findsOneWidget);

    // Capture the ring route the same way `_dismiss` does via
    // `ModalRoute.of(context)` — while it is still the current route.
    final ringRoute = ModalRoute.of<dynamic>(
      tester.element(find.byType(_RingPlaceholder)),
    )!;

    // Push CallScreen's stand-in on top, exactly like
    // `PushService.acceptRingingCall` -> `_openCall` does while the ring
    // route is held open underneath.
    navKey.currentState!.push(MaterialPageRoute<void>(
      builder: (_) => const _CallScreenPlaceholder(),
    ));
    await tester.pump(); // one frame — the push transition has now started

    var removed = false;
    // This is what `_dismiss` calls the instant CallScreen has been
    // requested — well before CallScreen's own entrance transition (~300ms)
    // has had any chance to finish.
    deferredRemoveRoute(
      navKey.currentState!,
      ringRoute,
      isRemoved: () => removed,
      markRemoved: () => removed = true,
    );

    // 1ms later. The old (buggy) behaviour called `nav.removeRoute` on this
    // exact next-frame timescale.
    await tester.pump(const Duration(milliseconds: 1));

    expect(removed, isFalse,
        reason: 'must not remove the ring route mid-transition');
    expect(find.byType(_RingPlaceholder), findsOneWidget,
        reason: 'the ring route must still be mounted at 1ms — this is the '
            'exact window that used to flash whatever was underneath it');
    expect(find.byType(_CallScreenPlaceholder), findsOneWidget,
        reason: 'CallScreen (the covering route) must remain mounted too');

    // Let the covering route's push transition — and the bounded 400ms
    // fallback in `deferredRemoveRoute`, whichever fires first — settle.
    await tester.pump(const Duration(milliseconds: 500));

    expect(removed, isTrue,
        reason: 'the ring route must be removed once the covering route has '
            'finished animating in (or the bounded fallback elapses)');
    expect(find.byType(_RingPlaceholder), findsNothing,
        reason: 'the ring route must now be gone from the tree');
    expect(find.byType(_CallScreenPlaceholder), findsOneWidget,
        reason: 'CallScreen must be the only thing left on screen');
  });

  testWidgets(
      'deferredRemoveRoute is bounded — it still removes the route even if '
      'no covering route was ever pushed on top of it (defensive: the '
      'animation listener has nothing to wait on)', (tester) async {
    final navKey = GlobalKey<NavigatorState>();
    // In production the ring route always sits above a base route (the shell
    // home); a Navigator may never end up with an empty history, so the test
    // must model that too.
    await tester.pumpWidget(MaterialApp(
      navigatorKey: navKey,
      home: const Scaffold(body: Center(child: Text('base'))),
    ));
    await tester.pump();
    navKey.currentState!.push(MaterialPageRoute<void>(
      builder: (_) => const _RingPlaceholder(),
    ));
    await tester.pumpAndSettle();

    final ringRoute = ModalRoute.of<dynamic>(
      tester.element(find.byType(_RingPlaceholder)),
    )!;

    var removed = false;
    deferredRemoveRoute(
      navKey.currentState!,
      ringRoute,
      isRemoved: () => removed,
      markRemoved: () => removed = true,
      // A short bound so the test doesn't need to wait 400ms for a case
      // that isn't exercising the real transition-timing path anyway.
      timeout: const Duration(milliseconds: 20),
    );

    await tester.pump(const Duration(milliseconds: 5));
    expect(removed, isFalse);

    await tester.pump(const Duration(milliseconds: 30));
    expect(removed, isTrue,
        reason: 'the bounded fallback must fire and remove the route even '
            'with nothing above it to animate against');
  });

  testWidgets(
      'deferredRemoveRoute never double-removes when called twice for the '
      'same route (mirrors a local tap and a server transition landing '
      'back-to-back)', (tester) async {
    final navKey = GlobalKey<NavigatorState>();
    await tester.pumpWidget(MaterialApp(
      navigatorKey: navKey,
      home: const _RingPlaceholder(),
    ));
    await tester.pump();
    final ringRoute = ModalRoute.of<dynamic>(
      tester.element(find.byType(_RingPlaceholder)),
    )!;
    navKey.currentState!.push(MaterialPageRoute<void>(
      builder: (_) => const _CallScreenPlaceholder(),
    ));
    await tester.pump();

    var removed = false;
    var removeErrors = 0;
    void onError(Object e, StackTrace st) => removeErrors++;

    deferredRemoveRoute(
      navKey.currentState!,
      ringRoute,
      isRemoved: () => removed,
      markRemoved: () => removed = true,
      onRemoveError: onError,
    );
    // A second dismissal racing the first (e.g. the server's terminal
    // broadcast landing right after this screen's own Accept already
    // claimed teardown) must be a safe no-op, not a crash or a duplicate
    // `removeRoute` call on an already-removed route.
    deferredRemoveRoute(
      navKey.currentState!,
      ringRoute,
      isRemoved: () => removed,
      markRemoved: () => removed = true,
      onRemoveError: onError,
    );

    await tester.pump(const Duration(milliseconds: 500));

    expect(removed, isTrue);
    expect(removeErrors, 0,
        reason: 'the guarded double-removal must never surface as an error');
    expect(find.byType(_RingPlaceholder), findsNothing);
    expect(find.byType(_CallScreenPlaceholder), findsOneWidget);
  });
}

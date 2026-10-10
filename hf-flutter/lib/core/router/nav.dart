import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../auth/session.dart';
import 'routes.dart';

/// Back: pop when there is something to pop, else go Home. Screens opened by a deep link (`go`) have
/// no history, and a plain `pop()` there would do nothing.
void popOrHome(BuildContext context) {
  final router = GoRouter.of(context);
  if (router.canPop()) {
    router.pop();
  } else {
    router.go(Routes.home);
  }
}

/// The AppBar back arrow for a screen that may have been opened without history.
class HfBackButton extends StatelessWidget {
  const HfBackButton({super.key});

  @override
  Widget build(BuildContext context) => IconButton(
        tooltip: 'Back',
        icon: const Icon(Icons.arrow_back_rounded),
        onPressed: () => popOrHome(context),
      );
}

/// Browse-before-sign-in gate (owner decision). Home, Explore and host profiles open without an account;
/// sign-in is asked only at Call, Notify me, Wallet, Become a host and the lanes.
///
/// ```dart
/// onPressed: () async {
///   if (!await requireSignIn(context, ref)) return;   // opens sign-in, comes back here after
///   startTheCall();
/// }
/// ```
/// Returns true when the person is (now) signed in. Otherwise it opens `/sign-in?next=<where you are>`
/// and returns false once the sign-in screen is closed without signing in. After a successful sign-in the
/// sign-in screen sends the person back to `next` and this returns true.
Future<bool> requireSignIn(BuildContext context, WidgetRef ref, {String? next}) async {
  if (ref.read(sessionProvider).isSignedIn) return true;
  final router = GoRouter.of(context);
  final where = next ?? router.routeInformationProvider.value.uri.toString();
  final result = await router.push<bool>(Routes.signInTo(where));
  return result == true && ref.read(sessionProvider).isSignedIn;
}

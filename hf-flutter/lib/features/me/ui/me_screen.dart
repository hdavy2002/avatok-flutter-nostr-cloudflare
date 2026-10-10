import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/auth/session.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';

/// Tab 4. Built in HF-NATIVE-12 (profile, language, notifications, legal, help, delete). This stub already
/// shows the session so the sign-in plumbing can be checked on a phone.
class MeScreen extends ConsumerWidget {
  const MeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    return StubScreen(
      title: 'Me',
      issue: 'HF-NATIVE-12',
      details: {
        'session': session.status.name,
        if (session.me?.displayName != null) 'name': session.me!.displayName!,
        'build': '${Analytics.appVersion}+${Analytics.appBuild}',
      },
      children: [
        if (session.isSignedIn) ...[
          HfButton(
            label: 'Sign out',
            kind: HfButtonKind.secondary,
            onPressed: () => ref.read(sessionProvider.notifier).signOut(),
          ),
          HfButton(
            label: 'Delete my account',
            kind: HfButtonKind.text,
            onPressed: () => context.push(Routes.meDelete),
          ),
        ] else
          HfButton(
            label: 'Sign in',
            onPressed: () => requireSignIn(context, ref, next: Routes.me),
          ),
      ],
    );
  }
}

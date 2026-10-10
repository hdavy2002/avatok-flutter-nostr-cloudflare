import 'package:flutter/material.dart';

import '../../../core/widgets/widgets.dart';

/// `/sign-in?next=` . Built in HF-NATIVE-2 (phone number, WhatsApp code, `signInWithTicket`).
/// On success: `context.pop(true)` when opened by `requireSignIn`, else `context.go(next ?? Routes.home)`.
class SignInScreen extends StatelessWidget {
  const SignInScreen({super.key, this.next});

  final String? next;

  @override
  Widget build(BuildContext context) => StubScreen(
        title: 'Sign in',
        issue: 'HF-NATIVE-2',
        showBack: true,
        details: {if (next != null) 'next': next!},
      );
}

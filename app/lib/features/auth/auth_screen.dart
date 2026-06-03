import 'package:clerk_flutter/clerk_flutter.dart';
import 'package:flutter/material.dart';

import '../../core/logo.dart';
import '../../core/theme.dart';

/// Signed-out screen: AvaTOK branding + Clerk's sign-in / sign-up UI.
class AuthScreen extends StatelessWidget {
  const AuthScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        child: Column(
          children: [
            const SizedBox(height: 28),
            const AvaLogo(size: 48),
            const SizedBox(height: 14),
            Text('AvaTOK', style: AvaTheme.wordmark(26)),
            const SizedBox(height: 2),
            const Text('Sign in to your account',
                style: TextStyle(color: AvaColors.sub, fontSize: 13)),
            const SizedBox(height: 8),
            const Expanded(
              child: Padding(
                padding: EdgeInsets.symmetric(horizontal: 12),
                child: ClerkErrorListener(child: ClerkAuthentication()),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

import 'package:flutter/material.dart';

import '../../core/account_restore.dart';
import '../../core/logo.dart';
import '../../core/theme.dart';

/// Shown ONLY when the server couldn't be reached while checking the signed-in
/// account (RestoreOutcome.unavailable). Signing in is the account credential —
/// there is no password/key recovery step anymore (Cloudflare-native pivot):
/// when the server is reachable, a returning user's device is set up
/// automatically and this screen is never seen.
/// It deliberately offers NO "claim a new handle" path, so an existing user can
/// never accidentally create a second account and think their data is lost.
class RestoreScreen extends StatelessWidget {
  final RestoreState state;
  final VoidCallback onRestored; // kept for call-site compatibility (unused)
  final VoidCallback onRetry;    // re-run the account check
  final VoidCallback onSignOut;  // bail out to welcome
  const RestoreScreen({
    super.key,
    required this.state,
    required this.onRestored,
    required this.onRetry,
    required this.onSignOut,
  });

  @override
  Widget build(BuildContext context) {
    final name = (state.displayName ?? '').trim();
    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(28, 40, 28, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 24),
              const AvaLogo(size: 52),
              const SizedBox(height: 22),
              Text(name.isNotEmpty ? 'One moment, $name' : 'Can’t reach AvaTOK',
                  style: Theme.of(context).textTheme.displayLarge?.copyWith(fontSize: 32)),
              const SizedBox(height: 10),
              const Text(
                  'We couldn’t load your account just now. Check your connection and '
                  'try again — everything on your account comes back automatically '
                  'once we’re connected. We won’t set you up as a new user.',
                  style: TextStyle(color: AvaColors.sub, fontSize: 15, height: 1.5)),
              const SizedBox(height: 28),
              SizedBox(
                width: double.infinity,
                child: FilledButton(onPressed: onRetry, child: const Text('Try again')),
              ),
              const SizedBox(height: 12),
              Center(
                  child: TextButton(
                      onPressed: onSignOut,
                      child: const Text('Sign out', style: TextStyle(color: AvaColors.sub)))),
            ],
          ),
        ),
      ),
    );
  }
}

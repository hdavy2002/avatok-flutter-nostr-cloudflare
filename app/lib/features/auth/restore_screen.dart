import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/account_restore.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

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
      body: ZinePaper(
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 24),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                Text('RECONNECTING', style: ZineText.kicker()),
              ]),
              Expanded(
                child: SingleChildScrollView(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    const SizedBox(height: 30),
                    Center(
                      child: ZineCrest(
                        child: PhosphorIcon(
                            PhosphorIcons.wifiSlash(PhosphorIconsStyle.bold),
                            size: 46, color: Zine.ink),
                      ),
                    ),
                    const SizedBox(height: 14),
                    Text(
                      name.isNotEmpty ? 'One moment,\n$name' : 'Can’t reach\nAvaTOK',
                      style: ZineText.hero(size: 34),
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 14),
                    Center(
                      child: ZineSticker(
                        'connection hiccup',
                        kind: ZineStickerKind.no,
                        icon: PhosphorIcons.plugs(PhosphorIconsStyle.bold),
                      ),
                    ),
                    const SizedBox(height: 18),
                    Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 300),
                        child: Text(
                          'We couldn’t load your account just now. Check your '
                          'connection and try again — everything on your account '
                          'comes back automatically once we’re connected. '
                          'We won’t set you up as a new user.',
                          style: ZineText.sub(),
                          textAlign: TextAlign.center,
                        ),
                      ),
                    ),
                    const SizedBox(height: 22),
                  ]),
                ),
              ),
              ZineButton(
                label: 'Try again',
                icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.bold),
                fullWidth: true,
                fontSize: 21,
                onPressed: onRetry,
              ),
              const SizedBox(height: 18),
              Center(child: ZineLink('sign out', underline: Zine.coral, fontSize: 14, onTap: onSignOut)),
              const SizedBox(height: 16),
              Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                PhosphorIcon(PhosphorIcons.lockKey(PhosphorIconsStyle.fill),
                    size: 14, color: Zine.blueInk),
                const SizedBox(width: 8),
                Flexible(
                  child: Text('your account is safe — nothing is lost',
                      style: ZineText.kicker(), textAlign: TextAlign.center),
                ),
              ]),
            ]),
          ),
        ),
      ),
    );
  }
}

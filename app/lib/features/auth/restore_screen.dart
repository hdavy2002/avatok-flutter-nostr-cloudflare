import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/account_restore.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
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
            padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s3, Msg.s5, Msg.s5),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                Text('Reconnecting', style: ADText.sectionLabel()),
              ]),
              Expanded(
                child: SingleChildScrollView(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    const SizedBox(height: Msg.s6),
                    Center(
                      child: ZineCrest(
                        child: PhosphorIcon(
                            PhosphorIcons.wifiSlash(PhosphorIconsStyle.regular),
                            // The crest disc is a saturated teal fill, so the
                            // glyph on it is white — NOT a dark ink.
                            size: 46, color: Colors.white),
                      ),
                    ),
                    const SizedBox(height: Msg.s4),
                    Text(
                      name.isNotEmpty ? 'One moment,\n$name' : 'Can’t reach\nAvaTOK',
                      style: ADText.appTitle().copyWith(
                          fontSize: 34, height: 1.08, letterSpacing: -0.02 * 34),
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: Msg.s4),
                    Center(
                      child: ZineSticker(
                        'connection hiccup',
                        kind: ZineStickerKind.no,
                        icon: PhosphorIcons.plugs(PhosphorIconsStyle.regular),
                      ),
                    ),
                    const SizedBox(height: Msg.s4),
                    Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 300),
                        child: Text(
                          'We couldn’t load your account just now. Check your '
                          'connection and try again — everything on your account '
                          'comes back automatically once we’re connected. '
                          'We won’t set you up as a new user.',
                          style: ADText.preview().copyWith(fontSize: 15, height: 1.42),
                          textAlign: TextAlign.center,
                        ),
                      ),
                    ),
                    const SizedBox(height: Msg.s5),
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
              const SizedBox(height: Msg.s4),
              Center(child: ZineLink('sign out', underline: AD.danger, fontSize: 14, onTap: onSignOut)),
              const SizedBox(height: Msg.s4),
              Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                PhosphorIcon(PhosphorIcons.lockKey(PhosphorIconsStyle.fill),
                    size: 14, color: AD.iconNeutral),
                const SizedBox(width: Msg.s2),
                Flexible(
                  child: Text('your account is safe — nothing is lost',
                      style: ADText.sectionLabel(), textAlign: TextAlign.center),
                ),
              ]),
            ]),
          ),
        ),
      ),
    );
  }
}

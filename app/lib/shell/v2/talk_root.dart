import 'package:flutter/material.dart';

import '../../auth/clerk_client.dart';
import '../../features/avatok/chat_list.dart';
import '../shell_v2.dart';
import 'shell_destinations.dart';

/// AvaTalk root — the existing messenger, moved in wholesale (plan §5). The
/// current [ChatListScreen] already carries its own footer (Chats · Dialpad ·
/// Groups · Calls) and drawer, so it IS the AvaTalk app surface; ShellV2 only
/// re-wires its cross-app "switch app" callback so menu taps route to the shell.
///
/// - Root-level destinations (Home / AvaDial / Services) switch the shell root
///   (keeping this navigator's stack intact in the IndexedStack).
/// - Everything else (Settings, Wallet, Marketplace, Identity, …) pushes onto
///   THIS root's navigator via [openShellDestination], exactly as the legacy
///   shell pushed apps on top of the messenger.
class TalkRoot extends StatelessWidget {
  final ClerkClient clerk;
  final VoidCallback onSignOut;
  const TalkRoot({super.key, required this.clerk, required this.onSignOut});

  @override
  Widget build(BuildContext context) {
    return ChatListScreen(
      clerk: clerk,
      onSignOut: onSignOut,
      onSwitchApp: (dest) {
        final root = rootIdForDestination(dest);
        if (root != null) {
          ShellScope.of(context).switchRoot(root);
          return;
        }
        openShellDestination(context, dest);
      },
    );
  }
}

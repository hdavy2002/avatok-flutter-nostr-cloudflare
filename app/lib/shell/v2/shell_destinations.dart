import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/app_registry.dart';
import '../../core/remote_config.dart';
import '../../core/ui/zine.dart';
import '../../features/avaapps/avaapps_screen.dart';
import '../../features/identity/identity_screen.dart';
import '../../features/library/avalibrary_screen.dart';
import '../../features/library/avastorage_screen.dart';
import '../../features/marketplace/archived_screen.dart';
import '../../features/marketplace/marketplace_browse.dart';
import '../../features/marketplace/my_listings_screen.dart';
import '../../features/marketplace/sell_listing_flow.dart';
import '../../features/marketplace/compose_chat.dart';
import '../../features/payout/payout_screen.dart';
import '../../features/profile/profile_screen.dart';
import '../../features/settings/about_screen.dart';
import '../../features/settings/settings_screen.dart';
import '../../features/subscribe/subscribe_screen.dart';
import '../../features/wallet/wallet_screen.dart';
import '../coming_soon.dart';
import '../shell_v2.dart';

/// Opens a destination key on the CURRENT root's [Navigator] (the one that owns
/// [context]). Shared by the shell sidebar (Home/AvaDial/Services) and by the
/// AvaTalk root's reused messenger drawer, so a menu tap pushes onto the right
/// app's navigator and the shell's IndexedStack keeps every other root intact.
///
/// This intentionally mirrors the relevant arms of the legacy AvaShell._openDest
/// switch (the screens reachable from the sidebars), but ONLY runs when the
/// shellV2 flag is on. Root-level destinations (home/avadial/avatalk/services)
/// are handled by the caller via ShellScope.switchRoot — they should not reach
/// here.
void openShellDestination(BuildContext context, String dest) {
  Future<void> push(Widget w) =>
      Navigator.of(context).push(MaterialPageRoute(builder: (_) => w));

  final scope = ShellScope.of(context);

  switch (dest) {
    case 'settings':
      push(SettingsScreen(
          clerk: scope.clerk, onSignOut: scope.onSignOut, identity: scope.identity));
      return;
    case 'profile':
      push(const ProfileScreen());
      return;
    case 'identity':
    case 'avaidentity':
      push(const IdentityScreen());
      return;
    case 'library':
    case 'avalibrary':
      push(const AvaLibraryScreen());
      return;
    case 'avastorage':
    case 'storage':
    case 'backup':
      push(const AvaStorageScreen());
      return;
    case 'wallet':
    case 'avawallet':
      push(const WalletScreen());
      return;
    // [FIX 2026-07-13] Connectors (Composio apps hub). ShellV2 dropped the old
    // shell's `avaapps` case, so the sidebar "Connectors" tap fell through to the
    // "coming soon" placeholder instead of the real AvaApps grid — this restores it.
    case 'avaapps':
    case 'apps':
    case 'connectors':
      push(const AvaAppsScreen());
      return;
    case 'payout':
    case 'avapayout':
      push(const PayoutScreen());
      return;
    case 'subscribe':
      push(const SubscribeScreen());
      return;
    case 'marketplace':
      push(const MarketplaceBrowse());
      return;
    case 'mylistings':
      push(const MyListingsScreen());
      return;
    case 'archived':
      push(const ArchivedScreen());
      return;
    case 'createlisting':
      // [MKT2] AI compose chat when enabled (it runs the liveness gate in-chat,
      // §3.1), else the old form. Mirrors ava_shell.dart.
      push(RemoteConfig.aiComposeEnabled
          ? const ComposeChatScreen()
          : const SellListingFlow());
      return;
    case 'about':
      push(const AboutScreen());
      return;
    default:
      // App-registry entries (or anything not yet built) → branded ComingSoon,
      // matching the legacy shell's fall-through behaviour.
      if (AppRegistry.byId(dest) != null) {
        push(ComingSoon.forApp(dest));
        return;
      }
      push(ComingSoon(
        title: 'Coming soon',
        subtitle: 'Not available right now',
        icon: PhosphorIcons.lightning(PhosphorIconsStyle.fill),
        color: Zine.blue,
      ));
  }
}

/// Whether a destination key names one of the four shell roots (handled by
/// switchRoot, never pushed as a screen).
bool isRootDestination(String dest) => rootIdForDestination(dest) != null;

/// Maps a sidebar/menu destination key onto a shell root, or null if it is a
/// pushable screen. Used so the reused AvaTalk messenger drawer can route
/// root-level taps to the shell instead of pushing a duplicate screen.
RootId? rootIdForDestination(String dest) {
  switch (dest) {
    case 'avadial':
    case 'dial':
      return RootId.avaDial;
    case 'home': // legacy links → the app now lands on AvaTOK (Home root retired)
    case 'avatalk':
    case 'avatok':
      return RootId.avaTalk;
    case 'services':
      return RootId.services;
    default:
      return null;
  }
}

/// Whether the Wallet entry should be shown (hidden when top-up + real-money are
/// both off and the account isn't premium-eligible). Kept permissive: Wallet is
/// always useful for viewing balance, so we only hide Payout behind its flag.
bool get walletEntryVisible => true;

/// Payout is a creator/earner surface — hide it while billing is off (its
/// existing feature flag), matching the plan §6 "hide Wallet/Payout entries when
/// their existing feature flags disable them".
bool get payoutEntryVisible => RemoteConfig.billingEnabled;

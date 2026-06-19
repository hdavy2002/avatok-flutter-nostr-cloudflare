import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../auth/clerk_client.dart';
import '../core/admin_tools.dart';
import '../core/app_registry.dart';
import '../core/apps.dart';
import '../core/ui/zine.dart';
import '../identity/identity.dart';
import '../features/avaapps/avaapps_screen.dart';
import '../features/ava_companion/companion_home.dart';
import '../features/avalive/avalive_discovery.dart';
import '../features/affiliate/affiliate_home.dart';
import '../features/avavoice/avavoice_home.dart';
import '../features/avavision/avavision_home.dart';
import '../features/avatok/chat_list.dart';
import '../features/ava_backup/backup_service.dart';
import '../features/booking/avabooking_screen.dart';
import '../features/calendar/avacalendar_screen.dart';
import '../features/library/avalibrary_screen.dart';
import '../features/library/avastorage_screen.dart';
import '../features/identity/identity_screen.dart';
import '../features/inbox/inbox_screen.dart';
import '../features/verse/verse_screen.dart';
import '../features/payout/payout_screen.dart';
import '../features/wallet/wallet_screen.dart';
import '../features/settings/settings_screen.dart';
import 'coming_soon.dart';
import 'focus_mode.dart';

/// The signed-in app shell. Opens on AvaTOK (messaging) as the home surface;
/// other apps are pushed on top and pop back here.
class AvaShell extends StatefulWidget {
  final ClerkClient clerk;
  final VoidCallback onSignOut;
  const AvaShell({super.key, required this.clerk, required this.onSignOut});
  @override
  State<AvaShell> createState() => _AvaShellState();
}

class _AvaShellState extends State<AvaShell> {
  final _idStore = IdentityStore();

  Identity? _id;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final id = await _idStore.load();
    // Warm the per-account focus-mode value so any sidebar drawer paints the
    // correct menu without a default-then-correct flicker.
    await FocusMode.load();
    if (mounted) setState(() => _id = id);
    // Daily auto-backup (best-effort, throttled): encrypt local SQLite → R2
    // (premium) or the user's own Google Drive (free). Makes the device + backup
    // the durable copy so the InboxDO can shed old history.
    BackupService.I.maybeAutoBackup();
  }

  /// Switch apps from within the home app (AvaTOK): return to the home surface,
  /// then open the requested destination on top.
  void _switchFromChild(String dest) {
    Navigator.of(context).popUntil((r) => r.isFirst);
    if (dest == 'explore') return; // marketplace de-emphasised this release
    WidgetsBinding.instance.addPostFrameCallback((_) => _openDest(dest));
  }

  void _openDest(String dest) {
    switch (dest) {
      case 'explore':
        return; // marketplace de-emphasised for the free messaging release
      case 'settings':
        // Reload on return — the preview switcher may have changed the account kind.
        _push(SettingsScreen(clerk: widget.clerk, onSignOut: widget.onSignOut, identity: _id))
            .then((_) => _load());
        return;
      case 'avatok':
        _push(ChatListScreen(clerk: widget.clerk, onSignOut: widget.onSignOut, onSwitchApp: _switchFromChild));
        return;
      case 'avalive':
        _push(const AvaLiveDiscovery());
        return;
      case 'avavoice':
        _push(const AvaVoiceHome());
        return;
      case 'avavision':
        _push(const AvaVisionHome());
        return;
      case 'avaaffiliate':
      case 'affiliate':
        _push(const AffiliateHomeScreen());
        return;
      case 'verse':
        _push(const VerseScreen());
        return;
      case 'inbox':
      case 'avainbox':
        _push(const InboxScreen());
        return;
      case 'library':
      case 'avalibrary':
        _push(const AvaLibraryScreen());
        return;
      case 'avaapps':
      case 'apps':
        _push(const AvaAppsScreen());
        return;
      case 'avachat':
        _push(const CompanionHome()); // talk privately with Ava
        return;
      case 'avastorage':
      case 'storage':
        _push(const AvaStorageScreen());
        return;
      case 'profile':
        // Profile menu removed — AvaIdentity is the one-stop identity hub
        // (profile & photo live inside it). PROPOSAL-PROGRESSIVE-IDENTITY §7b.
        _push(const IdentityScreen());
        return;
      case 'wallet':
      case 'avawallet':
        _push(const WalletScreen());
        return;
      case 'calendar':
      case 'avacalendar':
        _push(const AvaCalendarScreen());
        return;
      case 'booking':
      case 'avabooking':
        _push(const AvaBookingScreen());
        return;
      case 'payout':
      case 'avapayout':
        _push(const PayoutScreen());
        return;
      case 'identity':
      case 'avaidentity':
        _push(const IdentityScreen());
        return;
      case 'billing':
      case 'invite':
        _push(ComingSoon(
            title: dest[0].toUpperCase() + dest.substring(1),
            subtitle: 'Coming soon',
            icon: PhosphorIcons.lightning(PhosphorIconsStyle.fill),
            color: Zine.blue));
        return;
      default:
        // Parent/Enterprise management tools (dummy → coming soon for now).
        final tool = adminToolByKey(dest);
        if (tool != null) {
          _push(ComingSoon(title: tool.name, subtitle: tool.tagline, icon: tool.icon, color: tool.color));
          return;
        }
        // App registry (standard or hidden) → branded ComingSoon until its
        // phase ships; legacy kApps keys fall through to the same screen.
        if (AppRegistry.byId(dest) != null) {
          _push(ComingSoon.forApp(dest));
          return;
        }
        final a = appByKey(dest);
        _push(ComingSoon(title: a.name, subtitle: a.tagline, icon: a.icon, color: a.color));
    }
  }

  Future<void> _push(Widget w) => Navigator.push(context, MaterialPageRoute(builder: (_) => w));

  @override
  Widget build(BuildContext context) {
    // Messaging-first landing (owner decision 2026-06-18, free release): the app
    // opens directly on AvaTOK (ChatListScreen), where users see their chats &
    // contacts. ChatListScreen carries its own sidebar drawer + bottom nav, so
    // it IS the home surface. Other apps push on top via _switchFromChild and
    // pop back here. (Marketplace/ExploreHome de-emphasised for this release.)
    return ChatListScreen(
      clerk: widget.clerk,
      onSignOut: widget.onSignOut,
      onSwitchApp: _switchFromChild,
    );
  }
}

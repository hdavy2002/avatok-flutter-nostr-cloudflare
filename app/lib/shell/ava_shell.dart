import 'package:flutter/material.dart';

import '../auth/clerk_client.dart';
import '../core/admin_tools.dart';
import '../core/app_registry.dart';
import '../core/apps.dart';
import '../core/onboarding_store.dart';
import '../core/theme.dart';
import '../identity/identity.dart';
import '../features/avachat/avachat_screen.dart';
import '../features/avalive/avalive_discovery.dart';
import '../features/avatok/chat_list.dart';
import '../features/booking/avabooking_screen.dart';
import '../features/calendar/avacalendar_screen.dart';
import '../features/library/avalibrary_screen.dart';
import '../features/library/avastorage_screen.dart';
import '../features/explore/explore_home.dart';
import '../features/identity/identity_screen.dart';
import '../features/inbox/inbox_screen.dart';
import '../features/verse/verse_screen.dart';
import '../features/payout/payout_screen.dart';
import '../features/wallet/wallet_screen.dart';
import '../features/settings/settings_screen.dart';
import 'ava_sidebar.dart';
import 'coming_soon.dart';

/// The signed-in app shell: AvaExplore landing + sidebar drawer.
class AvaShell extends StatefulWidget {
  final ClerkClient clerk;
  final VoidCallback onSignOut;
  const AvaShell({super.key, required this.clerk, required this.onSignOut});
  @override
  State<AvaShell> createState() => _AvaShellState();
}

class _AvaShellState extends State<AvaShell> {
  final _scaffoldKey = GlobalKey<ScaffoldState>();
  final _onb = OnboardingStore();
  final _idStore = IdentityStore();
  final _kindStore = AccountKindStore();

  Set<String> _enabled = {};
  AccountKind _kind = AccountKind.personal;
  Identity? _id;
  String _current = 'explore';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final apps = await _onb.enabledApps();
    final id = await _idStore.load();
    final kind = await _kindStore.load();
    if (mounted) setState(() { _enabled = apps; _id = id; _kind = kind; });
  }

  void _openDrawer() => _scaffoldKey.currentState?.openDrawer();

  Future<void> _select(String dest) async {
    Navigator.pop(context); // close drawer
    _openDest(dest);
  }

  /// Switch apps from within a pushed app (e.g. AvaTok): return to the shell, then open.
  void _switchFromChild(String dest) {
    Navigator.of(context).popUntil((r) => r.isFirst);
    if (dest == 'explore') { setState(() => _current = 'explore'); return; }
    WidgetsBinding.instance.addPostFrameCallback((_) => _openDest(dest));
  }

  void _openDest(String dest) {
    switch (dest) {
      case 'explore':
        setState(() => _current = 'explore');
        return;
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
      case 'avachat':
        _push(const AvaChatScreen());
        return;
      case 'billing':
      case 'invite':
        _push(ComingSoon(title: dest[0].toUpperCase() + dest.substring(1), subtitle: 'Coming soon', icon: Icons.bolt, color: AvaColors.brand));
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
    return Scaffold(
      key: _scaffoldKey,
      drawerEnableOpenDragGesture: true,
      drawer: AvaSidebar(
        enabledApps: _enabled,
        accountKind: _kind,
        name: _id?.shortNpub ?? 'Account',
        seed: _id?.npub ?? 'avatok',
        current: _current,
        onSelect: _select,
        onSignOut: () { Navigator.pop(context); widget.onSignOut(); },
      ),
      body: ExploreHome(onMenu: _openDrawer),
    );
  }
}

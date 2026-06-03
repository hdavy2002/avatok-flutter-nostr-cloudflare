import 'package:flutter/material.dart';

import '../auth/clerk_client.dart';
import '../core/apps.dart';
import '../core/onboarding_store.dart';
import '../core/theme.dart';
import '../identity/identity.dart';
import '../features/avalive/live_screen.dart';
import '../features/avatok/chat_list.dart';
import '../features/explore/explore_home.dart';
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

  Set<String> _enabled = {};
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
    if (mounted) setState(() { _enabled = apps; _id = id; });
  }

  void _openDrawer() => _scaffoldKey.currentState?.openDrawer();

  Future<void> _select(String dest) async {
    Navigator.pop(context); // close drawer
    switch (dest) {
      case 'explore':
        setState(() => _current = 'explore');
        return;
      case 'settings':
        _push(SettingsScreen(clerk: widget.clerk, onSignOut: widget.onSignOut, identity: _id));
        return;
      case 'avatok':
        _push(ChatListScreen(clerk: widget.clerk, onSignOut: widget.onSignOut));
        return;
      case 'avalive':
        _push(const LiveScreen());
        return;
      case 'verse':
        _push(const ComingSoon(title: 'AvaVerse', subtitle: 'Your dashboard', icon: Icons.dashboard, color: Color(0xFF6C5CE7)));
        return;
      case 'library':
        _push(const ComingSoon(title: 'AvaLibrary', subtitle: 'Saved media & files', icon: Icons.folder_open, color: Color(0xFF8B5CF6)));
        return;
      case 'wallet':
      case 'profile':
      case 'billing':
      case 'payout':
      case 'invite':
        _push(ComingSoon(title: dest[0].toUpperCase() + dest.substring(1), subtitle: 'Coming soon', icon: Icons.bolt, color: AvaColors.brand));
        return;
      default:
        final a = appByKey(dest);
        _push(ComingSoon(title: a.name, subtitle: a.tagline, icon: a.icon, color: a.color));
    }
  }

  void _push(Widget w) => Navigator.push(context, MaterialPageRoute(builder: (_) => w));

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: _scaffoldKey,
      drawerEnableOpenDragGesture: true,
      drawer: AvaSidebar(
        enabledApps: _enabled,
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

import 'package:flutter/material.dart';

import '../core/admin_tools.dart';
import '../core/app_registry.dart';
import '../core/avatar.dart';
import '../core/device_contacts.dart';
import '../core/logo.dart';
import '../core/profile_store.dart';
import '../core/theme.dart';
import '../features/diagnostics/log_page.dart';

/// The AvaTOK sidebar drawer. `onSelect` receives a destination key:
/// 'explore' | 'verse' | 'library' | 'settings' | 'wallet' | 'profile' |
/// 'billing' | 'payout' | 'invite' | or an app key.
class AvaSidebar extends StatefulWidget {
  final Set<String> enabledApps;
  final AccountKind accountKind;
  final String name;
  final String seed;
  final String current;
  final ValueChanged<String> onSelect;
  final VoidCallback onSignOut;
  const AvaSidebar({
    super.key,
    required this.enabledApps,
    this.accountKind = AccountKind.personal,
    required this.name,
    required this.seed,
    required this.current,
    required this.onSelect,
    required this.onSignOut,
  });
  @override
  State<AvaSidebar> createState() => _AvaSidebarState();
}

class _AvaSidebarState extends State<AvaSidebar> {
  bool _accountOpen = false;
  String _displayName = '';
  String _handle = '';

  @override
  void initState() {
    super.initState();
    ProfileStore().load().then((p) {
      if (mounted) setState(() { _displayName = p.displayName; _handle = p.handle; });
    });
  }

  /// Real display name if set, else the short npub passed in.
  String get _name => _displayName.isNotEmpty ? _displayName : widget.name;
  String get _sub => _handle.isNotEmpty ? '@$_handle · View public profile' : 'View public profile';

  @override
  Widget build(BuildContext context) {
    // Phase 1: the sidebar renders STANDARD-tier apps only (hidden tier stays
    // registered in AppRegistry for later). Explore/Verse/Library render as the
    // featured tiles above, so the APPS list excludes them.
    final apps = AppRegistry.standard
        .where((a) => a.id != 'explore' && a.id != 'verse' && a.id != 'avalibrary')
        .toList();
    return Drawer(
      backgroundColor: Colors.white,
      width: MediaQuery.of(context).size.width * 0.82,
      child: SafeArea(
        child: Column(children: [
          // header
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 14, 14, 8),
            child: Row(children: [
              const AvaLogo(size: 22),
              const SizedBox(width: 8),
              Text('AvaTOK', style: Theme.of(context).textTheme.titleLarge?.copyWith(fontSize: 18)),
              const Spacer(),
              GestureDetector(
                onTap: () => Navigator.pop(context),
                child: Container(width: 30, height: 30,
                    decoration: const BoxDecoration(color: AvaColors.soft, shape: BoxShape.circle),
                    child: const Icon(Icons.close, size: 18)),
              ),
            ]),
          ),
          // profile (tap → public profile)
          InkWell(
            onTap: () => widget.onSelect('profile'),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(18, 6, 18, 12),
              child: Row(children: [
                _ringedAvatar(),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Flexible(child: Text(_name, maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15))),
                      const SizedBox(width: 4),
                      const Icon(Icons.chevron_right, size: 18, color: AvaColors.sub),
                    ]),
                    Text(_sub, maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: const TextStyle(color: AvaColors.sub, fontSize: 12)),
                  ]),
                ),
              ]),
            ),
          ),
          Expanded(
            child: ListView(padding: EdgeInsets.zero, children: [
              _special('explore', 'AvaExplore', 'Marketplace', Icons.storefront, AvaColors.brand),
              _special('verse', 'AvaVerse', 'Your dashboard', Icons.dashboard, const Color(0xFF6C5CE7)),
              // AvaInbox rides the registry row ('avainbox') in the APPS section
              // below — the shell routes it to the real InboxScreen (Phase 8).
              _special('library', 'AvaLibrary', 'Saved media & files', Icons.folder_open, const Color(0xFF8B5CF6)),
              // Role-based management tools (Parent / Enterprise).
              ..._managementSection(),
              const Padding(padding: EdgeInsets.fromLTRB(20, 14, 20, 6),
                  child: Text('APPS', style: TextStyle(color: AvaColors.sub, fontSize: 11, letterSpacing: 1, fontWeight: FontWeight.w700))),
              for (final a in apps) _appRow(a),
              ListTile(
                leading: const Icon(Icons.person_add_alt_1, size: 22, color: AvaColors.brand),
                title: const Text('Invite', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                onTap: () { Navigator.pop(context); DeviceContactsService.shareGenericInvite(); },
              ),
              ListTile(
                leading: const Icon(Icons.bug_report_outlined, size: 22, color: AvaColors.sub),
                title: const Text('Diagnostics', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                subtitle: const Text('App logs — copy & share', style: TextStyle(color: AvaColors.sub, fontSize: 11.5)),
                onTap: () {
                  Navigator.pop(context);
                  Navigator.push(context, MaterialPageRoute(builder: (_) => const LogPage()));
                },
              ),
              _accountSection(),
            ]),
          ),
          const Divider(height: 1, color: AvaColors.line),
          ListTile(
            leading: const Icon(Icons.logout, color: AvaColors.danger),
            title: const Text('Log out', style: TextStyle(color: AvaColors.danger, fontWeight: FontWeight.w700)),
            onTap: widget.onSignOut,
          ),
        ]),
      ),
    );
  }

  Widget _special(String key, String name, String sub, IconData icon, Color color) {
    final active = widget.current == key;
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
      decoration: BoxDecoration(
        color: active ? AvaColors.brand50 : Colors.transparent,
        borderRadius: BorderRadius.circular(12)),
      child: ListTile(
        leading: Container(width: 34, height: 34,
            decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(10)),
            child: Icon(icon, color: color, size: 18)),
        title: Text(name, style: TextStyle(fontWeight: FontWeight.w700,
            color: active ? AvaColors.brand : AvaColors.ink, fontSize: 14.5)),
        subtitle: Text(sub, style: const TextStyle(color: AvaColors.sub, fontSize: 11.5)),
        onTap: () => widget.onSelect(key),
      ),
    );
  }

  /// Parent/Enterprise tool group — empty for personal accounts.
  List<Widget> _managementSection() {
    final tools = toolsFor(widget.accountKind);
    if (tools.isEmpty) return const [];
    return [
      Padding(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 6),
        child: Text(headerFor(widget.accountKind),
            style: const TextStyle(color: AvaColors.sub, fontSize: 11, letterSpacing: 1, fontWeight: FontWeight.w700)),
      ),
      for (final t in tools) _toolRow(t),
    ];
  }

  Widget _toolRow(AdminTool t) => ListTile(
        dense: true,
        leading: Container(width: 30, height: 30,
            decoration: BoxDecoration(color: t.color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(9)),
            child: Icon(t.icon, color: t.color, size: 16)),
        title: Text(t.name, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
        subtitle: Text(t.tagline, maxLines: 1, overflow: TextOverflow.ellipsis,
            style: const TextStyle(color: AvaColors.sub, fontSize: 11.5)),
        onTap: () => widget.onSelect(t.key),
      );

  Widget _appRow(AppEntry a) => ListTile(
        dense: true,
        leading: Container(width: 30, height: 30,
            decoration: BoxDecoration(color: a.color, borderRadius: BorderRadius.circular(9)),
            child: Icon(a.icon, color: Colors.white, size: 16)),
        title: Text(a.title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
        trailing: const Icon(Icons.expand_more, size: 18, color: AvaColors.sub),
        onTap: () => widget.onSelect(a.route),
      );

  /// Avatar wrapped in an Instagram-style gradient story-ring + a small badge.
  Widget _ringedAvatar() => SizedBox(
        width: 50, height: 50,
        child: Stack(clipBehavior: Clip.none, children: [
          Container(
            width: 50, height: 50,
            padding: const EdgeInsets.all(2.5),
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              gradient: SweepGradient(colors: [
                Color(0xFFFF6036), Color(0xFFE1306C), Color(0xFF8B5CF6),
                Color(0xFF08C4C4), Color(0xFFFF6036),
              ]),
            ),
            child: Container(
              padding: const EdgeInsets.all(2),
              decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle),
              child: Avatar(seed: widget.seed, name: _name, size: 41),
            ),
          ),
          Positioned(
            right: -1, bottom: -1,
            child: Container(
              width: 17, height: 17,
              decoration: BoxDecoration(
                color: AvaColors.brand, shape: BoxShape.circle,
                border: Border.all(color: Colors.white, width: 2)),
              child: const Icon(Icons.camera_alt, size: 9, color: Colors.white),
            ),
          ),
        ]),
      );

  Widget _accountSection() {
    return Column(children: [
      ListTile(
        title: const Text('ACCOUNT', style: TextStyle(color: AvaColors.sub, fontSize: 11, letterSpacing: 1, fontWeight: FontWeight.w700)),
        trailing: Icon(_accountOpen ? Icons.expand_less : Icons.expand_more, size: 18, color: AvaColors.sub),
        onTap: () => setState(() => _accountOpen = !_accountOpen),
      ),
      if (_accountOpen) ...[
        _acct('wallet', 'Wallet', Icons.account_balance_wallet_outlined),
        _acct('profile', 'Profile', Icons.person_outline),
        _acct('billing', 'Billing', Icons.credit_card),
        _acct('payout', 'Payout', Icons.payments_outlined),
        _acct('settings', 'Settings', Icons.settings_outlined),
      ],
    ]);
  }

  Widget _acct(String key, String name, IconData icon) => ListTile(
        dense: true,
        leading: Container(width: 30, height: 30,
            decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(9)),
            child: Icon(icon, size: 16, color: AvaColors.ink)),
        title: Text(name, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
        onTap: () => widget.onSelect(key),
      );
}

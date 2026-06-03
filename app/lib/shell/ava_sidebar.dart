import 'package:flutter/material.dart';

import '../core/apps.dart';
import '../core/avatar.dart';
import '../core/logo.dart';
import '../core/theme.dart';

/// The AvaTOK sidebar drawer. `onSelect` receives a destination key:
/// 'explore' | 'verse' | 'library' | 'settings' | 'wallet' | 'profile' |
/// 'billing' | 'payout' | 'invite' | or an app key.
class AvaSidebar extends StatefulWidget {
  final Set<String> enabledApps;
  final String name;
  final String seed;
  final String current;
  final ValueChanged<String> onSelect;
  final VoidCallback onSignOut;
  const AvaSidebar({
    super.key,
    required this.enabledApps,
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

  @override
  Widget build(BuildContext context) {
    final apps = kApps.where((a) => widget.enabledApps.contains(a.key)).toList();
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
          // profile
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 6, 18, 12),
            child: Row(children: [
              Avatar(seed: widget.seed, name: widget.name, size: 44),
              const SizedBox(width: 12),
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Text(widget.name, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
                  const SizedBox(width: 4),
                  const Icon(Icons.chevron_right, size: 18, color: AvaColors.sub),
                ]),
                const Text('View public profile', style: TextStyle(color: AvaColors.sub, fontSize: 12)),
              ]),
            ]),
          ),
          Expanded(
            child: ListView(padding: EdgeInsets.zero, children: [
              _special('explore', 'AvaExplore', 'Marketplace', Icons.storefront, AvaColors.brand),
              _special('verse', 'AvaVerse', 'Your dashboard', Icons.dashboard, const Color(0xFF6C5CE7)),
              _special('library', 'AvaLibrary', 'Saved media & files', Icons.folder_open, const Color(0xFF8B5CF6)),
              const Padding(padding: EdgeInsets.fromLTRB(20, 14, 20, 6),
                  child: Text('APPS', style: TextStyle(color: AvaColors.sub, fontSize: 11, letterSpacing: 1, fontWeight: FontWeight.w700))),
              for (final a in apps) _appRow(a),
              _plain('invite', 'Invite', Icons.person_add_alt_1),
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

  Widget _appRow(AppDef a) => ListTile(
        dense: true,
        leading: Container(width: 30, height: 30,
            decoration: BoxDecoration(color: a.color, borderRadius: BorderRadius.circular(9)),
            child: Icon(a.icon, color: Colors.white, size: 16)),
        title: Text(a.name, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
        trailing: const Icon(Icons.expand_more, size: 18, color: AvaColors.sub),
        onTap: () => widget.onSelect(a.key),
      );

  Widget _plain(String key, String name, IconData icon) => ListTile(
        leading: Icon(icon, size: 22, color: AvaColors.ink),
        title: Text(name, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
        onTap: () => widget.onSelect(key),
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

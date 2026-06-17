import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../core/admin_tools.dart';
import '../core/app_registry.dart';
import '../core/avatar.dart';
import '../core/device_contacts.dart';
import '../core/paid_feature.dart';
import '../core/profile_store.dart';
import '../core/ui/zine.dart';
import '../core/ui/zine_widgets.dart';
import '../features/diagnostics/log_page.dart';
import 'focus_mode.dart';

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
  /// Desktop: render as a fixed left rail (no Drawer chrome, no close button)
  /// instead of a slide-over drawer.
  final bool permanent;
  const AvaSidebar({
    super.key,
    required this.enabledApps,
    this.accountKind = AccountKind.personal,
    required this.name,
    required this.seed,
    required this.current,
    required this.onSelect,
    required this.onSignOut,
    this.permanent = false,
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
    // Refresh focus-mode for the current account whenever the sidebar mounts
    // (account may have switched). The ValueListenableBuilder in build() then
    // reflects the loaded value + any later Settings-toggle change.
    FocusMode.load();
  }

  /// Real display name if set, else the short npub passed in.
  String get _name => _displayName.isNotEmpty ? _displayName : widget.name;
  String get _sub => _handle.isNotEmpty ? '@$_handle · View public profile' : 'View public profile';

  @override
  Widget build(BuildContext context) {
    // Phase 1: rebuild when focus mode flips (Settings toggle) so the menu shows
    // AvaTOK + account essentials only (ON) or the full app list (OFF) live.
    return ValueListenableBuilder<bool>(
      valueListenable: FocusMode.enabled,
      builder: (context, focus, _) {
        // When focus mode is ON the menu shows AvaTOK + account essentials only
        // (AppRegistry.focusMode). When OFF it behaves exactly as before:
        // STANDARD-tier apps (hidden tier stays registered for later). In both
        // modes Explore/Verse/Library render as featured tiles above (OFF only),
        // so the APPS list excludes them. Hidden-tier entries are never deleted.
        final source = focus ? AppRegistry.focusMode : AppRegistry.standard;
        final apps = source
            .where((a) => a.id != 'explore' && a.id != 'verse' && a.id != 'avalibrary')
            .toList();
        final body = SafeArea(child: _column(context, apps, focus));
        if (widget.permanent) {
          return Container(
            width: 300,
            decoration: const BoxDecoration(
              color: Zine.paper2,
              border: Border(right: BorderSide(color: Zine.ink, width: Zine.bw)),
            ),
            child: body,
          );
        }
        return Drawer(
          backgroundColor: Zine.paper2,
          shape: const Border(right: BorderSide(color: Zine.ink, width: Zine.bw)),
          width: MediaQuery.of(context).size.width * 0.82,
          child: body,
        );
      },
    );
  }

  /// Premium/paid-gated app entries — show a PAID badge in the APPS list. These
  /// are the AI/generative surfaces that spend AvaCoins at the point of use;
  /// AvaTOK core + account items stay free (no badge). Kept deliberately light.
  static const Set<String> _paidAppIds = {
    'avachat',   // personal AI (generative)
    'avavoice',  // AI voice agents
    'avavision', // AI vision coaches
  };

  Widget _column(BuildContext context, List<AppEntry> apps, bool focus) {
    return Column(children: [
          // header — wordmark + close
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 14, 14, 8),
            child: Row(children: [
              const ZineLogoMark(size: 22),
              const SizedBox(width: 8),
              Text.rich(
                TextSpan(
                  style: const TextStyle(
                      fontFamily: ZineText.display, fontWeight: FontWeight.w600,
                      fontSize: 19, letterSpacing: -0.38, color: Zine.ink),
                  children: const [
                    TextSpan(text: 'Ava'),
                    TextSpan(text: 'TOK', style: TextStyle(color: Zine.blueInk)),
                  ],
                ),
              ),
              const Spacer(),
              if (!widget.permanent)
                ZineBackButton(
                  icon: PhosphorIcons.x(PhosphorIconsStyle.bold),
                  onTap: () => Navigator.pop(context),
                ),
            ]),
          ),
          // profile (tap → public profile)
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 6, 14, 12),
            child: ZinePressable(
              onTap: () => widget.onSelect('profile'),
              radius: BorderRadius.circular(Zine.rSm),
              boxShadow: Zine.shadowXs,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              child: Row(children: [
                _inkedAvatar(),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Flexible(
                          child: Text(_name, maxLines: 1, overflow: TextOverflow.ellipsis,
                              style: ZineText.cardTitle(size: 16))),
                      const SizedBox(width: 4),
                      PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
                          size: 14, color: Zine.inkSoft),
                    ]),
                    const SizedBox(height: 2),
                    Text(_sub, maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: ZineText.tag(size: 10.5, color: Zine.inkSoft)),
                  ]),
                ),
              ]),
            ),
          ),
          Expanded(
            child: ListView(padding: const EdgeInsets.fromLTRB(14, 0, 14, 8), children: [
              // Featured tiles — hidden in focus mode (those apps live outside
              // AvaTOK + account essentials). Shown normally when focus is OFF.
              if (!focus) ...[
                // Two major apps: AvaChat (talk privately to Ava) + AvaTOK
                // (message people). AvaExplore/AvaVerse hidden (owner 2026-06-17).
                _special('avachat', 'AvaChat', 'Talk privately with Ava',
                    PhosphorIcons.sparkle(PhosphorIconsStyle.bold), Zine.lilac),
                _special('library', 'AvaLibrary', 'Saved media & files',
                    PhosphorIcons.folderOpen(PhosphorIconsStyle.bold), Zine.mint),
                _special('avaapps', 'AvaApps', 'Gmail, Docs, Drive & more',
                    PhosphorIcons.squaresFour(PhosphorIconsStyle.bold), Zine.blue),
              ],
              // Role-based management tools (Parent / Enterprise).
              ..._managementSection(),
              Padding(
                  padding: const EdgeInsets.fromLTRB(6, 16, 6, 8),
                  child: Text('APPS', style: ZineText.kicker())),
              for (final a in apps) _appRow(a),
              const SizedBox(height: 6),
              _plainRow(
                icon: PhosphorIcons.userPlus(PhosphorIconsStyle.bold),
                accent: Zine.lime,
                title: 'Invite',
                onTap: () { if (!widget.permanent) Navigator.pop(context); DeviceContactsService.shareGenericInvite(); },
              ),
              const SizedBox(height: 6),
              _plainRow(
                icon: PhosphorIcons.bug(PhosphorIconsStyle.bold),
                accent: Zine.blue,
                title: 'Diagnostics',
                subtitle: 'App logs — copy & share',
                onTap: () {
                  if (!widget.permanent) Navigator.pop(context);
                  Navigator.push(context, MaterialPageRoute(builder: (_) => const LogPage()));
                },
              ),
              _accountSection(),
            ]),
          ),
          Container(
            decoration: const BoxDecoration(
              border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
            ),
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: widget.onSignOut,
              child: Row(children: [
                ZineIconBadge(
                    icon: PhosphorIcons.signOut(PhosphorIconsStyle.bold),
                    color: Zine.coral, size: 30),
                const SizedBox(width: 12),
                Text('Log out', style: ZineText.value(size: 15, color: Zine.coral)),
              ]),
            ),
          ),
        ]);
  }

  Widget _special(String key, String name, String sub, IconData icon, Color color) {
    final active = widget.current == key;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: ZinePressable(
        onTap: () => widget.onSelect(key),
        color: active ? Zine.lime : Zine.card,
        radius: BorderRadius.circular(Zine.rSm),
        boxShadow: active ? Zine.shadowSm : Zine.shadowXs,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        child: Row(children: [
          ZineIconBadge(icon: icon, color: color),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(name, style: ZineText.cardTitle(size: 15.5)),
              const SizedBox(height: 1),
              Text(sub, style: ZineText.tag(size: 10.5, color: Zine.inkSoft)),
            ]),
          ),
        ]),
      ),
    );
  }

  /// Parent/Enterprise tool group — empty for personal accounts.
  List<Widget> _managementSection() {
    final tools = toolsFor(widget.accountKind);
    if (tools.isEmpty) return const [];
    return [
      Padding(
        padding: const EdgeInsets.fromLTRB(6, 16, 6, 8),
        child: Text(headerFor(widget.accountKind).toUpperCase(), style: ZineText.kicker()),
      ),
      for (final t in tools) _toolRow(t),
    ];
  }

  Widget _toolRow(AdminTool t) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: ZinePressable(
          onTap: () => widget.onSelect(t.key),
          radius: BorderRadius.circular(14),
          boxShadow: const <BoxShadow>[],
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          child: Row(children: [
            ZineIconBadge(icon: t.icon, color: t.color, size: 30),
            const SizedBox(width: 11),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(t.name, style: ZineText.value(size: 14)),
                Text(t.tagline, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ZineText.sub(size: 11.5)),
              ]),
            ),
          ]),
        ),
      );

  Widget _appRow(AppEntry a) {
    final paid = _paidAppIds.contains(a.id);
    return Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: ZinePressable(
          // The row still opens the app; the PAID badge shows it needs a top-up.
          // The actual spend gate (PaidFeature) lives at the feature's point of
          // use, so we don't block navigation from the menu.
          onTap: () => widget.onSelect(a.route),
          radius: BorderRadius.circular(14),
          boxShadow: const <BoxShadow>[],
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          child: Row(children: [
            ZineIconBadge(icon: a.icon, color: a.color, size: 30),
            const SizedBox(width: 11),
            Expanded(child: Text(a.title, style: ZineText.value(size: 14))),
            if (paid) ...[
              const PaidBadge(),
              const SizedBox(width: 8),
            ],
            PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
                size: 14, color: Zine.inkMute),
          ]),
        ),
      );
  }

  Widget _plainRow({
    required IconData icon,
    required Color accent,
    required String title,
    String? subtitle,
    required VoidCallback onTap,
  }) =>
      ZinePressable(
        onTap: onTap,
        radius: BorderRadius.circular(14),
        boxShadow: const <BoxShadow>[],
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        child: Row(children: [
          ZineIconBadge(icon: icon, color: accent, size: 30),
          const SizedBox(width: 11),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: ZineText.value(size: 14)),
              if (subtitle != null)
                Text(subtitle, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ZineText.sub(size: 11.5)),
            ]),
          ),
        ]),
      );

  /// Avatar in an ink-bordered circle + a small lime camera seal (no gradients
  /// in the zine system — flat fills + ink borders only).
  Widget _inkedAvatar() => SizedBox(
        width: 50, height: 50,
        child: Stack(clipBehavior: Clip.none, children: [
          Container(
            width: 50, height: 50,
            padding: const EdgeInsets.all(2),
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: Zine.card,
              border: Border.all(color: Zine.ink, width: 2),
            ),
            child: Avatar(seed: widget.seed, name: _name, size: 42),
          ),
          Positioned(
            right: -2, bottom: -2,
            child: Container(
              width: 18, height: 18,
              decoration: BoxDecoration(
                color: Zine.lime, shape: BoxShape.circle,
                border: Border.all(color: Zine.ink, width: 2),
              ),
              child: PhosphorIcon(PhosphorIcons.camera(PhosphorIconsStyle.fill),
                  size: 9, color: Zine.ink),
            ),
          ),
        ]),
      );

  Widget _accountSection() {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => setState(() => _accountOpen = !_accountOpen),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(6, 16, 6, 8),
          child: Row(children: [
            Text('ACCOUNT', style: ZineText.kicker()),
            const Spacer(),
            PhosphorIcon(
                _accountOpen
                    ? PhosphorIcons.caretUp(PhosphorIconsStyle.bold)
                    : PhosphorIcons.caretDown(PhosphorIconsStyle.bold),
                size: 14, color: Zine.inkSoft),
          ]),
        ),
      ),
      if (_accountOpen) ...[
        // Wallet, AvaIdentity, Payout hidden from the ACCOUNT section
        // (owner decision 2026-06-17).
        _acct('billing', 'Billing', PhosphorIcons.creditCard(PhosphorIconsStyle.bold)),
        _acct('settings', 'Settings', PhosphorIcons.gearSix(PhosphorIconsStyle.bold)),
      ],
    ]);
  }

  Widget _acct(String key, String name, IconData icon) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: ZinePressable(
          onTap: () => widget.onSelect(key),
          radius: BorderRadius.circular(14),
          boxShadow: const <BoxShadow>[],
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          child: Row(children: [
            ZineIconBadge(icon: icon, color: Zine.paper2, size: 30),
            const SizedBox(width: 11),
            Expanded(child: Text(name, style: ZineText.value(size: 14))),
          ]),
        ),
      );
}

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../core/admin_tools.dart';
import '../core/app_registry.dart';
import '../core/avatar.dart';
import '../core/remote_config.dart';
import '../core/money_api.dart';
import '../core/paid_feature.dart';
import '../core/profile_store.dart';
import '../core/team_api.dart';
import '../core/ui/zine.dart';
import '../core/ui/zine_widgets.dart';
import '../features/diagnostics/log_page.dart';
import '../features/settings/about_screen.dart';
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
  // ACCOUNT & SETTINGS section collapses by default (owner decision 2026-06-19,
  // revised) — the header is a bigger, tappable label that expands the group.
  bool _accountOpen = false;
  // Marketplace group COLLAPSED by default (owner decision 2026-06-30); tap the
  // header to reveal Browse / Create / My listings / Archived.
  bool _marketplaceOpen = false;
  String _displayName = '';
  String _handle = '';
  String _avatarUrl = ''; // the user's own profile photo (was never read → drawer showed initials)
  bool _premium = false; // topped-up wallet → premium (shown as a green pill)
  bool _onPaidTeam = false; // owner/member of a paid Team plan → drop the Team PAID badge

  @override
  void initState() {
    super.initState();
    ProfileStore().load().then((p) {
      if (mounted) setState(() { _displayName = p.displayName; _handle = p.handle; _avatarUrl = p.avatarUrl; });
    });
    // Reflect premium status in the sidebar (green PREMIUM pill once topped up).
    MoneyApi.balance().then((b) {
      if (mounted) setState(() => _premium = b['premium'] == 1 || b['premium'] == true);
    }).catchError((_) {});
    // Team plan status — once the user owns or belongs to a paid team, the Team
    // row drops its PAID badge (their staff seat / team plan already covers it).
    TeamApi.status().then((_) {
      if (mounted) setState(() => _onPaidTeam = TeamApi.onPaidTeam);
    }).catchError((_) {});
    // Refresh focus-mode for the current account whenever the sidebar mounts
    // (account may have switched). The ValueListenableBuilder in build() then
    // reflects the loaded value + any later Settings-toggle change.
    FocusMode.load();
  }

  /// Real display name if set, else the short uid passed in.
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
            .where((a) => a.id != 'explore' && a.id != 'verse')
            // Connectors, Wallet and View Storage now live in the ACCOUNT section
            // in BOTH modes, so they never appear in the APPS list.
            .where((a) => a.id != 'avaapps' && a.id != 'avawallet' && a.id != 'avastorage')
            // AvaTOK/Messenger, AvaChat/ChatAVA and Library now render as featured
            // tiles in BOTH focus and non-focus modes (see _column), so always drop
            // them from the APPS list to avoid duplicates.
            .where((a) => a.id != 'avalibrary' && a.id != 'avachat' && a.id != 'avatok')
            // Marketplace renders as its own expandable group (Browse / Create /
            // My listings), not a plain app row.
            .where((a) => a.id != 'marketplace')
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
  /// are the AI/generative surfaces that spend Tokens at the point of use;
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
          // Plan status — green PREMIUM ✓ pill once the wallet is topped up, else
          // a ghost "Free plan" chip that taps through to the Subscribe screen.
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 10),
            child: Align(alignment: Alignment.centerLeft, child: _planChip()),
          ),
          // (Subscribe moved into the list below the Contacts item — see ListView.)
          Expanded(
            child: ListView(padding: const EdgeInsets.fromLTRB(14, 0, 14, 8), children: [
              // Featured tiles — shown in BOTH focus and non-focus modes so the
              // renamed Messenger/ChatAVA + the AI Voice Agent item are always
              // visible (focus mode default is ON; these are the core surfaces).
              // AvaTOK first (message people), ChatAVA below it (talk to Ava), then
              // AI Voice Agent (hands-free call), then Library. Connectors live in
              // the ACCOUNT section; AvaExplore/AvaVerse hidden.
              _special('avatok', 'Messenger', 'Messages & calls',
                  PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), Zine.blue),
              // ChatAVA removed from the sidebar (owner decision 2026-06-27): the
              // private Ava chat now lives INSIDE Messenger as a pinned green
              // session (and via the + menu), so this duplicate is gone.
              // Owner request 2026-06-27: hide the "AI Voice Agent" entry from the
              // sidebar menu (the route/feature stays registered; only the menu
              // tile is suppressed so users can't start a hands-free voice call
              // from here). Re-enable by un-commenting this tile.
              // _special('aivoice', 'AI Voice Agent', 'Call Ava and talk hands-free',
              //     PhosphorIcons.phoneCall(PhosphorIconsStyle.bold), Zine.mint, paid: true),
              _special('library', 'Library', 'Saved media & files',
                  PhosphorIcons.folderOpen(PhosphorIconsStyle.bold), Zine.mint),
              // Contacts — moved out of ACCOUNT to sit below Library; own colour.
              _special('invite', 'Contacts', 'Find & manage people',
                  PhosphorIcons.addressBook(PhosphorIconsStyle.bold), Zine.coral),
              // AvaMarketplace — expandable group with its sub-pages (Browse,
              // Create listing, My listings, Archived). STAGING-ONLY for the
              // pro/live launch (owner decision 2026-07-01): the whole section +
              // its submenus show only when RemoteConfig.marketplaceEnabled is
              // true. Prod KV keeps it false (hidden); staging KV sets it true.
              if (RemoteConfig.marketplaceEnabled) _marketplaceSection(),
              // Team — AI receptionist + staff routing. HIDDEN from the sidebar
              // (owner decision 2026-06-28). Re-enable by un-commenting this row.
              // _special('team', 'Team', 'AI receptionist & staff',
              //     PhosphorIcons.usersThree(PhosphorIconsStyle.bold), Zine.lilac,
              //     paid: true, paidHidden: _onPaidTeam),
              // Subscribe — moved to sit just below Contacts (was a top CTA).
              // FREE LAUNCH: hidden while billing is off (no paywalls).
              if (RemoteConfig.billingEnabled)
              Padding(
                padding: const EdgeInsets.only(top: 4, bottom: 4),
                child: ZinePressable(
                  onTap: () => widget.onSelect('subscribe'),
                  color: Zine.lilac,
                  radius: BorderRadius.circular(Zine.rSm),
                  boxShadow: Zine.shadowXs,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  child: Row(children: [
                    ZineIconBadge(
                        icon: PhosphorIcons.crown(PhosphorIconsStyle.bold), color: Zine.card),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('Subscribe', style: ZineText.cardTitle(size: 15.5)),
                        const SizedBox(height: 1),
                        Text('Plans & upgrades',
                            style: ZineText.tag(size: 10.5, color: Zine.inkSoft)),
                      ]),
                    ),
                    PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
                        size: 14, color: Zine.ink),
                  ]),
                ),
              ),
              // Role-based management tools (Parent / Enterprise).
              ..._managementSection(),
              // APPS section — hidden when empty (in the default non-focus menu all
              // standard apps are featured tiles or live under ACCOUNT now).
              if (apps.isNotEmpty) ...[
                Padding(
                    padding: const EdgeInsets.fromLTRB(6, 16, 6, 8),
                    child: Text('APPS', style: ZineText.kicker())),
                for (final a in apps) _appRow(a),
              ],
              // Invite friends + Diagnostics moved into the ACCOUNT section
              // (owner 2026-06-19).
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

  /// Plan pill. BETA PHASE: the server reports every user as premium, so this
  /// green pill shows for everyone and reads "BETA PHASE" (all services free
  /// while in beta). Post-beta (betaFreePremium off), it reverts to the topped-up
  /// premium pill / "top up" ghost chip automatically.
  Widget _planChip() {
    if (_premium) {
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
        decoration: BoxDecoration(
          color: Zine.mint, // money/success green
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: Zine.ink, width: Zine.bw),
          boxShadow: Zine.shadowXs,
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(PhosphorIcons.sealCheck(PhosphorIconsStyle.fill), size: 14, color: Zine.mintInk),
          const SizedBox(width: 6),
          Text('BETA-FREE', style: ZineText.tag(size: 11.5, color: Zine.mintInk)),
        ]),
      );
    }
    // FREE LAUNCH: no paywalls. With billing off, show a plain non-tappable
    // "FREE PLAN" pill (no upgrade route). Reverts to the upgrade chip when
    // billingEnabled flips back on.
    final billingOn = RemoteConfig.billingEnabled;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: billingOn ? () => widget.onSelect('subscribe') : null,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
        decoration: BoxDecoration(
          color: Zine.card,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: Zine.inkMute, width: Zine.bw),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(PhosphorIcons.crown(PhosphorIconsStyle.fill), size: 13, color: Zine.inkSoft),
          const SizedBox(width: 6),
          Text(billingOn ? 'FREE PLAN · UPGRADE' : 'FREE PLAN',
              style: ZineText.tag(size: 11, color: Zine.inkSoft)),
        ]),
      ),
    );
  }

  Widget _special(String key, String name, String sub, IconData icon, Color color, {bool paid = false, bool paidHidden = false}) {
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
          // Premium marker — hidden once the user is on a paid plan / topped up,
          // or (for the Team row) once they're on a paid Team plan.
          if (paid && !_premium && !paidHidden) const PaidBadge(),
        ]),
      ),
    );
  }

  /// AvaMarketplace expandable group: a header that toggles open, revealing the
  /// Browse / Create listing / My listings sub-pages.
  Widget _marketplaceSection() {
    final headerActive = widget.current == 'marketplace';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(children: [
        ZinePressable(
          onTap: () => setState(() => _marketplaceOpen = !_marketplaceOpen),
          color: headerActive ? Zine.lime : Zine.card,
          radius: BorderRadius.circular(Zine.rSm),
          boxShadow: Zine.shadowXs,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Row(children: [
            ZineIconBadge(icon: PhosphorIcons.storefront(PhosphorIconsStyle.bold), color: Zine.coral),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Marketplace', style: ZineText.cardTitle(size: 15.5)),
                const SizedBox(height: 1),
                Text('Buy, sell & social', style: ZineText.tag(size: 10.5, color: Zine.inkSoft)),
              ]),
            ),
            PhosphorIcon(
                _marketplaceOpen
                    ? PhosphorIcons.caretUp(PhosphorIconsStyle.bold)
                    : PhosphorIcons.caretDown(PhosphorIconsStyle.bold),
                size: 14, color: Zine.inkSoft),
          ]),
        ),
        if (_marketplaceOpen) ...[
          const SizedBox(height: 4),
          _subRow('marketplace', 'Browse', PhosphorIcons.storefront(PhosphorIconsStyle.bold)),
          _subRow('createlisting', 'Create listing', PhosphorIcons.plusCircle(PhosphorIconsStyle.bold)),
          _subRow('mylistings', 'My listings', PhosphorIcons.tag(PhosphorIconsStyle.bold)),
          _subRow('archived', 'Archived', PhosphorIcons.archive(PhosphorIconsStyle.bold)),
        ],
      ]),
    );
  }

  Widget _subRow(String key, String label, IconData icon) => Padding(
        padding: const EdgeInsets.only(left: 14, top: 3),
        child: ZinePressable(
          onTap: () => widget.onSelect(key),
          radius: BorderRadius.circular(14),
          boxShadow: const <BoxShadow>[],
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          child: Row(children: [
            ZineIconBadge(icon: icon, color: Zine.blue, size: 30),
            const SizedBox(width: 11),
            Expanded(child: Text(label, style: ZineText.value(size: 14))),
            PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 12, color: Zine.inkSoft),
          ]),
        ),
      );

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
            // Owner request 2026-06-27: hide the PAID marker once the user is on
            // a paid plan / topped-up wallet — subscribers shouldn't see it on
            // the AI Voice Agent (or any other premium app) row.
            if (paid && !_premium) ...[
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
            child: Avatar(seed: widget.seed, name: _name, size: 42,
                avatarUrl: _avatarUrl.isEmpty ? null : _avatarUrl),
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
      // "ACCOUNT & SETTINGS" — a bigger, tappable header that collapses the group
      // (collapsed by default). Covers identity, money, storage, connectors,
      // invites, diagnostics and app settings, so the label names all of that.
      Padding(
        padding: const EdgeInsets.fromLTRB(6, 18, 6, 6),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () => setState(() => _accountOpen = !_accountOpen),
          child: Row(children: [
            Text('ACCOUNT & SETTINGS',
                style: TextStyle(
                    fontFamily: ZineText.display, fontWeight: FontWeight.w700,
                    fontSize: 13.5, letterSpacing: 0.6, color: Zine.ink)),
            const SizedBox(width: 6),
            PhosphorIcon(
                _accountOpen
                    ? PhosphorIcons.caretUp(PhosphorIconsStyle.bold)
                    : PhosphorIcons.caretDown(PhosphorIconsStyle.bold),
                size: 14, color: Zine.inkSoft),
          ]),
        ),
      ),
      // Account essentials. Wallet, Connectors, View Storage, Invite friends and
      // Diagnostics moved here (owner decision 2026-06-19). Identity (the trust
      // ladder + profile hub) also lives here now.
      if (_accountOpen) ...[
        // Owner request 2026-06-29: hide Identity, Billing, Wallet and
        // Diagnostics from the ACCOUNT & SETTINGS menu. Routes/features stay
        // registered — only these menu rows are suppressed. Re-enable by
        // un-commenting the rows below.
        // _acct('identity', 'Identity', PhosphorIcons.identificationCard(PhosphorIconsStyle.bold)),
        // _acct('billing', 'Billing', PhosphorIcons.creditCard(PhosphorIconsStyle.bold)),
        // _acct('avawallet', 'Wallet', PhosphorIcons.wallet(PhosphorIconsStyle.bold)),
        _acct('avaapps', 'Connectors', PhosphorIcons.squaresFour(PhosphorIconsStyle.bold)),
        _acct('avastorage', 'Backup', PhosphorIcons.chartPieSlice(PhosphorIconsStyle.bold)),
        // (Contacts moved OUT of ACCOUNT to a featured tile below Library.)
        // _acct('diagnostics', 'Diagnostics', PhosphorIcons.bug(PhosphorIconsStyle.bold),
        //     onTap: () {
        //       if (!widget.permanent) Navigator.pop(context);
        //       Navigator.push(context, MaterialPageRoute(builder: (_) => const LogPage()));
        //     }),
        _acct('settings', 'Settings', PhosphorIcons.gearSix(PhosphorIconsStyle.bold)),
        // About — app version, build, environment (prod/staging), git build.
        _acct('about', 'About', PhosphorIcons.info(PhosphorIconsStyle.bold),
            onTap: () {
              if (!widget.permanent) Navigator.pop(context);
              Navigator.push(context, MaterialPageRoute(builder: (_) => const AboutScreen()));
            }),
      ],
    ]);
  }

  Widget _acct(String key, String name, IconData icon, {VoidCallback? onTap}) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: ZinePressable(
          onTap: onTap ?? () => widget.onSelect(key),
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

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../core/account_storage.dart';
import '../core/admin_tools.dart';
import '../core/analytics.dart';
import '../core/app_registry.dart';
import '../core/avatar.dart';
import '../core/remote_config.dart';
import '../core/money_api.dart';
import '../core/paid_feature.dart';
import '../core/profile_store.dart';
import '../core/team_api.dart';
import '../core/update_service.dart';
import '../core/ui/zine_widgets.dart';
import '../core/ui/avatok_dark.dart';
import '../features/diagnostics/log_page.dart';
import '../features/settings/about_screen.dart';
import '../identity/identity.dart' show AccountScope;
import 'focus_mode.dart';

/// [SIDEBAR-ENTITLEMENT-CACHE] (AVA-UI-CACHE) Per-account cache of the premium /
/// beta-free entitlement that drives the sidebar plan pill. Two layers so the pill
/// renders with zero delay: an in-memory map keyed by account id (instant across
/// drawer opens within a session) over scoped secure storage (survives cold
/// starts). MANDATORY per-account scoping — one phone is shared by parent + child
/// accounts, so a raw global key would leak one account's entitlement onto another.
class _EntitlementCache {
  static const _s = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  static const _key = 'sidebar_premium_v1';
  static final Map<String, bool> _mem = {};

  static String get _scopeId =>
      (AccountScope.id == null || AccountScope.id!.isEmpty) ? kGuestScope : AccountScope.id!;

  /// Instant, synchronous last-known value for the CURRENT account (null = cold).
  static bool? peek() => _mem[_scopeId];

  /// Load the persisted value for the current account into memory (async, local).
  static Future<bool?> load() async {
    try {
      final v = await readScoped(_s, _key);
      if (v == null || v.isEmpty) return null;
      final b = v == '1';
      _mem[_scopeId] = b;
      return b;
    } catch (_) {
      return null;
    }
  }

  /// Persist the freshly-fetched value for the current account (both layers).
  static Future<void> store(bool premium) async {
    _mem[_scopeId] = premium;
    try { await _s.write(key: scopedKey(_key), value: premium ? '1' : '0'); } catch (_) {/* best-effort */}
  }
}

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
    // Reflect premium status in the sidebar (the green BETA-FREE / PREMIUM pill).
    // [SIDEBAR-ENTITLEMENT-CACHE] (AVA-UI-CACHE) The pill used to wait on a
    // MoneyApi.balance() network round-trip EVERY time the drawer opened, so the
    // "BETA-FREE" button took ~1s to appear. We now render the last-known value
    // instantly from a per-account cache (in-memory this session, scoped secure
    // storage across cold starts) and refresh from the network in the background.
    final cachedPremium = _EntitlementCache.peek();
    if (cachedPremium != null) {
      _premium = cachedPremium; // pre-first-frame → no setState needed
      Analytics.capture('sidebar_entitlement_cache_hit', {'source': 'memory', 'premium': cachedPremium});
    } else {
      _EntitlementCache.load().then((v) {
        if (v != null && mounted) {
          setState(() => _premium = v);
          Analytics.capture('sidebar_entitlement_cache_hit', {'source': 'disk', 'premium': v});
        }
      });
    }
    MoneyApi.balance().then((b) {
      if (!mounted) return;
      final premium = b['premium'] == 1 || b['premium'] == true;
      setState(() => _premium = premium);
      _EntitlementCache.store(premium); // warm the cache for the next drawer open / launch
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
              color: AD.headerFooter,
              border: Border(right: BorderSide(color: AD.borderHairline, width: 1)),
            ),
            child: body,
          );
        }
        return Drawer(
          backgroundColor: AD.headerFooter,
          shape: const Border(right: BorderSide(color: AD.borderHairline, width: 1)),
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
                      fontFamily: ADText.family, fontWeight: FontWeight.w800,
                      fontSize: 19, letterSpacing: -0.38, color: AD.textPrimary),
                  children: const [
                    TextSpan(text: 'Ava'),
                    TextSpan(text: 'TOK', style: TextStyle(color: AD.iconSearch)),
                  ],
                ),
              ),
              const Spacer(),
              if (!widget.permanent)
                AdBackButton(
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
              color: AD.card,
              borderColor: AD.borderControl,
              borderWidth: 1,
              radius: BorderRadius.circular(AD.rListCard),
              boxShadow: const [],
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              child: Row(children: [
                _inkedAvatar(),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Flexible(
                          child: Text(_name, maxLines: 1, overflow: TextOverflow.ellipsis,
                              style: ADText.threadName())),
                      const SizedBox(width: 4),
                      PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
                          size: 14, color: AD.textSecondary),
                    ]),
                    const SizedBox(height: 2),
                    Text(_sub, maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: ADText.statCaption(c: AD.textSecondary)),
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
                  PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), AD.iconSearch),
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
                  PhosphorIcons.folderOpen(PhosphorIconsStyle.bold), AD.online),
              // Contacts — moved out of ACCOUNT to sit below Library; own colour.
              _special('invite', 'Contacts', 'Find & manage people',
                  PhosphorIcons.addressBook(PhosphorIconsStyle.bold), AD.danger),
              // AvaMarketplace — expandable group with its sub-pages (Browse,
              // Create listing, My listings, Archived). ADMIN-ONLY during the
              // pro/live launch (owner decision 2026-07-04): the whole section +
              // its submenus show only when RemoteConfig.marketplaceVisible is
              // true — i.e. the global `marketplaceEnabled` KV flag (kept false
              // in prod) OR the signed-in account is an admin (uid ∈ ADMIN_UIDS).
              // So the operator dogfoods it in prod while testers never see it.
              if (RemoteConfig.marketplaceVisible) _marketplaceSection(),
              // Wallet — was ACCOUNT-only (and commented out there since
              // 2026-06-29), which meant the sidebar had NO way to reach it at
              // all. Restored here as a top-level item directly under
              // Marketplace (owner request). Always shown — unlike Marketplace
              // itself, Wallet isn't admin/flag-gated.
              _special('avawallet', 'Wallet', 'Balance & Tokens',
                  PhosphorIcons.wallet(PhosphorIconsStyle.bold), AD.online),
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
                  color: AD.iconVideo,
                  borderColor: AD.borderControl,
                  borderWidth: 1,
                  radius: BorderRadius.circular(AD.rListCard),
                  boxShadow: const [],
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  child: Row(children: [
                    // Pale fill so the badge's Zine.ink glyph stays legible against
                    // the purple Subscribe tile (ZineIconBadge always draws its icon
                    // in dark ink unless the fill is Zine.coral — see AD.card note below).
                    ZineIconBadge(
                        icon: PhosphorIcons.crown(PhosphorIconsStyle.bold), color: Colors.white),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('Subscribe', style: ADText.rowName(c: Colors.white)),
                        const SizedBox(height: 1),
                        Text('Plans & upgrades',
                            style: ADText.statCaption(c: Colors.white70)),
                      ]),
                    ),
                    PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
                        size: 14, color: Colors.white),
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
                    child: Text('APPS', style: ADText.sectionLabel())),
                for (final a in apps) _appRow(a),
              ],
              // Invite friends + Diagnostics moved into the ACCOUNT section
              // (owner 2026-06-19).
              _accountSection(),
            ]),
          ),
          Container(
            decoration: const BoxDecoration(
              border: Border(top: BorderSide(color: AD.borderHairline, width: 1)),
            ),
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: widget.onSignOut,
              child: Row(children: [
                ZineIconBadge(
                    icon: PhosphorIcons.signOut(PhosphorIconsStyle.bold),
                    color: AD.danger, size: 30),
                const SizedBox(width: 12),
                Text('Log out', style: ADText.rowName(c: AD.danger)),
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
      return AdSticker(
        'BETA-FREE',
        kind: AdStickerKind.ok,
        icon: PhosphorIcons.sealCheck(PhosphorIconsStyle.fill),
      );
    }
    // FREE LAUNCH: no paywalls. With billing off, show a plain non-tappable
    // "FREE PLAN" pill (no upgrade route). Reverts to the upgrade chip when
    // billingEnabled flips back on.
    final billingOn = RemoteConfig.billingEnabled;
    return AdSticker(
      billingOn ? 'FREE PLAN · UPGRADE' : 'FREE PLAN',
      kind: AdStickerKind.hint,
      icon: PhosphorIcons.crown(PhosphorIconsStyle.fill),
      onTap: billingOn ? () => widget.onSelect('subscribe') : null,
    );
  }

  Widget _special(String key, String name, String sub, IconData icon, Color color, {bool paid = false, bool paidHidden = false}) {
    final active = widget.current == key;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: ZinePressable(
        onTap: () => widget.onSelect(key),
        color: active ? AD.primaryBadge : AD.card,
        borderColor: AD.borderControl,
        borderWidth: 1,
        radius: BorderRadius.circular(AD.rListCard),
        boxShadow: const [],
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        child: Row(children: [
          ZineIconBadge(icon: icon, color: color),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(name, style: ADText.rowName(c: active ? Colors.white : AD.textPrimary)),
              const SizedBox(height: 1),
              Text(sub, style: ADText.statCaption(c: active ? Colors.white70 : AD.textSecondary)),
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
          color: headerActive ? AD.primaryBadge : AD.card,
          borderColor: AD.borderControl,
          borderWidth: 1,
          radius: BorderRadius.circular(AD.rListCard),
          boxShadow: const [],
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Row(children: [
            ZineIconBadge(icon: PhosphorIcons.storefront(PhosphorIconsStyle.bold), color: AD.danger),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Marketplace', style: ADText.rowName(c: headerActive ? Colors.white : AD.textPrimary)),
                const SizedBox(height: 1),
                Text('Buy, sell & social', style: ADText.statCaption(c: headerActive ? Colors.white70 : AD.textSecondary)),
              ]),
            ),
            PhosphorIcon(
                _marketplaceOpen
                    ? PhosphorIcons.caretUp(PhosphorIconsStyle.bold)
                    : PhosphorIcons.caretDown(PhosphorIconsStyle.bold),
                size: 14, color: AD.textSecondary),
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
          color: AD.card,
          borderColor: AD.borderControl,
          borderWidth: 1,
          radius: BorderRadius.circular(14),
          boxShadow: const <BoxShadow>[],
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          child: Row(children: [
            ZineIconBadge(icon: icon, color: AD.iconSearch, size: 30),
            const SizedBox(width: 11),
            Expanded(child: Text(label, style: ADText.rowName())),
            PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 12, color: AD.textSecondary),
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
        child: Text(headerFor(widget.accountKind).toUpperCase(), style: ADText.sectionLabel()),
      ),
      for (final t in tools) _toolRow(t),
    ];
  }

  Widget _toolRow(AdminTool t) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: ZinePressable(
          onTap: () => widget.onSelect(t.key),
          color: AD.card,
          borderColor: AD.borderControl,
          borderWidth: 1,
          radius: BorderRadius.circular(14),
          boxShadow: const <BoxShadow>[],
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          child: Row(children: [
            ZineIconBadge(icon: t.icon, color: t.color, size: 30),
            const SizedBox(width: 11),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(t.name, style: ADText.rowName()),
                Text(t.tagline, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ADText.preview(c: AD.textSecondary)),
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
          color: AD.card,
          borderColor: AD.borderControl,
          borderWidth: 1,
          radius: BorderRadius.circular(14),
          boxShadow: const <BoxShadow>[],
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          child: Row(children: [
            ZineIconBadge(icon: a.icon, color: a.color, size: 30),
            const SizedBox(width: 11),
            Expanded(child: Text(a.title, style: ADText.rowName())),
            // Owner request 2026-06-27: hide the PAID marker once the user is on
            // a paid plan / topped-up wallet — subscribers shouldn't see it on
            // the AI Voice Agent (or any other premium app) row.
            if (paid && !_premium) ...[
              const PaidBadge(),
              const SizedBox(width: 8),
            ],
            PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
                size: 14, color: AD.textTertiary),
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
        color: AD.card,
        borderColor: AD.borderControl,
        borderWidth: 1,
        radius: BorderRadius.circular(14),
        boxShadow: const <BoxShadow>[],
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        child: Row(children: [
          ZineIconBadge(icon: icon, color: accent, size: 30),
          const SizedBox(width: 11),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: ADText.rowName()),
              if (subtitle != null)
                Text(subtitle, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ADText.preview(c: AD.textSecondary)),
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
              color: AD.card,
              border: Border.all(color: AD.borderAvatar, width: 2),
            ),
            child: Avatar(seed: widget.seed, name: _name, size: 42,
                avatarUrl: _avatarUrl.isEmpty ? null : _avatarUrl),
          ),
          Positioned(
            right: -2, bottom: -2,
            child: Container(
              width: 18, height: 18,
              decoration: BoxDecoration(
                color: AD.primaryBadge, shape: BoxShape.circle,
                border: Border.all(color: AD.borderAvatar, width: 2),
              ),
              child: PhosphorIcon(PhosphorIcons.camera(PhosphorIconsStyle.fill),
                  size: 9, color: Colors.white),
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
                    fontFamily: ADText.family, fontWeight: FontWeight.w800,
                    fontSize: 13.5, letterSpacing: 0.6, color: AD.textPrimary)),
            const SizedBox(width: 6),
            PhosphorIcon(
                _accountOpen
                    ? PhosphorIcons.caretUp(PhosphorIconsStyle.bold)
                    : PhosphorIcons.caretDown(PhosphorIconsStyle.bold),
                size: 14, color: AD.textSecondary),
          ]),
        ),
      ),
      // Account essentials. Wallet, Connectors, View Storage, Invite friends and
      // Diagnostics moved here (owner decision 2026-06-19). Identity (the trust
      // ladder + profile hub) also lives here now.
      if (_accountOpen) ...[
        // Identity re-enabled for everyone (owner request 2026-07-04): the trust
        // ladder + identity-proofs hub (all identity types with green ticks when
        // complete) lives here in ACCOUNT & SETTINGS, visible to all users.
        // Billing, Wallet and Diagnostics stay hidden (owner request 2026-06-29);
        // their routes/features remain registered — only the menu rows are
        // suppressed. Re-enable those by un-commenting their rows below.
        _acct('identity', 'Identity', PhosphorIcons.identificationCard(PhosphorIconsStyle.bold)),
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
        // Update — opens the Google Play listing so the user can tap Play's
        // Update button. No route key: runs the flow directly. Android-only +
        // gated by RemoteConfig.inAppUpdateEnabled (UpdateService no-ops elsewhere).
        _acct('update', 'Update', PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.bold),
            onTap: () {
              if (!widget.permanent) Navigator.pop(context);
              UpdateService.runManual();
            }),
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
          color: AD.card,
          borderColor: AD.borderControl,
          borderWidth: 1,
          radius: BorderRadius.circular(14),
          boxShadow: const <BoxShadow>[],
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          child: Row(children: [
            // ZineIconBadge always renders its glyph in Zine.ink (dark) unless the
            // fill is Zine.coral — so a neutral badge needs a PALE fill to stay
            // legible on the dark v2 surface (mirrors the old Zine.paper2 intent).
            ZineIconBadge(icon: icon, color: Colors.white, size: 30),
            const SizedBox(width: 11),
            Expanded(child: Text(name, style: ADText.rowName())),
          ]),
        ),
      );
}

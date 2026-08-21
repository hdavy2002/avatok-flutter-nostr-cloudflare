import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/zine_widgets.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/breakpoints.dart';
import '../../core/avatar.dart';
import '../../core/profile_store.dart';
import '../../core/remote_config.dart';
import '../../core/theme.dart';
import '../../core/update_service.dart';
import '../../features/notifications/notifications_screen.dart';
import '../../features/profile/profile_screen.dart';
import '../../features/wallet/wallet_balance_chip.dart';
import '../../identity/identity.dart';
import '../shell_v2.dart';
import 'app_order_screen.dart';
import 'shell_destinations.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/rajasthani_motifs.dart';

/// A single destination in a shell footer (app switcher on Home, app tabs inside
/// a sub-app).
class ShellNavItem {
  final IconData icon;
  final IconData selectedIcon;
  final String label;
  const ShellNavItem(this.icon, this.selectedIcon, this.label);
}

/// The bordered, paper-2 [NavigationBar] used by every shell root, styled to
/// match the existing messenger footer (ink top border, lime indicator).
Widget shellNavBar({
  required int selectedIndex,
  required List<ShellNavItem> items,
  required ValueChanged<int> onSelected,
  Color? indicatorColor, // Home passes the user's accent (personalisation §D)
}) {
  // [RAJ-SEAMS-1] Footer seam — one hook covering every shell root, since
  // `shellNavBar()` is the single function they all call for the bottom bar
  // (design/seams/patches.md §5). The TorranDivider that used to be here is
  // retired: the owner replaced the drape with five seam styles, and the
  // footer's is always the flipped Double wave on an INDIGO band.
  //
  // The band moved turquoise -> indigo, which is why every label and icon below
  // is now routed through `AD.onBand`. Indigo is a DARK band, so ink type on it
  // is nearly invisible; the nav's foreground was ink only because the footer
  // used to be turquoise.
  //
  // DEVIATION FROM THE PATCH, deliberate and carried over: patches.md §5 writes
  // the band as a raw `Color(0xFF2E4A8C)` literal, which the design guard fails
  // on — `AD.bandIndigo` is that same value. `indicatorColor` is left alone: it
  // is the SELECTED-PILL accent (Home passes the user's personalisation accent),
  // not the band, so it must not be fed to the seam.
  const band = AD.bandIndigo;
  final onBand = AD.onBand(band);
  return Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      const DoubleWaveSeam(bandColor: band, flip: true),
      Container(
        decoration: const BoxDecoration(color: band),
        // [RAJ-SEAMS-1] `labelTextStyle` and `iconTheme` live on
        // NavigationBarThemeData, NOT on the NavigationBar widget — passing
        // either directly to the widget does not compile. This wrapper is the
        // pattern already proven in features/avaphone/ava_phone_screen.dart.
        // The icon colour is ALSO set per-destination below, because the theme
        // only reaches icons that don't carry their own colour.
        child: NavigationBarTheme(
          data: NavigationBarThemeData(
            backgroundColor: band,
            labelTextStyle:
                WidgetStatePropertyAll(ADText.sectionLabel(c: onBand)),
            iconTheme: WidgetStatePropertyAll(IconThemeData(color: onBand)),
          ),
          child: NavigationBar(
            selectedIndex: selectedIndex,
            onDestinationSelected: onSelected,
            backgroundColor: band,
            surfaceTintColor: Colors.transparent,
            indicatorColor: indicatorColor ?? AD.primaryBadge,
            destinations: [
              for (final it in items)
                NavigationDestination(
                  icon: PhosphorIcon(it.icon, color: onBand),
                  selectedIcon: PhosphorIcon(it.selectedIcon, color: onBand),
                  label: it.label,
                ),
            ],
          ),
        ),
      ),
    ],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// [UI-HEADER-2026] THE shared AvaTOK header band.
// ─────────────────────────────────────────────────────────────────────────────

/// Height of the header ROW itself at full size (the band's own top inset is
/// added on top by `SafeArea`, and by `Scaffold` when this is used in the
/// `appBar:` slot).
///
/// [RESP-SMALL-2] This is the CEILING, not the painted height — see
/// [avaTokHeaderRowHeight], which trims it on narrow widths. It stays the value
/// [AvaTokHeader.preferredSize] reports, because that getter has no
/// `BuildContext` to ask the width from.
const double kAvaTokHeaderRowHeight = 56;

/// The square box every header control is laid out in (`_MenuButton`,
/// `_HeaderBell`). Named because [avaTokHeaderRowHeight] floors itself on it:
/// a shorter row than this would clip the controls, which is the same trap
/// `[RESP-SMALL-1]` hit when it floored the chat-thread header at 48 for its
/// 46px `IconButton` constraints.
const double kAvaTokHeaderControlBox = 38;

/// [RESP-SMALL-2] The PAINTED header-row height for this width.
///
/// `AvaTokHeader` is mounted on every root (messenger, Calls, Services), so it
/// is unscrollable chrome on every primary screen — exactly the category
/// [ZineBreakpoints.chromeScale] exists to trim on a small device, where each
/// fixed pixel comes straight out of the content area.
///
/// Two rules, both deliberate:
///
///  * It is FLOORED at "the controls plus their own scaled padding"
///    ([kAvaTokHeaderControlBox] + the row's vertical padding). The controls do
///    NOT shrink — a tap target that shrinks on the smallest screen is
///    backwards (see the scope note on [ZineBreakpoints.chromeScale]) — so a
///    row shorter than that is not a saving, it is a RenderFlex overflow. The
///    floor lands at ~51.6 (0.85x) and ~49.5 (0.72x), i.e. never below the 48
///    that `[RESP-SMALL-1]` used for the chat-thread header.
///  * It never EXCEEDS [kAvaTokHeaderRowHeight], so it can never exceed what
///    `preferredSize` reserves.
double avaTokHeaderRowHeight(BuildContext context) {
  final s = ZineBreakpoints.chromeScale(context);
  return math.max(
    kAvaTokHeaderRowHeight * s,
    kAvaTokHeaderControlBox + 2 * Msg.s2 * s,
  );
}

/// The one header treatment every root and major page inherits: menu affordance ·
/// page name · wallet chip · profile avatar · notification bell. **Only the page
/// name changes between pages.**
///
/// Three things this deliberately does that a plain `AppBar` does not:
///
///  * It paints the band BEHIND the status bar (`Container` outside `SafeArea`),
///    so there is never a cream strip above an indigo header, and it stamps
///    [AvaTheme.bandOverlay] so the clock/Wi-Fi/battery glyphs are WHITE on the
///    dark band. A hand-rolled header without that `AnnotatedRegion` inherits
///    whatever the previous route left behind.
///  * It never lets the title push the trailing controls off screen — see
///    [AD.shortTitle].
///  * It does NOT draw the wave. The seam is a decorative OVERLAY on the
///    scrolling content below (`SeamOverlay`), never a layout sibling; a
///    sibling reserves ~36px whose transparent half can only reveal the
///    Scaffold's cream, which is exactly the "creamy strip hiding my messages"
///    the owner rejected. Hosts keep the first control clear of the wave with
///    [AD.searchDockTopGap].
///
/// Mount it in the `appBar:` slot (it is a [PreferredSizeWidget]) or as the
/// first child of a body `Column`. When [bottom] is set — a tab strip welded to
/// the band — prefer the body form, or pass [bottomHeight] so the `appBar:`
/// slot reserves the right space.
class AvaTokHeader extends StatelessWidget implements PreferredSizeWidget {
  /// The ONLY thing that varies between pages. Brand spelling is `AvaTOK`.
  final String title;

  /// Menu tap. `null` opens the enclosing `Scaffold`'s drawer.
  final VoidCallback? onMenu;

  /// Replaces the menu button entirely (e.g. a back button on a pushed screen).
  final Widget? leading;

  /// Extra trailing controls, inserted between the avatar and the bell.
  final List<Widget> actions;

  final bool showWallet;
  final bool showAvatar;
  final bool showBell;

  /// Override the profile avatar (the messenger passes its status-ring avatar).
  final Widget? avatar;

  /// Unread count on the bell. 0 hides the badge.
  final int notificationCount;

  /// Bell tap. `null` pushes the notification centre.
  final VoidCallback? onBell;

  /// Welded to the bottom of the band, inside the same SafeArea (a tab strip).
  final Widget? bottom;

  /// Height of [bottom]; only needed when this is used in an `appBar:` slot.
  final double bottomHeight;

  const AvaTokHeader({
    super.key,
    required this.title,
    this.onMenu,
    this.leading,
    this.actions = const [],
    this.showWallet = true,
    this.showAvatar = true,
    this.showBell = true,
    this.avatar,
    this.notificationCount = 0,
    this.onBell,
    this.bottom,
    this.bottomHeight = 0,
  });

  /// [RESP-SMALL-2] Reports the UNSCALED height on purpose.
  ///
  /// This getter has no `BuildContext`, so it cannot ask
  /// [ZineBreakpoints.chromeScale] anything, and a `PreferredSizeWidget` cannot
  /// be handed the width without changing every call site. Rather than guess,
  /// the invariant is made one-sided: [avaTokHeaderRowHeight] is capped at
  /// [kAvaTokHeaderRowHeight], so the painted row is always <= what is reported
  /// here, never more. A header that paints TALLER than its preferredSize is
  /// the case that clips; painting shorter cannot.
  ///
  /// Both possible `Scaffold` behaviours for the shorter child are benign, and
  /// this was NOT verified against a running device (no local toolchain):
  /// if the app-bar slot is laid out loosely, the body simply starts at the
  /// measured height and the trim is real; if it is stretched to the reported
  /// height instead, the surplus is inside the band-coloured `Container` below,
  /// so it renders exactly as it does today. Neither outcome is a cream gap or
  /// a clipped control. Two of the three call sites (chat_list, avadial_root)
  /// mount this in a body `Column` and never consult this getter at all.
  @override
  Size get preferredSize =>
      Size.fromHeight(kAvaTokHeaderRowHeight + bottomHeight);

  @override
  Widget build(BuildContext context) {
    const band = AD.headerFooter;
    final onBand = AD.onBand(band);
    final s = ZineBreakpoints.chromeScale(context);

    final trailing = <Widget>[
      if (showWallet) const WalletBalanceChip(),
      if (showAvatar) avatar ?? const ShellProfileAvatar(),
      ...actions,
      if (showBell)
        _HeaderBell(count: notificationCount, color: onBand, onTap: onBell),
    ];

    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: AvaTheme.bandOverlay(band),
      child: Container(
        color: band,
        child: SafeArea(
          bottom: false,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            SizedBox(
              // [RESP-SMALL-2] Width-aware: the band is unscrollable chrome on
              // every root, so it trims on narrow phones. See
              // `avaTokHeaderRowHeight` for the floor and the cap.
              height: avaTokHeaderRowHeight(context),
              child: Padding(
                // Only the VERTICAL padding scales — shrinking the horizontal
                // gutters on the narrowest phone pushes the wordmark and the
                // trailing controls toward the edges, where they are already
                // hardest to hit ([RESP-SMALL-1]).
                padding: EdgeInsets.fromLTRB(
                    Msg.s4, Msg.s2 * s, Msg.s3, Msg.s2 * s),
                child: Row(children: [
                  leading ?? _MenuButton(onTap: onMenu, color: onBand),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Builder(builder: (ctx) {
                      // The band is a FIXED height, so cap the OS accessibility
                      // scale feeding the title at 1.15x — same budget rule as
                      // ZineAppBar. This does not touch body text anywhere.
                      final os = MediaQuery.textScalerOf(ctx).scale(1.0);
                      return MediaQuery(
                        data: MediaQuery.of(ctx).copyWith(
                            textScaler:
                                TextScaler.linear(os > 1.15 ? 1.15 : os)),
                        child: Text(
                          AD.shortTitle(ctx, title),
                          maxLines: 1,
                          softWrap: false,
                          overflow: TextOverflow.ellipsis,
                          style: ADText.appTitle(c: onBand),
                        ),
                      );
                    }),
                  ),
                  for (var i = 0; i < trailing.length; i++) ...[
                    if (i > 0) const SizedBox(width: 10),
                    trailing[i],
                  ],
                ]),
              ),
            ),
            if (bottom != null) bottom!,
          ]),
        ),
      ),
    );
  }
}

/// Hamburger. Falls back to the enclosing Scaffold's drawer when no [onTap] is
/// given — a `Builder` is required for that so the context is BELOW the
/// Scaffold, which is the classic "Scaffold.of() called with a context that
/// does not contain a Scaffold" trap.
class _MenuButton extends StatelessWidget {
  final VoidCallback? onTap;
  final Color color;
  const _MenuButton({required this.onTap, required this.color});

  @override
  Widget build(BuildContext context) => Builder(
        builder: (ctx) => GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTap ?? () => Scaffold.of(ctx).openDrawer(),
          child: SizedBox(
            // [RESP-SMALL-2] Named, not 38: the row height floors itself on
            // this box. Tap targets never scale down (breakpoints.dart).
            width: kAvaTokHeaderControlBox,
            height: kAvaTokHeaderControlBox,
            child: Icon(PhosphorIcons.list(PhosphorIconsStyle.bold),
                size: 22, color: color),
          ),
        ),
      );
}

/// Notification bell + rani unread badge.
class _HeaderBell extends StatelessWidget {
  final int count;
  final Color color;
  final VoidCallback? onTap;
  const _HeaderBell({required this.count, required this.color, this.onTap});

  @override
  Widget build(BuildContext context) {
    final bell = GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap ??
          () => Navigator.of(context).push(MaterialPageRoute<void>(
              builder: (_) => const NotificationsScreen())),
      child: SizedBox(
        // [RESP-SMALL-2] See `_MenuButton` — same box, same reason.
        width: kAvaTokHeaderControlBox,
        height: kAvaTokHeaderControlBox,
        child: Center(
          child: PhosphorIcon(PhosphorIcons.bell(PhosphorIconsStyle.bold),
              size: 20, color: color),
        ),
      ),
    );
    if (count <= 0) return bell;
    return Stack(clipBehavior: Clip.none, children: [
      bell,
      Positioned(
        right: 0,
        top: 2,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: Msg.s2, vertical: 1),
          constraints: const BoxConstraints(minWidth: 16, minHeight: 16),
          decoration: BoxDecoration(
            color: AD.primaryBadge,
            borderRadius: Msg.brPill,
            border: Border.all(color: AD.headerFooter, width: 2),
          ),
          alignment: Alignment.center,
          child: Text(count > 99 ? '99+' : '$count',
              textAlign: TextAlign.center,
              style: const TextStyle(
                  color: Colors.white,
                  fontSize: 9.5,
                  fontWeight: FontWeight.w700,
                  height: 1.0)),
        ),
      ),
    ]);
  }
}

/// The header's profile avatar: my own photo when I have one, my generated
/// initials avatar otherwise. Tap → Profile.
///
/// Deliberately loads through [ProfileStore], which is per-account scoped and
/// in-memory cached — one phone is shared by a parent and each child account,
/// so this must never serve another account's photo.
class ShellProfileAvatar extends StatefulWidget {
  final double size;
  const ShellProfileAvatar({super.key, this.size = 32});

  @override
  State<ShellProfileAvatar> createState() => _ShellProfileAvatarState();
}

class _ShellProfileAvatarState extends State<ShellProfileAvatar> {
  String _url = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final p = await ProfileStore().load();
      // An empty URL never overwrites a good one — a profile fetch that lands
      // empty (mid account restore) would otherwise blank the header.
      if (mounted && p.avatarUrl.isNotEmpty && p.avatarUrl != _url) {
        setState(() => _url = p.avatarUrl);
      }
    } catch (_) {/* header avatar is best-effort — initials are a fine state */}
  }

  @override
  Widget build(BuildContext context) => GestureDetector(
        behavior: HitTestBehavior.opaque,
        // Pushed directly rather than via `openShellDestination`, which calls
        // `ShellScope.of` and therefore asserts when this header is mounted on
        // a screen outside ShellV2. The header has to work everywhere.
        onTap: () => Navigator.of(context)
            .push(MaterialPageRoute<void>(builder: (_) => const ProfileScreen())),
        child: Avatar(
          seed: AccountScope.id ?? 'me',
          name: 'You',
          size: widget.size,
          avatarUrl: _url.isEmpty ? null : _url,
        ),
      );
}

/// A themed empty state used by placeholder tabs ("coming with AvaDial", card
/// unavailable states, etc.).
class ShellEmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final Color color;
  /// [RAJ-SEAMS-1] Optional illustration asset (see `core/ui/illustrations.dart`).
  /// When set it replaces the icon badge; when null every existing call site
  /// renders exactly as before. Decorative only — it always sits above the
  /// title, so it is excluded from semantics.
  final String? illustration;
  const ShellEmptyState({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
    this.color = AD.iconSearch,
    this.illustration,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 36),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          if (illustration != null)
            SvgPicture.asset(illustration!,
                height: 140, fit: BoxFit.contain, excludeFromSemantics: true)
          else
            ZineIconBadge(icon: icon, color: color, size: 56),
          const SizedBox(height: 16),
          Text(title, textAlign: TextAlign.center, style: ADText.threadName().copyWith(fontSize: 18)),
          const SizedBox(height: 8),
          Text(subtitle, textAlign: TextAlign.center,
              style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 14)),
        ]),
      ),
    );
  }
}

/// The cross-app sidebar shared by the Home, AvaDial and Services roots. Carries
/// the app switcher (Home + the OTHER three apps), an Ask Ava entry, Settings,
/// plus any app-specific [extra] rows the root passes in. Reuses the AvaSidebar
/// visual language (ink-bordered pressable rows) without depending on its
/// messenger-specific state.
class ShellSidebar extends StatelessWidget {
  /// The root currently showing this sidebar (its own app row is omitted).
  final RootId current;

  /// App-specific menu rows shown under the app switcher (e.g. Services →
  /// Marketplace/Wallet/Payout; Home → Cards/Identity/Backup/About/Update).
  final List<Widget> extra;

  const ShellSidebar({super.key, required this.current, this.extra = const []});

  @override
  Widget build(BuildContext context) {
    final scope = ShellScope.of(context);

    void go(RootId r) {
      Navigator.of(context).maybePop(); // close the drawer
      scope.switchRoot(r);
    }

    Widget appRow(RootId r, String name, String sub, IconData icon, Color color) {
      if (r == current) return const SizedBox.shrink();
      return _SidebarRow(
        icon: icon,
        color: color,
        title: name,
        subtitle: sub,
        onTap: () => go(r),
      );
    }

    return Drawer(
      backgroundColor: AD.menu,
      shape: const Border(right: BorderSide(color: AD.borderHairline, width: 1)),
      width: MediaQuery.of(context).size.width * 0.82,
      child: SafeArea(
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s4, Msg.s4, Msg.s3),
            child: Row(children: [
              const ZineLogoMark(size: 22),
              const SizedBox(width: 8),
              Text.rich(
                TextSpan(
                  style: TextStyle(
                      fontFamily: ADText.family,
                      fontWeight: FontWeight.w700,
                      fontSize: 19,
                      letterSpacing: -0.38,
                      color: AD.textPrimary),
                  children: [
                    const TextSpan(text: 'Ava'),
                    TextSpan(text: 'TOK', style: TextStyle(color: AD.iconSearch)),
                  ],
                ),
              ),
              const Spacer(),
              AdBackButton(
                icon: PhosphorIcons.x(PhosphorIconsStyle.bold),
                onTap: () => Navigator.of(context).maybePop(),
              ),
            ]),
          ),
          Expanded(
            child: ListView(padding: const EdgeInsets.fromLTRB(Msg.s4, 0, Msg.s4, Msg.s3), children: [
              Padding(
                  padding: const EdgeInsets.fromLTRB(Msg.s2, Msg.s2, Msg.s2, Msg.s2),
                  child: Text('APPS', style: ADText.sectionLabel(c: AD.textTertiary))),
              appRow(RootId.avaTalk, 'AvaTOK', 'Messages & in-network calls',
                  PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), AD.online),
              // [IOS-PORT-DISABLE-1] 2026-08-14 owner rename: 'AvaDialer' →
              // 'Calls' (display-only; RootId.key stays 'avadial'). Mirror of
              // app_switcher_bar `_meta`.
              appRow(RootId.avaDial, 'Calls', 'AvaTOK calls, contacts & voicemail',
                  PhosphorIcons.phone(PhosphorIconsStyle.bold), AD.iconSearch),
              appRow(RootId.services,
                  RemoteConfig.marketplaceVisible ? 'Marketplace' : 'Services',
                  'Buy, sell, manage listings & wallet',
                  PhosphorIcons.storefront(PhosphorIconsStyle.bold), AD.danger),
              _SidebarRow(
                icon: PhosphorIcons.sparkle(PhosphorIconsStyle.bold),
                color: AD.iconVideo,
                // 2026-07-14 owner rename: 'Ask Ava' → 'AvaBrain', matching the
                // fixed AI action label in app_switcher_bar. Display-only — the
                // analytics key stays `askava`.
                title: 'AvaBrain',
                subtitle: 'Universal assistant',
                onTap: () {
                  Navigator.of(context).maybePop();
                  scope.askAva(current.key); // seed the assistant with this app's context
                },
              ),
              if (extra.isNotEmpty) ...[
                const SizedBox(height: Msg.s1),
                ...extra,
              ],
              const SizedBox(height: Msg.s1),
              Padding(
                  padding: const EdgeInsets.fromLTRB(Msg.s2, Msg.s2, Msg.s2, Msg.s2),
                  child: Text('MORE', style: ADText.sectionLabel(c: AD.textTertiary))),
              // Rescued from the retired Home dashboard drawer (2026-07-12 nav
              // rebrand) so they stay reachable from every app, not just Home.
              _SidebarRow(
                icon: PhosphorIcons.listNumbers(PhosphorIconsStyle.bold),
                color: AD.iconVideo,
                title: 'App order',
                subtitle: 'Reorder apps & pick your landing app',
                onTap: () {
                  Navigator.of(context).maybePop();
                  Navigator.of(context)
                      .push(MaterialPageRoute(builder: (_) => const AppOrderScreen()));
                },
              ),
              _SidebarRow(
                icon: PhosphorIcons.identificationCard(PhosphorIconsStyle.bold),
                color: AD.iconSearch,
                title: 'Identity',
                onTap: () {
                  Navigator.of(context).maybePop();
                  openShellDestination(context, 'identity');
                },
              ),
              _SidebarRow(
                icon: PhosphorIcons.chartPieSlice(PhosphorIconsStyle.bold),
                color: AD.online,
                title: 'Backup',
                onTap: () {
                  Navigator.of(context).maybePop();
                  openShellDestination(context, 'avastorage');
                },
              ),
              _SidebarRow(
                icon: PhosphorIcons.info(PhosphorIconsStyle.bold),
                color: AD.iconVideo,
                title: 'About',
                onTap: () {
                  Navigator.of(context).maybePop();
                  openShellDestination(context, 'about');
                },
              ),
              _SidebarRow(
                icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.bold),
                color: AD.danger,
                title: 'Update',
                onTap: () {
                  Navigator.of(context).maybePop();
                  UpdateService.runManual();
                },
              ),
              const SizedBox(height: Msg.s1),
              _SidebarRow(
                icon: PhosphorIcons.gearSix(PhosphorIconsStyle.bold),
                color: AD.textTertiary,
                title: 'Settings',
                onTap: () {
                  Navigator.of(context).maybePop();
                  openShellDestination(context, 'settings');
                },
              ),
            ]),
          ),
          Container(
            decoration: const BoxDecoration(
              border: Border(top: BorderSide(color: AD.borderHairline, width: 1)),
            ),
            padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s3, Msg.s4, Msg.s3),
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: scope.onSignOut,
              child: Row(children: [
                ZineIconBadge(
                    icon: PhosphorIcons.signOut(PhosphorIconsStyle.bold), color: AD.danger, size: 30),
                const SizedBox(width: 12),
                Text('Log out', style: ADText.rowName(c: AD.danger).copyWith(fontSize: 15)),
              ]),
            ),
          ),
        ]),
      ),
    );
  }
}

/// A sidebar/menu row helper. Public within v2 so roots can build their own
/// app-specific entries (Cards, Marketplace, etc.) with the same look.
class ShellMenuRow extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String title;
  final String? subtitle;
  final VoidCallback onTap;
  const ShellMenuRow({
    super.key,
    required this.icon,
    required this.color,
    required this.title,
    required this.onTap,
    this.subtitle,
  });

  @override
  Widget build(BuildContext context) => _SidebarRow(
        icon: icon,
        color: color,
        title: title,
        subtitle: subtitle,
        onTap: onTap,
      );
}

class _SidebarRow extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String title;
  final String? subtitle;
  final VoidCallback onTap;
  const _SidebarRow({
    required this.icon,
    required this.color,
    required this.title,
    required this.onTap,
    this.subtitle,
  });

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: ZinePressable(
          onTap: onTap,
          color: AD.card,
          borderColor: AD.borderControl,
          borderWidth: 1,
          radius: BorderRadius.circular(AD.rListCard),
          boxShadow: const [],
          padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s3),
          child: Row(children: [
            ZineIconBadge(icon: icon, color: color),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: ADText.threadName().copyWith(fontSize: 15)),
                if (subtitle != null) ...[
                  const SizedBox(height: 1),
                  Text(subtitle!, style: ADText.statCaption(c: AD.textSecondary).copyWith(fontSize: 10)),
                ],
              ]),
            ),
            PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 14, color: AD.textSecondary),
          ]),
        ),
      );
}

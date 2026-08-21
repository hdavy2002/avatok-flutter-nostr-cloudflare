import 'package:flutter/material.dart';

import '../../core/ui/messenger_theme.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:flutter/services.dart';

import '../../core/remote_config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/rajasthani_motifs.dart';
import '../../features/avadial/inbox/inbox_list_screen.dart';
import '../../features/avadial/sms/sms_unread_store.dart';
import '../shell_v2.dart';

/// The persistent, shell-level app switcher (2026-07-12 nav rebrand — supersedes
/// the old Home-only footer / `HomeAppSwitcherBar`). Renders the three root icons
/// — **AvaTOK** (avaTalk), **Calls** (avaDial), **Services** (services) — in the
/// user's chosen [order], each LONG-PRESS DRAGGABLE to a new position, plus a FIXED
/// "Inbox" action inserted right after the AvaDialer slot (never
/// draggable/targetable — a push, not a root switch), gated on
/// `RemoteConfig.pstnVoicemail`.
///
/// [AVA-RCPT-8 footer move] The "AvaBrain" fixed action that used to live at the
/// far right of this bar was REMOVED from the footer (owner spec) and replaced
/// by "Inbox" above. AvaBrain is not gone — it stays reachable from every root
/// via the ShellSidebar drawer's "AvaBrain" row (shell/v2/shell_chrome.dart),
/// which still calls [onAskAva]/`ShellScope.askAva`.
///
/// Rendered ONCE by [ShellV2] itself (not by each root), so the same icons stay in
/// the same place across every app — switching apps never moves or hides this bar.
/// Full-size icons/labels (66px bar) — a shrunk 50px variant was tried and reverted
/// per owner feedback (2026-07-12) since it made everything too small to read.
///
/// The FIRST root in [order] is the landing app on cold open. Reorders are
/// committed via [onReorder]; taps via [onSelect]; Inbox via [onOpenInbox].
class AppSwitcherBar extends StatefulWidget {
  final List<RootId> order;
  final RootId activeRoot;

  /// True while the universal Ask Ava overlay is open. When set, the active
  /// indicator moves to the fixed "Ava" action and NO root is shown as selected
  /// (Ask Ava overlays the active root but is not itself a root). Fixes the bug
  /// where tapping Ava left its icon white and the orange pill stuck on the
  /// previously-active root (owner bug 2026-07-14).
  final bool askAvaActive;

  final void Function(RootId) onSelect;
  final void Function(List<RootId>) onReorder;
  final VoidCallback onAskAva;

  /// [AVA-RCPT-8 footer move] Opens the AvaDial Inbox (voicemail/Ava
  /// Receptionist thread list) as a full-screen route on the active root's
  /// navigator — pushed from a FIXED footer slot, not a draggable root, so
  /// this callback is a simple push rather than a `switchRoot`. Only invoked
  /// while the slot is actually shown (RemoteConfig.pstnVoicemail on).
  final VoidCallback onOpenInbox;

  /// True while the Inbox route is on top. Mirrors [askAvaActive]'s fix (owner
  /// bug 2026-07-14, re-reported for Inbox 2026-07-16): while the pushed Inbox
  /// overlay is showing, the active indicator moves to the "Inbox" slot and NO
  /// root is shown as selected — otherwise the footer keeps highlighting the
  /// root underneath and Inbox looks unselected while you're inside it.
  final bool inboxActive;

  /// [AFF-NAV-1] Opens AvaAffiliate (a PUSH onto the active root's navigator,
  /// like [onOpenInbox] — Affiliate is a screen, not a root). Only ever invoked
  /// from the slot that TEMPORARILY replaces Services while
  /// `RemoteConfig.avaAffiliateEnabled` is on.
  final VoidCallback onOpenAffiliate;

  /// True while the pushed Affiliate route is on top — same indicator fix as
  /// [inboxActive]/[askAvaActive].
  final bool affiliateActive;

  /// Personalisation accent for the active-root indicator (falls back to lime).
  final Color? indicatorColor;

  const AppSwitcherBar({
    super.key,
    required this.order,
    required this.activeRoot,
    this.askAvaActive = false,
    required this.onSelect,
    required this.onReorder,
    required this.onAskAva,
    required this.onOpenInbox,
    this.inboxActive = false,
    required this.onOpenAffiliate,
    this.affiliateActive = false,
    this.indicatorColor,
  });

  @override
  State<AppSwitcherBar> createState() => _AppSwitcherBarState();
}

class _AppSwitcherBarState extends State<AppSwitcherBar> {
  // Index (within widget.order) currently being dragged, and the slot hovered as
  // a drop target — both drive the lift/shift animations.
  int? _dragging;
  int? _hoverTarget;
  // SHELL-NAV-DRAWER-1: collapsed by default to return chat height to content.
  // A clear handle remains visible and supports both tap and vertical swipe.
  bool _expanded = false;

  @override
  void initState() {
    super.initState();
    // [AVA-SMS-BADGE-1] The bar is rendered once by ShellV2 and lives for the
    // whole session — the natural place to boot the unread-SMS counter that
    // feeds the red count on the AvaDialer icon. Idempotent + cheap when the
    // avaSms flag is off or ROLE_SMS isn't held (count stays 0, no badge).
    SmsUnreadStore.I.start();
  }

  // icon · selectedIcon · label per root.
  // 2026-08-19: the third root is displayed as Marketplace when the server
  // flag is on. The persisted RootId remains `services` because that stable
  // route also carries Wallet/Payout entries in its drawer.
  // AvaBrain is a fixed global action so it is reachable in one tap from every
  // root; it is deliberately not draggable because it is not a root navigator.
  // These are DISPLAY-ONLY — `RootId.key` ('avatalk'/'avadial'/'services') still
  // drives analytics, persisted order and restoration IDs, so the rename is safe.
  // NOTE: this map is duplicated in shell/v2/app_order_screen.dart and
  // shell/v2/shell_chrome.dart — all three must be kept in sync.
  // Not `const`: PhosphorIcons.x(style) is a function call, not a constant.
  static final Map<RootId, (IconData, IconData, String)> _meta = {
    RootId.avaDial: (PhosphorIcons.phone(PhosphorIconsStyle.regular), PhosphorIcons.phone(PhosphorIconsStyle.fill), 'Calls'),
    RootId.avaTalk: (PhosphorIcons.chatCircle(PhosphorIconsStyle.regular), PhosphorIcons.chatCircle(PhosphorIconsStyle.fill), 'AvaTOK'),
    RootId.services: (PhosphorIcons.storefront(PhosphorIconsStyle.regular), PhosphorIcons.storefront(PhosphorIconsStyle.fill), 'Services'),
  };

  /// [AFF-NAV-1] Footer display for the AvaAffiliate slot that takes over the
  /// Services position while the affiliate kill switch is ON.
  static final (IconData, IconData, String) _affiliateMeta =
      (PhosphorIcons.handshake(PhosphorIconsStyle.regular), PhosphorIcons.handshake(PhosphorIconsStyle.fill), 'Affiliate');

  /// [AFF-NAV-1] (owner 2026-08-05) Services is DEFERRED, not deleted: while
  /// `avaAffiliateEnabled` is on, the Services footer slot renders AvaAffiliate
  /// instead and a tap PUSHES [AffiliateHomeScreen] rather than switching root.
  ///
  /// Deliberately flag-CONDITIONAL rather than an unconditional removal:
  /// `avaAffiliateEnabled` is false in production, and an unconditional swap
  /// would ship an empty (or dead-end "coming soon") footer slot to live users.
  /// With the flag off the footer is byte-for-byte what it is today — Services.
  ///
  /// NOTHING about Services is removed: `RootId.services` stays in the persisted
  /// order (so the slot keeps its position and stays drag-reorderable), the
  /// ServicesRoot navigator stays mounted in the shell's IndexedStack, and the
  /// ShellSidebar's "Services" row (shell_chrome.dart) still switches to it.
  /// Re-enabling the footer icon is one flag flip back to false.
  bool get _affiliateTakesServicesSlot =>
      RemoteConfig.avaAffiliateEnabled && !RemoteConfig.marketplaceVisible;

  Color get _indicator => widget.indicatorColor ?? AD.primaryBadge;

  // [RAJ-SEAMS-1] patches.md §6: "App switcher / footer (all)" -> indigo, 2C
  // Double wave (flip). Indigo is a DARK band, so every icon/label/badge
  // backing drawn straight on the bar must flip to AD.onBand.
  static const _band = AD.bandIndigo;
  Color get _onBand => AD.onBand(_band);

  void _commitMove(int from, int to) {
    if (from == to) return;
    final next = List<RootId>.from(widget.order);
    final moved = next.removeAt(from);
    // Clamp the insertion index after the removal shift.
    final insertAt = to.clamp(0, next.length);
    next.insert(insertAt, moved);
    HapticFeedback.selectionClick();
    widget.onReorder(next);
  }

  void _setExpanded(bool value) {
    if (_expanded == value) return;
    HapticFeedback.selectionClick();
    setState(() => _expanded = value);
  }

  void _activate(VoidCallback action) {
    if (_expanded) setState(() => _expanded = false);
    action();
  }

  @override
  Widget build(BuildContext context) {
    // [RAJ-SEAMS-1] TorranDivider is retired. This is the FOOTER, so the seam
    // sits ABOVE the bar, flipped — mirrors shellNavBar() in shell_chrome.dart
    // (patches.md §5/§6). Band moved AD.headerFooter -> AD.bandIndigo.
    // [RAJ-INDIGO-1] The DoubleWaveSeam that used to be the first child of this
    // Column has MOVED to `shell/shell_v2.dart`, where it is a bottom-pinned
    // overlay on the shell body. Owner, pic 7 №3 / pic 8: the seam's
    // transparent half sat inside `bottomNavigationBar`, so the only thing
    // visible through the wave was the Scaffold's cream — a dead cream band
    // between the content and the footer. Overlaid on the body instead, the
    // list scrolls through the scallops.
    //
    // It has to live in the shell rather than here because this widget IS the
    // bottomNavigationBar: nothing painted inside it can appear above its own
    // top edge. Pinning the seam to `bottom: 0` of the body puts it exactly on
    // that edge, and it tracks this bar's height automatically when the app
    // menu expands.
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          decoration: const BoxDecoration(
            color: _band,
          ),
          child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Semantics(
              button: true,
              label: _expanded ? 'Hide app menu' : 'Swipe up to show app menu',
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => _setExpanded(!_expanded),
                onVerticalDragEnd: (details) {
                  final velocity = details.primaryVelocity ?? 0;
                  if (velocity < -80) _setExpanded(true);
                  if (velocity > 80) _setExpanded(false);
                },
                child: SizedBox(
                  height: 40,
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        // Pre-existing bare Material Icons.* (not ours to fix —
                        // left as-is per the design-guard baseline); only the
                        // colour flips for the new indigo band.
                        _expanded
                            ? Icons.keyboard_arrow_down_rounded
                            : Icons.keyboard_arrow_up_rounded,
                        size: 18,
                        color: _onBand,
                      ),
                      const SizedBox(width: Msg.s1),
                      DecoratedBox(
                        decoration: BoxDecoration(
                          color: AD.bubbleOutPlay,
                          borderRadius: BorderRadius.circular(999),
                        ),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                          child: Text(
                            _expanded ? 'Swipe down' : 'Swipe up',
                            style: ADText.sectionLabel(c: Colors.white).copyWith(
                              fontSize: 12,
                              height: 1.1,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            if (_expanded)
              // Keep the proven full-size cells when open. Only the closed state
              // is compact; users never have to target shrunken icons.
              SizedBox(
                height: 66,
                child: Row(
                  children: [
                    for (var i = 0; i < widget.order.length; i++) ...[
                      Expanded(child: _draggableSlot(i)),
                      if (widget.order[i] == RootId.avaDial &&
                          RemoteConfig.pstnVoicemail)
                        Expanded(child: _inboxSlot()),
                    ],
                    Expanded(child: _avaBrainSlot()),
                  ],
                ),
              ),
          ],
        ),
          ),
        ),
      ],
    );
  }

  Widget _draggableSlot(int index) {
    final root = widget.order[index];
    // [AFF-NAV-1] Services slot on loan to AvaAffiliate while the flag is on.
    final affiliate = root == RootId.services && _affiliateTakesServicesSlot;
    // While Ask Ava is open, no root is "active" — the indicator lives on the
    // Ava action instead.
    final item = affiliate
        ? _labelledIcon(
            icon: _affiliateMeta.$1,
            selectedIcon: _affiliateMeta.$2,
            label: _affiliateMeta.$3,
            // Affiliate is a pushed route, not a root: it is "active" only while
            // its own overlay is on top (same rule as Inbox / Ask Ava).
            selected: widget.affiliateActive,
          )
        : _rootItem(root,
            selected: !widget.askAvaActive &&
                !widget.inboxActive &&
                !widget.affiliateActive &&
                root == widget.activeRoot);

    // DragTarget lets any OTHER root be dropped onto this slot; the whole row of
    // three roots is a reorder surface.
    return DragTarget<int>(
      onWillAcceptWithDetails: (d) {
        if (d.data == index) return false;
        setState(() => _hoverTarget = index);
        return true;
      },
      onLeave: (_) => setState(() => _hoverTarget = null),
      onAcceptWithDetails: (d) {
        setState(() => _hoverTarget = null);
        _commitMove(d.data, index);
      },
      builder: (context, candidate, rejected) {
        final isHover = _hoverTarget == index && candidate.isNotEmpty;
        return LongPressDraggable<int>(
          data: index,
          dragAnchorStrategy: pointerDragAnchorStrategy,
          onDragStarted: () {
            HapticFeedback.mediumImpact();
            setState(() => _dragging = index);
          },
          onDragEnd: (_) => setState(() {
            _dragging = null;
            _hoverTarget = null;
          }),
          onDraggableCanceled: (_, __) => setState(() {
            _dragging = null;
            _hoverTarget = null;
          }),
          feedback: _dragFeedback(root, affiliate: affiliate),
          childWhenDragging: Opacity(opacity: 0.25, child: item),
          child: AnimatedScale(
            duration: Msg.fast,
            curve: Msg.curve,
            scale: isHover ? 1.12 : 1.0,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => _activate(() => affiliate
                  ? widget.onOpenAffiliate()
                  : widget.onSelect(root)),
              child: item,
            ),
          ),
        );
      },
    );
  }

  /// [AVA-RCPT-8 footer move] FIXED "Inbox" action — replaces the old
  /// "AvaBrain" footer slot (owner spec: AvaBrain drops off the footer;
  /// AvaBrain itself stays fully reachable via the ShellSidebar drawer's
  /// "AvaBrain" row on every root — shell/v2/shell_chrome.dart — so this is a
  /// footer-only removal, not a feature removal). Never draggable / never a
  /// drop target, exactly like the slot it replaces. Tapping it is a plain
  /// PUSH of [InboxListScreen] (not a root switch — Inbox has no Navigator of
  /// its own), so the active app's back stack still returns here on pop.
  Widget _inboxSlot() {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => _activate(widget.onOpenInbox),
      child: _labelledIcon(
        icon: PhosphorIcons.voicemail(PhosphorIconsStyle.regular),
        selectedIcon: PhosphorIcons.voicemail(PhosphorIconsStyle.fill),
        label: 'Inbox',
        // Selected while the pushed Inbox route is on top ([inboxActive]) —
        // the slot is not a root, but the user IS "in" Inbox, so the footer
        // must say so (owner bug 2026-07-16; same fix as [askAvaActive]).
        selected: widget.inboxActive,
      ),
    );
  }

  Widget _avaBrainSlot() {
    // [RAJ-SEAMS-1] The mockup's "Ava" bottom-nav icon is the lotus rosette
    // plate (design/rajasthani/rajasthani_motifs.dart LotusRosettePlate), not
    // a Phosphor glyph. `icon`/`selectedIcon` are still passed (required
    // params, used nowhere once `iconWidget` is supplied) so this call site
    // stays structurally identical to every other slot. Default plate colours
    // (turquoise plate / cream ring+petals / haldi centre) read fine on the
    // AD.bandIndigo footer — turquoise is light enough against dark indigo
    // that no override was needed.
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => _activate(widget.onAskAva),
      child: _labelledIcon(
        icon: PhosphorIcons.sparkle(PhosphorIconsStyle.regular),
        selectedIcon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
        label: 'AvaBrain',
        selected: widget.askAvaActive,
        iconWidget: const LotusRosettePlate(size: 22),
      ),
    );
  }

  Widget _rootItem(RootId root, {required bool selected}) {
    final m = _meta[root]!;
    // [AVADIAL-BADGE-OFF-1] (owner request 2026-07-15, pic6 "remove the numbers
    // in the avadial icon") The AvaDialer icon USED to carry the unread-SMS count
    // in red (AVA-SMS-BADGE-1, 2026-07-14). It pinned "99+" permanently — the
    // count is dominated by bulk/spam SMS, so it never dropped and stopped meaning
    // anything. Removed from the nav bar ONLY.
    //
    // SmsUnreadStore stays running (started in initState): the OS app-icon badge
    // (core/badge_service.dart) and the Messages tab chip inside AvaDialer
    // (shell/v2/avadial_root.dart) both still read it. Do not delete the store.
    return _labelledIcon(
      icon: m.$1,
      selectedIcon: m.$2,
      label: root == RootId.services && RemoteConfig.marketplaceVisible
          ? 'Marketplace'
          : m.$3,
      selected: selected,
    );
  }

  /// A single footer cell: an accent indicator pill behind the icon when selected,
  /// then a label — mirroring NavigationDestination's look. [badge] > 0 draws a
  /// RED unread count on the icon's shoulder ([AVA-SMS-BADGE-1]).
  Widget _labelledIcon({
    required IconData icon,
    required IconData selectedIcon,
    required String label,
    required bool selected,
    int badge = 0,
    // [RAJ-SEAMS-1] Optional widget override — used by the "Ava" slot to draw
    // the LotusRosettePlate instead of a Phosphor glyph. `icon`/`selectedIcon`
    // stay required so every other call site is untouched.
    Widget? iconWidget,
  }) {
    final iconCell = AnimatedContainer(
      duration: Msg.fast,
      curve: Msg.curve,
      width: 46,
      height: 28,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: selected ? _indicator : Colors.transparent,
        borderRadius: BorderRadius.circular(Msg.rMd),
      ),
      // Active icon sits on the orange pill; inactive sits straight on the bar
      // — both stay one colour (owner request 2026-07-13, pic 5: "not greyed"),
      // now AD.onBand for the indigo band instead of ink.
      child: iconWidget ?? Icon(selected ? selectedIcon : icon, size: 22, color: _onBand),
    );
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (badge <= 0)
          iconCell
        else
          Stack(clipBehavior: Clip.none, children: [
            iconCell,
            Positioned(
              right: -6,
              top: -5,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                decoration: BoxDecoration(
                  // Dark backing keeps the red digits readable over the orange
                  // active pill and the dark bar alike — tracks the bar's own
                  // fill, now AD.bandIndigo.
                  color: _band,
                  borderRadius: BorderRadius.circular(Msg.rSm),
                  border: Border.all(
                      color: const Color(0xFFFF453A), width: 1),
                ),
                child: Text(
                  badge > 99 ? '99+' : '$badge',
                  style: const TextStyle(
                    color: Color(0xFFFF453A), // RED count — owner spec
                    fontSize: 10,
                    fontWeight: FontWeight.w600,
                    height: 1.2,
                  ),
                ),
              ),
            ),
          ]),
        const SizedBox(height: Msg.s1),
        Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          // Active label = bright green (indicates the active tab); inactive =
          // AD.onBand for the indigo band.
          style: selected
              ? ADText.navLabelPrimary(c: const Color(0xFF7BE08C))
              : ADText.navLabel(c: _onBand),
        ),
      ],
    );
  }

  /// The lifted item that follows the finger — a bordered dark v2 tile,
  /// so the drag reads as a physical pick-up.
  Widget _dragFeedback(RootId root, {bool affiliate = false}) {
    final m = affiliate ? _affiliateMeta : _meta[root]!;
    return Transform.translate(
      // Center-ish under the finger (pointerDragAnchorStrategy anchors at origin).
      offset: const Offset(-32, -34),
      child: Material(
        color: Colors.transparent,
        child: Container(
          width: 64,
          padding: const EdgeInsets.symmetric(vertical: 8),
          decoration: BoxDecoration(
            color: AD.card,
            border: Border.all(color: AD.borderControl, width: 1),
            borderRadius: BorderRadius.circular(AD.rListCard),
            boxShadow: const [],
          ),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(m.$2, size: 22, color: AD.textPrimary),
            const SizedBox(height: Msg.s1),
            Text(m.$3, style: ADText.navLabelPrimary()),
          ]),
        ),
      ),
    );
  }
}

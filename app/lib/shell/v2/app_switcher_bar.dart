import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/remote_config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../features/avadial/inbox/inbox_list_screen.dart';
import '../../features/avadial/sms/sms_unread_store.dart';
import '../shell_v2.dart';

/// The persistent, shell-level app switcher (2026-07-12 nav rebrand — supersedes
/// the old Home-only footer / `HomeAppSwitcherBar`). Renders the three root icons
/// — **AvaTOK** (avaTalk), **Calls** (avaDial), **Marketplace** (services) — in the
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
  // 2026-07-12 rebrand: AvaDial → "Calls", AvaTalk → "AvaTOK", Services →
  // "Marketplace"; Home root retired.
  // 2026-07-14 rebrand (owner): AvaTalk label "AvaTOK" → "AvaTalk", and the
  // fixed AI action "Ava" → "AvaBrain". AvaDialer + Marketplace unchanged.
  // These are DISPLAY-ONLY — `RootId.key` ('avatalk'/'avadial'/'services') still
  // drives analytics, persisted order and restoration IDs, so the rename is safe.
  // NOTE: this map is duplicated in shell/v2/app_order_screen.dart and
  // shell/v2/shell_chrome.dart — all three must be kept in sync.
  static const Map<RootId, (IconData, IconData, String)> _meta = {
    RootId.avaDial: (Icons.phone_outlined, Icons.phone, 'AvaDialer'),
    RootId.avaTalk: (Icons.chat_bubble_outline, Icons.chat_bubble, 'AvaTalk'),
    RootId.services: (Icons.storefront_outlined, Icons.storefront, 'Marketplace'),
  };

  Color get _indicator => widget.indicatorColor ?? AD.primaryBadge;

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

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: AD.headerFooter,
        border: Border(top: BorderSide(color: AD.borderHairline, width: 1)),
      ),
      child: SafeArea(
        top: false,
        // Restored to the original 66px height + icon/text sizes (2026-07-12
        // owner feedback: the shrunk 50px version made the icons/labels too
        // small to read).
        child: SizedBox(
          height: 66,
          child: Row(
            children: [
              for (var i = 0; i < widget.order.length; i++) ...[
                Expanded(child: _draggableSlot(i)),
                // [AVA-RCPT-8 footer move] FIXED "Inbox" action, inserted right
                // after AvaDialer's slot (between AvaDialer and Marketplace in
                // the default order) — not draggable / not a drop target, same
                // as the "AvaBrain" slot it replaces. Gated on pstnVoicemail:
                // hidden entirely while the flag is off (the footer's standard
                // hidden pattern — no placeholder slot, exactly like every
                // other flag-gated AvaDial surface).
                if (widget.order[i] == RootId.avaDial && RemoteConfig.pstnVoicemail)
                  Expanded(child: _inboxSlot()),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _draggableSlot(int index) {
    final root = widget.order[index];
    // While Ask Ava is open, no root is "active" — the indicator lives on the
    // Ava action instead.
    final item = _rootItem(root,
        selected: !widget.askAvaActive && root == widget.activeRoot);

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
          feedback: _dragFeedback(root),
          childWhenDragging: Opacity(opacity: 0.25, child: item),
          child: AnimatedScale(
            duration: const Duration(milliseconds: 160),
            scale: isHover ? 1.12 : 1.0,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => widget.onSelect(root),
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
      onTap: widget.onOpenInbox,
      child: _labelledIcon(
        icon: Icons.voicemail_outlined,
        selectedIcon: Icons.voicemail,
        label: 'Inbox',
        // This slot never becomes the "active root" (it's a push, not a
        // switchRoot) — always rendered unselected, same visual language as
        // every other row currently NOT the active app.
        selected: false,
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
      label: m.$3,
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
  }) {
    final iconCell = AnimatedContainer(
      duration: const Duration(milliseconds: 160),
      width: 46,
      height: 28,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: selected ? _indicator : Colors.transparent,
        borderRadius: BorderRadius.circular(14),
      ),
      // Active icon sits on the orange pill (white glyph); inactive icons are
      // white too (owner request 2026-07-13, pic 5) — not greyed.
      child:
          Icon(selected ? selectedIcon : icon, size: 22, color: AD.textPrimary),
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
                  // active pill and the dark bar alike.
                  color: AD.headerFooter,
                  borderRadius: BorderRadius.circular(9),
                  border: Border.all(
                      color: const Color(0xFFFF453A), width: 1),
                ),
                child: Text(
                  badge > 99 ? '99+' : '$badge',
                  style: const TextStyle(
                    color: Color(0xFFFF453A), // RED count — owner spec
                    fontSize: 10.5,
                    fontWeight: FontWeight.w800,
                    height: 1.2,
                  ),
                ),
              ),
            ),
          ]),
        const SizedBox(height: 3),
        Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          // Active label = bright green (indicates the active tab); inactive =
          // white.
          style: selected
              ? ADText.navLabelPrimary(c: const Color(0xFF7BE08C))
              : ADText.navLabel(c: AD.textPrimary),
        ),
      ],
    );
  }

  /// The lifted item that follows the finger — a bordered dark v2 tile,
  /// so the drag reads as a physical pick-up.
  Widget _dragFeedback(RootId root) {
    final m = _meta[root]!;
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
            const SizedBox(height: 3),
            Text(m.$3, style: ADText.navLabelPrimary()),
          ]),
        ),
      ),
    );
  }
}

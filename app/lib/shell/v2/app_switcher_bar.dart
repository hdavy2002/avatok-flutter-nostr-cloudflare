import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/ui/zine.dart';
import '../shell_v2.dart';

/// The persistent, shell-level app switcher (2026-07-12 nav rebrand — supersedes
/// the old Home-only footer / `HomeAppSwitcherBar`). Renders the three root icons
/// — **AvaTOK** (avaTalk), **Calls** (avaDial), **Marketplace** (services) — in the
/// user's chosen [order], each LONG-PRESS DRAGGABLE to a new position, plus a FIXED
/// "Ava" action pinned at the far right (never draggable/targetable, since Ask Ava
/// is a global action, not a root).
///
/// Rendered ONCE by [ShellV2] itself (not by each root), so the same icons stay in
/// the same place across every app — switching apps never moves or hides this bar.
///
/// The FIRST root in [order] is the landing app on cold open. Reorders are
/// committed via [onReorder]; taps via [onSelect]; the Ava action via [onAskAva].
class AppSwitcherBar extends StatefulWidget {
  final List<RootId> order;
  final RootId activeRoot;
  final void Function(RootId) onSelect;
  final void Function(List<RootId>) onReorder;
  final VoidCallback onAskAva;

  /// Personalisation accent for the active-root indicator (falls back to lime).
  final Color? indicatorColor;

  const AppSwitcherBar({
    super.key,
    required this.order,
    required this.activeRoot,
    required this.onSelect,
    required this.onReorder,
    required this.onAskAva,
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

  // icon · selectedIcon · label per root (2026-07-12 rebrand: AvaDial → "Calls",
  // AvaTalk → "AvaTOK", Services → "Marketplace"; Home root retired).
  static const Map<RootId, (IconData, IconData, String)> _meta = {
    RootId.avaDial: (Icons.phone_outlined, Icons.phone, 'AvaDialer'),
    RootId.avaTalk: (Icons.chat_bubble_outline, Icons.chat_bubble, 'AvaTOK'),
    RootId.services: (Icons.storefront_outlined, Icons.storefront, 'Marketplace'),
  };

  Color get _indicator => widget.indicatorColor ?? Zine.lime;

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
        color: Zine.paper2,
        border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
      ),
      child: SafeArea(
        top: false,
        // Shrunk from 66 → 50 (2026-07-12 owner request: reclaim screen real
        // estate now that this bar is visible on every app, not just Home).
        child: SizedBox(
          height: 50,
          child: Row(
            children: [
              for (var i = 0; i < widget.order.length; i++)
                Expanded(child: _draggableSlot(i)),
              // FIXED "Ava" action — far right, not draggable / not a drop target.
              Expanded(child: _aiSlot()),
            ],
          ),
        ),
      ),
    );
  }

  Widget _draggableSlot(int index) {
    final root = widget.order[index];
    final item = _rootItem(root, selected: root == widget.activeRoot);

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

  Widget _aiSlot() {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: widget.onAskAva,
      child: _labelledIcon(
        icon: Icons.auto_awesome_outlined,
        selectedIcon: Icons.auto_awesome,
        label: 'Ava',
        selected: false,
      ),
    );
  }

  Widget _rootItem(RootId root, {required bool selected}) {
    final m = _meta[root]!;
    return _labelledIcon(
      icon: m.$1,
      selectedIcon: m.$2,
      label: m.$3,
      selected: selected,
    );
  }

  /// A single footer cell: an accent indicator pill behind the icon when selected,
  /// then a label — mirroring NavigationDestination's look.
  Widget _labelledIcon({
    required IconData icon,
    required IconData selectedIcon,
    required String label,
    required bool selected,
  }) {
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      mainAxisSize: MainAxisSize.min,
      children: [
        AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          width: 42,
          height: 22,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: selected ? _indicator : Colors.transparent,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Icon(selected ? selectedIcon : icon, size: 19, color: Zine.ink),
        ),
        const SizedBox(height: 2),
        Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: ZineText.tag(
            size: 9.5,
            color: selected ? Zine.ink : Zine.inkSoft,
          ),
        ),
      ],
    );
  }

  /// The lifted item that follows the finger — a bordered paper tile with a hard
  /// offset shadow, so the drag reads as a physical pick-up (Zine language).
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
            color: Zine.card,
            border: Border.all(color: Zine.ink, width: Zine.bw),
            borderRadius: BorderRadius.circular(Zine.rSm),
            boxShadow: Zine.shadowSm,
          ),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(m.$2, size: 22, color: Zine.ink),
            const SizedBox(height: 3),
            Text(m.$3, style: ZineText.tag(size: 10.5, color: Zine.ink)),
          ]),
        ),
      ),
    );
  }
}

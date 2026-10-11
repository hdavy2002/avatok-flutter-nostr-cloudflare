import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/hf_theme.dart';

/// One destination of [HfFloatingNav].
class HfNavItem {
  const HfNavItem({
    required this.icon,
    required this.label,
    required this.tint,
    this.keyName,
  });

  final IconData icon;
  final String label;

  /// Colour of the pill when this item is selected.
  final HfTint tint;

  /// Becomes `ValueKey<String>(keyName)` on the item, so tests can tap it.
  final String? keyName;
}

/// The floating bottom bar: 68 px tall, 16 px side margins, 20 px above the bottom safe area, radius 26.
///
/// Unselected items are 52x48 icon buttons in muted; the selected item expands to a 48 px tinted pill with its
/// icon and label. The width change animates over 220 ms ([AnimatedSize], instant on reduced motion). A tap on
/// another item gives a `selectionClick` haptic and calls [onTap] with its index. [selected] may be -1 when the
/// current page has no item. The bar grows with the system text size and the label ellipsises rather than
/// overflowing. Place it in `Scaffold.bottomNavigationBar` (or a Stack) over a page that has bottom padding of
/// about 108.
class HfFloatingNav extends StatelessWidget {
  const HfFloatingNav({
    super.key,
    required this.items,
    required this.selected,
    required this.onTap,
  });

  final List<HfNavItem> items;
  final int selected;
  final ValueChanged<int> onTap;

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    final dark = HfBrightness.isDark(context);
    final extra = (media.textScaler.scale(14) - 14).clamp(0.0, 40.0) * 2;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 0, 16, 20 + media.viewPadding.bottom),
      child: Container(
        height: 68 + extra,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        decoration: BoxDecoration(
          color: dark ? HfColors.darkNav : HfColors.white,
          borderRadius: BorderRadius.circular(HfRadius.nav),
          boxShadow: dark ? HfShadows.navDark : HfShadows.nav,
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            for (var i = 0; i < items.length; i++)
              Flexible(
                flex: i == selected ? 1 : 0,
                child: _NavButton(
                  key: items[i].keyName == null
                      ? null
                      : ValueKey<String>(items[i].keyName!),
                  item: items[i],
                  selected: i == selected,
                  onTap: () {
                    if (i != selected) HapticFeedback.selectionClick();
                    onTap(i);
                  },
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _NavButton extends StatelessWidget {
  const _NavButton({
    super.key,
    required this.item,
    required this.selected,
    required this.onTap,
  });

  final HfNavItem item;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final tintInk = item.tint.ink(context);
    final pillBg = dark && item.tint == HfTint.lavender
        ? HfColors.darkSelected
        : item.tint.bg(context);
    final idle = dark ? HfColors.mutedSoft : HfColors.muted;
    final Widget body = selected
        ? Container(
            key: const ValueKey<String>('nav-selected'),
            height: 48,
            padding: const EdgeInsets.symmetric(horizontal: 16),
            decoration: BoxDecoration(
              color: pillBg,
              borderRadius: BorderRadius.circular(HfRadius.tileSmall),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(item.icon, size: 20, color: tintInk),
                const SizedBox(width: HfSpacing.sm),
                Flexible(
                  child: Text(
                    item.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: HfText.badge.copyWith(color: tintInk),
                  ),
                ),
              ],
            ),
          )
        : SizedBox(
            key: const ValueKey<String>('nav-idle'),
            width: 52,
            height: 48,
            child: Center(child: Icon(item.icon, size: 22, color: idle)),
          );
    return Semantics(
      button: true,
      selected: selected,
      label: item.label,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: AnimatedSize(
          duration: HfMotion.of(context, HfMotion.base),
          curve: HfMotion.curve,
          alignment: Alignment.centerLeft,
          child: body,
        ),
      ),
    );
  }
}

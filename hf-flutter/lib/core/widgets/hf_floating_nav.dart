import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/hf_theme.dart';
import '../theme/hf_profile_style.dart';

/// One destination of [HfFloatingNav], with a visible destination colour.
class HfNavItem {
  const HfNavItem({
    required this.icon,
    required this.label,
    required this.tint,
    this.color,
    this.keyName,
  });

  final IconData icon;
  final String label;
  final HfTint tint;
  final Color? color;
  final String? keyName;
}

/// Icon-only navigation with accessible names and 48 dp touch targets.
/// The regular bar reserves 68 dp plus its 20 dp bottom gap. Me retains its
/// full-width surface and receives the actual safe-area inset from the shell.
class HfFloatingNav extends StatelessWidget {
  const HfFloatingNav({
    super.key,
    required this.items,
    required this.selected,
    required this.onTap,
    this.profileStyle = false,
  });

  final List<HfNavItem> items;
  final int selected;
  final ValueChanged<int> onTap;
  final bool profileStyle;

  Widget _items(BuildContext context) => Row(
    mainAxisAlignment: MainAxisAlignment.spaceAround,
    children: [
      for (var i = 0; i < items.length; i++)
        Expanded(
          child: Center(
            child: _NavButton(
              key: items[i].keyName == null ? null : ValueKey<String>(items[i].keyName!),
              item: items[i],
              selected: i == selected,
              onTap: () {
                if (i != selected) HapticFeedback.selectionClick();
                onTap(i);
              },
            ),
          ),
        ),
    ],
  );

  @override
  Widget build(BuildContext context) {
    final style = HfProfileStyle.of(context);
    if (profileStyle) {
      return Container(
        key: const ValueKey<String>('profile-nav'),
        decoration: BoxDecoration(color: style.surface, boxShadow: style.navShadows),
        child: SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
            child: _items(context),
          ),
        ),
      );
    }
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 0, 16, 20 + MediaQuery.viewPaddingOf(context).bottom),
      child: Container(
        height: 68,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        decoration: BoxDecoration(
          color: style.surface,
          border: Border.all(color: style.line),
          borderRadius: BorderRadius.circular(HfRadius.nav),
          boxShadow: style.navShadows,
        ),
        child: _items(context),
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
    final base = item.color ?? item.tint.ink(context);
    final ink = dark ? Color.lerp(base, Colors.white, 0.38)! : base;
    return Semantics(
      button: true,
      selected: selected,
      label: item.label,
      excludeSemantics: true,
      child: Tooltip(
        message: item.label,
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            borderRadius: BorderRadius.circular(HfRadius.tileSmall),
            onTap: onTap,
            child: AnimatedContainer(
              key: ValueKey<String>(selected ? 'nav-selected' : 'nav-idle'),
              duration: HfMotion.of(context, HfMotion.base),
              width: 56,
              height: 48,
              decoration: BoxDecoration(
                color: selected ? base.withValues(alpha: dark ? 0.30 : 0.14) : Colors.transparent,
                borderRadius: BorderRadius.circular(HfRadius.tileSmall),
              ),
              alignment: Alignment.center,
              child: Icon(item.icon, size: 32, color: ink),
            ),
          ),
        ),
      ),
    );
  }
}

import 'package:flutter/material.dart';

import '../avatok_dark.dart';
import '../messenger_theme.dart';

/// A segmented control whose active pill slides between options instead of
/// hard-cutting — the same shape change other apps reach for
/// [Curves.elasticOut] on, done instead with [Msg.settle] so switching tabs
/// reads as smooth rather than springy. [Msg.base] because a tab switch is a
/// default enter, not a dismissal and not a reward moment.
///
/// The pill's rect is measured off the real rendered items (via [GlobalKey]s)
/// rather than computed from assumed widths, so it stays correct through a
/// font-scale change, a label-count change, or a parent resize — all of
/// which re-measure on the next frame.
class AdSlideTabs extends StatefulWidget {
  const AdSlideTabs({
    super.key,
    required this.labels,
    required this.selectedIndex,
    required this.onChanged,
  });

  final List<String> labels;
  final int selectedIndex;
  final ValueChanged<int> onChanged;

  @override
  State<AdSlideTabs> createState() => _AdSlideTabsState();
}

class _AdSlideTabsState extends State<AdSlideTabs> {
  final GlobalKey _containerKey = GlobalKey();
  List<GlobalKey> _itemKeys = const [];
  Rect? _pillRect;

  @override
  void initState() {
    super.initState();
    _rebuildKeys();
    WidgetsBinding.instance.addPostFrameCallback((_) => _measure());
  }

  void _rebuildKeys() {
    _itemKeys = List.generate(widget.labels.length, (_) => GlobalKey());
  }

  @override
  void didUpdateWidget(covariant AdSlideTabs oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.labels.length != widget.labels.length) {
      _rebuildKeys();
    }
    WidgetsBinding.instance.addPostFrameCallback((_) => _measure());
  }

  void _measure() {
    if (!mounted) return;
    if (widget.selectedIndex < 0 || widget.selectedIndex >= _itemKeys.length) return;
    final containerBox = _containerKey.currentContext?.findRenderObject() as RenderBox?;
    final itemBox =
        _itemKeys[widget.selectedIndex].currentContext?.findRenderObject() as RenderBox?;
    if (containerBox == null || itemBox == null) return;
    if (!containerBox.attached || !itemBox.attached) return;
    final origin = itemBox.localToGlobal(Offset.zero, ancestor: containerBox);
    final rect = origin & itemBox.size;
    if (rect != _pillRect) {
      setState(() => _pillRect = rect);
    }
  }

  @override
  Widget build(BuildContext context) {
    final reduce = MediaQuery.of(context).disableAnimations;
    return LayoutBuilder(
      builder: (context, constraints) {
        WidgetsBinding.instance.addPostFrameCallback((_) => _measure());
        return Container(
          key: _containerKey,
          padding: const EdgeInsets.all(4),
          decoration: BoxDecoration(
            color: AD.inputField,
            borderRadius: Msg.brSm,
            border: Border.fromBorderSide(Msg.border),
          ),
          child: Stack(
            children: [
              if (_pillRect != null)
                AnimatedPositioned(
                  duration: reduce ? Duration.zero : Msg.base,
                  curve: Msg.settle,
                  left: _pillRect!.left,
                  top: _pillRect!.top,
                  width: _pillRect!.width,
                  height: _pillRect!.height,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: Msg.accent,
                      borderRadius: Msg.brSm,
                    ),
                  ),
                ),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (var i = 0; i < widget.labels.length; i++) _buildItem(i),
                ],
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _buildItem(int index) {
    final selected = index == widget.selectedIndex;
    return GestureDetector(
      key: _itemKeys[index],
      behavior: HitTestBehavior.opaque,
      onTap: () => widget.onChanged(index),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s2),
        child: Text(
          widget.labels[index],
          textAlign: TextAlign.center,
          style: ADText.tabLabel(c: selected ? AD.sendActiveInk : AD.textSecondary),
        ),
      ),
    );
  }
}

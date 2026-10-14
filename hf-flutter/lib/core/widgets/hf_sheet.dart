import 'package:flutter/material.dart';

import '../theme/hf_theme.dart';

/// Opens the shared bottom sheet (mockup `Explore`, `CallSheet`).
///
/// A [DraggableScrollableSheet] in a modal: 44x5 `handle` drag handle, radius 32 on top, optional [title]
/// (24 sp) with a "Clear all" text button when [onClear] is given. [builder] builds the scrolling content: it is
/// wrapped in a [PrimaryScrollController], so a plain `ListView` or `SingleChildScrollView` inside it drags the
/// sheet and scrolls correctly. [footer] (for example the "Show N hosts" button) is pinned at the bottom with
/// 12 px padding and a hairline above it, and is lifted by the keyboard ([MediaQuery.viewInsets]).
Future<T?> showHfSheet<T>(
  BuildContext context, {
  required WidgetBuilder builder,
  double initialSize = 0.82,
  double minSize = 0.4,
  double maxSize = 0.95,
  Widget? footer,
  String? title,
  VoidCallback? onClear,
}) {
  return showModalBottomSheet<T>(
    context: context,
    // Root navigator: inside a tab the floating nav sits above the tab's navigator and would cover the footer.
    useRootNavigator: true,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Colors.transparent,
    barrierColor: const Color(
      0x6B1D1A33,
    ), // rgba(29,26,51,0.42) from the mockup scrim
    builder: (sheetContext) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: initialSize,
      minChildSize: minSize,
      maxChildSize: maxSize,
      builder: (ctx, controller) => _HfSheetBody(
        controller: controller,
        builder: builder,
        footer: footer,
        title: title,
        onClear: onClear,
      ),
    ),
  );
}

class _HfSheetBody extends StatelessWidget {
  const _HfSheetBody({
    required this.controller,
    required this.builder,
    this.footer,
    this.title,
    this.onClear,
  });

  final ScrollController controller;
  final WidgetBuilder builder;
  final Widget? footer;
  final String? title;
  final VoidCallback? onClear;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final media = MediaQuery.of(context);
    final footerBottom =
        (media.viewInsets.bottom > media.viewPadding.bottom
            ? media.viewInsets.bottom
            : media.viewPadding.bottom) +
        12;
    return Container(
      decoration: BoxDecoration(
        color: dark ? HfColors.darkCard : HfColors.surface,
        border: Border.all(
          color: dark ? HfColors.darkLine : HfColors.line,
          strokeAlign: BorderSide.strokeAlignOutside,
        ),
        boxShadow: HfShadows.cardFor(context),
        borderRadius: const BorderRadius.vertical(
          top: Radius.circular(HfRadius.sheet),
        ),
      ),
      child: Column(
        children: [
          SizedBox(
            height: 28,
            child: Center(
              child: Container(
                key: const ValueKey<String>('hf-sheet-handle'),
                width: 44,
                height: 5,
                decoration: BoxDecoration(
                  color: dark ? HfColors.darkSelected : HfColors.handle,
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
            ),
          ),
          if (title != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                HfSpacing.pageWide,
                0,
                HfSpacing.pageWide,
                6,
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      title!,
                      style: HfText.of(context, HfText.title),
                    ),
                  ),
                  if (onClear != null)
                    TextButton(
                      onPressed: onClear,
                      style: TextButton.styleFrom(
                        minimumSize: const Size(HfSpacing.tap, 44),
                      ),
                      child: const Text('Clear all'),
                    ),
                ],
              ),
            ),
          Expanded(
            child: PrimaryScrollController(
              controller: controller,
              child: Builder(builder: builder),
            ),
          ),
          if (footer != null)
            DecoratedBox(
              decoration: BoxDecoration(
                border: Border(
                  top: BorderSide(
                    color: dark ? HfColors.darkLine : HfColors.line,
                  ),
                ),
              ),
              child: AnimatedPadding(
                duration: HfMotion.of(context, HfMotion.fast),
                padding: EdgeInsets.fromLTRB(
                  HfSpacing.pageWide,
                  12,
                  HfSpacing.pageWide,
                  footerBottom,
                ),
                child: footer!,
              ),
            ),
        ],
      ),
    );
  }
}

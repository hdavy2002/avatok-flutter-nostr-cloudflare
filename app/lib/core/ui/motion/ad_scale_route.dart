import 'package:flutter/material.dart';

import '../avatok_dark.dart';
import '../messenger_theme.dart';

/// A dialog/sheet-style route that scales in from 0.96 with a fade, rather
/// than the flat cross-fade [showDialog] uses by default.
///
/// Asymmetric on purpose: opening is a deliberate [Msg.base] arrival, but
/// dismissing a dialog should get out of the way fast, so the reverse
/// transition uses [Msg.fast]. The scale start (0.96, not something more
/// dramatic like 0.8) is intentionally subtle — paired with the fade it
/// reads as "settling into place", not "popping up".
PageRouteBuilder<T> adDialogRoute<T>({
  required WidgetBuilder builder,
  bool barrierDismissible = true,
  Color barrierColor = AD.scrim,
  RouteSettings? settings,
}) {
  return PageRouteBuilder<T>(
    opaque: false,
    barrierDismissible: barrierDismissible,
    barrierColor: barrierColor,
    transitionDuration: Msg.base,
    reverseTransitionDuration: Msg.fast,
    settings: settings,
    pageBuilder: (context, animation, secondaryAnimation) => builder(context),
    transitionsBuilder: (context, animation, secondaryAnimation, child) {
      if (MediaQuery.of(context).disableAnimations) return child;
      final curved = CurvedAnimation(parent: animation, curve: Msg.settle);
      return FadeTransition(
        opacity: curved,
        child: ScaleTransition(
          scale: Tween<double>(begin: 0.96, end: 1.0).animate(curved),
          child: child,
        ),
      );
    },
  );
}

/// A menu/popover-style route that grows from [alignment] — typically the
/// corner nearest whatever was tapped to open it — instead of scaling from
/// its own centre. This is what makes a context menu read as coming FROM
/// the button that opened it rather than materialising in place.
///
/// Same asymmetric timing as [adDialogRoute]: [Msg.base] to open,
/// [Msg.fast] to close.
PageRouteBuilder<T> adMenuTransition<T>({
  required WidgetBuilder builder,
  required Alignment alignment,
  bool barrierDismissible = true,
  Color barrierColor = AD.scrim,
  RouteSettings? settings,
}) {
  return PageRouteBuilder<T>(
    opaque: false,
    barrierDismissible: barrierDismissible,
    barrierColor: barrierColor,
    transitionDuration: Msg.base,
    reverseTransitionDuration: Msg.fast,
    settings: settings,
    pageBuilder: (context, animation, secondaryAnimation) => builder(context),
    transitionsBuilder: (context, animation, secondaryAnimation, child) {
      if (MediaQuery.of(context).disableAnimations) return child;
      final curved = CurvedAnimation(parent: animation, curve: Msg.settle);
      return FadeTransition(
        opacity: curved,
        child: ScaleTransition(
          scale: curved,
          alignment: alignment,
          child: child,
        ),
      );
    },
  );
}

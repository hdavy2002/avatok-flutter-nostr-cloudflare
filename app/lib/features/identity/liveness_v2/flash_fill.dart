import 'package:flutter/material.dart';
import 'package:screen_brightness/screen_brightness.dart';

import '../../../core/ui/avatok_dark.dart';

/// Liveness V2 flash-fill (Specs/LIVENESS-V2-PLAN.md §4 step 1, A8/A9
/// mitigation): while the POSITION/challenge capture is active, push the screen
/// brightness to 100% and render a thick white "ring light" surround around the
/// camera preview so the subject's face is lit from the display.
///
/// [FlashFillController] owns the brightness side-effect. It stores the current
/// brightness on [activate] and ALWAYS restores it on [deactivate]/[dispose]
/// (try/finally), so a crash mid-capture can never leave the phone stuck at max
/// brightness.
class FlashFillController {
  double? _saved; // brightness before we boosted it
  bool _active = false;

  bool get isActive => _active;

  /// Boost to 1.0 after remembering the current brightness. Best-effort: a
  /// platform failure never throws into the capture flow.
  Future<void> activate() async {
    if (_active) return;
    _active = true;
    try {
      _saved = await ScreenBrightness().current;
    } catch (_) {
      _saved = null; // fall back to system reset on restore
    }
    try {
      await ScreenBrightness().setScreenBrightness(1.0);
    } catch (_) {/* keep going — the white surround still helps */}
  }

  /// Restore the saved brightness. Idempotent; safe to call from dispose.
  Future<void> deactivate() async {
    if (!_active) return;
    try {
      final saved = _saved;
      if (saved != null) {
        await ScreenBrightness().setScreenBrightness(saved);
      } else {
        await ScreenBrightness().resetScreenBrightness();
      }
    } catch (_) {
      // Last-ditch: ask the OS to take brightness back.
      try {
        await ScreenBrightness().resetScreenBrightness();
      } catch (_) {/* nothing more we can do */}
    } finally {
      _active = false;
      _saved = null;
    }
  }

  /// Alias so callers can treat this like a disposable resource.
  Future<void> dispose() => deactivate();
}

/// Renders [child] (the camera preview) inside a thick white ring-light surround.
/// Purely visual — the brightness boost is driven by [FlashFillController].
class FlashFillSurround extends StatelessWidget {
  const FlashFillSurround({
    super.key,
    required this.child,
    this.active = true,
    this.thickness = 26,
  });

  /// The camera preview (or any capture surface).
  final Widget child;

  /// When false, the surround collapses to nothing (no white border).
  final bool active;

  /// Width of the white ring-light border.
  final double thickness;

  @override
  Widget build(BuildContext context) {
    if (!active) return child;
    return Container(
      color: Colors.white, // white "ring light" — functional face illumination
      padding: EdgeInsets.all(thickness),
      child: DecoratedBox(
        decoration: const BoxDecoration(
          border: Border.fromBorderSide(
            BorderSide(color: AD.borderControl, width: 1),
          ),
        ),
        child: child,
      ),
    );
  }
}

import 'package:flutter/material.dart';

import 'avatok_dark.dart';

/// [BOOT-FLASH-2 2026-08-06] The ONE screen shown while the app resolves local
/// state at launch. Static by design.
///
/// WHY THIS EXISTS. Startup crosses two gates that each used to paint their own
/// `Scaffold(AD.bg, CircularProgressIndicator(AD.iconSearch))`:
///
///   1. `RootFlow._Stage.loading` in `main.dart`, while `_boot()` reads the
///      account id, identity and onboarding flag from local storage.
///   2. `AvaShell`'s `_profileComplete == null` gate, while `_load()` reads two
///      per-account flags.
///
/// The two were pixel-identical, so there was no colour flash — but they are
/// different widget instances in different subtrees, so at the handoff Flutter
/// disposed one `CircularProgressIndicator` and created another. A spinner that
/// restarts mid-spin reads as a stutter, which is exactly the "settling" the
/// owner has been reporting. Sharing a single const widget does NOT fix that on
/// its own: the element still can't be reused across the stage swap.
///
/// So the fix is to remove the moving part. Both gates are LOCAL reads — a few
/// files and one secure-storage entry, typically well under a frame or two — so
/// there is nothing worth animating a progress indicator for. A spinner that
/// appears and vanishes inside ~100ms is visual noise, not feedback. This paints
/// the app background and nothing else: no motion, so nothing can restart, and
/// the handoff between the two gates is now literally undetectable because both
/// render identical static pixels.
///
/// Consistent with the owner's standing instruction (2026-08-06): no animation,
/// no effects. Do NOT put a spinner back here. If a genuinely slow path ever
/// needs progress, give THAT path its own indicator rather than making every
/// launch pay for it.
class AvaBootScreen extends StatelessWidget {
  const AvaBootScreen({super.key});

  @override
  Widget build(BuildContext context) =>
      const Scaffold(backgroundColor: AD.bg, body: SizedBox.expand());
}

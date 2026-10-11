import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/boot.dart';
import '../../../core/brand.dart';
import '../../../core/router/deep_link_handler.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_theme.dart';
import '../../call/data/call_api.dart';
import '../../../core/router/pending_intent.dart';

/// Boot restoration only, with no artificial animation delay. Public browsing never requires consent.
class SplashScreen extends ConsumerStatefulWidget {
  const SplashScreen({super.key});

  @override
  ConsumerState<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends ConsumerState<SplashScreen> {
  @override
  void initState() {
    super.initState();
    _run();
  }

  Future<void> _run() async {
    try {
      await ref.read(appBootProvider.future);
    } catch (_) {
      // boot never throws, and a failure must not strand the person here
    }
    if (!mounted) return;
    final handler = ref.read(deepLinkHandlerProvider);
    ref.read(bootDoneProvider.notifier).markDone();
    final opened = await handler.flushPending();
    if (!mounted) return;
    if (opened) return;
    final pending = await ref.read(pendingIntentProvider).read();
    if (!mounted) return;
    context.go(pending ?? Routes.home);
    // [HF-NATIVE-FIX-1] A call that is still going when the app starts: go back into it (Home stays underneath).
    try {
      final callId = await ref.read(activeCallResumeProvider.future);
      if (callId != null && mounted) {
        unawaited(context.push(Routes.callOf(callId)));
      }
    } catch (_) {
      // never let a resume failure strand the person
    }
  }

  @override
  Widget build(BuildContext context) {
    // Page background, the wordmark in Nunito ink, three pastel dots. No spinner and no animation to wait for.
    return Scaffold(
      backgroundColor: HfBrightness.isDark(context)
          ? HfColors.darkBg
          : HfColors.page,
      body: SafeArea(
        child: SizedBox.expand(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: HfSpacing.section,
                ),
                child: Text(
                  Brand.name,
                  textAlign: TextAlign.center,
                  style: HfText.of(context, HfText.hero),
                ),
              ),
              const SizedBox(height: HfSpacing.section),
              const Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _Dot(HfTint.lavender),
                  SizedBox(width: HfSpacing.md),
                  _Dot(HfTint.peach),
                  SizedBox(width: HfSpacing.md),
                  _Dot(HfTint.sky),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Dot extends StatelessWidget {
  const _Dot(this.tint);

  final HfTint tint;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: Container(
      width: 14,
      height: 14,
      decoration: BoxDecoration(
        color: tint.bg(context),
        shape: BoxShape.circle,
      ),
    ),
  );
}

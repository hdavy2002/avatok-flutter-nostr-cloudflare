import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/boot.dart';
import '../../../core/brand.dart';
import '../../../core/router/deep_link_handler.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../call/data/call_api.dart';
import '../../welcome/data/ack_service.dart';

/// Cold start: shows the brand while the session and the flags load (capped at 6 s). Then: Welcome (18+ and
/// safety rules) when this device and account have not accepted the current version; else a link that arrived
/// during start; else Home.
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
    // 18+ and safety rules first (spec 2.1): this device or this account must have accepted the current
    // version. A link that arrived during start stays pending: Welcome releases it after Continue.
    var welcomeFirst = false;
    try {
      welcomeFirst = await ref.read(ackServiceProvider).needsWelcomeNow();
    } catch (_) {
      // An unreadable ack must not trap the person on the splash: ask them again, which is safe.
      welcomeFirst = true;
    }
    if (!mounted) return;
    if (welcomeFirst) {
      context.go(Routes.welcome);
      return;
    }
    final handler = ref.read(deepLinkHandlerProvider);
    ref.read(bootDoneProvider.notifier).markDone();
    final opened = await handler.flushPending();
    if (!mounted) return;
    if (opened) return;
    context.go(Routes.home);
    // [HF-NATIVE-FIX-1] A call that is still going when the app starts: go back into it (Home stays underneath).
    try {
      final callId = await ref.read(activeCallResumeProvider.future);
      if (callId != null && mounted) context.push(Routes.callOf(callId));
    } catch (_) {
      // never let a resume failure strand the person
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: HfColors.cream,
      body: SafeArea(
        child: SizedBox.expand(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Image.asset(
                'assets/images/logo.png',
                width: 96,
                height: 96,
                errorBuilder: (_, __, ___) => const SizedBox(width: 96, height: 96),
              ),
              const SizedBox(height: 16),
              const Text(Brand.name, style: HfText.headline),
              const SizedBox(height: 24),
              const SizedBox(
                width: 28,
                height: 28,
                child: CircularProgressIndicator(strokeWidth: 3, color: HfColors.orchid),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

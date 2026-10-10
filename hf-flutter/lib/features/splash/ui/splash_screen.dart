import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/boot.dart';
import '../../../core/brand.dart';
import '../../../core/router/deep_link_handler.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_tokens.dart';

/// Cold start: shows the brand while the session and the flags load (capped at 6 s), then opens a link that
/// arrived during start, else Home. (The Welcome screen decision is added by HF-NATIVE-2.)
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
    if (!opened) context.go(Routes.home);
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

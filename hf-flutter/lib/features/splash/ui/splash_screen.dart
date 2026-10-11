import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/boot.dart';
import '../../../core/brand.dart';
import '../../../core/router/deep_link_handler.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../call/data/call_api.dart';
import '../../../core/router/pending_intent.dart';
import '../../../core/widgets/widgets.dart';

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
      if (callId != null && mounted) unawaited(context.push(Routes.callOf(callId)));
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
              const HfScene(kind: HfSceneKind.discover, height: 190, animated: true),
              const SizedBox(height: 16),
              const Text(Brand.name, style: HfText.headline),
              const SizedBox(height: 8),
              const Text('A little hello. A real connection.', style: HfText.bodyText),
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

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../features/call/data/call_api.dart';
import 'app_router.dart';
import 'deep_link_handler.dart';
import 'pending_intent.dart';
import 'routes.dart';

/// Shared by splash and install-intro completion. Keep links queued throughout
/// restoration; only release them once the fresh-install explanation is done.
class StartupNavigation {
  StartupNavigation(this.ref);
  final Ref ref;
  static const recoveryTimeout = Duration(seconds: 2);

  Future<void> openLanding() async {
    // An explicit link wins without waiting for an unrelated call-status request.
    if (await _openQueuedLink() || !ref.mounted) return;
    final pending = await ref.read(pendingIntentProvider).read();
    if (!ref.mounted) return;
    String? callId;
    try {
      callId = await ref.read(activeCallResumeProvider.future)
          .timeout(recoveryTimeout);
    } catch (_) {
      // Failed or slow recovery must not block public browsing. A late result
      // is ignored: it must not replace the route the person is now using.
    }
    if (!ref.mounted) return;
    // A link arriving during recovery still takes priority over every fallback.
    await _openQueuedLink(
      fallback: callId != null ? Routes.callOf(callId) : pending ?? Routes.explore,
    );
  }

  Future<bool> _openQueuedLink({String? fallback}) async {
    var opened = false;
    // Keep warm links queued while Custom Tabs or telemetry await; a newer
    // explicit route must not be overwritten by the default landing afterward.
    while (ref.read(pendingLinkProvider) != null) {
      final routed = await ref.read(deepLinkHandlerProvider).flushPending();
      if (!ref.mounted) return true;
      opened = routed || opened;
    }
    if (opened || fallback != null) {
      // No await between the last queue check, opening the gate, and navigation.
      ref.read(bootDoneProvider.notifier).markDone();
      if (!opened) ref.read(appRouterProvider).go(fallback!);
    }
    return opened;
  }
}

final startupNavigationProvider = Provider<StartupNavigation>(StartupNavigation.new);

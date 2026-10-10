import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../analytics/analytics.dart';
import '../links.dart';
import 'app_router.dart';
import 'deep_links.dart';

/// A link that arrived before the splash screen finished (cold start from a link or a push).
class PendingLinkData {
  const PendingLinkData({required this.input, required this.source, required this.launch});
  final String input;
  final String source;
  final String launch;
}

class PendingLink extends Notifier<PendingLinkData?> {
  @override
  PendingLinkData? build() => null;

  void set(PendingLinkData? v) => state = v;
}

final pendingLinkProvider = NotifierProvider<PendingLink, PendingLinkData?>(PendingLink.new);

class BootDone extends Notifier<bool> {
  @override
  bool build() => false;

  void markDone() => state = true;
}

/// True once the splash screen has finished and routed. Links that arrive earlier wait in [pendingLinkProvider].
final bootDoneProvider = NotifierProvider<BootDone, bool>(BootDone.new);

/// Opens whatever an incoming link or push points at (spec 3.3).
///
/// Sources: `link` (https App Link), `scheme` (custom scheme), `push` (FCM `data.path`). HF-NATIVE-7 calls
/// `handle(path, source: 'push')`.
class DeepLinkHandler {
  DeepLinkHandler(this._ref);

  final Ref _ref;

  Future<void> handle(String input, {required String source, String launch = 'warm'}) async {
    if (!_ref.read(bootDoneProvider)) {
      _ref.read(pendingLinkProvider.notifier).set(PendingLinkData(input: input, source: source, launch: 'cold'));
      return;
    }
    await _apply(input, source, launch);
  }

  /// Called by the splash screen after boot: opens a link that arrived while the app was starting.
  /// Returns true when it did, so the splash does not also go Home.
  Future<bool> flushPending() async {
    final pending = _ref.read(pendingLinkProvider);
    if (pending == null) return false;
    _ref.read(pendingLinkProvider.notifier).set(null);
    await _apply(pending.input, pending.source, pending.launch);
    return true;
  }

  Future<void> _apply(String input, String source, String launch) async {
    final target = DeepLinks.resolve(input);
    if (target is IgnoreLink) return;
    // Telemetry never carries a slug, an id or a token: the path is templated and the query dropped.
    await Analytics.capture('hf_app_deeplink_opened', {
      'path': DeepLinks.telemetryPath(input),
      'source': source,
      'launch': launch,
    });
    final GoRouter router = _ref.read(appRouterProvider);
    switch (target) {
      case OpenRoute(:final location):
        router.go(location);
      case DigiLockerReturn(:final location):
        // The onboarding and lane screens run `digilocker/complete` when they see `dl=return` (HF-NATIVE-8).
        router.go(location);
      case OpenCustomTab(:final uri):
        await LinkOpener.instance.customTab(uri);
      case IgnoreLink():
        break;
    }
  }
}

final deepLinkHandlerProvider = Provider<DeepLinkHandler>((ref) => DeepLinkHandler(ref));

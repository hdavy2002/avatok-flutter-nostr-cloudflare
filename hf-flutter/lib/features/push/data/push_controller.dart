import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/session.dart';
import 'push_gateway.dart';
import 'push_payload.dart';
import 'push_service.dart';

/// What the push overlay should show right now.
class PushUiState {
  const PushUiState({this.banner, this.promptOptIn = false});

  /// A push that arrived while the app was open: shown as a banner with "Open".
  final PushMessage? banner;

  /// The opt-in sheet is due (signed in, flag on, not allowed, not asked in the last 14 days).
  final bool promptOptIn;

  PushUiState copyWith({PushMessage? banner, bool clearBanner = false, bool? promptOptIn}) => PushUiState(
        banner: clearBanner ? null : (banner ?? this.banner),
        promptOptIn: promptOptIn ?? this.promptOptIn,
      );
}

final pushControllerProvider = NotifierProvider<PushController, PushUiState>(PushController.new);

/// Wires Firebase Messaging to the app: token registration (sign-in, refresh, sign-out), the opt-in
/// prompt trigger, the foreground banner and notification taps. Started once by `PushOverlay`.
class PushController extends Notifier<PushUiState> {
  final List<StreamSubscription<Object?>> _subs = <StreamSubscription<Object?>>[];
  bool _started = false;

  PushService get _service => ref.read(pushServiceProvider);
  PushGateway get _gateway => ref.read(pushGatewayProvider);

  @override
  PushUiState build() {
    // Sign-out: delete this phone's token first, while the session still authorises the call.
    ref.read(signOutHooksProvider).add(() => _service.unregister());
    ref.listen<SessionState>(sessionProvider, (prev, next) {
      if (next.isSignedIn && prev?.status != SessionStatus.signedIn) {
        unawaited(_onSignedIn());
      } else if (!next.isSignedIn) {
        state = const PushUiState();
      }
    });
    ref.onDispose(() {
      for (final s in _subs) {
        s.cancel();
      }
      _subs.clear();
    });
    return const PushUiState();
  }

  /// Idempotent. Without Firebase (no google-services.json, or a test) it does nothing.
  Future<void> start() async {
    if (_started) return;
    _started = true;
    final gateway = _gateway;
    if (!gateway.available) return;

    _subs.add(gateway.onTokenRefresh.listen((t) {
      if (ref.read(sessionProvider).isSignedIn) unawaited(_service.registerToken(t));
    }, onError: (_) {}));
    _subs.add(gateway.onForeground.listen((m) {
      if (m.title.isEmpty && m.body.isEmpty) return;
      state = state.copyWith(banner: m);
    }, onError: (_) {}));
    _subs.add(gateway.onOpened.listen((m) => unawaited(_service.open(m, launch: 'warm')), onError: (_) {}));

    // Started from a tapped notification. The link handler holds it until the splash has finished.
    try {
      final initial = await gateway.initialMessage();
      if (initial != null) await _service.open(initial, launch: 'cold');
    } catch (_) {
      // no initial message
    }
    if (ref.read(sessionProvider).isSignedIn) await _onSignedIn();
  }

  Future<void> _onSignedIn() async {
    await _service.syncAfterSignIn();
    if (await _service.shouldPrompt()) state = state.copyWith(promptOptIn: true);
  }

  /// The overlay showed (or skipped) the sheet.
  void promptHandled() => state = state.copyWith(promptOptIn: false);

  void dismissBanner() => state = state.copyWith(clearBanner: true);

  /// "Open" on the banner.
  Future<void> openBanner() async {
    final m = state.banner;
    if (m == null) return;
    state = state.copyWith(clearBanner: true);
    await _service.open(m, launch: 'warm');
  }
}

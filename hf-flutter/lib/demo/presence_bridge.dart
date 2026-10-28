import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../data/demo_mode.dart';
import '../data/presence_store.dart';
import 'call_safety_kit.dart'; // [HF-CALL-SAFETY-APP]
import 'state.dart';
import 'widgets.dart';

/// Joins the influencer screens to real presence (HF-WIRE-5). While [DemoMode.on] they keep reading
/// the dummy `demo.online`; with `--dart-define=HF_DEMO=false` they read [PresenceStore].
abstract final class PresenceBridge {
  /// Tests set this to exercise the real path without a dart-define.
  @visibleForTesting
  static bool forceReal = false;

  static bool get real => forceReal || !DemoMode.on;
}

/// Rebuild trigger for the influencer screens.
Listenable get presenceListenable => PresenceBridge.real ? Listenable.merge([demo, PresenceStore.instance]) : demo;

/// Is she online right now (busy counts as online).
bool get myOnline => PresenceBridge.real ? PresenceStore.instance.online : demo.online;

/// She is on a call right now (real mode only; the button is paused until it ends).
bool get myBusy => PresenceBridge.real && PresenceStore.instance.busy;

/// A switch is already on its way to the server.
bool get mySaving => PresenceBridge.real && PresenceStore.instance.saving;

/// Call from a build method of the first influencer screen.
void ensurePresenceLoaded() {
  if (PresenceBridge.real) PresenceStore.instance.ensureLoaded();
}

/// Flip Online/Offline and tell her what happened. Real mode rolls back and explains on failure.
Future<void> togglePresence(BuildContext context) async {
  final goOnline = !myOnline;
  if (!PresenceBridge.real) {
    demo.setOnline(goOnline);
    toast(context, goOnline ? 'You are online. Fans can call you now.' : 'You are offline. Bookings stay open.');
    return;
  }
  final store = PresenceStore.instance;
  final messenger = ScaffoldMessenger.of(context);
  final go = GoRouter.maybeOf(context); // [HF-CALL-SAFETY-APP] captured before the await
  final error = await store.setOnline(goOnline);
  if (error != null && SafetyGate.handle(go, store.lastErrorCode)) return;
  final msg = error ?? (goOnline ? 'You are online. Fans can call you now.' : 'You are offline. Bookings stay open.');
  messenger
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(msg)));
}

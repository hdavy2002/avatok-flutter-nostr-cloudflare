import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';

import 'auth/clerk_client.dart';
import 'core/onboarding_store.dart';
import 'core/theme.dart';
import 'identity/identity.dart';
import 'features/auth/sign_in_screen.dart';
import 'features/onboarding/onboarding_flow.dart';
import 'features/onboarding/welcome_screen.dart';
import 'push/push_service.dart';
import 'shell/ava_shell.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    await Firebase.initializeApp();
    FirebaseMessaging.onBackgroundMessage(firebaseBackgroundHandler);
    await PushService.init();
  } catch (_) {/* push unavailable; app still works */}
  runApp(const AvaTalkApp());
}

class AvaTalkApp extends StatelessWidget {
  const AvaTalkApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AvaTOK',
      navigatorKey: navigatorKey,
      debugShowCheckedModeBanner: false,
      theme: AvaTheme.light,
      // Bump all text up ~18% (on top of the user's system setting) so the UI
      // isn't tiny, while still respecting accessibility scaling.
      builder: (context, child) {
        final mq = MediaQuery.of(context);
        final base = mq.textScaler.scale(1.0);
        return MediaQuery(
          data: mq.copyWith(textScaler: TextScaler.linear((base * 1.18).clamp(1.0, 2.0))),
          child: child!,
        );
      },
      home: const RootFlow(),
    );
  }
}

enum _Stage { loading, welcome, signIn, onboarding, shell }

class RootFlow extends StatefulWidget {
  const RootFlow({super.key});
  @override
  State<RootFlow> createState() => _RootFlowState();
}

class _RootFlowState extends State<RootFlow> {
  final _clerk = ClerkClient();
  final _onb = OnboardingStore();
  _Stage _stage = _Stage.loading;

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    bool signedIn = false;
    try {
      final cu = await _clerk.currentUser();
      AccountScope.id = cu?.id; // scope the Nostr identity to this account
      signedIn = cu != null;
    } catch (_) {}
    if (!signedIn) { _to(_Stage.welcome); return; }
    _to(await _onb.isDone() ? _Stage.shell : _Stage.onboarding);
  }

  void _to(_Stage s) { if (mounted) setState(() => _stage = s); }

  Future<void> _afterAuth() async {
    try { AccountScope.id = (await _clerk.currentUser())?.id; } catch (_) {}
    _to(await _onb.isDone() ? _Stage.shell : _Stage.onboarding);
  }

  /// Full sign-out: clear any pushed screens (AvaTok/Settings/etc.), end the
  /// Clerk session, then return to welcome. Centralised so every "Log out"
  /// entry point behaves the same (the bug was: pushed routes stayed on top,
  /// so logout appeared to do nothing and the session was never cleared).
  Future<void> _signOut() async {
    navigatorKey.currentState?.popUntil((r) => r.isFirst);
    try { await _clerk.signOut(); } catch (_) {/* clear locally regardless */}
    AccountScope.id = null;
    _to(_Stage.welcome);
  }

  @override
  Widget build(BuildContext context) {
    switch (_stage) {
      case _Stage.loading:
        return const Scaffold(body: Center(child: CircularProgressIndicator(color: AvaColors.brand)));
      case _Stage.welcome:
        return WelcomeScreen(onContinue: () => _to(_Stage.signIn));
      case _Stage.signIn:
        return SignInScreen(clerk: _clerk, onSignedIn: _afterAuth);
      case _Stage.onboarding:
        return OnboardingFlow(onComplete: () => _to(_Stage.shell));
      case _Stage.shell:
        return AvaShell(clerk: _clerk, onSignOut: _signOut);
    }
  }
}

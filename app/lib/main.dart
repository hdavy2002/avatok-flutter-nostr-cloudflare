import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';

import 'auth/clerk_client.dart';
import 'core/account_restore.dart';
import 'core/analytics.dart';
import 'core/api_auth.dart';
import 'core/onboarding_store.dart';
import 'core/prefs_sync.dart';
import 'core/theme.dart';
import 'identity/identity.dart';
import 'features/auth/sign_in_screen.dart';
import 'features/auth/restore_screen.dart';
import 'features/avatok/contacts.dart';
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
  // Product analytics + error tracking (best-effort).
  await Analytics.init();
  // Route every uncaught error to PostHog as a $exception so crashes are queryable.
  final priorOnError = FlutterError.onError;
  FlutterError.onError = (details) {
    priorOnError?.call(details);
    Analytics.captureException(details.exception, details.stack);
  };
  WidgetsBinding.instance.platformDispatcher.onError = (error, stack) {
    Analytics.captureException(error, stack);
    return false; // let the platform continue its default handling too
  };
  runApp(const AvaTalkApp());
}

class AvaTalkApp extends StatelessWidget {
  const AvaTalkApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AvaTOK',
      navigatorKey: navigatorKey,
      navigatorObservers: [Analytics.observer], // auto $screen on every route
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

enum _Stage { loading, welcome, signIn, onboarding, restore, shell }

class RootFlow extends StatefulWidget {
  const RootFlow({super.key});
  @override
  State<RootFlow> createState() => _RootFlowState();
}

class _RootFlowState extends State<RootFlow> with WidgetsBindingObserver {
  final _clerk = ClerkClient();
  final _onb = OnboardingStore();
  final _idStore = IdentityStore();
  _Stage _stage = _Stage.loading;
  RestoreState? _restoreState;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Dual auth: every signed API call carries NIP-98 (key ownership) + a Clerk
    // session JWT (verified account). The Worker requires both on mutations.
    ApiAuth.clerkBearer = _clerk.sessionToken;
    _boot();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Back up the user's prefs to the cross-device vault whenever the app goes
    // to the background — captures any settings/app-toggle/filter changes.
    if (state == AppLifecycleState.paused || state == AppLifecycleState.inactive) {
      if (ApiAuth.identity != null) PrefsSync.push();
    }
  }

  Future<void> _boot() async {
    bool signedIn = false;
    try {
      final cu = await _clerk.currentUser();
      AccountScope.id = cu?.id; // scope the Nostr identity to this account
      signedIn = cu != null;
    } catch (_) {}
    if (!signedIn) { _to(_Stage.welcome); return; }
    await _route();
  }

  void _to(_Stage s) { if (mounted) setState(() => _stage = s); }

  Future<void> _afterAuth() async {
    try { AccountScope.id = (await _clerk.currentUser())?.id; } catch (_) {}
    await _route();
  }

  /// Decide where a signed-in user lands. The key safety rule: a user the server
  /// already knows (existing account) is NEVER sent to onboarding — they're
  /// restored automatically or shown the recovery screen — so they can't
  /// accidentally create a second handle and think their data vanished.
  Future<void> _route() async {
    // Already have this account's key on this device → normal path.
    Identity? local;
    try { local = await _idStore.load(); } catch (_) {}
    if (local != null) {
      final done = await _onb.isDone();
      if (done) ContactsStore().pullAndMerge(); // sync contacts from the vault
      _to(done ? _Stage.shell : _Stage.onboarding);
      return;
    }
    // Fresh install / new device → ask the server who this account is.
    RestoreState st;
    try { st = await AccountRestore.restoreFromServer(); }
    catch (_) { st = const RestoreState(RestoreOutcome.unavailable); }
    switch (st.outcome) {
      case RestoreOutcome.restored:
        ContactsStore().pullAndMerge(); // bring the user's contacts to this device
        _to(_Stage.shell);
        return;
      case RestoreOutcome.newUser:
        _to(_Stage.onboarding);
        return;
      case RestoreOutcome.needsRecovery:
      case RestoreOutcome.unavailable:
        setState(() => _restoreState = st);
        _to(_Stage.restore);
        return;
    }
  }

  /// Full sign-out: clear any pushed screens (AvaTok/Settings/etc.), end the
  /// Clerk session, then return to welcome. Centralised so every "Log out"
  /// entry point behaves the same (the bug was: pushed routes stayed on top,
  /// so logout appeared to do nothing and the session was never cleared).
  Future<void> _signOut() async {
    navigatorKey.currentState?.popUntil((r) => r.isFirst);
    try { await _clerk.signOut(); } catch (_) {/* clear locally regardless */}
    AccountScope.id = null;
    AuthSession.lastPassword = null;
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
      case _Stage.restore:
        return RestoreScreen(
          state: _restoreState ?? const RestoreState(RestoreOutcome.unavailable),
          onRestored: () => _to(_Stage.shell),
          onRetry: () { _to(_Stage.loading); _route(); },
          onSignOut: _signOut,
        );
      case _Stage.shell:
        return AvaShell(clerk: _clerk, onSignOut: _signOut);
    }
  }
}

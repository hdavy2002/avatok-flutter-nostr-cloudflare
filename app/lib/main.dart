import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import 'auth/clerk_client.dart';
import 'core/account_gate.dart';
import 'core/account_restore.dart';
import 'core/analytics.dart';
import 'core/api_auth.dart';
import 'core/app_registry.dart';
import 'core/apps.dart';
import 'core/ava_bootstrap.dart';
import 'core/ava_log.dart';
import 'core/db.dart';
import 'core/deep_links.dart';
import 'core/disk_cache.dart';
import 'core/font_scale.dart';
import 'core/guest_session.dart';
import 'core/onboarding_store.dart';
import 'core/prefs_sync.dart';
import 'core/profile_store.dart';
import 'core/remote_config.dart';
import 'core/theme.dart';
import 'core/ui/zine_widgets.dart';
import 'firebase_options.dart';
import 'identity/identity.dart';
import 'features/auth/sign_in_screen.dart';
import 'features/auth/restore_screen.dart';
import 'features/avatok/contacts.dart';
import 'features/identity/human_check_page.dart';
import 'features/identity/ladder_api.dart';
import 'features/onboarding/handle_claim_screen.dart';
import 'features/onboarding/onboarding_flow.dart';
import 'features/onboarding/welcome_screen.dart';
import 'push/push_service.dart';
import 'shell/ava_shell.dart';
import 'sync/sync_hub.dart';

void main() async {
  final t0 = DateTime.now(); // for first_frame_ms telemetry (PERF-6)
  WidgetsFlutterBinding.ensureInitialized();
  // RAM budget (Scale proposal Phase 1): cap the global decoded-image cache.
  // Flutter's default is 1000 images / 100MB with no upper bound enforcement on
  // some paths; avatar grids + media threads on cheap phones benefit from a hard
  // ceiling. Disk caches (avatar_cache/media) make re-decodes cheap.
  PaintingBinding.instance.imageCache.maximumSize = 300;
  PaintingBinding.instance.imageCache.maximumSizeBytes = 64 << 20; // 64 MB
  // User's app-wide font-size preference (Settings → Display & fonts). Cheap
  // local prefs read — kept before runApp so the first frame's text scale is
  // right (everything else heavy is deferred to post-first-frame below).
  try { await FontScale.load(); } catch (_) {/* default scale */}
  // Remote kill switches (A2): fetch in the background; never blocks startup.
  unawaited(RemoteConfig.start());
  // Route every uncaught error to PostHog as a $exception so crashes are queryable.
  final priorOnError = FlutterError.onError;
  FlutterError.onError = (details) {
    priorOnError?.call(details);
    Analytics.captureException(details.exception, details.stack);
  };
  WidgetsBinding.instance.platformDispatcher.onError = (error, stack) {
    // A Wi-Fi / DNS blip (failed host lookup on clerk.avatok.ai, an inbox-WS
    // 401/abort, a dropped tool call) surfaces here as an UNCAUGHT async error.
    // Previously we returned false, so the platform's default handling could
    // terminate the app — i.e. a transient network drop crashed AvaTOK. Swallow
    // those connectivity errors (still logged, tagged so they don't pollute the
    // crash dashboard) so the app degrades gracefully; let genuine bugs fall
    // through to default handling as before.
    final transient = _isTransientNetworkError(error);
    Analytics.captureException(error, stack,
        screen: transient ? 'network_transient' : null);
    return transient; // true = handled (no crash); false = default handling
  };
  // Everything heavy (analytics native setup, Firebase, push init incl. the
  // permission dialog, disk-cache purge, Ava bootstrap) runs AFTER the first
  // frame so the user sees UI from local state immediately (P0-3 audit fix).
  WidgetsBinding.instance.addPostFrameCallback((_) {
    // Compute the ms now (at first frame); the event is sent from inside
    // _deferredInit once Analytics.init() has completed (PERF-6).
    final firstFrameMs = DateTime.now().difference(t0).inMilliseconds;
    unawaited(_deferredInit(firstFrameMs: firstFrameMs));
  });
  runApp(const AvaTalkApp());
}

/// Post-first-frame initialization. Order preserved from the old pre-runApp
/// sequence: Analytics FIRST (so a Firebase init failure is still captured),
/// then Firebase, then the rest.
Future<void> _deferredInit({int? firstFrameMs}) async {
  // One-time image-cache self-heal on this new build (owner request 2026-07-01):
  // a corrupt cached avatar was crashing the image decoder ("Invalid image data")
  // and freezing the app — reinstalling only "fixed" it by wiping the cache. Purge
  // the on-disk image cache ONCE here (keyed to the build tag) + drop the in-memory
  // cache, so testers never have to reinstall. Account/contacts/history untouched.
  try {
    await DiskCache.flushImageCachesOnce('img_cache_flush_0_1_17_20');
    PaintingBinding.instance.imageCache.clear();
    PaintingBinding.instance.imageCache.clearLiveImages();
  } catch (_) {/* never block boot on a cache purge */}
  // Product analytics + error tracking (best-effort) — init FIRST so we can
  // capture a Firebase init failure instead of silently swallowing it.
  await Analytics.init();
  // Startup performance metric (PERF-6): ms from main() entry to first frame.
  // Proves/regresses the deferred-init work on real devices (target: <1s).
  if (firstFrameMs != null) {
    Analytics.capture('first_frame_ms', {'ms': firstFrameMs});
  }
  // Initialize Firebase from EXPLICIT options (not the google-services resource
  // lookup, which was failing in CI and broke phone OTP with core/no-app).
  try {
    await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  } catch (e, st) {
    Analytics.captureException(e, st, screen: 'startup_firebase_init');
  }
  // Ava in-chat layer init (Phase 0). Single startup hook — later phases plug in
  // tools/memory/settings sections via their own files. Non-blocking + guarded.
  try { await AvaBootstrap.init(); } catch (_) {/* never block boot on Ava init */}
  // Push is separate: a messaging failure must not block the app. Runs post-
  // first-frame so the notification-permission dialog never hides the UI.
  try {
    FirebaseMessaging.onBackgroundMessage(firebaseBackgroundHandler);
    await PushService.init();
  } catch (_) {/* push unavailable; app still works */}
}

/// True for transient connectivity failures (no network / DNS / socket / WS drop)
/// that should NOT crash the app. Matched by type name + message so we don't have
/// to import dart:io / http / web_socket_channel just for `is` checks.
bool _isTransientNetworkError(Object error) {
  final type = error.runtimeType.toString();
  final msg = error.toString().toLowerCase();
  const typeMarkers = [
    'SocketException',
    'WebSocketException',
    'WebSocketChannelException',
    'ClientException',
    'HandshakeException',
    'TimeoutException',
    'HttpException',
    // (Ably was fully removed; its transient-error suppression entry was dropped
    // in [P0-CLEAN-3]. PartyKit is the ephemeral realtime layer now.)
  ];
  for (final t in typeMarkers) {
    if (type.contains(t)) return true;
  }
  const msgMarkers = [
    'failed host lookup',
    'no address associated with hostname',
    'software caused connection abort',
    'connection closed',
    'connection reset',
    'connection refused',
    'connection timed out',
    'network is unreachable',
    'was not upgraded to websocket',
    'os error: errno = 7',
    'broken pipe',
  ];
  for (final m in msgMarkers) {
    if (msg.contains(m)) return true;
  }
  return false;
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
      // Text scaling = OS accessibility setting × the app's base bump (~22%) ×
      // the user's own Display & fonts choice (FontScale). Listens live so the
      // whole app re-scales the instant the user moves the slider.
      builder: (context, child) {
        final mq = MediaQuery.of(context);
        final sys = mq.textScaler.scale(1.0);
        return ValueListenableBuilder<double>(
          valueListenable: FontScale.scale,
          builder: (_, userScale, __) => MediaQuery(
            data: mq.copyWith(
                textScaler: TextScaler.linear((sys * 1.22 * userScale).clamp(0.9, 2.8))),
            child: child!,
          ),
        );
      },
      home: const RootFlow(),
    );
  }
}

enum _Stage { loading, welcome, handleClaim, signIn, onboarding, restore, humanCheck, shell }

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
    // On a 401 (e.g. the session JWT lapsed during a backgrounded OAuth round-
    // trip), repair the session once — rate-limited inside ApiAuth — instead of
    // letting authed calls storm and blank the thread.
    ApiAuth.onAuthExpired = _clerk.warmSession;
    // Let any deep widget upgrade an L0 guest to an L1 member (AccountGate):
    // it drives the Clerk sign-up, then calls back here to re-scope the app.
    AccountGate.clerk = _clerk;
    AccountGate.onUpgraded = _promoteGuestToMember;
    _boot();
    // Route incoming "add me on AvaTOK" QR links to the add-contact card.
    DeepLinks.init(navigatorKey);
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
    // RAM budget: release decoded images when backgrounded — the OS is most
    // likely to kill us for memory exactly then, and the disk caches mean
    // re-decode on resume is cheap.
    if (state == AppLifecycleState.paused) {
      PaintingBinding.instance.imageCache.clear();
      PaintingBinding.instance.imageCache.clearLiveImages();
    }
    // Returning from background — often an app-connect OAuth round-trip in the
    // browser — can leave the cached Clerk session JWT stale. Refresh it BEFORE
    // the chat thread's read/poll loops resume so authed calls (/api/msg/read,
    // InboxDO WS) don't 401-storm the thread into a blank screen.
    if (state == AppLifecycleState.resumed && ApiAuth.identity != null) {
      unawaited(_clerk.warmSession());
      // Force the realtime InboxDO socket to prove it's alive (or reconnect) the
      // moment we're foregrounded, so a chat catches up in seconds instead of
      // waiting for a half-open socket to time out — the "reopened the app and
      // the message still wasn't there" report.
      SyncHub.I.onAppResumed();
    }
  }

  static const _kAcct = 'clerk_account_id';

  Future<void> _boot() async {
    // LOCAL-FIRST boot (the WhatsApp model): if we remember the account and its
    // key is stored locally, render the app IMMEDIATELY from local state and
    // validate the Clerk session in the BACKGROUND. currentUser() is a network
    // call to Clerk — blocking on it at boot (esp. on flaky mobile DNS) was a big
    // chunk of the cold-start wait. Fresh installs / signed-out fall back to the
    // online check.
    try {
      final cachedId = await DiskCache.readGlobal(_kAcct);
      if (cachedId != null && cachedId.isNotEmpty) {
        AccountScope.id = cachedId;
        final local = await _idStore.load(); // in-memory cached after first read
        if (local != null && await _onb.isDone()) {
          // [LIVE-GATE-4] instant local gate: when the human-check flag is ON and
          // this account's CACHED level is < 2 (not liveness-verified), hold at the
          // human check instead of the shell — no network on the critical path.
          // (_validateClerkInBackground still runs; the gate page confirms server
          // truth before letting the user proceed.)
          if (RemoteConfig.livenessOnboardingGate && await LadderApi.cachedLevel() < 2) {
            Analytics.capture('liveness_gate_shown', const {'source': 'redirect'});
            _to(_Stage.humanCheck);
            unawaited(_validateClerkInBackground());
            return;
          }
          _to(_Stage.shell); // instant — no network on the critical path
          unawaited(_validateClerkInBackground());
          ContactsStore().pullAndMerge();
          return;
        }
      } else {
        // No Clerk account remembered — but a returning L0 guest who already
        // claimed a handle and set up locally goes straight back into the app
        // (browse mode). They stay in the default scope until they upgrade.
        final guestHandle = await GuestSession.reservedHandle();
        if (guestHandle != null && guestHandle.isNotEmpty) {
          AccountScope.id = null;
          final local = await _idStore.load();
          if (local != null && await _onb.isDone()) {
            _to(_Stage.shell);
            return;
          }
        }
      }
    } catch (_) {/* fall through to the online path */}
    await _bootOnline();
  }

  /// The original network boot — used on fresh install / signed-out, or when we
  /// have no local session to trust.
  Future<void> _bootOnline() async {
    // Self-heal a corrupt secure store before doing anything online. On a
    // Keystore⇄ciphertext mismatch (BAD_DECRYPT after an update / OS restore /
    // device transfer) [IdentityStore.load] can't return the key and flags
    // [storageCorrupt]; without recovery the app loops forever on the "Can't
    // reach AvaTOK" reconnect screen. Both the corrupt-member path (local == null
    // falls through here) and the guest path funnel through _bootOnline, so this
    // is the single chokepoint. Runs at most once (the wipe clears the flag).
    if (IdentityStore.storageCorrupt) await _recoverFromCorruptStorage();
    bool signedIn = false;
    try {
      final t0 = DateTime.now();
      final cu = await _clerk.currentUser();
      AvaLog.I.log('boot', 'clerk currentUser (online) ${DateTime.now().difference(t0).inMilliseconds}ms signedIn=${cu != null}');
      AccountScope.id = cu?.id; // scope the Nostr identity to this account
      if (cu?.id != null) await DiskCache.writeGlobal(_kAcct, cu!.id);
      // Bridge telemetry: link the uid distinct_id to the Clerk uid the Worker
      // stamps, so client + server events land on one person in PostHog.
      if (cu?.id != null && cu!.id.isNotEmpty) unawaited(Analytics.aliasClerk(cu.id));
      signedIn = cu != null;
    } catch (_) {}
    // Fresh / signed-out → start at the Welcome hero (step 1), which leads into
    // social sign-in. (Simple flow: Welcome → Login → Terms → Notifications.)
    if (!signedIn) { _to(_Stage.welcome); return; }
    await _route();
  }

  /// Recover from an un-decryptable secure store (Android Keystore ⇄
  /// EncryptedSharedPreferences mismatch — a `BadPaddingException` / `BAD_DECRYPT`
  /// on the FIRST key read after an app update, OS/cloud backup restore, or device
  /// transfer). The stored ciphertext survives the restore but the Keystore key
  /// that decrypts it does not, so every launch used to throw out of boot and sit
  /// on the "Can't reach AvaTOK" reconnect screen in a relaunch loop.
  ///
  /// Recovery = treat the device like a fresh install and let the server rebuild
  /// it: wipe the un-decryptable secure store + all on-disk caches, forget the
  /// remembered account pointer, then fall through to the normal online boot. The
  /// account, keys, messages (re-synced from cursor 0), groups (re-adopted) and
  /// profile all come back from the server via [_route] → key restore + /api/me.
  /// Runs at most once per corruption (the wipe clears [storageCorrupt]).
  Future<void> _recoverFromCorruptStorage() async {
    if (!IdentityStore.storageCorrupt) return;
    Analytics.capture('storage_recovered', const {'reason': 'bad_decrypt'});
    AvaLog.I.log('storage',
        'secure store un-decryptable (BAD_DECRYPT) — wiping local state, re-restoring from server');
    // 1. Drop every secure-storage entry (all corrupt on a Keystore mismatch).
    try { await _idStore.wipeAllSecureStorage(); } catch (_) {}
    // 2. Clear all on-disk caches + the remembered-account pointer so nothing
    //    stale renders; the server restore rebuilds them.
    try { await DiskCache.purgeAllCaches(); } catch (_) {}
    // 3. Drop the open local DB handle so it reopens clean for the restored scope.
    try { await Db.reset(); } catch (_) {}
    AccountScope.id = null;
    IdentityStore.storageCorrupt = false; // one-shot guard
  }

  /// Validate/refresh the Clerk session AFTER the UI is already on screen. Only
  /// signs out on a definitive revocation (currentUser returns null = no token);
  /// a network error keeps the local session (offline-friendly). Also logs how
  /// long Clerk actually takes (the measurement).
  Future<void> _validateClerkInBackground() async {
    try {
      final t0 = DateTime.now();
      final cu = await _clerk.currentUser();
      AvaLog.I.log('boot', 'clerk validate (bg) ${DateTime.now().difference(t0).inMilliseconds}ms signedIn=${cu != null}');
      if (cu == null) { await _signOut(); return; } // session revoked server-side
      // Bridge uid ↔ Clerk uid for cross-stack telemetry joins (every app open
      // hits this background-validate path).
      if (cu.id.isNotEmpty) unawaited(Analytics.aliasClerk(cu.id));
      if (cu.id != AccountScope.id) { // account changed under us — re-route
        AccountScope.id = cu.id;
        await DiskCache.writeGlobal(_kAcct, cu.id);
        await _route();
        return;
      }
      await DiskCache.writeGlobal(_kAcct, cu.id);
    } catch (_) {/* offline — keep showing the local session */}
  }

  void _to(_Stage s) { if (mounted) setState(() => _stage = s); }

  /// STREAM H [LIVE-GATE-4]: the onboarding human-check gate. An existing member
  /// who has NOT passed liveness is redirected to the non-dismissible human check
  /// on app open when the livenessOnboardingGate flag is ON (D13 — no grace).
  /// Guests (L0) and the flag-off case are never gated here (the server is still
  /// the real gate on spam-capable routes). Returns true when the user should be
  /// held at the human check instead of landing on the shell.
  Future<bool> _needsHumanCheck() async {
    if (!RemoteConfig.livenessOnboardingGate) return false;
    if (!AccountGate.isMember) return false; // L0 guest — no account yet, no gate
    // Fast path: cached level ≥2 means liveness already passed (instant, offline).
    if (await LadderApi.cachedLevel() >= 2) return false;
    // Confirm against server truth before blocking (avoids a stale-cache lockout).
    final ld = await LadderApi.level();
    final level = ld?.level ?? await LadderApi.cachedLevel();
    return level < 2;
  }

  /// Land the signed-in member on the shell, OR hold them at the human-check gate
  /// first (D13). Centralised so every "go to shell" path honours the gate.
  Future<void> _landOrGate() async {
    if (await _needsHumanCheck()) {
      Analytics.capture('liveness_gate_shown', const {'source': 'redirect'});
      _to(_Stage.humanCheck);
      return;
    }
    _to(_Stage.shell);
  }

  Future<void> _afterAuth() async {
    try {
      final cu = await _clerk.currentUser();
      AccountScope.id = cu?.id;
      if (cu?.id != null) await DiskCache.writeGlobal(_kAcct, cu!.id);
    } catch (_) {}
    await _route();
  }

  /// Handle claimed → walk straight into the app as an L0 guest. No sign-up
  /// wall and no multi-step setup: we mint the device identity, default the
  /// app set, and render the shell. Everything lives in the default
  /// (un-scoped) space and migrates forward automatically if/when the guest
  /// upgrades to a real account (see [_promoteGuestToMember]).
  Future<void> _enterAsGuest() async {
    AccountScope.id = null; // L0 guests browse in the default scope
    try {
      final existing = await _idStore.load();
      if (existing == null) await _idStore.createAndStore();
    } catch (_) {/* identity is best-effort; the shell still renders */}
    if (!await _onb.isDone()) {
      await _onb.setEnabledApps(kApps
          .where((a) => a.defaultOn && AppRegistry.isStandard(a.key))
          .map((a) => a.key)
          .toSet());
      await _onb.setDone();
    }
    Analytics.capture('guest_entered_app', const {});
    _to(_Stage.shell);
  }

  /// L0 guest → L1 member (AccountGate). Called after the Clerk sign-up
  /// completes. Re-scopes the app to the new Clerk account, carries the guest's
  /// local state forward, and merges the reserved @handle into the real
  /// account. The shell stays mounted — only the gated action resumes.
  Future<void> _promoteGuestToMember() async {
    // Read guest-scope bits BEFORE the scope flips: DiskCache is keyed by
    // AccountScope.id and (unlike the identity/secure-storage keys) does not
    // auto-migrate, so we re-stamp these under the new scope below.
    final guestHandle = await GuestSession.reservedHandle();
    Set<String> apps;
    try { apps = await _onb.enabledApps(); } catch (_) { apps = <String>{}; }

    try {
      final cu = await _clerk.currentUser();
      if (cu?.id != null && cu!.id.isNotEmpty) {
        AccountScope.id = cu.id;
        await DiskCache.writeGlobal(_kAcct, cu.id);
      }
    } catch (_) {}

    // Carry onboarding state into the Clerk-scoped space so the member is never
    // bounced back through onboarding on the next launch.
    if (apps.isNotEmpty) await _onb.setEnabledApps(apps);
    await _onb.setDone();
    try { await _idStore.load(); } catch (_) {} // migrates the guest uid forward

    // Keep their reserved @handle on the profile, then merge it server-side.
    if (guestHandle != null && guestHandle.isNotEmpty) {
      try {
        final prof = await ProfileStore().load();
        if (prof.handle.isEmpty) {
          await ProfileStore().save(prof.copyWith(handle: guestHandle));
        }
      } catch (_) {}
    }
    try { await GuestSession.upgradeIfAny(); } catch (_) {}

    PrefsSync.push();
    ContactsStore().pullAndMerge();
    Analytics.capture('guest_upgraded_to_member', const {});
    if (mounted) setState(() {}); // refresh AccountGate.isMember-driven UI
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
      if (done) {
        ContactsStore().pullAndMerge(); // sync contacts from the vault
        await _landOrGate(); // [LIVE-GATE-4] hold at human check if unverified + flag on
      } else {
        _to(_Stage.onboarding);
      }
      return;
    }
    // Fresh install / new device → ask the server who this account is.
    RestoreState st;
    try { st = await AccountRestore.restoreFromServer(); }
    catch (_) { st = const RestoreState(RestoreOutcome.unavailable); }
    switch (st.outcome) {
      case RestoreOutcome.restored:
        ContactsStore().pullAndMerge(); // bring the user's contacts to this device
        await _landOrGate(); // [LIVE-GATE-4] gate a restored-but-unverified account too
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
    await DiskCache.deleteGlobal(_kAcct); // forget the remembered account
    _to(_Stage.signIn);
  }

  @override
  Widget build(BuildContext context) {
    // Forced-update gate (A2): minAppBuild above the installed build blocks the
    // app until updated. Listens to config revisions so a remote flip applies
    // within one poll cycle without restarting.
    return ValueListenableBuilder<int>(
      valueListenable: RemoteConfig.revision,
      builder: (context, _, __) {
        if (RemoteConfig.updateRequired) return const _UpdateRequiredScreen();
        return _stageBody();
      },
    );
  }

  Widget _stageBody() {
    switch (_stage) {
      case _Stage.loading:
        return const Scaffold(body: Center(child: CircularProgressIndicator(color: Zine.blueInk)));
      case _Stage.welcome:
        // Google-only auth (2026-06-18): the welcome hero leads straight into
        // Google sign-in. The handle is picked AFTER auth in OnboardingFlow's
        // profile step (the pre-auth handle-claim screen is no longer in the flow).
        return WelcomeScreen(onContinue: () => _to(_Stage.signIn));
      case _Stage.handleClaim:
        return HandleClaimScreen(
          onClaimed: _enterAsGuest, // claim a handle → browse as an L0 guest
          onHaveAccount: () => _to(_Stage.signIn),
        );
      case _Stage.signIn:
        return SignInScreen(
          clerk: _clerk,
          onSignedIn: _afterAuth,
          // "New here? Sign up" → back to claim a handle (handle-first), NOT the
          // email/password form (that only surfaces from the AccountGate).
          onSignUpRequested: () => _to(_Stage.handleClaim),
        );
      case _Stage.onboarding:
        return OnboardingFlow(onComplete: () => _to(_Stage.shell));
      case _Stage.restore:
        return RestoreScreen(
          state: _restoreState ?? const RestoreState(RestoreOutcome.unavailable),
          onRestored: () => _to(_Stage.shell),
          onRetry: () { _to(_Stage.loading); _route(); },
          onSignOut: _signOut,
        );
      case _Stage.humanCheck:
        // [LIVE-GATE-4] non-dismissible redirect for an existing unverified user.
        // On pass, re-route through _landOrGate → the app shell.
        return HumanCheckPage(
          source: HumanCheckSource.redirect,
          onVerified: () { unawaited(_landOrGate()); },
        );
      case _Stage.shell:
        return AvaShell(clerk: _clerk, onSignOut: _signOut);
    }
  }
}

/// Blocking screen shown when the server's minAppBuild is newer than this
/// build (remote kill switch A2). No way past it except updating.
class _UpdateRequiredScreen extends StatelessWidget {
  const _UpdateRequiredScreen();
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ZinePaper(
        child: SafeArea(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 36),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                ZineCrest(
                  size: 116,
                  child: PhosphorIcon(PhosphorIcons.downloadSimple(PhosphorIconsStyle.bold), size: 52, color: Zine.ink),
                ),
                const SizedBox(height: 24),
                const ZineMarkTitle(pre: 'Update ', mark: 'required', fontSize: 34),
                const SizedBox(height: 12),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 300),
                  child: Text(
                    'This version of AvaTOK is taking a rest. '
                    'Grab the latest update to pick up where you left off.',
                    textAlign: TextAlign.center,
                    style: ZineText.sub(size: 14.5),
                  ),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

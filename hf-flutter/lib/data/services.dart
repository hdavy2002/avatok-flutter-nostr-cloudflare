import 'dart:async';

import 'package:package_info_plus/package_info_plus.dart';
import 'package:flutter/foundation.dart';

import '../demo/state.dart';
import 'api_client.dart';
import 'call_flags.dart'; // [HF-CALL-MODES-E2]
import 'auth/clerk_client.dart';
import 'intro_store.dart';
import 'models/me.dart';
import 'repos/auth_repo.dart';
import 'repos/bookings_repo.dart';
import 'repos/call_safety_repo.dart'; // [HF-CALL-SAFETY-APP]
import 'repos/calls_repo.dart';
import 'repos/channels_repo.dart';
import 'youtube_sign_in.dart';
import 'favourites_store.dart';
import 'repos/config_repo.dart';
import 'repos/favourites_repo.dart';
import 'repos/me_repo.dart';
import 'repos/merch_repo.dart'; // [HF-MERCH-APP-1]
import 'repos/payouts_repo.dart';
import 'repos/queue_repo.dart'; // [HF-CALL-MODES-E2]
import 'reel_comments_cache.dart';
import 'reel_engage_store.dart';
import 'repos/reel_engage_repo.dart';
import 'repos/reels_repo.dart';
import 'repos/safety_repo.dart'; // [HF-APP-PARITY-SAFETY]
import 'repos/search_repo.dart';
import 'repos/spaces_repo.dart'; // [HF-CREATOR-SPACES-1]
import 'repos/wallet_repo.dart';
import 'push.dart'; // [HF-BOOK-APPROVE-PUSH]
import 'response_cache.dart'; // [HF-APP-CACHE-1]
import 'telemetry.dart';

/// The app-wide singletons: Clerk, the API client and the repositories. Plain Dart (no provider tree)
/// so the demo screens, which are still global-state based, can reach it. Everything is lazy, so
/// importing this file in a test touches no platform channel.
class Services {
  Services._();

  static final Services instance = Services._();

  late final ClerkApi clerk = ClerkClient();
  /// [HF-APP-CACHE-1] Account reads stay in memory; only explicitly public responses can reach disk.
  late final ApiClient api = ApiClient(
    tokens: clerk.sessionToken,
    onSessionLost: _sessionLost,
    cache: ResponseCache(persist: true),
    accountId: () => user?.id,
  );
  late final MeRepo meRepo = MeRepo(api);
  late final ConfigRepo configRepo = ConfigRepo(api);
  late final AuthRepo authRepo = AuthRepo(
    api: api,
    clerk: clerk,
    onSignedIn: (u) => user = u,
    refreshMe: refreshMe,
  );
  late final ChannelsRepo channelsRepo = ChannelsRepo(api); // [HF-WIRE-3]
  late final BookingsRepo bookingsRepo = BookingsRepo(api); // [HF-WIRE-8]
  late final ReelsRepo reelsRepo = ReelsRepo(api); // [HF-WIRE-4]
  late final ReelEngageRepo reelEngageRepo = ReelEngageRepo(api, signedIn: () => isSignedIn); // [HF-REEL-ENGAGE-APP-1]
  late final YoutubeSignIn youtubeSignIn = GoogleYoutubeSignIn(); // [HF-WIRE-14] created on first use
  late final WalletRepo walletRepo = WalletRepo(api); // [HF-WIRE-6]
  late final CallsRepo callsRepo = CallsRepo(api); // [HF-WIRE-7]
  late final QueueRepo queueRepo = QueueRepo(api); // [HF-CALL-MODES-E2]
  late final PayoutsRepo payoutsRepo = PayoutsRepo(api); // [HF-WIRE-10]
  late final SearchRepo searchRepo = SearchRepo(api); // [HF-WIRE-9]
  late final FavouritesRepo favouritesRepo = FavouritesRepo(api); // [HF-WIRE-9]
  late final MerchRepo merchRepo = MerchRepo(api); // [HF-MERCH-APP-1]
  late final SafetyRepo safetyRepo = SafetyRepo(api); // [HF-APP-PARITY-SAFETY]
  late final SpacesRepo spacesRepo = SpacesRepo(api); // [HF-CREATOR-SPACES-1]
  late final CallSafetyRepo callSafetyRepo = CallSafetyRepo(api); // [HF-CALL-SAFETY-APP]

  /// The signed-in Clerk user, or null (signed out, or no connection at start).
  /// Session changes can precede /me, including an offline or slow restore.
  final ValueNotifier<String?> authAccount = ValueNotifier<String?>(null);

  ClerkUser? _user;
  ClerkUser? get user => _user;
  set user(ClerkUser? value) {
    if (_user?.id != value?.id) {
      final old = _user?.id;
      if (old != null) unawaited(api.cache.clearAccount(old));
      me = null;
      _prefetchedFor = null;
    }
    _user = value;
    authAccount.value = value?.id;
  }

  /// `GET /api/hf/me`, or null until it loaded.
  Me? me;

  /// Result of the start-up update check.
  UpdateStatus updateStatus = UpdateStatus.none;

  /// [HF-BOOK-APPROVE] `hfBookingApprovalEnabled` from the start-up config. False until the config says true, so the
  /// booking screens look exactly as before while the feature is dark (or the config could not be read).
  bool bookingApprovalEnabled = false;

  bool get isSignedIn => user != null;

  /// Influencer earnings and fans' wallet money both leave through Withdraw (HF-REEL-36); refunds only ever land in the wallet (HF-REEL-35).
  bool get viewerIsInfluencer => demo.influencerJoined || me?.hostStatus != null;

  Future<void> _sessionLost() async {
    _forgetCached();
    user = null;
    me = null;
    _prefetchedFor = null;
    PushNotifications.forget(); // [HF-BOOK-APPROVE-PUSH] the session is gone, so the token cannot be removed from here
    demo.signOut();
    FavouritesStore.instance.reset(); // [HF-WIRE-9]
    ReelEngageStore.instance.clear(); // [HF-REEL-ENGAGE-APP-1] nobody's likes leak to the next account
    ReelCommentsCache.instance.clearMemory(); // [HF-REEL-COMMENTS-CACHE-1] the saved lists are per account
  }

  /// [HF-APP-CACHE-1] Wipe this account's cached reads (memory and disk) so the next person on this phone never sees them.
  void _forgetCached() {
    final id = user?.id;
    if (id != null && id.isNotEmpty) unawaited(api.cache.clearAccount(id));
  }

  /// [HF-APP-CACHE-1] Put the last `/me` this account loaded on screen state at once (no network). False when there is none.
  Future<bool> restoreCachedMe() async {
    if (!isSignedIn) return false;
    if (me != null) return true;
    try {
      final id = user?.id;
      final epoch = api.cache.accountGeneration;
      final m = await meRepo.cached();
      if (id != user?.id || epoch != api.cache.accountGeneration || m == null) return false;
      me = m;
      _syncDemoAccount();
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Is there an active Clerk session on this device? Never throws.
  Future<void> restoreSession() async {
    final epoch = api.cache.accountGeneration;
    try {
      final u = await clerk.currentUser();
      if (epoch != api.cache.accountGeneration) return;
      user = (u == null || u.id.isEmpty) ? null : u;
    } catch (_) {
      if (epoch != api.cache.accountGeneration) return;
      user = null;
    }
  }

  /// Reload `/api/hf/me`. A failure keeps the previous value.
  Future<void> refreshMe() async {
    if (!isSignedIn) return;
    try {
      final id = user?.id;
      final epoch = api.cache.accountGeneration;
      final fresh = await meRepo.fetch();
      if (id != user?.id || epoch != api.cache.accountGeneration) return;
      me = fresh;
      _syncDemoAccount();
      unawaited(_syncPush());
      unawaited(prefetch());
    } catch (_) {
      // keep what we had; the api client already reported the failure
    }
  }

  String? _prefetchedFor;

  /// [HF-APP-CACHE-1] Warm the read cache once per account per app run, right after `/me` loads: wallet, the fan's bookings,
  /// favourites, the search landing and topic chips, the first reels page, and for an influencer her bookings and calendar. Every
  /// step is a plain cached GET (never a write), runs in parallel, and swallows its own errors.
  Future<void> prefetch() async {
    final id = user?.id;
    if (id == null || id.isEmpty || _prefetchedFor == id) return;
    _prefetchedFor = id;
    final host = me?.hostStatus != null;
    Future<void> quiet(Future<Object?> Function() run) async {
      try {
        await run();
      } catch (_) {}
    }

    await Future.wait<void>([
      quiet(() => walletRepo.fetch(limit: 1)),
      quiet(() => walletRepo.fetch()),
      quiet(() => bookingsRepo.mine()),
      quiet(() => favouritesRepo.list()),
      quiet(() => searchRepo.topics()),
      quiet(() => searchRepo.search('')),
      quiet(() => reelsRepo.feed()),
      if (host) quiet(() => bookingsRepo.hostBookings()),
      if (host) quiet(() => bookingsRepo.availability()),
    ]);
  }

  /// [HF-BOOK-APPROVE-PUSH] Ask for the notification permission once and register this phone's push token for this
  /// account. Does nothing in a build without Firebase (and in tests). Never throws.
  Future<void> _syncPush() async {
    try {
      if (!PushNotifications.ready) return;
      await PushNotifications.onAccount(api, shell: 'native-${await installedBuild()}');
    } catch (_) {}
  }

  /// Mirror the real account into the screens' shared state (Me header, Settings, `requireAccount`).
  void _syncDemoAccount() {
    final m = me;
    if (m == null) return;
    demo.applyAccount(name: m.name ?? '', email: m.email ?? '', whatsapp: m.phoneMasked ?? '');
  }

  /// Clerk sign-out, then forget everything held for this person (account, cached /me, screen state).
  Future<void> signOut() async {
    if (PushNotifications.ready) await PushNotifications.onSignOut(api); // [HF-BOOK-APPROVE-PUSH] while the session can still authorise the call
    try {
      await clerk.signOut();
    } catch (_) {}
    _forgetCached();
    user = null;
    me = null;
    _prefetchedFor = null;
    demo.signOut();
    FavouritesStore.instance.reset(); // [HF-WIRE-9]
    ReelEngageStore.instance.clear(); // [HF-REEL-ENGAGE-APP-1] nobody's likes leak to the next account
    ReelCommentsCache.instance.clearMemory(); // [HF-REEL-COMMENTS-CACHE-1] the saved lists are per account
  }

  /// Android versionCode, or 0 when unknown (never nag on a guess).
  Future<int> installedBuild() async {
    try {
      final info = await PackageInfo.fromPlatform();
      return int.tryParse(info.buildNumber) ?? 0;
    } catch (_) {
      return 0;
    }
  }

  /// Work done behind the splash countdown: intro-seen flag, session restore, `/me`, app config.
  /// Every step swallows its own errors, so this never throws; results land on the fields above.
  /// The splash gives up waiting after the countdown, and late results are simply kept for later screens.
  Future<void> boot() async {
    final started = Stopwatch()..start();
    await api.cache.initialize();
    if (api.cache.migrationError != null) {
      Telemetry.cacheOutcome('/cache', 'legacy_purge_failed');
    }
    final intro = IntroStore.read().then((seen) {
      if (seen) demo.introSeen = true;
    });
    // [HF-APP-CACHE-1] The saved /me and config are applied first, so the screens that open before the network answers already
    // know who she is and whether approval is on; the fresh answers then replace them.
    final session = restoreSession().then((_) async {
      await restoreCachedMe();
      await refreshMe();
    });
    final config = () async {
      try {
        final saved = await configRepo.cached();
        if (saved != null) {
          bookingApprovalEnabled = saved.bookingApprovalEnabled;
          CallFlags.apply(saved); // [HF-CALL-MODES-E2]
          updateStatus = saved.updateStatusFor(await installedBuild());
        }
      } catch (_) {}
      try {
        final cfg = await configRepo.fetch();
        updateStatus = cfg.updateStatusFor(await installedBuild());
        bookingApprovalEnabled = cfg.bookingApprovalEnabled;
        CallFlags.apply(cfg); // [HF-CALL-MODES-E2]
      } catch (_) {
        // keep what the saved config said; with none saved this stays "none" / false
      }
    }();
    unawaited(api.cache.prune());
    await Future.wait<void>([intro, session, config]);
    Telemetry.appOpen(coldMs: started.elapsedMilliseconds, signedIn: isSignedIn);
  }
}

import 'dart:async';

import 'package:package_info_plus/package_info_plus.dart';

import '../demo/state.dart';
import 'api_client.dart';
import 'auth/clerk_client.dart';
import 'intro_store.dart';
import 'models/me.dart';
import 'repos/auth_repo.dart';
import 'repos/bookings_repo.dart';
import 'repos/calls_repo.dart';
import 'repos/channels_repo.dart';
import 'youtube_sign_in.dart';
import 'favourites_store.dart';
import 'repos/config_repo.dart';
import 'repos/favourites_repo.dart';
import 'repos/me_repo.dart';
import 'repos/payouts_repo.dart';
import 'repos/reels_repo.dart';
import 'repos/search_repo.dart';
import 'repos/wallet_repo.dart';
import 'telemetry.dart';

/// The app-wide singletons: Clerk, the API client and the repositories. Plain Dart (no provider tree)
/// so the demo screens, which are still global-state based, can reach it. Everything is lazy, so
/// importing this file in a test touches no platform channel.
class Services {
  Services._();

  static final Services instance = Services._();

  late final ClerkApi clerk = ClerkClient();
  late final ApiClient api = ApiClient(tokens: clerk.sessionToken, onSessionLost: _sessionLost);
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
  late final YoutubeSignIn youtubeSignIn = GoogleYoutubeSignIn(); // [HF-WIRE-14] created on first use
  late final WalletRepo walletRepo = WalletRepo(api); // [HF-WIRE-6]
  late final CallsRepo callsRepo = CallsRepo(api); // [HF-WIRE-7]
  late final PayoutsRepo payoutsRepo = PayoutsRepo(api); // [HF-WIRE-10]
  late final SearchRepo searchRepo = SearchRepo(api); // [HF-WIRE-9]
  late final FavouritesRepo favouritesRepo = FavouritesRepo(api); // [HF-WIRE-9]

  /// The signed-in Clerk user, or null (signed out, or no connection at start).
  ClerkUser? user;

  /// `GET /api/hf/me`, or null until it loaded.
  Me? me;

  /// Result of the start-up update check.
  UpdateStatus updateStatus = UpdateStatus.none;

  /// [HF-BOOK-APPROVE] `hfBookingApprovalEnabled` from the start-up config. False until the config says true, so the
  /// booking screens look exactly as before while the feature is dark (or the config could not be read).
  bool bookingApprovalEnabled = false;

  bool get isSignedIn => user != null;

  /// Influencer earnings and fans' wallet money both leave through Payout (HF-REEL-36); refunds only ever land in the wallet (HF-REEL-35).
  bool get viewerIsInfluencer => demo.influencerJoined || me?.hostStatus != null;

  Future<void> _sessionLost() async {
    user = null;
    me = null;
    demo.signOut();
    FavouritesStore.instance.reset(); // [HF-WIRE-9]
  }

  /// Is there an active Clerk session on this device? Never throws.
  Future<void> restoreSession() async {
    try {
      final u = await clerk.currentUser();
      user = (u == null || u.id.isEmpty) ? null : u;
    } catch (_) {
      user = null;
    }
  }

  /// Reload `/api/hf/me`. A failure keeps the previous value.
  Future<void> refreshMe() async {
    if (!isSignedIn) return;
    try {
      me = await meRepo.fetch();
      _syncDemoAccount();
    } catch (_) {
      // keep what we had; the api client already reported the failure
    }
  }

  /// Mirror the real account into the screens' shared state (Me header, Settings, `requireAccount`).
  void _syncDemoAccount() {
    final m = me;
    if (m == null) return;
    demo.applyAccount(name: m.name ?? '', email: m.email ?? '', whatsapp: m.phoneMasked ?? '');
  }

  /// Clerk sign-out, then forget everything held for this person (account, cached /me, screen state).
  Future<void> signOut() async {
    try {
      await clerk.signOut();
    } catch (_) {}
    user = null;
    me = null;
    demo.signOut();
    FavouritesStore.instance.reset(); // [HF-WIRE-9]
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
    final intro = IntroStore.read().then((seen) {
      if (seen) demo.introSeen = true;
    });
    final session = restoreSession().then((_) => refreshMe());
    final config = () async {
      try {
        final cfg = await configRepo.fetch();
        updateStatus = cfg.updateStatusFor(await installedBuild());
        bookingApprovalEnabled = cfg.bookingApprovalEnabled;
      } catch (_) {
        updateStatus = UpdateStatus.none;
      }
    }();
    await Future.wait<void>([intro, session, config]);
    Telemetry.appOpen(coldMs: started.elapsedMilliseconds, signedIn: isSignedIn);
  }
}

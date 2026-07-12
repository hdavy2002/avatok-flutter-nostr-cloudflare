import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../auth/clerk_client.dart';
import '../core/account_storage.dart';
import '../core/admin_tools.dart';
import '../core/analytics.dart';
import '../core/app_registry.dart';
import '../core/apps.dart';
import '../core/disk_cache.dart';
import '../core/remote_config.dart';
import '../core/profile_store.dart';
import '../core/ui/zine.dart';
import '../core/ui/zine_widgets.dart';
import '../identity/identity.dart';
import '../features/avaapps/avaapps_screen.dart';
import '../features/ava_companion/companion_home.dart';
import '../features/avachat/voice_call/ai_voice_agent_screen.dart';
import '../features/avalive/avalive_discovery.dart';
import '../features/affiliate/affiliate_home.dart';
import '../features/team/team_home.dart';
import '../features/avavoice/avavoice_home.dart';
import '../features/avavision/avavision_home.dart';
import '../features/avatok/ava_number.dart';
import '../features/avatok/chat_list.dart';
import '../features/avaphone/ava_phone_screen.dart';
import '../features/avatok/invite_screen.dart';
import '../features/avatok/number_settings_screen.dart';
import '../features/ava_backup/backup_service.dart';
import '../features/booking/avabooking_screen.dart';
import '../features/calendar/avacalendar_screen.dart';
import '../features/library/avalibrary_screen.dart';
import '../features/library/avastorage_screen.dart';
import '../features/marketplace/my_listings_screen.dart';
import '../features/marketplace/sell_listing_flow.dart';
import '../features/marketplace/archived_screen.dart';
import '../features/marketplace/marketplace_browse.dart';
import '../features/explore/explore_home.dart';
import '../features/identity/identity_screen.dart';
import '../features/identity/listing_liveness_gate.dart';
import '../features/profile/profile_screen.dart';
import '../features/profile/profile_setup_screen.dart';
import '../features/inbox/inbox_screen.dart';
import '../features/verse/verse_screen.dart';
import '../features/payout/payout_screen.dart';
import '../features/subscribe/subscribe_screen.dart';
import '../features/wallet/wallet_screen.dart';
import '../features/settings/settings_screen.dart';
import 'coming_soon.dart';
import 'focus_mode.dart';
import 'shell_v2.dart';

/// The signed-in app shell. Opens on AvaTOK (messaging) as the home surface;
/// other apps are pushed on top and pop back here.
class AvaShell extends StatefulWidget {
  final ClerkClient clerk;
  final VoidCallback onSignOut;
  const AvaShell({super.key, required this.clerk, required this.onSignOut});
  @override
  State<AvaShell> createState() => _AvaShellState();
}

class _AvaShellState extends State<AvaShell> {
  final _idStore = IdentityStore();

  Identity? _id;
  bool? _profileComplete; // null = checking, false = show gate, true = enter app
  // Compulsory AvaTOK number (owner decision 2026-06-27): a complete profile with
  // NO number must choose one before entering the app — applies to new users at
  // onboarding AND existing users without a number on next open.
  bool _needsNumber = false;
  // STICKY (dup-number fix 2026-07-08): once a number is picked in THIS app run,
  // never re-show the gate. The old flow re-showed it because onDone→_load() re-ran
  // the gate and validateGates() recomputed needsNumber from a STALE AvaNumber.me()
  // (the assignment hadn't propagated yet), so the user was asked for a number a
  // second time right after finishing their profile (proven in PostHog:
  // number_gate_shown fired again immediately after profile_completed).
  bool _numberAssignedThisSession = false;
  String? _authEmail; // email the user signed in with (Clerk) → shown locked in profile
  String? _authFirst; // first name from the Google sign-in → prefills the profile
  String? _authLast;  // last name from the Google sign-in → prefills the profile

  @override
  void initState() {
    super.initState();
    _load();
  }

  // Persisted per-account gate flags (P0-1, local-first shell): '1'/'0' via
  // DiskCache, which is account-scoped automatically (cache/<AccountScope.id>/,
  // same pattern as FocusMode). Lets a returning user enter the app instantly
  // from the last-known gate decisions; the server re-validates in background.
  static const _kProfileCompleteFlag = 'shell_profile_complete';
  static const _kHasNumberFlag = 'shell_has_number';

  Future<void> _load() async {
    final gateT0 = DateTime.now();
    final id = await _idStore.load();
    // Warm the per-account focus-mode value so any sidebar drawer paints the
    // correct menu without a default-then-correct flicker.
    await FocusMode.load();
    // LOCAL-FIRST gates: if both flags are known from a previous launch, render
    // NOW (no network on the critical path) and re-validate in the background.
    String? storedComplete;
    String? storedHasNumber;
    try {
      storedComplete = await DiskCache.read(_kProfileCompleteFlag);
      storedHasNumber = await DiskCache.read(_kHasNumberFlag);
    } catch (_) {/* treat as first run */}
    final haveCache = storedComplete != null && storedComplete.isNotEmpty &&
        storedHasNumber != null && storedHasNumber.isNotEmpty;
    if (haveCache && mounted) {
      final needsNumber = storedHasNumber != '1' && !_numberAssignedThisSession;
      setState(() {
        _id = id;
        _profileComplete = storedComplete == '1';
        _needsNumber = needsNumber;
      });
      Analytics.capture('shell_gate_ms', {
        'ms': DateTime.now().difference(gateT0).inMilliseconds,
        'source': 'cache',
      });
      // Funnel signal: did the user hit the compulsory number gate?
      if (needsNumber) Analytics.capture('number_gate_shown', const {});
    }

    Future<void> validateGates() async {
      // The signed-in email (from Clerk) — used to prefill + lock the profile's
      // email field and satisfy its required-email validation.
      try {
        final u = await widget.clerk.currentUser();
        final email = u?.email;
        // Capture email + Google-provided name for the profile (prefill + lock).
        if (mounted && (email != _authEmail || u?.firstName != _authFirst || u?.lastName != _authLast)) {
          setState(() {
            _authEmail = email ?? _authEmail;
            _authFirst = u?.firstName ?? _authFirst;
            _authLast = u?.lastName ?? _authLast;
          });
        } else {
          _authEmail = email ?? _authEmail;
          _authFirst = u?.firstName ?? _authFirst;
          _authLast = u?.lastName ?? _authLast;
        }
      } catch (_) {/* offline */}
      // Mandatory-profile gate (pic5): every entry into the shell — new users after
      // onboarding AND existing users on next open — must have a complete profile
      // (photo, first+last name, valid email, valid phone) before using the app.
      final store = ProfileStore();
      var complete = (await store.load()).isComplete;
      // Email-OTP recovery on a NEW phone: if the local profile is incomplete (a
      // fresh install), ask the server for this account's saved profile and
      // hydrate it so a returning user skips onboarding. Phone is re-added later
      // via the soft nudge (owner request 2026-06-27).
      if (!complete) {
        try { complete = await store.restoreFromServer(); } catch (_) {/* offline → setup screen */}
      }
      // R2-F2: when the profile-completion gate is ON, the server is the authority
      // on completeness (its AI vetting — photo moderation, real-name — can mark a
      // locally-"complete" profile as not yet passed). If /api/me says the profile
      // is incomplete, route to the Profile screen before the app. FAIL OPEN: a
      // null (offline / error) leaves the local decision untouched so a network
      // blip never traps the user out.
      if (complete && RemoteConfig.profileCompletionGate) {
        try {
          final serverComplete = await store.serverProfileComplete();
          if (serverComplete == false) complete = false;
        } catch (_) {/* offline → trust local decision */}
      }
      // Compulsory AvaTOK number — now picked BEFORE the profile (owner decision
      // 2026-06-27) so the chosen number can be shown (locked) in the profile's
      // phone field. Computed regardless of profile completeness. Fail-open when
      // offline so a network error never traps a user.
      var needsNumber = false;
      try {
        final me = await AvaNumber.me();
        needsNumber = me.featureOn && !me.hasNumber;
        // [NUMBER-GATE-DIAG 2026-07-10] Rich telemetry to catch the "gate re-appears
        // even though I have a number" report. If needs_number is true while the
        // account actually holds one, this row makes the contradiction visible.
        Analytics.capture('number_gate_decided', {
          'feature_on': me.featureOn,
          'has_number': me.hasNumber,
          'needs_number': needsNumber,
          'stored_flag': storedHasNumber ?? 'null',
          'assigned_this_session': _numberAssignedThisSession,
        });
      } catch (e) {
        needsNumber = false; // fail-open: a network blip never traps the user
        Analytics.capture('number_gate_me_error', {'err': e.runtimeType.toString()});
      }
      // Dup-number fix: if the user already picked a number in this run, trust that
      // over a possibly-stale server read so the gate is never re-shown post-profile.
      if (_numberAssignedThisSession) needsNumber = false;
      // Persist both gate decisions so the NEXT launch enters instantly.
      try {
        await DiskCache.write(_kProfileCompleteFlag, complete ? '1' : '0');
        await DiskCache.write(_kHasNumberFlag, needsNumber ? '0' : '1');
      } catch (_) {/* best-effort */}
      if (!haveCache) {
        // FIRST RUN: this was the blocking path — reveal the UI now.
        if (mounted) setState(() { _id = id; _profileComplete = complete; _needsNumber = needsNumber; });
        Analytics.capture('shell_gate_ms', {
          'ms': DateTime.now().difference(gateT0).inMilliseconds,
          'source': 'network',
        });
        if (needsNumber) Analytics.capture('number_gate_shown', const {});
      } else if (mounted &&
          (complete != _profileComplete || needsNumber != _needsNumber)) {
        // Server disagrees with the cached render — re-route (e.g. a user who
        // genuinely lost profile-completeness goes to the gate).
        setState(() { _profileComplete = complete; _needsNumber = needsNumber; });
        if (needsNumber) Analytics.capture('number_gate_shown', const {});
      }
      // Daily auto-backup (best-effort, throttled): encrypt local SQLite → R2
      // (premium) or the user's own Google Drive (free). Makes the device + backup
      // the durable copy so the InboxDO can shed old history.
      BackupService.I.maybeAutoBackup();
    }

    if (haveCache) {
      unawaited(validateGates()); // user is already in the app
    } else {
      // FIRST RUN (no cached gate flags — a fresh install OR a just-switched
      // account): correctness-first, but NEVER hang the shell on bad DNS.
      // validateGates() awaits several network calls with no timeout; when the
      // device's resolver is failing (observed on Jio: "Failed host lookup:
      // clerk.avatok.ai / api.avatok.ai") those awaits stall 20-30s, leaving the
      // user on a spinner mashing the nav button (shell_gate_ms p90 ~2s, max 3s).
      // GUARD (PERF-DNS): reveal the shell using the LOCAL profile decision if the
      // network gate hasn't resolved within a short bound; validateGates keeps
      // running and re-routes if the server disagrees (the same correction path a
      // cached launch already uses). Fail-open: a hung network never traps the user.
      final bound = Timer(const Duration(seconds: 3), () async {
        if (_id != null || !mounted) return; // network gate already revealed
        var localComplete = false;
        try { localComplete = (await ProfileStore().load()).isComplete; } catch (_) {/* setup */}
        if (_id != null || !mounted) return;
        setState(() { _id = id; _profileComplete = localComplete; _needsNumber = false; });
        Analytics.capture('shell_gate_ms', {
          'ms': DateTime.now().difference(gateT0).inMilliseconds,
          'source': 'local_fallback',
        });
      });
      try {
        await validateGates(); // first run: correctness over speed
      } finally {
        bound.cancel();
      }
    }
  }

  /// Switch apps from within the home app (AvaTOK): return to the home surface,
  /// then open the requested destination on top.
  void _switchFromChild(String dest) {
    Navigator.of(context).popUntil((r) => r.isFirst);
    if (dest == 'explore') return; // marketplace de-emphasised this release
    WidgetsBinding.instance.addPostFrameCallback((_) => _openDest(dest));
  }

  void _openDest(String dest) {
    // Where users go after signing in / which features they use most.
    Analytics.capture('feature_opened', {'dest': dest});
    // FREE LAUNCH (Specs/FREE-LAUNCH-DIRECTION.md): defensively route any hidden
    // feature (deep-link/stray nav) to ComingSoon instead of opening it, so the
    // app stays focused even if an entry point slips through. Reverts when the
    // matching flag flips back on.
    bool launchBlocked(String key) {
      switch (key) {
        case 'avalive': return !RemoteConfig.liveEnabled;
        case 'avaconsult':
        case 'consult': return !RemoteConfig.consultEnabled;
        case 'avavoice': return !RemoteConfig.avavoiceEnabled;
        case 'avavision': return !RemoteConfig.avavisionEnabled;
        case 'avaaffiliate':
        case 'affiliate': return !RemoteConfig.avaAffiliateEnabled;
        case 'verse': return !RemoteConfig.verseEnabled;
        case 'subscribe':
        case 'billing': return !RemoteConfig.billingEnabled;
        default: return false;
      }
    }
    if (launchBlocked(dest)) {
      _push(AppRegistry.byId(dest) != null
          ? ComingSoon.forApp(dest)
          : ComingSoon(title: 'Coming soon', subtitle: 'Not available right now',
              icon: PhosphorIcons.lightning(PhosphorIconsStyle.fill), color: Zine.blue));
      return;
    }
    switch (dest) {
      case 'marketplace':
        // AvaMarketplace landing = the dedicated buy/sell/social browse (cards
        // with photo, price, country flag; country-default + AI search filter).
        _push(const MarketplaceBrowse());
        return;
      case 'explore':
        // Legacy AvaExplore creator grid (events/consults) — kept for deep links.
        _push(ExploreHome(onMenu: () => Navigator.of(context).maybePop()));
        return;
      case 'createlisting':
        // First-time liveness gate (owner 2026-07-03): an unverified user must
        // pass the one-time human check before the sell flow opens. Verified
        // users go straight in (no extra screen). Only enforced when the flag is
        // ON; the Worker is the real gate (403 liveness_required).
        if (RemoteConfig.listingLivenessGate) {
          ensureListingLiveness(context).then((ok) {
            if (!mounted) return;
            if (ok) {
              _push(const SellListingFlow());
            } else {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Verify you\'re a real person to start selling.')));
            }
          });
        } else {
          _push(const SellListingFlow());
        }
        return;
      case 'mylistings':
        _push(const MyListingsScreen());
        return;
      case 'archived':
        _push(const ArchivedScreen());
        return;
      case 'settings':
        // Reload on return — the preview switcher may have changed the account kind.
        _push(SettingsScreen(clerk: widget.clerk, onSignOut: widget.onSignOut, identity: _id))
            .then((_) => _load());
        return;
      case 'avatok':
        _push(ChatListScreen(clerk: widget.clerk, onSignOut: widget.onSignOut, onSwitchApp: _switchFromChild));
        return;
      case 'avaphone':
      case 'phone':
      case 'dialer':
        _push(const AvaPhoneScreen()); // PSTN-style dialer over AvaTOK-to-AvaTOK calling
        return;
      case 'avalive':
        _push(const AvaLiveDiscovery());
        return;
      case 'avavoice':
        _push(const AvaVoiceHome());
        return;
      case 'avavision':
        _push(const AvaVisionHome());
        return;
      case 'avaaffiliate':
      case 'affiliate':
        _push(const AffiliateHomeScreen());
        return;
      case 'verse':
        _push(const VerseScreen());
        return;
      case 'inbox':
      case 'avainbox':
        _push(const InboxScreen());
        return;
      case 'library':
      case 'avalibrary':
        _push(const AvaLibraryScreen());
        return;
      case 'avaapps':
      case 'apps':
        _push(const AvaAppsScreen());
        return;
      case 'avachat':
        _push(const CompanionHome()); // talk privately with Ava
        return;
      case 'aivoice':
        _push(const AiVoiceAgentScreen()); // hands-free Gemini Live call
        return;
      case 'avastorage':
      case 'storage':
        _push(const AvaStorageScreen());
        return;
      case 'profile':
        // The "View profile" row opens the proper profile editor directly
        // (photo + crop, name, email/OTP, password, about-you for AvaBrain).
        // The trust-ladder hub now lives under 'identity' in ACCOUNT & SETTINGS.
        _push(const ProfileScreen());
        return;
      case 'wallet':
      case 'avawallet':
        _push(const WalletScreen());
        return;
      case 'calendar':
      case 'avacalendar':
        _push(const AvaCalendarScreen());
        return;
      case 'booking':
      case 'avabooking':
        _push(const AvaBookingScreen());
        return;
      case 'payout':
      case 'avapayout':
        _push(const PayoutScreen());
        return;
      case 'identity':
      case 'avaidentity':
        _push(const IdentityScreen());
        return;
      case 'invite':
        _push(const InviteScreen());
        return;
      case 'team':
        _push(const TeamHomeScreen());
        return;
      case 'subscribe':
        _push(const SubscribeScreen());
        return;
      case 'billing':
        _push(ComingSoon(
            title: dest[0].toUpperCase() + dest.substring(1),
            subtitle: 'Coming soon',
            icon: PhosphorIcons.lightning(PhosphorIconsStyle.fill),
            color: Zine.blue));
        return;
      default:
        // Parent/Enterprise management tools (dummy → coming soon for now).
        final tool = adminToolByKey(dest);
        if (tool != null) {
          _push(ComingSoon(title: tool.name, subtitle: tool.tagline, icon: tool.icon, color: tool.color));
          return;
        }
        // App registry (standard or hidden) → branded ComingSoon until its
        // phase ships; legacy kApps keys fall through to the same screen.
        if (AppRegistry.byId(dest) != null) {
          _push(ComingSoon.forApp(dest));
          return;
        }
        final a = appByKey(dest);
        _push(ComingSoon(title: a.name, subtitle: a.tagline, icon: a.icon, color: a.color));
    }
  }

  /// One-time onboarding offer: if the account has no AvaTOK number yet and can
  /// still generate one (free accounts get one; paid unlimited), invite the user
  /// to pick it now. Skippable — they can always do it later in Settings → Your
  /// number. The offer is shown once per account (scoped flag).
  Future<void> _maybeOfferNumber() async {
    const ss = FlutterSecureStorage();
    const flag = 'onboarding_number_offered_v1';
    try { if (await readScoped(ss, flag) == '1') return; } catch (_) {}
    MyNumber me;
    try { me = await AvaNumber.me(); } catch (_) { return; } // offline → try again next open
    if (!mounted) return;
    // Mark offered now (one-time), regardless of choice — never nag again.
    try { await ss.write(key: scopedKey(flag), value: '1'); } catch (_) {}
    if (!me.featureOn || me.hasNumber || !me.canGenerate) return;
    final go = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: Zine.paper,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            ZineIconBadge(icon: PhosphorIcons.hash(PhosphorIconsStyle.bold), color: Zine.lime, size: 36),
            const SizedBox(width: 12),
            Expanded(child: Text('Get your AvaTOK number', style: ZineText.cardTitle(size: 18))),
          ]),
          const SizedBox(height: 12),
          Text('Pick a free number that represents you on AvaTOK so you can stay in '
              'touch without giving out your real phone — your real number always '
              'stays private. Free accounts get one number; you can choose it now.',
              style: ZineText.sub(size: 13.5)),
          const SizedBox(height: 18),
          ZineButton(label: 'Choose my number', variant: ZineButtonVariant.blue,
              fullWidth: true, fontSize: 16, trailingIcon: false,
              icon: PhosphorIcons.hash(PhosphorIconsStyle.bold),
              onPressed: () => Navigator.pop(ctx, true)),
          const SizedBox(height: 8),
          Center(child: TextButton(onPressed: () => Navigator.pop(ctx, false),
              child: Text('Maybe later', style: ZineText.link(size: 14, color: Zine.inkSoft)))),
        ]),
      )),
    );
    if (go == true && mounted) await _push(const NumberSettingsScreen());
  }

  Future<void> _push(Widget w) => Navigator.push(context, MaterialPageRoute(builder: (_) => w));

  @override
  Widget build(BuildContext context) {
    // Mandatory-profile gate (pic5): block the entire app until the profile is
    // complete. A brief loader while we read the local profile; then either the
    // non-skippable setup screen or the real shell.
    if (_profileComplete == null) {
      return const Scaffold(
        backgroundColor: Zine.paper,
        body: Center(child: CircularProgressIndicator(color: Zine.blueInk)),
      );
    }
    // Compulsory AvaTOK number gate FIRST (owner decision 2026-06-27): the user
    // picks their number before completing the profile, so the profile can show
    // that number (locked) in the phone field. Same gate for new users at
    // onboarding and existing users who never registered a number.
    if (_needsNumber) {
      return NumberSettingsScreen(
        gate: true,
        onSignOut: widget.onSignOut,
        onAssigned: () {
          // Mark sticky + persist the "has number" flag IMMEDIATELY so the
          // post-profile onDone→_load() reads '1' and never re-shows this gate.
          _numberAssignedThisSession = true;
          unawaited(DiskCache.write(_kHasNumberFlag, '1').catchError((_) {}));
          setState(() => _needsNumber = false);
        },
      );
    }
    if (_profileComplete == false) {
      return ProfileSetupScreen(
        identity: _id,
        email: _authEmail,
        prefillFirstName: _authFirst,
        prefillLastName: _authLast,
        onSignOut: widget.onSignOut,
        // Re-run the gate after the profile is saved (show the loader meanwhile,
        // no flash to the chat list).
        onDone: () { setState(() { _profileComplete = null; }); _load(); },
      );
    }
    // shellV2 (Specs/PLAN-2026-07-12-home-ava-tok-services-shell.md, Phase 1):
    // when the remote flag is ON, render the four-root shell (Home · AvaDial ·
    // AvaTalk · Services) instead of the messenger-first surface. ALL gates above
    // (profile / number) still run first — only the LANDING changes. When the
    // flag is OFF (default, dark), this returns the exact ChatListScreen below,
    // byte-for-byte today's behaviour.
    if (RemoteConfig.shellV2) {
      return ShellV2(clerk: widget.clerk, onSignOut: widget.onSignOut, identity: _id);
    }
    // Messaging-first landing (owner decision 2026-06-18, free release): the app
    // opens directly on AvaTOK (ChatListScreen), where users see their chats &
    // contacts. ChatListScreen carries its own sidebar drawer + bottom nav, so
    // it IS the home surface. Other apps push on top via _switchFromChild and
    // pop back here. (Marketplace/ExploreHome de-emphasised for this release.)
    return ChatListScreen(
      clerk: widget.clerk,
      onSignOut: widget.onSignOut,
      onSwitchApp: _switchFromChild,
    );
  }
}

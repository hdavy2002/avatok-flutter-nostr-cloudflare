import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../auth/clerk_client.dart';
import '../core/account_storage.dart';
import '../core/analytics.dart';
import '../core/mini_audio_player_bar.dart'; // [AVAVM-PLAYER-1]
import '../core/config.dart';
import '../core/profile_store.dart';
import '../core/remote_config.dart';
import '../core/ui/avatok_dark.dart';
import '../features/askava/askava_screen.dart';
import '../features/avadial/avadial_channel.dart';
import '../features/avadial/avadial_setup_sheet.dart';
import '../features/avadial/block_list.dart';
import '../features/avadial/contact_detail_screen.dart';
import '../features/avadial/in_call_screen.dart';
import '../features/avadial/inbox/inbox_list_screen.dart';
import '../features/avadial/missed_call_service.dart';
import '../features/avadial/pstn_call_screen.dart';
import '../features/avadial/pstn_forwarding_intro.dart';
import '../features/avadial/sms/sms_thread_screen.dart';
import '../identity/identity.dart';
import 'v2/app_switcher_bar.dart';
import 'v2/avadial_root.dart';
import 'v2/root_order_store.dart';
import 'v2/services_root.dart';
import 'v2/talk_root.dart';

/// [AVA-RCPT-7] Pool DID for PSTN voicemail forwarding (Phase 0 probe,
/// Specs/PLAN-2026-07-16-ava-receptionist-guardian-FINAL.md). Shared across
/// every user — DIDs are never per-user (plan's cost guardrails) — so this is
/// a plain constant, not per-account config. Update here (and only here) if
/// the pool grows to a second DID with routing logic; single-DID for v1.
const String kPstnVoicemailDid = '+912271264209';

/// The three sibling apps of the [ShellV2] shell (2026-07-12: Home root retired —
/// AvaTOK/AvaTalk is now the sole landing app). Each is its OWN [Navigator] inside
/// an [IndexedStack], so switching apps preserves the app's nested route stack +
/// scroll state. The persistent [AppSwitcherBar] footer (rendered once, at the
/// shell level — see [_ShellV2State.build]) is the SAME set of icons in the SAME
/// position no matter which root is active.
enum RootId { avaDial, avaTalk, services }

extension RootIdX on RootId {
  /// Stable string used for restoration IDs, persistence + analytics.
  String get key {
    switch (this) {
      case RootId.avaDial:
        return 'avadial';
      case RootId.avaTalk:
        return 'avatalk';
      case RootId.services:
        return 'services';
    }
  }
}

/// Shell API exposed to every root (and its nested screens) via an
/// [InheritedWidget]. Root screens read it with `ShellScope.of(context)` to
/// switch apps, open the universal Ask Ava overlay, or reach the signed-in
/// account context (clerk / sign-out / identity).
class ShellScope extends InheritedWidget {
  final RootId activeRoot;
  final void Function(RootId) switchRoot;

  /// Open the universal Ask Ava assistant (plan §4.6). Optional [hint] names the
  /// app that opened it ('avadial'|'avatalk'|'services'|'root') so the assistant
  /// primes the right context/tools. It is a GLOBAL ACTION — pushed on the active
  /// root's navigator, dismissing back to wherever the user was.
  final void Function([String hint]) askAva;
  final ClerkClient clerk;
  final VoidCallback onSignOut;
  final Identity? identity;

  /// User-chosen order of the four Home footer app-switcher roots (AVA-SHELL-8).
  /// The FIRST entry is the landing app on cold open. The Home footer reads this
  /// to render + drag-reorder the icons; the AI action is not part of it.
  final List<RootId> rootOrder;

  /// Commit a new [rootOrder] (from a footer drag or the "App order" screen).
  /// Persists per-account + fires the reorder analytics.
  final void Function(List<RootId>) setRootOrder;

  const ShellScope({
    super.key,
    required this.activeRoot,
    required this.switchRoot,
    required this.askAva,
    required this.clerk,
    required this.onSignOut,
    required this.identity,
    required this.rootOrder,
    required this.setRootOrder,
    required super.child,
  });

  static ShellScope of(BuildContext context) {
    final s = context.dependOnInheritedWidgetOfExactType<ShellScope>();
    assert(s != null, 'ShellScope.of() called outside a ShellV2');
    return s!;
  }

  @override
  bool updateShouldNotify(ShellScope old) =>
      old.activeRoot != activeRoot ||
      old.identity != identity ||
      !_sameOrder(old.rootOrder, rootOrder);

  static bool _sameOrder(List<RootId> a, List<RootId> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }
}

/// The 4-root shell (Home · AvaDial · AvaTalk · Services), gated ENTIRELY behind
/// the `shellV2` remote flag (see [AvaShell]). When the flag is off, none of this
/// code runs and the app renders today's messenger-first shell byte-for-byte.
///
/// Navigation contract (plan §8):
///  - Each root owns a [Navigator] held in an [IndexedStack] → switching roots
///    keeps each root's nested route stack + scroll (state preserved).
///  - Android back pops WITHIN the active root; at a root's first route it
///    switches to Home; at Home's first route it exits the app.
///  - Per-root restoration IDs + [PageStorageKey]s so the OS can restore state.
///  - Notifications / deep links route to the correct root via [rootForDeepLink]
///    (a small TODO map — Phase 2 wires the real notification taps).
class ShellV2 extends StatefulWidget {
  final ClerkClient clerk;
  final VoidCallback onSignOut;
  final Identity? identity;
  const ShellV2({
    super.key,
    required this.clerk,
    required this.onSignOut,
    required this.identity,
  });

  /// Deep-link / notification → root map (plan §8 navigation contract). Returns
  /// the root a given destination key should surface in, or null if unknown (the
  /// caller then stays on the current root). Exposed here so the push/notification
  /// layer can route a tap into the correct navigator instead of duplicating a
  /// screen.
  /// TODO(phase2): extend as real notification taps are wired (incoming AvaTalk
  /// call, marketplace push, PSTN missed-call, etc.).
  static RootId? rootForDeepLink(String dest) {
    switch (dest) {
      case 'home': // legacy links → the app now lands on AvaTOK
      case 'chat':
      case 'message':
      case 'avatalk':
      case 'avatok':
      case 'call': // in-network call notifications live in AvaTalk today
      case 'group':
        return RootId.avaTalk;
      case 'avadial':
      case 'dial':
      case 'pstn':
      case 'missedcall':
        return RootId.avaDial;
      case 'services':
      case 'marketplace':
      case 'listing':
      case 'wallet':
      case 'payout':
        return RootId.services;
      default:
        return null;
    }
  }

  @override
  State<ShellV2> createState() => _ShellV2State();
}

class _ShellV2State extends State<ShellV2> {
  RootId _root = RootId.avaTalk;

  // True while the universal Ask Ava overlay is on screen. Ask Ava is a GLOBAL
  // action pushed onto the active root's navigator (not a root), so `_root` never
  // changes when it opens — without this flag the footer would keep the active
  // indicator on the previous root (AvaDialer, etc.) instead of moving it to the
  // "Ava" icon. Set true on push, reset when the route pops (owner bug 2026-07-14:
  // "Ava icon stays white, orange highlight stuck on another icon").
  bool _askAvaOpen = false;

  /// True while the footer-pushed Inbox route is on top — mirrors
  /// [_askAvaOpen] so the footer highlights the Inbox slot (owner bug
  /// 2026-07-16: Inbox icon stayed unselected while inside the Inbox).
  bool _inboxOpen = false;

  /// [AVA-NAV-STUCK-1] (owner bug 2026-07-17) The live Inbox / Ask Ava overlay
  /// routes, plus the root whose Navigator they were pushed onto.
  ///
  /// WHY THIS EXISTS: Inbox and Ask Ava are GLOBAL actions but they get pushed
  /// onto the ACTIVE ROOT's navigator, and each root's stack survives an app
  /// switch inside the IndexedStack. So opening Inbox from AvaDialer and then
  /// tapping AvaTalk used to leave the Inbox route parked on AvaDialer's stack
  /// forever: `_inboxOpen` never cleared (nothing popped it), so the orange
  /// pill stayed welded to the Inbox slot with no root selected, AND the next
  /// tap on AvaDialer re-revealed the Inbox route sitting on top of it — the
  /// user got "switched back to Inbox" without asking. Holding the route lets
  /// [_dismissOverlays] remove it from whichever navigator owns it, by identity,
  /// without disturbing anything the user pushed on top of it.
  Route<void>? _inboxRoute;
  Route<void>? _askAvaRoute;
  RootId? _overlayRoot;

  // User-chosen app-switcher order (AVA-SHELL-8). Drives BOTH the Home footer
  // rendering and the cold-open landing decision (order.first = landing app).
  // Loaded per-account in initState; defaults until then.
  List<RootId> _order = List<RootId>.from(RootOrderPrefs.defaultOrder);

  // One Navigator per root — kept alive by the IndexedStack so each app's
  // nested route stack survives an app switch.
  final Map<RootId, GlobalKey<NavigatorState>> _navKeys = {
    for (final r in RootId.values) r: GlobalKey<NavigatorState>(),
  };

  // Per-account last-used root (plan §9 item 2): open to the last root used on
  // this account, Home on first run. Scoped via scopedKey so a parent + child
  // on one phone keep independent last-root state.
  static const _kLastRoot = 'shellv2_last_root';
  // [DEFAULT-APPS-REPROMPT-1] '1' once this account has been offered the
  // "make AvaTOK your phone" re-prompt. Account-scoped (see scopedKey): a shared
  // phone's parent and child hold their own OS roles, so one seeing it must not
  // silence it for the other.
  static const _kDefaultAppsReprompt = 'shellv2_default_apps_reprompt_v1';
  static const _ss = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  StreamSubscription<AvaIncomingLaunch>? _incomingSub;
  StreamSubscription<AvaComposeLaunch>? _composeSub;
  StreamSubscription<AvaOpenDialLaunch>? _openDialSub;

  @override
  void initState() {
    super.initState();
    _initRootState();
    _wireIncomingCalls();
    _wireCompose();
    _wireMissedCall();
    _maybeRepromptDefaultApps();
    _maybeShowVoicemailIntro();
  }

  /// [AVA-RCPT-CONSENT-1] (owner decision 2026-07-16, PLAN-2026-07-16
  /// receptionist/guardian doc): carrier voicemail forwarding is ON BY
  /// DEFAULT for every user now, via informed consent rather than silently.
  /// New signups see this as the onboarding 'voicemail_forwarding' step
  /// (onboarding_flow.dart); EXISTING users — anyone who signed up, or last
  /// updated, before this shipped — get the exact same screen once, here,
  /// post-login. Same three-brake shape as [_maybeRepromptDefaultApps]:
  ///   1. Flag gate — `avaDialer` && `pstnVoicemail`, the identical pair the
  ///      Settings row (pstn_forwarding_setup.dart) and the onboarding step
  ///      both gate on.
  ///   2. Per-account "seen" marker ([pstnIntroSeen]/[markPstnIntroSeen],
  ///      pstn_forwarding_intro.dart) — at most once per account, ever.
  ///   3. Never fights the incoming-call launch path: skipped outright while
  ///      [AvaDialChannel.incomingScreenOpen] is true (an active
  ///      [PstnCallScreen] push already owns the screen — the same guard
  ///      [_openIncoming] checks above) and given a short beat after the
  ///      first frame so it doesn't collide with [_maybeRepromptDefaultApps]'s
  ///      own post-frame dialog on the very same cold start.
  void _maybeShowVoicemailIntro() {
    if (!Platform.isAndroid || !RemoteConfig.avaDialer || !RemoteConfig.pstnVoicemail) return;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      try {
        // Give the default-apps re-prompt (registered in the same initState,
        // same frame) first crack at the screen — never stack two unrelated
        // one-time prompts on top of each other on a single cold start.
        await Future.delayed(const Duration(milliseconds: 600));
        if (!mounted) return;
        if (AvaDialChannel.I.incomingScreenOpen) return; // an incoming call owns the screen right now
        if (await pstnIntroSeen()) return;
        if (!mounted) return;
        Analytics.capture('pstn_forward_intro_shown', {'from': 'shell_startup'});
        await Navigator.of(context, rootNavigator: true).push(MaterialPageRoute<void>(
          fullscreenDialog: true,
          builder: (_) => const PstnForwardingIntroScreen(),
        ));
      } catch (e) {
        // A prompt must never be able to break app launch.
        Analytics.capture('pstn_forward_intro_error', {'error': e.toString()});
      }
    });
  }

  /// [DEFAULT-APPS-REPROMPT-1] (owner request 2026-07-15) Existing users who never
  /// took the onboarding "make AvaTOK your phone" step get sent, ONCE, to
  /// Settings → "Default phone & messages" on their next app open.
  ///
  /// Three independent brakes, because this interrupts app launch and the owner
  /// already had the old setup sheet stopped on 2026-07-14 for nagging:
  ///   1. `defaultAppsReprompt` — server kill switch (declared in config.ts
  ///      PlatformConfig + DEFAULTS, so it can actually be flipped).
  ///   2. A persistent account-SCOPED key — at most once per account, ever.
  ///      Scoped because a parent and child share the phone and hold separate
  ///      roles; a global key would silence the prompt for everyone after the
  ///      first person saw it (rulebook rule 1).
  ///   3. Role check — never shown to anyone who already holds them.
  ///
  /// Deliberately NOT the old auto-popping sheet: this is a single dismissible
  /// prompt that hands off to the settings section and then never returns.
  void _maybeRepromptDefaultApps() {
    if (!Platform.isAndroid || !RemoteConfig.avaDialer) return;
    if (!RemoteConfig.defaultAppsReprompt) return;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      try {
        // Once per account, ever.
        final seen = await readScoped(_ss, _kDefaultAppsReprompt);
        if (seen == '1') return;
        // Already the default phone (and SMS, when that surface is live)? Then
        // there is nothing to ask for — record it and never ask again.
        final dialer = await AvaDialChannel.I.isDialerRoleHeld();
        final sms = RemoteConfig.avaSms ? await AvaDialChannel.I.isSmsRoleHeld() : true;
        if (dialer && sms) {
          await _ss.write(key: scopedKey(_kDefaultAppsReprompt), value: '1');
          return;
        }
        if (!mounted) return;
        // Mark BEFORE showing. If the user force-quits on the prompt we must not
        // re-ask on every launch — one shot is one shot.
        await _ss.write(key: scopedKey(_kDefaultAppsReprompt), value: '1');
        Analytics.capture('default_apps_reprompt_shown',
            {'dialer_held': dialer, 'sms_held': sms});
        if (!mounted) return;
        final go = await showDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
            backgroundColor: AD.card,
            title: Text('Make AvaTOK your phone app?',
                style: ADText.rowName().copyWith(fontSize: 17)),
            content: Text(
              'Set AvaTOK as your default phone and messages app so calls and '
              'texts run through it, with the free scam and spam shield.',
              style: ADText.preview(c: AD.textSecondary),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(ctx, false),
                child: Text('Not now', style: ADText.rowName(c: AD.textSecondary)),
              ),
              TextButton(
                onPressed: () => Navigator.pop(ctx, true),
                child: Text('Set up', style: ADText.rowName(c: AD.primaryBadge)),
              ),
            ],
          ),
        );
        Analytics.capture('default_apps_reprompt_choice', {'accepted': go == true});
        if (go != true || !mounted) return;
        await showAvaDialSetupSheet(context);
      } catch (e) {
        // A prompt must never be able to break app launch.
        Analytics.capture('default_apps_reprompt_error', {'error': e.toString()});
      }
    });
  }

  @override
  void dispose() {
    _incomingSub?.cancel();
    _composeSub?.cancel();
    _openDialSub?.cancel();
    super.dispose();
  }

  /// Cold-start / background incoming-call route (plan Phase 2b leftover). The
  /// native AvaInCallService launches MainActivity with the `avadial/incoming`
  /// route extra; MainActivity forwards it to the AvaDial plugin. Here we open
  /// [PstnCallScreen] on the AvaDial navigator — both for a launch that beat us
  /// (drained via consumePendingIncoming) and one that arrives while running
  /// (the onLaunchIncoming stream). All DARK behind `avaDialer`.
  void _wireIncomingCalls() {
    if (!RemoteConfig.avaDialer) return;
    AvaDialChannel.I.ensureWired();
    // [AVADIAL-NATIVE-INCALL-1] Mirror the native-in-call kill switch to disk. The
    // native call screens run with NO Flutter engine, so they cannot read
    // RemoteConfig — this file IS how they learn the flag. Written on every wire-up
    // so a KV flip takes effect on the next app open. Absent/corrupt reads as OFF.
    unawaited(AvaDialChannel.I.setNativeInCallEnabled(RemoteConfig.nativeInCallUi));
    // [AVA-RCPT-5/6/7] Mirror PSTN voicemail forwarding config to disk — read
    // with NO engine attached by AvaInCallService (reject → expect ping),
    // AvaCallScreeningService (hidden-caller-ID auto-route) and
    // AvaMissedCallReceiver (missed → expect ping). Written on every wire-up
    // so flipping `pstnVoicemail` in KV takes effect on the next app open,
    // exactly like the nativeInCallUi mirror just above. `base` carries the
    // scheme (unlike setMissedCallEnabled's bare host) because native uses it
    // verbatim as `$base/api/pstn/expect-native`.
    unawaited(AvaDialChannel.I.setPstnConfig(
      enabled: RemoteConfig.pstnVoicemail,
      base: 'https://$kSignalingHost',
      did: kPstnVoicemailDid,
    ));
    // [AVADIAL-CALL-INTEL-1] Tell native who is signed in, so calls that happen with
    // the app closed still carry the user's email — the only way to work out whose
    // device a call problem was on once there are many testers.
    unawaited(_syncNativeIdentity());
    _incomingSub = AvaDialChannel.I.incomingLaunch
        .listen((l) => _openIncoming(l.callId, l.number, l.answered, l.spamScore));
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final l = await AvaDialChannel.I.consumePendingIncoming();
      if (l != null) _openIncoming(l.callId, l.number, l.answered, l.spamScore);
      // [AVADIAL-NATIVE-RING-1] Sync Block/Report actions taken on the native
      // incoming-call screen while the app was dead into the in-app BlockList.
      for (final a in await AvaDialChannel.I.drainPendingCallActions()) {
        final number = '${a['number'] ?? ''}';
        if (number.isEmpty) continue;
        try {
          if (a['action'] == 'report_spam') {
            await BlockList.I.reportSpam(number);
          } else {
            await BlockList.I.block(number, reportedSpam: false);
          }
          Analytics.capture('pstn_native_action_synced', {'action': '${a['action']}'});
        } catch (_) {/* best-effort */}
      }
    });
  }

  /// [AVADIAL-CALL-INTEL-1] Hand the signed-in user's identity to native.
  ///
  /// Native owns the call but has no Clerk, no IdentityStore and (by design) no
  /// Flutter engine at call time — so Dart writes an identity snapshot to disk and
  /// native reads it. Exactly the handshake spam_snapshot.json / avatok_directory
  /// .json already use, and the one AvaMissedCallOverlay already reads with no
  /// engine attached.
  ///
  /// Per-account scoping is mandatory here (one phone, parent + child accounts):
  /// [ProfileStore.load] reads through `readScoped`, so this always reflects the
  /// CURRENT account, and a sign-out must clear it rather than leave the previous
  /// user's email stamped on the next account's calls.
  Future<void> _syncNativeIdentity() async {
    try {
      final p = await ProfileStore().load();
      await AvaDialChannel.I.writeIdentity(
        distinctId: AccountScope.id,
        email: p.email.isEmpty ? null : p.email,
        phoneE164: p.phone.isEmpty ? null : p.phone,
        name: p.displayName.isEmpty ? null : p.displayName,
        accountId: AccountScope.id,
      );
    } catch (_) {/* best-effort — telemetry identity is never worth an exception */}
  }

  /// Cold-start / background SMS-compose route (AVA-SMS). The native SMS notification
  /// tap or an ACTION_SENDTO on sms:/smsto: forwards MainActivity → the AvaDial plugin
  /// with the `avadial/compose` route; here we switch to the AvaDial root and open the
  /// composer on its navigator (both the launch that beat us — drained via
  /// consumePendingCompose — and one arriving while running). DARK behind `avaSms`.
  void _wireCompose() {
    if (!RemoteConfig.avaSms) return;
    AvaDialChannel.I.ensureWired();
    _composeSub = AvaDialChannel.I.composeLaunch.listen((c) => _openCompose(c.number));
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final c = await AvaDialChannel.I.consumePendingCompose();
      if (c != null) _openCompose(c.number);
    });
  }

  /// [AVA-MISSEDCALL-1] Truecaller-style missed-call overlay. Boots [MissedCallService]
  /// (which arms the native PHONE_STATE receiver + keeps the caller directory fresh) and
  /// routes the overlay's "View profile" / AvaTOK action back into the app — both for a
  /// launch that beat us (drained via consumePendingOpenDial) and one arriving while
  /// running (the openDialLaunch stream). All DARK behind `missedCallOverlay`.
  void _wireMissedCall() {
    if (!RemoteConfig.missedCallOverlay) return;
    AvaDialChannel.I.ensureWired();
    unawaited(MissedCallService.I.init());
    _openDialSub = AvaDialChannel.I.openDialLaunch.listen((l) => _openDialContact(l.number));
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final l = await AvaDialChannel.I.consumePendingOpenDial();
      if (l != null) _openDialContact(l.number);
    });
  }

  void _openDialContact(String? number) {
    if (!mounted) return;
    final n = (number ?? '').trim();
    if (n.isEmpty) return;
    setState(() => _root = RootId.avaDial);
    final nav = _navKeys[RootId.avaDial]?.currentState ?? Navigator.of(context);
    nav.push(MaterialPageRoute<void>(builder: (_) => ContactDetailScreen(number: n)));
  }

  void _openCompose(String? number) {
    if (!mounted) return;
    final n = (number ?? '').trim();
    setState(() => _root = RootId.avaDial);
    final nav = _navKeys[RootId.avaDial]?.currentState ?? Navigator.of(context);
    // A specific recipient opens straight into the thread composer; a blank compose
    // still lands on the AvaDial root's Messages surface (the user picks a recipient).
    if (n.isNotEmpty) {
      nav.push(MaterialPageRoute<void>(builder: (_) => SmsThreadScreen(address: n)));
    }
  }

  // [AVADIAL-HARDEN-2] [answered] means the call was already answered/active
  // by the time this launch arrived (notification "answer" action fired
  // before Flutter/MainActivity came up) — open the active-call UI directly
  // instead of the ringing screen, which would otherwise be stuck (its
  // Answer/Decline do nothing once the call is already connected).
  void _openIncoming(String callId, String? number, [bool answered = false, int? spamScore]) {
    if (!mounted) return;
    final n = number ?? '';
    if (n.isEmpty) return;
    if (AvaDialChannel.I.incomingScreenOpen) {
      // [AVADIAL-INCOMING-HIDDEN-1] The screen already exists — this path re-fires
      // on a notification tap / relaunch after the _initRootState landing race hid
      // the (still ringing) PstnCallScreen behind another root. Re-surface the
      // AvaDial root instead of silently swallowing the tap, so the user can
      // always get back to Answer/Decline.
      if (_root != RootId.avaDial) {
        setState(() => _root = RootId.avaDial);
        Analytics.capture('pstn_incoming_resurfaced', {'from': 'relaunch'});
      }
      return;
    }
    AvaDialChannel.I.incomingScreenOpen = true;
    setState(() => _root = RootId.avaDial);
    final nav = _navKeys[RootId.avaDial]?.currentState ?? Navigator.of(context);
    nav
        .push(MaterialPageRoute<void>(
          fullscreenDialog: true,
          builder: (_) => answered
              ? InCallScreen(callId: callId, number: n, initialState: 'active')
              : PstnCallScreen(callId: callId, number: n, spamScore: spamScore),
        ))
        .whenComplete(() => AvaDialChannel.I.incomingScreenOpen = false);
  }

  /// Cold-open state (AVA-SHELL-8). Loads the per-account app-switcher order and
  /// LANDS ON `order.first` — the user's chosen landing app (put AvaTalk first and
  /// the app opens in the messenger). This REPLACES the old last-used-root landing.
  Future<void> _initRootState() async {
    List<RootId> order;
    try {
      order = await RootOrderPrefs.load();
    } catch (_) {
      order = List<RootId>.from(RootOrderPrefs.defaultOrder);
    }
    if (!mounted || order.isEmpty) return;
    // [AVADIAL-INCOMING-HIDDEN-1] An incoming PSTN call may have cold-started us and
    // already switched the shell to the AvaDial root with PstnCallScreen ringing
    // (the incoming drain wins this async race — proven by PostHog: shellv2_landing_root
    // fired 1.5s AFTER pstn_call_screen_shown and hid the answer UI behind the chat
    // list). Never stomp the visible root while that screen is up; still adopt the
    // loaded order so the footer stays correct.
    final suppressLanding = AvaDialChannel.I.incomingScreenOpen;
    setState(() {
      _order = order;
      if (!suppressLanding) _root = order.first; // landing rule
    });
    Analytics.capture('shellv2_landing_root', {
      'root': (suppressLanding ? _root : order.first).key,
      'landing_suppressed': suppressLanding,
    });
  }

  /// Persist a reordered app switcher (from the Home footer drag or the "App order"
  /// screen). Updates the in-memory order so the footer + landing stay consistent,
  /// writes it per-account, and fires the reorder analytics.
  void _setRootOrder(List<RootId> order) {
    if (order.isEmpty) return;
    setState(() => _order = List<RootId>.from(order));
    unawaited(RootOrderPrefs.save(order));
    Analytics.capture('shellv2_roots_reordered', {
      'order': order.map((r) => r.key).join(','),
    });
  }

  /// LEGACY last-used-root path (plan §9 item 2), retained but SUPERSEDED by the
  /// explicit order in [_initRootState]: cold open now prefers `order.first`, so
  /// this is no longer invoked for the landing decision. Kept (with its writer
  /// below) so the persisted value/behaviour can be restored if the explicit-order
  /// landing is ever reverted.
  // ignore: unused_element
  Future<void> _restoreLastRoot() async {
    try {
      final v = await readScoped(_ss, _kLastRoot);
      if (v == null || v.isEmpty || !mounted) return;
      final match = RootId.values.where((r) => r.key == v);
      if (match.isNotEmpty && mounted) setState(() => _root = match.first);
    } catch (_) {/* first run → Home */}
  }

  void _persistLastRoot(RootId r) {
    // Best-effort, account-scoped. Never blocks the UI.
    unawaited(_ss.write(key: scopedKey(_kLastRoot), value: r.key).catchError((_) {}));
  }

  /// [AVA-NAV-STUCK-1] Tear down any live global overlay (Inbox / Ask Ava)
  /// before a root switch. Removes each route BY IDENTITY from the navigator it
  /// was actually pushed onto — never `pop()`, which would kill whatever the
  /// user has on top instead. `removeRoute` does not fire the push future's
  /// `whenComplete`, so the flags are cleared here explicitly.
  void _dismissOverlays() {
    if (_inboxRoute == null && _askAvaRoute == null) return;
    final nav = _navKeys[_overlayRoot ?? _root]?.currentState;
    for (final route in [_inboxRoute, _askAvaRoute]) {
      if (route != null && route.isActive) nav?.removeRoute(route);
    }
    _inboxRoute = null;
    _askAvaRoute = null;
    _overlayRoot = null;
    _inboxOpen = false;
    _askAvaOpen = false;
  }

  void _switchRoot(RootId r) {
    if (r == _root && !_inboxOpen && !_askAvaOpen) {
      // Re-tapping the active app pops it back to its first route (common
      // bottom-nav affordance). Guarded on the overlay flags: while Inbox or
      // Ask Ava is up, the "active app" the user sees in the footer is the
      // OVERLAY, not `_root` — so a tap on the root underneath is a real switch
      // back to it (fall through and dismiss), not a pop-to-root of a stack the
      // user isn't looking at.
      _navKeys[r]?.currentState?.popUntil((route) => route.isFirst);
      return;
    }
    // Close Inbox/Ask Ava first: they are global actions parked on some root's
    // stack, and leaving them there strands the footer indicator and ambushes
    // the user with the overlay on their next visit to that root.
    setState(() {
      _dismissOverlays();
      _root = r;
    });
    _persistLastRoot(r);
    Analytics.capture('shellv2_root_selected', {'root': r.key});
  }

  /// [AVA-RCPT-8 footer move] The main-shell footer's own "Inbox" slot
  /// (shell/v2/app_switcher_bar.dart, between AvaDialer and Marketplace) —
  /// pushes the Inbox as a full-screen route on the ACTIVE root's navigator,
  /// same pattern as [_askAva]'s global-action push, so Android back / swipe
  /// returns the user to wherever they were instead of switching roots.
  void _openInbox() {
    Analytics.capture('shellv2_inbox_opened', {'root': _root.key});
    // Reflect the open overlay in the footer: move the active indicator to the
    // "Inbox" icon (and off the current root) while the Inbox is showing —
    // exactly the [_askAva] fix (owner bug 2026-07-16: Inbox icon stayed
    // unselected while the user was inside the Inbox).
    setState(() => _inboxOpen = true);
    final nav = _navKeys[_root]?.currentState ?? Navigator.of(context);
    // [AVA-NAV-STUCK-1] Remember the route + the root that owns it so a footer
    // root-switch can dismiss it (see [_dismissOverlays]).
    final route = MaterialPageRoute<void>(
      builder: (_) => const InboxListScreen(embedded: false),
    );
    _inboxRoute = route;
    _overlayRoot = _root;
    nav.push(route).whenComplete(() {
      // Only clear if this is still the live overlay — _dismissOverlays may
      // have already torn it down and opened another.
      if (!mounted || !identical(_inboxRoute, route)) return;
      setState(() {
        _inboxOpen = false;
        _inboxRoute = null;
        if (_askAvaRoute == null) _overlayRoot = null;
      });
    });
  }

  void _askAva([String hint = 'root']) {
    Analytics.capture('shellv2_askava_opened', {'root': _root.key, 'hint': hint});
    // Reflect the open overlay in the footer: move the active indicator to the
    // "Ava" icon (and off the current root) while Ask Ava is showing.
    setState(() => _askAvaOpen = true);
    // Global action: push the assistant onto the ACTIVE root's navigator so it
    // overlays the current app and Android back returns the user where they were.
    final nav = _navKeys[_root]?.currentState ?? Navigator.of(context);
    // [AVA-NAV-STUCK-1] Same stranding hazard as _openInbox — track the route.
    final route = MaterialPageRoute<void>(
      builder: (_) => AskAvaScreen(contextHint: hint),
    );
    _askAvaRoute = route;
    _overlayRoot = _root;
    // Restore the indicator to the underlying root once the overlay is
    // dismissed (Android back, swipe, or in-screen close).
    nav.push(route).whenComplete(() {
      Analytics.capture('shellv2_askava_closed', {'root': _root.key});
      if (!mounted || !identical(_askAvaRoute, route)) return;
      setState(() {
        _askAvaOpen = false;
        _askAvaRoute = null;
        if (_inboxRoute == null) _overlayRoot = null;
      });
    });
  }

  Widget _rootScreen(RootId r) {
    switch (r) {
      case RootId.avaDial:
        return const AvaDialRoot(key: PageStorageKey('shellv2_avadial'));
      case RootId.avaTalk:
        return TalkRoot(
          key: const PageStorageKey('shellv2_avatalk'),
          clerk: widget.clerk,
          onSignOut: widget.onSignOut,
        );
      case RootId.services:
        return const ServicesRoot(key: PageStorageKey('shellv2_services'));
    }
  }

  Widget _navigatorFor(RootId r) => Navigator(
        key: _navKeys[r],
        restorationScopeId: 'shellv2_nav_${r.key}',
        onGenerateRoute: (settings) => MaterialPageRoute(
          settings: settings,
          builder: (_) => _rootScreen(r),
        ),
      );

  Future<void> _handleBack() async {
    final nav = _navKeys[_root]?.currentState;
    if (nav != null && nav.canPop()) {
      nav.pop();
      return;
    }
    if (_root != RootId.avaTalk) {
      _switchRoot(RootId.avaTalk);
      return;
    }
    // At AvaTOK's (landing app) first route → leave the app.
    await SystemNavigator.pop();
  }

  @override
  Widget build(BuildContext context) {
    return ShellScope(
      activeRoot: _root,
      switchRoot: _switchRoot,
      askAva: _askAva,
      clerk: widget.clerk,
      onSignOut: widget.onSignOut,
      identity: widget.identity,
      rootOrder: _order,
      setRootOrder: _setRootOrder,
      child: PopScope(
        canPop: false,
        onPopInvokedWithResult: (didPop, _) {
          if (didPop) return;
          _handleBack();
        },
        child: Scaffold(
          backgroundColor: AD.bg,
          body: Stack(
            children: [
              IndexedStack(
                index: _root.index,
                children: [for (final r in RootId.values) _navigatorFor(r)],
              ),
              // [AVAVM-PLAYER-1] Mounted ONCE here, above the per-root
              // IndexedStack, so a voice note / voicemail keeps playing (and
              // stays visible) as the user moves between AvaTalk, AvaDial and
              // Marketplace — instead of dying with whichever screen started
              // it. Deliberately NOT mounted inside `v2/avadial_root.dart`
              // (owned by a different agent) — it belongs at this shell-root
              // level so it overlays every app, not just one.
              const Positioned(top: 0, left: 0, right: 0, child: MiniAudioPlayerBar()),
            ],
          ),
          // The app switcher is rendered ONCE here, at the shell level — so the
          // same icons stay in the same place as the user moves between AvaTOK,
          // Calls and Marketplace (2026-07-12 nav rebrand). Each root no longer
          // owns this bar itself.
          bottomNavigationBar: AppSwitcherBar(
            order: _order,
            activeRoot: _root,
            askAvaActive: _askAvaOpen,
            onSelect: _switchRoot,
            onReorder: _setRootOrder,
            onAskAva: _askAva,
            onOpenInbox: _openInbox,
            inboxActive: _inboxOpen,
          ),
        ),
      ),
    );
  }
}

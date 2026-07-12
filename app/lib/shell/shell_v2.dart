import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../auth/clerk_client.dart';
import '../core/account_storage.dart';
import '../core/analytics.dart';
import '../core/remote_config.dart';
import '../core/ui/zine.dart';
import '../features/askava/askava_screen.dart';
import '../features/avadial/avadial_channel.dart';
import '../features/avadial/pstn_call_screen.dart';
import '../features/avadial/sms/sms_thread_screen.dart';
import '../identity/identity.dart';
import 'v2/avadial_root.dart';
import 'v2/home_root.dart';
import 'v2/services_root.dart';
import 'v2/talk_root.dart';

/// The four sibling apps of the [ShellV2] shell (Specs/PLAN-2026-07-12-home-ava-
/// tok-services-shell.md). Each is its OWN [Navigator] inside an [IndexedStack],
/// so switching apps preserves the app's nested route stack + scroll state.
enum RootId { home, avaDial, avaTalk, services }

extension RootIdX on RootId {
  /// Stable string used for restoration IDs, persistence + analytics.
  String get key {
    switch (this) {
      case RootId.home:
        return 'home';
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

  const ShellScope({
    super.key,
    required this.activeRoot,
    required this.switchRoot,
    required this.askAva,
    required this.clerk,
    required this.onSignOut,
    required this.identity,
    required super.child,
  });

  static ShellScope of(BuildContext context) {
    final s = context.dependOnInheritedWidgetOfExactType<ShellScope>();
    assert(s != null, 'ShellScope.of() called outside a ShellV2');
    return s!;
  }

  @override
  bool updateShouldNotify(ShellScope old) =>
      old.activeRoot != activeRoot || old.identity != identity;
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
      case 'home':
        return RootId.home;
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
  RootId _root = RootId.home;

  // One Navigator per root — kept alive by the IndexedStack so each app's
  // nested route stack survives an app switch.
  final Map<RootId, GlobalKey<NavigatorState>> _navKeys = {
    for (final r in RootId.values) r: GlobalKey<NavigatorState>(),
  };

  // Per-account last-used root (plan §9 item 2): open to the last root used on
  // this account, Home on first run. Scoped via scopedKey so a parent + child
  // on one phone keep independent last-root state.
  static const _kLastRoot = 'shellv2_last_root';
  static const _ss = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  StreamSubscription<AvaIncomingLaunch>? _incomingSub;
  StreamSubscription<AvaComposeLaunch>? _composeSub;

  @override
  void initState() {
    super.initState();
    _restoreLastRoot();
    _wireIncomingCalls();
    _wireCompose();
  }

  @override
  void dispose() {
    _incomingSub?.cancel();
    _composeSub?.cancel();
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
    _incomingSub = AvaDialChannel.I.incomingLaunch.listen((l) => _openIncoming(l.callId, l.number));
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final l = await AvaDialChannel.I.consumePendingIncoming();
      if (l != null) _openIncoming(l.callId, l.number);
    });
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

  void _openIncoming(String callId, String? number) {
    if (!mounted) return;
    final n = number ?? '';
    if (n.isEmpty) return;
    if (AvaDialChannel.I.incomingScreenOpen) return; // AvaDialRoot may already have it
    AvaDialChannel.I.incomingScreenOpen = true;
    setState(() => _root = RootId.avaDial);
    final nav = _navKeys[RootId.avaDial]?.currentState ?? Navigator.of(context);
    nav
        .push(MaterialPageRoute<void>(
          fullscreenDialog: true,
          builder: (_) => PstnCallScreen(callId: callId, number: n),
        ))
        .whenComplete(() => AvaDialChannel.I.incomingScreenOpen = false);
  }

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

  void _switchRoot(RootId r) {
    if (r == _root) {
      // Re-tapping the active app pops it back to its first route (common
      // bottom-nav affordance).
      _navKeys[r]?.currentState?.popUntil((route) => route.isFirst);
      return;
    }
    setState(() => _root = r);
    _persistLastRoot(r);
    Analytics.capture('shellv2_root_selected', {'root': r.key});
  }

  void _askAva([String hint = 'root']) {
    Analytics.capture('shellv2_askava_opened', {'root': _root.key, 'hint': hint});
    // Global action: push the assistant onto the ACTIVE root's navigator so it
    // overlays the current app and Android back returns the user where they were.
    final nav = _navKeys[_root]?.currentState ?? Navigator.of(context);
    nav.push(MaterialPageRoute<void>(
      builder: (_) => AskAvaScreen(contextHint: hint),
    ));
  }

  Widget _rootScreen(RootId r) {
    switch (r) {
      case RootId.home:
        return const HomeRoot(key: PageStorageKey('shellv2_home'));
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
    if (_root != RootId.home) {
      _switchRoot(RootId.home);
      return;
    }
    // At Home's first route → leave the app.
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
      child: PopScope(
        canPop: false,
        onPopInvokedWithResult: (didPop, _) {
          if (didPop) return;
          _handleBack();
        },
        child: Scaffold(
          backgroundColor: Zine.paper,
          body: IndexedStack(
            index: _root.index,
            children: [for (final r in RootId.values) _navigatorFor(r)],
          ),
        ),
      ),
    );
  }
}

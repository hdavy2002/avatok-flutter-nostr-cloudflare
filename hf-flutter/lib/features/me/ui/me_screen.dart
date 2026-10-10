import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_error.dart';
import '../../../core/auth/hf_me.dart';
import '../../../core/auth/session.dart';
import '../../../core/links.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../../lanes/data/lanes_api.dart';
import '../data/me_telemetry.dart';
import '../data/notification_control.dart';
import 'name_sheet.dart';

/// Copy of the Me screen.
abstract final class MeCopy {
  static const String title = 'Me';
  static const String signInTitle = 'Sign in';
  static const String signInBody = 'Sign in with your WhatsApp number to call, add tokens and manage your account.';
  static const String signInButton = 'Sign in';
  static const String noName = 'Add your name';
  static const String editName = 'Change name';
  static const String whatsapp = 'WhatsApp';
  static const String closingTitle = 'Your account is being closed';
  static const String closingBody = 'See where it stands, or change your mind.';
  static const String closingButton = 'See status';
  static const String spacesTitle = 'My spaces';
  static const String womenSpace = 'Women-only space';
  static const String lgbtqSpace = 'LGBTQ+ space';
  static const String youAreIn = "You're in";
  static const String notJoined = 'Not joined';
  static const String join = 'Join';
  static const String leave = 'Leave';
  static const String leaveTitle = 'Leave this space?';
  static const String leaveBody = 'You can join again later. You will have to verify again.';
  static const String leaveStay = 'Stay';
  static const String leaveYes = 'Leave';
  static const String hostTitle = 'Host';
  static const String hostDashboard = 'Host dashboard';
  static const String becomeHost = 'Become a host';
  static const String becomeHostBody = 'Talk to people and earn. It takes about 10 minutes to set up.';
  static const String notificationsTitle = 'Notifications';
  static const String notificationsBody = 'Know when your favourite host is online.';
  static const String helpTitle = 'Help and legal';
  static const String signOut = 'Sign out';
  static const String deleteAccount = 'Delete my account';
  static const String couldNotOpenPage = "We couldn't open that page. Please try again.";
  static const String couldNotLeave = "We couldn't update that. Please try again.";

  /// Key, label and site path of every help and legal page.
  static const List<(String, String, String)> links = [
    ('help', 'Help centre', '/help'),
    ('safety', 'Safety', '/safety'),
    ('community', 'Community guidelines', '/community-guidelines'),
    ('terms', 'Terms of use', '/terms'),
    ('wallet-terms', 'Wallet and token terms', '/wallet-terms'),
    ('privacy', 'Privacy policy', '/privacy'),
    ('data-deletion', 'Data deletion', '/data-deletion'),
    ('grievance', 'Grievance officer', '/grievance'),
    ('report', 'Report a problem', '/report'),
  ];

  static String hostStatusLine(String status) {
    switch (status) {
      case 'live':
        return 'You are live. Open your dashboard.';
      case 'draft':
      case 'pending_host':
        return 'Finish setting up your profile.';
      case 'generating':
        return 'We are making your profile.';
      case 'pending_review':
        return 'We are checking your profile.';
      case 'rejected':
        return 'Your profile needs changes.';
      case 'paused':
        return 'Your profile is paused.';
      default:
        return 'Open your dashboard.';
    }
  }
}

/// Tab 4: the person, their spaces, notifications, help and legal links, sign out and delete account
/// (spec 2.15, HF-NATIVE-12). Signed out it shows a sign-in card and the help and legal links.
class MeScreen extends ConsumerStatefulWidget {
  const MeScreen({super.key});

  @override
  ConsumerState<MeScreen> createState() => _MeScreenState();
}

class _MeScreenState extends ConsumerState<MeScreen> with WidgetsBindingObserver {
  /// The name just saved, shown at once (the session reloads `/api/hf/me` behind it).
  String? _savedName;

  /// Lanes the person just left, shown at once.
  final Map<Lane, bool> _laneOverride = <Lane, bool>{};
  Lane? _leaving;

  bool? _notificationsOn;
  bool _notificationsBusy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      MeTelemetry.viewed(signedIn: ref.read(sessionProvider).isSignedIn);
      unawaited(_loadNotifications());
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Coming back from the phone's notification settings.
    if (state == AppLifecycleState.resumed) unawaited(_loadNotifications());
  }

  Future<void> _loadNotifications() async {
    final on = await ref.read(notificationControlProvider).isEnabled();
    if (!mounted) return;
    setState(() => _notificationsOn = on);
  }

  Future<void> _toggleNotifications(bool on) async {
    if (_notificationsBusy) return;
    setState(() => _notificationsBusy = true);
    final changed = await ref.read(notificationControlProvider).setEnabled(on);
    if (!mounted) return;
    setState(() {
      _notificationsBusy = false;
      if (changed) _notificationsOn = on;
    });
    if (!changed) await _loadNotifications();
  }

  Future<void> _editName(String? current) async {
    final saved = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: HfColors.cream,
      showDragHandle: true,
      builder: (_) => NameSheet(initial: current ?? ''),
    );
    if (saved == null || !mounted) return;
    setState(() => _savedName = saved);
    // The session reloads `/api/hf/me`; a failure there keeps what is shown.
    unawaited(ref.read(sessionProvider.notifier).refreshMe());
  }

  bool _inLane(Lane lane, HfMe? me) {
    final o = _laneOverride[lane];
    if (o != null) return o;
    if (me == null) return false;
    return lane == Lane.women ? me.womenLane : me.lgbtqLane;
  }

  Future<void> _leaveLane(Lane lane) async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text(MeCopy.leaveTitle),
        content: const Text(MeCopy.leaveBody),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text(MeCopy.leaveStay)),
          TextButton(
            key: const ValueKey<String>('me-leave-confirm'),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text(MeCopy.leaveYes),
          ),
        ],
      ),
    );
    if (yes != true || !mounted) return;
    setState(() => _leaving = lane);
    try {
      await ref.read(lanesApiProvider).leave(lane);
      if (!mounted) return;
      setState(() {
        _leaving = null;
        _laneOverride[lane] = false;
      });
      ref.invalidate(laneStatusProvider);
      unawaited(ref.read(sessionProvider.notifier).refreshMe());
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() => _leaving = null);
      _snack(e.message ?? MeCopy.couldNotLeave);
    }
  }

  void _snack(String text) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text, style: HfText.bodyText.copyWith(color: HfColors.cream))));
  }

  Future<void> _openPage(String path) async {
    final ok = await LinkOpener.instance.site(path);
    if (!ok && mounted) _snack(MeCopy.couldNotOpenPage);
  }

  Future<void> _signOut() async {
    // Go Home first: /me needs an account, so staying on it would bounce to the sign-in screen.
    GoRouter.of(context).go(Routes.home);
    await ref.read(sessionProvider.notifier).signOut();
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    return Scaffold(
      appBar: AppBar(automaticallyImplyLeading: false, title: const Text(MeCopy.title)),
      body: SafeArea(
        child: session.isLoading
            ? const LoadingPanel()
            : SingleChildScrollView(
                padding: const EdgeInsets.all(HfSpacing.page),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: session.isSignedIn ? _signedIn(context, session) : _signedOut(context),
                ),
              ),
      ),
    );
  }

  // ---- signed out -----------------------------------------------------------------------------------

  List<Widget> _signedOut(BuildContext context) => [
        HfCard(
          color: HfColors.lilac,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(MeCopy.signInTitle, style: HfText.title),
              const SizedBox(height: 8),
              const Text(MeCopy.signInBody, style: HfText.bodyText),
              const SizedBox(height: 16),
              HfButton(
                key: const ValueKey<String>('me-sign-in'),
                label: MeCopy.signInButton,
                onPressed: () => unawaited(requireSignIn(context, ref, next: Routes.me)),
              ),
            ],
          ),
        ),
        const SizedBox(height: HfSpacing.gapLarge),
        ..._helpSection(),
        const SizedBox(height: HfSpacing.gapLarge),
        const CrisisStrip(),
        const SizedBox(height: HfSpacing.gapLarge),
        _versionLine(),
      ];

  // ---- signed in ------------------------------------------------------------------------------------

  List<Widget> _signedIn(BuildContext context, SessionState session) {
    final me = session.me;
    final name = _savedName ?? me?.displayName;
    return [
      _profileCard(name, me),
      if (me?.closing ?? false) ...[
        const SizedBox(height: HfSpacing.gap),
        HfCard(
          key: const ValueKey<String>('me-closing'),
          color: HfColors.blush,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(MeCopy.closingTitle, style: HfText.subtitle),
              const SizedBox(height: 6),
              const Text(MeCopy.closingBody, style: HfText.bodyText),
              const SizedBox(height: 12),
              HfButton(
                key: const ValueKey<String>('me-closing-status'),
                label: MeCopy.closingButton,
                kind: HfButtonKind.secondary,
                onPressed: () => unawaited(context.push(Routes.meDelete)),
              ),
            ],
          ),
        ),
      ],
      const SizedBox(height: HfSpacing.gapLarge),
      const Text(MeCopy.spacesTitle, style: HfText.subtitle),
      const SizedBox(height: 8),
      _laneRow(Lane.women, MeCopy.womenSpace, me),
      const SizedBox(height: 8),
      _laneRow(Lane.lgbtq, MeCopy.lgbtqSpace, me),
      const SizedBox(height: HfSpacing.gapLarge),
      const Text(MeCopy.hostTitle, style: HfText.subtitle),
      const SizedBox(height: 8),
      _hostCard(context, me),
      const SizedBox(height: HfSpacing.gapLarge),
      _notificationsCard(),
      const SizedBox(height: HfSpacing.gapLarge),
      ..._helpSection(),
      const SizedBox(height: HfSpacing.gapLarge),
      const CrisisStrip(),
      const SizedBox(height: HfSpacing.gapLarge),
      HfButton(
        key: const ValueKey<String>('me-sign-out'),
        label: MeCopy.signOut,
        kind: HfButtonKind.secondary,
        icon: Icons.logout_rounded,
        onPressed: () => unawaited(_signOut()),
      ),
      const SizedBox(height: 4),
      TextButton(
        key: const ValueKey<String>('me-delete'),
        style: TextButton.styleFrom(
          foregroundColor: HfColors.accent,
          minimumSize: const Size.fromHeight(HfSpacing.tap),
        ),
        onPressed: () => unawaited(context.push(Routes.meDelete)),
        child: const Text(MeCopy.deleteAccount),
      ),
      const SizedBox(height: 8),
      _versionLine(),
    ];
  }

  Widget _profileCard(String? name, HfMe? me) {
    final shownName = (name == null || name.trim().isEmpty) ? null : name.trim();
    final phone = me?.phoneMasked;
    return HfCard(
      child: Row(
        children: [
          Container(
            width: 52,
            height: 52,
            decoration: const BoxDecoration(color: HfColors.lilac, shape: BoxShape.circle),
            child: const Icon(Icons.person_rounded, color: HfColors.orchid, size: 28),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  shownName ?? MeCopy.noName,
                  key: const ValueKey<String>('me-name'),
                  style: shownName != null ? HfText.subtitle : HfText.subtitle.copyWith(color: HfColors.mauve),
                ),
                if (phone != null) ...[
                  const SizedBox(height: 2),
                  Text('${MeCopy.whatsapp} $phone', key: const ValueKey<String>('me-phone'), style: HfText.note),
                ],
              ],
            ),
          ),
          IconButton(
            key: const ValueKey<String>('me-edit-name'),
            tooltip: MeCopy.editName,
            constraints: const BoxConstraints(minWidth: HfSpacing.tap, minHeight: HfSpacing.tap),
            onPressed: () => unawaited(_editName(shownName)),
            icon: const Icon(Icons.edit_rounded, color: HfColors.orchid),
          ),
        ],
      ),
    );
  }

  Widget _laneRow(Lane lane, String label, HfMe? me) {
    final inLane = _inLane(lane, me);
    final busy = _leaving == lane;
    return HfCard(
      key: ValueKey<String>('me-lane-${lane.wire}'),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: HfText.bodyStrong),
                const SizedBox(height: 2),
                Text(inLane ? MeCopy.youAreIn : MeCopy.notJoined, style: HfText.note),
              ],
            ),
          ),
          const SizedBox(width: 8),
          if (inLane)
            HfButton(
              key: ValueKey<String>('me-lane-${lane.wire}-leave'),
              label: MeCopy.leave,
              kind: HfButtonKind.secondary,
              expand: false,
              loading: busy,
              onPressed: () => unawaited(_leaveLane(lane)),
            )
          else
            HfButton(
              key: ValueKey<String>('me-lane-${lane.wire}-join'),
              label: MeCopy.join,
              kind: HfButtonKind.secondary,
              expand: false,
              onPressed: () => unawaited(context.push(Routes.lanesOf(lane.wire))),
            ),
        ],
      ),
    );
  }

  Widget _hostCard(BuildContext context, HfMe? me) {
    final host = me?.host;
    if (host != null) {
      return HfCard(
        key: const ValueKey<String>('me-host'),
        onTap: () => context.go(Routes.host),
        child: Row(
          children: [
            const Icon(Icons.storefront_rounded, color: HfColors.orchid),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(MeCopy.hostDashboard, style: HfText.bodyStrong),
                  const SizedBox(height: 2),
                  Text(MeCopy.hostStatusLine(host.status), style: HfText.note),
                ],
              ),
            ),
            const Icon(Icons.chevron_right_rounded, color: HfColors.mauve),
          ],
        ),
      );
    }
    return HfCard(
      key: const ValueKey<String>('me-become-host'),
      color: HfColors.butter,
      onTap: () => unawaited(context.push(Routes.hostOnboarding)),
      child: const Row(
        children: [
          Icon(Icons.mic_rounded, color: HfColors.orchid),
          SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(MeCopy.becomeHost, style: HfText.bodyStrong),
                SizedBox(height: 2),
                Text(MeCopy.becomeHostBody, style: HfText.note),
              ],
            ),
          ),
          Icon(Icons.chevron_right_rounded, color: HfColors.mauve),
        ],
      ),
    );
  }

  Widget _notificationsCard() {
    final on = _notificationsOn ?? false;
    return HfCard(
      child: Row(
        children: [
          const Icon(Icons.notifications_rounded, color: HfColors.orchid),
          const SizedBox(width: 14),
          const Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(MeCopy.notificationsTitle, style: HfText.bodyStrong),
                SizedBox(height: 2),
                Text(MeCopy.notificationsBody, style: HfText.note),
              ],
            ),
          ),
          Switch(
            key: const ValueKey<String>('me-notifications'),
            value: on,
            onChanged: (_notificationsOn == null || _notificationsBusy) ? null : (v) => unawaited(_toggleNotifications(v)),
          ),
        ],
      ),
    );
  }

  // ---- shared ---------------------------------------------------------------------------------------

  List<Widget> _helpSection() => [
        const Text(MeCopy.helpTitle, style: HfText.subtitle),
        const SizedBox(height: 8),
        HfCard(
          padding: EdgeInsets.zero,
          child: Column(
            children: [
              for (var i = 0; i < MeCopy.links.length; i++) ...[
                if (i > 0) const Divider(height: 1, color: HfColors.line),
                _linkRow(MeCopy.links[i].$1, MeCopy.links[i].$2, MeCopy.links[i].$3),
              ],
            ],
          ),
        ),
      ];

  Widget _linkRow(String key, String label, String path) {
    return InkWell(
      key: ValueKey<String>('me-link-$key'),
      onTap: () => unawaited(_openPage(path)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 52),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Row(
            children: [
              Expanded(child: Text(label, style: HfText.bodyText)),
              const Icon(Icons.open_in_new_rounded, size: 20, color: HfColors.mauve),
            ],
          ),
        ),
      ),
    );
  }

  /// `Version 2.5.0 (2005)`, or nothing while the build is unknown.
  Widget _versionLine() {
    final v = Analytics.appVersion;
    if (v.isEmpty || v == 'unresolved') return const SizedBox.shrink();
    final parts = v.split('+');
    final text = parts.length == 2 ? 'Version ${parts[0]} (${parts[1]})' : 'Version $v';
    return Text(text, key: const ValueKey<String>('me-version'), style: HfText.note, textAlign: TextAlign.center);
  }
}

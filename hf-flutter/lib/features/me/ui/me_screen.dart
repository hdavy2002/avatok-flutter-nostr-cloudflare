import 'dart:async';

import 'package:flutter/material.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_error.dart';
import '../../../core/auth/hf_me.dart';
import '../../../core/auth/session.dart';
import '../../../core/links.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/theme/theme_mode_store.dart';
import '../../../core/theme/hf_profile_style.dart';
import '../../../core/widgets/widgets.dart';
import '../../host_dashboard/host_dashboard_providers.dart';
import '../../lanes/data/lanes_api.dart';
import '../data/me_telemetry.dart';
import '../data/notification_control.dart';
import 'name_sheet.dart';
import '../../kyc/ui/identity_kyc_screen.dart';
import '../../auth/ui/sign_in_screen.dart';
import '../../call/data/call_api.dart';
import '../../wallet/wallet_providers.dart';

/// Copy of the Me screen.
abstract final class MeCopy {
  static const String title = 'Me';
  static const String signInTitle = 'Sign in';
  static const String signInBody =
      'Sign in with your WhatsApp number to call, add money and manage your account.';
  static const String signInButton = 'Sign in';
  static const String noName = 'Add your name';
  static const String editName = 'Edit profile';
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
  static const String leaveBody =
      'You can join again later with a fresh declaration. Valid identity and approved video checks can be reused.';
  static const String leaveStay = 'Stay';
  static const String leaveYes = 'Leave';
  static const String hostTitle = 'Host';
  static const String hostDashboard = 'Host dashboard';
  static const String becomeHost = 'Become a host';
  static const String becomeHostBody =
      'Talk to people and earn. It takes about 10 minutes to set up.';
  static const String appearanceTitle = 'Appearance';
  static const String appearanceBody =
      'Dark is the default. System follows your phone’s light or dark setting.';
  static const String appearanceLight = 'Light';
  static const String appearanceDark = 'Dark';
  static const String appearanceSystem = 'System';
  static const String notificationsTitle = 'Notifications';
  static const String notificationsBody =
      'Know when your favourite host is online.';
  static const String nudgeTitle = 'Offline reminders';
  static const String nudgeBody =
      "A WhatsApp nudge every 3 hours while you're offline";
  static const String couldNotSaveNudge =
      "We couldn't update that. Please try again.";
  static const String helpTitle = 'Help and legal';
  static const String signOut = 'Sign out';
  static const String deleteAccount = 'Delete my account';
  static const String couldNotOpenPage =
      "We couldn't open that page. Please try again.";
  static const String couldNotLeave =
      "We couldn't update that. Please try again.";

  /// Key, label and site path of every help and legal page.
  static const List<(String, String, String)> links = [
    ('help', 'Help centre', '/help'),
    ('safety', 'Safety', '/safety'),
    ('community', 'Community guidelines', '/community-guidelines'),
    ('terms', 'Terms of use', '/terms'),
    ('wallet-terms', 'Wallet terms', '/wallet-terms'),
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

class _MeScreenState extends ConsumerState<MeScreen>
    with WidgetsBindingObserver {
  /// The name just saved, shown at once (the session reloads `/api/hf/me` behind it).
  String? _savedName;

  /// Lanes the person just left, shown at once.
  final Map<Lane, bool> _laneOverride = <Lane, bool>{};
  Lane? _leaving;

  bool? _notificationsOn;
  bool _notificationsBusy = false;

  /// Offline reminders for a host: on = not paused. Null until the server has answered.
  bool? _nudgesOn;
  bool _nudgesBusy = false;
  bool _leavingAccount = false;
  final GlobalKey _appearanceKey = GlobalKey();

  HfProfileStyle get _style => HfProfileStyle.of(context);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      MeTelemetry.viewed(signedIn: ref.read(sessionProvider).isSignedIn);
      unawaited(_loadNotifications());
      unawaited(_loadNudges());
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

  Future<void> _loadNudges() async {
    if (!ref.read(sessionProvider).hasHostTab) return;
    try {
      final paused = await ref.read(hostDashboardApiProvider).nudgesPaused();
      if (!mounted) return;
      setState(() => _nudgesOn = !paused);
    } catch (_) {
      // Stays unknown: the switch is off-limits until the server answers.
    }
  }

  Future<void> _toggleNudges(bool on) async {
    if (_nudgesBusy) return;
    final before = _nudgesOn;
    setState(() {
      _nudgesBusy = true;
      _nudgesOn = on;
    });
    try {
      final paused = await ref
          .read(hostDashboardApiProvider)
          .setNudgesPaused(!on);
      if (!mounted) return;
      setState(() {
        _nudgesBusy = false;
        _nudgesOn = !paused;
      });
      MeTelemetry.presenceNudgeToggle(on: on, outcome: 'ok');
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _nudgesBusy = false;
        _nudgesOn = before;
      });
      MeTelemetry.presenceNudgeToggle(on: on, outcome: 'failed');
      _snack(MeCopy.couldNotSaveNudge);
    }
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
    final saved = await showHfSheet<String>(
      context,
      initialSize: 0.9,
      minSize: 0.5,
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
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text(MeCopy.leaveStay),
          ),
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
      ..showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _openPage(String path) async {
    final ok = await LinkOpener.instance.site(path);
    if (!ok && mounted) _snack(MeCopy.couldNotOpenPage);
  }

  Future<void> _signOut({bool switchAccount = false}) async {
    if (_leavingAccount) return;
    setState(() => _leavingAccount = true);
    final session = ref.read(sessionProvider);
    final uid = session.user?.id ?? session.me?.uid;
    bool sameAccount() {
      if (!mounted) return false;
      final current = ref.read(sessionProvider);
      return current.isSignedIn && (current.user?.id ?? current.me?.uid) == uid;
    }
    try {
      final purchases = ref.read(purchaseControllerProvider.notifier);
      if (purchases.hasActivePurchase) {
        _snack('Finish your purchase before leaving this account.');
        return;
      }
      final store = ref.read(activeCallStoreProvider);
      final callApi = ref.read(callApiProvider);
      final callId = await store.read();
      if (!sameAccount()) return;
      if (callId != null) {
        try {
          final info = await callApi.status(callId);
          if (!sameAccount()) return;
          if (!info.status.isTerminal) {
            _snack('Finish your active call before leaving this account.');
            return;
          }
          await store.clear(onlyIfId: callId);
        } catch (_) {
          if (sameAccount()) _snack('We could not confirm that your call ended. Please try again.');
          return;
        }
      }
      if (!mounted || !sameAccount()) return;
      if (purchases.hasActivePurchase) {
        _snack('Finish your purchase before leaving this account.');
        return;
      }
      final navigator = Navigator.of(context);
      final controller = ref.read(sessionProvider.notifier);
      GoRouter.of(context).go(Routes.explore);
      await controller.signOut();
      if (switchAccount && navigator.mounted) {
        await navigator.push<void>(MaterialPageRoute(builder: (_) => const SignInScreen(secondNumber: true)));
      }
    } finally { if (mounted) setState(() => _leavingAccount = false); }
  }

  void _showAppearance() {
    final target = _appearanceKey.currentContext;
    if (target == null) return;
    unawaited(Scrollable.ensureVisible(
      target,
      alignment: 0.05,
      duration: MediaQuery.disableAnimationsOf(context)
          ? Duration.zero : const Duration(milliseconds: 250),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    final style = _style;
    final buttonStyle = OutlinedButton.styleFrom(
      foregroundColor: style.ink,
      backgroundColor: style.soft,
      side: BorderSide(color: style.line),
      minimumSize: const Size(48, 48),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      textStyle: style.body.copyWith(fontWeight: FontWeight.w500),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
    );
    return Theme(
      data: Theme.of(context).copyWith(
        outlinedButtonTheme: OutlinedButtonThemeData(style: buttonStyle),
        switchTheme: SwitchThemeData(
          thumbColor: WidgetStateProperty.resolveWith((states) =>
              states.contains(WidgetState.selected) ? style.selectedInk : style.muted),
          trackColor: WidgetStateProperty.resolveWith((states) =>
              states.contains(WidgetState.selected) ? style.selected : style.soft),
          trackOutlineColor: WidgetStatePropertyAll(style.line),
          materialTapTargetSize: MaterialTapTargetSize.padded,
        ),
      ),
      child: Scaffold(
        backgroundColor: style.page,
        appBar: AppBar(
          automaticallyImplyLeading: false,
          toolbarHeight: 24 + MediaQuery.textScalerOf(context).scale(24) * 1.4,
          backgroundColor: style.page,
          foregroundColor: style.ink,
          surfaceTintColor: Colors.transparent,
          title: Text(MeCopy.title, style: style.title),
          actions: [
            IconButton(
              key: const ValueKey<String>('me-appearance-settings'),
              tooltip: 'Appearance settings',
              onPressed: session.isLoading ? null : _showAppearance,
              icon: const Icon(Icons.settings_outlined),
            ),
            const SizedBox(width: 8),
          ],
        ),
        body: SafeArea(
          bottom: false,
          child: session.isLoading
              ? const LoadingPanel()
              : SingleChildScrollView(
                  padding: EdgeInsets.fromLTRB(20, 12, 20,
                      MediaQuery.paddingOf(context).bottom + 24),
                  child: Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 640),
                      // Sections rise in one after another (HF-MOTION-D, light touch).
                      child: StaggeredReveal(
                        key: const ValueKey<String>('me-sections'),
                        stagger: const Duration(milliseconds: 40),
                        children: session.isSignedIn
                            ? _signedIn(context, session) : _signedOut(context),
                      ),
                    ),
                  ),
                ),
        ),
      ),
    );
  }

  Widget _heading(String text) => Padding(
    padding: const EdgeInsets.fromLTRB(4, 0, 4, 10),
    child: Semantics(header: true, child: Text(text, style: _style.heading)),
  );

  Widget _card({Key? key, required Widget child}) => Container(
    key: key,
    decoration: _style.card,
    padding: const EdgeInsets.all(20),
    child: child,
  );

  Widget _group(List<Widget> rows, {Key? key}) => Container(
    key: key,
    decoration: _style.card,
    child: ClipRRect(
      borderRadius: BorderRadius.circular(24),
      child: Material(
        type: MaterialType.transparency,
        child: Column(children: [
          for (var i = 0; i < rows.length; i++) ...[
            if (i > 0) Divider(height: 1, color: _style.line),
            rows[i],
          ],
        ]),
      ),
    ),
  );

  Widget _iconSquare(IconData icon, {Color? color}) => Container(
    width: 40,
    height: 40,
    decoration: BoxDecoration(
      color: _style.iconTint,
      borderRadius: BorderRadius.circular(12),
    ),
    child: Icon(icon, size: 20, color: color ?? _style.ink),
  );

  Widget _row({
    Key? key,
    required IconData icon,
    required String title,
    String? subtitle,
    Widget? trailing,
    bool actionBelowWhenNarrow = false,
    VoidCallback? onTap,
    Color? titleColor,
    Color? iconColor,
  }) {
    final content = LayoutBuilder(builder: (context, constraints) {
      final stackAction = actionBelowWhenNarrow &&
          (constraints.maxWidth < 280 || MediaQuery.textScalerOf(context).scale(16) > 24);
      final text = Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: _style.body.copyWith(color: titleColor)),
          if (subtitle != null) ...[
            const SizedBox(height: 2),
            Text(subtitle, style: _style.note),
          ],
          if (stackAction && trailing != null) ...[
            const SizedBox(height: 8),
            trailing,
          ],
        ],
      );
      return ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 64),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
          child: Row(children: [
            _iconSquare(icon, color: iconColor),
            const SizedBox(width: 12),
            Expanded(child: text),
            if (!stackAction && trailing != null) ...[
              const SizedBox(width: 8),
              trailing,
            ],
          ]),
        ),
      );
    });
    if (onTap == null) return KeyedSubtree(key: key, child: content);
    return InkWell(key: key, onTap: onTap, child: content);
  }

  Widget _chevron() => Icon(Icons.chevron_right_rounded, color: _style.muted);

  List<Widget> _signedOut(BuildContext context) => [
    _card(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text(MeCopy.signInTitle, style: _style.title),
      const SizedBox(height: 8),
      Text(MeCopy.signInBody, style: _style.body),
      const SizedBox(height: 16),
      HfButton(
        key: const ValueKey<String>('me-sign-in'),
        label: MeCopy.signInButton,
        kind: HfButtonKind.secondary,
        onPressed: () => unawaited(requireSignIn(context, ref, next: Routes.me)),
      ),
    ])),
    const SizedBox(height: 28),
    ..._appearanceSection(),
    const SizedBox(height: 28),
    ..._helpSection(),
    const SizedBox(height: 28),
    const CrisisStrip(),
    const SizedBox(height: 28),
    _versionLine(),
  ];

  List<Widget> _signedIn(BuildContext context, SessionState session) {
    final me = session.me;
    final name = _savedName ?? me?.displayName;
    return [
      _profileCard(name, me, session.user?.imageUrl, session.user?.id ?? me?.uid),
      if (me?.closing ?? false) ...[
        const SizedBox(height: 16),
        _card(
          key: const ValueKey<String>('me-closing'),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text(MeCopy.closingTitle, style: _style.heading),
            const SizedBox(height: 6),
            Text(MeCopy.closingBody, style: _style.body),
            const SizedBox(height: 12),
            HfButton(
              key: const ValueKey<String>('me-closing-status'),
              label: MeCopy.closingButton,
              kind: HfButtonKind.secondary,
              onPressed: () => unawaited(context.push(Routes.meDelete)),
            ),
          ]),
        ),
      ],
      const SizedBox(height: 28),
      _heading('My preferences'),
      _preferencesCard(session.hasHostTab),
      const SizedBox(height: 28),
      ..._appearanceSection(),
      const SizedBox(height: 28),
      _heading(MeCopy.spacesTitle),
      _group([
        _laneRow(Lane.women, MeCopy.womenSpace, me),
        _laneRow(Lane.lgbtq, MeCopy.lgbtqSpace, me),
      ]),
      const SizedBox(height: 28),
      _heading(MeCopy.hostTitle),
      _hostCard(context, me),
      const SizedBox(height: 28),
      ..._helpSection(),
      const SizedBox(height: 28),
      const CrisisStrip(),
      const SizedBox(height: 28),
      _group([
        _row(
          key: const ValueKey<String>('me-sign-out'),
          icon: Icons.logout_rounded,
          title: MeCopy.signOut,
          onTap: () => unawaited(_signOut()),
        ),
        _row(
          key: const ValueKey<String>('me-delete'),
          icon: Icons.delete_outline_rounded,
          title: MeCopy.deleteAccount,
          titleColor: _style.accent,
          iconColor: _style.accent,
          onTap: () => unawaited(context.push(Routes.meDelete)),
        ),
      ]),
      const SizedBox(height: 20),
      _versionLine(),
    ];
  }

  Widget _profileCard(String? name, HfMe? me, String? imageUrl, String? accountId) {
    final shownName = name?.trim();
    final phone = me?.phoneMasked?.trim();
    final username = me?.username?.trim();
    final photo = imageUrl?.trim();
    return _card(
      key: const ValueKey<String>('me-summary'),
      child: LayoutBuilder(builder: (context, constraints) {
        final narrow = constraints.maxWidth < 320;
        final avatarSize = narrow ? 74.0 : 84.0;
        final fallback = ColoredBox(
          key: const ValueKey<String>('me-avatar-fallback'),
          color: _style.iconTint,
          child: Center(child: Icon(Icons.person_rounded, size: 36, color: _style.ink)),
        );
        final avatar = Container(
          width: avatarSize,
          height: avatarSize,
          padding: const EdgeInsets.all(4),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(24),
            // A subtle warm ring glow around the photo (HF-MOTION-D). Still, never looping.
            border: Border.all(color: HfColors.sunshine.withValues(alpha: 0.85), width: 2),
            boxShadow: [
              ..._style.avatarShadows,
              BoxShadow(
                color: HfColors.sunshine.withValues(alpha: 0.45),
                blurRadius: 18,
                spreadRadius: 1,
              ),
            ],
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(20),
            child: photo == null || photo.isEmpty || accountId == null || accountId.isEmpty
                ? fallback
                : CachedNetworkImage(
                    key: ValueKey<String>('me-avatar:$accountId:$photo'),
                    cacheKey: 'hf-profile:$accountId:$photo',
                    imageUrl: photo,
                    fit: BoxFit.cover,
                    placeholder: (_, _) => fallback,
                    errorWidget: (_, _, _) => fallback,
                  ),
          ),
        );
        final identity = Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(shownName == null || shownName.isEmpty ? MeCopy.noName : shownName,
                key: const ValueKey<String>('me-name'), style: _style.title),
            if (username != null && username.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text('@$username', key: const ValueKey<String>('me-username'), style: _style.note),
            ],
            if (phone != null && phone.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text('${MeCopy.whatsapp} $phone',
                  key: const ValueKey<String>('me-phone'), style: _style.note),
            ],
            if (me?.whatsappVerified ?? false) ...[
              const SizedBox(height: 6),
              Text('WhatsApp verified', style: _style.note),
            ],
          ],
        );
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (constraints.maxWidth < 240 || MediaQuery.textScalerOf(context).scale(16) > 24) ...[
            Align(alignment: Alignment.centerLeft, child: avatar),
            const SizedBox(height: 16),
            identity,
          ] else
            Row(children: [avatar, const SizedBox(width: 18), Expanded(child: identity)]),
          const SizedBox(height: 20),
          HfButton(
            key: const ValueKey<String>('me-edit-name'),
            label: MeCopy.editName,
            kind: HfButtonKind.secondary,
            icon: Icons.edit_outlined,
            onPressed: () => unawaited(_editName(shownName)),
          ),
        ]);
      }),
    );
  }

  Widget _laneRow(Lane lane, String label, HfMe? me) {
    final inLane = _inLane(lane, me);
    return _row(
      key: ValueKey<String>('me-lane-${lane.wire}'),
      icon: lane == Lane.women ? Icons.favorite_rounded : Icons.diversity_1_rounded,
      title: label,
      subtitle: inLane ? MeCopy.youAreIn : MeCopy.notJoined,
      actionBelowWhenNarrow: true,
      trailing: HfButton(
        key: ValueKey<String>('me-lane-${lane.wire}-${inLane ? 'leave' : 'join'}'),
        label: inLane ? MeCopy.leave : MeCopy.join,
        kind: HfButtonKind.secondary,
        expand: false,
        loading: inLane && _leaving == lane,
        onPressed: () => inLane
            ? unawaited(_leaveLane(lane))
            : unawaited(context.push(Routes.lanesOf(lane.wire))),
      ),
    );
  }

  Widget _hostCard(BuildContext context, HfMe? me) {
    final host = me?.host;
    return _group([
      _row(
        key: ValueKey<String>(host == null ? 'me-become-host' : 'me-host'),
        icon: host == null ? Icons.mic_rounded : Icons.storefront_rounded,
        title: host == null ? MeCopy.becomeHost : MeCopy.hostDashboard,
        subtitle: host == null ? MeCopy.becomeHostBody : MeCopy.hostStatusLine(host.status),
        trailing: _chevron(),
        onTap: () => host == null
            ? unawaited(context.push(Routes.hostOnboarding)) : context.go(Routes.host),
      ),
    ]);
  }

  Widget _preferencesCard(bool isHost) => _group([
    _row(
      icon: Icons.notifications_outlined,
      title: MeCopy.notificationsTitle,
      subtitle: MeCopy.notificationsBody,
      actionBelowWhenNarrow: true,
      trailing: Switch(
        key: const ValueKey<String>('me-notifications'),
        value: _notificationsOn ?? false,
        onChanged: (_notificationsOn == null || _notificationsBusy) ? null : (v) {
          HapticFeedback.selectionClick();
          unawaited(_toggleNotifications(v));
        },
      ),
    ),
    _row(
      icon: Icons.verified_user_outlined,
      title: 'Identity verification',
      subtitle: 'View your Aadhaar and video review status',
      trailing: _chevron(),
      onTap: () => Navigator.of(context).push<void>(
          MaterialPageRoute(builder: (_) => const IdentityKycScreen())),
    ),
    _row(
      key: const ValueKey<String>('me-switch-account'),
      icon: Icons.switch_account_outlined,
      title: 'Use another account',
      subtitle: 'Sign out, then verify another WhatsApp number. No physical SIM detection.',
      trailing: _chevron(),
      onTap: _leavingAccount ? null : () => _signOut(switchAccount: true),
    ),
    _row(
      icon: Icons.stars_outlined,
      title: 'Influencer or Celebrity',
      subtitle: 'Full identity and video verification is required. The team confirms eligibility after review.',
      trailing: _chevron(),
      onTap: () => Navigator.of(context).push<void>(
          MaterialPageRoute(builder: (_) => const IdentityKycScreen(creator: true))),
    ),
    if (isHost)
      _row(
        icon: Icons.notifications_paused_rounded,
        title: MeCopy.nudgeTitle,
        subtitle: MeCopy.nudgeBody,
        actionBelowWhenNarrow: true,
        trailing: Switch(
          key: const ValueKey<String>('me-offline-reminders'),
          value: _nudgesOn ?? false,
          onChanged: (_nudgesOn == null || _nudgesBusy) ? null : (v) {
            HapticFeedback.selectionClick();
            unawaited(_toggleNudges(v));
          },
        ),
      ),
  ]);

  /// Uses the existing device preference, including System and saved choices.
  List<Widget> _appearanceSection() {
    final mode = ref.watch(themeModeProvider);
    const options = [
      (ThemeMode.light, MeCopy.appearanceLight, Icons.light_mode_outlined),
      (ThemeMode.dark, MeCopy.appearanceDark, Icons.dark_mode_outlined),
      (ThemeMode.system, MeCopy.appearanceSystem, Icons.phone_android_outlined),
    ];
    return [
      KeyedSubtree(key: _appearanceKey, child: _heading(MeCopy.appearanceTitle)),
      _card(
        key: const ValueKey<String>('me-appearance'),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(MeCopy.appearanceBody, style: _style.note),
          const SizedBox(height: 14),
          LayoutBuilder(builder: (context, constraints) {
            final stack = constraints.maxWidth < 220 ||
                MediaQuery.textScalerOf(context).scale(14) > 20;
            final controls = [
              for (final option in options)
                Semantics(
                  selected: option.$1 == mode,
                  child: OutlinedButton(
                    key: ValueKey<String>('me-appearance-${option.$1.name}'),
                    style: OutlinedButton.styleFrom(
                      backgroundColor: option.$1 == mode ? _style.selected : _style.soft,
                      foregroundColor: option.$1 == mode ? _style.selectedInk : _style.ink,
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
                    ),
                    onPressed: () {
                      HapticFeedback.selectionClick();
                      unawaited(ref.read(themeModeProvider.notifier).set(option.$1));
                    },
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                      Icon(option.$3, size: 22),
                      const SizedBox(height: 6),
                      Text(option.$2, textAlign: TextAlign.center),
                    ]),
                  ),
                ),
            ];
            return KeyedSubtree(
              key: const ValueKey<String>('me-appearance-mode'),
              child: stack
                  ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                      for (var i = 0; i < controls.length; i++) ...[
                        if (i > 0) const SizedBox(height: 8),
                        controls[i],
                      ],
                    ])
                  : Row(children: [
                      for (var i = 0; i < controls.length; i++) ...[
                        if (i > 0) const SizedBox(width: 8),
                        Expanded(child: controls[i]),
                      ],
                    ]),
            );
          }),
        ]),
      ),
    ];
  }

  List<Widget> _helpSection() => [
    _heading(MeCopy.helpTitle),
    _group([for (final l in MeCopy.links) _linkRow(l.$1, l.$2, l.$3)]),
  ];

  Widget _linkRow(String key, String label, String path) => _row(
    key: ValueKey<String>('me-link-$key'),
    icon: key == 'help' ? Icons.help_outline_rounded : Icons.article_outlined,
    title: label,
    trailing: Icon(Icons.open_in_new_rounded, size: 20, color: _style.muted),
    onTap: () => unawaited(_openPage(path)),
  );

  Widget _versionLine() {
    final v = Analytics.appVersion;
    if (v.isEmpty || v == 'unresolved') return const SizedBox.shrink();
    final parts = v.split('+');
    final text = parts.length == 2 ? 'Version ${parts[0]} (${parts[1]})' : 'Version $v';
    return Text(text, key: const ValueKey<String>('me-version'),
        style: _style.note, textAlign: TextAlign.center);
  }
}

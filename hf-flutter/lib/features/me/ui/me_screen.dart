import 'dart:async';

import 'package:flutter/material.dart';
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
import '../../../core/theme/theme_mode_store.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../../host_dashboard/host_dashboard_providers.dart';
import '../../lanes/data/lanes_api.dart';
import '../data/me_telemetry.dart';
import '../data/notification_control.dart';
import 'name_sheet.dart';

/// Copy of the Me screen.
abstract final class MeCopy {
  static const String title = 'Me';
  static const String signInTitle = 'Sign in';
  static const String signInBody =
      'Sign in with your WhatsApp number to call, add money and manage your account.';
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
      'Light is the default. System follows your phone.';
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

  Future<void> _signOut() async {
    // Go Home first: /me needs an account, so staying on it would bounce to the sign-in screen.
    GoRouter.of(context).go(Routes.home);
    await ref.read(sessionProvider.notifier).signOut();
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: false,
        title: const Text(MeCopy.title),
      ),
      body: SafeArea(
        child: session.isLoading
            ? const LoadingPanel()
            : SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(
                  HfSpacing.page,
                  0,
                  HfSpacing.page,
                  120,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: session.isSignedIn
                      ? _signedIn(context, session)
                      : _signedOut(context),
                ),
              ),
      ),
    );
  }

  // ---- building blocks ------------------------------------------------------------------------------

  Widget _heading(String text) => Padding(
    padding: const EdgeInsets.fromLTRB(4, 0, 4, HfSpacing.sm),
    child: Semantics(
      header: true,
      child: Text(text, style: HfText.of(context, HfText.subsection)),
    ),
  );

  /// A grouped list card: radius 22, 1 px line border, rows divided by hairlines.
  Widget _group(List<Widget> rows, {Key? key}) {
    final dark = HfBrightness.isDark(context);
    return Container(
      key: key,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: dark ? HfColors.darkCard : HfColors.white,
        borderRadius: BorderRadius.circular(HfRadius.tile),
        border: Border.all(color: dark ? HfColors.darkLine : HfColors.line),
      ),
      child: Material(
        type: MaterialType.transparency,
        child: Column(
          children: [
            for (var i = 0; i < rows.length; i++) ...[
              if (i > 0)
                Divider(
                  height: 1,
                  color: dark ? HfColors.darkLine : HfColors.line,
                ),
              rows[i],
            ],
          ],
        ),
      ),
    );
  }

  Widget _iconSquare(IconData icon, HfTint tint, {Color? color}) => Container(
    width: 40,
    height: 40,
    decoration: BoxDecoration(
      color: tint.bg(context),
      borderRadius: BorderRadius.circular(12),
    ),
    child: Icon(icon, size: 20, color: color ?? tint.ink(context)),
  );

  Widget _row({
    Key? key,
    required IconData icon,
    required HfTint tint,
    required String title,
    String? subtitle,
    Widget? trailing,
    VoidCallback? onTap,
    Color? titleColor,
    Color? iconColor,
  }) {
    final content = ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 60),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        child: Row(
          children: [
            _iconSquare(icon, tint, color: iconColor),
            const SizedBox(width: HfSpacing.lg),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: HfText.of(
                      context,
                      HfText.bodyStrong,
                    ).copyWith(color: titleColor),
                  ),
                  if (subtitle != null) ...[
                    const SizedBox(height: 2),
                    Text(subtitle, style: HfText.of(context, HfText.note)),
                  ],
                ],
              ),
            ),
            if (trailing != null) ...[
              const SizedBox(width: HfSpacing.sm),
              trailing,
            ],
          ],
        ),
      ),
    );
    if (onTap == null) return KeyedSubtree(key: key, child: content);
    return InkWell(key: key, onTap: onTap, child: content);
  }

  Widget _chevron() => Icon(
    Icons.chevron_right_rounded,
    color: HfText.of(context, HfText.note).color,
  );

  // ---- signed out -----------------------------------------------------------------------------------

  List<Widget> _signedOut(BuildContext context) => [
    const HfCluster(kind: HfClusterKind.profile, height: 150),
    const SizedBox(height: 16),
    HfCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(MeCopy.signInTitle, style: HfText.of(context, HfText.title)),
          const SizedBox(height: 8),
          Text(MeCopy.signInBody, style: HfText.of(context, HfText.body)),
          const SizedBox(height: 16),
          HfButton(
            key: const ValueKey<String>('me-sign-in'),
            label: MeCopy.signInButton,
            onPressed: () =>
                unawaited(requireSignIn(context, ref, next: Routes.me)),
          ),
        ],
      ),
    ),
    const SizedBox(height: HfSpacing.section),
    ..._appearanceSection(),
    const SizedBox(height: HfSpacing.section),
    ..._helpSection(),
    const SizedBox(height: HfSpacing.section),
    const CrisisStrip(),
    const SizedBox(height: HfSpacing.section),
    _versionLine(),
  ];

  // ---- signed in ------------------------------------------------------------------------------------

  List<Widget> _signedIn(BuildContext context, SessionState session) {
    final me = session.me;
    final name = _savedName ?? me?.displayName;
    return [
      _profileCard(name, me),
      if (me?.closing ?? false) ...[
        const SizedBox(height: HfSpacing.lg),
        HfCard(
          key: const ValueKey<String>('me-closing'),
          color: HfBrightness.isDark(context)
              ? HfColors.darkTileBlush
              : HfColors.blush,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                MeCopy.closingTitle,
                style: HfText.of(
                  context,
                  HfText.subsection,
                ).copyWith(color: HfTint.blush.valueInk(context)),
              ),
              const SizedBox(height: 6),
              Text(
                MeCopy.closingBody,
                style: HfText.body.copyWith(color: HfTint.blush.ink(context)),
              ),
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
      const SizedBox(height: HfSpacing.section),
      _notificationsCard(),
      const SizedBox(height: HfSpacing.section),
      _heading(MeCopy.spacesTitle),
      _group([
        _laneRow(Lane.women, MeCopy.womenSpace, me),
        _laneRow(Lane.lgbtq, MeCopy.lgbtqSpace, me),
      ]),
      const SizedBox(height: HfSpacing.section),
      _heading(MeCopy.hostTitle),
      _hostCard(context, me),
      const SizedBox(height: HfSpacing.section),
      ..._appearanceSection(),
      const SizedBox(height: HfSpacing.section),
      ..._helpSection(),
      const SizedBox(height: HfSpacing.section),
      const CrisisStrip(),
      const SizedBox(height: HfSpacing.section),
      _group([
        _row(
          key: const ValueKey<String>('me-sign-out'),
          icon: Icons.logout_rounded,
          tint: HfTint.sky,
          title: MeCopy.signOut,
          onTap: () => unawaited(_signOut()),
        ),
        _row(
          key: const ValueKey<String>('me-delete'),
          icon: Icons.delete_outline_rounded,
          tint: HfTint.blush,
          title: MeCopy.deleteAccount,
          titleColor: HfBrightness.isDark(context)
              ? HfColors.blushLight
              : HfColors.accent,
          iconColor: HfBrightness.isDark(context)
              ? HfColors.blushLight
              : HfColors.accent,
          onTap: () => unawaited(context.push(Routes.meDelete)),
        ),
      ]),
      const SizedBox(height: HfSpacing.lg),
      _versionLine(),
    ];
  }

  Widget _profileCard(String? name, HfMe? me) {
    final shownName = (name == null || name.trim().isEmpty)
        ? null
        : name.trim();
    final phone = me?.phoneMasked;
    return HfCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Container(
                width: 60,
                height: 60,
                decoration: BoxDecoration(
                  color: HfTint.lavender.bg(context),
                  borderRadius: BorderRadius.circular(HfRadius.tile),
                ),
                child: Icon(
                  Icons.person_rounded,
                  color: HfTint.lavender.ink(context),
                  size: 32,
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      shownName ?? MeCopy.noName,
                      key: const ValueKey<String>('me-name'),
                      style: HfText.of(context, HfText.title),
                    ),
                    if (phone != null) ...[
                      const SizedBox(height: 2),
                      Text(
                        '${MeCopy.whatsapp} $phone',
                        key: const ValueKey<String>('me-phone'),
                        style: HfText.of(context, HfText.note),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          HfButton(
            key: const ValueKey<String>('me-edit-name'),
            label: MeCopy.editName,
            kind: HfButtonKind.secondary,
            icon: Icons.edit_rounded,
            onPressed: () => unawaited(_editName(shownName)),
          ),
        ],
      ),
    );
  }

  Widget _laneRow(Lane lane, String label, HfMe? me) {
    final inLane = _inLane(lane, me);
    final busy = _leaving == lane;
    return _row(
      key: ValueKey<String>('me-lane-${lane.wire}'),
      icon: lane == Lane.women
          ? Icons.favorite_rounded
          : Icons.diversity_1_rounded,
      tint: lane == Lane.women ? HfTint.blush : HfTint.lavender,
      title: label,
      subtitle: inLane ? MeCopy.youAreIn : MeCopy.notJoined,
      trailing: inLane
          ? HfButton(
              key: ValueKey<String>('me-lane-${lane.wire}-leave'),
              label: MeCopy.leave,
              kind: HfButtonKind.secondary,
              expand: false,
              loading: busy,
              onPressed: () => unawaited(_leaveLane(lane)),
            )
          : HfButton(
              key: ValueKey<String>('me-lane-${lane.wire}-join'),
              label: MeCopy.join,
              kind: HfButtonKind.secondary,
              expand: false,
              onPressed: () =>
                  unawaited(context.push(Routes.lanesOf(lane.wire))),
            ),
    );
  }

  Widget _hostCard(BuildContext context, HfMe? me) {
    final host = me?.host;
    if (host != null) {
      return _group([
        _row(
          key: const ValueKey<String>('me-host'),
          icon: Icons.storefront_rounded,
          tint: HfTint.lavender,
          title: MeCopy.hostDashboard,
          subtitle: MeCopy.hostStatusLine(host.status),
          trailing: _chevron(),
          onTap: () => context.go(Routes.host),
        ),
      ]);
    }
    final dark = HfBrightness.isDark(context);
    return Container(
      decoration: BoxDecoration(
        color: HfTint.lavender.bg(context),
        borderRadius: BorderRadius.circular(HfRadius.tile),
      ),
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          key: const ValueKey<String>('me-become-host'),
          borderRadius: BorderRadius.circular(HfRadius.tile),
          onTap: () => unawaited(context.push(Routes.hostOnboarding)),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 72),
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Row(
                children: [
                  Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(
                      color: dark ? HfColors.darkCard : HfColors.white,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Icon(
                      Icons.mic_rounded,
                      size: 20,
                      color: HfTint.lavender.ink(context),
                    ),
                  ),
                  const SizedBox(width: HfSpacing.lg),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          MeCopy.becomeHost,
                          style: HfText.bodyStrong.copyWith(
                            color: HfTint.lavender.valueInk(context),
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          MeCopy.becomeHostBody,
                          style: HfText.note.copyWith(
                            color: HfTint.lavender.ink(context),
                          ),
                        ),
                      ],
                    ),
                  ),
                  Icon(
                    Icons.chevron_right_rounded,
                    color: HfTint.lavender.ink(context),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _notificationsCard() {
    final on = _notificationsOn ?? false;
    final isHost = ref.watch(sessionProvider.select((s) => s.hasHostTab));
    return _group([
      _row(
        icon: Icons.notifications_rounded,
        tint: HfTint.blush,
        title: MeCopy.notificationsTitle,
        subtitle: MeCopy.notificationsBody,
        trailing: Switch(
          key: const ValueKey<String>('me-notifications'),
          value: on,
          onChanged: (_notificationsOn == null || _notificationsBusy)
              ? null
              : (v) {
                  HapticFeedback.selectionClick();
                  unawaited(_toggleNotifications(v));
                },
        ),
      ),
      if (isHost)
        _row(
          icon: Icons.notifications_paused_rounded,
          tint: HfTint.blush,
          title: MeCopy.nudgeTitle,
          subtitle: MeCopy.nudgeBody,
          trailing: Switch(
            key: const ValueKey<String>('me-offline-reminders'),
            value: _nudgesOn ?? false,
            onChanged: (_nudgesOn == null || _nudgesBusy)
                ? null
                : (v) {
                    HapticFeedback.selectionClick();
                    unawaited(_toggleNudges(v));
                  },
          ),
        ),
    ]);
  }

  // ---- shared ---------------------------------------------------------------------------------------

  /// Light / Dark / System, saved on the device (not per account).
  List<Widget> _appearanceSection() {
    final mode = ref.watch(themeModeProvider);
    const modes = [ThemeMode.light, ThemeMode.dark, ThemeMode.system];
    return [
      _heading(MeCopy.appearanceTitle),
      HfCard(
        key: const ValueKey<String>('me-appearance'),
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                _iconSquare(
                  mode == ThemeMode.dark
                      ? Icons.dark_mode_rounded
                      : mode == ThemeMode.system
                      ? Icons.phone_android_rounded
                      : Icons.light_mode_rounded,
                  mode == ThemeMode.dark
                      ? HfTint.lavender
                      : mode == ThemeMode.system
                      ? HfTint.sky
                      : HfTint.butter,
                ),
                const SizedBox(width: HfSpacing.lg),
                Expanded(
                  child: Text(
                    MeCopy.appearanceBody,
                    style: HfText.of(context, HfText.note),
                  ),
                ),
              ],
            ),
            const SizedBox(height: HfSpacing.lg),
            HfSegmented(
              key: const ValueKey<String>('me-appearance-mode'),
              options: const [
                MeCopy.appearanceLight,
                MeCopy.appearanceDark,
                MeCopy.appearanceSystem,
              ],
              tints: const [HfTint.butter, HfTint.lavender, HfTint.sky],
              selected: modes.indexOf(mode),
              onChanged: (i) {
                HapticFeedback.selectionClick();
                unawaited(ref.read(themeModeProvider.notifier).set(modes[i]));
              },
            ),
          ],
        ),
      ),
    ];
  }

  List<Widget> _helpSection() => [
    _heading(MeCopy.helpTitle),
    _group([for (final l in MeCopy.links) _linkRow(l.$1, l.$2, l.$3)]),
  ];

  Widget _linkRow(String key, String label, String path) {
    return _row(
      key: ValueKey<String>('me-link-$key'),
      icon: key == 'help' ? Icons.help_outline_rounded : Icons.article_outlined,
      tint: HfTint.sky,
      title: label,
      trailing: Icon(
        Icons.open_in_new_rounded,
        size: 20,
        color: HfText.of(context, HfText.note).color,
      ),
      onTap: () => unawaited(_openPage(path)),
    );
  }

  /// `Version 2.5.0 (2005)`, or nothing while the build is unknown.
  Widget _versionLine() {
    final v = Analytics.appVersion;
    if (v.isEmpty || v == 'unresolved') return const SizedBox.shrink();
    final parts = v.split('+');
    final text = parts.length == 2
        ? 'Version ${parts[0]} (${parts[1]})'
        : 'Version $v';
    return Text(
      text,
      key: const ValueKey<String>('me-version'),
      style: HfText.of(context, HfText.label),
      textAlign: TextAlign.center,
    );
  }
}

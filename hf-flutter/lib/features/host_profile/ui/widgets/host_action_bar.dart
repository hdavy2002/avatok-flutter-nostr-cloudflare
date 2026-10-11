import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/analytics/analytics.dart';
import '../../../../core/api/api_error.dart';
import '../../../../core/auth/session.dart';
import '../../../../core/config/flags.dart';
import '../../../../core/format/money.dart';
import '../../../../core/router/nav.dart';
import '../../../../core/router/routes.dart';
import '../../../../core/widgets/status_pill.dart';
import '../../../../core/theme/hf_theme.dart';
import '../../data/host_profile.dart';
import '../../data/host_profile_providers.dart';
import '../../host_profile_strings.dart';
import '../../../demo/demo_data.dart'; // [HF-DEMO] remove with lib/features/demo

/// The sticky bottom action of the profile: an ink bar (radius 28) with the price on the left and a white pill on
/// the right.
///
/// - Calls are off (flag): a disabled "Calls open soon".
/// - A women-only host and a caller who has not joined that space: "Verify to call", which explains the
///   space and opens the lanes screen.
/// - Online: **Call** (sign in first, then the call confirm step of HF-NATIVE-5).
/// - Busy or offline: **Notify me** (sign in first, then `POST /api/hf/hosts/:slug/notify`).
class HostActionBar extends ConsumerStatefulWidget {
  const HostActionBar({
    super.key,
    required this.profile,
    this.notificationIntent,
  });

  final HostProfile profile;

  /// on/off preserves the requested operation; choose handles older saved links.
  final String? notificationIntent;

  @override
  ConsumerState<HostActionBar> createState() => _HostActionBarState();
}

class _HostActionBarState extends ConsumerState<HostActionBar> {
  bool _busy = false;
  bool _intentHandled = false;
  bool? _subscribedOverride;
  String? _message;
  bool _messageIsError = false;

  HostProfile get _p => widget.profile;

  String? get _lane {
    final value = GoRouterState.of(context).uri.queryParameters['lane'];
    return value == 'women' || value == 'lgbtq' ? value : null;
  }

  Future<void> _call() async {
    unawaited(
      Analytics.capture('hf_app_call_tapped', {
        'slug': _p.slug,
        'status': _p.status.name,
      }),
    );
    // [HF-DEMO] remove with lib/features/demo: no sign-in gate for demo hosts.
    if (!isDemoSlug(_p.slug) &&
        !await requireSignIn(
          context,
          ref,
          next: Routes.callConfirmOf(_p.slug, lane: _lane),
        )) {
      return;
    }
    if (!mounted) return;
    await ref.read(callConfirmOpenerProvider)(context, _p.slug);
  }

  Future<void> _verifyToCall() async {
    if (ref.read(sessionProvider).me?.womenLane == true) {
      await _call();
      return;
    }
    // The space explanation is public; registration belongs to its join action.
    unawaited(
      GoRouter.of(context).push<Object?>(
        Routes.lanesOf(
          'women',
          next: Routes.callConfirmOf(_p.slug, lane: 'women'),
        ),
      ),
    );
  }

  Future<void> _toggleNotify(bool subscribed) {
    HapticFeedback.selectionClick();
    return _setNotify(!subscribed);
  }

  Future<void> _setNotify(bool turnOn) async {
    if (_busy) return;
    // [HF-DEMO] remove with lib/features/demo: a snackbar, no sign-in, no request.
    if (isDemoSlug(_p.slug)) {
      unawaited(HapticFeedback.selectionClick());
      ScaffoldMessenger.maybeOf(context)
        ?..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text(kDemoNotifyMessage)));
      return;
    }
    final next = Uri(
      path: Routes.hostProfileOf(_p.slug),
      queryParameters: {
        'action': 'notify',
        'notify': turnOn ? 'on' : 'off',
        if (_lane != null) 'lane': _lane!,
      },
    ).toString();
    if (!await requireSignIn(context, ref, next: next)) return;
    if (!mounted) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    final sw = Stopwatch()..start();
    try {
      final now = await setNotifyMe(
        ref.read(apiClientProvider),
        _p.slug,
        on: turnOn,
      );
      if (!mounted) return;
      setState(() {
        _busy = false;
        _subscribedOverride = now;
        _intentHandled = true;
        _messageIsError = false;
        _message = now
            ? HostProfileStrings.notifyOn
            : HostProfileStrings.notifyOff;
      });
      unawaited(
        Analytics.capture('hf_app_notify_me', {
          'slug': _p.slug,
          'on': now,
          'outcome': 'ok',
          'ms': sw.elapsedMilliseconds,
        }),
      );
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _messageIsError = true;
        _message = e.userMessage;
      });
      unawaited(
        Analytics.capture('hf_app_notify_me', {
          'slug': _p.slug,
          'on': turnOn,
          'outcome': 'error',
          'reason': e.code,
          'status': e.status,
          'ms': sw.elapsedMilliseconds,
        }),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final callsOn =
        ref
            .watch(flagsProvider)
            .when(
              data: (f) => f.hfCallsEnabled,
              loading: () => true,
              error: (_, __) => true,
            ) ||
        isDemoSlug(_p.slug); // [HF-DEMO] remove with lib/features/demo
    final inWomenLane = ref.watch(
      sessionProvider.select((s) => s.me?.womenLane ?? false),
    );
    final remoteSubscribed = ref
        .watch(notifyStatusProvider(_p.slug))
        .when(data: (v) => v, loading: () => false, error: (_, __) => false);
    final estimate = ref
        .watch(hostEstimateProvider(_p.slug))
        .when(data: (e) => e, loading: () => null, error: (_, __) => null);
    final subscribed = _subscribedOverride ?? remoteSubscribed;
    final name = _p.displayName;

    String? note;
    // The main pill, and an optional second action stacked above it (restored notification intents).
    late final Widget pill;
    var extra = const <Widget>[];
    var showPrice = true;
    final pendingNotify = widget.notificationIntent != null && !_intentHandled;
    if (!callsOn) {
      pill = const _BarPill(
        label: HostProfileStrings.callsSoon,
        onPressed: null,
      );
    } else if (pendingNotify) {
      final intent = widget.notificationIntent;
      showPrice = false;
      note = intent == 'off'
          ? 'You asked to stop notifications for this host. Confirm to continue.'
          : intent == 'on'
          ? 'You asked for a notification when this host is available. Confirm to continue.'
          : 'You returned to manage notifications for this host. Choose what to do.';
      pill = _BarPill(
        label: intent == 'off' ? 'Confirm stop' : 'Confirm notification',
        icon: intent == 'off'
            ? Icons.notifications_off_rounded
            : Icons.notifications_active_rounded,
        loading: _busy,
        onPressed: () => _setNotify(intent != 'off'),
      );
      extra = [
        if (intent == 'choose')
          _BarPill(
            label: 'Stop notifications',
            outlined: true,
            onPressed: _busy ? null : () => _setNotify(false),
          ),
        TextButton(
          onPressed: _busy ? null : () => setState(() => _intentHandled = true),
          style: TextButton.styleFrom(
            foregroundColor: HfColors.white,
            minimumSize: const Size(HfSpacing.tap, HfSpacing.tap),
          ),
          child: Text(
            'Cancel',
            style: HfText.badge.copyWith(color: HfColors.white),
          ),
        ),
      ];
    } else if (_p.womenOnly && !inWomenLane) {
      note = HostProfileStrings.womenLaneNote;
      pill = _BarPill(
        label: HostProfileStrings.verifyToCall,
        icon: Icons.verified_user_rounded,
        onPressed: _verifyToCall,
      );
    } else if (_p.status == HostPresence.online) {
      pill = _BarPill(
        label: HostProfileStrings.callName(name),
        icon: Icons.call_rounded,
        onPressed: _call,
      );
    } else {
      note = _p.status == HostPresence.busy
          ? HostProfileStrings.hostOnCall(name)
          : HostProfileStrings.hostOffline(name);
      pill = _BarPill(
        label: subscribed
            ? HostProfileStrings.notifyStop
            : (_p.status == HostPresence.busy
                  ? HostProfileStrings.notifyBusy
                  : HostProfileStrings.notifyOffline),
        icon: subscribed
            ? Icons.notifications_off_rounded
            : Icons.notifications_active_rounded,
        loading: _busy,
        onPressed: () => _toggleNotify(subscribed),
      );
    }

    final onInk = HfText.note.copyWith(fontSize: 14, color: HfColors.mutedSoft);
    final estimateText = estimate?.aboutText;
    final safeEstimateText = estimateText != null &&
            RegExp(r'\b(tokens?|coins?)\b', caseSensitive: false)
                .hasMatch(estimateText)
        ? HostProfileStrings.addMoneyToCall
        : estimateText;
    final price = _PriceBlock(
      priceLabel: _p.priceLabel,
      about: estimate != null && estimate.isMetered
          ? safeEstimateText
          : (_p.plan == 'standard' || _p.priceTiers.isNotEmpty)
          ? 'Lower rates after 30 min'
          : HostProfileStrings.tenMinutes(
              formatRupees(_p.pricePerMin * 10),
            ),
    );
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.all(HfSpacing.lg),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: HfColors.ink,
            borderRadius: BorderRadius.circular(HfRadius.cardInner),
            boxShadow: HfShadows.nav,
          ),
          child: Padding(
            padding: const EdgeInsets.all(HfSpacing.sm),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (note != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(
                      HfSpacing.lg,
                      HfSpacing.xs,
                      HfSpacing.lg,
                      HfSpacing.sm,
                    ),
                    child: Text(
                      note,
                      style: onInk,
                      textAlign: TextAlign.center,
                    ),
                  ),
                if (_message != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(
                      HfSpacing.lg,
                      HfSpacing.xs,
                      HfSpacing.lg,
                      HfSpacing.sm,
                    ),
                    child: Semantics(
                      liveRegion: true,
                      child: Text(
                        _message!,
                        style: HfText.bodyStrong.copyWith(
                          fontSize: 15,
                          color: _messageIsError
                              ? HfColors.blushLight
                              : HfColors.white,
                        ),
                        textAlign: TextAlign.center,
                      ),
                    ),
                  ),
                LayoutBuilder(
                  builder: (context, c) {
                    final stacked =
                        c.maxWidth < 300 ||
                        MediaQuery.textScalerOf(context).scale(16) > 21;
                    if (!showPrice) {
                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          pill,
                          for (final w in extra) ...[
                            const SizedBox(height: HfSpacing.sm),
                            w,
                          ],
                        ],
                      );
                    }
                    if (stacked) {
                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: HfSpacing.lg,
                            ),
                            child: price,
                          ),
                          const SizedBox(height: HfSpacing.md),
                          pill,
                        ],
                      );
                    }
                    return Row(
                      crossAxisAlignment: CrossAxisAlignment.center,
                      children: [
                        Expanded(
                          child: Padding(
                            padding: const EdgeInsets.only(left: HfSpacing.lg),
                            child: price,
                          ),
                        ),
                        const SizedBox(width: HfSpacing.md),
                        Flexible(child: pill),
                      ],
                    );
                  },
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// "₹20 /min" and under it "10 min ≈ ₹200" (or, signed in on token mode, the server's own "about 8 min" line).
class _PriceBlock extends StatelessWidget {
  const _PriceBlock({required this.priceLabel, this.about});

  final String priceLabel;
  final String? about;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          priceLabel,
          style: HfText.stat.copyWith(
            fontSize: 21,
            height: 1.1,
            color: HfColors.white,
          ),
        ),
        Text(
          about ?? HostProfileStrings.sameRate,
          style: HfText.note.copyWith(fontSize: 14, color: HfColors.mutedSoft),
        ),
      ],
    );
  }
}

/// The white pill on the ink bar (56 tall, radius 22). Disabled when [onPressed] is null.
class _BarPill extends StatelessWidget {
  const _BarPill({
    required this.label,
    required this.onPressed,
    this.icon,
    this.loading = false,
    this.outlined = false,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final bool loading;
  final bool outlined;

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null && !loading;
    final fg = outlined ? HfColors.white : HfColors.ink;
    final bg = outlined
        ? Colors.transparent
        : (onPressed == null && !loading
              ? HfColors.white.withValues(alpha: 0.5)
              : HfColors.white);
    return Material(
      color: bg,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(HfRadius.tile),
        side: outlined
            ? const BorderSide(color: HfColors.white, width: 2)
            : BorderSide.none,
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(HfRadius.tile),
        onTap: enabled ? onPressed : null,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 56),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: 24,
              vertical: HfSpacing.md,
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                if (loading)
                  SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(
                      strokeWidth: 2.5,
                      color: fg,
                    ),
                  )
                else ...[
                  if (icon != null) ...[
                    Icon(icon, size: 18, color: fg),
                    const SizedBox(width: HfSpacing.md),
                  ],
                  Flexible(
                    child: Text(
                      label,
                      textAlign: TextAlign.center,
                      style: HfText.button.copyWith(color: fg),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

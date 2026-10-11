import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_error.dart';
import '../../../core/config/flags.dart';
import '../../../core/format/money.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/router/pending_intent.dart';
import '../../../core/strings.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../../demo/demo_data.dart'; // [HF-DEMO] remove with lib/features/demo
import '../data/call_api.dart';
import '../data/call_models.dart';
import '../data/call_telemetry.dart';
import 'call_avatar.dart';

/// Opens the call confirm sheet for a host (spec section 2.8, mockup `CallSheet`). The Host profile and the host
/// cards call this:
///
/// ```dart
/// onPressed: () => showCallConfirmSheet(context, ref, slug: host.slug, hostName: host.displayName);
/// ```
/// Signed-out people are sent to sign-in first and come back to the same screen. [lane] is `'lgbtq'` only when
/// the person came from the LGBTQ+ tab; women-lane hosts are lane-set by the server. [presence] and [photoUrl]
/// are optional: when the caller knows them the host strip shows the status line and the photo.
///
/// When the call starts the sheet closes and the call screen (`/call/:id`) opens. Errors stay in the sheet with
/// the right next step (Wallet, lane verification, Notify me, sign-in, Try again).
Future<void> showCallConfirmSheet(
  BuildContext context,
  WidgetRef ref, {
  required String slug,
  required String hostName,
  String? lane,
  HfPresence? presence,
  String? photoUrl,
}) async {
  if (!await requireSignIn(
    context,
    ref,
    next: Routes.callConfirmOf(slug, lane: lane),
  )) {
    return;
  }
  if (!context.mounted) return;
  final router = GoRouter.of(context);
  final outcome = await showHfSheet<CallSheetOutcome>(
    context,
    initialSize: 0.92,
    minSize: 0.5,
    maxSize: 0.95,
    builder: (sheetContext) => CallConfirmSheet(
      slug: slug,
      hostName: hostName,
      lane: lane,
      presence: presence,
      photoUrl: photoUrl,
      showHandle: false,
      onOutcome: (o) => Navigator.of(sheetContext).pop(o),
    ),
  );
  if (outcome == null) {
    await ref.read(pendingIntentProvider).clear();
    return;
  }
  await handleCallSheetOutcome(router, outcome);
}

/// Does what the sheet asked for. [replace] swaps the current page for the call screen (the confirm page
/// `/call/new` is replaced by `/call/<id>`, so Back from the call goes to the host).
Future<void> handleCallSheetOutcome(
  GoRouter router,
  CallSheetOutcome outcome, {
  bool replace = false,
}) async {
  switch (outcome.action) {
    case CallSheetAction.close:
      break;
    case CallSheetAction.started:
    case CallSheetAction.openCall:
      final id = outcome.value;
      if (id == null) break;
      if (replace) {
        await router.pushReplacement(Routes.callOf(id));
      } else {
        await router.push(Routes.callOf(id));
      }
    case CallSheetAction.wallet:
      router.go(
        outcome.next == null
            ? Routes.wallet
            : Routes.walletWithNext(outcome.next!),
      );
    case CallSheetAction.lane:
      await router.push(Routes.lanesOf(outcome.value, next: outcome.next));
    case CallSheetAction.signIn:
      await router.push(Routes.signInTo(outcome.next));
  }
}

enum CallSheetAction { close, started, openCall, wallet, lane, signIn }

/// What the sheet asks its host to do next. [value] is the call id, or the lane.
class CallSheetOutcome {
  const CallSheetOutcome(this.action, [this.value, this.next]);

  final CallSheetAction action;
  final String? value;
  final String? next;
}

/// The body of the confirm sheet: host strip, rate and wallet tiles, the three steps, the slide to call and the
/// 2-minute note. It never decides navigation itself; it reports a [CallSheetOutcome] (so tests can pump it
/// directly).
class CallConfirmSheet extends ConsumerStatefulWidget {
  const CallConfirmSheet({
    super.key,
    required this.slug,
    required this.hostName,
    required this.onOutcome,
    this.lane,
    this.showHandle = true,
    this.presence,
    this.photoUrl,
  });

  final String slug;
  final String hostName;
  final String? lane;

  /// The little grab bar at the top (a bottom sheet has one, a full page does not).
  final bool showHandle;

  /// The host's presence for the status line under the name (omitted when null).
  final HfPresence? presence;
  final String? photoUrl;
  final void Function(CallSheetOutcome outcome) onOutcome;

  @override
  ConsumerState<CallConfirmSheet> createState() => _CallConfirmSheetState();
}

class _CallConfirmSheetState extends ConsumerState<CallConfirmSheet> {
  static const SizedBox _gap = SizedBox(height: HfSpacing.xxl);

  bool _starting = false;
  CallStartProblem? _problem;
  bool _notifying = false;
  String? _notifyMessage;

  Future<void> _emit(CallSheetOutcome outcome) async {
    final next = Routes.callConfirmOf(widget.slug, lane: widget.lane);
    if ({
      CallSheetAction.wallet,
      CallSheetAction.lane,
      CallSheetAction.signIn,
    }.contains(outcome.action)) {
      await ref.read(pendingIntentProvider).save(next);
    } else {
      await ref.read(pendingIntentProvider).clear();
    }
    if (mounted) {
      widget.onOutcome(CallSheetOutcome(outcome.action, outcome.value, next));
    }
  }

  String get _firstName {
    final n = widget.hostName.trim();
    return n.isEmpty ? 'your host' : n.split(RegExp(r'\s+')).first;
  }

  Future<void> _start() async {
    if (_starting) return;
    setState(() {
      _starting = true;
      _problem = null;
      _notifyMessage = null;
    });
    // [HF-DEMO] remove with lib/features/demo: pretend to start, no request, no saved call id.
    if (isDemoSlug(widget.slug)) {
      demoStep('started');
      await Future<void>.delayed(const Duration(milliseconds: 450));
      if (!mounted) return;
      unawaited(
        _emit(const CallSheetOutcome(CallSheetAction.started, kDemoCallId)),
      );
      return;
    }
    final sw = Stopwatch()..start();
    try {
      final started = await ref
          .read(callApiProvider)
          .start(widget.slug, lane: widget.lane);
      CallTelemetry.started(
        slug: widget.slug,
        ok: true,
        ms: sw.elapsedMilliseconds,
        mode: started.isTokens ? 'tokens' : 'inr',
      );
      // Remembered before the screen opens, so killing the app right now still resumes the call.
      await ref.read(activeCallStoreProvider).save(started.callId);
      if (!mounted) return;
      unawaited(
        _emit(CallSheetOutcome(CallSheetAction.started, started.callId)),
      );
    } on ApiError catch (e) {
      CallTelemetry.started(
        slug: widget.slug,
        ok: false,
        reason: e.code,
        httpStatus: e.status,
        ms: sw.elapsedMilliseconds,
      );
      if (!mounted) return;
      setState(() {
        _starting = false;
        _problem = CallStartProblem.fromError(e);
      });
    }
  }

  Future<void> _resumeExisting() async {
    final id = await ref.read(activeCallStoreProvider).read();
    if (!mounted) return;
    if (id != null) {
      unawaited(_emit(CallSheetOutcome(CallSheetAction.openCall, id)));
    }
  }

  Future<void> _notify() async {
    if (_notifying) return;
    setState(() {
      _notifying = true;
      _notifyMessage = null;
    });
    try {
      await ref.read(callApiProvider).notifyMe(widget.slug);
      if (!mounted) return;
      setState(() {
        _notifying = false;
        _notifyMessage = "We'll WhatsApp you when $_firstName is free.";
      });
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _notifying = false;
        _notifyMessage = e.userMessage;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final demo = isDemoSlug(
      widget.slug,
    ); // [HF-DEMO] remove with lib/features/demo
    final callsOn =
        demo ||
        ref
            .watch(flagsProvider)
            .when(
              data: (f) => f.hfCallsEnabled,
              loading: () => true,
              error: (_, __) => true,
            );
    final estimate = demo
        ? const AsyncData<CallEstimate>(
            kDemoEstimate,
          ) // [HF-DEMO] remove with lib/features/demo
        : ref.watch(callEstimateProvider(widget.slug));
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    final display = widget.hostName.trim().isEmpty
        ? 'your host'
        : widget.hostName.trim();

    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(
        HfSpacing.pageWide,
        0,
        HfSpacing.pageWide,
        30 + bottomInset,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (widget.showHandle)
            SizedBox(
              height: 26,
              child: Center(
                child: Container(
                  width: 44,
                  height: 5,
                  decoration: BoxDecoration(
                    color: HfBrightness.isDark(context)
                        ? HfColors.darkSelected
                        : HfColors.handle,
                    borderRadius: BorderRadius.circular(3),
                  ),
                ),
              ),
            ),
          _HostStrip(
            name: display,
            presence:
                widget.presence ??
                (demo
                    ? HfPresence.online
                    : null), // [HF-DEMO] remove with lib/features/demo
            photoUrl:
                widget.photoUrl ??
                (demo
                    ? demoAvatarFor(widget.slug)
                    : null), // [HF-DEMO] remove with lib/features/demo
          ),
          _gap,
          if (!callsOn)
            const ComingSoonPanelInline(title: CallStrings.callsOpenSoon)
          else
            estimate.when(
              loading: () => const _SheetSkeleton(),
              error: (e, _) => _EstimateError(
                error: e,
                onRetry: () =>
                    ref.invalidate(callEstimateProvider(widget.slug)),
              ),
              data: _body,
            ),
        ],
      ),
    );
  }

  /// "about 17 min" from the estimate (whole minutes the balance pays for).
  String _aboutMinutes(CallEstimate est) {
    if (!est.canStart || est.hasDebt) return CallStrings.addMoneyToCall;
    final s = est.affordableSeconds;
    if (s != null && s >= 60) return 'about ${s ~/ 60} min';
    if (s != null && s > 0) return 'under 1 min';
    final about = est.aboutText;
    if (about != null && about.startsWith('about')) return about;
    return CallStrings.addMoneyToCall;
  }

  Widget _body(CallEstimate est) {
    final problem = _problem;
    final walletAmount = est.balance == null
        ? null
        : num.tryParse(est.balance!);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Tiles(
          rate: '${Money.rupees(est.ratePerMinRupees)}/min',
          walletCaption: walletAmount == null
              ? CallStrings.yourWalletPlain
              : CallStrings.yourWalletAmount(
                  Money.tokensWithUnit(walletAmount),
                ),
          walletValue: est.isTokens ? _aboutMinutes(est) : null,
        ),
        _gap,
        _Steps(name: _firstName),
        _gap,
        if (est.hasDebt)
          _Warning(
            text: 'Please clear the amount owed before calling.',
            actionLabel: CallStrings.clearWhatYouOwe,
            onAction: () =>
                _emit(const CallSheetOutcome(CallSheetAction.wallet)),
          )
        else if (!est.canStart)
          _Warning(
            text:
                'You need at least 2 minutes of balance to start. Add money to call.',
            actionLabel: CallStrings.addTokens,
            onAction: () =>
                _emit(const CallSheetOutcome(CallSheetAction.wallet)),
          )
        else ...[
          if (problem != null) ...[
            _ProblemCard(
              problem: problem,
              hostFirstName: _firstName,
              notifyMessage: _notifyMessage,
              notifying: _notifying,
              onNotify: _notify,
              onResume: _resumeExisting,
              onOutcome: _emit,
            ),
            const SizedBox(height: HfSpacing.lg),
          ],
          if (problem == null)
            _SlideToCall(name: _firstName, starting: _starting, onStart: _start)
          else if (problem.kind == CallProblemKind.retry)
            HfButton(
              label: Strings.tryAgain,
              icon: Icons.call_rounded,
              loading: _starting,
              onPressed: _start,
            ),
        ],
        const SizedBox(height: HfSpacing.sm),
        Text(
          CallStrings.minBalanceNote,
          textAlign: TextAlign.center,
          style: HfText.of(context, HfText.note.copyWith(fontSize: 14)),
        ),
        const SizedBox(height: HfSpacing.sm),
        // The crisis line stays on the confirm step (owner safety rule), as a quiet note.
        Text(
          CallStrings.safetyNotice,
          textAlign: TextAlign.center,
          style: HfText.of(context, HfText.note.copyWith(fontSize: 14)),
        ),
      ],
    );
  }
}

/// 64 px avatar (radius 22), "Call {name}" and the status line.
class _HostStrip extends StatelessWidget {
  const _HostStrip({
    required this.name,
    required this.presence,
    required this.photoUrl,
  });

  final String name;
  final HfPresence? presence;
  final String? photoUrl;

  @override
  Widget build(BuildContext context) {
    final p = presence;
    return Row(
      children: [
        HfCallAvatar(
          name: name == 'your host' ? '' : name,
          size: 64,
          radius: HfRadius.tile,
          photoUrl: photoUrl,
        ),
        const SizedBox(width: HfSpacing.xl),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Semantics(
                header: true,
                child: Text(
                  'Call $name',
                  style: HfText.of(context, HfText.title),
                ),
              ),
              if (p != null) ...[
                const SizedBox(height: 2),
                _PresenceLine(presence: p),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class _PresenceLine extends StatelessWidget {
  const _PresenceLine({required this.presence});

  final HfPresence presence;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final Color dot;
    final Color text;
    switch (presence) {
      case HfPresence.online:
        dot = dark ? HfColors.blushDot : HfColors.roseDot;
        text = dark ? HfColors.blushLight : HfColors.blushDeep;
      case HfPresence.busy:
        dot = HfColors.amberDot;
        text = dark ? HfColors.star : HfColors.butterDeep;
      case HfPresence.offline:
      case HfPresence.away:
        dot = HfColors.mutedSoft;
        text = dark ? HfColors.mutedSoft : HfColors.muted;
    }
    return Row(
      children: [
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
        ),
        const SizedBox(width: HfSpacing.xs),
        Flexible(
          child: Text(
            presence.label,
            style: HfText.badge.copyWith(color: text),
          ),
        ),
      ],
    );
  }
}

/// Rate (surfaceSoft) and wallet (butter) tiles, side by side. Without a wallet value (old rupee mode) only
/// the rate tile shows.
class _Tiles extends StatelessWidget {
  const _Tiles({
    required this.rate,
    required this.walletCaption,
    required this.walletValue,
  });

  final String rate;
  final String walletCaption;
  final String? walletValue;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final rateTile = _Tile(
      bg: dark ? HfColors.darkBar : HfColors.surfaceSoft,
      caption: CallStrings.rateLabel,
      captionColor: dark ? HfColors.mutedSoft : HfColors.muted,
      value: rate,
      valueColor: dark ? HfColors.darkText : HfColors.ink,
    );
    final wv = walletValue;
    if (wv == null) return rateTile;
    const butter = HfTint.butter;
    final walletTile = _Tile(
      bg: butter.bg(context),
      caption: walletCaption,
      captionColor: dark ? HfColors.star : HfColors.butterInk,
      value: wv,
      valueColor: butter.valueInk(context),
    );
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(child: rateTile),
          const SizedBox(width: HfSpacing.md),
          Expanded(child: walletTile),
        ],
      ),
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({
    required this.bg,
    required this.caption,
    required this.captionColor,
    required this.value,
    required this.valueColor,
  });

  final Color bg;
  final String caption;
  final Color captionColor;
  final String value;
  final Color valueColor;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(HfSpacing.xl),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(HfRadius.control),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            caption,
            style: HfText.badge.copyWith(
              fontWeight: FontWeight.w400,
              color: captionColor,
            ),
          ),
          const SizedBox(height: 4),
          Text(value, style: HfText.stat.copyWith(color: valueColor)),
        ],
      ),
    );
  }
}

/// The three numbered steps (sky / peach / blush circles).
class _Steps extends StatelessWidget {
  const _Steps({required this.name});

  final String name;

  @override
  Widget build(BuildContext context) {
    final base = HfText.of(
      context,
      HfText.body.copyWith(fontSize: 15, height: 1.4),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Step(
          n: 1,
          tint: HfTint.sky,
          child: Text(CallStrings.stepRingFirst(name), style: base),
        ),
        const SizedBox(height: HfSpacing.lg),
        _Step(
          n: 2,
          tint: HfTint.peach,
          child: Text.rich(
            TextSpan(
              style: base,
              children: [
                const TextSpan(text: CallStrings.stepPhoneLead),
                TextSpan(
                  text: CallStrings.stepPhoneBold,
                  style: base.copyWith(fontWeight: FontWeight.w700),
                ),
                const TextSpan(text: CallStrings.stepPhoneTail),
              ],
            ),
          ),
        ),
        const SizedBox(height: HfSpacing.lg),
        _Step(
          n: 3,
          tint: HfTint.blush,
          child: Text(CallStrings.stepEnd, style: base),
        ),
      ],
    );
  }
}

class _Step extends StatelessWidget {
  const _Step({required this.n, required this.tint, required this.child});

  final int n;
  final HfTint tint;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          width: 32,
          height: 32,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: tint.bg(context),
            shape: BoxShape.circle,
          ),
          child: Text(
            '$n',
            style: HfText.badge.copyWith(color: tint.valueInk(context)),
          ),
        ),
        const SizedBox(width: HfSpacing.lg),
        Expanded(child: child),
      ],
    );
  }
}

/// The ink slide track. While the start request is in flight the knob turns into a spinner and the track is
/// inert, so a second start cannot be sent.
class _SlideToCall extends StatelessWidget {
  const _SlideToCall({
    required this.name,
    required this.starting,
    required this.onStart,
  });

  final String name;
  final bool starting;
  final VoidCallback onStart;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    return Stack(
      children: [
        HfSlideToConfirm(
          label: CallStrings.slideToCall(name),
          icon: Icons.call_rounded,
          onConfirm: onStart,
          fallbackLabel: CallStrings.orTapToCall,
          onFallback: onStart,
          enabled: !starting,
        ),
        if (starting)
          Positioned(
            left: 6,
            top: 6,
            child: IgnorePointer(
              child: Container(
                width: 56,
                height: 56,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: dark ? HfColors.lavender : HfColors.white,
                  shape: BoxShape.circle,
                  boxShadow: HfShadows.knob,
                ),
                child: const SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(
                    strokeWidth: 2.5,
                    color: HfColors.ink,
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

/// Placeholder with the shape of the loaded sheet: two tiles, three steps, the slide track.
class _SheetSkeleton extends StatelessWidget {
  const _SheetSkeleton();

  @override
  Widget build(BuildContext context) {
    return const Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: HfSkeleton.box(height: 76, radius: HfRadius.control),
            ),
            SizedBox(width: HfSpacing.md),
            Expanded(
              child: HfSkeleton.box(height: 76, radius: HfRadius.control),
            ),
          ],
        ),
        SizedBox(height: HfSpacing.xxl),
        HfSkeleton.box(height: 32, radius: 16),
        SizedBox(height: HfSpacing.lg),
        HfSkeleton.box(height: 32, radius: 16),
        SizedBox(height: HfSpacing.lg),
        HfSkeleton.box(height: 32, radius: 16),
        SizedBox(height: HfSpacing.xxl),
        HfSkeleton.box(height: 68, radius: 34),
      ],
    );
  }
}

class _Warning extends StatelessWidget {
  const _Warning({
    required this.text,
    required this.actionLabel,
    required this.onAction,
  });

  final String text;
  final String actionLabel;
  final VoidCallback onAction;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Notice(text: text),
        const SizedBox(height: HfSpacing.lg),
        HfButton(
          label: actionLabel,
          icon: Icons.account_balance_wallet_rounded,
          onPressed: onAction,
        ),
      ],
    );
  }
}

/// A blush message box (problems and warnings).
class _Notice extends StatelessWidget {
  const _Notice({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      child: Container(
        padding: const EdgeInsets.all(HfSpacing.xl),
        decoration: BoxDecoration(
          color: HfTint.blush.bg(context),
          borderRadius: BorderRadius.circular(HfRadius.tile),
        ),
        child: Text(
          text,
          style: HfText.bodyStrong.copyWith(
            color: HfTint.blush.valueInk(context),
          ),
        ),
      ),
    );
  }
}

class _ProblemCard extends StatelessWidget {
  const _ProblemCard({
    required this.problem,
    required this.hostFirstName,
    required this.notifyMessage,
    required this.notifying,
    required this.onNotify,
    required this.onResume,
    required this.onOutcome,
  });

  final CallStartProblem problem;
  final String hostFirstName;
  final String? notifyMessage;
  final bool notifying;
  final VoidCallback onNotify;
  final VoidCallback onResume;
  final void Function(CallSheetOutcome) onOutcome;

  @override
  Widget build(BuildContext context) {
    Widget? action;
    switch (problem.kind) {
      case CallProblemKind.hostUnavailable:
        action = HfButton(
          label: CallStrings.notifyMe,
          icon: Icons.notifications_active_rounded,
          loading: notifying,
          onPressed: onNotify,
        );
      case CallProblemKind.callInProgress:
        action = HfButton(
          label: CallStrings.goToMyCall,
          icon: Icons.call_rounded,
          onPressed: onResume,
        );
      case CallProblemKind.signIn:
        action = HfButton(
          label: CallStrings.signInAgain,
          onPressed: () =>
              onOutcome(const CallSheetOutcome(CallSheetAction.signIn)),
        );
      case CallProblemKind.lane:
        action = HfButton(
          label: CallStrings.verifyToCall,
          onPressed: () =>
              onOutcome(CallSheetOutcome(CallSheetAction.lane, problem.lane)),
        );
      case CallProblemKind.wallet:
        action = HfButton(
          label: CallStrings.addTokens,
          icon: Icons.account_balance_wallet_rounded,
          onPressed: () =>
              onOutcome(const CallSheetOutcome(CallSheetAction.wallet)),
        );
      case CallProblemKind.debt:
        action = HfButton(
          label: CallStrings.clearWhatYouOwe,
          icon: Icons.account_balance_wallet_rounded,
          onPressed: () =>
              onOutcome(const CallSheetOutcome(CallSheetAction.wallet)),
        );
      case CallProblemKind.comingSoon:
      case CallProblemKind.retry:
      case CallProblemKind.message:
        action = null;
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Notice(text: problem.message),
        if (notifyMessage != null) ...[
          const SizedBox(height: HfSpacing.sm),
          Text(notifyMessage!, style: HfText.of(context, HfText.note)),
        ],
        if (action != null) ...[const SizedBox(height: HfSpacing.lg), action],
      ],
    );
  }
}

class _EstimateError extends StatelessWidget {
  const _EstimateError({required this.error, required this.onRetry});

  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final e = error;
    if (e is ApiError && e.isNotEnabled) {
      return const ComingSoonPanelInline(title: CallStrings.callsOpenSoon);
    }
    // Not ErrorPanel: that one is built to fill a screen and cannot sit inside a scrolling sheet.
    final text = e is ApiError ? e.userMessage : Strings.somethingWrong;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Notice(text: text),
        const SizedBox(height: HfSpacing.lg),
        HfButton(label: Strings.tryAgain, onPressed: onRetry),
      ],
    );
  }
}

/// A short "Coming soon" block for inside a sheet (the full-page [ComingSoonPanel] is built to fill a screen).
class ComingSoonPanelInline extends StatelessWidget {
  const ComingSoonPanelInline({super.key, required this.title});

  final String title;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(HfSpacing.page),
      decoration: BoxDecoration(
        color: HfTint.lavender.bg(context),
        borderRadius: BorderRadius.circular(HfRadius.tile),
      ),
      child: Column(
        children: [
          Text(
            title,
            style: HfText.of(context, HfText.subsection),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: HfSpacing.xs),
          Text(
            Strings.comingSoonBody,
            style: HfText.of(context, HfText.body),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }
}

/// The safety reminder: a normal phone call, in crisis dial 14416, press # to end and block. Used on the live
/// call screen as a quiet note.
class CallSafetyCard extends StatelessWidget {
  const CallSafetyCard({super.key});

  @override
  Widget build(BuildContext context) {
    return Text(
      CallStrings.safetyNotice,
      textAlign: TextAlign.center,
      style: HfText.of(context, HfText.note.copyWith(fontSize: 14)),
    );
  }
}

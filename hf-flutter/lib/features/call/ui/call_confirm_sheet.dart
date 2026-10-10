import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_error.dart';
import '../../../core/config/flags.dart';
import '../../../core/format/money.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/strings.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../data/call_api.dart';
import '../data/call_models.dart';
import '../data/call_telemetry.dart';

/// Opens the call confirm sheet for a host (spec section 2.8). The Host profile and the host cards call this:
///
/// ```dart
/// onPressed: () => showCallConfirmSheet(context, ref, slug: host.slug, hostName: host.displayName);
/// ```
/// Signed-out people are sent to sign-in first and come back to the same screen. [lane] is `'lgbtq'` only when
/// the person came from the LGBTQ+ tab; women-lane hosts are lane-set by the server.
///
/// When the call starts the sheet closes and the call screen (`/call/:id`) opens. Errors stay in the sheet with
/// the right next step (Wallet, lane verification, Notify me, sign-in, Try again).
Future<void> showCallConfirmSheet(
  BuildContext context,
  WidgetRef ref, {
  required String slug,
  required String hostName,
  String? lane,
}) async {
  if (!await requireSignIn(context, ref)) return;
  if (!context.mounted) return;
  final router = GoRouter.of(context);
  final outcome = await showModalBottomSheet<CallSheetOutcome>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: HfColors.cream,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(HfRadius.card + 6)),
    ),
    builder: (sheetContext) => CallConfirmSheet(
      slug: slug,
      hostName: hostName,
      lane: lane,
      onOutcome: (o) => Navigator.of(sheetContext).pop(o),
    ),
  );
  if (outcome == null) return;
  await handleCallSheetOutcome(router, outcome);
}

/// Does what the sheet asked for. [replace] swaps the current page for the call screen (the confirm page
/// `/call/new` is replaced by `/call/<id>`, so Back from the call goes to the host).
Future<void> handleCallSheetOutcome(GoRouter router, CallSheetOutcome outcome, {bool replace = false}) async {
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
      router.go(Routes.wallet);
    case CallSheetAction.lane:
      await router.push(Routes.lanesOf(outcome.value));
    case CallSheetAction.signIn:
      await router.push(Routes.signIn);
  }
}

enum CallSheetAction { close, started, openCall, wallet, lane, signIn }

/// What the sheet asks its host to do next. [value] is the call id, or the lane.
class CallSheetOutcome {
  const CallSheetOutcome(this.action, [this.value]);

  final CallSheetAction action;
  final String? value;
}

/// The body of the confirm sheet: host, price, estimate, the 2-minute rule, the safety reminder and Start call.
/// It never decides navigation itself; it reports a [CallSheetOutcome] (so tests can pump it directly).
class CallConfirmSheet extends ConsumerStatefulWidget {
  const CallConfirmSheet({
    super.key,
    required this.slug,
    required this.hostName,
    required this.onOutcome,
    this.lane,
    this.showHandle = true,
  });

  final String slug;
  final String hostName;
  final String? lane;

  /// The little grab bar at the top (a bottom sheet has one, a full page does not).
  final bool showHandle;
  final void Function(CallSheetOutcome outcome) onOutcome;

  @override
  ConsumerState<CallConfirmSheet> createState() => _CallConfirmSheetState();
}

class _CallConfirmSheetState extends ConsumerState<CallConfirmSheet> {
  bool _starting = false;
  CallStartProblem? _problem;
  bool _notifying = false;
  String? _notifyMessage;

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
    final sw = Stopwatch()..start();
    try {
      final started = await ref.read(callApiProvider).start(widget.slug, lane: widget.lane);
      CallTelemetry.started(
          slug: widget.slug, ok: true, ms: sw.elapsedMilliseconds, mode: started.isTokens ? 'tokens' : 'inr');
      // Remembered before the screen opens, so killing the app right now still resumes the call.
      await ref.read(activeCallStoreProvider).save(started.callId);
      if (!mounted) return;
      widget.onOutcome(CallSheetOutcome(CallSheetAction.started, started.callId));
    } on ApiError catch (e) {
      CallTelemetry.started(
          slug: widget.slug, ok: false, reason: e.code, httpStatus: e.status, ms: sw.elapsedMilliseconds);
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
    if (id != null) widget.onOutcome(CallSheetOutcome(CallSheetAction.openCall, id));
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
    final callsOn = ref.watch(flagsProvider).when(
          data: (f) => f.hfCallsEnabled,
          loading: () => true,
          error: (_, __) => true,
        );
    final estimate = ref.watch(callEstimateProvider(widget.slug));
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;

    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(HfSpacing.page, 12, HfSpacing.page, HfSpacing.page + bottomInset),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (widget.showHandle) ...[
            Center(
              child: Container(
                width: 44,
                height: 5,
                decoration: BoxDecoration(color: HfColors.line, borderRadius: BorderRadius.circular(3)),
              ),
            ),
            const SizedBox(height: 16),
          ],
          Text('Call ${widget.hostName.trim().isEmpty ? 'your host' : widget.hostName.trim()}', style: HfText.headline),
          const SizedBox(height: 16),
          if (!callsOn)
            const ComingSoonPanelInline(title: CallStrings.callsOpenSoon)
          else
            estimate.when(
              loading: () => const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: LoadingPanel(message: 'Checking the price…'),
              ),
              error: (e, _) => _EstimateError(
                error: e,
                onRetry: () => ref.invalidate(callEstimateProvider(widget.slug)),
              ),
              data: _body,
            ),
          const SizedBox(height: 8),
          HfButton(
            label: CallStrings.notNow,
            kind: HfButtonKind.text,
            onPressed: () => widget.onOutcome(const CallSheetOutcome(CallSheetAction.close)),
          ),
        ],
      ),
    );
  }

  Widget _body(CallEstimate est) {
    final problem = _problem;
    final about = est.aboutText;
    final showAbout = est.isTokens && about != null && about.startsWith('about');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        HfCard(
          color: HfColors.lilac,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('${Money.rupees(est.ratePerMinRupees)}/min', style: HfText.hero),
              if (est.isTokens && est.tokensPerMinute != null) ...[
                const SizedBox(height: 4),
                Text('${est.tokensPerMinute} tokens/min', style: HfText.subtitle),
              ],
              const SizedBox(height: 8),
              Text(
                est.isTokens
                    ? 'Billed per second. ${CallStrings.ringingNoCharge}'
                    : 'Billed per started minute. ${CallStrings.ringingNoCharge}',
                style: HfText.note,
              ),
              if (showAbout) ...[
                const SizedBox(height: 12),
                Text('Estimate: $about with your balance', style: HfText.bodyStrong),
              ],
            ],
          ),
        ),
        const SizedBox(height: 12),
        const _Fact(icon: Icons.timer_outlined, text: CallStrings.twoMinuteRule),
        const SizedBox(height: 8),
        const _Fact(icon: Icons.phone_in_talk_rounded, text: CallStrings.phoneRings),
        const SizedBox(height: 12),
        const CallSafetyCard(),
        const SizedBox(height: 16),
        if (est.hasDebt)
          _Warning(
            text: 'Please clear the amount owed before calling.',
            actionLabel: CallStrings.clearWhatYouOwe,
            onAction: () => widget.onOutcome(const CallSheetOutcome(CallSheetAction.wallet)),
          )
        else if (!est.canStart)
          _Warning(
            text: 'You need at least 2 minutes of balance to start. Add tokens to call.',
            actionLabel: CallStrings.addTokens,
            onAction: () => widget.onOutcome(const CallSheetOutcome(CallSheetAction.wallet)),
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
              onOutcome: widget.onOutcome,
            ),
            const SizedBox(height: 12),
          ],
          if (problem == null || problem.kind == CallProblemKind.retry)
            HfButton(
              label: problem == null ? CallStrings.startCall : Strings.tryAgain,
              icon: Icons.call_rounded,
              loading: _starting,
              onPressed: _start,
            ),
        ],
      ],
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 24, color: HfColors.orchid),
        const SizedBox(width: 12),
        Expanded(child: Text(text, style: HfText.bodyText)),
      ],
    );
  }
}

/// The safety reminder: a normal phone call, in crisis dial 14416, press # to end and block.
class CallSafetyCard extends StatelessWidget {
  const CallSafetyCard({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: HfColors.butter,
        borderRadius: BorderRadius.circular(HfRadius.card),
        border: Border.all(color: HfColors.butterDeep),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.shield_outlined, size: 24, color: HfColors.plum),
          const SizedBox(width: 12),
          const Expanded(child: Text(CallStrings.safetyNotice, style: HfText.bodyText)),
        ],
      ),
    );
  }
}

class _Warning extends StatelessWidget {
  const _Warning({required this.text, required this.actionLabel, required this.onAction});

  final String text;
  final String actionLabel;
  final VoidCallback onAction;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: HfColors.blush,
            borderRadius: BorderRadius.circular(HfRadius.card),
          ),
          child: Text(text, style: HfText.bodyStrong),
        ),
        const SizedBox(height: 12),
        HfButton(label: actionLabel, icon: Icons.account_balance_wallet_rounded, onPressed: onAction),
      ],
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
        action = HfButton(label: CallStrings.goToMyCall, icon: Icons.call_rounded, onPressed: onResume);
      case CallProblemKind.signIn:
        action = HfButton(
          label: CallStrings.signInAgain,
          onPressed: () => onOutcome(const CallSheetOutcome(CallSheetAction.signIn)),
        );
      case CallProblemKind.lane:
        action = HfButton(
          label: CallStrings.verifyToCall,
          onPressed: () => onOutcome(CallSheetOutcome(CallSheetAction.lane, problem.lane)),
        );
      case CallProblemKind.wallet:
        action = HfButton(
          label: CallStrings.addTokens,
          icon: Icons.account_balance_wallet_rounded,
          onPressed: () => onOutcome(const CallSheetOutcome(CallSheetAction.wallet)),
        );
      case CallProblemKind.debt:
        action = HfButton(
          label: CallStrings.clearWhatYouOwe,
          icon: Icons.account_balance_wallet_rounded,
          onPressed: () => onOutcome(const CallSheetOutcome(CallSheetAction.wallet)),
        );
      case CallProblemKind.comingSoon:
      case CallProblemKind.retry:
      case CallProblemKind.message:
        action = null;
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          liveRegion: true,
          child: Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: HfColors.blush,
              borderRadius: BorderRadius.circular(HfRadius.card),
            ),
            child: Text(problem.message, style: HfText.bodyStrong),
          ),
        ),
        if (notifyMessage != null) ...[
          const SizedBox(height: 8),
          Text(notifyMessage!, style: HfText.note),
        ],
        if (action != null) ...[
          const SizedBox(height: 12),
          action,
        ],
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
    if (e is ApiError && e.isNotEnabled) return const ComingSoonPanelInline(title: CallStrings.callsOpenSoon);
    // Not ErrorPanel: that one is built to fill a screen and cannot sit inside a scrolling sheet.
    final text = e is ApiError ? e.userMessage : Strings.somethingWrong;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          liveRegion: true,
          child: Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(color: HfColors.blush, borderRadius: BorderRadius.circular(HfRadius.card)),
            child: Text(text, style: HfText.bodyStrong),
          ),
        ),
        const SizedBox(height: 12),
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
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: HfColors.lilac, borderRadius: BorderRadius.circular(HfRadius.card)),
      child: Column(
        children: [
          Text(title, style: HfText.subtitle, textAlign: TextAlign.center),
          const SizedBox(height: 6),
          const Text(Strings.comingSoonBody, style: HfText.bodyText, textAlign: TextAlign.center),
        ],
      ),
    );
  }
}

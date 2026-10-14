import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_error.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/strings.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../data/call_api.dart';
import '../data/call_models.dart';
import '../data/call_telemetry.dart';
import 'call_confirm_page.dart';
import 'call_live_view.dart';
import 'call_summary.dart';

/// `/call/:id` (needs sign-in). Follows one call (spec section 2.8):
///
///  * "Your phone will ring in a few seconds" while the host is rung, then "{host} said yes. Your phone will
///    ring now", then Connected with a running clock.
///  * Polls `GET /api/hf/calls/:id` every 2 s while the screen is in the foreground. The dialer puts the app in
///    the background when the phone rings, so polling pauses there and polls again at once on resume.
///    Polling stops for good on a terminal status.
///  * Cancel is offered only before the call connects.
///  * The call id is kept on the phone ([ActiveCallStore]) until the call ends, so reopening the app resumes
///    this screen.
///  * When the call is over: summary (time, charge, why it ended) and Rate your call.
///
/// `/call/new?host=<slug>[&lane=lgbtq]` is the call confirm step (the host profile opens it): the same content as
/// the confirm sheet, as a page. When the call starts it is replaced by `/call/<id>`.
class CallScreen extends StatelessWidget {
  const CallScreen({super.key, required this.id});

  final String id;

  /// The id in `/call/new`: no call yet, only the confirm step.
  static const String newCallId = 'new';

  /// Poll interval (the contract says every 2 s).
  static const Duration pollEvery = Duration(seconds: 2);

  @override
  Widget build(BuildContext context) {
    return id == newCallId ? const CallConfirmPage() : CallFollower(id: id);
  }
}

/// Follows one running or finished call (see [CallScreen]).
class CallFollower extends ConsumerStatefulWidget {
  const CallFollower({super.key, required this.id});

  final String id;

  @override
  ConsumerState<CallFollower> createState() => _CallFollowerState();
}

class _CallFollowerState extends ConsumerState<CallFollower>
    with WidgetsBindingObserver {
  CallInfo? _info;
  ApiError? _fatal;
  int _failures = 0;
  bool _inFlight = false;
  bool _foreground = true;
  bool _cancelling = false;
  bool _ending = false;
  bool _cancelledByMe = false;
  bool _notifying = false;
  bool _notified = false;
  bool _reviewed = false;
  String? _notice;
  String? _notifyMessage;
  Timer? _pollTimer;
  Timer? _clockTimer;
  DateTime? _firstSeenConnected;
  CallStatus? _lastReported;
  bool _endedReported = false;

  bool get _terminal => _info?.status.isTerminal ?? false;
  bool get _shouldPoll =>
      mounted && _foreground && _fatal == null && !_terminal;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(ref.read(activeCallStoreProvider).save(widget.id));
    unawaited(_poll());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _pollTimer?.cancel();
    _clockTimer?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.resumed:
        _foreground = true;
        if (_shouldPoll) {
          _pollTimer?.cancel();
          unawaited(_poll());
        }
      case AppLifecycleState.hidden:
      case AppLifecycleState.paused:
        // The phone is ringing or the person left: no polling in the background.
        _foreground = false;
        _pollTimer?.cancel();
      case AppLifecycleState.inactive:
      case AppLifecycleState.detached:
        break;
    }
  }

  Future<void> _poll() async {
    if (_inFlight || !mounted) return;
    _inFlight = true;
    try {
      final info = await ref.read(callApiProvider).status(widget.id);
      if (mounted) {
        _failures = 0;
        _apply(info);
      }
    } on ApiError catch (e) {
      if (mounted) {
        if (e.status == 404 || e.code == 'not_found') {
          // The server does not know this call: forget it.
          unawaited(
            ref.read(activeCallStoreProvider).clear(onlyIfId: widget.id),
          );
          _stopTimers();
          setState(() => _fatal = e);
        } else {
          // A dropped connection or a hiccup: keep trying, and say so after a few misses.
          setState(() => _failures++);
        }
      }
    } finally {
      _inFlight = false;
    }
    if (_shouldPoll) _schedule();
  }

  void _schedule() {
    _pollTimer?.cancel();
    _pollTimer = Timer(CallScreen.pollEvery, () => unawaited(_poll()));
  }

  void _stopTimers() {
    _pollTimer?.cancel();
    _pollTimer = null;
    _clockTimer?.cancel();
    _clockTimer = null;
  }

  void _apply(CallInfo info) {
    if (info.status != _lastReported) {
      _lastReported = info.status;
      if (info.status == CallStatus.connected) HapticFeedback.mediumImpact();
      CallTelemetry.status(info.status.wire);
    }
    if (info.status == CallStatus.connected) {
      _firstSeenConnected ??= ref.read(callClockProvider)();
      _clockTimer ??= Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    }
    if (info.status.isTerminal) {
      _stopTimers();
      unawaited(ref.read(activeCallStoreProvider).clear(onlyIfId: widget.id));
      if (!_endedReported) {
        _endedReported = true;
        CallTelemetry.ended(
          seconds: info.talkedSeconds,
          endReason: info.endReason,
          status: info.status.wire,
          mode: info.isMeteredCall ? 'rupees' : 'inr',
        );
      }
    }
    setState(() {
      _info = info;
      _fatal = null;
    });
  }

  Future<void> _cancel() async {
    if (_cancelling) return;
    setState(() {
      _cancelling = true;
      _notice = null;
    });
    try {
      await ref.read(callApiProvider).cancel(widget.id);
      CallTelemetry.cancelled('ok');
      _cancelledByMe = true;
      if (!mounted) return;
      setState(() => _cancelling = false);
    } on ApiError catch (e) {
      if (e.code == 'already_connected') {
        CallTelemetry.cancelled('too_late');
      } else {
        CallTelemetry.cancelled('failed', reason: e.code);
      }
      if (!mounted) return;
      setState(() {
        _cancelling = false;
        _notice = e.code == 'already_connected'
            ? CallStrings.tooLateToCancel
            : CallStrings.cancelFailed;
      });
    }
    // Show what really happened now (ended, or connected after all).
    _pollTimer?.cancel();
    await _poll();
  }

  Future<void> _end() async {
    if (_ending) return;
    setState(() {
      _ending = true;
      _notice = null;
    });
    try {
      await ref.read(callApiProvider).end(widget.id);
      if (!mounted) return;
      setState(() => _ending = false);
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _ending = false;
        _notice = e.code == 'end_pending'
            ? CallStrings.endPending
            : CallStrings.endFailed;
      });
    }
    _pollTimer?.cancel();
    await _poll();
  }

  Future<void> _notify(CallInfo info) async {
    final slug = info.hostSlug;
    if (_notifying || _notified || slug == null) return;
    setState(() {
      _notifying = true;
      _notifyMessage = null;
    });
    final sw = Stopwatch()..start();
    try {
      await ref.read(callApiProvider).notifyMe(slug);
      CallTelemetry.notifyMe(
        slug: slug,
        callStatus: info.status.wire,
        ok: true,
        ms: sw.elapsedMilliseconds,
      );
      if (!mounted) return;
      setState(() {
        _notifying = false;
        _notified = true;
        _notifyMessage =
            "We'll WhatsApp you when ${info.hostFirstName} is free.";
      });
    } on ApiError catch (e) {
      CallTelemetry.notifyMe(
        slug: slug,
        callStatus: info.status.wire,
        ok: false,
        reason: e.code,
        httpStatus: e.status,
        ms: sw.elapsedMilliseconds,
      );
      if (!mounted) return;
      setState(() {
        _notifying = false;
        _notifyMessage = e.userMessage;
      });
    }
  }

  bool _canNotify(CallInfo info) =>
      !_cancelledByMe &&
      info.hostSlug != null &&
      (info.status == CallStatus.hostDeclined ||
          info.status == CallStatus.noAnswer);

  Future<void> _rate(CallInfo info) async {
    final router = GoRouter.of(context);
    final result = await router.push<bool>(Routes.reviewCallOf(info.id));
    if (result == true && mounted) setState(() => _reviewed = true);
  }

  int _elapsedSeconds(CallInfo info) {
    final now = ref.read(callClockProvider)();
    final fromServer = info.connectedAt == null
        ? null
        : now.difference(info.connectedAt!);
    // Trust the server's start time unless the phone's clock is clearly off (then count from first sight).
    final d = (fromServer != null && fromServer.inSeconds > -5)
        ? fromServer
        : (_firstSeenConnected == null
              ? Duration.zero
              : now.difference(_firstSeenConnected!));
    return d.inSeconds < 0 ? 0 : d.inSeconds;
  }

  @override
  Widget build(BuildContext context) {
    final info = _info;
    final live = _fatal == null && info != null && !info.status.isTerminal;
    final dark = HfBrightness.isDark(context);
    return Scaffold(
      backgroundColor: dark ? HfColors.darkBg : HfColors.page,
      appBar: live
          ? null
          : AppBar(
              automaticallyImplyLeading: false,
              leading: const HfBackButton(),
              title: const Text(CallStrings.screenTitle),
            ),
      body: SafeArea(child: _content(info)),
    );
  }

  String? _hostPhotoUrl(CallInfo info) {
    final slug = info.hostSlug;
    if (slug == null) return null;
    final visual = ref.watch(callHostVisualProvider(slug));
    return visual.hasValue ? visual.requireValue.photoUrl : null;
  }

  Widget _content(CallInfo? info) {
    final fatal = _fatal;
    if (fatal != null) {
      return EmptyPanel(
        message: fatal.status == 404
            ? CallStrings.callNotFound
            : fatal.userMessage,
        icon: Icons.phone_disabled_rounded,
        actionLabel: Strings.goHome,
        onAction: () => GoRouter.of(context).go(Routes.home),
      );
    }
    if (info == null) {
      // First answer not here yet. After a few misses, say what is going on.
      if (_failures >= 3) {
        return ErrorPanel(
          message: CallStrings.connectionTrouble,
          onRetry: () => unawaited(_poll()),
        );
      }
      return const LoadingPanel(
        message: CallStrings.checking,
        skeleton: _CallSkeleton(),
      );
    }
    if (info.status == CallStatus.ending ||
        info.status == CallStatus.finalizing) {
      return const LoadingPanel(message: CallStrings.finalizingCall);
    }
    if (info.status.isTerminal) {
      return LayoutBuilder(
        builder: (context, constraints) => SingleChildScrollView(
          padding: const EdgeInsets.all(HfSpacing.page),
          child: ConstrainedBox(
            constraints: BoxConstraints(
              minHeight: constraints.maxHeight - HfSpacing.page * 2,
            ),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                CallSummary(
                  info: info,
                  photoUrl: _hostPhotoUrl(info),
                  cancelledByMe: _cancelledByMe,
                  reviewed: _reviewed,
                  notifying: _notifying,
                  notified: _notified,
                  notifyMessage: _notifyMessage,
                  onNotify: _canNotify(info)
                      ? () => unawaited(_notify(info))
                      : null,
                  onRate: () => unawaited(_rate(info)),
                  onDone: () => popOrHome(context),
                ),
              ],
            ),
          ),
        ),
      );
    }
    return _live(info);
  }

  Widget _live(CallInfo info) {
    final connected = info.status == CallStatus.connected;
    int? currentRate;
    final photoUrl = _hostPhotoUrl(info);
    if (connected && info.rateTiers.isNotEmpty) {
      currentRate = currentRatePaise(
        info.rateTiers,
        _elapsedSeconds(info),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: SingleChildScrollView(
            child: CallLiveView(
              info: info,
              elapsedSeconds: connected ? _elapsedSeconds(info) : 0,
              currentRatePaise: currentRate,
              photoUrl: photoUrl,
              notice: _notice,
              showConnectionTrouble: _failures >= 3,
            ),
          ),
        ),
        if (info.status.isRinging)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              HfSpacing.pageWide,
              HfSpacing.sm,
              HfSpacing.pageWide,
              34,
            ),
            child: HfButton(
              label: _cancelling
                  ? CallStrings.cancelling
                  : CallStrings.cancelCall,
              kind: HfButtonKind.secondary,
              loading: _cancelling,
              onPressed: _cancel,
            ),
          )
        else if (connected)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              HfSpacing.pageWide,
              HfSpacing.sm,
              HfSpacing.pageWide,
              34,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                HfButton(
                  label: _ending
                      ? CallStrings.endingCall
                      : CallStrings.endCall,
                  kind: HfButtonKind.destructive,
                  loading: _ending,
                  onPressed: _end,
                ),
                const SizedBox(height: HfSpacing.sm),
                Text(
                  CallStrings.endFromPhone,
                  textAlign: TextAlign.center,
                  style: HfText.of(context, HfText.note),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// Placeholder with the shape of the live call: privacy chip, the ringed avatar, three text lines.
class _CallSkeleton extends StatelessWidget {
  const _CallSkeleton();

  @override
  Widget build(BuildContext context) {
    return const Column(
      children: [
        HfSkeleton.box(width: 200, height: 34, radius: 16),
        SizedBox(height: 44),
        HfSkeleton.box(width: 240, height: 240, radius: 120),
        SizedBox(height: HfSpacing.section),
        HfSkeleton.box(width: 260, height: 36, radius: 12),
        SizedBox(height: HfSpacing.md),
        HfSkeleton.line(width: 220),
      ],
    );
  }
}

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_error.dart';
import '../../../core/format/money.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/strings.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../data/call_api.dart';
import '../data/call_models.dart';
import '../data/call_telemetry.dart';
import 'call_confirm_page.dart';
import 'call_confirm_sheet.dart';
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
  Widget build(BuildContext context) => id == newCallId ? const CallConfirmPage() : CallFollower(id: id);
}

/// Follows one running or finished call (see [CallScreen]).
class CallFollower extends ConsumerStatefulWidget {
  const CallFollower({super.key, required this.id});

  final String id;

  @override
  ConsumerState<CallFollower> createState() => _CallFollowerState();
}

class _CallFollowerState extends ConsumerState<CallFollower> with WidgetsBindingObserver {
  CallInfo? _info;
  ApiError? _fatal;
  int _failures = 0;
  bool _inFlight = false;
  bool _foreground = true;
  bool _cancelling = false;
  bool _cancelledByMe = false;
  bool _reviewed = false;
  String? _notice;
  Timer? _pollTimer;
  Timer? _clockTimer;
  DateTime? _firstSeenConnected;
  CallStatus? _lastReported;
  bool _endedReported = false;

  bool get _terminal => _info?.status.isTerminal ?? false;
  bool get _shouldPoll => mounted && _foreground && _fatal == null && !_terminal;

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
          unawaited(ref.read(activeCallStoreProvider).clear(onlyIfId: widget.id));
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
          mode: info.isTokenCall ? 'tokens' : 'inr',
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
        _notice = e.code == 'already_connected' ? CallStrings.tooLateToCancel : CallStrings.cancelFailed;
      });
    }
    // Show what really happened now (ended, or connected after all).
    _pollTimer?.cancel();
    await _poll();
  }

  Future<void> _rate(CallInfo info) async {
    final router = GoRouter.of(context);
    final result = await router.push<bool>(Routes.reviewCallOf(info.id));
    if (result == true && mounted) setState(() => _reviewed = true);
  }

  int _elapsedSeconds(CallInfo info) {
    final now = ref.read(callClockProvider)();
    final fromServer = info.connectedAt == null ? null : now.difference(info.connectedAt!);
    // Trust the server's start time unless the phone's clock is clearly off (then count from first sight).
    final d = (fromServer != null && fromServer.inSeconds > -5)
        ? fromServer
        : (_firstSeenConnected == null ? Duration.zero : now.difference(_firstSeenConnected!));
    return d.inSeconds < 0 ? 0 : d.inSeconds;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: false,
        leading: const HfBackButton(),
        title: const Text(CallStrings.screenTitle),
      ),
      body: SafeArea(child: _content(_info)),
    );
  }

  Widget _content(CallInfo? info) {
    final fatal = _fatal;
    if (fatal != null) {
      return EmptyPanel(
        message: fatal.status == 404 ? CallStrings.callNotFound : fatal.userMessage,
        icon: Icons.phone_disabled_rounded,
        actionLabel: Strings.goHome,
        onAction: () => GoRouter.of(context).go(Routes.home),
      );
    }
    if (info == null) {
      // First answer not here yet. After a few misses, say what is going on.
      if (_failures >= 3) {
        return ErrorPanel(message: CallStrings.connectionTrouble, onRetry: () => unawaited(_poll()));
      }
      return const LoadingPanel(message: CallStrings.checking);
    }
    return LayoutBuilder(
      builder: (context, constraints) => SingleChildScrollView(
        padding: const EdgeInsets.all(HfSpacing.page),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: constraints.maxHeight - HfSpacing.page * 2),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: info.status.isTerminal
                ? [
                    CallSummary(
                      info: info,
                      cancelledByMe: _cancelledByMe,
                      reviewed: _reviewed,
                      onRate: () => unawaited(_rate(info)),
                      onDone: () => popOrHome(context),
                    ),
                  ]
                : _live(info),
          ),
        ),
      ),
    );
  }

  List<Widget> _live(CallInfo info) {
    final connected = info.status == CallStatus.connected;
    final name = info.hostFirstName;
    final String headline;
    final String sub;
    if (connected) {
      headline = CallStrings.connected;
      sub = '${CallStrings.endWithHash} ${CallStrings.maxLengthHint}';
    } else if (info.status == CallStatus.ringingCaller) {
      headline = CallStrings.ringingCaller(name);
      sub = CallStrings.yourPhoneWillRingSub;
    } else {
      headline = CallStrings.yourPhoneWillRing;
      sub = CallStrings.ringingHost(name);
    }
    return [
      HfScene(kind: HfSceneKind.call, height: 180, animated: !connected),
      const SizedBox(height: 24),
      Semantics(
        liveRegion: true,
        child: Text(headline, style: HfText.headline, textAlign: TextAlign.center),
      ),
      if (connected) ...[
        const SizedBox(height: 8),
        Text(
          Money.clock(_elapsedSeconds(info)),
          key: const ValueKey<String>('call-clock'),
          style: HfText.hero,
          textAlign: TextAlign.center,
        ),
      ],
      const SizedBox(height: 8),
      HfCard(child: Column(children: [
        Text(name, style: HfText.title, textAlign: TextAlign.center),
        const SizedBox(height: 12),
        Text(sub, style: HfText.bodyText, textAlign: TextAlign.center),
        if (!connected) ...[
          const SizedBox(height: 12),
          const Text(CallStrings.ringingNoCharge, style: HfText.bodyStrong, textAlign: TextAlign.center),
        ],
      ])),
      const SizedBox(height: 20),
      const CallSafetyCard(),
      if (_notice != null) ...[
        const SizedBox(height: 12),
        Semantics(
          liveRegion: true,
          child: Text(_notice!, style: HfText.bodyStrong, textAlign: TextAlign.center),
        ),
      ],
      if (_failures >= 3) ...[
        const SizedBox(height: 12),
        const Text(CallStrings.connectionTrouble, style: HfText.note, textAlign: TextAlign.center),
      ],
      if (info.status.isRinging) ...[
        const SizedBox(height: 20),
        HfButton(
          label: _cancelling ? CallStrings.cancelling : CallStrings.cancelCall,
          kind: HfButtonKind.secondary,
          loading: _cancelling,
          onPressed: _cancel,
        ),
      ],
    ];
  }
}

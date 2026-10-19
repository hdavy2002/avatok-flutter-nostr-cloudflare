import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/brand.dart';
import '../../data/api_exception.dart';
import '../../data/demo_mode.dart';
import '../../data/models/call.dart';
import '../../data/repos/calls_repo.dart';
import '../../data/repos/presence_repo.dart';
import '../../data/services.dart';
import '../../data/telemetry.dart';
import '../data.dart';
import '../notify_me_button.dart';
import '../theme.dart';
import '../widgets.dart';
import 'sheets.dart';

/// Real instant calls (HF-WIRE-7). While [DemoMode.on] the dummy flow in call.dart / sheets.dart stays.
abstract final class CallsBridge {
  /// Tests set this to exercise the real path without a dart-define.
  @visibleForTesting
  static bool forceReal = false;

  static bool get real => forceReal || !DemoMode.on;
}

/// A stand-in [Influencer] for widgets that want one (the real data has only a slug and a name).
Influencer callPerson(String? slug, String? name) => Influencer(
      id: slug ?? '',
      name: (name == null || name.isEmpty) ? 'Your call' : name,
      handle: '',
      city: '',
      niche: '',
      bio: '',
      rate: 0,
      likes: '',
      followers: '',
      videos: 0,
      online: true,
      tones: const [C.marigold, C.rani],
    );

/// Whole rupees without paise, otherwise two decimals.
String paiseText(int paise) => paise % 100 == 0 ? inr(paise / 100, paise: false) : inr(paise / 100);

String _rateText(double r) => r == r.roundToDouble() ? '₹${r.round()}' : '₹${r.toStringAsFixed(2)}';

String _clock(int seconds) {
  final s = seconds < 0 ? 0 : seconds;
  return '${(s ~/ 60).toString().padLeft(2, '0')}:${(s % 60).toString().padLeft(2, '0')}';
}

void _leave(BuildContext context) => context.canPop() ? context.pop() : context.go('/reels');

// ============================================================================================ confirm sheet

/// Call now, real: reads the estimate and the wallet, offers TOP UP when it is low, otherwise starts the call.
class RealCallConfirmSheet extends StatefulWidget {
  const RealCallConfirmSheet({super.key, required this.who, this.repo, this.notifyRepo});

  final Influencer who;
  final CallsRepo? repo;
  final PresenceRepo? notifyRepo;

  @override
  State<RealCallConfirmSheet> createState() => _RealCallConfirmSheetState();
}

class _RealCallConfirmSheetState extends State<RealCallConfirmSheet> {
  CallEstimate? _est;
  CallProblemInfo? _problem;
  bool _loading = true;
  bool _starting = false;

  CallsRepo get _repo => widget.repo ?? Services.instance.callsRepo;
  String get _first => widget.who.name.split(' ').first;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _problem = null;
    });
    try {
      final e = await _repo.estimate(widget.who.id);
      if (!mounted) return;
      setState(() => _est = e);
      Telemetry.event('hf_app_call_confirm_viewed', {'slug': widget.who.id, 'can_start': e.canStart, 'low': e.low});
    } catch (e) {
      if (!mounted) return;
      setState(() => _problem = CallProblemInfo.of(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _start() async {
    if (_starting) return;
    setState(() => _starting = true);
    final sw = Stopwatch()..start();
    try {
      final id = await _repo.start(widget.who.id);
      Telemetry.event('hf_app_call_started', {'slug': widget.who.id, 'outcome': 'ok', 'status': 200, 'ms': sw.elapsedMilliseconds, 'mode': 'inr'});
      if (!mounted) return;
      final go = GoRouter.of(context);
      Navigator.of(context).pop();
      unawaited(go.push('/call/$id'));
    } catch (e) {
      Telemetry.event('hf_app_call_started', {
        'slug': widget.who.id,
        'outcome': 'failed',
        'reason': e is ApiException ? e.code : 'error',
        'status': e is ApiException ? e.status : 0,
        'ms': sw.elapsedMilliseconds,
        'mode': 'inr',
      });
      if (!mounted) return;
      setState(() {
        _problem = CallProblemInfo.of(e);
        _starting = false;
      });
    }
  }

  void _topUp() {
    final go = GoRouter.of(context);
    Navigator.of(context).pop();
    unawaited(go.push('/topup'));
  }

  @override
  Widget build(BuildContext context) {
    final who = widget.who;
    final est = _est;
    final p = _problem;
    return SheetFrame(
      child: Padding(
        padding: EdgeInsets.fromLTRB(26, 8, 26, MediaQuery.paddingOf(context).bottom + 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Avatar(who, size: 84),
            const SizedBox(height: 10),
            Text(p?.problem == CallProblem.hostUnavailable ? '$_first is not available' : 'Call ${who.name}?', textAlign: TextAlign.center, style: t(26, color: C.maroon)),
            const SizedBox(height: 14),
            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: SizedBox(width: 36, height: 36, child: CircularProgressIndicator(color: C.maroon, strokeWidth: 4)),
              )
            else if (est != null && (p == null || (p.problem != CallProblem.hostUnavailable && p.problem != CallProblem.notOpen)))
              ..._confirmBody(est, p)
            else if (p != null)
              ..._problemBody(p),
          ],
        ),
      ),
    );
  }

  List<Widget> _confirmBody(CallEstimate est, CallProblemInfo? startProblem) {
    final low = est.low || startProblem?.problem == CallProblem.lowBalance;
    final minutes = est.talkMinutes;
    return [
      Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(color: C.deep, borderRadius: BorderRadius.circular(16)),
        child: Column(
          children: [
            _row('Rate', '${_rateText(est.ratePerMinRupees)} per minute'),
            const SizedBox(height: 8),
            _row('Your wallet', est.balancePaise == null ? '—' : paiseText(est.balancePaise!)),
            const SizedBox(height: 8),
            const SizedBox(height: 3, width: double.infinity, child: DashedLine(vertical: false, color: C.brass, width: 2)),
            const SizedBox(height: 8),
            _row('Talk time', minutes == null ? 'see below' : 'up to $minutes min', strong: true),
          ],
        ),
      ),
      const SizedBox(height: 12),
      Row(
        children: [
          const Icon(Icons.lock_rounded, size: 18, color: C.muted),
          const SizedBox(width: 8),
          Expanded(child: Text("We ring $_first first, then your phone. Both numbers stay private.", style: t(14, color: C.muted, w: FontWeight.w700, h: 1.4))),
        ],
      ),
      const SizedBox(height: 18),
      if (startProblem != null && startProblem.problem != CallProblem.lowBalance) ...[
        Text(startProblem.message, textAlign: TextAlign.center, style: t(15, color: C.ruby, h: 1.4)),
        const SizedBox(height: 12),
      ],
      if (!low)
        TicketButton(
          label: _starting ? 'CALLING…' : 'CALL NOW',
          icon: Icons.call_rounded,
          stubTop: 'RATE',
          stubBottom: '${_rateText(est.ratePerMinRupees)}/min',
          enabled: !_starting,
          onTap: _start,
        )
      else ...[
        Text(est.lowMessage, key: const Key('lowBalanceMessage'), textAlign: TextAlign.center, style: t(15, color: C.ruby, h: 1.4)),
        const SizedBox(height: 12),
        TicketButton(label: 'TOP UP', maroon: true, stubIcon: Icons.add_rounded, onTap: _topUp),
      ],
    ];
  }

  List<Widget> _problemBody(CallProblemInfo p) {
    if (p.problem == CallProblem.hostUnavailable) {
      return [
        Text('$_first is offline or busy right now. No charge.', textAlign: TextAlign.center, style: t(16, color: C.deep, h: 1.4)),
        const SizedBox(height: 16),
        NotifyMeButton(slug: widget.who.id, firstName: _first, repo: widget.notifyRepo),
        const SizedBox(height: 10),
        ChunkyButton(
          label: 'BOOK A TIME',
          filled: false,
          onTap: () {
            final go = GoRouter.of(context);
            Navigator.of(context).pop();
            unawaited(go.push('/book/${widget.who.id}'));
          },
        ),
      ];
    }
    return [
      Text(p.message, textAlign: TextAlign.center, style: t(16, color: C.ruby, h: 1.4)),
      const SizedBox(height: 16),
      if (p.problem == CallProblem.lowBalance)
        TicketButton(label: 'TOP UP', maroon: true, stubIcon: Icons.add_rounded, onTap: _topUp)
      else if (p.problem != CallProblem.notOpen)
        ChunkyButton(label: 'TRY AGAIN', onTap: _load),
    ];
  }

  Widget _row(String a, String b, {bool strong = false}) {
    return Row(
      children: [
        Expanded(child: Text(a, style: t(16, color: strong ? C.gold : C.cream, w: FontWeight.w700))),
        Text(b, style: t(strong ? 20 : 16, color: strong ? C.gold : C.ivory)),
      ],
    );
  }
}

// ============================================================================================ call screen

/// The live call. Polls `GET /api/hf/calls/:id` every 2 s (every 5 s once connected) and shows the phase:
/// ringing them, they picked up, ringing your phone, on the call (clock, cost, wallet, low-balance warning),
/// ended (cost + stars) or "Busy right now" (declined, missed, busy, offline).
class RealCallScreen extends StatefulWidget {
  const RealCallScreen({
    super.key,
    required this.callId,
    this.repo,
    this.notifyRepo,
    this.fastPoll = const Duration(seconds: 2),
    this.slowPoll = const Duration(seconds: 5),
    this.now,
  });

  final String callId;
  final CallsRepo? repo;
  final PresenceRepo? notifyRepo;
  final Duration fastPoll;
  final Duration slowPoll;

  /// Epoch ms; tests inject a clock.
  final int Function()? now;

  @override
  State<RealCallScreen> createState() => _RealCallScreenState();
}

class _RealCallScreenState extends State<RealCallScreen> with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 1200))..repeat();
  CallStatus? _s;
  CallProblemInfo? _problem;
  bool _offline = false;
  bool _busy = false;
  bool _inFlight = false;
  bool _disposed = false;
  int _stars = 0;
  int _reviewFails = 0;
  Timer? _poll;
  Timer? _tick;
  final Set<String> _seen = {};
  bool _endedReported = false;
  bool _warnReported = false;

  CallsRepo get _repo => widget.repo ?? Services.instance.callsRepo;
  int _nowMs() => widget.now?.call() ?? DateTime.now().millisecondsSinceEpoch;

  @override
  void initState() {
    super.initState();
    unawaited(_pollNow());
  }

  @override
  void dispose() {
    _disposed = true;
    _poll?.cancel();
    _tick?.cancel();
    _pulse.dispose();
    super.dispose();
  }

  void _schedule() {
    _poll?.cancel();
    final s = _s;
    if (_disposed || _problem != null || (s != null && s.isEnded)) return;
    _poll = Timer(s?.phase == CallPhase.connected ? widget.slowPoll : widget.fastPoll, () => unawaited(_pollNow()));
  }

  Future<void> _pollNow() async {
    if (_inFlight || _disposed) return;
    _inFlight = true;
    _poll?.cancel();
    try {
      final s = await _repo.status(widget.callId);
      if (_disposed) return;
      _apply(s);
    } on ApiException catch (e) {
      if (_disposed) return;
      if (e.code == 'not_enabled' || e.code == 'not_found') {
        setState(() => _problem = CallProblemInfo.of(e));
      } else {
        setState(() => _offline = true);
      }
    } catch (_) {
      if (!_disposed) setState(() => _offline = true);
    } finally {
      _inFlight = false;
      if (!_disposed) _schedule();
    }
  }

  void _apply(CallStatus s) {
    if (_seen.add(s.status)) Telemetry.event('hf_app_call_status', {'status': s.status});
    if (s.isEnded) {
      _pulse.stop();
      _tick?.cancel();
      if (!_endedReported) {
        _endedReported = true;
        Telemetry.event('hf_app_call_ended', {
          'seconds': s.billedMinutes * 60,
          'end_reason': s.endReason ?? 'none',
          'status': s.status,
          'mode': 'inr',
        });
      }
    } else if (s.phase == CallPhase.connected && _tick == null) {
      _tick = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    }
    setState(() {
      _s = s;
      _offline = false;
    });
  }

  Future<void> _hangUp() async {
    final s = _s;
    if (_busy || s == null) return;
    setState(() => _busy = true);
    try {
      if (s.phase == CallPhase.connected) {
        await _repo.end(widget.callId);
      } else {
        try {
          await _repo.cancel(widget.callId);
          Telemetry.event('hf_app_call_cancelled', {'outcome': 'ok'});
        } on ApiException catch (e) {
          if (e.code != 'already_connected') {
            Telemetry.event('hf_app_call_cancelled', {'outcome': 'failed', 'reason': e.code});
            rethrow;
          }
          Telemetry.event('hf_app_call_cancelled', {'outcome': 'too_late', 'reason': e.code});
          await _repo.end(widget.callId);
        }
      }
    } on ApiException catch (e) {
      if (mounted) toast(context, e.userMessage);
    } catch (_) {
      if (mounted) toast(context, ApiException.genericText);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    await _pollNow();
  }

  Future<void> _done() async {
    final s = _s;
    if (_busy) return;
    if (s != null && _stars > 0 && s.canReview && _reviewFails < 2) {
      setState(() => _busy = true);
      final sw = Stopwatch()..start();
      try {
        await _repo.review(widget.callId, _stars);
        Telemetry.event('hf_app_review_submitted', {'stars': _stars, 'via': 'call', 'outcome': 'ok', 'status': 200, 'ms': sw.elapsedMilliseconds});
      } catch (e) {
        Telemetry.event('hf_app_review_submitted', {
          'stars': _stars,
          'via': 'call',
          'outcome': 'failed',
          'reason': e is ApiException ? e.code : 'error',
          'status': e is ApiException ? e.status : 0,
          'ms': sw.elapsedMilliseconds,
        });
        // An already-sent review is fine; anything else gets one more try.
        if (!(e is ApiException && e.code == 'already_reviewed')) {
          _reviewFails++;
          if (mounted) {
            setState(() => _busy = false);
            toast(context, e is ApiException ? e.userMessage : ApiException.genericText);
          }
          return;
        }
      }
      if (mounted) setState(() => _busy = false);
    }
    if (mounted) _leave(context);
  }

  int get _talkSeconds {
    final at = _s?.connectedAt;
    if (at == null) return 0;
    final sec = ((_nowMs() - at) / 1000).floor();
    return sec < 0 ? 0 : sec;
  }

  @override
  Widget build(BuildContext context) {
    final s = _s;
    final w = callPerson(s?.hostSlug, s?.hostName);
    final first = s?.hostName == null ? 'them' : w.name.split(' ').first;
    final ended = s?.isEnded ?? false;
    final String title;
    if (_problem != null) {
      title = _problem!.message;
    } else if (s == null) {
      title = _offline ? ApiException.offlineText : 'Connecting…';
    } else {
      title = switch (s.phase) {
        CallPhase.ringingHost => 'Calling $first…',
        CallPhase.hostAccepted || CallPhase.dialingFan => '$first picked up! Ringing your phone…',
        CallPhase.connected => 'On call · ${_clock(_talkSeconds)}',
        CallPhase.ended => s.unavailable ? 'Busy right now' : 'Call ended',
      };
    }
    return PopScope(
      canPop: ended || _problem != null,
      child: Scaffold(
        backgroundColor: C.cinema,
        body: SafeArea(
          child: Stack(
            children: [
              const Positioned(left: 0, top: 0, bottom: 0, child: SprocketRail()),
              const Positioned(right: 0, top: 0, bottom: 0, child: SprocketRail()),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 28),
                child: SingleChildScrollView(
                  child: ConstrainedBox(
                    constraints: BoxConstraints(minHeight: MediaQuery.sizeOf(context).height - MediaQuery.paddingOf(context).vertical - 8),
                    child: IntrinsicHeight(child: _body(context, s, w, first, title, ended)),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _body(BuildContext context, CallStatus? s, Influencer w, String first, String title, bool ended) {
    final connected = s?.phase == CallPhase.connected;
    final remainingMs = (s?.capAt == null) ? null : s!.capAt! - _nowMs();
    final warn = connected && remainingMs != null && remainingMs > 0 && remainingMs <= 60000;
    if (warn && !_warnReported) {
      _warnReported = true;
      Telemetry.event('hf_app_call_cap_warning', {});
    }
    return Column(
      children: [
        const SizedBox(height: 40),
        SizedBox(
          width: 220,
          height: 220,
          child: Stack(
            alignment: Alignment.center,
            children: [
              if (!ended && _problem == null)
                AnimatedBuilder(
                  animation: _pulse,
                  builder: (_, __) => Container(
                    width: 150 + 70 * _pulse.value,
                    height: 150 + 70 * _pulse.value,
                    decoration: BoxDecoration(shape: BoxShape.circle, color: C.marigold.withValues(alpha: 0.35 * (1 - _pulse.value))),
                  ),
                ),
              Avatar(w, size: 150),
            ],
          ),
        ),
        const SizedBox(height: 18),
        Text(w.name, textAlign: TextAlign.center, style: t(30, color: C.ivory, ls: 0.02)),
        const SizedBox(height: 8),
        Text(title, textAlign: TextAlign.center, style: t(19, color: C.gold)),
        if (_offline && s != null) ...[
          const SizedBox(height: 6),
          Text(ApiException.offlineText, textAlign: TextAlign.center, style: t(14, color: C.cream, w: FontWeight.w700)),
        ],
        if (s != null && (s.phase == CallPhase.hostAccepted || s.phase == CallPhase.dialingFan)) ...[
          const SizedBox(height: 10),
          Text('Answer the call from the ${Brand.name} number.', textAlign: TextAlign.center, style: t(15, color: C.cream, w: FontWeight.w700)),
        ],
        if (connected) ...[
          const SizedBox(height: 18),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
            decoration: BoxDecoration(color: C.deep, borderRadius: BorderRadius.circular(14), border: Border.all(color: C.brass, width: 2)),
            child: Text('${(_talkSeconds / 60).ceil()} min · ${paiseText(s!.costPaise)} so far', style: t(17, color: C.gold)),
          ),
          if (s.walletPaise != null) ...[
            const SizedBox(height: 8),
            Text('Wallet: ${paiseText(s.walletPaise!)}', style: t(14, color: C.cream, w: FontWeight.w700)),
          ],
          if (warn) ...[
            const SizedBox(height: 14),
            Semantics(
              liveRegion: true,
              child: GestureDetector(
                onTap: () => context.push('/topup'),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  decoration: BoxDecoration(color: C.marigold, borderRadius: BorderRadius.circular(14)),
                  child: Text('About 1 minute left. Top up to keep talking.', textAlign: TextAlign.center, style: t(16, color: C.deep, h: 1.3)),
                ),
              ),
            ),
          ],
        ],
        if (ended && s != null) ..._endedBody(context, s, first),
        const Spacer(),
        if (_problem != null)
          SizedBox(width: double.infinity, child: ChunkyButton(label: 'DONE', height: 64, onTap: () => _leave(context)))
        else if (!ended)
          SizedBox(
            width: double.infinity,
            child: ChunkyButton(label: 'END CALL', icon: Icons.call_end_rounded, dark: true, height: 64, onTap: (_busy || s == null) ? null : _hangUp),
          )
        else
          SizedBox(width: double.infinity, child: ChunkyButton(label: 'DONE', height: 64, onTap: _busy ? null : _done)),
        const SizedBox(height: 24),
      ],
    );
  }

  List<Widget> _endedBody(BuildContext context, CallStatus s, String first) {
    if (s.unavailable) {
      return [
        const SizedBox(height: 14),
        Text("$first can't take your call right now. No charge — the call did not connect.", textAlign: TextAlign.center, style: t(16, color: C.ivory, h: 1.4)),
        const SizedBox(height: 18),
        if (s.hostSlug != null) ...[
          NotifyMeButton(slug: s.hostSlug!, firstName: first, repo: widget.notifyRepo),
          const SizedBox(height: 10),
          ChunkyButton(label: 'BOOK A TIME', filled: false, dark: true, onTap: () => context.push('/book/${s.hostSlug}')),
        ],
      ];
    }
    if (!s.wasConnected) {
      return [
        const SizedBox(height: 18),
        Text('No charge — the call did not connect.', textAlign: TextAlign.center, style: t(18, color: C.ivory)),
      ];
    }
    return [
      const SizedBox(height: 18),
      if (s.firstMinuteDrop)
        Text(s.firstMinuteText, key: const Key('firstMinuteMessage'), textAlign: TextAlign.center, style: t(18, color: C.ivory, h: 1.4))
      else
        Text('${s.billedMinutes} min · ${paiseText(s.costPaise)}', style: t(18, color: C.ivory)),
      if (s.reason == CallReason.noBalance) ...[
        const SizedBox(height: 8),
        Text('Your balance ran out.', style: t(15, color: C.cream, w: FontWeight.w700)),
        const SizedBox(height: 10),
        ChunkyButton(label: 'TOP UP', filled: false, dark: true, onTap: () => context.push('/topup')),
      ],
      if (s.canReview) ...[
        const SizedBox(height: 22),
        Text('How was it?', style: t(18, color: C.gold)),
        const SizedBox(height: 8),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            for (var i = 1; i <= 5; i++)
              IconButton(
                iconSize: 40,
                tooltip: '$i stars',
                onPressed: () => setState(() => _stars = i),
                icon: Icon(i <= _stars ? Icons.star_rounded : Icons.star_outline_rounded, color: C.marigold),
              ),
          ],
        ),
      ],
    ];
  }
}

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/brand.dart';
import '../../data/api_exception.dart';
import '../../data/call_flags.dart'; // [HF-CALL-MODES-E2]
import '../../data/demo_mode.dart';
import '../../data/models/call.dart';
import '../../data/repos/calls_repo.dart';
import '../../data/repos/presence_repo.dart';
import '../../data/services.dart';
import '../../data/telemetry.dart';
import '../data.dart';
import '../notify_me_button.dart';
import '../queue_kit.dart'; // [HF-CALL-MODES-E2]
import '../theme.dart';
import '../widgets.dart';
import '../call_kit.dart';

/// Explicit 18+ recovery; callers must tap their transaction action again afterwards.
Future<void> recoverHfAgeConfirmation(BuildContext context, {Future<void> Function()? acknowledge}) async {
  final agreed = await hfConfirm(context, title: 'Confirm your age',
    body: 'Please confirm that you are 18 or older to continue.',
    confirmLabel: 'I am 18 or older');
  if (!agreed || !context.mounted) return;
  try {
    await (acknowledge ?? Services.instance.authRepo.confirmAge)();
    if (context.mounted) toast(context, 'Age confirmation saved. Please try your call or booking again.');
  } catch (e) {
    if (context.mounted) toast(context, e is ApiException ? e.userMessage : 'We could not save your age confirmation. Please try again.');
  }
}

/// Legacy scheduled bookings remain readable/cancellable, but need this before auto-start.
class BookingAgeConfirmation extends StatefulWidget {
  const BookingAgeConfirmation({super.key});
  @override
  State<BookingAgeConfirmation> createState() => _BookingAgeConfirmationState();
}
class _BookingAgeConfirmationState extends State<BookingAgeConfirmation> {
  bool _needed = Services.instance.me?.age18ConfirmedAt == null;
  bool _busy = false;
  Future<void> _check() async {
    try {
      final me = await Services.instance.meRepo.fetch();
      if (mounted) setState(() => _needed = me.age18ConfirmedAt == null);
    } catch (_) {
      // A failed read must still offer a route to explicit attestation.
      if (mounted) setState(() => _needed = true);
    }
  }
  @override
  Widget build(BuildContext context) => !_needed ? const SizedBox.shrink() : Padding(
    padding: const EdgeInsets.symmetric(vertical: 12),
    child: Column(children: [
      Text('Confirm you are 18 or older before your appointment can start.', style: t(16)),
      TextButton(onPressed: _busy ? null : () async {
        setState(() => _busy = true);
        await recoverHfAgeConfirmation(context);
        if (!mounted) return;
        await _check();
        if (mounted) setState(() => _busy = false);
      }, child: const Text('Confirm 18+')),
    ]),
  );
}

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

/// [HF-CALL-MODES-E2] The banner while the wallet cannot fund the next 5 minutes (chunk billing).
const String kShortBannerText = 'Your wallet is running out — top up now and keep talking';

/// Whole rupees without paise, otherwise two decimals.
String paiseText(int paise) => paise % 100 == 0 ? inr(paise / 100, paise: false) : inr(paise / 100);

String _rateText(double r) => r == r.roundToDouble() ? '₹${r.round()}' : '₹${r.toStringAsFixed(2)}';

String _clock(int seconds) {
  final s = seconds < 0 ? 0 : seconds;
  // [HF-CALL-MODES-E2] Calls can now last 5 hours: show h:mm:ss from the first hour (only with chunk billing on).
  if (CallFlags.chunkBilling && s >= 3600) {
    return '${s ~/ 3600}:${((s % 3600) ~/ 60).toString().padLeft(2, '0')}:${(s % 60).toString().padLeft(2, '0')}';
  }
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
      if (e is ApiException && e.code == 'age_confirmation_required') {
        await recoverHfAgeConfirmation(context);
        if (mounted) setState(() { _problem = null; _starting = false; });
        return;
      }
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
    // [HF-APP-DESI-6] approved call confirm sheet
    return CallSheetFrame(
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, MediaQuery.paddingOf(context).bottom + 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CallSheetHead(who: who, title: p?.problem == CallProblem.hostUnavailable ? '$_first is not available' : 'Call ${who.name}?'),
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
      CallSheetHisaab(
        rate: '${_rateText(est.ratePerMinRupees)} per minute',
        wallet: est.balancePaise == null ? '—' : paiseText(est.balancePaise!),
        talk: minutes == null ? 'see below' : 'up to $minutes min',
      ),
      const SizedBox(height: 12),
      CallPrivacyNote(first: _first),
      const SizedBox(height: 16),
      if (startProblem != null && startProblem.problem != CallProblem.lowBalance) ...[
        Text(startProblem.message, textAlign: TextAlign.center, style: t(15, color: C.ruby, w: FontWeight.w800, h: 1.4)),
        const SizedBox(height: 12),
      ],
      if (!low)
        CallPill(
          label: _starting ? 'CALLING…' : 'CALL NOW',
          icon: Icons.call_rounded,
          tag: '${_rateText(est.ratePerMinRupees)}/min',
          onTap: _starting ? null : _start,
        )
      else ...[
        Text(est.lowMessage, key: const Key('lowBalanceMessage'), textAlign: TextAlign.center, style: t(15, color: C.ruby, w: FontWeight.w800, h: 1.4)),
        const SizedBox(height: 12),
        CallPill(label: 'TOP UP', kind: CallPillKind.gold, icon: Icons.add_rounded, onTap: _topUp),
      ],
    ];
  }

  List<Widget> _problemBody(CallProblemInfo p) {
    if (p.problem == CallProblem.hostUnavailable) {
      // [HF-CALL-MODES-E2] The server said why (on a call, appointments only, offline...): offer what fits that reason.
      final why = p.reason;
      if (CallFlags.modes && why != null) {
        return [
          CallStateActions(
            slug: widget.who.id,
            first: _first,
            state: why,
            canQueue: p.canQueue,
            canBook: p.canBook,
            waiting: p.queueWaiting,
            notifyRepo: widget.notifyRepo,
            onDone: () => Navigator.of(context).pop(),
          ),
        ];
      }
      return [
        Text('$_first is offline or busy right now. No charge.', textAlign: TextAlign.center, style: t(16, color: C.deep, w: FontWeight.w700, h: 1.4)),
        const SizedBox(height: 16),
        NotifyMeButton(slug: widget.who.id, firstName: _first, repo: widget.notifyRepo, big: true),
        const SizedBox(height: 10),
        CallPill(
          label: 'BOOK A TIME',
          kind: CallPillKind.gold,
          height: 58,
          onTap: () {
            final go = GoRouter.of(context);
            Navigator.of(context).pop();
            unawaited(go.push('/book/${widget.who.id}'));
          },
        ),
      ];
    }
    return [
      Text(p.message, textAlign: TextAlign.center, style: t(16, color: C.ruby, w: FontWeight.w800, h: 1.4)),
      const SizedBox(height: 16),
      if (p.problem == CallProblem.lowBalance)
        CallPill(label: 'TOP UP', kind: CallPillKind.gold, icon: Icons.add_rounded, onTap: _topUp)
      else if (p.problem != CallProblem.notOpen)
        CallPill(label: 'TRY AGAIN', kind: CallPillKind.plum, onTap: _load),
    ];
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
    // [HF-CALL-MODES-E2] While the wallet is short, ask faster so a top-up shows at once.
    final slow = s?.phase == CallPhase.connected && !(CallFlags.chunkBilling && s?.short == true);
    _poll = Timer(slow ? widget.slowPoll : widget.fastPoll, () => unawaited(_pollNow()));
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
      CallReturn.callId = null; // [HF-CALL-MODES-E2]
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

  /// [HF-CALL-MODES-E2] TOP UP while talking: opens the normal top-up and the payment result brings her back to this call.
  void _topUp() {
    Telemetry.event('hf_app_call_topup_tapped', {'surface': 'call', 'short': _s?.short == true});
    if (CallFlags.chunkBilling) CallReturn.callId = widget.callId;
    unawaited(context.push('/topup').then((_) {
      if (mounted) unawaited(_pollNow());
    }));
  }

  /// [HF-CALL-MODES-E2] Shown while the server says the wallet cannot fund the next chunk.
  Widget _shortBanner() => Semantics(
        liveRegion: true,
        child: Container(
          key: const ValueKey('call-short-banner'),
          width: double.infinity,
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
          decoration: BoxDecoration(gradient: const LinearGradient(colors: [C.marigold, C.lemon]), borderRadius: BorderRadius.circular(18)),
          child: Column(children: [
            Text(kShortBannerText, textAlign: TextAlign.center, style: t(16, color: C.deep, w: FontWeight.w800, h: 1.3)),
            const SizedBox(height: 10),
            CallPill(label: 'TOP UP', kind: CallPillKind.plum, height: 52, icon: Icons.add_rounded, onTap: _topUp),
          ]),
        ),
      );

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
    // [HF-APP-DESI-6] approved on-call / call-ended layout
    return PopScope(
      canPop: ended || _problem != null,
      child: Scaffold(
        backgroundColor: C.deep,
        body: CallBackdrop(
          child: LayoutBuilder(
            builder: (context, box) => SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(22, 40, 22, 24),
              child: ConstrainedBox(
                constraints: BoxConstraints(minHeight: box.maxHeight - 64),
                child: IntrinsicHeight(child: _body(context, s, w, first, title, ended)),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _body(BuildContext context, CallStatus? s, Influencer w, String first, String title, bool ended) {
    final connected = s?.phase == CallPhase.connected;
    // [HF-CALL-MODES-E2] With chunk billing the end moves: follow capAt (else fundedUntil) from the latest poll.
    final endAt = s?.capAt ?? (CallFlags.chunkBilling ? s?.fundedUntil : null);
    final remainingMs = endAt == null ? null : endAt - _nowMs();
    final short = CallFlags.chunkBilling && connected && s?.short == true;
    final warn = connected && remainingMs != null && remainingMs > 0 && remainingMs <= 60000;
    if (warn && !_warnReported) {
      _warnReported = true;
      Telemetry.event('hf_app_call_cap_warning', {});
    }
    final over = ended && s != null;
    return Column(
      children: [
        CallPortrait(who: w, pulse: _pulse, active: !ended && _problem == null, small: over),
        const SizedBox(height: 14),
        if (over) ...[
          Text(title, textAlign: TextAlign.center, style: t(28, color: C.white, w: FontWeight.w900)),
          if (s.hostName != null) Text('with ${w.name}', textAlign: TextAlign.center, style: t(16, color: C.white, w: FontWeight.w700)),
        ] else ...[
          Text(w.name, textAlign: TextAlign.center, style: t(30, color: C.white, w: FontWeight.w900)),
          const SizedBox(height: 8),
          if (connected) ...[
            const CallOnChip(),
            const SizedBox(height: 10),
            CallClock(_clock(_talkSeconds)),
          ] else
            Text(title, textAlign: TextAlign.center, style: t(19, color: C.lemon, w: FontWeight.w800)),
        ],
        if (_offline && s != null) ...[
          const SizedBox(height: 6),
          Text(ApiException.offlineText, textAlign: TextAlign.center, style: t(14, color: C.white, w: FontWeight.w700)),
        ],
        if (s != null && (s.phase == CallPhase.hostAccepted || s.phase == CallPhase.dialingFan)) ...[
          const SizedBox(height: 10),
          Text('Answer the call from the ${Brand.name} number.', textAlign: TextAlign.center, style: t(15, color: C.white, w: FontWeight.w700)),
        ],
        if (connected) ...[
          const SizedBox(height: 14),
          CallSpendTiles(
            spent: paiseText(s!.costPaise),
            spentSub: '${(_talkSeconds / 60).ceil()} min',
            wallet: s.walletPaise == null ? null : paiseText(s.walletPaise!),
          ),
          if (short) ...[
            const SizedBox(height: 14),
            _shortBanner(),
          ] else if (warn) ...[
            const SizedBox(height: 14),
            Semantics(
              liveRegion: true,
              child: GestureDetector(
                onTap: () {
                  if (CallFlags.chunkBilling) {
                    _topUp();
                  } else {
                    unawaited(context.push('/topup'));
                  }
                },
                child: Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(colors: [Color(0xFFF59E0B), Color(0xFFFBBF24)]),
                    borderRadius: BorderRadius.circular(18),
                  ),
                  child: Text(CallFlags.chunkBilling ? 'About 1 minute left on this call.' : 'About 1 minute left. Top up to keep talking.', textAlign: TextAlign.center, style: t(16, color: C.deep, w: FontWeight.w800, h: 1.3)),
                ),
              ),
            ),
          ],
        ],
        if (over) ..._endedBody(context, s, first),
        const Spacer(),
        const SizedBox(height: 16),
        if (_problem != null)
          CallPill(label: 'DONE', kind: CallPillKind.gold, onTap: () => _leave(context))
        else if (!ended)
          CallPill(label: 'END CALL', kind: CallPillKind.red, icon: Icons.call_end_rounded, height: 64, onTap: (_busy || s == null) ? null : _hangUp)
        else
          CallPill(label: 'DONE', kind: CallPillKind.gold, onTap: _busy ? null : _done),
      ],
    );
  }

  List<Widget> _endedBody(BuildContext context, CallStatus s, String first) {
    if (s.unavailable) {
      return [
        const SizedBox(height: 16),
        CallEndHisaab(message: "$first can't take your call right now. No charge — the call did not connect."),
        const SizedBox(height: 16),
        if (s.hostSlug != null) ...[
          NotifyMeButton(slug: s.hostSlug!, firstName: first, repo: widget.notifyRepo, big: true),
          const SizedBox(height: 10),
          CallPill(label: 'BOOK A TIME', kind: CallPillKind.ghost, height: 58, onTap: () => context.push('/book/${s.hostSlug}')),
        ],
      ];
    }
    if (!s.wasConnected) {
      return [const SizedBox(height: 16), const CallEndHisaab(message: 'No charge — the call did not connect.')];
    }
    return [
      const SizedBox(height: 16),
      s.firstMinuteDrop
          ? CallEndHisaab(message: s.firstMinuteText, messageKey: const Key('firstMinuteMessage'))
          : CallEndHisaab(
              talked: '${s.billedMinutes} min',
              paid: paiseText(s.costPaise),
              footer: s.reason == CallReason.noBalance ? 'Your balance ran out.' : null,
            ),
      if (s.reason == CallReason.noBalance) ...[
        const SizedBox(height: 12),
        CallPill(label: 'TOP UP', kind: CallPillKind.ghost, height: 52, icon: Icons.add_rounded, onTap: () => context.push('/topup')),
      ],
      if (s.canReview) ...[
        const SizedBox(height: 18),
        CallStars(value: _stars, onPick: (i) => setState(() => _stars = i)),
      ],
    ];
  }
}

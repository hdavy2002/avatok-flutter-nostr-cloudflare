import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/api_exception.dart';
import '../../data/models/queue.dart';
import '../../data/repos/queue_repo.dart';
import '../../data/repos/reels_repo.dart';
import '../../data/services.dart';
import '../../data/telemetry.dart';
import '../booking_kit.dart';
import '../call_kit.dart';
import '../desi.dart';
import '../theme.dart';
import '../widgets.dart';
import '../space_kit.dart'; // [HF-CREATOR-SPACES-1]
import 'call_real.dart';

/// [HF-CALL-MODES-E2] Join the queue for an influencer who is on a call (dark behind `hfCallQueueEnabled`). `/queue/:slug`.
/// Shows: a join card, then the live position (polls `GET /api/hf/queue/me`), leave, and what went wrong in plain words.
/// When it is this fan's turn the server starts the call and this screen moves to it.
const String kQueueWhatsappLine = "We'll WhatsApp you just before we call. Nothing is charged until you talk.";

enum _Stage { loading, ready, waiting, offered, over, failed }

class QueueScreen extends StatefulWidget {
  const QueueScreen({
    super.key,
    required this.slug,
    this.waiting = 0,
    this.repo,
    this.reelsRepo,
    this.poll = const Duration(seconds: 5),
  });

  final String slug;

  /// How many are already waiting, when the previous screen knew.
  final int waiting;
  final QueueRepo? repo;
  final ReelsRepo? reelsRepo;

  /// How often the position refreshes. Tests pass a short one, or null to poll only on start.
  final Duration? poll;

  @override
  State<QueueScreen> createState() => _QueueScreenState();
}

class _QueueScreenState extends State<QueueScreen> {
  QueueRepo get _repo => widget.repo ?? Services.instance.queueRepo;

  _Stage _stage = _Stage.loading;
  MyQueueEntry? _entry;
  QueueProblemInfo? _problem;
  Object? _loadError;
  String _name = '';
  String _overText = '';
  bool _busy = false;
  bool _offline = false;
  bool _inFlight = false;
  bool _moved = false;
  bool _wasOffered = false; // the server drops a finished entry from /queue/me, so "gone after our turn" is the only sign the turn came
  late final int _waitingAtStart = widget.waiting;
  Timer? _timer;
  final Stopwatch _wait = Stopwatch();

  String get _first => _name.isEmpty ? 'the influencer' : _name.split(' ').first;

  @override
  void initState() {
    super.initState();
    unawaited(_init());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _loadName() async {
    try {
      final p = await (widget.reelsRepo ?? Services.instance.reelsRepo).profile(widget.slug);
      if (mounted && p.host.name.isNotEmpty) setState(() => _name = p.host.name);
    } catch (_) {
      // the screen still works without her name
    }
  }

  Future<void> _init() async {
    setState(() {
      _stage = _Stage.loading;
      _loadError = null;
    });
    unawaited(_loadName());
    try {
      final e = (await _repo.mine()).entry;
      if (!mounted) return;
      if (e != null && !e.isOver) {
        if (e.hostSlug == widget.slug) {
          _enter(e);
          return;
        }
        setState(() {
          _stage = _Stage.ready;
          _problem = QueueProblemInfo(QueueProblem.alreadyQueued, 'You are already in the queue for ${e.hostName}.', hostSlug: e.hostSlug);
        });
        return;
      }
      setState(() => _stage = _Stage.ready);
    } catch (e) {
      if (mounted) {
        setState(() {
          _stage = _Stage.failed;
          _loadError = e;
        });
      }
    }
  }

  void _enter(MyQueueEntry e) {
    _wasOffered = e.isOffered;
    _wait
      ..reset()
      ..start();
    setState(() {
      _entry = e;
      if (e.hostName.isNotEmpty && e.hostName != 'the influencer') _name = e.hostName;
      _stage = e.isOffered ? _Stage.offered : _Stage.waiting;
      _problem = null;
    });
    _maybeMove(e);
    _schedule();
  }

  void _schedule() {
    _timer?.cancel();
    final p = widget.poll;
    if (p == null || !mounted || _moved || (_stage != _Stage.waiting && _stage != _Stage.offered)) return;
    _timer = Timer(p, () => unawaited(_pollNow()));
  }

  void _maybeMove(MyQueueEntry e) {
    final id = e.callId;
    if (_moved || !e.isOffered || id == null || id.isEmpty || !mounted) return;
    _moved = true;
    _timer?.cancel();
    context.pushReplacement('/call/${Uri.encodeComponent(id)}');
  }

  Future<void> _pollNow() async {
    if (_inFlight || !mounted) return;
    _inFlight = true;
    try {
      final e = (await _repo.mine()).entry;
      if (!mounted) return;
      if (e == null || e.isOver) {
        _over(e);
        return;
      }
      _wasOffered = e.isOffered;
      setState(() {
        _offline = false;
        _entry = e;
        _stage = e.isOffered ? _Stage.offered : _Stage.waiting;
      });
      _maybeMove(e);
    } catch (_) {
      if (mounted) setState(() => _offline = true);
    } finally {
      _inFlight = false;
      _schedule();
    }
  }

  void _over(MyQueueEntry? e) {
    _timer?.cancel();
    final status = e?.status ?? 'gone';
    Telemetry.event('hf_app_queue_left', {'wait_s': _wait.elapsed.inSeconds, 'reason': status});
    final text = switch (status) {
      'left' => 'You left the queue.',
      'skipped' => 'We could not connect your turn, so you left the queue. Nothing was charged.',
      'expired' => 'Your place in the queue has expired. Nothing was charged.',
      'closed' => '$_first has stopped taking calls for now, so the queue is closed. Nothing was charged.',
      'done' => 'Your call is finished. Thank you.',
      _ when _wasOffered => 'Your turn came. If we could not reach you, you have left the queue. Nothing is charged for waiting.',
      _ => 'Your place in the queue has ended. Nothing was charged.',
    };
    setState(() {
      _overText = text;
      _stage = _Stage.over;
    });
  }

  Future<void> _join() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _problem = null;
    });
    try {
      final r = await _repo.join(widget.slug);
      Telemetry.event('hf_app_queue_joined', {'position': r.position});
      if (!mounted) return;
      setState(() => _busy = false);
      _enter(MyQueueEntry(entryId: r.entryId, hostSlug: widget.slug, hostName: _name.isEmpty ? 'the influencer' : _name, position: r.position, status: 'waiting'));
    } catch (e) {
      Telemetry.event('hf_app_queue_failed', {'reason': e is ApiException ? e.code : 'error'});
      if (!mounted) return;
      // [HF-CREATOR-SPACES-1] 403 lane_required: the locked prompt with "Verify to call".
      if (await handleLaneRequired(context, e)) {
        if (mounted) setState(() => _busy = false);
        return;
      }
      if (!mounted) return;
      setState(() {
        _busy = false;
        _problem = QueueProblemInfo.of(e);
      });
    }
  }

  Future<void> _leave() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await _repo.leave(widget.slug);
      Telemetry.event('hf_app_queue_left', {'wait_s': _wait.elapsed.inSeconds, 'reason': 'user'});
      if (!mounted) return;
      _timer?.cancel();
      _close();
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      toast(context, e is ApiException ? e.userMessage : ApiException.genericText);
    }
  }

  void _close() => context.canPop() ? context.pop() : context.go('/reels');

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.ivory,
      body: SafeArea(
        child: Column(
          children: [
            const BookHeader('Join the queue'),
            Expanded(child: _content(context)),
          ],
        ),
      ),
    );
  }

  Widget _content(BuildContext context) {
    switch (_stage) {
      case _Stage.loading:
        return Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const SizedBox(width: 36, height: 36, child: CircularProgressIndicator(color: C.maroon, strokeWidth: 4)),
            const SizedBox(height: 12),
            Text('Checking the queue…', style: t(16, color: C.muted, w: FontWeight.w700)),
          ]),
        );
      case _Stage.failed:
        final err = _loadError;
        return ListView(padding: const EdgeInsets.fromLTRB(16, 16, 16, 24), children: [
          Text(err is ApiException ? err.failureTitle : 'That did not work', textAlign: TextAlign.center, style: t(22, color: C.maroon, w: FontWeight.w900)),
          const SizedBox(height: 8),
          Text(err is ApiException ? err.failureMessage : ApiException.genericText, textAlign: TextAlign.center, style: t(16, color: C.muted, w: FontWeight.w700, h: 1.4)),
          const SizedBox(height: 16),
          CallPill(label: 'TRY AGAIN', kind: CallPillKind.plum, onTap: () => unawaited(_init())),
        ]);
      case _Stage.ready:
        return _ready(context);
      case _Stage.waiting:
      case _Stage.offered:
        return _waiting(context);
      case _Stage.over:
        return ListView(padding: const EdgeInsets.fromLTRB(16, 24, 16, 24), children: [
          Icon(Icons.hourglass_empty_rounded, size: 48, color: C.maroon),
          const SizedBox(height: 12),
          Text(_overText, key: const ValueKey('queue-over-text'), textAlign: TextAlign.center, style: t(18, w: FontWeight.w800, h: 1.4)),
          const SizedBox(height: 20),
          CallPill(label: 'BOOK A TIME', kind: CallPillKind.gold, height: 58, onTap: () => context.pushReplacement('/book/${Uri.encodeComponent(widget.slug)}')),
          const SizedBox(height: 10),
          TextButton(
            style: TextButton.styleFrom(minimumSize: const Size.fromHeight(48)),
            onPressed: _close,
            child: Text('BACK', style: t(16, color: C.maroon, w: FontWeight.w900)),
          ),
        ]);
    }
  }

  Widget _ready(BuildContext context) {
    final p = _problem;
    final n = _waitingAtStart;
    return Column(children: [
      Expanded(
        child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 16), children: [
          Text(_name.isEmpty ? 'Join the queue' : '$_first is on a call', textAlign: TextAlign.center, style: t(26, color: C.maroon, w: FontWeight.w900)),
          const SizedBox(height: 6),
          Text(
            n > 0 ? '$n ${n == 1 ? 'person is' : 'people are'} waiting. You will join behind them.' : 'Be the first in line.',
            key: const ValueKey('queue-waiting-line'),
            textAlign: TextAlign.center,
            style: t(16, color: C.muted, w: FontWeight.w700, h: 1.4),
          ),
          const SizedBox(height: 14),
          const BookNotice(key: ValueKey('queue-whatsapp-note'), text: kQueueWhatsappLine, icon: Icons.chat_rounded, teal: true),
          if (p != null) ...[
            const SizedBox(height: 14),
            _problemCard(context, p),
          ],
          const SizedBox(height: 14),
          const DesiMogra(),
        ]),
      ),
      BookBottomButton(label: _busy ? 'JOINING…' : 'JOIN THE QUEUE', icon: null, plum: true, enabled: !_busy, onTap: () => unawaited(_join())),
    ]);
  }

  Widget _problemCard(BuildContext context, QueueProblemInfo p) {
    final shortfall = p.shortfallPaise;
    final extra = p.problem == QueueProblem.lowBalance && shortfall != null && shortfall > 0 ? ' Add about ${paiseText(shortfall)} more to join.' : '';
    return Container(
      key: const ValueKey('queue-problem'),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(20), border: Border.all(color: C.ruby, width: 1.5)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Semantics(liveRegion: true, child: Text('${p.message}$extra', style: t(16, color: C.ruby, w: FontWeight.w800, h: 1.4))),
        if (p.problem == QueueProblem.lowBalance) ...[
          const SizedBox(height: 12),
          CallPill(
            label: 'TOP UP',
            kind: CallPillKind.gold,
            icon: Icons.add_rounded,
            onTap: () {
              Telemetry.event('hf_app_call_topup_tapped', {'surface': 'queue'});
              unawaited(context.push('/topup'));
            },
          ),
        ],
        if (p.problem == QueueProblem.alreadyQueued && p.hostSlug != null) ...[
          const SizedBox(height: 12),
          CallPill(label: 'GO TO THAT QUEUE', kind: CallPillKind.plum, onTap: () => context.pushReplacement('/queue/${Uri.encodeComponent(p.hostSlug!)}')),
        ],
        if (p.problem == QueueProblem.closed || p.problem == QueueProblem.full) ...[
          const SizedBox(height: 12),
          CallPill(label: 'BOOK A TIME', kind: CallPillKind.gold, height: 58, onTap: () => context.pushReplacement('/book/${Uri.encodeComponent(widget.slug)}')),
        ],
      ]),
    );
  }

  Widget _waiting(BuildContext context) {
    final e = _entry!;
    final turn = _stage == _Stage.offered;
    return Column(children: [
      Expanded(
        child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 16), children: [
          if (_offline) ...[
            Text(ApiException.offlineText, textAlign: TextAlign.center, style: t(14, color: C.ruby, w: FontWeight.w800)),
            const SizedBox(height: 8),
          ],
          Semantics(
            liveRegion: true,
            child: Column(children: [
              Text(turn ? "It's your turn!" : 'Your place in line', textAlign: TextAlign.center, style: t(20, color: C.muted, w: FontWeight.w800)),
              if (!turn)
                Text('#${e.position}', key: const ValueKey('queue-position'), textAlign: TextAlign.center, style: t(72, color: C.maroon, w: FontWeight.w900, h: 1.05)),
              Text(
                turn ? 'Connecting you to $_first. Keep your phone free.' : 'for $_first',
                key: const ValueKey('queue-status-line'),
                textAlign: TextAlign.center,
                style: t(18, color: C.deep, w: FontWeight.w800, h: 1.3),
              ),
            ]),
          ),
          const SizedBox(height: 16),
          const BookNotice(key: ValueKey('queue-whatsapp-note'), text: kQueueWhatsappLine, icon: Icons.chat_rounded, teal: true),
          const SizedBox(height: 14),
          const DesiMogra(),
        ]),
      ),
      if (!turn)
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 20),
          child: SizedBox(
            height: 56,
            width: double.infinity,
            child: OutlinedButton(
              key: const ValueKey('queue-leave'),
              style: OutlinedButton.styleFrom(foregroundColor: C.maroon, side: const BorderSide(color: C.maroon, width: 2), shape: const StadiumBorder()),
              onPressed: _busy ? null : () => unawaited(_leave()),
              child: Text(_busy ? 'PLEASE WAIT…' : 'LEAVE THE QUEUE', style: t(16, color: C.maroon, w: FontWeight.w900)),
            ),
          ),
        ),
    ]);
  }
}

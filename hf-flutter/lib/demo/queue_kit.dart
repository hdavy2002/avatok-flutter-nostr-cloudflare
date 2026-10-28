import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../data/call_flags.dart';
import '../data/models/queue.dart';
import '../data/presence_store.dart';
import '../data/repos/bookings_repo.dart';
import '../data/repos/presence_repo.dart';
import '../data/repos/queue_repo.dart';
import '../data/services.dart';
import '../data/telemetry.dart';
import 'call_kit.dart';
import 'call_safety_kit.dart'; // [HF-CALL-SAFETY-APP]
import 'data.dart';
import 'notify_me_button.dart';
import 'theme.dart';
import 'widgets.dart';

/// [HF-CALL-MODES-E2] Call modes and the call queue, both sides. Everything here is only reachable while the public flags
/// (`CallFlags.modes`, `CallFlags.queue`) are on; with them off the old Online/Offline and Call now screens are untouched.

// ======================================================================================== influencer: three-way mode

class _ModeOption {
  const _ModeOption(this.mode, this.title, this.line, this.icon);
  final String mode;
  final String title;
  final String line;
  final IconData icon;
}

const List<_ModeOption> _modeOptions = [
  _ModeOption('online', 'Online', 'Instant calls, your queue and bookings.', Icons.wifi_tethering_rounded),
  _ModeOption('bookings_only', 'Bookings only', 'By appointment. No instant calls or queue.', Icons.event_available_rounded),
  _ModeOption('offline', 'Offline', 'No instant calls, queue or new bookings.', Icons.nightlight_round),
];

/// "Online", "Bookings only" or "Offline".
String hostModeLabel(String mode) => switch (mode) {
      'online' => 'Online',
      'offline' => 'Offline',
      _ => 'Bookings only',
    };

String hostModeToast(String mode) => switch (mode) {
      'online' => 'You are online. Fans can call you now.',
      'offline' => 'You are offline. Calls already booked will still ring.',
      _ => 'Bookings only. Fans can book you, but not call right away.',
    };

/// The sentence for the Offline confirmation. [booked] is the number of booked calls, or -1 when it could not be read.
String offlineWarning(int booked) {
  if (booked == 1) return 'You have 1 booked call. It will still ring.';
  if (booked > 1) return 'You have $booked booked calls. They will still ring.';
  return 'Calls already booked will still ring.';
}

/// Opens the Online / Bookings only / Offline choice (the footer button and the Home card both call this).
Future<void> showHostModeSheet(BuildContext context, {String surface = 'footer', PresenceStore? store, BookingsRepo? bookings}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: C.clear,
    builder: (_) => HostModeSheet(surface: surface, store: store, bookings: bookings),
  );
}

class HostModeSheet extends StatelessWidget {
  const HostModeSheet({super.key, this.surface = 'footer', this.store, this.bookings});

  final String surface;

  /// Tests inject these; the app uses [PresenceStore.instance] and [Services].
  final PresenceStore? store;
  final BookingsRepo? bookings;

  PresenceStore get _store => store ?? PresenceStore.instance;

  Future<int> _bookedCount() async {
    try {
      final list = await (bookings ?? Services.instance.bookingsRepo).hostBookings();
      return list.where((b) => !b.isPending && !b.isPast).length;
    } catch (_) {
      return -1;
    }
  }

  Future<void> _pick(BuildContext context, String mode) async {
    final st = _store;
    if (st.saving) return;
    if (mode == st.mode) {
      Navigator.of(context).pop();
      return;
    }
    final messenger = ScaffoldMessenger.of(context);
    if (mode == 'offline') {
      final n = await _bookedCount();
      if (!context.mounted) return;
      if (n != 0) {
        final ok = await hfConfirm(context, title: 'Go offline?', body: offlineWarning(n), confirmLabel: 'Go offline');
        if (!ok || !context.mounted) return;
      }
    }
    final go = GoRouter.of(context); // [HF-CALL-SAFETY-APP] captured before the sheet closes
    Navigator.of(context).pop();
    final from = st.mode;
    final err = await st.setMode(mode);
    if (err != null && SafetyGate.handle(go, st.lastErrorCode, surface: surface)) return;
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(err ?? hostModeToast(mode))));
    if (err == null) Telemetry.event('hf_app_mode_changed', {'from': from, 'to': mode, 'surface': surface});
  }

  @override
  Widget build(BuildContext context) {
    final st = _store;
    return Container(
      decoration: const BoxDecoration(color: C.ivory, borderRadius: BorderRadius.vertical(top: Radius.circular(28))),
      padding: EdgeInsets.fromLTRB(16, 12, 16, MediaQuery.paddingOf(context).bottom + 16),
      child: SingleChildScrollView(
        child: ListenableBuilder(
          listenable: st,
          builder: (context, _) => Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(child: Container(width: 44, height: 5, decoration: BoxDecoration(color: C.brass, borderRadius: BorderRadius.circular(3)))),
              const SizedBox(height: 14),
              Semantics(header: true, child: Text('Your calls', style: t(24, color: C.maroon, w: FontWeight.w900))),
              const SizedBox(height: 4),
              Text(
                st.onCall ? 'You are on a call right now. This changes what happens next.' : 'Choose how fans can reach you.',
                style: t(15, color: C.muted, w: FontWeight.w700, h: 1.35),
              ),
              const SizedBox(height: 12),
              for (final o in _modeOptions) ...[
                _ModeTile(option: o, on: st.mode == o.mode, busy: st.saving, onTap: () => unawaited(_pick(context, o.mode))),
                const SizedBox(height: 10),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _ModeTile extends StatelessWidget {
  const _ModeTile({required this.option, required this.on, required this.busy, required this.onTap});

  final _ModeOption option;
  final bool on;
  final bool busy;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: on,
      label: '${option.title}. ${option.line}',
      excludeSemantics: true,
      child: Material(
        key: ValueKey('mode-${option.mode}'),
        color: on ? C.lavtint : C.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20), side: BorderSide(color: on ? C.maroon : C.line, width: on ? 2.5 : 1.5)),
        child: InkWell(
          borderRadius: BorderRadius.circular(20),
          onTap: busy ? null : onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 64),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              child: Row(children: [
                Icon(option.icon, color: on ? C.maroon : C.muted, size: 26),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(option.title, style: t(18, color: C.maroon, w: FontWeight.w900)),
                    Text(option.line, style: t(14, color: C.muted, w: FontWeight.w700, h: 1.3)),
                  ]),
                ),
                if (on) const Icon(Icons.check_circle_rounded, color: C.maroon, size: 26),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// Home card that replaces the old "You are ONLINE" card while call modes are on.
class HostModeCard extends StatelessWidget {
  const HostModeCard({super.key, required this.store, this.onTap});

  final PresenceStore store;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final mode = store.mode;
    final online = mode == 'online';
    final ink = online ? C.onlineInk : C.deep;
    final icon = online ? Icons.wifi_tethering_rounded : (mode == 'offline' ? Icons.nightlight_round : Icons.event_available_rounded);
    final line = store.onCall
        ? 'You are on a call right now.'
        : switch (mode) {
            'online' => 'Fans can call you, join your queue and book you.',
            'offline' => 'No new calls or bookings. Booked calls still ring.',
            _ => 'Fans can book a time. No instant calls.',
          };
    return Semantics(
      button: true,
      label: 'You are ${hostModeLabel(mode)}. $line Tap to change',
      excludeSemantics: true,
      child: Material(
        key: const ValueKey('home-mode-card'),
        color: online ? C.onlineBg : C.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24), side: BorderSide(color: online ? C.onlineLine : C.line, width: 2)),
        child: InkWell(
          borderRadius: BorderRadius.circular(24),
          onTap: onTap ?? () => unawaited(showHostModeSheet(context, surface: 'home')),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 72),
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Row(children: [
                Container(
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(color: online ? C.white : C.lavtint, shape: BoxShape.circle),
                  child: Icon(icon, color: online ? C.onlineInk : C.maroon, size: 26),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('You are ${hostModeLabel(mode).toUpperCase()}', style: t(20, color: ink, w: FontWeight.w900)),
                    Text(line, style: t(14, color: online ? C.onlineInk : C.muted, w: FontWeight.w700, h: 1.3)),
                  ]),
                ),
                Icon(Icons.chevron_right_rounded, color: ink),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

// ======================================================================================== influencer: her queue

/// Loads her queue and pauses / resumes it. Shared by the Home card and the settings rows.
class HostQueueModel extends ChangeNotifier {
  HostQueueModel(this._repo, {PresenceStore? store}) : _store = store;

  final QueueRepo _repo;
  final PresenceStore? _store;

  HostQueue? queue;
  bool loading = false;
  Object? error;
  bool saving = false;

  Future<void> load() async {
    if (loading) return;
    loading = true;
    if (queue == null) error = null;
    notifyListeners();
    try {
      queue = await _repo.hostQueue();
      error = null;
      _store?.noteQueue(waiting: queue!.waiting, paused: queue!.paused);
    } catch (e) {
      error = e;
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  /// Null on success, else the reason in plain English.
  Future<String?> setPaused(bool paused) async {
    if (saving) return null;
    saving = true;
    notifyListeners();
    try {
      queue = await _repo.setPaused(paused);
      error = null;
      _store?.noteQueue(waiting: queue!.waiting, paused: queue!.paused);
      return null;
    } catch (e) {
      return QueueProblemInfo.of(e).message;
    } finally {
      saving = false;
      notifyListeners();
    }
  }
}

/// "3 waiting in your queue", the first names, and Pause / Resume. Shown on Home while the queue flag is on.
class HostQueueCard extends StatefulWidget {
  const HostQueueCard({super.key, this.repo, this.store, this.poll = const Duration(seconds: 30)});

  final QueueRepo? repo;
  final PresenceStore? store;

  /// How often the count refreshes while the card is on screen. Tests pass null.
  final Duration? poll;

  @override
  State<HostQueueCard> createState() => _HostQueueCardState();
}

class _HostQueueCardState extends State<HostQueueCard> {
  late final HostQueueModel _m = HostQueueModel(widget.repo ?? Services.instance.queueRepo, store: widget.store ?? PresenceStore.instance);
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    unawaited(_m.load());
    final p = widget.poll;
    if (p != null) _timer = Timer.periodic(p, (_) => unawaited(_m.load()));
  }

  @override
  void dispose() {
    _timer?.cancel();
    _m.dispose();
    super.dispose();
  }

  Future<void> _toggle(HostQueue q) async {
    final err = await _m.setPaused(!q.paused);
    if (err != null && mounted) toast(context, err);
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _m,
      builder: (context, _) {
        final q = _m.queue;
        return Container(
          key: const ValueKey('host-queue-card'),
          width: double.infinity,
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: C.white,
            borderRadius: BorderRadius.circular(24),
            border: Border.all(color: C.line, width: 1.5),
          ),
          child: _body(q),
        );
      },
    );
  }

  Widget _body(HostQueue? q) {
    if (q == null) {
      if (_m.error != null) {
        return Row(children: [
          Expanded(child: Text('We could not load your queue.', style: t(15, color: C.muted, w: FontWeight.w700))),
          TextButton(
            style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
            onPressed: () => unawaited(_m.load()),
            child: Text('Try again', style: t(15, color: C.maroon, w: FontWeight.w800)),
          ),
        ]);
      }
      return Row(children: [
        const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(color: C.maroon, strokeWidth: 3)),
        const SizedBox(width: 12),
        Text('Loading your queue…', style: t(15, color: C.muted, w: FontWeight.w700)),
      ]);
    }
    final title = q.waiting == 0 ? 'No one is waiting in your queue' : '${q.waiting} waiting in your queue';
    final sub = q.paused ? 'Queue paused. Fans cannot join right now.' : (q.waiting == 0 ? 'Fans who find you on a call can wait here.' : q.namesLine);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        const Icon(Icons.groups_rounded, color: C.maroon, size: 26),
        const SizedBox(width: 10),
        Expanded(child: Text(title, key: const ValueKey('queue-title'), style: t(18, color: C.maroon, w: FontWeight.w900))),
      ]),
      if (sub.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4, left: 36), child: Text(sub, style: t(14, color: C.muted, w: FontWeight.w700, h: 1.3))),
      const SizedBox(height: 10),
      SizedBox(
        height: 48,
        width: double.infinity,
        child: OutlinedButton(
          key: const ValueKey('queue-pause'),
          style: OutlinedButton.styleFrom(
            foregroundColor: C.maroon,
            side: const BorderSide(color: C.maroon, width: 2),
            shape: const StadiumBorder(),
          ),
          onPressed: _m.saving ? null : () => unawaited(_toggle(q)),
          child: Text(q.paused ? 'Resume queue' : 'Pause queue', style: t(16, color: C.maroon, w: FontWeight.w900)),
        ),
      ),
    ]);
  }
}

/// Settings rows for an influencer: how many wait, and a Pause switch. Rendered inside a SettingsCard by settings_real.dart.
class HostQueueSettingsRows extends StatefulWidget {
  const HostQueueSettingsRows({super.key, this.repo, this.store});

  final QueueRepo? repo;
  final PresenceStore? store;

  @override
  State<HostQueueSettingsRows> createState() => _HostQueueSettingsRowsState();
}

class _HostQueueSettingsRowsState extends State<HostQueueSettingsRows> {
  late final HostQueueModel _m = HostQueueModel(widget.repo ?? Services.instance.queueRepo, store: widget.store ?? PresenceStore.instance);

  @override
  void initState() {
    super.initState();
    unawaited(_m.load());
  }

  @override
  void dispose() {
    _m.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _m,
      builder: (context, _) {
        final q = _m.queue;
        if (q == null) {
          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: _m.error != null
                ? Row(children: [
                    Expanded(child: Text('We could not load your queue.', style: t(15, color: C.muted, w: FontWeight.w700))),
                    TextButton(
                      style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
                      onPressed: () => unawaited(_m.load()),
                      child: Text('Try again', style: t(15, color: C.maroon, w: FontWeight.w800)),
                    ),
                  ])
                : Text('Loading your queue…', style: t(15, color: C.muted, w: FontWeight.w700)),
          );
        }
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(
            padding: const EdgeInsets.only(top: 4, bottom: 4),
            child: Text(
              q.waiting == 0 ? 'No one is waiting in your queue.' : '${q.waiting} waiting in your queue: ${q.namesLine}',
              key: const ValueKey('queue-settings-line'),
              style: t(15, w: FontWeight.w700, h: 1.35),
            ),
          ),
          SwitchListTile(
            key: const ValueKey('queue-pause-switch'),
            contentPadding: EdgeInsets.zero,
            title: Text('Pause the queue', style: t(16, w: FontWeight.w800)),
            subtitle: Text('Fans cannot join while it is paused. Fans already waiting keep their place for 15 minutes.', style: t(14, color: C.muted, w: FontWeight.w700, h: 1.3)),
            value: q.paused,
            activeThumbColor: C.white,
            activeTrackColor: C.rani,
            inactiveThumbColor: C.white,
            inactiveTrackColor: C.brass,
            trackOutlineColor: const WidgetStatePropertyAll(C.clear),
            onChanged: _m.saving
                ? null
                : (v) async {
                    final err = await _m.setPaused(v);
                    if (err != null && context.mounted) toast(context, err);
                  },
          ),
        ]);
      },
    );
  }
}

// ======================================================================================== fan: call buttons from callState

/// Does Call now need the state sheet instead of the normal confirm sheet? Only with call modes on, a known state, and something
/// to offer. With the queue off, "connecting" and "queue only" fall back to the old flow (the server decides).
bool needsCallStateSheet(Influencer who) {
  if (!CallFlags.modes) return false;
  final s = who.callState;
  if (s == null || s == HostCallState.available) return false;
  if (!CallFlags.queue && (s == HostCallState.connecting || s == HostCallState.queueOnly)) return false;
  return true;
}

/// The label of the main call button on a card, or null when the card should show no call button. Used by the feed.
String? callActionLabel(HostCallState? s) {
  if (s == null) return 'Call now';
  switch (s) {
    case HostCallState.available:
      return 'Call now';
    case HostCallState.onCall:
    case HostCallState.connecting:
    case HostCallState.queueOnly:
      return CallFlags.queue ? 'Join the queue' : null;
    case HostCallState.appointments:
    case HostCallState.offline:
      return null;
  }
}

/// Status line for the feed: (title, chip, colour). Null when the old presence-based wording should be used.
(String, String, Color)? callStateDot(HostCallState? s) {
  if (!CallFlags.modes || s == null) return null;
  return switch (s) {
    HostCallState.available => ('Influencer is online', 'Available', C.onlineDot),
    HostCallState.onCall => ('Influencer is on a call', 'On a call', C.marigold),
    HostCallState.connecting => ('Influencer is online', 'Online', C.onlineDot),
    HostCallState.queueOnly => ('Influencer has fans waiting', 'Queue', C.marigold),
    HostCallState.appointments => ('Available by appointment', 'By appointment', C.marigold),
    HostCallState.offline => ('Influencer is offline', 'Offline', C.ruby),
  };
}

/// The message and the buttons for a host who cannot take an instant call right now (spec 2.1 table).
/// Used inside the state sheet and inside the "not available" part of the call confirm sheet.
class CallStateActions extends StatelessWidget {
  const CallStateActions({
    super.key,
    required this.slug,
    required this.first,
    required this.state,
    this.canQueue,
    this.canBook,
    this.waiting = 0,
    this.notifyRepo,
    this.onDone,
  });

  final String slug;
  final String first;
  final HostCallState state;

  /// The server's own answer on a refused call (`canQueue` / `canBook`); null = work it out from [state].
  final bool? canQueue;
  final bool? canBook;
  final int waiting;
  final PresenceRepo? notifyRepo;

  /// Called before moving to another screen (the sheet closes itself here).
  final VoidCallback? onDone;

  bool get _queue =>
      CallFlags.queue && (canQueue ?? (state == HostCallState.onCall || state == HostCallState.connecting || state == HostCallState.queueOnly));
  bool get _book => canBook ?? (state != HostCallState.offline);
  bool get _notify => !_queue || state == HostCallState.appointments || state == HostCallState.offline;

  String get _message {
    final w = waiting > 0 ? ' $waiting ${waiting == 1 ? 'person is' : 'people are'} waiting.' : '';
    switch (state) {
      case HostCallState.onCall:
        return '$first is on a call right now.$w ${_queue ? 'Join the queue or book a time.' : 'Book a time, or get a WhatsApp when she is free.'}';
      case HostCallState.connecting:
        return '$first is about to take a call.$w ${_queue ? 'Join the queue to keep your place.' : ''}'.trim();
      case HostCallState.queueOnly:
        return '$first has people waiting.$w Join the queue to keep your place.';
      case HostCallState.appointments:
        return '$first is available by appointment. Book a time that suits you.';
      case HostCallState.offline:
        return '$first is offline right now. We will WhatsApp you when she is back.';
      case HostCallState.available:
        return '';
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text(_message, key: const ValueKey('call-state-message'), textAlign: TextAlign.center, style: t(16, color: C.deep, w: FontWeight.w700, h: 1.4)),
      const SizedBox(height: 16),
      if (_queue) ...[
        CallPill(
          label: 'JOIN THE QUEUE',
          kind: CallPillKind.plum,
          height: 58,
          onTap: () {
            final go = GoRouter.of(context);
            onDone?.call();
            unawaited(go.push('/queue/${Uri.encodeComponent(slug)}?n=$waiting'));
          },
        ),
        const SizedBox(height: 10),
      ],
      if (_notify) ...[
        NotifyMeButton(slug: slug, firstName: first, repo: notifyRepo, big: true),
        const SizedBox(height: 10),
      ],
      if (_book)
        CallPill(
          label: 'BOOK A TIME',
          kind: CallPillKind.gold,
          height: 58,
          onTap: () {
            final go = GoRouter.of(context);
            onDone?.call();
            unawaited(go.push('/book/${Uri.encodeComponent(slug)}'));
          },
        ),
    ]);
  }
}

String _stateTitle(HostCallState s, String first) => switch (s) {
      HostCallState.onCall => '$first is on a call',
      HostCallState.appointments => 'Available by appointment',
      HostCallState.offline => '$first is offline',
      HostCallState.queueOnly => '$first has people waiting',
      _ => 'Call $first?',
    };

/// Call now when the influencer cannot take an instant call: shows what to do instead (spec 2.1).
Future<void> showCallStateSheet(BuildContext context, Influencer who) {
  final s = who.callState ?? HostCallState.offline;
  final first = who.name.split(' ').first;
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: C.clear,
    builder: (sheetContext) => CallSheetFrame(
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, MediaQuery.paddingOf(sheetContext).bottom + 20),
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            CallSheetHead(who: who, title: _stateTitle(s, first)),
            const SizedBox(height: 14),
            CallStateActions(
              slug: who.id,
              first: first,
              state: s,
              waiting: who.queueWaiting,
              onDone: () => Navigator.of(sheetContext).pop(),
            ),
          ]),
        ),
      ),
    ),
  );
}

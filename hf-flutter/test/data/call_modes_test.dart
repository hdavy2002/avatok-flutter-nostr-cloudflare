import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/call_flags.dart';
import 'package:hf_app/data/models/booking.dart';
import 'package:hf_app/data/models/call.dart';
import 'package:hf_app/data/models/queue.dart';
import 'package:hf_app/data/models/reel.dart';
import 'package:hf_app/data/presence_store.dart';
import 'package:hf_app/data/repos/bookings_repo.dart';
import 'package:hf_app/data/repos/calls_repo.dart';
import 'package:hf_app/data/repos/config_repo.dart';
import 'package:hf_app/data/repos/presence_repo.dart';
import 'package:hf_app/data/repos/queue_repo.dart';
import 'package:hf_app/data/telemetry.dart';

typedef Handler = Object? Function(String method, String path, Map<String, Object?>? query, Object? body);

class FakeApiClient extends ApiClient {
  FakeApiClient(this.handler) : super(origin: 'https://api.test');

  Handler handler;
  final List<String> calls = [];
  final List<Object?> bodies = [];
  final List<Map<String, Object?>?> queries = [];

  @override
  Future<Object?> request(String method, String path,
      {Map<String, Object?>? query, Object? body, bool auth = true, Map<String, String>? headers}) async {
    calls.add('$method $path');
    bodies.add(body);
    queries.add(query);
    final out = handler(method, path, query, body);
    if (out is ApiException) throw out;
    return out;
  }
}

ApiException _err(int status, String code, [Map<String, Object?> extra = const {}]) =>
    ApiException(kind: ApiFailure.http, status: status, code: code, extra: extra);

void main() {
  tearDown(CallFlags.reset);

  group('flags', () {
    test('an old config (no new keys) turns everything off', () {
      final c = AppConfig.fromJson(<String, dynamic>{'hfAppMinBuild': 5});
      expect(c.callModesEnabled, isFalse);
      expect(c.callQueueEnabled, isFalse);
      expect(c.callChunkBillingEnabled, isFalse);
      expect(c.bookingLengthsEnabled, isFalse);
    });

    test('only a real true turns a flag on', () {
      final c = AppConfig.fromJson({
        'hfCallModesEnabled': true,
        'hfCallQueueEnabled': 'yes',
        'hfCallChunkBillingEnabled': 1,
        'hfBookingLengthsEnabled': true,
      });
      expect(c.callModesEnabled, isTrue);
      expect(c.callQueueEnabled, isFalse);
      expect(c.callChunkBillingEnabled, isFalse);
      expect(c.bookingLengthsEnabled, isTrue);
      CallFlags.apply(c);
      expect(CallFlags.modes, isTrue);
      expect(CallFlags.queue, isFalse);
      expect(CallFlags.bookingLengths, isTrue);
      CallFlags.reset();
      expect(CallFlags.modes, isFalse);
    });

    test('length labels and the default length follow the flag', () {
      expect(kBookingLengths, [15, 30, 60, 120, 180, 240, 300]);
      expect([for (final m in kBookingLengths) lengthLabel(m)], ['15 min', '30 min', '1 h', '2 h', '3 h', '4 h', '5 h']);
      expect(defaultBookingMinutes(), 10);
      CallFlags.bookingLengths = true;
      expect(defaultBookingMinutes(), 15);
    });

    test('the new events are in the telemetry catalog', () {
      expect(
        Telemetry.catalogEvents,
        containsAll([
          'hf_app_mode_changed',
          'hf_app_queue_joined',
          'hf_app_queue_left',
          'hf_app_queue_failed',
          'hf_app_booking_length_picked',
          'hf_app_call_topup_tapped',
        ]),
      );
    });
  });

  group('presence payloads', () {
    test('old payload: online/busy mean Online, offline means Bookings only', () {
      final a = PresenceState.fromJson({'ok': true, 'presence': 'online'});
      expect((a.mode, a.onCall, a.queueWaiting), ('online', false, 0));
      final b = PresenceState.fromJson({'ok': true, 'presence': 'busy'});
      expect((b.mode, b.onCall), ('online', true));
      final c = PresenceState.fromJson({'ok': true, 'presence': 'offline'});
      expect(c.mode, 'bookings_only');
      expect(PresenceState.fromJson(<String, dynamic>{}).presence, 'offline');
    });

    test('new payload carries mode, onCall and the queue', () {
      final s = PresenceState.fromJson({
        'ok': true,
        'presence': 'offline',
        'mode': 'offline',
        'onCall': false,
        'queue': {'waiting': 3, 'paused': true, 'open': false},
      });
      expect(s.mode, 'offline');
      expect(s.queueWaiting, 3);
      expect(s.queuePaused, isTrue);
      expect(s.queueOpen, isFalse);
      expect(PresenceState.fromJson({'presence': 'online', 'mode': 'nonsense'}).mode, 'online');
    });

    test('setMode sends {mode} and keeps the server answer', () async {
      final api = FakeApiClient((m, p, q, b) => {'ok': true, 'presence': 'offline', 'mode': 'bookings_only', 'onCall': false, 'queue': {'waiting': 0, 'paused': false, 'open': false}});
      final store = PresenceStore(PresenceRepo(api));
      expect(await store.setMode('bookings_only'), isNull);
      expect(api.calls, ['PUT /api/hosts/me/presence']);
      expect(api.bodies.single, {'mode': 'bookings_only'});
      expect(store.mode, 'bookings_only');
      expect(store.online, isFalse);
    });

    test('setMode is optimistic and rolls back with the reason', () async {
      late PresenceStore store;
      final seen = <String>[];
      final api = FakeApiClient((m, p, q, b) {
        seen.add(store.mode);
        return const ApiException(kind: ApiFailure.http, status: 503, code: 'unavailable', message: 'Try again in a little while.');
      });
      store = PresenceStore(PresenceRepo(api));
      store.mode = 'online';
      store.presence = 'online';
      store.queueWaiting = 2;
      expect(await store.setMode('offline'), 'Try again in a little while.');
      expect(seen, ['offline']);
      expect(store.mode, 'online');
      expect(store.presence, 'online');
      expect(store.queueWaiting, 2);
    });

    test('leaving Online clears the waiting count at once; on a call the presence stays busy', () async {
      final api = FakeApiClient((m, p, q, b) => {'ok': true, 'presence': 'busy', 'mode': 'offline', 'onCall': true, 'queue': {'waiting': 0, 'paused': false, 'open': false}});
      final store = PresenceStore(PresenceRepo(api));
      store.onCall = true;
      store.queueWaiting = 4;
      await store.setMode('offline');
      expect(store.queueWaiting, 0);
      expect(store.busy, isTrue);
      expect(store.mode, 'offline');
    });

    test('the old setOnline still sends the legacy {online} body', () async {
      final api = FakeApiClient((m, p, q, b) => {'ok': true, 'presence': 'online'});
      final store = PresenceStore(PresenceRepo(api));
      expect(await store.setOnline(true), isNull);
      expect(api.bodies.single, {'online': true});
      expect(store.mode, 'online');
    });
  });

  group('queue payloads', () {
    test('host queue: first names, count and pause; names line', () {
      final q = HostQueue.fromJson({
        'ok': true,
        'waiting': 4,
        'paused': false,
        'entries': [
          {'position': 1, 'firstName': 'Priya', 'joinedAt': 10},
          {'position': 2, 'firstName': 'Amit', 'joinedAt': 20},
          {'position': 3, 'firstName': 'Neha', 'joinedAt': 30},
          {'position': 4, 'firstName': 'Ravi', 'joinedAt': 40},
        ],
      });
      expect(q.waiting, 4);
      expect(q.entries.first.firstName, 'Priya');
      expect(q.namesLine, 'Priya, Amit and 2 more');
      expect(const HostQueue().namesLine, '');
      expect(HostQueue.fromJson(<String, dynamic>{}).waiting, 0);
      expect(HostQueue.fromJson({'entries': [{'position': 1}]}).waiting, 1);
    });

    test('my queue entry: waiting, offered, over, and none', () {
      expect(MyQueue.fromJson({'ok': true, 'entry': null}).entry, isNull);
      final w = MyQueue.fromJson({'entry': {'entryId': 'e1', 'hostSlug': 'priya', 'hostName': 'Priya Rao', 'position': 2, 'status': 'waiting'}}).entry!;
      expect((w.position, w.isWaiting, w.isOffered, w.isOver), (2, true, false, false));
      final o = MyQueue.fromJson({'entry': {'entryId': 'e1', 'hostSlug': 'priya', 'position': 1, 'status': 'offered', 'callId': 'c9'}}).entry!;
      expect((o.isOffered, o.callId), (true, 'c9'));
      expect(MyQueueEntry.fromJson({'status': 'skipped'}).isOver, isTrue);
    });

    test('queue repo paths and bodies', () async {
      final api = FakeApiClient((m, p, q, b) {
        if (m == 'POST') return {'ok': true, 'entryId': 'e1', 'position': 3, 'waiting': 3};
        if (p == '/api/hosts/me/queue') return {'ok': true, 'waiting': 1, 'paused': b is Map && b['paused'] == true, 'entries': <Object?>[]};
        return <String, Object?>{};
      });
      final repo = QueueRepo(api);
      final j = await repo.join('priya rao');
      expect((j.entryId, j.position, j.waiting), ('e1', 3, 3));
      await repo.leave('priya');
      final paused = await repo.setPaused(true);
      expect(paused.paused, isTrue);
      await repo.hostQueue();
      await repo.mine();
      expect(api.calls, [
        'POST /api/hf/hosts/priya%20rao/queue',
        'DELETE /api/hf/hosts/priya/queue',
        'PUT /api/hosts/me/queue',
        'GET /api/hosts/me/queue',
        'GET /api/hf/queue/me',
      ]);
      expect(api.bodies[2], {'paused': true});
    });

    test('join errors map to problems', () {
      expect(QueueProblemInfo.of(_err(409, 'queue_closed')).problem, QueueProblem.closed);
      expect(QueueProblemInfo.of(_err(409, 'queue_full')).problem, QueueProblem.full);
      final a = QueueProblemInfo.of(_err(409, 'already_queued', {'hostSlug': 'amit'}));
      expect((a.problem, a.hostSlug), (QueueProblem.alreadyQueued, 'amit'));
      final l = QueueProblemInfo.of(_err(402, 'low_balance', {'shortfallPaise': 4500}));
      expect((l.problem, l.shortfallPaise), (QueueProblem.lowBalance, 4500));
      expect(QueueProblemInfo.of(_err(403, 'not_verified')).problem, QueueProblem.notVerified);
      expect(QueueProblemInfo.of(_err(500, 'boom')).problem, QueueProblem.other);
      expect(QueueProblemInfo.of(ApiException.offline()).message, ApiException.offlineText);
    });
  });

  group('callState', () {
    test('every state parses; unknown or missing is null', () {
      expect(hostCallStateOf('available'), HostCallState.available);
      expect(hostCallStateOf('on_call'), HostCallState.onCall);
      expect(hostCallStateOf('connecting'), HostCallState.connecting);
      expect(hostCallStateOf('queue_only'), HostCallState.queueOnly);
      expect(hostCallStateOf('appointments'), HostCallState.appointments);
      expect(hostCallStateOf('offline'), HostCallState.offline);
      expect(hostCallStateOf('x'), isNull);
      expect(hostCallStateOf(null), isNull);
    });

    test('a host from an old server has no callState; a new one carries state and queue', () {
      final old = ReelHost.fromJson({'slug': 'priya', 'name': 'Priya', 'presence': 'busy'});
      expect(old.callState, isNull);
      expect(old.queueOpen, isFalse);
      expect(old.online, isTrue);
      final h = ReelHost.fromJson({'slug': 'priya', 'name': 'Priya', 'presence': 'busy', 'callState': 'on_call', 'queue': {'open': true, 'waiting': 2}});
      expect(h.callState, HostCallState.onCall);
      expect(h.queueOpen, isTrue);
      expect(h.queueWaiting, 2);
    });

    test('a public profile reads callState too', () {
      final p = PublicProfile.fromJson({'slug': 'priya', 'displayName': 'Priya', 'status': 'offline', 'callState': 'appointments', 'queue': {'open': false, 'waiting': 0}, 'reels': <Object?>[]});
      expect(p.host.callState, HostCallState.appointments);
      expect(PublicProfile.fromJson({'slug': 'priya', 'displayName': 'Priya', 'status': 'online'}).host.callState, isNull);
    });

    test('a refused call carries reason, canQueue, canBook and the waiting count', () {
      final i = CallProblemInfo.of(_err(409, 'host_unavailable', {'reason': 'on_call', 'canQueue': true, 'canBook': true, 'queueWaiting': 3}));
      expect(i.problem, CallProblem.hostUnavailable);
      expect((i.reason, i.canQueue, i.canBook, i.queueWaiting), (HostCallState.onCall, true, true, 3));
      final old = CallProblemInfo.of(_err(409, 'host_unavailable'));
      expect((old.reason, old.canQueue, old.queueWaiting), (null, null, 0));
    });
  });

  group('call status', () {
    test('an old payload has no funding fields', () {
      final s = CallStatus.fromJson({'id': 'c1', 'status': 'connected', 'phase': 'connected', 'capAt': 1000});
      expect(s.fundedUntil, isNull);
      expect(s.short, isFalse);
      expect(s.source, isNull);
      expect(s.capAt, 1000);
    });

    test('a new payload carries fundedUntil, short, a moving capAt and the source', () {
      final s = CallStatus.fromJson({'id': 'c1', 'status': 'connected', 'phase': 'connected', 'fundedUntil': 5000, 'short': true, 'capAt': 6000, 'source': 'queue'});
      expect((s.fundedUntil, s.short, s.capAt, s.source), (5000, true, 6000, 'queue'));
    });
  });

  group('booking lengths', () {
    test('an old slots payload: ten minutes, no lengths', () {
      final s = HostSlots.fromJson({'ratePerMin': 20, 'holdPaise': 20000, 'days': <String, Object?>{}});
      expect(s.minutes, 10);
      expect(s.durationsMinutes, isEmpty);
      expect(s.holdMinutes, isNull);
    });

    test('a new slots payload lists the lengths and the hold', () {
      final s = HostSlots.fromJson({
        'minutes': 30,
        'ratePerMin': 20,
        'holdPaise': 30000,
        'holdMinutes': 15,
        'durationsMinutes': [15, 30, 60, 120, 180, 240, 300],
        'days': <String, Object?>{},
      });
      expect(s.minutes, 30);
      expect(s.durationsMinutes, [15, 30, 60, 120, 180, 240, 300]);
      expect(s.holdMinutes, 15);
    });

    test('a row without minutes means 10, or 15 once lengths are on', () {
      Map<String, Object?> row() => {'id': 'b1', 'status': 'confirmed', 'startAt': '2026-10-22T10:30:00.000Z', 'day': '2026-10-22', 'time': '16:00'};
      expect(AppBooking.fromJson(row()).minutes, 10);
      CallFlags.bookingLengths = true;
      expect(AppBooking.fromJson(row()).minutes, 15);
      expect(AppBooking.fromJson({...row(), 'minutes': 60}).minutes, 60);
    });

    test('the slots call sends durationMinutes only when asked; book sends it only when given', () async {
      final api = FakeApiClient((m, p, q, b) => p.endsWith('/slots')
          ? {'ratePerMin': 20, 'holdPaise': 1, 'days': <String, Object?>{}}
          : {'booking': {'id': 'b1', 'status': 'confirmed', 'startAt': '2026-10-22T10:30:00.000Z', 'day': '2026-10-22', 'time': '16:00', 'minutes': 60, 'holdPaise': 1}});
      final repo = BookingsRepo(api);
      await repo.slots('maya');
      expect(api.queries.last?.containsKey('durationMinutes'), isFalse);
      await repo.slots('maya', durationMinutes: 60);
      expect(api.queries.last?['durationMinutes'], 60);
      await repo.book('maya', DateTime.utc(2026, 10, 22, 10, 30));
      expect((api.bodies.last as Map).containsKey('durationMinutes'), isFalse);
      await repo.book('maya', DateTime.utc(2026, 10, 22, 10, 30), durationMinutes: 60);
      expect((api.bodies.last as Map)['durationMinutes'], 60);
    });
  });
}

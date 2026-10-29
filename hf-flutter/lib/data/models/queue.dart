/// [HF-CALL-MODES-E2] Call-queue shapes (spec 2.2 / 2.5). Read defensively: a missing key is a calm default, because the
/// worker adds fields over time and the queue is dark until `hfCallQueueEnabled`.
library;

import '../api_exception.dart';

int _int(Object? v, [int d = 0]) => v is num ? v.toInt() : (v is String ? int.tryParse(v) ?? d : d);
String? _str(Object? v) => v is String && v.isNotEmpty ? v : null;

/// What a fan sees on a host's profile (spec 2.1 callState table). Unknown or missing values mean "use the old behaviour".
enum HostCallState { available, onCall, connecting, queueOnly, appointments, offline }

HostCallState? hostCallStateOf(Object? v) {
  switch (v) {
    case 'available':
      return HostCallState.available;
    case 'on_call':
      return HostCallState.onCall;
    case 'connecting':
      return HostCallState.connecting;
    case 'queue_only':
      return HostCallState.queueOnly;
    case 'appointments':
      return HostCallState.appointments;
    case 'offline':
      return HostCallState.offline;
  }
  return null;
}

/// One waiting fan as the influencer sees her queue: first names only, never numbers.
class HostQueueEntry {
  const HostQueueEntry({required this.position, required this.firstName, required this.joinedAt, this.name, this.handle, this.avatarUrl});

  factory HostQueueEntry.fromJson(Map<String, dynamic> j) => HostQueueEntry(
        position: _int(j['position']),
        firstName: _str(j['firstName']) ?? 'A fan',
        joinedAt: _int(j['joinedAt']),
        name: _str(j['name']),
        handle: _str(j['handle'])?.replaceFirst(RegExp(r'^@+'), ''),
        avatarUrl: _str(j['avatar_url']),
      );

  final int position;
  final String firstName;
  final int joinedAt;

  /// [HF-ME-SETTINGS-MOVE] Full name, @handle (no @) and round picture; null when the server did not send them.
  final String? name;
  final String? handle;
  final String? avatarUrl;

  /// The name to show: the full name, else the first name.
  String get shownName => name ?? firstName;
}

/// `GET/PUT /api/hosts/me/queue`.
class HostQueue {
  const HostQueue({this.waiting = 0, this.paused = false, this.entries = const [], this.notLive = false});

  factory HostQueue.fromJson(Map<String, dynamic> j) {
    final raw = j['entries'];
    final entries = [
      if (raw is List)
        for (final e in raw)
          if (e is Map) HostQueueEntry.fromJson(Map<String, dynamic>.from(e)),
    ];
    final w = j['waiting'];
    return HostQueue(waiting: w is num ? w.toInt() : entries.length, paused: j['paused'] == true, entries: entries, notLive: j['not_live'] == true);
  }

  /// [HF-ME-SETTINGS-MOVE] The influencer is not live yet: the server answers an empty queue (not an error).
  final bool notLive;

  final int waiting;
  final bool paused;
  final List<HostQueueEntry> entries;

  /// "Priya, Amit and 2 more" (at most two names are spelled out).
  String get namesLine {
    if (entries.isEmpty) return '';
    final names = [for (final e in entries.take(2)) e.firstName];
    final more = waiting - names.length;
    if (more <= 0) return names.join(' and ');
    return '${names.join(', ')} and $more more';
  }
}

/// `POST /api/hf/hosts/:slug/queue` -> `{entryId, position, waiting}`.
class QueueJoinResult {
  const QueueJoinResult({required this.entryId, required this.position, required this.waiting});

  factory QueueJoinResult.fromJson(Map<String, dynamic> j) =>
      QueueJoinResult(entryId: _str(j['entryId']) ?? '', position: _int(j['position'], 1), waiting: _int(j['waiting'], 1));

  final String entryId;
  final int position;
  final int waiting;
}

/// The fan's own place: `GET /api/hf/queue/me` -> `{entry: null | {...}}`.
class MyQueueEntry {
  const MyQueueEntry({required this.entryId, required this.hostSlug, required this.hostName, required this.position, required this.status, this.callId});

  factory MyQueueEntry.fromJson(Map<String, dynamic> j) => MyQueueEntry(
        entryId: _str(j['entryId']) ?? '',
        hostSlug: _str(j['hostSlug']) ?? '',
        hostName: _str(j['hostName']) ?? 'the influencer',
        position: _int(j['position'], 1),
        status: _str(j['status']) ?? 'waiting',
        callId: _str(j['callId']),
      );

  final String entryId;
  final String hostSlug;
  final String hostName;
  final int position;

  /// `waiting`, `offered`, `connected`, `done`, `left`, `skipped`, `expired`, `closed`.
  final String status;
  final String? callId;

  bool get isWaiting => status == 'waiting';

  /// It is this fan's turn: the call is being set up.
  bool get isOffered => status == 'offered' || status == 'connected';

  /// Gone for good: left, skipped, expired, closed or finished.
  bool get isOver => !isWaiting && !isOffered;
}

class MyQueue {
  const MyQueue({this.entry});

  factory MyQueue.fromJson(Map<String, dynamic> j) {
    final e = j['entry'];
    return MyQueue(entry: e is Map ? MyQueueEntry.fromJson(Map<String, dynamic>.from(e)) : null);
  }

  final MyQueueEntry? entry;
}

/// What a failed queue request means for the person (branch on this, never on message text).
enum QueueProblem { closed, full, alreadyQueued, lowBalance, notVerified, other }

class QueueProblemInfo {
  const QueueProblemInfo(this.problem, this.message, {this.shortfallPaise, this.hostSlug});

  final QueueProblem problem;
  final String message;
  final int? shortfallPaise;
  final String? hostSlug;

  static const String closedText = 'The queue is closed right now. You can book a time instead.';
  static const String fullText = 'The queue is full right now. Please try again a little later or book a time.';
  static const String alreadyText = 'You are already in a queue.';
  static const String notVerifiedText = 'Verify your WhatsApp number first, so we can tell you when it is your turn.';

  factory QueueProblemInfo.of(Object error) {
    if (error is! ApiException) return const QueueProblemInfo(QueueProblem.other, ApiException.genericText);
    switch (error.code) {
      case 'queue_closed':
        return const QueueProblemInfo(QueueProblem.closed, closedText);
      case 'queue_full':
        return const QueueProblemInfo(QueueProblem.full, fullText);
      case 'already_queued':
        return QueueProblemInfo(QueueProblem.alreadyQueued, alreadyText, hostSlug: _str(error.extra['hostSlug']));
      case 'low_balance':
        final s = error.extra['shortfallPaise'];
        return QueueProblemInfo(QueueProblem.lowBalance, error.userMessage, shortfallPaise: s is num ? s.toInt() : null);
      case 'not_verified':
        return const QueueProblemInfo(QueueProblem.notVerified, notVerifiedText);
    }
    return QueueProblemInfo(QueueProblem.other, error.userMessage);
  }
}

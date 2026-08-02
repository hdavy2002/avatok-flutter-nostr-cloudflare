/// Small per-call reservation/marker used at native and navigation boundaries.
///
/// Call IDs are unique, but callbacks can be replayed by Android, FCM, or the
/// live socket. Keeping the gate independent from Flutter makes the behavior
/// deterministic and regression-testable.
class CallTtlGate {
  CallTtlGate({required this.ttlMs});

  final int ttlMs;
  final Map<String, int> _markedAt = <String, int>{};

  void mark(String callId, {int? nowMs}) {
    if (callId.isEmpty) return;
    final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
    _prune(now);
    _markedAt[callId] = now;
  }

  bool contains(String callId, {int? nowMs}) {
    if (callId.isEmpty) return false;
    final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
    _prune(now);
    return _markedAt.containsKey(callId);
  }

  bool tryReserve(String callId, {int? nowMs}) {
    if (callId.isEmpty) return false;
    final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
    _prune(now);
    if (_markedAt.containsKey(callId)) return false;
    _markedAt[callId] = now;
    return true;
  }

  void release(String callId) => _markedAt.remove(callId);

  void _prune(int now) {
    _markedAt.removeWhere((_, at) => now - at > ttlMs);
  }
}

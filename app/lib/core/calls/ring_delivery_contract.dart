const int callRingLifetimeMs = 20000;

/// Fail closed for an explicitly expired invite. Older payloads without an
/// expiry use their send timestamp and the same canonical ring lifetime.
bool ringInviteIsFresh(Map<String, dynamic> data, {int? nowMs}) {
  final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
  final explicit = int.tryParse((data['tokenExpiresAt'] ?? '').toString());
  if (explicit != null && explicit > 0) return now < explicit;
  final sentAt = int.tryParse((data['ts'] ?? '').toString());
  if (sentAt != null && sentAt > 0) return now < sentAt + callRingLifetimeMs;
  // Backwards compatibility for already-installed producers. Once all server
  // paths carry expiry this branch can be changed to fail closed.
  return true;
}

/// How much of the server-owned ring lease remains. A late delivery receives
/// only the remainder; it never starts a fresh 20-second native ring.
int ringInviteRemainingMs(Map<String, dynamic> data, {int? nowMs}) {
  final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
  final explicit = int.tryParse((data['tokenExpiresAt'] ?? '').toString());
  final sentAt = int.tryParse((data['ts'] ?? '').toString());
  final expiry = explicit != null && explicit > 0
      ? explicit
      : (sentAt != null && sentAt > 0
          ? sentAt + callRingLifetimeMs
          : now + callRingLifetimeMs);
  return (expiry - now).clamp(0, callRingLifetimeMs).toInt();
}

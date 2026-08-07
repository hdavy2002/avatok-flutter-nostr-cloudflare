const int callRingLifetimeMs = 20000;

/// [CALL-4RINGS-1 2026-08-08] Absolute ceiling on a native ring, in ms.
///
/// The ring lifetime is no longer a single constant: with `callRealRingCount`
/// the server grants `max(20s, receptionistRings * ringCycleMs + 4s)` so that
/// four genuine ring cycles have room to happen, and both `receptionistRings`
/// and `ringCycleMs` are KV-flippable. Clamping the native ring to the old
/// 20 000 hard-coded here would cut the phone off mid-way through the final
/// cycle — silencing exactly the ring the handoff decision depends on.
///
/// So the per-call bound is derived from the invite itself (`tokenExpiresAt`
/// minus `ts`, both server-stamped) and this stays only as a sanity ceiling
/// against a malformed or hostile payload asking a phone to ring for an hour.
const int callRingLifetimeMaxMs = 120000;

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
  // [CALL-4RINGS-1] The per-call lease, not a constant. When the server told us
  // BOTH when it sent the invite and when the lease expires, the difference IS
  // the lifetime this call was granted — which is now 20 s or more depending on
  // `receptionistRings` × `ringCycleMs`. Only when one of those is missing (an
  // older producer) do we fall back to the legacy 20 s bound.
  final leaseMs = (explicit != null && explicit > 0 && sentAt != null && sentAt > 0 && explicit > sentAt)
      ? (explicit - sentAt)
      : callRingLifetimeMs;
  final maxMs = leaseMs.clamp(0, callRingLifetimeMaxMs).toInt();
  return (expiry - now).clamp(0, maxMs).toInt();
}

// presence.ts — [CALL-PRESENCE-1 2026-08-07]
//
// THE REAL HEARTBEAT. Until this file existed there was NO heartbeat anywhere in
// AvaTOK. "Presence" was a side effect of the call ring itself: `/api/call`
// broadcast a `call_ring` frame into the callee's InboxDO and read back whether
// any socket accepted it (do/inbox.ts event() -> broadcast()). That is a fact
// about the ring, discovered ~3.6 s into placing a call, and it was thrown away.
// `last_active_at` (do/inbox.ts) is written on socket connect/disconnect only and
// the call path never read it. The client's 25 s ping is answered by the DO's
// hibernation auto-response (do/inbox.ts constructor), so it never even wakes the
// DO — it refreshes nothing and proves nothing to anyone but the socket.
//
// WHY UPSTASH REDIS AND NOT THE INBOX DO
// --------------------------------------
// The obvious place for a presence record is `InboxDO.storage`. It is the wrong
// place, and deliberately so:
//
//   [WS-AUTORESP-1] exists precisely to STOP the 25 s ping waking the hibernated
//   DO — roughly 3,456 avoided wakes per day per connected user (billed DO
//   requests + duration). A heartbeat written into DO storage would wake the DO
//   on EVERY tick and hand that entire saving straight back, plus a write.
//
// Upstash Redis is already bound (worker/wrangler.toml UPSTASH_REDIS_REST_URL +
// the UPSTASH_REDIS_REST_TOKEN secret), it is an HTTP REST hop with no DO wake at
// either end, the write is a single SET-with-EX and the read is a single GET.
//
// KEY NAMESPACING. Prod and staging point at different Upstash databases today
// ([STAGING-ISOLATION-1], 2026-08-02) but CLAUDE.md still records Upstash as a
// shared service, and the two Workers are one account. The environment is baked
// into every key so that even if the two envs are ever pointed back at one
// database, a staging device can never mark a prod user online (or vice versa).
//
// FAIL POLICY: OPEN, ALWAYS. Every failure mode — no Upstash credentials, a REST
// error, a malformed record, a user who has simply never beaten — reads as
// `null`, which callers MUST treat as "unknown presence, ring normally". The
// alternative (unknown == offline) would route every call on the platform to the
// receptionist the moment Redis hiccuped.

import type { Env } from "../types";
import { redisGetJson, redisSetJson } from "./redis";

/** What a device says about itself when it checks in. */
export interface PresenceRecord {
  /** Epoch ms of the beat. Server-stamped — never trust a device clock. */
  lastSeenMs: number;
  /** What produced the beat: 'ws_connect' | 'ping' | 'resume' | 'push' | 'call'. */
  source: string;
  /** Device lifecycle at beat time: 'foreground' | 'background' | 'unknown'. */
  appState: string;
  /** Which device beat. Multi-device: the LAST device to check in wins. */
  deviceId: string;
}

/** Presence + how old it is, as the call path wants to reason about it. */
export type PresenceState = "fresh" | "stale" | "unknown";

export interface PresenceVerdict {
  presence: PresenceState;
  /** ms since the last beat, or null when there is no record at all. */
  ageMs: number | null;
  record: PresenceRecord | null;
}

/**
 * Environment-namespaced key. `prod` is the fail-safe default so an env missing
 * ENVIRONMENT_NAME lands on the production namespace it is most likely to be
 * (matching hooks.ts's identical default) rather than inventing a third space.
 */
function presenceKey(env: Env, uid: string): string {
  const environment = env.ENVIRONMENT_NAME ?? "prod";
  return `presence:${environment}:${uid}`;
}

/**
 * The stored TTL. Deliberately several multiples of the freshness window: a key
 * that expired the instant it went stale would make "stale" and "never beat"
 * indistinguishable, and `presence_age_ms` — the number that tells us whether
 * the heartbeat is actually working — would always be null exactly when it
 * matters. Capped so an abandoned account cannot hold a key forever.
 */
function presenceTtlSec(freshSec: number): number {
  const fresh = Number.isFinite(freshSec) && freshSec > 0 ? freshSec : 90;
  return Math.min(86_400, Math.max(300, Math.round(fresh * 8)));
}

/** Write (or refresh) this user's presence. Best-effort; never throws. */
export async function writePresence(
  env: Env,
  uid: string,
  rec: PresenceRecord,
  freshSec: number,
): Promise<void> {
  if (!uid) return;
  await redisSetJson(env, presenceKey(env, uid), rec, presenceTtlSec(freshSec));
}

/** Raw read — `null` on miss, error, or no configured store. */
export async function readPresenceRecord(env: Env, uid: string): Promise<PresenceRecord | null> {
  if (!uid) return null;
  const raw = await redisGetJson<Partial<PresenceRecord>>(env, presenceKey(env, uid));
  const lastSeenMs = Number(raw?.lastSeenMs ?? 0);
  if (!raw || !Number.isFinite(lastSeenMs) || lastSeenMs <= 0) return null;
  return {
    lastSeenMs,
    source: String(raw.source ?? "unknown"),
    appState: String(raw.appState ?? "unknown"),
    deviceId: String(raw.deviceId ?? ""),
  };
}

/**
 * The call path's question, answered in one lookup: is this person's phone
 * checking in right now?
 *
 * NOTE the three-valued result. `unknown` is NOT `stale`. A user on a build that
 * predates the client heartbeat, or any call placed while Upstash is unreachable,
 * produces `unknown`, and the caller must ring exactly as it always did. Only a
 * record that EXISTS and is older than the window is `stale` — i.e. we have
 * positive evidence this device used to check in and has stopped.
 *
 * A clock-skewed record from the future is clamped to age 0 (fresh) rather than
 * treated as ancient; the timestamp is server-stamped at beat time, so a negative
 * age means our own clocks disagree, not that the device is offline.
 */
export async function readPresence(env: Env, uid: string, freshSec: number): Promise<PresenceVerdict> {
  const record = await readPresenceRecord(env, uid);
  if (!record) return { presence: "unknown", ageMs: null, record: null };
  const ageMs = Math.max(0, Date.now() - record.lastSeenMs);
  const windowMs = (Number.isFinite(freshSec) && freshSec > 0 ? freshSec : 90) * 1000;
  return { presence: ageMs <= windowMs ? "fresh" : "stale", ageMs, record };
}

// [HF-CALL-MODES-A] I/O side of the host call-state view (the pure rules stay in lib/hf_host_status.ts).
// Every PUBLIC reader (card, list, search, reels, favourites, me) calls lineFieldsForUids(): it returns null while hfCallModesEnabled is OFF
// (readers then emit exactly today's JSON) and a Map of { mode, callState, queue:{open,waiting} } per host when ON. Spec section 2.1 / 2.5.
import type { Env } from "../types";
import { readConfig } from "../routes/config";
import { canQueue, publicCallState } from "./hf_host_status";
import type { HostMode, PublicCallState } from "./hf_call_contracts";

export interface HostLineFields {
  mode: HostMode;
  callState: PublicCallState;
  /** open = a fan can join the queue right now; waiting = fans in hf_call_queue that are waiting or in their 60 s break (same definition as lib/hf_queue_store.ts WAITING_SQL). */
  queue: { open: boolean; waiting: number };
}

export interface LineFlags { modes: boolean; queue: boolean }
export async function lineFlags(env: Env): Promise<LineFlags> {
  try {
    const c = (await readConfig(env)) as unknown as Record<string, unknown>;
    return { modes: c.hfCallModesEnabled === true, queue: c.hfCallQueueEnabled === true };
  } catch { return { modes: false, queue: false }; }
}

const asMode = (m: unknown): HostMode => (m === "offline" || m === "bookings_only" ? m : "online");

/** Pure: one host's public fields from its row values + waiting count. */
export function lineFieldsFor(
  row: { call_mode?: string | null; on_call_since?: number | null; presence_call_id?: string | null; queue_paused?: number | null },
  waiting: number,
  queueOn: boolean,
): HostLineFields {
  const mode = asMode(row.call_mode);
  const w = queueOn ? Math.max(0, Math.trunc(waiting)) : 0;
  const callState = publicCallState({ mode, onCallSince: row.on_call_since ?? null, lockCallId: row.presence_call_id ?? null, waiting: w });
  return { mode, callState, queue: { open: queueOn && canQueue(callState, Number(row.queue_paused ?? 0) === 1), waiting: w } };
}

/** Waiting fans per host (empty map when the queue flag is off or the table is missing). */
export async function waitingCounts(env: Env, hostUids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const uids = [...new Set(hostUids)];
  for (let i = 0; i < uids.length; i += 90) {
    const part = uids.slice(i, i + 90);
    try {
      const rs = (await env.DB_META.prepare(`SELECT host_uid, COUNT(*) AS n FROM hf_call_queue WHERE (status='waiting' OR (status='offered' AND call_id IS NULL)) AND host_uid IN (${part.map((_, j) => `?${j + 1}`).join(",")}) GROUP BY host_uid`)
        .bind(...part).all<{ host_uid: string; n: number }>()).results ?? [];
      for (const r of rs) out.set(r.host_uid, Number(r.n ?? 0));
    } catch { /* hf_call_queue not applied yet: nobody waits */ }
  }
  return out;
}

/** null = modes flag OFF (emit nothing new). Otherwise one entry per host uid found. */
export async function lineFieldsForUids(env: Env, hostUids: string[]): Promise<Map<string, HostLineFields> | null> {
  const flags = await lineFlags(env);
  if (!flags.modes) return null;
  const out = new Map<string, HostLineFields>();
  const uids = [...new Set(hostUids)].filter(Boolean);
  if (!uids.length) return out;
  const waiting = flags.queue ? await waitingCounts(env, uids) : new Map<string, number>();
  for (let i = 0; i < uids.length; i += 90) {
    const part = uids.slice(i, i + 90);
    try {
      const rs = (await env.DB_META.prepare(`SELECT uid, call_mode, on_call_since, presence_call_id, queue_paused FROM hf_hosts WHERE uid IN (${part.map((_, j) => `?${j + 1}`).join(",")})`)
        .bind(...part).all<{ uid: string; call_mode: string | null; on_call_since: number | null; presence_call_id: string | null; queue_paused: number | null }>()).results ?? [];
      for (const r of rs) out.set(r.uid, lineFieldsFor(r, waiting.get(r.uid) ?? 0, flags.queue));
    } catch { /* columns not applied yet: readers fall back to legacy output */ }
  }
  return out;
}

// [HF-CALL-MODES-A] I/O side of the host call-state view (the pure rules stay in lib/hf_host_status.ts).
// Every PUBLIC reader (card, list, search, reels, favourites, me) calls lineFieldsForUids(): it returns null while hfCallModesEnabled is OFF
// (readers then emit exactly today's JSON) and a Map of { mode, callState, queue:{open,waiting} } per host when ON. Spec section 2.1 / 2.5.
import type { Env } from "../types";
import { readConfig } from "../routes/config";
import { canQueue, publicCallState } from "./hf_host_status";
import type { HostMode, PublicCallState } from "./hf_call_contracts";
import { mainActionFor, parseCallOption, type CallOption, type MainAction } from "./hf_call_option"; // [HF-INTRO-W2]

export interface HostLineFields {
  mode: HostMode;
  callState: PublicCallState;
  /** open = a fan can join the queue right now; waiting = fans in hf_call_queue that are waiting or in their 60 s break (same definition as lib/hf_queue_store.ts WAITING_SQL). */
  queue: { open: boolean; waiting: number };
  /** [HF-INTRO-W2] present only while hfCallOptionEnabled is on. null = legacy host (no option chosen yet). */
  callOption?: CallOption | null;
  /** [HF-INTRO-W2] present only while hfCallOptionEnabled is on: the single button web and app render (D15). */
  mainAction?: MainAction;
}

export interface LineFlags { modes: boolean; queue: boolean; option: boolean; bookings: boolean }
export async function lineFlags(env: Env): Promise<LineFlags> {
  try {
    const c = (await readConfig(env)) as unknown as Record<string, unknown>;
    return { modes: c.hfCallModesEnabled === true, queue: c.hfCallQueueEnabled === true, option: c.hfCallOptionEnabled === true, bookings: c.hfBookingsEnabled === true };
  } catch { return { modes: false, queue: false, option: false, bookings: false }; }
}

const asMode = (m: unknown): HostMode => (m === "offline" || m === "bookings_only" ? m : "online");

/** Pure: one host's public fields from its row values + waiting count. */
export function lineFieldsFor(
  row: { call_mode?: string | null; on_call_since?: number | null; presence_call_id?: string | null; queue_paused?: number | null; call_option?: string | null },
  waiting: number,
  queueOn: boolean,
  /** [HF-INTRO-W2] undefined / on:false = today's output exactly. */
  option?: { on: boolean; bookingsOn: boolean },
): HostLineFields {
  const mode = asMode(row.call_mode);
  const w = queueOn ? Math.max(0, Math.trunc(waiting)) : 0;
  let callState = publicCallState({ mode, onCallSince: row.on_call_since ?? null, lockCallId: row.presence_call_id ?? null, waiting: w });
  if (!option?.on) return { mode, callState, queue: { open: queueOn && canQueue(callState, Number(row.queue_paused ?? 0) === 1), waiting: w } };
  const callOption = parseCallOption(row.call_option);
  if (callOption === "A") callState = "appointments"; // bookings only, whatever her presence switch says
  const open = queueOn && canQueue(callState, Number(row.queue_paused ?? 0) === 1);
  return { mode, callState, queue: { open, waiting: w }, callOption, mainAction: mainActionFor({ option: callOption, state: callState, queueOpen: open, bookingsOn: option.bookingsOn }) };
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

/** [HF-INTRO-W2] call_option per host, read on its own so a DB without the column still serves every other field (everyone is then legacy). */
async function callOptionsFor(env: Env, uids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (let i = 0; i < uids.length; i += 90) {
    const part = uids.slice(i, i + 90);
    try {
      const rs = (await env.DB_META.prepare(`SELECT uid, call_option FROM hf_hosts WHERE uid IN (${part.map((_, j) => `?${j + 1}`).join(",")})`)
        .bind(...part).all<{ uid: string; call_option: string | null }>()).results ?? [];
      for (const r of rs) out.set(r.uid, r.call_option);
    } catch { /* call_option column not applied yet: every host is legacy */ }
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
  const options = flags.option ? await callOptionsFor(env, uids) : new Map<string, string | null>();
  for (let i = 0; i < uids.length; i += 90) {
    const part = uids.slice(i, i + 90);
    try {
      const rs = (await env.DB_META.prepare(`SELECT uid, call_mode, on_call_since, presence_call_id, queue_paused FROM hf_hosts WHERE uid IN (${part.map((_, j) => `?${j + 1}`).join(",")})`)
        .bind(...part).all<{ uid: string; call_mode: string | null; on_call_since: number | null; presence_call_id: string | null; queue_paused: number | null }>()).results ?? [];
      for (const r of rs) out.set(r.uid, lineFieldsFor({ ...r, call_option: options.get(r.uid) ?? null }, waiting.get(r.uid) ?? 0, flags.queue, flags.option ? { on: true, bookingsOn: flags.bookings } : undefined));
    } catch { /* columns not applied yet: readers fall back to legacy output */ }
  }
  return out;
}

// [HF-INTRO-W2] Call option (HF-INTRO-8/15/16/20, Specs/HF-INTRO-VIDEO-1.md D9/D16/D20).
//   A = Bookings only: no instant call and no queue join, ever, online or not. Only bookings (and booked calls still ring in every state).
//   B = Bookings + live: Online & free -> instant call; Online & on a call -> queue or book; Offline -> no instant / queue, bookings stay open.
//   NULL (column empty / not applied yet) = legacy host: today's rules unchanged.
// Everything here is INERT until hfCallOptionEnabled is on: every reader returns null / false and no SQL gains a condition.
import type { Env } from "../types";
import { readConfig } from "../routes/config";
import { canBook as stateCanBook } from "./hf_host_status";
import type { PublicCallState } from "./hf_call_contracts";
import { trackException } from "../hooks";
import { BRAND } from "./brand";

export type CallOption = "A" | "B";
export const CALL_OPTIONS: readonly CallOption[] = ["A", "B"];
export const parseCallOption = (v: unknown): CallOption | null => (v === "A" || v === "B" ? v : null);

/** The single button every surface renders (web and app, D15). */
export type MainAction = "call" | "queue_or_book" | "book" | "none";

/** The refusal reason clients get when an option-A host is asked for a live call / queue spot. */
export const BOOKINGS_ONLY_REASON = "bookings_only";
export const BOOKINGS_ONLY_MESSAGE = "This influencer takes bookings only. Book a time to talk to them.";

export async function callOptionOn(env: Env): Promise<boolean> {
  try { return (await readConfig(env)).hfCallOptionEnabled === true; } catch { return false; }
}

/** hf_hosts.call_option. Never throws: the column comes from W1's migration, so an old DB answers null (= legacy host). */
export async function hostCallOption(env: Env, hostUid: string): Promise<CallOption | null> {
  try {
    return parseCallOption((await env.DB_META.prepare("SELECT call_option FROM hf_hosts WHERE uid=?1").bind(hostUid).first<{ call_option: string | null }>())?.call_option);
  } catch { return null; /* migration not applied yet */ }
}

/** Option A host + flag on: no instant call and no queue spot. Booked calls never ask this. */
export async function liveBlockedByOption(env: Env, hostUid: string): Promise<boolean> {
  if (!(await callOptionOn(env))) return false;
  return (await hostCallOption(env, hostUid)) === "A";
}

/** Option-aware "can a fan book a time". Offline still takes bookings for A and B (D9); a legacy host keeps today's rule. */
export function canBookFor(state: PublicCallState, option: CallOption | null): boolean {
  return option ? true : stateCanBook(state);
}

/** D15/D16: the one button. `queueOpen` = a fan can join the queue right now; `bookingsOn` = hfBookingsEnabled. */
export function mainActionFor(a: { option: CallOption | null; state: PublicCallState; queueOpen: boolean; bookingsOn: boolean }): MainAction {
  const book: MainAction = a.bookingsOn ? "book" : "none";
  if (a.option === "A") return book;
  switch (a.state) {
    case "available": return "call";
    case "on_call": case "connecting": case "queue_only": return a.queueOpen ? "queue_or_book" : book;
    case "appointments": return book;
    case "offline": return a.option === "B" ? book : "none"; // legacy host: Offline takes no new bookings (today's rule)
    default: return "none";
  }
}

/** Write the option. Returns the previous value; `ok:false` when the column does not exist yet (W1's migration not applied). */
export async function setCallOption(env: Env, hostUid: string, option: CallOption): Promise<{ ok: true; prev: CallOption | null } | { ok: false }> {
  const prev = await hostCallOption(env, hostUid);
  try {
    const r = await env.DB_META.prepare("UPDATE hf_hosts SET call_option=?1 WHERE uid=?2").bind(option, hostUid).run();
    if (Number(r.meta?.changes ?? 0) !== 1) return { ok: false };
    return { ok: true, prev };
  } catch (e) {
    await trackException(env, e, { uid: hostUid, route: "hf_call_option.setCallOption", handled: true, app_name: BRAND.slug, extra: { area: "hf_call_option" } }).catch(() => undefined);
    return { ok: false };
  }
}

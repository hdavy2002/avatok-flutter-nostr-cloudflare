// [HF-CALL-MODES-C] The one place a token call is STARTED, for instant callers (POST /api/hf/calls), queued callers (HfHostLineDO dispatch) and,
// through the same DO contract, booked calls. startTokenCall moved here from routes/hf_calls.ts (behaviour unchanged with hfCallChunkBillingEnabled off:
// whole-call reserve, 60-minute cap). With the flag on only chunk 0 (300 s) is reserved and the call DO takes the rest 5 minutes ahead.
// Spec: Specs/SPEC-2026-10-23-HF-CALL-MODES-QUEUE.md sections 2.2 rule 4, 2.3.
import type { Env } from "../types";
import type { CallSource } from "./hf_call_contracts";
import { readConfig } from "../routes/config";
import { track, trackException } from "../hooks";
import { claimHost, claimHostFromQueue, releaseHost, hasLaneAccess, isBlockedEitherWay, callsConfigured, HF_CALL_APP } from "./hf_calls_store";
import { readHfTokenConfig, readHfStdPlan, type HfStdPlan, type HfTokenConfig } from "./hf_token_config";
import { release as releaseTokenLots } from "./hf_token_ledger";
import { prepareTokenStart } from "./hf_token_calls";
import { readMoneyRules } from "./hf_money_rules";
import { creatorSnapshotFor, isCreatorCategory, validCreatorRate, type CreatorSnapshot } from "./hf_creator_pricing";
import { pricingStd, readInfluencerRate } from "./hf_influencer_rate";
import { isClosing } from "./hf_exit";
import { isDemoHost } from "./hf_demo";
import { verifiedWhatsAppNumber } from "./whatsapp_notify";

// ── shared helpers (moved from routes/hf_calls.ts) ──────────────────────────────────────────────────────────────────────────────────────
export function instantBookingOverlapGuardSql(first: number): string {
  if (!Number.isInteger(first) || first < 1) throw new Error("invalid booking guard parameter index");
  const enabled = first, caller = first + 1, host = first + 2, start = first + 3, end = first + 4;
  return ` WHERE ?${enabled}=0 OR NOT EXISTS (SELECT 1 FROM hf_bookings b WHERE b.status IN ('confirmed','pending_approval','starting','active','settling') ` +
    `AND (b.host_uid IN (?${caller},?${host}) OR b.customer_uid IN (?${caller},?${host})) ` +
    `AND b.starts_at-COALESCE((SELECT buffer_min*60000 FROM hf_availability_schedules s WHERE s.host_uid=b.host_uid),600000)<?${end} ` +
    `AND b.ends_at+COALESCE((SELECT buffer_min*60000 FROM hf_availability_schedules s WHERE s.host_uid=b.host_uid),600000)>?${start})`;
}

/** Epoch ms before which an instant / queued call must end so it never runs into a booking (or `now` when one is running); null = no booking ahead. */
export async function nextBookingCutoff(env: Env, callerUid: string, hostUid: string, now: number): Promise<number | null> {
  const parties = [callerUid, hostUid];
  const active = await env.DB_META.prepare(
    "SELECT 1 AS x FROM hf_bookings b WHERE b.status IN ('confirmed','pending_approval','starting','active','settling') " +
    "AND (b.host_uid IN (?1,?2) OR b.customer_uid IN (?1,?2)) AND b.starts_at<=?3 " +
    "AND b.ends_at+COALESCE((SELECT buffer_min*60000 FROM hf_availability_schedules s WHERE s.host_uid=b.host_uid),600000)>?3 LIMIT 1",
  ).bind(...parties, now).first();
  if (active) return now;
  const next = await env.DB_META.prepare(
    "SELECT MIN(b.starts_at-COALESCE((SELECT buffer_min*60000 FROM hf_availability_schedules s WHERE s.host_uid=b.host_uid),600000)) AS cutoff " +
    "FROM hf_bookings b WHERE b.status IN ('confirmed','pending_approval','starting','active','settling') " +
    "AND (b.host_uid IN (?1,?2) OR b.customer_uid IN (?1,?2)) AND b.starts_at>?3",
  ).bind(...parties, now).first<{ cutoff: number | null }>();
  return next?.cutoff == null ? null : Number(next.cutoff);
}

// ── chunk configuration ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ChunkSettings { sec: number; capSec: number }
/** null when hfCallChunkBillingEnabled is off (the whole-call reserve and the 60-minute cap stay exactly as before). */
export function chunkSettingsFrom(cfg: Record<string, unknown>): ChunkSettings | null {
  if (cfg.hfCallChunkBillingEnabled !== true) return null;
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.trunc(v))) : d);
  const chunkMin = num(cfg.hfCallChunkMinutes, 5, 1, 30);
  const maxMin = num(cfg.hfCallMaxMinutes, 300, chunkMin, 1440);
  return { sec: chunkMin * 60, capSec: maxMin * 60 };
}

// ── start (token path) ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface StartFailure { ok: false; status: number; error: string; message: string; extra?: Record<string, unknown> }
export interface StartTokenOk { ok: true; callId: string; rate: number; maxMinutes: number; maxSeconds: number; plan: "creator" | "standard" | "host_rate"; chunk: boolean }
export type StartTokenResult = StartTokenOk | StartFailure;

const fail = (status: number, error: string, message: string, extra?: Record<string, unknown>): StartFailure => ({ ok: false, status, error, message, ...(extra ? { extra } : {}) });
const UNAVAILABLE_MSG = "This host isn't available right now.";

// [HF-TOK-CALLS-1] Token-mode start. Debt and balance gates + lot reservation happen in prepareTokenStart; the hf_calls row carries the
// pricing snapshot (rate, call cost per minute, host share, versions) so a later config change never alters this call.
export async function startTokenCall(env: Env, a: {
  uid: string; hostUid: string; lane: string | null; rate: number; callId: string; tk: HfTokenConfig; hardEndsAt?: number; bookingGuard?: boolean; std?: HfStdPlan; creator?: CreatorSnapshot;
  /** hfCallChunkBillingEnabled settings (null/absent = whole-call reserve). */
  chunk?: ChunkSettings | null;
  /** How the call began; 'queue' takes the line from the queue lock 'q:<queueEntryId>'. */
  source?: CallSource; queueEntryId?: string;
}): Promise<StartTokenResult> {
  const { uid, hostUid, lane, rate, callId, tk, hardEndsAt, bookingGuard } = a;
  const source: CallSource = a.source ?? "instant";
  const ratePaise = Math.round(rate * 100);
  const rules = await readMoneyRules(env); // [HF-WIRE-13] rule 1: at least Rs 20 in the wallet to start
  const chk = await prepareTokenStart(env, { uid, callId, ratePaise, tk, std: a.std ?? null, creator: a.creator, minBalancePaise: rules.minBalancePaise, ...(a.chunk ? { chunk: a.chunk } : {}) });
  if (!chk.ok) return fail(chk.status, chk.error, chk.message, chk.extra);
  const undo = async (claimed: boolean) => {
    if (claimed) await releaseHost(env, hostUid, callId).catch(() => undefined);
    await releaseTokenLots(env, callId).catch(() => undefined);
  };
  const claimed = source === "queue" && a.queueEntryId ? await claimHostFromQueue(env, hostUid, a.queueEntryId, callId) : await claimHost(env, hostUid, callId);
  if (!claimed) { await undo(false); return fail(409, "host_unavailable", UNAVAILABLE_MSG); }
  const maxMinutes = Math.floor(chk.maxSeconds / 60);
  try {
    const insertNow = Date.now();
    const plannedEnd = Math.min(hardEndsAt ?? Number.MAX_SAFE_INTEGER, insertNow + chk.maxSeconds * 1000);
    const inserted = await env.DB_META.prepare(
      `INSERT INTO hf_calls (id, caller_uid, host_uid, rate_paise, status, lane, created_at, conference_name, call_cost_paise_per_min, host_share_bps, tax_mode, split_rule_version, pricing_snapshot)
       SELECT ?1,?2,?3,?4,'ringing_host',?5,?6,?7,?8,?9,?10,?11,?12` + instantBookingOverlapGuardSql(13),
    ).bind(callId, uid, hostUid, chk.snapshot.ratePaise, lane, insertNow, `hf_${callId.replace(/-/g, "")}`, chk.snapshot.callCostPaisePerMin, chk.snapshot.hostShareBps, chk.snapshot.taxMode, chk.snapshot.splitRuleVersion,
      chk.snapshot.creator ? JSON.stringify(chk.snapshot.creator) : chk.snapshot.std ? JSON.stringify(chk.snapshot.std) : null,
      bookingGuard === true ? 1 : 0, uid, hostUid, insertNow, plannedEnd).run();
    if (Number(inserted.meta?.changes ?? 0) !== 1) {
      await undo(true);
      return fail(409, "booking_window_conflict", "A scheduled booking overlaps this call window.");
    }
  } catch (e) {
    await undo(true);
    await trackException(env, e, { uid, route: "/api/hf/calls", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "insert_tokens" } });
    return fail(500, "internal_error", "Something went wrong.");
  }
  // [HF-CALL-MODES-C] how the call began + what chunk 0 paid for. Best effort on its own statement: the columns come from the 2026-10-24 ALTER migration,
  // and a worker deployed before it must keep starting calls. Written only when there is something to say, so flag-off calls run the exact old statements.
  if (chk.chunk || source !== "instant") {
    await env.DB_META.prepare("UPDATE hf_calls SET source=?1, queue_entry_id=?2, funded_seconds=?3, chunks=?4 WHERE id=?5")
      .bind(source, a.queueEntryId ?? null, chk.chunk ? chk.chunk.fundedSec : null, chk.chunk ? 1 : null, callId).run().catch(() => undefined);
  }
  try {
    const r = await env.HF_CALL.get(env.HF_CALL.idFromName(callId)).fetch("https://hfcall/init", {
      method: "POST",
      body: JSON.stringify({
        callId, callerUid: uid, hostUid, ...(hardEndsAt != null ? { hardEndsAt } : {}), rateRupees: rate, reservedRupees: 0, testReservedRupees: 0, fundsRupees: 0, maxMinutes, limitReason: chk.limitReason,
        source,
        tokens: {
          ratePaise: chk.snapshot.ratePaise, callCostPaisePerMin: chk.snapshot.callCostPaisePerMin, hostShareBps: chk.snapshot.hostShareBps, maxSeconds: chk.maxSeconds, std: chk.snapshot.std ?? null, creator: chk.snapshot.creator,
          ...(chk.chunk ? { chunk: true, chunkSec: chk.chunk.sec, capSec: chk.chunk.capSec, fundedSec: chk.chunk.fundedSec } : {}),
        },
      }),
    });
    if (!r.ok) throw new Error(`init ${r.status}`);
  } catch (e) {
    await env.DB_META.prepare("UPDATE hf_calls SET status='failed', end_reason='error', ended_at=?1 WHERE id=?2 AND status='ringing_host'").bind(Date.now(), callId).run().catch(() => undefined);
    await undo(true);
    await trackException(env, e, { uid, route: "/api/hf/calls", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "init_tokens" } });
    return fail(502, "call_failed", "We couldn't place the call. Please try again.");
  }
  const plan = chk.snapshot.creator ? "creator" : chk.snapshot.std ? "standard" : "host_rate";
  void track(env, uid, "hf_call_started", HF_CALL_APP, {
    area: "hf_call", call_id: callId, rate_rupees: rate, lane, max_minutes: maxMinutes, max_seconds: chk.maxSeconds, mode: "tokens", plan, pricing_version: chk.snapshot.splitRuleVersion,
    ...(chk.chunk ? { source, chunk_billing: true, funded_seconds: chk.chunk.fundedSec } : {}),
  }).catch(() => undefined);
  return { ok: true, callId, rate, maxMinutes, maxSeconds: chk.maxSeconds, plan, chunk: !!chk.chunk };
}

// ── pricing choice (same order the route always used) ──────────────────────────────────────────────────────────────────────────────────────
export interface PricingHost { uid: string; price_per_min: number; category: string }
export type PricingPick =
  | { kind: "unavailable" }
  | { kind: "legacy"; rate: number }
  | { kind: "token"; rate: number; std?: HfStdPlan; creator?: CreatorSnapshot };
export function pickPricing(host: PricingHost, rawCfg: Record<string, unknown>, tk: HfTokenConfig): PricingPick {
  const rate = Math.trunc(Number(host.price_per_min));
  const std = pricingStd(readHfStdPlan(rawCfg), rawCfg); // [HF-WIRE-18] HF-REEL-37
  const infRate = readInfluencerRate(rawCfg);
  if (isCreatorCategory(host.category)) {
    if (!validCreatorRate(rate)) return { kind: "unavailable" };
    return { kind: "token", rate, creator: creatorSnapshotFor(host.category, rate) };
  }
  if (std.enabled) return { kind: "token", rate: std.tariff.tiers[0].paisePerMin / 100, std };
  if (!(rate > 0) || (infRate.on && rate < infRate.minRupees)) return { kind: "unavailable" };
  if (tk.enabled) return { kind: "token", rate };
  return { kind: "legacy", rate };
}

// ── queue / instant entry point ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface StartInstantCallInput {
  callerUid: string;
  hostUid: string;
  /** 'queue' = dispatched by HfHostLineDO (line already locked as 'q:<queueEntryId>'; use claimHostFromQueue). */
  source: Extract<CallSource, "instant" | "queue">;
  queueEntryId?: string;
  /** Epoch ms hard stop (e.g. next booking cutoff). */
  hardEndsAt?: number;
}
export type StartInstantCallResult =
  | { ok: true; callId: string }
  | { ok: false; error: string; status?: number; message?: string; extra?: Record<string, unknown> };

/**
 * Start a call for a caller the CALLER-side already cleared (queue dispatch re-checks money here: low_balance comes back as error "low_balance" with
 * extra.shortfallPaise so the queue can skip the fan). Everything the route checks for an instant call that is not about the line itself is checked
 * here too: account closing, blocks, verified numbers, lane, a call already in progress, booking cutoff, demo hosts. Money is reserved first
 * (chunk 0), the line is taken last (claimHostFromQueue for 'queue'), and any failure after the reserve gives the money back.
 */
export async function startInstantCall(env: Env, input: StartInstantCallInput): Promise<StartInstantCallResult> {
  const { callerUid: uid, hostUid } = input;
  const bad = (f: StartFailure): StartInstantCallResult => ({ ok: false, error: f.error, status: f.status, message: f.message, ...(f.extra ? { extra: f.extra } : {}) });
  try {
    const rawCfg = (await readConfig(env).catch(() => ({}))) as unknown as Record<string, unknown>;
    if (rawCfg.hfCallsEnabled !== true) return { ok: false, error: "not_enabled", status: 404 };
    if (!callsConfigured(env)) return { ok: false, error: "calls_not_ready", status: 503 };
    if (input.source === "queue" && !input.queueEntryId) return { ok: false, error: "queue_entry_required", status: 400 };
    const host = await env.DB_META.prepare("SELECT uid, display_name, price_per_min, category, women_lane, lgbtq_lane, status FROM hf_hosts WHERE uid=?1").bind(hostUid)
      .first<{ uid: string; display_name: string | null; price_per_min: number; category: string; women_lane: number; lgbtq_lane: number; status: string }>();
    if (!host || host.status !== "live" || host.uid === uid) return { ok: false, error: "host_unavailable", status: 409 };
    if (await isDemoHost(env, host.uid)) return { ok: false, error: "demo_host", status: 409 };
    if (await isClosing(env, uid)) return { ok: false, error: "account_closing", status: 409 };
    if (await isClosing(env, host.uid) || await isBlockedEitherWay(env, uid, host.uid)) return { ok: false, error: "host_unavailable", status: 409 };
    if (!(await verifiedWhatsAppNumber(env, uid))) return { ok: false, error: "not_verified", status: 403 };
    if (!(await verifiedWhatsAppNumber(env, host.uid))) return { ok: false, error: "host_unavailable", status: 409 };
    if (host.women_lane === 1 && !(await hasLaneAccess(env, uid, "women"))) return { ok: false, error: "lane_required", status: 403 };
    const lane = host.women_lane === 1 ? "women" : null;
    const open = await env.DB_META.prepare(
      "SELECT 1 AS x FROM hf_calls WHERE caller_uid=?1 AND status IN ('ringing_host','ringing_caller','connected') AND created_at>?2 LIMIT 1",
    ).bind(uid, Date.now() - 25 * 3600_000).first();
    if (open) return { ok: false, error: "call_in_progress", status: 409 };
    const now = Date.now();
    const cutoff = rawCfg.hfBookingsEnabled === true ? await nextBookingCutoff(env, uid, host.uid, now) : null;
    if (cutoff != null && cutoff <= now) return { ok: false, error: "booking_window_conflict", status: 409 };
    const hardEndsAt = cutoff != null && input.hardEndsAt != null ? Math.min(cutoff, input.hardEndsAt) : (cutoff ?? input.hardEndsAt);
    const tk = readHfTokenConfig(rawCfg);
    const pick = pickPricing(host, rawCfg, tk);
    if (pick.kind === "unavailable") return { ok: false, error: "host_unavailable", status: 409 };
    if (pick.kind === "legacy") return { ok: false, error: "calls_not_ready", status: 503 }; // the rupee-wallet path has no queue and no chunks
    const callId = crypto.randomUUID();
    const r = await startTokenCall(env, {
      uid, hostUid: host.uid, lane, rate: pick.rate, callId, tk, ...(hardEndsAt != null ? { hardEndsAt } : {}), bookingGuard: rawCfg.hfBookingsEnabled === true,
      ...(pick.std ? { std: pick.std } : {}), ...(pick.creator ? { creator: pick.creator } : {}),
      chunk: chunkSettingsFrom(rawCfg), source: input.source, ...(input.queueEntryId ? { queueEntryId: input.queueEntryId } : {}),
    });
    return r.ok ? { ok: true, callId } : bad(r);
  } catch (e) {
    await trackException(env, e, { uid, route: "hf_call_start.startInstantCall", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", source: input.source } });
    return { ok: false, error: "internal_error", status: 500 };
  }
}

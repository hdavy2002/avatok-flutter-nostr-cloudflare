import { requireHfAgeConfirmation } from "../lib/hf_age_eligibility";
// [HF-CALLS-1] HF masked paid calls: start/status/cancel, wallet read, admin test credits, host presence, host call list,
// admin call list and the Vobiz webhooks. Contract: Specs/HF-CALLS-CONTRACT.md. Dark behind hfCallsEnabled.
//   POST /api/hf/calls {hostSlug, lane?}              -> {ok, callId, status:"ringing_host", rate, maxMinutes}
//   GET  /api/hf/calls?role=caller|host&status=all|completed|missed&cursor=&limit=   -> {ok, items:[{id,status,otherHandle,hostSlug,at,seconds,amountPaise,endReason}], nextCursor}   [HF-DASH-CALLS-1]
//   GET  /api/hf/calls/:id                            -> {id,status,hostSlug,hostName,rate,connectedAt,endedAt,billedMinutes,chargedRupees,endReason,canReview}
//   POST /api/hf/calls/:id/cancel                     (caller, before connect)
//   GET  /api/hf/wallet                               -> {paidBalance, testBalance, spendable, host?, history[], balanceRupees (legacy)}   [HF-WALLET-1]
//   POST /api/admin/hf/wallet/migrate-test-credits {dry_run?=true}   (one-off: moves earlier wallet test credits into hf_credits)
//   GET|PUT /api/hosts/me/presence {online}           -> {ok, presence[, nudgesPaused on GET]}      POST /api/hosts/me/presence/beat
//   PUT /api/hosts/me/presence/nudges {paused}        -> {ok, paused}   pause / resume the 3-hourly "you are offline" reminders   [HF-PRESENCE-NUDGE-1]
//   GET  /api/hosts/me/calls                          -> {ok, calls:[...], today:{calls,minutes,earningRupees}}   (handles only, never numbers)
//   POST /api/admin/hf/wallet/credit {uid | phone, rupees 1..2000, note, opId?, via?}   GET /api/admin/hf/users/search?q=      GET /api/admin/hf/calls?status=&limit=&offset=
//   POST /api/hf/vobiz/<VOBIZ_WEBHOOK_SECRET>/{answer/<host|caller>/<id> | digits/host/<id> | hangup/<host|caller>/<id> | conf/<id>/<host|caller> | notice/host-nopickup/<id>}
// Phone numbers are never present in any response, log or event here; they are read from the verified-WhatsApp store only at dial time (do/hf_call.ts).
import { isDemoHost, DEMO_MESSAGE } from "../lib/hf_demo"; // [HF-WIRE-14]
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { track, trackException } from "../hooks";
import { isAdminUid } from "../lib/preview";
import { personName } from "../lib/admin2_people_data";
import { verifiedWhatsAppNumber } from "../lib/whatsapp_notify";
import { notifyHostOnline } from "../lib/hf_notify";
import { isClosing, forceHostOffline, CLOSING_MESSAGE } from "../lib/hf_exit"; // [HF-WALLET-EXIT-1]
import { walletOp } from "./wallet";
import { classifyAdminQuery, searchable } from "../lib/hf_admin_search";
import { searchHfUsers, resolvePhone } from "../lib/hf_admin_users";
import { readConfig } from "./config";
import { readHfTokenConfig, readHfStdPlan, type HfStdPlan } from "../lib/hf_token_config";
import { formatTokens, formatDuration, formatRupees, tierBreakdown, chargePaise, validTariff, START_RESERVE_MINUTES as TOK_START_MINUTES, STD_TECH_MAX_SECONDS, type Tariff } from "../lib/hf_token_math";
import { hfStdPlanPublic } from "../lib/hf_token_config";
import { balanceSummary, availableLots, getLots, release as releaseTokenLots } from "../lib/hf_token_ledger";
import { prepareTokenStart, estimateForHost, activeValuePaise } from "../lib/hf_token_calls";
import { readMoneyRules, lowBalanceMessage, firstMinuteMessage, RULE_FIRST_MINUTE_DROP } from "../lib/hf_money_rules"; // [HF-WIRE-13] HF-REEL-35
import { creatorSnapshotFor, isCreatorCategory, validCreatorRate, validCreatorSnapshot, type CreatorSnapshot } from "../lib/hf_creator_pricing";
import { hostSummary, listCallEarnings } from "../lib/hf_host_ledger";
import { correctCallCharge } from "../lib/hf_call_corrections"; // [HF-STD-PLAN-1] rule 6
import { grantTestLot, migrateTestCreditsToLots } from "../lib/hf_token_test_credits";
import {
  HF_CALL_APP, WALLET_APP, callsConfigured, claimHost, releaseHost, hasLaneAccess, isBlockedEitherWay, hfReserve, hfRelease, hfWalletBalance, type HfCallRow,
} from "../lib/hf_calls_store";
import { reserveTestCredits, settleTestCredits, grantTestCredits, getTestBalance } from "../lib/hf_credits";
import { maxMinutesFor, START_RESERVE_MINUTES, MAX_CALL_MINUTES, paidShortfall, hangupXml, callerDidntPickUpXml, callerHandle } from "../lib/hf_call_math";
import { hasPositiveCallDuration } from "../lib/hf_reviews_pure";
import { recordLegFromWebhook } from "../lib/hf_vobiz_ledger";
import { pricingStd, readInfluencerRate } from "../lib/hf_influencer_rate"; // [HF-WIRE-18]
import { instantBookingOverlapGuardSql, nextBookingCutoff, startTokenCall, chunkSettingsFrom, pickPricing, type StartTokenResult } from "../lib/hf_call_start"; // [HF-CALL-MODES-C]
import { publicCallState, canQueue as stateCanQueue, canBook as stateCanBook } from "../lib/hf_host_status";
import { queueGate } from "../lib/hf_queue_store";
import type { PublicCallState, CallRefusalReason } from "../lib/hf_call_contracts";

const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) => json({ error, message, ...extra }, status);
const UNAVAILABLE = () => err(409, "host_unavailable", "This host isn't available right now.");
const NOT_ENABLED = () => err(404, "not_enabled", "Calls are not open yet.");
// [HF-CALL-MODES-C] A refusal for the line itself keeps error "host_unavailable" and ADDS why, and what the fan can do instead (spec 2.5).
// Old apps ignore the extra fields. With hfCallModesEnabled off the reason comes from the legacy presence alone and the queue is never offered.
async function lineRefusal(env: Env, hostUid: string): Promise<Response> {
  try {
    const cfg = (await readConfig(env).catch(() => ({}))) as unknown as Record<string, unknown>;
    type LineRow = { presence: string | null; call_mode?: string | null; on_call_since?: number | null; presence_call_id?: string | null; queue_paused?: number | null };
    let row = null as LineRow | null;
    try { row = await env.DB_META.prepare("SELECT presence, call_mode, on_call_since, presence_call_id, queue_paused FROM hf_hosts WHERE uid=?1").bind(hostUid).first<LineRow>(); }
    catch { row = await env.DB_META.prepare("SELECT presence FROM hf_hosts WHERE uid=?1").bind(hostUid).first<LineRow>().catch(() => null); } // migration not applied yet
    if (!row) return UNAVAILABLE();
    const modesOn = cfg.hfCallModesEnabled === true && row.call_mode != null;
    const gate = await queueGate(env, hostUid).catch(() => ({ waiting: 0, paused: false, open: false }));
    const state: PublicCallState = modesOn
      ? publicCallState({ mode: row.call_mode, onCallSince: row.on_call_since ?? null, lockCallId: row.presence_call_id ?? null, waiting: gate.waiting })
      : row.presence === "busy" ? "on_call" : row.presence === "online" ? "connecting" : "offline";
    if (state === "available") return UNAVAILABLE(); // refused for another reason: no line reason to add
    const reason: CallRefusalReason = state;
    const canQueue = modesOn && cfg.hfCallQueueEnabled === true && stateCanQueue(state, row.queue_paused === 1 || gate.paused);
    const canBook = cfg.hfBookingsEnabled === true && stateCanBook(state);
    return err(409, "host_unavailable", "This host isn't available right now.", { reason, canQueue, canBook, queueWaiting: Math.max(0, gate.waiting) });
  } catch { return UNAVAILABLE(); }
}
/** Fairness (spec 2.2 rule 1): while anyone waits in the queue an instant caller must queue too. Only acts with modes AND queue on. */
async function queueHoldsLine(env: Env, hostUid: string): Promise<boolean> {
  try {
    const cfg = (await readConfig(env)) as unknown as Record<string, unknown>;
    if (cfg.hfCallModesEnabled !== true || cfg.hfCallQueueEnabled !== true) return false;
    return (await queueGate(env, hostUid)).waiting > 0;
  } catch { return false; }
}
/** The JSON a successful start answers (unchanged shape), or the failure in the route's usual error shape. */
async function startAnswer(env: Env, r: StartTokenResult, hostUid: string): Promise<Response> {
  if (r.ok) return json({ ok: true, callId: r.callId, status: "ringing_host", rate: r.rate, maxMinutes: r.maxMinutes, maxSeconds: r.maxSeconds, mode: "tokens", plan: r.plan });
  if (r.error === "host_unavailable") return lineRefusal(env, hostUid);
  return err(r.status, r.error, r.message, r.extra ?? {});
}
const REVIEW_WINDOW_MS = 7 * 24 * 3600_000;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 8000) return {};
  try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}
const callStub = (env: Env, id: string) => env.HF_CALL.get(env.HF_CALL.idFromName(id));
// [HF-CALL-MODES-C] moved to lib/hf_call_start.ts (queue dispatch needs them too); re-exported so existing imports keep working.
export { instantBookingOverlapGuardSql };
async function callsOn(env: Env): Promise<boolean> {
  try { return (await readConfig(env)).hfCallsEnabled === true; } catch { return false; }
}
async function reelsOn(env: Env): Promise<boolean> {
  try { return (await readConfig(env)).hfReelsEnabled === true; } catch { return false; }
}
async function adminCtx(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  if (!isAdminUid(env, u.uid)) return err(403, "forbidden", "Forbidden.");
  return { uid: u.uid };
}
async function audit(env: Env, adminUid: string, action: string, target: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await env.DB_WALLET.prepare("INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(crypto.randomUUID(), adminUid, `hf_${action}`, target, JSON.stringify(meta), Date.now()).run();
  } catch (e) {
    await trackException(env, e, { route: "/api/admin/hf", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "admin_audit", action } });
  }
}
const rupees = (paise: number | null | undefined) => Math.round(Number(paise ?? 0)) / 100;

// ── POST /api/hf/calls ───────────────────────────────────────────────────────
async function startCall(req: Request, env: Env): Promise<Response> {
  if (!(await callsOn(env))) return NOT_ENABLED();
  if (!callsConfigured(env)) return err(503, "calls_not_ready", "Calls aren't ready yet. Please try again later.");
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  const uid = u.uid;
  const ageGate = await requireHfAgeConfirmation(env, uid);
  if (ageGate) return ageGate;
  // [HF-WALLET-EXIT-1] A user closing their account starts no new calls.
  if (await isClosing(env, uid)) return err(409, "account_closing", CLOSING_MESSAGE, { reason: "account_closing" });
  const body = await readJson(req);
  const slug = String(body.hostSlug ?? "").trim().toLowerCase();
  const laneIn = body.lane == null || body.lane === "" ? null : String(body.lane);
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) return UNAVAILABLE();
  if (laneIn !== null && laneIn !== "women" && laneIn !== "lgbtq") return err(400, "invalid_lane", "Unknown lane.");

  if (!(await verifiedWhatsAppNumber(env, uid))) return err(403, "not_verified", "Please verify your WhatsApp number first.");
  const limited = await rateLimit(env, `hfcall:${uid}`, 10, 600);
  if (limited) return limited;

  const host = await env.DB_META.prepare("SELECT uid, display_name, price_per_min, category, women_lane, lgbtq_lane, presence, status FROM hf_hosts WHERE slug=?1")
    .bind(slug).first<{ uid: string; display_name: string | null; price_per_min: number; category: string; women_lane: number; lgbtq_lane: number; presence: string | null; status: string }>();
  if (host && (await isDemoHost(env, host.uid))) return err(409, "demo_host", DEMO_MESSAGE, { reason: "demo_host" }); // [HF-WIRE-14] HF-REEL-34
  if (!host || host.status !== "live" || host.uid === uid) return UNAVAILABLE();
  if (host.presence !== "online" || (await queueHoldsLine(env, host.uid))) return lineRefusal(env, host.uid); // [HF-CALL-MODES-C] adds reason / canQueue / canBook / queueWaiting
  if (await isClosing(env, host.uid)) return UNAVAILABLE(); // [HF-WALLET-EXIT-1] a host who is closing their account takes no calls
  if (await isBlockedEitherWay(env, uid, host.uid)) return UNAVAILABLE();
  if (!(await verifiedWhatsAppNumber(env, host.uid))) return UNAVAILABLE();

  if (host.women_lane === 1 && !(await hasLaneAccess(env, uid, "women"))) return err(403, "lane_required", "This host takes calls from verified women only.", { lane: "women" });
  if (laneIn === "lgbtq") {
    if (host.lgbtq_lane !== 1) return UNAVAILABLE();
    if (!(await hasLaneAccess(env, uid, "lgbtq"))) return err(403, "lane_required", "Please verify to use this lane.", { lane: "lgbtq" });
  }
  const lane = laneIn ?? (host.women_lane === 1 ? "women" : null);

  const open = await env.DB_META.prepare(
    "SELECT 1 AS x FROM hf_calls WHERE caller_uid=?1 AND status IN ('ringing_host','ringing_caller','connected') AND created_at>?2 LIMIT 1",
  ).bind(uid, Date.now() - 25 * 3600_000).first(); // [HF-STD-PLAN-1] cover the explicit 24 h operational safety ceiling
  if (open) return err(409, "call_in_progress", "You already have a call in progress.");

  const rate = Math.trunc(Number(host.price_per_min));
  const callId = crypto.randomUUID();
  // [HF-TOK-CALLS-1] hfTokensEnabled on: the whole call runs on token lots (reserve, per-second billing, host paid in paise). Flag off: old path below.
  // [HF-STD-PLAN-1] Standard plan on: the host's own price is ignored; every call uses the Standard tariff on the rupee wallet (always the lot path).
  const rawCfg = (await readConfig(env).catch(() => ({}))) as Record<string, unknown>;
  const now = Date.now();
  const bookingCutoff = rawCfg.hfBookingsEnabled === true ? await nextBookingCutoff(env, uid, host.uid, now) : null;
  if (bookingCutoff != null && bookingCutoff <= now) return err(409, "booking_window_conflict", "A scheduled booking is too close to start another call.");
  const tk = readHfTokenConfig(rawCfg);
  const pick = pickPricing(host, rawCfg, tk); // [HF-CALL-MODES-C] same order as before: creator, Standard plan, host rate (tokens), then the old rupee wallet
  if (pick.kind === "unavailable") return UNAVAILABLE();
  const chunk = chunkSettingsFrom(rawCfg);
  if (pick.kind === "token") {
    return startAnswer(env, await startTokenCall(env, {
      uid, hostUid: host.uid, lane, rate: pick.rate, callId, tk, hardEndsAt: bookingCutoff ?? undefined, bookingGuard: rawCfg.hfBookingsEnabled === true,
      ...(pick.std ? { std: pick.std } : {}), ...(pick.creator ? { creator: pick.creator } : {}), chunk, source: "instant",
    }), host.uid);
  }
  if (chunk) return err(503, "calls_not_ready", "Calls aren't ready yet. Please try again later."); // chunk billing runs on the rupee lots only
  const moneyRules = await readMoneyRules(env); // [HF-WIRE-13] rule 1 on the old rupee wallet too
  const needed = Math.max(rate * START_RESERVE_MINUTES, Math.ceil(moneyRules.minBalancePaise / 100));

  // [HF-WALLET-1] Test credits are held first (up to a full-length call); the paid wallet reserves only what they do not cover.
  const testReserved = await reserveTestCredits(env, uid, callId, rate * MAX_CALL_MINUTES);
  const shortfall = paidShortfall(needed, testReserved);
  let paidReserved = 0, paidFunds = 0;
  if (shortfall > 0) {
    const rsv = await hfReserve(env, uid, shortfall, callId, "reserve");
    if (!rsv.ok) {
      await settleTestCredits(env, uid, callId, 0).catch(() => 0);
      const spendable = testReserved + rsv.available;
      if (rsv.status === 402) return err(402, "low_balance", spendable < Math.ceil(moneyRules.minBalancePaise / 100) ? lowBalanceMessage(moneyRules.minBalancePaise) : `You need at least ₹${needed} for this call.`, { needed, balance: spendable, minBalancePaise: moneyRules.minBalancePaise });
      return err(502, "wallet_error", "We couldn't check your balance. Please try again.");
    }
    paidReserved = shortfall;
    paidFunds = rsv.available + shortfall;
  } else {
    paidFunds = await hfWalletBalance(env, uid);
  }
  const fundsRupees = testReserved + paidFunds;
  const maxMinutes = maxMinutesFor(fundsRupees, rate);
  const limitReason: "time_limit" | "balance" = Math.floor(fundsRupees / rate) >= MAX_CALL_MINUTES ? "time_limit" : "balance";

  const freeAll = async () => { await hfRelease(env, uid, callId).catch(() => false); await settleTestCredits(env, uid, callId, 0).catch(() => 0); };
  if (!(await claimHost(env, host.uid, callId))) {
    await freeAll();
    return UNAVAILABLE();
  }
  const undo = async () => { await releaseHost(env, host.uid, callId).catch(() => undefined); await freeAll(); };
  try {
    const insertNow = Date.now();
    const plannedEnd = Math.min(bookingCutoff ?? Number.MAX_SAFE_INTEGER, insertNow + maxMinutes * 60_000);
    const inserted = await env.DB_META.prepare(
      "INSERT INTO hf_calls (id, caller_uid, host_uid, rate_paise, status, lane, created_at, conference_name) " +
      "SELECT ?1,?2,?3,?4,'ringing_host',?5,?6,?7" + instantBookingOverlapGuardSql(8),
    ).bind(callId, uid, host.uid, rate * 100, lane, insertNow, `hf_${callId.replace(/-/g, "")}`,
      rawCfg.hfBookingsEnabled === true ? 1 : 0, uid, host.uid, insertNow, plannedEnd).run();
    if (Number(inserted.meta?.changes ?? 0) !== 1) {
      await undo();
      return err(409, "booking_window_conflict", "A scheduled booking overlaps this call window.");
    }
  } catch (e) {
    await undo();
    await trackException(env, e, { uid, route: "/api/hf/calls", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "insert" } });
    return err(500, "internal_error", "Something went wrong.");
  }
  try {
    const r = await callStub(env, callId).fetch("https://hfcall/init", {
      method: "POST",
      body: JSON.stringify({ callId, callerUid: uid, hostUid: host.uid, ...(bookingCutoff != null ? { hardEndsAt: bookingCutoff } : {}), rateRupees: rate, reservedRupees: paidReserved, testReservedRupees: testReserved, fundsRupees, maxMinutes, limitReason }),
    });
    if (!r.ok) return err(502, "call_failed", "We couldn't place the call. Please try again.");
  } catch (e) {
    await env.DB_META.prepare("UPDATE hf_calls SET status='failed', end_reason='error', ended_at=?1 WHERE id=?2 AND status='ringing_host'").bind(Date.now(), callId).run().catch(() => undefined);
    await undo();
    await trackException(env, e, { uid, route: "/api/hf/calls", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "init" } });
    return err(502, "call_failed", "We couldn't place the call. Please try again.");
  }
  void track(env, uid, "hf_call_started", HF_CALL_APP, { area: "hf_call", call_id: callId, rate_rupees: rate, lane, max_minutes: maxMinutes }).catch(() => undefined);
  return json({ ok: true, callId, status: "ringing_host", rate, maxMinutes });
}

// ── GET /api/hf/calls/:id ────────────────────────────────────────────────────
const tokCall = (c: HfCallRow): { micro: number; secs: number } | null => {
  return c.tokens_spent_micro == null
    ? null
    : { micro: Number(c.tokens_spent_micro), secs: Number(c.billable_seconds ?? 0) };
};
// [HF-WIRE-7] The caller is told to top up when fewer than this many seconds of funds remain (3 minutes). Served in the estimate and the status.
export const LOW_BALANCE_SECONDS = 180;
/** App-facing phase of a call row: ringing_host | host_accepted | dialing_fan | connected | ended. */
export function callPhase(c: { status: string; host_answered_at?: number | null }): string {
  if (c.status === "connected") return "connected";
  if (c.status === "ringing_caller") return "dialing_fan";
  if (c.status === "ringing_host") return c.host_answered_at ? "host_accepted" : "ringing_host";
  return "ended"; // completed | host_declined | no_answer | caller_no_answer | failed | blocked
}
/** Why an ended call ended, in the app's words: declined | missed | busy | offline | no_balance | ended. null while it is still live. */
export function callReason(c: { status: string; end_reason?: string | null }): string | null {
  if (c.status === "host_declined") return "declined";
  if (c.status === "no_answer" || c.status === "caller_no_answer") return "missed";
  if (c.status === "blocked") return "busy";
  if (c.status === "failed") return c.end_reason === "caller_hangup" ? "ended" : "offline"; // the caller cancelled: not the host's doing
  if (c.status === "completed") return c.end_reason === "balance" ? "no_balance" : "ended";
  return null;
}
/** Money fields for the call screen. Numbers only; never a phone number. */
async function liveFields(env: Env, c: HfCallRow, pricingRaw: string | null | undefined, std: Tariff | null, isCaller: boolean): Promise<Record<string, unknown>> {
  const phase = callPhase(c);
  const reason = phase === "ended" ? callReason(c) : null;
  const consumed = (c as unknown as { consumed_value_paise?: number | null }).consumed_value_paise;
  // The caller sees what the call cost; the host never sees the caller's money (costPaise 0, walletPaise null).
  const out: Record<string, unknown> = { phase, reason, lowBalanceSeconds: LOW_BALANCE_SECONDS, costPaise: isCaller ? Math.max(0, Math.trunc(Number(consumed ?? c.charged_paise ?? 0))) : 0, walletPaise: null, capAt: null,
    // [HF-CALL-MODES-C] chunk billing: fundedUntil = epoch ms the call is paid to, short = the next chunk could not be funded (the caller was told). null / false otherwise.
    fundedUntil: null, short: false };
  if (phase !== "connected" || c.connected_at == null || !isCaller) return out;
  const secs = Math.max(0, Math.floor((Date.now() - Number(c.connected_at)) / 1000));
  let creatorRate: number | null = null;
  try { const j = JSON.parse(pricingRaw ?? "null"); if (validCreatorSnapshot(j)) creatorRate = Number((j as CreatorSnapshot).ratePaise); } catch { /* legacy snapshot */ }
  const costAt = (s: number): number => std ? chargePaise(std, s) : creatorRate != null ? chargePaise(creatorRate, s) : Math.ceil(s / 60) * Math.max(0, Math.trunc(Number(c.rate_paise ?? 0)));
  out.costPaise = costAt(secs);
  try {
    const r = await callStub(env, c.id).fetch("https://hfcall/info", { method: "POST", body: "{}" });
    if (r.ok) {
      const i = (await r.json()) as { maxSeconds?: number; hardEndsAt?: number | null; fundsPaise?: number | null; fundedSec?: number | null; short?: boolean };
      // [HF-CALL-MODES-C] with chunk billing the call ends at what is PAID FOR so far (moves up with every chunk and every top-up), never past the hard cap.
      const capMs = Math.max(0, Math.trunc(Number(i.maxSeconds ?? 0))) * 1000;
      const fundedMs = i.fundedSec != null ? Math.max(0, Math.trunc(Number(i.fundedSec))) * 1000 : null;
      const maxMs = fundedMs != null ? Math.min(fundedMs, capMs) : capMs;
      let capAt = Number(c.connected_at) + maxMs;
      if (i.hardEndsAt != null) capAt = Math.min(capAt, Number(i.hardEndsAt));
      out.capAt = maxMs > 0 ? capAt : null;
      if (fundedMs != null) { out.fundedUntil = maxMs > 0 ? capAt : null; out.short = i.short === true; }
      const funds = i.fundsPaise != null ? Number(i.fundsPaise) : costAt(Math.floor(maxMs / 1000));
      out.walletPaise = Math.max(0, Math.trunc(funds - Number(out.costPaise)));
    }
  } catch { /* status still answers without the cap */ }
  return out;
}
async function getCall(req: Request, env: Env, id: string): Promise<Response> {
  if (!(await callsOn(env))) return NOT_ENABLED();
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  const c = await env.DB_META.prepare("SELECT * FROM hf_calls WHERE id=?1").bind(id).first<HfCallRow>();
  if (!c || (c.caller_uid !== u.uid && c.host_uid !== u.uid)) return err(404, "not_found", "Call not found.");
  const h = await env.DB_META.prepare("SELECT slug, display_name FROM hf_hosts WHERE uid=?1").bind(c.host_uid).first<{ slug: string | null; display_name: string | null }>().catch(() => null);
  const pricingRaw = (c as unknown as { pricing_snapshot?: string | null }).pricing_snapshot;
  const frozenStandard = stdTariffOf(pricingRaw);
  let frozenCreator = false;
  try { frozenCreator = validCreatorSnapshot(JSON.parse(pricingRaw ?? "null")); } catch { /* legacy snapshot */ }
  let canReview = false;
  if (c.caller_uid === u.uid && c.status === "completed" && hasPositiveCallDuration(c) && Date.now() - Number(c.ended_at ?? c.created_at) < REVIEW_WINDOW_MS) {
    const rv = await env.DB_META.prepare("SELECT 1 AS x FROM hf_reviews WHERE call_id=?1").bind(id).first().catch(() => null);
    canReview = !rv;
  }
  const live = await liveFields(env, c, pricingRaw, frozenStandard, c.caller_uid === u.uid);
  // [HF-WIRE-13] rule 3: tell the CALLER when the charge is the first-minute one (the app shows the owner's sentence; the host sees nothing about it).
  const moneyRule = (c as unknown as { money_rule?: string | null }).money_rule ?? null;
  const dropped = c.caller_uid === u.uid && moneyRule === RULE_FIRST_MINUTE_DROP;
  const droppedPaise = dropped ? Math.max(0, Math.trunc(Number((c as unknown as { consumed_value_paise?: number | null }).consumed_value_paise ?? c.charged_paise ?? 0))) : 0;
  return json({
    id: c.id, status: c.status, hostSlug: h?.slug ?? null, hostName: h?.display_name ?? null, rate: rupees(c.rate_paise),
    connectedAt: c.connected_at, endedAt: c.ended_at, billedMinutes: c.billed_minutes, chargedRupees: rupees(c.charged_paise), endReason: c.end_reason, canReview,
    ...live, // [HF-WIRE-7] additive: phase, reason, costPaise, walletPaise, capAt, lowBalanceSeconds; [HF-CALL-MODES-C] fundedUntil, short
    source: ((c as unknown as { source?: string | null }).source ?? ((c as unknown as { booking_id?: string | null }).booking_id ? "booking" : "instant")), // [HF-CALL-MODES-C]
    ...(dropped ? { moneyRule: RULE_FIRST_MINUTE_DROP, firstMinuteDrop: true, firstMinuteChargePaise: droppedPaise, firstMinuteMessage: firstMinuteMessage(droppedPaise) } : {}), // [HF-WIRE-13]
    plan: frozenCreator ? "creator" : frozenStandard ? "standard" : "host_rate",
    rateTiers: frozenStandard
      ? frozenStandard.tiers.map((tier, index) => ({ fromMin: tier.fromSec / 60, toMin: index + 1 < frozenStandard.tiers.length ? frozenStandard.tiers[index + 1].fromSec / 60 : null, paisePerMin: tier.paisePerMin }))
      : [{ fromMin: 0, toMin: null, paisePerMin: Math.max(0, Math.trunc(Number(c.rate_paise ?? 0))) }],
    // [HF-TOK-CALLS-1] token calls: seconds billed for both; [HF-STD-PLAN-1] the CALLER sees the rupee charge (and the per-band breakdown on a
    // Standard call), the HOST sees only his rupee earnings. Margins and phone costs are admin-only.
    ...(tokCall(c)
      ? c.caller_uid === u.uid
        ? (() => {
          const x = c as unknown as { consumed_value_paise?: number | null; pricing_snapshot?: string | null };
          const charged = Math.max(0, Math.trunc(Number(x.consumed_value_paise ?? c.charged_paise ?? 0)));
          const t = stdTariffOf(x.pricing_snapshot);
          return {
            billableSeconds: tokCall(c)!.secs, chargedPaise: charged, charged: formatRupees(charged),
            ...(t ? { tiers: tierBreakdown(t, tokCall(c)!.secs) } : {}),
          };
        })()
        : { billableSeconds: tokCall(c)!.secs, earningPaise: Math.max(0, Math.trunc(Number(c.host_earning_paise ?? 0))), earningRupees: rupees(c.host_earning_paise), earning: formatRupees(Math.max(0, Math.trunc(Number(c.host_earning_paise ?? 0)))) }
      : {}),
  }, 200, { "cache-control": "private, no-store" });
}

async function cancelCall(req: Request, env: Env, id: string): Promise<Response> {
  if (!(await callsOn(env))) return NOT_ENABLED();
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  const c = await env.DB_META.prepare("SELECT caller_uid, status FROM hf_calls WHERE id=?1").bind(id).first<{ caller_uid: string; status: string }>();
  if (!c || c.caller_uid !== u.uid) return err(404, "not_found", "Call not found.");
  if (c.status === "connected") return err(409, "already_connected", "The call is already connected.");
  if (c.status !== "ringing_host" && c.status !== "ringing_caller") return json({ ok: true, status: c.status });
  const r = await callStub(env, id).fetch("https://hfcall/cancel", { method: "POST", body: "{}" });
  const out = (await r.json().catch(() => ({}))) as { ok?: boolean; status?: string };
  if (r.status === 409) return err(409, "already_connected", "The call is already connected.");
  if (!r.ok) return err(503, "cancel_pending", "We're still stopping the call. Please hang up on your phone too.");
  return json({ ok: true, status: out.status ?? "failed" });
}

/** Caller-owned end is valid before or after connect. The DO owns the end timestamp and idempotent settlement. */
async function endCall(req: Request, env: Env, id: string): Promise<Response> {
  if (!(await callsOn(env))) return NOT_ENABLED();
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  const c = await env.DB_META.prepare("SELECT caller_uid, status FROM hf_calls WHERE id=?1").bind(id).first<{ caller_uid: string; status: string }>();
  if (!c || c.caller_uid !== u.uid) return err(404, "not_found", "Call not found.");
  if (!["ringing_host", "ringing_caller", "connected"].includes(c.status)) return json({ ok: true, status: c.status });
  const response = await callStub(env, id).fetch("https://hfcall/end", { method: "POST", body: "{}" });
  if (response.status === 503) return err(503, "end_pending", "We're still ending the phone connection. Hang up on your phone too, and we'll keep checking.");
  if (!response.ok) return err(502, "end_failed", "We couldn't end the call. Please try again.");
  return json(await response.json(), 200, { "cache-control": "private, no-store" });
}

async function walletGet(req: Request, env: Env): Promise<Response> {
  if (!(await callsOn(env))) return NOT_ENABLED();
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  return walletGetFor(env, u.uid);
}

/** [HF-ADMIN-COMPLETE-1] The wallet exactly as GET /api/hf/wallet computes it, for any uid (the admin member page reuses this, so the
 *  admin sees the same rupee figure the member sees). No auth here: callers must have authorised already. */
export async function walletGetFor(env: Env, uid: string): Promise<Response> {
  const u = { uid };
  // [HF-TOK-CALLS-1] token mode: callers see tokens (2 decimals) + the per-value breakdown + any amount owed; hosts see rupees only.
  const cfgAll = (await readConfig(env).catch(() => ({}))) as Record<string, unknown>;
  const tkCfg = readHfTokenConfig(cfgAll);
  if (tkCfg.enabled) {
    return readHfStdPlan(cfgAll).enabled
      ? await walletGetStandard(env, u.uid, tkCfg, cfgAll)
      : await walletGetTokens(env, u.uid, tkCfg);
  }
  // [HF-WALLET-1] paid (withdrawable) money and spend-only test credits are reported separately; host block only for hosts.
  const snap = await walletOp(env, u.uid, { op: "balance", uid: u.uid });
  const paidBalance = snap.status === 200 ? Math.max(0, Math.trunc(Number(snap.body?.balance ?? 0))) : 0;
  const held = snap.status === 200 ? Math.max(0, Math.trunc(Number(snap.body?.held ?? 0))) : 0;
  const test = await getTestBalance(env, u.uid);
  const isHost = !!(await env.DB_META.prepare("SELECT 1 AS x FROM hf_hosts WHERE uid=?1").bind(u.uid).first().catch(() => null));

  type H = { at: number; kind: string; rupees: number; label: string; callId?: string };
  const hist: H[] = [];
  const ledger = (await env.DB_META.prepare(
    "SELECT kind, delta, note, created_at FROM hf_credit_ledger WHERE uid=?1 AND kind IN ('grant','migrate','admin_reverse') ORDER BY created_at DESC LIMIT 50",
  ).bind(u.uid).all<{ kind: string; delta: number; note: string | null; created_at: number }>().catch(() => ({ results: [] }))).results ?? [];
  for (const l of ledger) {
    hist.push({ at: l.created_at, kind: l.kind === "admin_reverse" ? "test_credit_removed" : "test_credit", rupees: Number(l.delta), label: l.kind === "grant" ? "Test credits added" : l.kind === "migrate" ? "Test credits (moved from wallet)" : "Test credits removed" });
  }
  const calls = (await env.DB_META.prepare(
    `SELECT c.id, c.caller_uid, c.created_at, c.ended_at, c.billed_minutes, c.charged_paise, c.paid_rupees, c.test_rupees, c.host_paid_rupees, c.host_test_rupees, c.host_earned_tokens,
            (SELECT display_name FROM hf_hosts h WHERE h.uid=c.host_uid) AS host_name, (SELECT display_name FROM users x WHERE x.uid=c.caller_uid) AS caller_name
       FROM hf_calls c WHERE (c.caller_uid=?1 OR c.host_uid=?1) AND c.status='completed' AND c.billed_minutes>=1 ORDER BY c.created_at DESC LIMIT 50`,
  ).bind(u.uid).all<{ id: string; caller_uid: string; created_at: number; ended_at: number | null; billed_minutes: number; charged_paise: number; paid_rupees: number | null; test_rupees: number | null; host_paid_rupees: number | null; host_test_rupees: number | null; host_earned_tokens: number | null; host_name: string | null; caller_name: string | null }>()
    .catch(() => ({ results: [] }))).results ?? [];
  for (const c of calls) {
    const at = Number(c.ended_at ?? c.created_at);
    if (c.caller_uid === u.uid) {
      hist.push({ at, kind: "call_spent", rupees: -Math.round(Number(c.charged_paise ?? 0)) / 100, label: `Call with ${callerHandle(c.host_name)} (${c.billed_minutes} min)`, callId: c.id });
    } else {
      const paid = Number(c.host_paid_rupees ?? c.host_earned_tokens ?? 0), t = Number(c.host_test_rupees ?? 0);
      hist.push({ at, kind: "call_earned", rupees: paid + t, label: `Call with ${callerHandle(c.caller_name)} (${c.billed_minutes} min)${t > 0 ? ` - ₹${t} from test credits, not withdrawable` : ""}`, callId: c.id });
    }
  }
  hist.sort((a, b) => b.at - a.at);

  let host: { heldRupees: number; availableRupees: number; testEarningsRupees: number; lifetimePaidEarnings: number } | undefined;
  if (isHost) {
    const te = await env.DB_META.prepare("SELECT COALESCE(SUM(rupees),0) AS t FROM hf_host_test_earnings WHERE host_uid=?1").bind(u.uid).first<{ t: number }>().catch(() => null);
    const life = await env.DB_META.prepare("SELECT COALESCE(SUM(COALESCE(host_paid_rupees, host_earned_tokens)),0) AS p FROM hf_calls WHERE host_uid=?1").bind(u.uid).first<{ p: number }>().catch(() => null);
    host = { heldRupees: held, availableRupees: paidBalance, testEarningsRupees: Number(te?.t ?? 0), lifetimePaidEarnings: Number(life?.p ?? 0) };
  }
  return json({
    balanceRupees: paidBalance, testCredits: true, // legacy fields kept for older clients
    paidBalance, testBalance: test.balance, spendable: paidBalance + test.balance, ...(host ? { host } : {}), history: hist.slice(0, 50),
  }, 200, { "cache-control": "private, no-store" });
}

const rs = (paise: number) => Math.round(paise) / 100;
/** [HF-STD-PLAN-1] The Standard tariff frozen on a call row, or null for an old host-rate call. */
function stdTariffOf(snapshot: string | null | undefined): Tariff | null {
  if (!snapshot) return null;
  try { const j = JSON.parse(snapshot); return j && j.plan === "std" && validTariff(j.tariff) ? (j.tariff as Tariff) : null; } catch { return null; }
}
async function walletGetTokens(env: Env, uid: string, tk: ReturnType<typeof readHfTokenConfig>): Promise<Response> {
  const [sum, isHostRow, allLots] = await Promise.all([
    balanceSummary(env, uid),
    env.DB_META.prepare("SELECT 1 AS x FROM hf_hosts WHERE uid=?1").bind(uid).first().catch(() => null),
    getLots(env, uid),
  ]);
  const testMicro = allLots.filter((l) => l.kind === "test").reduce((t, l) => t + l.leftMicro, 0);
  type H = { at: number; kind: string; tokens?: string; label: string; callId?: string };
  const hist: H[] = [];
  const led = (await env.DB_META.prepare(
    "SELECT kind, delta_micro, created_at FROM hf_token_ledger WHERE uid=?1 AND kind IN ('purchase','admin_adjust','refund_revoke','debt_create','debt_clear') ORDER BY created_at DESC LIMIT 50",
  ).bind(uid).all<{ kind: string; delta_micro: number; created_at: number }>().catch(() => ({ results: [] }))).results ?? [];
  const lbl: Record<string, string> = { purchase: "Money added", admin_adjust: "Test credit added", refund_revoke: "Money removed (refund)", debt_create: "Amount owed after a refund", debt_clear: "Amount owed paid from new money" };
  for (const l of led) {
    const d = Number(l.delta_micro);
    hist.push({ at: Number(l.created_at), kind: l.kind, tokens: `${d < 0 ? "-" : l.kind === "debt_create" ? "" : "+"}${formatTokens(Math.abs(d), 2)}`, label: lbl[l.kind] ?? l.kind });
  }
  const calls = (await env.DB_META.prepare(
    `SELECT c.id, c.created_at, c.ended_at, c.billable_seconds, c.tokens_spent_micro, (SELECT display_name FROM hf_hosts h WHERE h.uid=c.host_uid) AS host_name
       FROM hf_calls c WHERE c.caller_uid=?1 AND c.status='completed' AND c.tokens_spent_micro IS NOT NULL AND c.billable_seconds>0 ORDER BY c.created_at DESC LIMIT 50`,
  ).bind(uid).all<{ id: string; created_at: number; ended_at: number | null; billable_seconds: number; tokens_spent_micro: number; host_name: string | null }>().catch(() => ({ results: [] }))).results ?? [];
  for (const c of calls) {
    hist.push({ at: Number(c.ended_at ?? c.created_at), kind: "call_spent", tokens: `-${formatTokens(Number(c.tokens_spent_micro), 2)}`, label: `Call with ${callerHandle(c.host_name)} (${formatDuration(Number(c.billable_seconds))})`, callId: c.id });
  }
  hist.sort((a, b) => b.at - a.at);

  let host: Record<string, unknown> | undefined;
  if (isHostRow) {
    const [hs, per] = await Promise.all([hostSummary(env, uid), listCallEarnings(env, uid, 50)]);
    const payouts = (await env.DB_META.prepare("SELECT id, amount_rupees, status, created_at, paid_at FROM hf_payout_requests WHERE host_uid=?1 AND NOT (status='cancelled' AND reject_reason LIKE 'system:%') ORDER BY created_at DESC LIMIT 50")
      .bind(uid).all<{ id: string; amount_rupees: number; status: string; created_at: number; paid_at: number | null }>().catch(() => ({ results: [] }))).results ?? [];
    host = {
      currency: "INR",
      pendingPaise: hs.pendingPaise, availablePaise: hs.availablePaise, totalEarnedPaise: hs.earnedPaise, testEarningsPaise: hs.testPaise,
      openPayoutPaise: hs.openPayoutPaise, paidOutPaise: hs.paidOutPaise,
      pendingRupees: rs(hs.pendingPaise), availableRupees: rs(hs.availablePaise), totalEarnedRupees: rs(hs.earnedPaise), testEarningsRupees: rs(hs.testPaise),
      heldRupees: rs(hs.pendingPaise), lifetimePaidEarnings: rs(hs.earnedPaise),
      perCall: per.map((p) => ({ callId: p.callId, at: p.at, earnedPaise: p.paidPaise + p.testPaise, paidPaise: p.paidPaise, testPaise: p.testPaise, availableAt: p.availableAt })),
      payouts: payouts.map((p) => ({ id: p.id, amountPaise: Number(p.amount_rupees) * 100, status: p.status, createdAt: Number(p.created_at), paidAt: p.paid_at == null ? null : Number(p.paid_at) })),
    };
  }
  return json({
    mode: "tokens",
    tokens: {
      balance: formatTokens(sum.totalMicro, 2), balanceMicro: sum.totalMicro, testTokens: formatTokens(testMicro, 2), available: formatTokens(sum.availableMicro, 2), availableMicro: sum.availableMicro,
      byValue: sum.byValue.map((b) => ({ valuePaisePerToken: b.valuePaisePerToken, valueRupees: (b.valuePaisePerToken / 100).toFixed(2), tokens: formatTokens(b.micro, 2), micro: b.micro })),
      debt: { tokens: formatTokens(sum.debtMicro, 2), micro: sum.debtMicro, valuePaise: sum.debtValuePaise, open: sum.debtValuePaise > 0 || sum.debtMicro > 0 },
      activeValuePaisePerToken: await activeValuePaise(env, tk),
    },
    balanceRupees: 0, testCredits: true, paidBalance: 0, testBalance: Number(formatTokens(testMicro, 2)), spendable: 0,
    ...(host ? { host } : {}), history: hist.slice(0, 50),
  }, 200, { "cache-control": "private, no-store" });
}

async function walletGetStandard(env: Env, uid: string, tk: ReturnType<typeof readHfTokenConfig>, cfgAll: Record<string, unknown>): Promise<Response> {
  const [sum, isHostRow, allLots] = await Promise.all([
    balanceSummary(env, uid),
    env.DB_META.prepare("SELECT 1 AS x FROM hf_hosts WHERE uid=?1").bind(uid).first().catch(() => null),
    getLots(env, uid),
  ]);
  // [HF-STD-PLAN-1] Every amount below is RUPEES in paise (amountPaise, signed) with a ready "+₹101.69" string. `tokens` stays only as a legacy
  // copy of the same rupee figure for app builds that still read it.
  type H = { at: number; kind: string; amountPaise: number; amount: string; tokens?: string; label: string; callId?: string;
    purchase?: { paidPaise: number; gstPaise: number; walletPaise: number; orderId: string | null } };
  const hist: H[] = [];
  const sign = (p: number, owed = false) => `${p < 0 ? "-" : owed ? "" : "+"}${formatRupees(Math.abs(p))}`;
  const led = (await env.DB_META.prepare(
    // A call-charge correction writes two rows (the credit and the "Call charge corrected" marker): show only the marker, linked to the call.
    `SELECT l.kind, l.delta_micro, l.rupee_value_paise, l.created_at, l.lot_id, l.call_id, t.paid_paise, t.gst_paise, t.provider_ref
       FROM hf_token_ledger l LEFT JOIN hf_token_lots t ON t.id = l.lot_id
      WHERE l.uid=?1 AND l.kind IN ('purchase','admin_adjust','refund_revoke','debt_create','debt_clear','call_refund','payout_take','payout_return')
        AND NOT (l.kind IN ('purchase','admin_adjust') AND (l.note LIKE 'call_refund:%' OR l.note LIKE 'payout_return:%'))
        AND NOT (l.kind='admin_adjust' AND l.note = 'hf_std_migration') ORDER BY l.created_at DESC LIMIT 50`,
  ).bind(uid).all<{ kind: string; delta_micro: number; rupee_value_paise: number; created_at: number; lot_id: string | null; call_id: string | null; paid_paise: number | null; gst_paise: number | null; provider_ref: string | null }>().catch(() => ({ results: [] }))).results ?? [];
  const lbl: Record<string, string> = {
    purchase: "Money added", admin_adjust: "Test credit added", refund_revoke: "Money removed (refund)", debt_create: "Amount owed after a refund",
    debt_clear: "Amount owed paid from new money", call_refund: "Call charge corrected",
    // [HF-WIRE-13] refunds only ever land in the wallet; a withdrawal that is cancelled or rejected returns here too.
    payout_take: "Withdrawal to your UPI", payout_return: "Withdrawal returned to your wallet",
  };
  for (const l of led) {
    const neg = Number(l.delta_micro) < 0 || l.kind === "refund_revoke" || l.kind === "debt_clear";
    const v = Math.abs(Math.trunc(Number(l.rupee_value_paise ?? 0)));
    const amt = l.kind === "debt_create" ? v : neg ? -v : v;
    hist.push({
      at: Number(l.created_at), kind: l.kind, amountPaise: amt, amount: sign(amt, l.kind === "debt_create"), tokens: (amt / 100).toFixed(2), label: lbl[l.kind] ?? l.kind,
      ...(l.kind === "call_refund" && l.call_id ? { callId: l.call_id } : {}),
      ...(l.kind === "purchase" ? { purchase: { paidPaise: Number(l.paid_paise ?? 0), gstPaise: Number(l.gst_paise ?? 0), walletPaise: v, orderId: l.provider_ref } } : {}),
    });
  }
  const calls = (await env.DB_META.prepare(
    `SELECT c.id, c.created_at, c.ended_at, c.billable_seconds, c.consumed_value_paise, c.money_rule, (SELECT display_name FROM hf_hosts h WHERE h.uid=c.host_uid) AS host_name
       FROM hf_calls c WHERE c.caller_uid=?1 AND c.status='completed' AND c.tokens_spent_micro IS NOT NULL AND (c.billable_seconds>0 OR c.consumed_value_paise>0) ORDER BY c.created_at DESC LIMIT 50`,
  ).bind(uid).all<{ id: string; created_at: number; ended_at: number | null; billable_seconds: number; consumed_value_paise: number | null; money_rule: string | null; host_name: string | null }>().catch(() => ({ results: [] }))).results ?? [];
  for (const c of calls) {
    const p = -Math.max(0, Math.trunc(Number(c.consumed_value_paise ?? 0)));
    hist.push({ at: Number(c.ended_at ?? c.created_at), kind: "call_spent", amountPaise: p, amount: sign(p), tokens: (p / 100).toFixed(2), label: c.money_rule === RULE_FIRST_MINUTE_DROP ? `Call with ${callerHandle(c.host_name)} (ended in the first minute)` : `Call with ${callerHandle(c.host_name)} (${formatDuration(Number(c.billable_seconds))})`, callId: c.id });
  }
  hist.sort((a, b) => b.at - a.at);
  const testPaise = allLots.filter((l) => l.kind === "test").reduce((t, l) => t + Math.floor((l.leftMicro * l.valuePaisePerToken) / 1_000_000), 0);

  let host: Record<string, unknown> | undefined;
  if (isHostRow) {
    const [hs, per] = await Promise.all([hostSummary(env, uid), listCallEarnings(env, uid, 50)]);
    const payouts = (await env.DB_META.prepare("SELECT id, amount_rupees, status, created_at, paid_at FROM hf_payout_requests WHERE host_uid=?1 AND NOT (status='cancelled' AND reject_reason LIKE 'system:%') ORDER BY created_at DESC LIMIT 50")
      .bind(uid).all<{ id: string; amount_rupees: number; status: string; created_at: number; paid_at: number | null }>().catch(() => ({ results: [] }))).results ?? [];
    host = {
      currency: "INR",
      pendingPaise: hs.pendingPaise, availablePaise: hs.availablePaise, totalEarnedPaise: hs.earnedPaise, testEarningsPaise: hs.testPaise,
      openPayoutPaise: hs.openPayoutPaise, paidOutPaise: hs.paidOutPaise,
      pendingRupees: rs(hs.pendingPaise), availableRupees: rs(hs.availablePaise), totalEarnedRupees: rs(hs.earnedPaise), testEarningsRupees: rs(hs.testPaise),
      heldRupees: rs(hs.pendingPaise), lifetimePaidEarnings: rs(hs.earnedPaise), // same names the old host block used, now with paise
      perCall: per.map((p) => ({ callId: p.callId, at: p.at, earnedPaise: p.paidPaise + p.testPaise, paidPaise: p.paidPaise, testPaise: p.testPaise, availableAt: p.availableAt })),
      payouts: payouts.map((p) => ({ id: p.id, amountPaise: Number(p.amount_rupees) * 100, status: p.status, createdAt: Number(p.created_at), paidAt: p.paid_at == null ? null : Number(p.paid_at) })),
    };
  }
  return json({
    mode: "rupees",
    // [HF-STD-PLAN-1] The wallet in rupees (integer paise + display strings). Reserved = held for a call in progress.
    wallet: {
      currency: "INR",
      balancePaise: sum.totalPaise, availablePaise: sum.availablePaise, reservedPaise: Math.max(0, sum.totalPaise - sum.availablePaise),
      paidPaise: sum.availablePaidPaise, testPaise, debtPaise: sum.debtValuePaise,
      balance: formatRupees(sum.totalPaise), available: formatRupees(sum.availablePaise), test: formatRupees(testPaise), debt: formatRupees(sum.debtValuePaise),
      debtOpen: sum.debtValuePaise > 0 || sum.debtMicro > 0,
    },
    plan: hfStdPlanPublic(cfgAll),
    // legacy copy for app builds before HF-STD-PLAN-1: the same RUPEE figures as plain numbers with 2 decimals (no token values any more).
    tokens: {
      balance: (sum.totalPaise / 100).toFixed(2), balanceMicro: sum.totalMicro, testTokens: (testPaise / 100).toFixed(2), available: (sum.availablePaise / 100).toFixed(2), availableMicro: sum.availableMicro,
      byValue: sum.byValue.map((b) => ({ valuePaisePerToken: b.valuePaisePerToken, valueRupees: (b.valuePaisePerToken / 100).toFixed(2), tokens: formatTokens(b.micro, 2), micro: b.micro })),
      debt: { tokens: formatTokens(sum.debtMicro, 2), micro: sum.debtMicro, valuePaise: sum.debtValuePaise, open: sum.debtValuePaise > 0 || sum.debtMicro > 0 },
      activeValuePaisePerToken: await activeValuePaise(env, tk),
    },
    // legacy fields kept so an older client renders zeros instead of breaking
    balanceRupees: 0, testCredits: true, paidBalance: 0, testBalance: testPaise / 100, spendable: 0,
    ...(host ? { host } : {}),
    history: hist.slice(0, 50),
  }, 200, { "cache-control": "private, no-store" });
}

// GET /api/hf/wallet/estimate?host=<slug>  -> what a call with this host costs THIS caller, in tokens (token mode) or rupees (old mode)
// [HF-WIRE-7] Adds the low-balance threshold (3 minutes) to every successful estimate so the app never hard-codes it.
async function walletEstimate(req: Request, env: Env): Promise<Response> {
  const res = await walletEstimateInner(req, env);
  if (res.status !== 200) return res;
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return res;
  // [HF-WIRE-13] rule 1: the server owns the wallet minimum; below it the answer is "cannot start" with the owner's words.
  const rules = await readMoneyRules(env);
  const out: Record<string, unknown> = { ...body, lowBalanceSeconds: LOW_BALANCE_SECONDS, minBalancePaise: rules.minBalancePaise, lowBalanceMessage: lowBalanceMessage(rules.minBalancePaise) };
  if (typeof body.balancePaise === "number" && body.balancePaise < rules.minBalancePaise) {
    out.canStart = false;
    out.startNeedPaise = Math.max(Number(body.startNeedPaise ?? 0), rules.minBalancePaise);
    if (typeof body.startNeedPaise === "number") out.startNeed = formatRupees(out.startNeedPaise as number);
  }
  return json(out, 200, { "cache-control": "private, no-store" });
}
async function walletEstimateInner(req: Request, env: Env): Promise<Response> {
  if (!(await callsOn(env))) return NOT_ENABLED();
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  const slug = String(new URL(req.url).searchParams.get("host") ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) return err(404, "not_found", "Host not found.");
  const h = await env.DB_META.prepare("SELECT price_per_min, category FROM hf_hosts WHERE slug=?1 AND status='live'").bind(slug).first<{ price_per_min: number; category: string }>().catch(() => null);
  if (!h) return err(404, "not_found", "Host not found.");
  const rate = Math.trunc(Number(h.price_per_min));
  const cfgAll = (await readConfig(env).catch(() => ({}))) as Record<string, unknown>;
  const tk = readHfTokenConfig(cfgAll);
  const stdWallet = readHfStdPlan(cfgAll).enabled; // [HF-WIRE-18] wallet stays rupee-based; only pricing switches
  const std = pricingStd(readHfStdPlan(cfgAll), cfgAll);
  if (isCreatorCategory(h.category)) {
    if (!validCreatorRate(rate)) return err(409, "invalid_pricing", "This listing's price is unavailable.");
    const [lots, v, sum] = await Promise.all([availableLots(env, u.uid), activeValuePaise(env, tk), balanceSummary(env, u.uid)]);
    const snapshot = creatorSnapshotFor(h.category, rate);
    const e = estimateForHost(lots, snapshot.ratePaise, v);
    return json({ mode: "rupees", plan: "creator", pricingVersion: snapshot.version, category: snapshot.category,
      ratePerMinRupees: e.ratePerMinRupees, ratePaisePerMin: e.ratePaise, aboutText: e.aboutText,
      affordableSeconds: e.affordableSeconds, affordableChargePaise: e.affordableChargePaise, operationalMaxSeconds: MAX_CALL_MINUTES * 60,
      canStart: e.canStart && sum.debtValuePaise <= 0 && sum.debtMicro <= 0, startNeedPaise: snapshot.ratePaise * TOK_START_MINUTES,
      balancePaise: sum.availablePaise, balance: formatRupees(sum.availablePaise), hasDebt: sum.debtValuePaise > 0 || sum.debtMicro > 0,
      tokensPerMinute: e.ratePerMinRupees, taxMode: snapshot.taxMode }, 200, { "cache-control": "private, no-store" });
  }
  if (std.enabled) {
    // [HF-STD-PLAN-1] Same rate card for every host. Wallet affordability is uncapped; the separate 24 h ceiling is operational only.
    const [lots, v, sum] = await Promise.all([availableLots(env, u.uid), activeValuePaise(env, tk), balanceSummary(env, u.uid)]);
    const e = estimateForHost(lots, std.tariff, v, null);
    const needPaise = chargePaise(std.tariff, TOK_START_MINUTES * 60);
    return json({
      mode: "rupees", plan: "standard", ...hfStdPlanPublic(cfgAll),
      ratePerMinRupees: e.ratePerMinRupees, ratePaisePerMin: e.ratePaise, aboutText: e.aboutText, affordableSeconds: e.affordableSeconds, affordableChargePaise: e.affordableChargePaise,
      operationalMaxSeconds: STD_TECH_MAX_SECONDS,
      canStart: e.canStart, startNeedPaise: needPaise, startNeed: formatRupees(needPaise),
      balancePaise: sum.availablePaise, balance: formatRupees(sum.availablePaise), hasDebt: sum.debtValuePaise > 0 || sum.debtMicro > 0,
      tokensPerMinute: e.ratePerMinRupees, // legacy field for older app builds (now the rupee rate)
    }, 200, { "cache-control": "private, no-store" });
  }
  if (!tk.enabled) return json({ mode: "inr", ratePerMinRupees: rate }, 200, { "cache-control": "private, no-store" });
  const [lots, v, sum] = await Promise.all([availableLots(env, u.uid), activeValuePaise(env, tk), balanceSummary(env, u.uid)]);
  const e = estimateForHost(lots, rate * 100, v);
  if (stdWallet) { // [HF-WIRE-18] HF-REEL-37: her own rate on the rupee wallet (same shape as the creator estimate)
    const ir = readInfluencerRate(cfgAll);
    if (rate < ir.minRupees || rate > ir.maxRupees) return err(409, "invalid_pricing", "This listing's price is unavailable.");
    return json({ mode: "rupees", plan: "host_rate", ratePerMinRupees: e.ratePerMinRupees, ratePaisePerMin: e.ratePaise, aboutText: e.aboutText,
      affordableSeconds: e.affordableSeconds, affordableChargePaise: e.affordableChargePaise, operationalMaxSeconds: MAX_CALL_MINUTES * 60,
      canStart: e.canStart && sum.debtValuePaise <= 0 && sum.debtMicro <= 0, startNeedPaise: rate * 100 * TOK_START_MINUTES,
      balancePaise: sum.availablePaise, balance: formatRupees(sum.availablePaise), hasDebt: sum.debtValuePaise > 0 || sum.debtMicro > 0,
      tokensPerMinute: e.ratePerMinRupees }, 200, { "cache-control": "private, no-store" });
  }
  return json({
    mode: "tokens", ratePerMinRupees: rate, tokensPerMinute: e.tokensPerMinute, aboutText: e.aboutText, affordableSeconds: e.affordableSeconds, canStart: e.canStart,
    hasDebt: sum.debtValuePaise > 0 || sum.debtMicro > 0, balance: formatTokens(sum.totalMicro, 2),
  }, 200, { "cache-control": "private, no-store" });
}

// ── host presence ────────────────────────────────────────────────────────────
async function presenceRoute(req: Request, env: Env, p: string, ctx?: ExecutionContext): Promise<Response> {
  // [HF-WIRE-5] the reels app uses presence without calls being open: calls OR reels flag.
  if (!(await callsOn(env)) && !(await reelsOn(env))) return NOT_ENABLED();
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  const host = await env.DB_META.prepare("SELECT uid, status, presence FROM hf_hosts WHERE uid=?1").bind(u.uid).first<{ uid: string; status: string; presence: string | null }>();
  if (!host || host.status !== "live") return err(409, "not_live", "Your profile isn't live yet.");
  const now = Date.now();
  // [HF-PRESENCE-NUDGE-1] nudge_paused comes from an ALTER migration: read it on its own so a worker deployed before the migration still serves presence.
  const nudgesPaused = async (): Promise<boolean> => {
    try { return Number((await env.DB_META.prepare("SELECT nudge_paused FROM hf_hosts WHERE uid=?1").bind(u.uid).first<{ nudge_paused: number }>())?.nudge_paused ?? 0) === 1; } catch { return false; }
  };
  if (req.method === "GET") return json({ ok: true, presence: host.presence ?? "offline", nudgesPaused: await nudgesPaused() }, 200, { "cache-control": "private, no-store" });
  if (p.endsWith("/nudges")) { // PUT {paused:boolean} -> {ok, paused}: pause / resume the 3-hourly "you're offline" reminders
    const b = await readJson(req);
    if (typeof b.paused !== "boolean") return err(400, "invalid_field", "paused must be true or false.");
    try {
      await env.DB_META.prepare("UPDATE hf_hosts SET nudge_paused=?1 WHERE uid=?2").bind(b.paused ? 1 : 0, u.uid).run();
    } catch (e) {
      await trackException(env, e, { route: p, method: "PUT", uid: u.uid, handled: true, app_name: HF_CALL_APP, extra: { area: "hf_presence_nudge" } });
      return err(503, "unavailable", "Try again in a little while.");
    }
    void track(env, u.uid, "hf_presence_nudge_paused", HF_CALL_APP, { area: "hf_presence_nudge", paused: b.paused }).catch(() => undefined);
    return json({ ok: true, paused: b.paused });
  }
  if (p.endsWith("/beat")) {
    await env.DB_META.prepare("UPDATE hf_hosts SET presence_at=?1 WHERE uid=?2 AND presence IN ('online','busy')").bind(now, u.uid).run();
    return json({ ok: true, presence: host.presence ?? "offline" });
  }
  const body = await readJson(req);
  if (typeof body.online !== "boolean") return err(400, "invalid_field", "online must be true or false.");
  if (body.online) {
    if (await isClosing(env, u.uid)) { await forceHostOffline(env, u.uid); return err(409, "account_closing", CLOSING_MESSAGE, { reason: "account_closing" }); } // [HF-WALLET-EXIT-1]
    if (!(await verifiedWhatsAppNumber(env, u.uid))) return err(403, "not_verified", "Verify your WhatsApp number to take calls.");
    await env.DB_META.prepare("UPDATE hf_hosts SET presence=CASE WHEN presence='busy' OR presence_call_id IS NOT NULL THEN 'busy' ELSE 'online' END, presence_at=?1 WHERE uid=?2").bind(now, u.uid).run();
  } else {
    await env.DB_META.prepare("UPDATE hf_hosts SET presence='offline', presence_at=?1 WHERE uid=?2").bind(now, u.uid).run();
  }
  const after = (await env.DB_META.prepare("SELECT presence FROM hf_hosts WHERE uid=?1").bind(u.uid).first<{ presence: string }>())?.presence ?? "offline";
  if (body.online && (host.presence ?? "offline") === "offline" && after === "online") {
    const work = notifyHostOnline(env, ctx, u.uid).catch(() => undefined);
    if (ctx) ctx.waitUntil(work); else await work;
  }
  void track(env, u.uid, "hf_host_presence", HF_CALL_APP, { area: "hf_call", presence: after }).catch(() => undefined);
  return json({ ok: true, presence: after });
}

// ── GET /api/hf/calls (role=caller|host) ─────────────────────────────────────
// [HF-DASH-CALLS-1] Paginated history of calls you made or received, every outcome. Handles only; scoped to the signed-in uid.
const LIVE_STATUSES = "'connected','ringing_host','ringing_caller'";
function b64uEnc(s: string): string { return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function decodeCursor(c: string): { at: number; id: string } | null {
  try {
    const raw = atob(c.replace(/-/g, "+").replace(/_/g, "/"));
    const i = raw.indexOf(":");
    const at = Number(raw.slice(0, i)), id = raw.slice(i + 1);
    return i > 0 && Number.isFinite(at) && at >= 0 && ID_RE.test(id) ? { at, id } : null;
  } catch { return null; }
}
async function listCalls(req: Request, env: Env): Promise<Response> {
  if (!(await callsOn(env))) return NOT_ENABLED();
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  const q = new URL(req.url).searchParams;
  const role = q.get("role") ?? "caller";
  const status = q.get("status") ?? "all";
  if (role !== "caller" && role !== "host") return err(400, "invalid_field", "role must be caller or host.", { field: "role" });
  if (status !== "all" && status !== "completed" && status !== "missed") return err(400, "invalid_field", "status must be all, completed or missed.", { field: "status" });
  const limRaw = q.get("limit");
  let limit = 20;
  if (limRaw != null && limRaw !== "") {
    limit = Number(limRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return err(400, "invalid_field", "limit must be 1 to 50.", { field: "limit" });
  }
  const curRaw = q.get("cursor");
  const cur = curRaw ? decodeCursor(curRaw) : null;
  if (curRaw && !cur) return err(400, "invalid_field", "cursor is not valid.", { field: "cursor" });
  const noStore = { "cache-control": "private, no-store" };
  try {
    if (role === "host") {
      const h = await env.DB_META.prepare("SELECT 1 AS x FROM hf_hosts WHERE uid=?1").bind(u.uid).first();
      if (!h) return json({ ok: true, items: [], nextCursor: null }, 200, noStore);
    }
    const mine = role === "host" ? "c.host_uid" : "c.caller_uid";
    const binds: unknown[] = [u.uid];
    let where = `${mine}=?1`;
    if (status === "completed") where += " AND c.status='completed'";
    else if (status === "missed") where += ` AND c.status NOT IN ('completed',${LIVE_STATUSES})`;
    if (cur) { binds.push(cur.at, cur.id); where += " AND (c.created_at<?2 OR (c.created_at=?2 AND c.id<?3))"; }
    binds.push(limit + 1);
    const other = role === "host"
      ? "(SELECT display_name FROM users x WHERE x.uid=c.caller_uid) AS other_name, NULL AS host_slug"
      : "(SELECT display_name FROM hf_hosts h WHERE h.uid=c.host_uid) AS other_name, (SELECT slug FROM hf_hosts h WHERE h.uid=c.host_uid) AS host_slug";
    const rows = (await env.DB_META.prepare(
      `SELECT c.id, c.status, c.created_at, c.connected_at, c.billed_minutes, c.billable_seconds, c.charged_paise, c.consumed_value_paise, c.host_earning_paise, c.end_reason, ${other}
         FROM hf_calls c WHERE ${where} ORDER BY c.created_at DESC, c.id DESC LIMIT ?${binds.length}`,
    ).bind(...binds).all<{ id: string; status: string; created_at: number; connected_at: number | null; billed_minutes: number | null; billable_seconds: number | null; charged_paise: number | null; consumed_value_paise: number | null; host_earning_paise: number | null; end_reason: string | null; other_name: string | null; host_slug: string | null }>()).results ?? [];
    const page = rows.slice(0, limit);
    // [HF-WIRE-7] the caller's own rating per call (separate, tolerant query: a missing reviews table just means no ratings)
    const stars = new Map<string, number>();
    if (role === "caller" && page.length) {
      const ids = page.map((r) => r.id);
      const rv = (await env.DB_META.prepare(`SELECT call_id, stars FROM hf_reviews WHERE caller_uid=?1 AND call_id IN (${ids.map((_, i) => `?${i + 2}`).join(",")})`)
        .bind(u.uid, ...ids).all<{ call_id: string; stars: number }>().catch(() => ({ results: [] }))).results ?? [];
      for (const x of rv) stars.set(x.call_id, Math.trunc(Number(x.stars)));
    }
    const items = page.map((r) => {
      const secs = r.billable_seconds != null ? Math.max(0, Math.trunc(Number(r.billable_seconds))) : Math.max(0, Math.trunc(Number(r.billed_minutes ?? 0))) * 60;
      const paise = role === "host" ? Number(r.host_earning_paise ?? 0) : Number(r.consumed_value_paise ?? r.charged_paise ?? 0);
      return {
        id: r.id, status: r.status,
        otherHandle: role === "host" ? callerHandle(r.other_name) : (r.other_name || "A host"),
        hostSlug: role === "host" ? null : r.host_slug,
        at: Number(r.connected_at ?? r.created_at), seconds: secs,
        amountPaise: paise > 0 ? Math.trunc(paise) : null, endReason: r.end_reason,
        // [HF-WIRE-7] additive: the app's words for why it ended, and the caller's own star rating (null if none)
        reason: callReason({ status: r.status, end_reason: r.end_reason }),
        myStars: stars.get(r.id) ?? null,
      };
    });
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last ? b64uEnc(`${last.created_at}:${last.id}`) : null;
    return json({ ok: true, items, nextCursor }, 200, noStore);
  } catch (e) {
    await trackException(env, e, { uid: u.uid, route: "/api/hf/calls", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "list", role } });
    return err(500, "internal_error", "Something went wrong.");
  }
}

// ── host dashboard calls (handles only) ──────────────────────────────────────
async function hostCalls(req: Request, env: Env): Promise<Response> {
  if (!(await callsOn(env))) return NOT_ENABLED();
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  const rows = (await env.DB_META.prepare(
    `SELECT c.id, c.status, c.created_at, c.connected_at, c.ended_at, c.billed_minutes, c.host_earning_paise, c.end_reason,
            (SELECT display_name FROM users x WHERE x.uid=c.caller_uid) AS caller_name
       FROM hf_calls c WHERE c.host_uid=?1 ORDER BY c.created_at DESC LIMIT 50`,
  ).bind(u.uid).all<{ id: string; status: string; created_at: number; connected_at: number | null; ended_at: number | null; billed_minutes: number; host_earning_paise: number; end_reason: string | null; caller_name: string | null }>()).results ?? [];
  // "Today" = the host's IST day.
  const istStart = Math.floor((Date.now() + 19_800_000) / 86_400_000) * 86_400_000 - 19_800_000;
  const t = await env.DB_META.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(billed_minutes),0) AS m, COALESCE(SUM(host_earning_paise),0) AS e FROM hf_calls WHERE host_uid=?1 AND status='completed' AND billed_minutes>=1 AND created_at>=?2",
  ).bind(u.uid, istStart).first<{ n: number; m: number; e: number }>();
  return json({
    ok: true,
    calls: rows.map((r) => ({
      id: r.id, status: r.status, callerHandle: callerHandle(r.caller_name), createdAt: r.created_at, connectedAt: r.connected_at, endedAt: r.ended_at,
      billedMinutes: r.billed_minutes, earningRupees: rupees(r.host_earning_paise), endReason: r.end_reason,
    })),
    today: { calls: Number(t?.n ?? 0), minutes: Number(t?.m ?? 0), earningRupees: rupees(t?.e) },
  }, 200, { "cache-control": "private, no-store" });
}

// ── admin ────────────────────────────────────────────────────────────────────
async function adminCredit(req: Request, env: Env): Promise<Response> {
  const a = await adminCtx(req, env);
  if (a instanceof Response) return a;
  const b = await readJson(req);
  let uid = String(b.uid ?? "").trim();
  const phoneIn = String(b.phone ?? "").trim();
  const amount = Number(b.rupees);
  const note = String(b.note ?? "").trim().slice(0, 200);
  let via: "search" | "uid" | "phone" = b.via === "search" && uid ? "search" : "uid";
  let name: string | null = null;
  if (!uid && phoneIn) {
    const q = classifyAdminQuery(phoneIn);
    if (q.type !== "phone") return err(400, "invalid_field", "Enter a valid WhatsApp number.", { field: "phone" });
    const hits = await resolvePhone(env, q);
    if (hits.length === 0) return err(404, "not_found", "No user with that number.");
    if (hits.length > 1) return err(409, "ambiguous", "More than one user matches that number. Search and pick one.");
    uid = hits[0].uid; name = hits[0].name; via = "phone";
  }
  if (!uid || uid.length > 128) return err(400, "invalid_field", "uid or phone is required.", { field: "uid" });
  if (!Number.isInteger(amount) || amount < 1 || amount > 2000) return err(400, "invalid_field", "rupees must be a whole number from 1 to 2000.", { field: "rupees" });
  if (!note) return err(400, "invalid_field", "Add a note saying why.", { field: "note" });
  const exists = await env.DB_META.prepare("SELECT display_name, first_name, last_name FROM users WHERE uid=?1").bind(uid).first<{ display_name: string | null; first_name: string | null; last_name: string | null }>().catch(() => null);
  if (!exists) return err(404, "not_found", "No such user.");
  if (name === null) name = personName(exists);
  const opKey = String(b.opId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || crypto.randomUUID();
  // [HF-WALLET-1] Test credits are spend-only and live in hf_credits, never in the withdrawable wallet.
  // [HF-TOK-LEDGER-1] With hfTokensEnabled on, the amount is RUPEES (1 unit = Rs 1 under gp-r1) and becomes a `test` lot at the active pricing value instead.
  const tk = readHfTokenConfig((await readConfig(env).catch(() => ({}))) as Record<string, unknown>);
  let g: { applied: boolean; balance: number };
  try {
    if (tk.enabled) {
      const t = await grantTestLot(env, uid, amount, opKey, note, tk.pricingVersion);
      if (!t.ok) return err(t.reason === "invalid_amount" ? 400 : 502, t.reason === "invalid_amount" ? "invalid_field" : "pricing_not_ready", t.reason === "invalid_amount" ? "Amount must be whole rupees from 1 to 2000." : "The pricing version is not set up.");
      g = { applied: t.applied, balance: Number(formatTokens(t.totalMicro, 2)) };
    } else g = await grantTestCredits(env, uid, amount, `hftest:${opKey}`, note);
  } catch (e) {
    await trackException(env, e, { uid: a.uid, route: "/api/admin/hf/wallet/credit", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "grant" } });
    return err(502, "wallet_error", "The credit didn't go through.");
  }
  const paid = await hfWalletBalance(env, uid);
  await audit(env, a.uid, "wallet_test_credit", uid, { rupees: amount, note, op: opKey, via });
  void track(env, a.uid, "hf_test_credit_added", HF_CALL_APP, { area: "hf_call", rupees: amount }).catch(() => undefined);
  void track(env, a.uid, "hf_admin_credit_added", HF_CALL_APP, { area: "hf_call", rupees: amount, via }).catch(() => undefined);
  return json({ ok: true, uid, name, balanceRupees: paid, testBalance: g.balance });
}

// POST /api/admin/hf/wallet/migrate-test-credits {dry_run?: boolean (default true)}
// One-off: earlier admin test credits landed in the PAID wallet (type hf_test_credit). Move min(sum credited, current paid balance) per user
// out of the wallet and into hf_credits. Idempotent per user (op ids hfmig:<uid>). Hosts' earlier call earnings cannot be classified; counts only.
async function adminMigrateTestCredits(req: Request, env: Env): Promise<Response> {
  const a = await adminCtx(req, env);
  if (a instanceof Response) return a;
  const b = await readJson(req);
  const dryRun = b.dry_run !== false;
  const rows = (await env.DB_WALLET.prepare(
    "SELECT uid, SUM(amount) AS credited, COUNT(*) AS n FROM wallet_transactions WHERE type='hf_test_credit' AND amount>0 GROUP BY uid LIMIT 500",
  ).all<{ uid: string; credited: number; n: number }>()).results ?? [];
  const report: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const credited = Math.max(0, Math.trunc(Number(r.credited)));
    const paid = await hfWalletBalance(env, r.uid);
    const already = await env.DB_META.prepare("SELECT 1 AS x FROM hf_credit_ledger WHERE op_id=?1").bind(`hfmig:${r.uid}`).first<{ x: number }>().catch(() => null);
    const amount = already ? 0 : Math.min(credited, paid);
    const row: Record<string, unknown> = { uid: r.uid, credited, paidBalance: paid, amount, alreadyMigrated: !!already, moved: false };
    if (!dryRun && amount > 0) {
      const sp = await walletOp(env, r.uid, { op: "spend", uid: r.uid, amount, allow_free: false, op_id: `hfmig:${r.uid}`, app_name: WALLET_APP, ref: "hfmig", context: "Test credits moved to spend-only balance" });
      if (sp.status === 200 && sp.body?.ok === true) {
        await grantTestCredits(env, r.uid, amount, `hfmig:${r.uid}`, "Moved from wallet", "migrate");
        row.moved = true;
      } else row.error = `wallet_${sp.status}`;
    }
    report.push(row);
  }
  const hosts = (await env.DB_META.prepare(
    "SELECT host_uid, COUNT(*) AS calls, COALESCE(SUM(host_earned_tokens),0) AS rupees FROM hf_calls WHERE host_uid IS NOT NULL AND host_paid_rupees IS NULL AND host_earned_tokens>0 GROUP BY host_uid LIMIT 500",
  ).all<{ host_uid: string; calls: number; rupees: number }>().catch(() => ({ results: [] }))).results ?? [];
  await audit(env, a.uid, "migrate_test_credits", "-", { dry_run: dryRun, users: report.length, moved: report.filter((x) => x.moved).length });
  return json({
    ok: true, dryRun, users: report, totalAmount: report.reduce((t, x) => t + Number(x.amount ?? 0), 0),
    unclassifiedHostEarnings: hosts.map((h) => ({ hostUid: h.host_uid, calls: Number(h.calls), rupees: Number(h.rupees) })),
  }, 200, { "cache-control": "private, no-store" });
}

// POST /api/admin/hf/tokens/migrate-test-credits {dry_run?: boolean (default true)}   [HF-TOK-LEDGER-1]
// One-off: hf_credits.test_balance (rupees) -> `test` lots worth the same rupees at the active Play value (gp-r1: Rs 1 = 1 unit, so 1:1), note "migrated from test credits". Idempotent per user (op hftmig:<uid>).
// Admin only; works whether or not hfTokensEnabled is on (run it BEFORE flipping the flag). hf_credits rows are kept.
async function adminMigrateTestToLots(req: Request, env: Env): Promise<Response> {
  const a = await adminCtx(req, env);
  if (a instanceof Response) return a;
  const b = await readJson(req);
  const dryRun = b.dry_run !== false;
  const tk = readHfTokenConfig((await readConfig(env).catch(() => ({}))) as Record<string, unknown>);
  let out;
  try { out = await migrateTestCreditsToLots(env, { dryRun, pricingVersionId: tk.pricingVersion }); } catch (e) {
    await trackException(env, e, { uid: a.uid, route: "/api/admin/hf/tokens/migrate-test-credits", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_tokens", step: "migrate" } });
    return err(502, "migration_failed", "The migration did not run. Check that the wallet tables exist.");
  }
  await audit(env, a.uid, "migrate_test_credits_to_lots", "-", { dry_run: dryRun, users: out.rows.length, moved: out.rows.filter((r) => r.migrated).length, tokens: out.totalTokens });
  return json({ ok: true, dryRun, pricingVersion: tk.pricingVersion, users: out.rows, totalTokens: out.totalTokens }, 200, { "cache-control": "private, no-store" });
}

// GET /api/admin/hf/users/search?q=  (admin only; full phone is shown on purpose, the audit row keeps only type + count)
async function adminUserSearch(req: Request, env: Env): Promise<Response> {
  const a = await adminCtx(req, env);
  if (a instanceof Response) return a;
  const q = classifyAdminQuery(new URL(req.url).searchParams.get("q"));
  if (!searchable(q)) return json({ items: [] }, 200, { "cache-control": "private, no-store" });
  const items = await searchHfUsers(env, q);
  await audit(env, a.uid, "user_search", "-", { type: q.type, results: items.length });
  void track(env, a.uid, "hf_admin_user_search", HF_CALL_APP, { area: "hf_call", type: q.type, results: items.length }).catch(() => undefined);
  return json({ items }, 200, { "cache-control": "private, no-store" });
}

async function adminCalls(req: Request, env: Env): Promise<Response> {
  const a = await adminCtx(req, env);
  if (a instanceof Response) return a;
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Math.floor(Number(url.searchParams.get("limit") || 50)) || 50));
  const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset") || 0)) || 0);
  const status = url.searchParams.get("status");
  const where = status && /^[a-z_]{3,20}$/.test(status) ? "WHERE c.status=?3" : "";
  const stmt = env.DB_META.prepare(
    `SELECT c.*, h.slug AS host_slug, h.display_name AS host_name, (SELECT display_name FROM users x WHERE x.uid=c.caller_uid) AS caller_name
       FROM hf_calls c LEFT JOIN hf_hosts h ON h.uid=c.host_uid ${where} ORDER BY c.created_at DESC LIMIT ?1 OFFSET ?2`,
  );
  const rows = (await (where ? stmt.bind(limit, offset, status) : stmt.bind(limit, offset)).all<HfCallRow & { host_slug: string | null; host_name: string | null; caller_name: string | null }>()).results ?? [];
  return json({
    ok: true,
    items: rows.map((c) => ({
      id: c.id, status: c.status, lane: c.lane, callerUid: c.caller_uid, callerName: c.caller_name, hostUid: c.host_uid, hostName: c.host_name, hostSlug: c.host_slug,
      rate: rupees(c.rate_paise), createdAt: c.created_at, connectedAt: c.connected_at, endedAt: c.ended_at, billedMinutes: c.billed_minutes,
      chargedRupees: rupees(c.charged_paise), hostEarningRupees: rupees(c.host_earning_paise), endReason: c.end_reason,
    })),
  }, 200, { "cache-control": "private, no-store" });
}

// ── Vobiz webhooks ───────────────────────────────────────────────────────────
const xml = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/xml" } });
async function parseForm(req: Request): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try { for (const [k, v] of new URLSearchParams(await req.text()).entries()) out[k] = v; } catch { /* empty fields */ }
  return out;
}

async function vobizWebhook(req: Request, env: Env, p: string): Promise<Response> {
  const parts = p.slice("/api/hf/vobiz/".length).split("/").filter(Boolean).map((x) => decodeURIComponent(x));
  const [secret, kind, a, b] = parts;
  const expected = env.VOBIZ_WEBHOOK_SECRET || "";
  if (!expected || secret !== expected) return xml(hangupXml(), 403);
  if (req.method !== "POST" && req.method !== "GET") return xml(hangupXml(), 405);
  const forward = async (op: string, id: string, role?: "host" | "caller"): Promise<Response> => {
    if (!ID_RE.test(id)) return xml(hangupXml());
    const fields = req.method === "POST" ? await parseForm(req) : Object.fromEntries(new URL(req.url).searchParams.entries());
    if ((op === "host-answer" || op === "caller-answer" || op === "hangup") && role && fields.CallUUID) {
      const column = role === "host" ? "host_leg_uuid" : "caller_leg_uuid";
      // Capture provider identity in D1 before the DO forward; only an existing linked call may claim it.
      const linked = await env.DB_META.prepare(`UPDATE hf_calls SET ${column}=COALESCE(${column},?1) WHERE id=?2 AND booking_id IS NOT NULL AND (${column} IS NULL OR ${column}=?1) AND EXISTS (SELECT 1 FROM hf_bookings b WHERE b.id=hf_calls.booking_id AND b.call_id=hf_calls.id AND b.status IN ('starting','active','settling'))`)
        .bind(fields.CallUUID, id).run().catch(() => null);
      if ((linked?.meta?.changes ?? 0) > 0 && op === "hangup") {
        await recordLegFromWebhook(env, { callId: id, role, legUuid: fields.CallUUID, fields }).catch(() => undefined);
      }
    }
    try {
      return await callStub(env, id).fetch(`https://hfcall/${op}`, { method: "POST", body: JSON.stringify({ role, fields }) });
    } catch (e) {
      await trackException(env, e, { route: `/api/hf/vobiz/${kind}`, handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "forward", op } });
      return xml(op.includes("answer") || op === "host-digits" ? hangupXml("Sorry, something went wrong. Goodbye.") : "<?xml version=\"1.0\"?><Response></Response>");
    }
  };
  const role = (x: string | undefined): "host" | "caller" | null => (x === "host" || x === "caller" ? x : null);
  if (kind === "answer" && role(a)) return forward(a === "host" ? "host-answer" : "caller-answer", b ?? "", role(a)!);
  if (kind === "digits" && a === "host") return forward("host-digits", b ?? "", "host");
  if (kind === "hangup" && role(a)) return forward("hangup", b ?? "", role(a)!);
  if (kind === "conf" && role(b)) return forward("conf", a ?? "", role(b)!);
  if (kind === "notice" && a === "host-nopickup") return xml(callerDidntPickUpXml());
  return xml(hangupXml(), 404);
}

// POST /api/admin/hf/calls/:id/correct {amountPaise?, note}   [HF-STD-PLAN-1 rule 6]
// Billing-error correction: money goes back to the caller's wallet (a new adjustment lot), traceable to the call, ONCE per call. The host's
// earning is reversed only while it is still inside the 7-day hold. Asking again returns the first correction and moves nothing.
async function adminCorrectCall(req: Request, env: Env, callId: string): Promise<Response> {
  const a = await adminCtx(req, env);
  if (a instanceof Response) return a;
  const b = await readJson(req);
  const note = String(b.note ?? "").trim().slice(0, 200);
  if (!note) return err(400, "invalid_field", "Add a note saying why.", { field: "note" });
  const raw = b.amountPaise;
  if (raw !== undefined && raw !== null && !(typeof raw === "number" && Number.isInteger(raw) && raw > 0)) return err(400, "invalid_field", "amountPaise must be a whole number of paise above zero.", { field: "amountPaise" });
  let r;
  try { r = await correctCallCharge(env, { callId, amountPaise: typeof raw === "number" ? raw : null, adminUid: a.uid, note }); }
  catch (e) {
    await trackException(env, e, { uid: a.uid, route: "/api/admin/hf/calls/:id/correct", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "correct" } });
    return err(502, "wallet_error", "The correction didn't go through.");
  }
  if (!r.ok) return err(r.error === "not_found" ? 404 : r.error === "wallet_error" ? 502 : 400, r.error, r.message, r.maxPaise != null ? { maxPaise: r.maxPaise } : {});
  await audit(env, a.uid, "call_charge_corrected", callId, { amountPaise: r.correctedPaise, chargedPaise: r.chargedPaise, hostReversal: r.hostReversal, hostReversedPaise: r.hostReversedPaise, again: r.again, note });
  return json({ ok: true, again: r.again, callId, correctedPaise: r.correctedPaise, corrected: formatRupees(r.correctedPaise), hostReversedPaise: r.hostReversedPaise, hostReversal: r.hostReversal });
}

// ── router ───────────────────────────────────────────────────────────────────
/** Returns null when the path is not ours so index.ts can fall through. */
export async function hfCallsRoute(req: Request, env: Env, p: string, ctx?: ExecutionContext): Promise<Response | null> {
  const m = req.method;
  try {
    if (p.startsWith("/api/hf/vobiz/")) return await vobizWebhook(req, env, p);
    if (p === "/api/hf/calls" && m === "POST") return await startCall(req, env);
    if (p === "/api/hf/calls" && m === "GET") return await listCalls(req, env); // [HF-DASH-CALLS-1]
    const one = p.match(/^\/api\/hf\/calls\/([A-Za-z0-9_-]{8,64})$/);
    if (one && m === "GET") return await getCall(req, env, one[1]);
    const cancel = p.match(/^\/api\/hf\/calls\/([A-Za-z0-9_-]{8,64})\/cancel$/);
    if (cancel && m === "POST") return await cancelCall(req, env, cancel[1]);
    const end = p.match(/^\/api\/hf\/calls\/([A-Za-z0-9_-]{8,64})\/end$/);
    if (end && m === "POST") return await endCall(req, env, end[1]);
    if (p === "/api/hf/wallet" && m === "GET") return await walletGet(req, env);
    if (p === "/api/hf/wallet/estimate" && m === "GET") return await walletEstimate(req, env);
    if (p === "/api/hosts/me/presence" && (m === "PUT" || m === "GET")) return await presenceRoute(req, env, p, ctx);
    if (p === "/api/hosts/me/presence/beat" && m === "POST") return await presenceRoute(req, env, p, ctx);
    if (p === "/api/hosts/me/presence/nudges" && m === "PUT") return await presenceRoute(req, env, p, ctx); // [HF-PRESENCE-NUDGE-1]
    if (p === "/api/hosts/me/calls" && m === "GET") return await hostCalls(req, env);
    if (p === "/api/admin/hf/wallet/credit" && m === "POST") return await adminCredit(req, env);
    if (p === "/api/admin/hf/wallet/migrate-test-credits" && m === "POST") return await adminMigrateTestCredits(req, env);
    if (p === "/api/admin/hf/tokens/migrate-test-credits" && m === "POST") return await adminMigrateTestToLots(req, env);
    if (p === "/api/admin/hf/users/search" && m === "GET") return await adminUserSearch(req, env);
    if (p === "/api/admin/hf/calls" && m === "GET") return await adminCalls(req, env);
    const corr = p.match(/^\/api\/admin\/hf\/calls\/([A-Za-z0-9_-]{8,64})\/correct$/);
    if (corr && m === "POST") return await adminCorrectCall(req, env, corr[1]);
    return null;
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls" } });
    if (p.startsWith("/api/hf/vobiz/")) return xml(hangupXml("Sorry, something went wrong. Goodbye."));
    return err(500, "internal_error", "Something went wrong.");
  }
}

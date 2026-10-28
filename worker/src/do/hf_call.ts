// [HF-CALLS-1] HfCallDO: one per HF masked call (idFromName(callId)). Contract: Specs/HF-CALLS-CONTRACT.md.
//
// The DO is the single serialised owner of a call's state machine. The Vobiz webhooks (routes/hf_calls.ts) only forward their
// fields here; this class answers with XML, places the legs, runs the alarms (ring watchdog, 60 s warning, time limit),
// bills through WalletDO and writes the final hf_calls row. Nothing here ever returns or stores a phone number beyond the
// dial itself: numbers are read from the verified-WhatsApp store at dial time and never persisted or logged.
//
// Flow: host leg first -> announcement + GetDigits -> 1 -> caller leg -> safety notice + Conference on both legs.
// All Vobiz dialect assumptions are marked "VERIFY ON FIRST LIVE CALL" (here and in lib/hf_call_math.ts).
import type { Env } from "../types";
import { getTelephonyProvider } from "../lib/telephony_provider";
import { verifiedWhatsAppNumber } from "../lib/whatsapp_notify";
import { track, trackException } from "../hooks";
import { onCallCompleted } from "../lib/hf_reviews";
import { pauseForSharedAnnouncement, resumeAfterSharedAnnouncement, speakIntoCall } from "../lib/hf_vobiz";
import { recordLegFromWebhook } from "../lib/hf_vobiz_ledger"; // [HF-VOBIZ-SPEND-1]
import {
  HF_CALL_APP, webhookBase, releaseHost, markOnCall, hfReserve, hfRelease, hfConsume, hfEarn, type HfCallRow,
} from "../lib/hf_calls_store";
import { settleTestCredits } from "../lib/hf_credits";
import { settleTokenCall, priceOf, type StdSnapshot } from "../lib/hf_token_calls"; // [HF-TOK-CALLS-1]
import { validTariff } from "../lib/hf_token_math"; // [HF-STD-PLAN-1]
import { getCdr, parseTimeMs } from "../lib/hf_vobiz_api";
import { relOpId, reserveChunk, getReservation, releaseOrphanChunks } from "../lib/hf_token_ledger";
import { speakToCaller } from "../lib/hf_vobiz"; // [HF-CALL-MODES-C]
import { notifyLineFree, dropBlockedEntries } from "../lib/hf_queue_store"; // [HF-CALL-MODES-C] never throws
import {
  settleCall, billedMinutes, hostTokensToCredit, splitCharge, splitHostShare, paidStillNeeded, callerHandle, hostAnnounceXml, noticeAndConferenceXml, hangupXml, emptyXml,
  LIMIT_WARNING_TEXT, WARN_BEFORE_LIMIT_SEC,
  lowFundsWhisperText, TOPPED_UP_WHISPER_TEXT, NEUTRAL_ONE_MINUTE_TEXT, whisperMinutes, chunkCapEffSec, nextChunkDueSec, nextChunkRange,
} from "../lib/hf_call_math";

import { validCreatorSnapshot, type CreatorSnapshot } from "../lib/hf_creator_pricing";
import { readMoneyRules, firstMinuteDrop } from "../lib/hf_money_rules"; // [HF-WIRE-13] HF-REEL-35 rule 3

type Role = "host" | "caller";
const HOST_RING_SEC = 30, CALLER_RING_SEC = 35;
const HOST_PHASE_MS = 90_000;      // ring + announcement + digit wait
const CALLER_PHASE_MS = 70_000;    // caller ring + safety notice
const CONNECT_GUESS_MS = 25_000;   // only used when Vobiz sends no conference "enter" events at all
const MAX_RETRY_DELAY_MS = 5 * 60_000;
const FUNDS_RETRY_MS = 30_000;     // [HF-CALL-MODES-C] while the next chunk cannot be funded, look again this often (a top-up poke is the fast path)

// [HF-WALLET-1] testUsed/paidUsed split the caller's charge; hostPaid/hostTest split the host's share the same way (test part is never withdrawable).
interface Plan {
  billedMinutes: number; chargeRupees: number; hostEarningPaise: number; hostTokens: number; capped: boolean;
  testUsed?: number; paidUsed?: number; hostPaid?: number; hostTest?: number;
}
// [HF-TOK-CALLS-1] Token-mode call: the snapshot taken at start (never live config) + the call's own time limit in seconds.
interface TokenSnap {
  ratePaise: number; callCostPaisePerMin: number; hostShareBps: number; maxSeconds: number; booked?: boolean; std?: StdSnapshot | null; creator?: CreatorSnapshot;
  // [HF-CALL-MODES-C] chunk billing (hfCallChunkBillingEnabled when the call started). Absent on every other call: the old 60-minute behaviour is untouched.
  // maxSeconds is then the hard CAP; fundedSec = connected seconds the ledger has reserved money for (the call ends there unless a chunk or top-up extends it).
  chunk?: true; chunkSec?: number; capSec?: number; fundedSec?: number; chunkN?: number; short?: boolean; shortWhispered?: boolean;
}
interface Bill {
  tokSettled?: boolean;
  funds?: number; plan?: Plan; consumed?: number; released?: boolean; earned?: boolean; saved?: boolean; post?: boolean; attempts: number;
  testSettled?: boolean; testEarned?: boolean;
  hostReleased?: boolean;
}
interface FinishRequest {
  status: string;
  endReason: string | null;
  hashBy: Role | null;
  skipHostLeg: boolean;
  skipCallerLeg: boolean;
  tellHost: boolean;
  attempts: number;
  hostDone: boolean;
  callerDone: boolean;
}
interface S {
  callId: string; callerUid: string; hostUid: string; bookingId?: string; bookedEndsAt?: number; hardEndsAt?: number;
  // reservedRupees = PAID rupees reserved in the wallet at start; testReservedRupees = test credits held for this call; fundsRupees = test + paid available at start.
  rateRupees: number; reservedRupees: number; testReservedRupees?: number; fundsRupees: number; maxMinutes: number; limitReason: "time_limit" | "balance";
  status: string; createdAt: number;
  hostLeg: string | null; callerLeg: string | null;
  hostPicked: boolean; hostAccepted: boolean; callerPicked: boolean; callerPickedAt: number | null;
  inRoom: Record<Role, boolean>; member: Partial<Record<Role, string>>; anyEnter: boolean;
  connectedAt: number | null; endedAt: number | null; endReason: string | null; finalStatus: string | null; hashBy: Role | null;
  finalized: boolean; finishing?: FinishRequest; tasks: Partial<Record<"ring" | "warn" | "limit" | "retry" | "guess" | "disconnect" | "chunk" | "fundsRetry" | "whisper" | "announcement", number>>; bill: Bill;
  source?: string; // [HF-CALL-MODES-C] instant | queue | booking
  tok?: TokenSnap; // present only for calls started with hfTokensEnabled on
}

const xmlRes = (x: string) => new Response(x, { headers: { "content-type": "application/xml" } });
const jsonRes = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

export class HfCallDO {
  constructor(private state: DurableObjectState, private env: Env) {}

  private async load(): Promise<S | null> { return (await this.state.storage.get<S>("s")) ?? null; }
  private async save(s: S): Promise<void> { await this.state.storage.put("s", s); await this.reschedule(s); }
  private async reschedule(s: S): Promise<void> {
    const times = Object.values(s.tasks).filter((t): t is number => typeof t === "number");
    if (times.length) await this.state.storage.setAlarm(Math.max(Date.now() + 200, Math.min(...times)));
    else await this.state.storage.deleteAlarm();
  }
  private db() { return this.env.DB_META; }
  private emit(uid: string, event: string, props: Record<string, unknown>): void {
    void track(this.env, uid, event, HF_CALL_APP, { area: "hf_call", ...props }).catch(() => undefined);
  }
  private urls(s: S) {
    const b = webhookBase(this.env);
    return {
      answer: (r: Role) => `${b}/answer/${r}/${s.callId}`,
      hangup: (r: Role) => `${b}/hangup/${r}/${s.callId}`,
      digits: `${b}/digits/host/${s.callId}`,
      conf: (r: Role) => `${b}/conf/${s.callId}/${r}`,
      hostNoPickup: `${b}/notice/host-nopickup/${s.callId}`,
    };
  }
  private room(s: S) { return `hf_${s.callId.replace(/-/g, "")}`; }
  /** The call's time limit in seconds: exact for token calls, whole minutes for the old path. */
  private maxSec(s: S) { return s.tok ? s.tok.maxSeconds : s.maxMinutes * 60; }
  // [HF-STD-PLAN-1] provider backstop never above 24 h (Standard calls are sized up to STD_TECH_MAX_SECONDS); the DO alarm is the real limit.
  private backstopSec(s: S) {
    const scheduledRemaining = s.hardEndsAt == null ? Infinity : Math.max(1, Math.ceil((s.hardEndsAt - Date.now()) / 1000));
    return Math.min(this.maxSec(s) + 90, scheduledRemaining, 86_400);
  }
  private ringTimeoutSec(s: S, normal: number) {
    return Math.min(normal, s.hardEndsAt == null ? normal : Math.max(1, Math.ceil((s.hardEndsAt - Date.now()) / 1000)));
  }

  // ── HTTP entry (internal: only routes/hf_calls.ts and the cron call this) ───────────────────────────────────────
  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname.replace(/^\/+/, "");
    let body: Record<string, any> = {};
    try { body = (await req.json()) as Record<string, any>; } catch { body = {}; }
    try {
      if (path === "init") return await this.init(body);
      if (path === "recover") {
        const recovered = await this.load();
        if (!recovered) return await this.recoverMissingState(body);
        if (recovered.finalized && recovered.bill.post) return jsonRes({ ok: true, status: recovered.status, finalized: true });
        if (recovered.finalized) {
          recovered.tasks.retry = Date.now() + 200;
          await this.save(recovered);
          await this.settleAndPost(recovered);
          return jsonRes({ ok: true, status: recovered.status, retryScheduled: !recovered.bill.post });
        }
        const taskTimes = Object.values(recovered.tasks).filter((t): t is number => typeof t === "number");
        if (!taskTimes.length) return jsonRes({ ok: false, error: "do_state_has_no_recovery_task", manualRecoveryRequired: true }, 409);
        await this.reschedule(recovered);
        return jsonRes({ ok: true, status: recovered.status, retryScheduled: true });
      }
      const s = await this.load();
      if (!s) return path === "host-answer" || path === "host-digits" || path === "caller-answer" ? xmlRes(hangupXml()) : jsonRes({ ok: false, error: "unknown_call" }, 404);
      switch (path) {
        case "host-answer": return await this.hostAnswer(s, body.fields ?? {});
        case "host-digits": return await this.hostDigits(s, body.fields ?? {});
        case "caller-answer": return await this.callerAnswer(s, body.fields ?? {});
        case "conf": return await this.conf(s, body.role as Role, body.fields ?? {});
        case "hangup": return await this.hangup(s, body.role as Role, body.fields ?? {});
        case "cancel": return await this.cancel(s);
        case "end":
          if (!s.finalized) {
            const disconnected = await this.finish(s, s.connectedAt != null ? "completed" : "failed", "caller_hangup");
            if (!disconnected) return jsonRes({ ok: false, error: "disconnect_pending", status: s.status }, 503);
          }
          return jsonRes({ ok: true, status: s.status });
        case "watchdog": return await this.watchdog(s);
        // [HF-WIRE-7] read-only: how long this call may run and (old rupee path only) the funds it was sized to. Numbers only.
        case "info": return jsonRes({ ok: true, maxSeconds: this.maxSec(s), hardEndsAt: s.hardEndsAt ?? null, fundsPaise: s.tok ? null : Math.max(0, Math.trunc(s.fundsRupees)) * 100,
          ...(s.tok?.chunk ? { fundedSec: s.tok.fundedSec ?? 0, short: s.tok.short === true } : {}) }); // [HF-CALL-MODES-C]
        // [HF-CALL-MODES-C] a wallet top-up landed (lib/hf_call_funds.pokeLiveCall): reserve the chunks the call now can pay for. Idempotent.
        case "funds": {
          if (!s.tok?.chunk || (typeof body.uid === "string" && body.uid !== s.callerUid)) return jsonRes({ ok: false, fundedSec: s.tok?.fundedSec ?? 0, short: s.tok?.short === true, addedSec: 0 });
          const r = await this.fund(body.reason === "retry" ? "retry" : "topup");
          return jsonRes({ ok: r.ran, fundedSec: r.fundedSec, short: r.short, addedSec: r.addedSec });
        }
        default: return jsonRes({ ok: false, error: "not_found" }, 404);
      }
    } catch (e) {
      await trackException(this.env, e, { route: `hf_call.${path}`, handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls" } });
      return path === "host-answer" || path === "host-digits" || path === "caller-answer" ? xmlRes(hangupXml("Sorry, something went wrong. Goodbye.")) : jsonRes({ ok: false, error: "internal" }, 500);
    }
  }

  /** Rebuild a booked call only from linked D1 rows and provider terminal evidence. */
  private async recoverMissingState(body: Record<string, any>): Promise<Response> {
    const callId = typeof body.callId === "string" ? body.callId : "";
    if (!/^[a-f0-9-]{36}$/i.test(callId)) return jsonRes({ ok: false, error: "do_state_missing", manualRecoveryRequired: true }, 410);
    const rows = await this.db().prepare(
      "SELECT c.id,c.booking_id,c.caller_uid,c.host_uid,c.status AS call_status,c.connected_at,c.host_leg_uuid,c.caller_leg_uuid," +
      "b.status AS booking_status,b.settlement_status,b.updated_at AS booking_updated_at,b.ends_at,b.duration_min,b.price_snapshot_json,b.call_id AS booking_call_id " +
      "FROM hf_calls c JOIN hf_bookings b ON b.id=c.booking_id WHERE c.id=?1 AND b.call_id=c.id AND c.caller_uid=b.customer_uid AND c.host_uid=b.host_uid")
      .bind(callId).first<any>();
    if (!rows || !["starting", "active", "settling"].includes(rows.booking_status) || rows.settlement_status !== "held" ||
      !["starting", "ringing_host", "ringing_caller", "connected", "ending", "finalizing", "settling", "recovering"].includes(rows.call_status)) {
      return jsonRes({ ok: false, error: "booking_link_or_state_invalid", manualRecoveryRequired: true }, 409);
    }
    if (!rows.host_leg_uuid || !rows.caller_leg_uuid) return jsonRes({ ok: false, error: "provider_leg_identity_missing", retryScheduled: true }, 503);
    // D1 lease prevents concurrent recovery; the five-minute expiry permits retry after a DO eviction.
    const now = Date.now();
    const claim = await this.db().batch([
      this.db().prepare("UPDATE hf_bookings SET updated_at=?1 WHERE id=?2 AND call_id=?3 AND status IN ('starting','active','settling') AND settlement_status='held' AND ((?4<>'recovering' AND updated_at=?5) OR (?4='recovering' AND updated_at<?6))")
        .bind(now, rows.booking_id, callId, rows.call_status, Number(rows.booking_updated_at), now - 5 * 60_000),
      this.db().prepare("UPDATE hf_calls SET status='recovering' WHERE id=?1 AND status=?2 AND EXISTS (SELECT 1 FROM hf_bookings WHERE id=?3 AND call_id=?1 AND updated_at=?4 AND settlement_status='held')")
        .bind(callId, rows.call_status, rows.booking_id, now),
    ]);
    if ((claim[0]?.meta?.changes ?? 0) === 0 || (claim[1]?.meta?.changes ?? 0) === 0)
      return jsonRes({ ok: false, error: "recovery_in_progress", retryScheduled: true }, 503);
    const provider = getTelephonyProvider(this.env);
    let [hostState, callerState] = await Promise.all([provider.getCallState(rows.host_leg_uuid), provider.getCallState(rows.caller_leg_uuid)]);
    if (hostState.callUuid !== rows.host_leg_uuid || callerState.callUuid !== rows.caller_leg_uuid) throw new Error("provider_call_identity_mismatch");
    const terminal = (x: typeof hostState) => ["completed", "ended", "failed", "cancelled", "canceled", "busy", "no-answer", "no_answer"].includes(x.status.trim().toLowerCase());
    if (!terminal(hostState)) await provider.hangupCall(rows.host_leg_uuid).catch(() => undefined);
    if (!terminal(callerState)) await provider.hangupCall(rows.caller_leg_uuid).catch(() => undefined);
    [hostState, callerState] = await Promise.all([provider.getCallState(rows.host_leg_uuid), provider.getCallState(rows.caller_leg_uuid)]);
    if (hostState.callUuid !== rows.host_leg_uuid || callerState.callUuid !== rows.caller_leg_uuid) throw new Error("provider_call_identity_mismatch");
    const hostEnd = parseTimeMs(hostState.endedAt);
    const callerEnd = parseTimeMs(callerState.endedAt);
    if (!terminal(hostState) || !terminal(callerState) || hostEnd == null || callerEnd == null) {
      return jsonRes({ ok: false, error: "provider_state_unresolved", retryScheduled: true }, 503);
    }
    const released = await this.db().prepare("SELECT 1 AS x FROM hf_token_ledger WHERE op_id=?1").bind(relOpId(callId)).first();
    if (released) return jsonRes({ ok: false, error: "booking_reservation_already_released", manualRecoveryRequired: true }, 409);
    const connectedAt = Number(rows.connected_at) > 0 ? Number(rows.connected_at) : null;
    const noAnswerEvidence = connectedAt == null ? await Promise.all([getCdr(this.env, rows.host_leg_uuid), getCdr(this.env, rows.caller_leg_uuid)]) : [null, null];
    const provesNoAnswer = (cdr: Awaited<ReturnType<typeof getCdr>>, uuid: string) => !!cdr && cdr.uuid === uuid && cdr.answerAt == null && cdr.billsec === 0 &&
      /no[ _-]?answer/i.test(String(cdr.hangupCause ?? ""));
    const neverAnswered = connectedAt == null && (provesNoAnswer(noAnswerEvidence[0], rows.host_leg_uuid) || provesNoAnswer(noAnswerEvidence[1], rows.caller_leg_uuid));
    const callCreated = await this.db().prepare("SELECT created_at FROM hf_calls WHERE id=?1").bind(callId).first<{ created_at: number }>();
    if (connectedAt != null && (connectedAt < Number(callCreated?.created_at ?? 0) || connectedAt > Math.min(hostEnd, callerEnd, Number(rows.ends_at)))) {
      return jsonRes({ ok: false, error: "connected_at_outside_provider_window", retryScheduled: true }, 503);
    }
    const price = JSON.parse(String(rows.price_snapshot_json)) as Record<string, any>;
    const ratePaise = Number(price.ratePaise);
    const callCostPaisePerMin = Number(price.callCostPaisePerMin);
    const hostShareBps = Number(price.hostShareBps);
    const std = price.std ?? null;
    const creator = price.creator ?? null;
    if (!Number.isSafeInteger(ratePaise) || ratePaise <= 0 || !Number.isSafeInteger(callCostPaisePerMin) || callCostPaisePerMin < 0 ||
      !Number.isSafeInteger(hostShareBps) || hostShareBps < 0 || hostShareBps > 10_000 ||
      (std !== null && (std.plan !== "std" || !validTariff(std.tariff) || !Number.isFinite(Number(std.hostPaisePerMin)) || Number(std.hostPaisePerMin) < 0 || !Number.isFinite(Number(std.phoneCostPaisePerMin)) || Number(std.phoneCostPaisePerMin) < 0)) ||
      (creator !== null && !validCreatorSnapshot(creator))) {
      return jsonRes({ ok: false, error: "booking_price_snapshot_invalid", manualRecoveryRequired: true }, 409);
    }
    const seconds = connectedAt ? Math.max(0, Math.floor((Math.min(hostEnd, callerEnd, Number(rows.ends_at)) - connectedAt) / 1000)) : 0;
    if (connectedAt && seconds <= 0) return jsonRes({ ok: false, error: "connected_duration_unverified", retryScheduled: true }, 503);
    if (!connectedAt && !neverAnswered) {
      return jsonRes({ ok: false, error: "answer_evidence_ambiguous", retryScheduled: true }, 503);
    }
    const maxSeconds = Math.max(0, Math.floor(Number(rows.duration_min) * 60));
    const s: S = {
      callId, callerUid: rows.caller_uid, hostUid: rows.host_uid, bookingId: rows.booking_id,
      bookedEndsAt: Number(rows.ends_at), hardEndsAt: Number(rows.ends_at), rateRupees: ratePaise / 100,
      reservedRupees: 0, testReservedRupees: 0, fundsRupees: 0, maxMinutes: Number(rows.duration_min), limitReason: "time_limit",
      status: "finalizing", createdAt: Date.now(), hostLeg: rows.host_leg_uuid, callerLeg: rows.caller_leg_uuid,
      hostPicked: !!hostState.answeredAt, hostAccepted: false, callerPicked: !!callerState.answeredAt, callerPickedAt: null,
      inRoom: { host: false, caller: false }, member: {}, anyEnter: false, connectedAt, endedAt: Math.min(hostEnd, callerEnd),
      endReason: neverAnswered ? "no_answer" : "recovered_provider_end", finalStatus: neverAnswered ? "failed" : "completed", hashBy: null,
      finalized: true, finishing: { status: neverAnswered ? "failed" : "completed", endReason: neverAnswered ? "no_answer" : "recovered_provider_end", hashBy: null,
        skipHostLeg: true, skipCallerLeg: true, tellHost: false, attempts: 0, hostDone: true, callerDone: true },
      tasks: { retry: Date.now() + 20_000 }, bill: { attempts: 0 },
      tok: { ratePaise, callCostPaisePerMin, hostShareBps, maxSeconds,
        booked: true, std, creator },
    };
    await this.save(s);
    await this.db().prepare("UPDATE hf_calls SET connected_at=COALESCE(connected_at,?1),status='finalizing',ended_at=?2,end_reason=?3 WHERE id=?4 AND status='recovering'")
      .bind(connectedAt, s.endedAt, s.endReason, callId).run();
    await this.settleAndPost(s);
    return jsonRes({ ok: true, status: s.status, finalized: s.bill.post === true });
  }

  // ── start: the host rings first ───────────────────────────────────────────────────────────────────────────────
  private async init(b: Record<string, any>): Promise<Response> {
    if (await this.load()) return jsonRes({ ok: true, again: true });
    const now = Date.now();
    const s: S = {
      callId: String(b.callId), callerUid: String(b.callerUid), hostUid: String(b.hostUid),
      ...(typeof b.bookingId === "string" ? { bookingId: b.bookingId } : {}),
      ...(Number.isSafeInteger(b.bookedEndsAt) ? { bookedEndsAt: Number(b.bookedEndsAt) } : {}),
      ...(Number.isSafeInteger(b.hardEndsAt) ? { hardEndsAt: Number(b.hardEndsAt) } : {}),
      rateRupees: Math.trunc(Number(b.rateRupees)), reservedRupees: Math.trunc(Number(b.reservedRupees)), testReservedRupees: Math.max(0, Math.trunc(Number(b.testReservedRupees ?? 0))), fundsRupees: Math.trunc(Number(b.fundsRupees)),
      maxMinutes: Math.trunc(Number(b.maxMinutes)), limitReason: b.limitReason === "balance" ? "balance" : "time_limit",
      status: "ringing_host", createdAt: now, hostLeg: null, callerLeg: null,
      hostPicked: false, hostAccepted: false, callerPicked: false, callerPickedAt: null,
      inRoom: { host: false, caller: false }, member: {}, anyEnter: false,
      connectedAt: null, endedAt: null, endReason: null, finalStatus: null, hashBy: null,
      finalized: false, tasks: { ring: Math.min(now + HOST_PHASE_MS, Number(b.hardEndsAt ?? Infinity)) }, bill: { attempts: 0 },
    };
    if (b.tokens && typeof b.tokens === "object") {
      const t = b.tokens as Record<string, unknown>;
      s.tok = {
        ratePaise: Math.trunc(Number(t.ratePaise)), callCostPaisePerMin: Math.trunc(Number(t.callCostPaisePerMin)),
        hostShareBps: Math.trunc(Number(t.hostShareBps)), maxSeconds: Math.max(0, Math.trunc(Number(t.maxSeconds))),
        booked: t.booked === true,
      };
      if (t.creator != null) {
        if (!validCreatorSnapshot(t.creator)) throw new Error("Invalid creator pricing snapshot");
        s.tok.creator = { ...t.creator };
      }
      // [HF-STD-PLAN-1] Standard plan snapshot (tiers + host pay + phone estimate), frozen for the life of this call.
      const sd = t.std as StdSnapshot | null | undefined;
      if (sd && sd.plan === "std" && validTariff(sd.tariff)) {
        s.tok.std = { plan: "std", tariff: { tiers: sd.tariff.tiers.map((x) => ({ fromSec: Math.trunc(x.fromSec), paisePerMin: Math.trunc(x.paisePerMin) })) },
          hostPaisePerMin: Math.max(0, Math.trunc(Number(sd.hostPaisePerMin))), phoneCostPaisePerMin: Math.max(0, Math.trunc(Number(sd.phoneCostPaisePerMin))) };
      }
      s.maxMinutes = Math.floor(s.tok.maxSeconds / 60);
      // [HF-CALL-MODES-C] chunk billing: the starter reserved chunk 0 (or, for a booking, the hold). The ledger is the truth for fundedSec.
      if (t.chunk === true && Number(t.chunkSec) > 0 && Number(t.capSec) > 0) {
        const held = Math.trunc(Number(t.fundedSec)) > 0 ? Math.trunc(Number(t.fundedSec)) : (await getReservation(this.env, s.callId).catch(() => null))?.secondsCovered ?? 0;
        s.tok.chunk = true; s.tok.chunkSec = Math.trunc(Number(t.chunkSec));
        s.tok.capSec = Math.min(Math.trunc(Number(t.capSec)), s.tok.maxSeconds > 0 ? s.tok.maxSeconds : Math.trunc(Number(t.capSec)));
        s.tok.maxSeconds = s.tok.capSec; s.tok.fundedSec = Math.max(0, held); s.tok.chunkN = 1; s.tok.short = false; // chunk 0 (or the booked hold) already came with the start
        s.maxMinutes = Math.floor(s.tok.maxSeconds / 60);
      }
    }
    if (typeof b.source === "string" && ["instant", "queue", "booking"].includes(b.source)) s.source = b.source;
    else if (s.bookingId) s.source = "booking";
    await this.save(s);
    try {
      const to = await verifiedWhatsAppNumber(this.env, s.hostUid);
      if (!to) throw new Error("host has no verified number");
      const u = this.urls(s);
      const r = await getTelephonyProvider(this.env).makeCall({
        from: this.env.HF_CALL_DID || "", to, answerUrl: u.answer("host"), hangupUrl: u.hangup("host"), ringTimeoutSec: this.ringTimeoutSec(s, HOST_RING_SEC),
      });
      s.hostLeg = r.callUuid; // provisional; the answer webhook's CallUUID replaces it
      await this.save(s);
      await this.db().prepare("UPDATE hf_calls SET host_leg_uuid=?1, conference_name=?2 WHERE id=?3").bind(s.hostLeg, this.room(s), s.callId).run().catch(() => undefined);
      return jsonRes({ ok: true });
    } catch (e) {
      await trackException(this.env, e, { route: "hf_call.init", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "dial_host" } });
      await this.finish(s, "failed", "error");
      return jsonRes({ ok: false, error: "provider_error" }, 502);
    }
  }

  // ── host leg ──────────────────────────────────────────────────────────────────────────────────────────────────
  private async hostAnswer(s: S, f: Record<string, string>): Promise<Response> {
    if (s.finalized || s.status !== "ringing_host") return xmlRes(hangupXml());
    if (s.hardEndsAt != null && Date.now() >= s.hardEndsAt) { await this.finish(s, "failed", "booking_window_ended"); return xmlRes(hangupXml()); }
    s.hostPicked = true;
    if (f.CallUUID) s.hostLeg = f.CallUUID;
    await this.save(s);
    await this.db().prepare("UPDATE hf_calls SET host_answered_at=?1, host_leg_uuid=?2 WHERE id=?3").bind(Date.now(), s.hostLeg, s.callId).run().catch(() => undefined);
    this.emit(s.hostUid, "hf_call_host_answered", { call_id: s.callId });
    const [u, prev] = await Promise.all([
      this.db().prepare("SELECT display_name FROM users WHERE uid=?1").bind(s.callerUid).first<{ display_name: string | null }>().catch(() => null),
      this.db().prepare("SELECT COUNT(*) AS n FROM hf_calls WHERE caller_uid=?1 AND host_uid=?2 AND status='completed' AND billed_minutes>=1 AND id<>?3")
        .bind(s.callerUid, s.hostUid, s.callId).first<{ n: number }>().catch(() => null),
    ]);
    return xmlRes(hostAnnounceXml({ handle: callerHandle(u?.display_name), previousCalls: Number(prev?.n ?? 0), digitsUrl: this.urls(s).digits }));
  }

  private async hostDigits(s: S, f: Record<string, string>): Promise<Response> {
    if (s.finalized || s.status !== "ringing_host") return xmlRes(hangupXml());
    const digit = String(f.Digits ?? "").trim();
    if (s.hardEndsAt != null && Date.now() >= s.hardEndsAt) { await this.finish(s, "failed", "booking_window_ended"); return xmlRes(hangupXml()); }
    if (digit !== "1") {
      await this.finish(s, "host_declined", null, { skipHostLeg: true });
      return xmlRes(hangupXml("Okay. Goodbye."));
    }
    s.hostAccepted = true; s.status = "ringing_caller"; s.tasks.ring = Math.min(Date.now() + CALLER_PHASE_MS, Number(s.hardEndsAt ?? Infinity));
    await this.save(s);
    await this.db().prepare("UPDATE hf_calls SET status='ringing_caller' WHERE id=?1").bind(s.callId).run().catch(() => undefined);
    try {
      const to = await verifiedWhatsAppNumber(this.env, s.callerUid);
      if (!to) throw new Error("caller has no verified number");
      const u = this.urls(s);
      const r = await getTelephonyProvider(this.env).makeCall({
        from: this.env.HF_CALL_DID || "", to, answerUrl: u.answer("caller"), hangupUrl: u.hangup("caller"), ringTimeoutSec: this.ringTimeoutSec(s, CALLER_RING_SEC),
      });
      s.callerLeg = r.callUuid;
      await this.save(s);
      await this.db().prepare("UPDATE hf_calls SET caller_leg_uuid=?1 WHERE id=?2").bind(s.callerLeg, s.callId).run().catch(() => undefined);
    } catch (e) {
      await trackException(this.env, e, { route: "hf_call.dial_caller", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "dial_caller" } });
      await this.finish(s, "failed", "error", { skipHostLeg: true });
      return xmlRes(hangupXml("Sorry, we couldn't reach the caller. Goodbye."));
    }
    return xmlRes(this.roomXml(s, "host"));
  }

  private roomXml(s: S, r: Role): string {
    return noticeAndConferenceXml({ room: this.room(s), callbackUrl: this.urls(s).conf(r), timeLimitSec: this.backstopSec(s) });
  }

  // ── caller leg ────────────────────────────────────────────────────────────────────────────────────────────────
  private async callerAnswer(s: S, f: Record<string, string>): Promise<Response> {
    if (s.finalized || s.status !== "ringing_caller") return xmlRes(hangupXml());
    if (s.hardEndsAt != null && Date.now() >= s.hardEndsAt) { await this.finish(s, "failed", "booking_window_ended"); return xmlRes(hangupXml()); }
    s.callerPicked = true; s.callerPickedAt = Date.now();
    if (f.CallUUID) s.callerLeg = f.CallUUID;
    s.tasks.guess = Date.now() + CONNECT_GUESS_MS;
    await this.save(s);
    await this.db().prepare("UPDATE hf_calls SET caller_leg_uuid=?1 WHERE id=?2").bind(s.callerLeg, s.callId).run().catch(() => undefined);
    return xmlRes(this.roomXml(s, "caller"));
  }

  // ── conference events (enter / exit / digits) ─────────────────────────────────────────────────────────────────
  private async conf(s: S, role: Role, f: Record<string, string>): Promise<Response> {
    if (s.finalized || (role !== "host" && role !== "caller")) return xmlRes(emptyXml());
    const action = String(f.ConferenceAction ?? f.Event ?? "").toLowerCase();
    const digitsHit = String(f.ConferenceDigitsMatch ?? f.DigitsMatch ?? "").includes("#") || (action.includes("digit") && String(f.Digits ?? "").includes("#"));
    if (digitsHit) {
      // '#' from either side: end the call, block the other person, log an incident (connected minutes are still billed).
      if (s.connectedAt) await this.finish(s, "completed", "hash_block", { hashBy: role });
      return xmlRes(emptyXml());
    }
    if (action === "enter" || action.includes("enter")) {
      s.anyEnter = true; s.inRoom[role] = true;
      if (f.ConferenceMemberID) s.member[role] = String(f.ConferenceMemberID);
      if (s.inRoom.host && s.inRoom.caller && !s.connectedAt) await this.connect(s, false);
      else await this.save(s);
    } else if (action === "exit" || action.includes("exit")) {
      s.inRoom[role] = false;
      if (s.connectedAt) await this.finish(s, "completed", role === "host" ? "host_hangup" : "caller_hangup",
        role === "host" ? { skipHostLeg: true } : { skipCallerLeg: true });
      else await this.save(s);
    }
    return xmlRes(emptyXml());
  }

  private async connect(s: S, guessed: boolean): Promise<void> {
    const now = Date.now();
    if (s.hardEndsAt != null && now >= s.hardEndsAt) {
      await this.finish(s, "failed", "booking_window_ended");
      return;
    }
    s.connectedAt = now; s.status = "connected"; delete s.tasks.ring; delete s.tasks.guess;
    if (s.tok?.chunk) {
      this.plan(s); // [HF-CALL-MODES-C] limit = what is funded (cut by the cap / a booking end), next chunk due 5 s after connect, warn / whisper 60 s before the limit
    } else {
      const scheduledRemainingMs = s.hardEndsAt != null ? Math.max(0, s.hardEndsAt - now) : Infinity;
      const limitMs = Math.min(this.maxSec(s) * 1000, scheduledRemainingMs);
      s.tasks.limit = now + limitMs;
      if (limitMs > (WARN_BEFORE_LIMIT_SEC + 5) * 1000) s.tasks.warn = now + limitMs - WARN_BEFORE_LIMIT_SEC * 1000;
    }
    await this.save(s);
    await this.db().prepare("UPDATE hf_calls SET status='connected', connected_at=?1 WHERE id=?2").bind(now, s.callId).run().catch(() => undefined);
    // [HF-CALL-MODES-C] "On a call" comes from the JOINED call (spec 2.1): both legs are in the room now. Best effort; dynamic so a missing helper never blocks the call.
    try { await markOnCall(this.env, s.hostUid, s.callId); } catch { /* the line lock already shows busy */ }
    this.emit(s.callerUid, "hf_call_connected", { call_id: s.callId, max_minutes: s.maxMinutes, guessed });
  }

  // ── hangup webhooks ───────────────────────────────────────────────────────────────────────────────────────────
  private async hangup(s: S, role: Role, f: Record<string, string>): Promise<Response> {
    // [HF-VOBIZ-SPEND-1] Record this leg's hangup webhook in the spend ledger (both legs, even after finalize). Off the response path; never throws.
    {
      const rec = recordLegFromWebhook(this.env, { callId: s.callId, role, legUuid: role === "host" ? s.hostLeg : s.callerLeg, fields: f ?? {} }).catch(() => undefined);
      const st = this.state as unknown as { waitUntil?: (p: Promise<unknown>) => void };
      if (typeof st.waitUntil === "function") st.waitUntil(rec);
    }
    if (s.finalized) return xmlRes(emptyXml());
    if (s.finishing) {
      if (role === "host") s.finishing.hostDone = true;
      else s.finishing.callerDone = true;
      await this.save(s);
      await this.disconnectAndFinalize(s);
      return xmlRes(emptyXml());
    }
    if (s.connectedAt) {
      await this.finish(s, "completed", role === "host" ? "host_hangup" : "caller_hangup",
        role === "host" ? { skipHostLeg: true } : { skipCallerLeg: true });
      return xmlRes(emptyXml());
    }
    if (role === "host") {
      // Before accepting: unanswered / no digit pressed within 10 s. After accepting but before connecting: the host walked away.
      if (!s.hostAccepted) await this.finish(s, "no_answer", null, { skipHostLeg: true });
      else await this.finish(s, "failed", "host_hangup", { skipHostLeg: true });
    } else {
      await this.finish(s, "caller_no_answer", null, { skipCallerLeg: true, tellHost: true });
    }
    return xmlRes(emptyXml());
  }

  private async cancel(s: S): Promise<Response> {
    if (s.finalized) return jsonRes({ ok: true, status: s.finalStatus });
    if (s.connectedAt) return jsonRes({ ok: false, error: "connected" }, 409);
    if (!(await this.finish(s, "failed", "caller_hangup"))) {
      return jsonRes({ ok: false, error: "disconnect_pending", status: s.status }, 503);
    }
    return jsonRes({ ok: true, status: "failed" });
  }

  private async watchdog(s: S): Promise<Response> {
    const now = Date.now();
    if (s.finalized) {
      if (!s.bill.post) {
        s.tasks.retry = now + 30_000;
        await this.save(s);
        await this.settleAndPost(s);
      }
      return jsonRes({ ok: true, finalized: true });
    }
    if (s.finishing) {
      await this.disconnectAndFinalize(s);
      return jsonRes({ ok: true, finishing: true });
    }
    if (!s.connectedAt && now - s.createdAt > 3 * 60_000) await this.finish(s, s.status === "ringing_caller" ? "caller_no_answer" : "no_answer", null, { tellHost: s.status === "ringing_caller" });
    else if (s.connectedAt && now > s.connectedAt + (this.maxSec(s) + 120) * 1000) await this.finish(s, "completed", s.limitReason);
    return jsonRes({ ok: true });
  }

  // ── alarms ────────────────────────────────────────────────────────────────────────────────────────────────────
  async alarm(): Promise<void> {
    const s = await this.load();
    if (!s) return;
    const now = Date.now();
    const due = (k: keyof S["tasks"]) => typeof s.tasks[k] === "number" && (s.tasks[k] as number) <= now + 250;
    try {
      if (s.finalized) {
        if (due("retry")) {
          s.tasks.retry = now + 30_000;
          await this.save(s);
          await this.settleAndPost(s);
        }
        return;
      }
      if (due("disconnect")) {
        s.tasks.disconnect = now + 30_000;
        await this.save(s);
        await this.disconnectAndFinalize(s);
        return;
      }
      if (due("announcement")) { await this.resumeSharedAnnouncement(s); return; }
      if (due("limit")) {
        // [HF-CALL-MODES-C] chunk billing: the call ended because the money (or the cap / booking end) ran out; say which in end_reason.
        const t = s.tok;
        const reason = t?.chunk && s.connectedAt
          ? ((t.fundedSec ?? 0) < chunkCapEffSec({ capSec: t.capSec ?? t.maxSeconds, connectedAt: s.connectedAt, hardEndsAt: s.hardEndsAt }) ? "balance" : "time_limit")
          : s.limitReason;
        await this.finish(s, "completed", reason); return;
      }
      // [HF-CALL-MODES-C] chunk billing timers. Each handler re-loads the state after its I/O, so none of them continues with this (possibly stale) copy.
      if (s.tok?.chunk && (due("chunk") || due("fundsRetry"))) {
        const retry = !due("chunk");
        delete s.tasks.chunk; delete s.tasks.fundsRetry; await this.save(s);
        try { await this.fund(retry ? "retry" : "chunk"); }
        catch (e) { await this.fundsFailed(e); }
        return;
      }
      if (s.tok?.chunk && due("whisper")) { delete s.tasks.whisper; await this.save(s); await this.oneMinuteWhisper(); return; }
      if (due("warn")) {
        delete s.tasks.warn; await this.save(s);
        if (s.tok?.chunk) { try { await this.chunkWarn(); } catch (e) { await this.fundsFailed(e); } return; }
        await Promise.all((["host", "caller"] as Role[]).map((r) =>
          speakIntoCall(this.env, { room: this.room(s), memberId: s.member[r], callUuid: r === "host" ? s.hostLeg : s.callerLeg, text: LIMIT_WARNING_TEXT })));
      }
      if (due("guess")) {
        delete s.tasks.guess;
        // Answer/accept webhooks prove only that each PSTN leg reached its prompt. Without provider conference evidence for BOTH members,
        // never synthesize a connected timestamp or bill seconds: close unbilled for explicit reconciliation.
        if (!s.connectedAt && !s.anyEnter && s.callerPicked && s.hostAccepted) await this.finish(s, "reconciliation", "conference_callbacks_missing");
        else await this.save(s);
      }
      if (due("ring")) {
        delete s.tasks.ring;
        if (!s.connectedAt) await this.finish(s, s.status === "ringing_caller" ? "caller_no_answer" : "no_answer", null, { tellHost: s.status === "ringing_caller" });
        else await this.save(s);
      }
    } catch (e) {
      await trackException(this.env, e, { route: "hf_call.alarm", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls" } });
    }
  }

  // ── [HF-CALL-MODES-C] chunk billing (flag hfCallChunkBillingEnabled; none of this runs for a call that started without it) ──────────
  /** Set limit / chunk / warn / whisper tasks from what is funded. Pure on `s`; the caller saves. */
  private plan(s: S): void {
    const t = s.tok;
    if (!t?.chunk || !s.connectedAt) return;
    const c = s.connectedAt, funded = t.fundedSec ?? 0, chunkSec = t.chunkSec ?? 300;
    const cap = chunkCapEffSec({ capSec: t.capSec ?? t.maxSeconds, connectedAt: c, hardEndsAt: s.hardEndsAt });
    const limitSec = Math.min(funded, cap);
    s.tasks.limit = c + limitSec * 1000;
    delete s.tasks.warn; delete s.tasks.whisper; delete s.tasks.chunk;
    const due = nextChunkDueSec({ fundedSec: funded, chunkSec, capEffSec: cap });
    if (t.short) {
      const w = c + (limitSec - 60) * 1000;
      if (limitSec > 65 && w > Date.now() + 2000) s.tasks.whisper = w;
      return;
    }
    if (due != null) { if (!s.tasks.fundsRetry) s.tasks.chunk = c + due * 1000; return; }
    delete s.tasks.fundsRetry;
    if (limitSec > WARN_BEFORE_LIMIT_SEC + 5) s.tasks.warn = c + (limitSec - WARN_BEFORE_LIMIT_SEC) * 1000;
  }

  private mp3(key: string): string | null {
    const base = this.env.HF_WHISPER_MP3_BASE;
    return base ? `${base.replace(/\/+$/, "")}/${key}.mp3` : null;
  }

  /** Caller-only whisper. Never takes a host id. Records which Vobiz path worked. */
  private async whisperCaller(s: S, kind: string, text: string, mp3Key: string): Promise<void> {
    const r = await speakToCaller(this.env, { room: this.room(s), callerMemberId: s.member.caller, callerLegUuid: s.callerLeg, text, mp3Url: this.mp3(mp3Key) })
      .catch(() => ({ ok: false, via: "none" as const }));
    this.emit(s.callerUid, "hf_call_whisper", { call_id: s.callId, kind, via: r.via, ok: r.ok });
  }

  /** Mute both PSTN legs, play one shared warning, then always try to restore speech. */
  private async sharedAnnouncement(s: S, kind: string, text: string, mp3Key: string): Promise<void> {
    const memberIds = [s.member.host, s.member.caller].filter((id): id is string => typeof id === "string" && id.length > 0);
    const r = await pauseForSharedAnnouncement(this.env, { room: this.room(s), memberIds, text, mp3Url: this.mp3(mp3Key) });
    this.emit(s.callerUid, "hf_call_shared_announcement", { call_id: s.callId, kind, via: r.via, ok: r.ok });
    if (!r.ok) return;
    const latest = await this.load();
    if (!latest || latest.finalized || latest.finishing) return;
    // Vobiz queues media asynchronously and has no completion callback. Fourteen
    // seconds safely covers the short recorded/TTS wallet announcement; the alarm
    // also retries unmute after a transient provider failure.
    latest.tasks.announcement = Date.now() + 14_000;
    await this.save(latest);
  }

  private async resumeSharedAnnouncement(s: S): Promise<void> {
    const memberIds = [s.member.host, s.member.caller].filter((id): id is string => typeof id === "string" && id.length > 0);
    const ok = await resumeAfterSharedAnnouncement(this.env, { room: this.room(s), memberIds });
    const latest = await this.load();
    if (!latest || latest.finalized || latest.finishing) return;
    if (ok) delete latest.tasks.announcement;
    else latest.tasks.announcement = Date.now() + 2_000;
    await this.save(latest);
  }

  /**
   * Reserve the chunks the call now needs (money is taken ~5 min ahead). Idempotent per chunk (the ledger gate is keyed on the chunk number).
   * All I/O happens before the state is re-read: a hangup that landed meanwhile wins, and whatever we reserved is swept by settle.
   */
  private async fund(reason: "chunk" | "retry" | "topup"): Promise<{ ran: boolean; fundedSec: number; short: boolean; addedSec: number }> {
    const s0 = await this.load();
    const idle = { ran: false, fundedSec: s0?.tok?.fundedSec ?? 0, short: s0?.tok?.short === true, addedSec: 0 };
    if (!s0 || s0.finalized || s0.finishing || !s0.tok?.chunk || !s0.connectedAt) return idle;
    const t0 = s0.tok, price = priceOf(t0), chunkSec = t0.chunkSec ?? 300;
    const cap = chunkCapEffSec({ capSec: t0.capSec ?? t0.maxSeconds, connectedAt: s0.connectedAt, hardEndsAt: s0.hardEndsAt });
    const start = t0.fundedSec ?? 0;
    let funded = start, n = t0.chunkN ?? 0, short = false, retrySoon = false;
    for (let i = 0; i < 70; i++) {
      const elapsed = Math.max(0, Math.floor((Date.now() - s0.connectedAt) / 1000));
      // already funded 5 minutes ahead -> nothing to do; but a call that ran short is re-checked at once (a top-up must extend it even though a partial chunk left it "ahead")
      if (!(t0.short === true && i === 0) && funded - elapsed > chunkSec - 5) break;
      const range = nextChunkRange({ fundedSec: funded, chunkSec, capEffSec: cap });
      if (!range) break;
      const r = await reserveChunk(this.env, s0.callerUid, s0.callId, n, price, range.from, range.to);
      if (!r.ok) {
        if (r.reason === "insufficient") short = true;
        else if (r.reason === "conflict") retrySoon = true;
        else if (r.reason === "invalid") { await trackException(this.env, new Error("chunk invalid"), { route: "hf_call.fund", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", call: s0.callId, n } }); retrySoon = true; }
        funded = Math.max(funded, r.fundedSec);
        break;
      }
      funded = Math.max(funded, r.fundedSec); n += 1;
      this.emit(s0.callerUid, "hf_call_chunk_reserved", { call_id: s0.callId, n: r.n, from_sec: r.fromSec, covered_sec: r.coveredSec, paise: r.paise, partial: r.partial, funded_seconds: funded, reason });
      if (r.partial) { short = true; break; }
    }
    const s = await this.load();
    if (!s || s.finalized || s.finishing || !s.tok?.chunk || !s.connectedAt) return { ...idle, ran: false };
    const t = s.tok, wasShort = t.short === true;
    t.fundedSec = Math.max(t.fundedSec ?? 0, funded); t.chunkN = Math.max(t.chunkN ?? 0, n);
    t.short = short && t.fundedSec < cap;
    const added = t.fundedSec - start;
    delete s.tasks.fundsRetry;
    if (t.short || retrySoon) s.tasks.fundsRetry = Date.now() + FUNDS_RETRY_MS;
    const needWhisper = t.short && !t.shortWhispered;
    const topped = !t.short && wasShort;
    if (needWhisper) t.shortWhispered = true;
    if (!t.short) t.shortWhispered = false;
    this.plan(s);
    await this.save(s);
    const remaining = Math.max(0, Math.min(t.fundedSec, cap) - Math.max(0, Math.floor((Date.now() - s.connectedAt) / 1000)));
    if (needWhisper) {
      this.emit(s.callerUid, "hf_call_funds_short", { call_id: s.callId, funded_seconds: t.fundedSec, remaining_sec: remaining, chunk_n: t.chunkN, reason });
      const m = whisperMinutes(remaining);
      await this.sharedAnnouncement(s, "low_funds", lowFundsWhisperText(m), `low_funds_${m}`);
    }
    if (topped || (reason === "topup" && added > 0)) {
      this.emit(s.callerUid, "hf_call_topup_extended", { call_id: s.callId, added_seconds: added, funded_seconds: t.fundedSec, reason });
      if (topped) await this.whisperCaller(s, "topped_up", TOPPED_UP_WHISPER_TEXT, "topped_up");
    }
    return { ran: true, fundedSec: t.fundedSec, short: t.short === true, addedSec: added };
  }

  /** A chunk step threw (D1 blip, ledger error): look again soon, never end the call for it. */
  private async fundsFailed(e: unknown): Promise<void> {
    const s = await this.load();
    await trackException(this.env, e, { route: "hf_call.fund", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", call: s?.callId } });
    if (!s || s.finalized || s.finishing || !s.tok?.chunk) return;
    s.tasks.fundsRetry = Date.now() + FUNDS_RETRY_MS;
    await this.save(s);
  }

  /** 60 s before the cap / a booking end (the call is funded all the way): the same both-leg warning as today. */
  private async chunkWarn(): Promise<void> {
    const s = await this.load();
    if (!s || s.finalized || s.finishing || !s.connectedAt) return;
    await Promise.all((["host", "caller"] as Role[]).map((r) =>
      speakIntoCall(this.env, { room: this.room(s), memberId: s.member[r], callUuid: r === "host" ? s.hostLeg : s.callerLeg, text: LIMIT_WARNING_TEXT })));
  }

  /** One minute before funds run out, pause both legs for the same shared warning. */
  private async oneMinuteWhisper(): Promise<void> {
    const s = await this.load();
    if (!s || s.finalized || s.finishing || !s.connectedAt || s.tok?.short !== true) return;
    await this.sharedAnnouncement(s, "one_minute", lowFundsWhisperText(1), "low_funds_1");
  }

  // ── finish: hang up, record, free the host, bill, announce ───────────────────────────────────────────────────
  private async finish(s: S, status: string, endReason: string | null, o: { hashBy?: Role; skipHostLeg?: boolean; skipCallerLeg?: boolean; tellHost?: boolean } = {}): Promise<boolean> {
    if (s.finalized) return true;
    if (!s.finishing) {
      s.endedAt = Date.now();
      s.finalStatus = status;
      s.endReason = endReason;
      s.hashBy = o.hashBy ?? null;
      s.finishing = {
        status,
        endReason,
        hashBy: o.hashBy ?? null,
        skipHostLeg: o.skipHostLeg === true,
        skipCallerLeg: o.skipCallerLeg === true,
        tellHost: o.tellHost === true,
        attempts: 0,
        hostDone: o.skipHostLeg === true || !s.hostLeg,
        callerDone: o.skipCallerLeg === true || !s.callerLeg,
      };
      s.status = "ending";
      s.tasks = { disconnect: Date.now() + 30_000 };
      await this.save(s);
    }
    return this.disconnectAndFinalize(s);
  }

  /** Do not claim a call ended until every still-live provider leg accepted a disconnect. */
  private async disconnectAndFinalize(s: S): Promise<boolean> {
    const request = s.finishing;
    if (!request) return s.finalized;
    // Durable backstop before provider I/O. If this invocation is terminated,
    // the alarm resumes only the legs that have not been acknowledged.
    s.tasks.disconnect = Date.now() + 30_000;
    await this.save(s);
    const provider = getTelephonyProvider(this.env);
    const disconnect = async (role: Role, callUuid: string): Promise<void> => {
      try {
        if (role === "host" && request.tellHost) {
          await provider.transferCall({ callUuid, legs: "aleg", alegUrl: this.urls(s).hostNoPickup })
            .catch(() => provider.hangupCall(callUuid));
        } else await provider.hangupCall(callUuid);
        if (role === "host") request.hostDone = true;
        else request.callerDone = true;
      } catch (error) {
        // A provider can reject DELETE after the leg has already ended. Resolve
        // that ambiguity before retrying so a successful leg is never targeted
        // again and one late webhook cannot strand the host reservation.
        try {
          const state = await provider.getCallState(callUuid);
          const status = state.status.trim().toLowerCase();
          const terminal = !!state.endedAt || !!state.hangupCause
            || ["completed", "ended", "failed", "cancelled", "canceled", "busy", "no-answer", "no_answer"].includes(status);
          if (terminal) {
            if (role === "host") request.hostDone = true;
            else request.callerDone = true;
            return;
          }
        } catch { /* unresolved: retain the leg for the alarm retry */ }
        throw error;
      }
    };
    const legs: Promise<void>[] = [];
    if (s.hostLeg && !request.hostDone) legs.push(disconnect("host", s.hostLeg));
    if (s.callerLeg && !request.callerDone) legs.push(disconnect("caller", s.callerLeg));
    const results = await Promise.allSettled(legs);
    // Persist successful per-leg acknowledgements even when the other leg
    // failed, otherwise the next alarm would repeat an already-complete DELETE.
    await this.save(s);
    const failure = results.find((result) => result.status === "rejected");
    if (failure || !request.hostDone || !request.callerDone) {
      request.attempts += 1;
      s.status = "ending";
      s.tasks.disconnect = Date.now() + Math.min(MAX_RETRY_DELAY_MS, 5_000 * request.attempts);
      await this.save(s);
      await trackException(this.env, failure && (failure as PromiseRejectedResult).reason || new Error("provider disconnect unresolved"), {
        route: "hf_call.disconnect", handled: true, app_name: HF_CALL_APP,
        extra: { area: "hf_calls", attempt: request.attempts, call: s.callId },
      });
      return false;
    }

    delete s.finishing;
    s.finalized = true;
    s.status = "finalizing";
    delete s.tasks.disconnect;
    // Keep a recovery path throughout D1 finalization, host release and
    // settlement. settleAndPost clears this only after bill.post is durable.
    s.tasks.retry = Date.now() + 20_000;
    await this.save(s);

    await this.db().prepare("UPDATE hf_calls SET status=?1, ended_at=?2, end_reason=?3, host_leg_uuid=?4, caller_leg_uuid=?5 WHERE id=?6")
      .bind("finalizing", s.endedAt, request.endReason, s.hostLeg, s.callerLeg, s.callId).run()
      .catch((e) => trackException(this.env, e, { route: "hf_call.finish", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "row" } }));
    if (request.hashBy) await this.recordBlock(s, request.hashBy);
    await this.settleAndPost(s);
    return true;
  }

  private async recordBlock(s: S, by: Role): Promise<void> {
    const blocker = by === "host" ? s.hostUid : s.callerUid, blocked = by === "host" ? s.callerUid : s.hostUid;
    const now = Date.now();
    try {
      await this.db().batch([
        this.db().prepare("INSERT OR REPLACE INTO hf_blocks (blocker_uid, blocked_uid, call_id, created_at) VALUES (?1,?2,?3,?4)").bind(blocker, blocked, s.callId, now),
        this.db().prepare("INSERT INTO hf_incidents (id, call_id, reporter_uid, kind, created_at) VALUES (?1,?2,?3,'hash_block',?4)").bind(crypto.randomUUID(), s.callId, blocker, now),
      ]);
    } catch (e) {
      await trackException(this.env, e, { route: "hf_call.block", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "block" } });
    }
    await dropBlockedEntries(this.env, blocker).catch(() => 0); // [HF-CALL-MODES-INT] rule 10: the '#' block also removes any queue entry between the pair
    this.emit(blocker, "hf_call_blocked", { call_id: s.callId, by });
  }

  // ── billing (idempotent steps, persisted; failures retry from the alarm) ──────────────────────────────────────
  private async settleAndPost(s: S): Promise<void> {
    if (!s.bookingId && !s.bill.hostReleased) {
      try {
        await releaseHost(this.env, s.hostUid, s.callId);
        s.bill.hostReleased = true;
        await this.save(s);
        await notifyLineFree(this.env, s.hostUid, s.callId, s.finalStatus).catch(() => undefined); // [HF-CALL-MODES-C] queue: the line is free
      } catch (e) {
        s.bill.attempts += 1;
        s.tasks.retry = Date.now() + Math.min(MAX_RETRY_DELAY_MS, 20_000 * s.bill.attempts);
        await this.save(s);
        await trackException(this.env, e, { route: "hf_call.settle", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "release_host", attempt: s.bill.attempts, call: s.callId } });
        return;
      }
    }
    const ok = await this.settle(s);
    if (!ok || s.bill.post) return;
    if (s.bookingId && !s.bill.hostReleased) {
      try {
        await releaseHost(this.env, s.hostUid, s.callId);
        s.bill.hostReleased = true;
        await this.save(s);
        await notifyLineFree(this.env, s.hostUid, s.callId, s.finalStatus).catch(() => undefined); // [HF-CALL-MODES-C] queue: the line is free
      } catch (e) {
        s.bill.attempts += 1;
        s.tasks.retry = Date.now() + Math.min(MAX_RETRY_DELAY_MS, 20_000 * s.bill.attempts);
        await this.save(s);
        await trackException(this.env, e, { route: "hf_call.settle", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "release_host", attempt: s.bill.attempts, call: s.callId } });
        return;
      }
    }
    const finalStatus = s.finalStatus ?? "completed";
    try {
      await this.db().prepare("UPDATE hf_calls SET status=?1, ended_at=?2, end_reason=?3, host_leg_uuid=?4, caller_leg_uuid=?5 WHERE id=?6")
        .bind(finalStatus, s.endedAt, s.endReason, s.hostLeg, s.callerLeg, s.callId).run();
      if (s.bookingId) {
        const bookingStatus = finalStatus === "completed" ? "completed" : "failed";
        const occupancyStatus = bookingStatus === "completed" ? "completed" : "cancelled";
        const settlementStatus = bookingStatus === "completed" ? "settled" : "released";
        const now = Date.now();
        await this.db().batch([
          this.db().prepare("UPDATE hf_bookings SET status=?1,settlement_status=?2,completed_at=?3,updated_at=?3 WHERE id=?4 AND call_id=?5 AND status IN ('starting','active','settling')")
            .bind(bookingStatus, settlementStatus, now, s.bookingId, s.callId),
          this.db().prepare("INSERT OR IGNORE INTO hf_booking_events(id,booking_id,operation_id,actor_uid,from_status,to_status,details_json,created_at) " +
            "SELECT ?1,?2,?3,NULL,NULL,?4,?5,?6 WHERE EXISTS (SELECT 1 FROM hf_bookings WHERE id=?2 AND call_id=?7 AND status=?4)")
            .bind(crypto.randomUUID(), s.bookingId, "call-final:" + s.callId, bookingStatus, JSON.stringify({ callId: s.callId, endReason: s.endReason }), now, s.callId),
          this.db().prepare("UPDATE hf_booking_occupancy SET status=?1,updated_at=?2 WHERE booking_id=?3")
            .bind(occupancyStatus, now, s.bookingId),
          this.db().prepare("UPDATE calendar_blocks SET status=?1 WHERE source_app='hf_booking' AND source_ref=?2")
            .bind(occupancyStatus, s.bookingId),
        ]);
        const savedBooking = await this.db().prepare("SELECT status,settlement_status,call_id FROM hf_bookings WHERE id=?1")
          .bind(s.bookingId).first<{ status: string; settlement_status: string; call_id: string }>();
        if (!savedBooking || savedBooking.call_id !== s.callId || savedBooking.status !== bookingStatus || savedBooking.settlement_status !== settlementStatus) {
          throw new Error("booking finalization did not persist");
        }
      }
    } catch (e) {
      s.bill.attempts += 1;
      s.tasks.retry = Date.now() + Math.min(MAX_RETRY_DELAY_MS, 20_000 * s.bill.attempts);
      await this.save(s);
      await trackException(this.env, e, { route: "hf_call.settle", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "final_row", attempt: s.bill.attempts, call: s.callId } });
      return;
    }
    s.bill.post = true;
    s.status = finalStatus;
    delete s.tasks.retry;
    await this.save(s);
    // [HF-CALL-MODES-C] what the call was funded for and how many chunks it took: the money monitor's judgeCall reads funded_seconds. Best effort (column from an ALTER migration).
    if (s.tok?.chunk) await this.db().prepare("UPDATE hf_calls SET funded_seconds=?1, chunks=?2 WHERE id=?3").bind(s.tok.fundedSec ?? 0, s.tok.chunkN ?? 0, s.callId).run().catch(() => undefined);
    const billed = s.bill.plan?.billedMinutes ?? 0;
    this.emit(s.callerUid, "hf_call_ended", { call_id: s.callId, billed_minutes: billed, end_reason: s.endReason ?? s.finalStatus,
      ...(s.source ? { source: s.source } : {}), ...(s.tok?.chunk ? { funded_seconds: s.tok.fundedSec ?? 0, chunks: s.tok.chunkN ?? 0 } : {}) }); // [HF-CALL-MODES-C]
    const row = await this.db().prepare("SELECT * FROM hf_calls WHERE id=?1").bind(s.callId).first<HfCallRow>().catch(() => null);
    if (row) await onCallCompleted(this.env, undefined, row).catch(() => undefined);
  }

  // [HF-TOK-CALLS-1] Token calls: per-second billing over the caller's lots, split from the START snapshot, host paid in paise.
  private async settleTokens(s: S): Promise<boolean> {
    const b = s.bill, t = s.tok as TokenSnap;
    try {
      if (!b.tokSettled) {
        const endedAt = s.endedAt ?? Date.now();
        const rawSeconds = s.connectedAt ? Math.floor((endedAt - s.connectedAt) / 1000) : 0;
        const seconds = s.hardEndsAt != null && s.connectedAt != null
          ? Math.max(0, Math.min(rawSeconds, Math.floor((s.hardEndsAt - s.connectedAt) / 1000)))
          : rawSeconds;
        const rules = await readMoneyRules(this.env); // [HF-WIRE-13] rule 3: joined and broke inside the first minute = the fixed charge
        const out = await settleTokenCall(this.env, {
          callId: s.callId, callerUid: s.callerUid, hostUid: s.hostUid, ratePaise: t.ratePaise, callCostPaisePerMin: t.callCostPaisePerMin,
          hostShareBps: t.hostShareBps, connectedSeconds: seconds, maxSeconds: t.chunk && t.booked !== true ? Math.min(t.maxSeconds, Math.max(0, t.fundedSec ?? 0)) : t.maxSeconds, endedAt, std: t.std ?? null, creator: t.creator, booked: t.booked === true,
          joined: s.connectedAt != null, dropChargePaise: rules.dropChargePaise,
        });
        b.plan = { billedMinutes: out.billedMinutes, chargeRupees: 0, hostEarningPaise: out.hostPaise, hostTokens: 0, capped: out.shortfall };
        b.tokSettled = true; b.saved = true;
        await this.save(s);
        this.emit(s.callerUid, "hf_call_settled", {
          call_id: s.callId, consumed_value_paise: out.consumedValuePaise, host_earning_paise: out.hostPaise, lots: out.lots.length,
          billable_seconds: out.billableSeconds, tokens_spent_micro: out.tokensSpentMicro,
          plan: t.creator ? "creator" : t.std ? "standard" : "host_rate", charge_paise: out.consumedValuePaise, phone_cost_est_paise: out.callCostPaise, platform_paise: out.platformPaise, shortfall: out.shortfall,
        });
      }
      // [HF-CALL-MODES-C] a chunk that was mid-flight at hangup may have landed after settle read the hold: sweep it (idempotent, safe on every retry).
      if (t.chunk) await releaseOrphanChunks(this.env, s.callId).catch((e) => trackException(this.env, e, { route: "hf_call.settle", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "orphan_chunks", call: s.callId } }));
      return true;
    } catch (e) {
      b.attempts += 1;
      await trackException(this.env, e, { route: "hf_call.settle", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "billing_tokens", attempt: b.attempts, call: s.callId } });
      s.tasks.retry = Date.now() + Math.min(MAX_RETRY_DELAY_MS, 20_000 * b.attempts);
      await this.save(s);
      return false;
    }
  }

  private async settle(s: S): Promise<boolean> {
    if (s.tok) return this.settleTokens(s);
    const b = s.bill;
    try {
      if (!b.plan) {
        const seconds = s.connectedAt ? Math.floor(((s.endedAt ?? Date.now()) - s.connectedAt) / 1000) : 0;
        // [HF-WALLET-1] `funds` = PAID rupees secured in the wallet; test credits (held at start) cover the charge first.
        let funds = s.reservedRupees;
        const testHeld = Math.max(0, s.testReservedRupees ?? 0);
        const wantCharge = Math.min(billedMinutes(seconds) * s.rateRupees, s.fundsRupees);
        const extraNeeded = paidStillNeeded(wantCharge, testHeld, funds);
        if (extraNeeded > 0) {
          // Secure the rest of the charge (never more than the balance at start). Two op ids: a refused reserve is cached by op_id.
          const extra = extraNeeded;
          const r1 = await hfReserve(this.env, s.callerUid, extra, s.callId, "reserve2");
          if (r1.ok) funds += extra;
          else if (r1.status === 402 && r1.available > 0) {
            const part = Math.min(extra, r1.available);
            const r2 = await hfReserve(this.env, s.callerUid, part, s.callId, "reserve3");
            if (r2.ok) funds += part; else if (r2.status !== 402) throw new Error(`reserve3 ${r2.status}`);
          } else if (r1.status !== 402) throw new Error(`reserve2 ${r1.status}`);
        }
        b.funds = funds;
        // [HF-WIRE-13] rule 3 on the old rupee wallet: a joined call that broke inside the first minute costs the fixed charge (whole rupees, rounded up).
        const drop = firstMinuteDrop({ joined: s.connectedAt != null, connectedSeconds: seconds, dropChargePaise: (await readMoneyRules(this.env)).dropChargePaise });
        const st = drop.applies
          ? { billedMinutes: 1, chargeRupees: Math.min(Math.ceil(drop.chargePaise / 100), funds + testHeld), hostEarningPaise: 0, capped: false }
          : settleCall({ connectedSeconds: seconds, rateRupees: s.rateRupees, fundsRupees: funds + testHeld });
        let hostTokens = 0;
        if (st.hostEarningPaise > 0) {
          const prior = await this.db().prepare("SELECT COALESCE(SUM(host_earning_paise),0) AS p, COALESCE(SUM(host_earned_tokens),0) AS t FROM hf_calls WHERE host_uid=?1 AND id<>?2")
            .bind(s.hostUid, s.callId).first<{ p: number; t: number }>();
          hostTokens = Math.min(st.chargeRupees, hostTokensToCredit(Number(prior?.p ?? 0), Number(prior?.t ?? 0), st.hostEarningPaise));
        }
        const split = splitCharge(st.chargeRupees, testHeld);
        const hs = splitHostShare(hostTokens, st.chargeRupees, split.paidUsed);
        b.plan = {
          billedMinutes: st.billedMinutes, chargeRupees: st.chargeRupees, hostEarningPaise: st.hostEarningPaise, hostTokens, capped: st.capped,
          testUsed: split.testUsed, paidUsed: split.paidUsed, hostPaid: hs.hostPaid, hostTest: hs.hostTest,
        };
        await this.save(s);
      }
      const plan = b.plan;
      // Plans saved before HF-WALLET-1 have no split: everything was paid.
      const paidUsed = plan.paidUsed ?? plan.chargeRupees, testUsed = plan.testUsed ?? 0;
      const hostPaid = plan.hostPaid ?? plan.hostTokens, hostTest = plan.hostTest ?? 0;
      if (b.consumed == null) {
        if (paidUsed > 0) {
          const c = await hfConsume(this.env, s.callerUid, paidUsed, s.callId, s.hostUid);
          if (!c.ok) throw new Error("consume failed");
          b.consumed = c.consumed;
        } else b.consumed = 0;
        await this.save(s);
      }
      if (!b.released) {
        if (!(await hfRelease(this.env, s.callerUid, s.callId))) throw new Error("release failed");
        b.released = true; await this.save(s);
      }
      if (!b.testSettled) {
        await settleTestCredits(this.env, s.callerUid, s.callId, testUsed);
        b.testSettled = true; await this.save(s);
      }
      if (hostPaid > 0 && !b.earned) {
        if (!(await hfEarn(this.env, s.hostUid, hostPaid, s.callId, s.callerUid, Math.max(0, (b.consumed ?? 0) - hostPaid)))) throw new Error("earn failed");
        b.earned = true; await this.save(s);
      }
      if (hostTest > 0 && !b.testEarned) {
        await this.db().prepare("INSERT OR IGNORE INTO hf_host_test_earnings (id, host_uid, call_id, rupees, created_at) VALUES (?1,?2,?3,?4,?5)")
          .bind(crypto.randomUUID(), s.hostUid, s.callId, hostTest, Date.now()).run();
        b.testEarned = true; await this.save(s);
      }
      if (!b.saved) {
        await this.db().prepare(
          "UPDATE hf_calls SET billed_minutes=?1, charged_paise=?2, host_earning_paise=?3, host_earned_tokens=?4, paid_rupees=?5, test_rupees=?6, host_paid_rupees=?7, host_test_rupees=?8 WHERE id=?9",
        ).bind(plan.billedMinutes, ((b.consumed ?? 0) + testUsed) * 100, plan.hostEarningPaise, plan.hostTokens, b.consumed ?? 0, testUsed, hostPaid, hostTest, s.callId).run();
        b.saved = true; await this.save(s);
      }
      return true;
    } catch (e) {
      b.attempts += 1;
      await trackException(this.env, e, { route: "hf_call.settle", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "billing", attempt: b.attempts, call: s.callId } });
      s.tasks.retry = Date.now() + Math.min(MAX_RETRY_DELAY_MS, 20_000 * b.attempts);
      await this.save(s);
      return false;
    }
  }
}

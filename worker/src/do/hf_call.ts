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
import { speakIntoCall } from "../lib/hf_vobiz";
import {
  HF_CALL_APP, webhookBase, releaseHost, hfReserve, hfRelease, hfConsume, hfEarn, type HfCallRow,
} from "../lib/hf_calls_store";
import {
  settleCall, billedMinutes, hostTokensToCredit, callerHandle, hostAnnounceXml, noticeAndConferenceXml, hangupXml, emptyXml,
  LIMIT_WARNING_TEXT, WARN_BEFORE_LIMIT_SEC,
} from "../lib/hf_call_math";

type Role = "host" | "caller";
const HOST_RING_SEC = 30, CALLER_RING_SEC = 35;
const HOST_PHASE_MS = 90_000;      // ring + announcement + digit wait
const CALLER_PHASE_MS = 70_000;    // caller ring + safety notice
const CONNECT_GUESS_MS = 25_000;   // only used when Vobiz sends no conference "enter" events at all
const MAX_BILL_ATTEMPTS = 8;

interface Plan { billedMinutes: number; chargeRupees: number; hostEarningPaise: number; hostTokens: number; capped: boolean }
interface Bill { funds?: number; plan?: Plan; consumed?: number; released?: boolean; earned?: boolean; saved?: boolean; post?: boolean; attempts: number }
interface S {
  callId: string; callerUid: string; hostUid: string;
  rateRupees: number; reservedRupees: number; fundsRupees: number; maxMinutes: number; limitReason: "time_limit" | "balance";
  status: string; createdAt: number;
  hostLeg: string | null; callerLeg: string | null;
  hostPicked: boolean; hostAccepted: boolean; callerPicked: boolean; callerPickedAt: number | null;
  inRoom: Record<Role, boolean>; member: Partial<Record<Role, string>>; anyEnter: boolean;
  connectedAt: number | null; endedAt: number | null; endReason: string | null; finalStatus: string | null; hashBy: Role | null;
  finalized: boolean; tasks: Partial<Record<"ring" | "warn" | "limit" | "retry" | "guess", number>>; bill: Bill;
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
  private backstopSec(s: S) { return s.maxMinutes * 60 + 90; }

  // ── HTTP entry (internal: only routes/hf_calls.ts and the cron call this) ───────────────────────────────────────
  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname.replace(/^\/+/, "");
    let body: Record<string, any> = {};
    try { body = (await req.json()) as Record<string, any>; } catch { body = {}; }
    try {
      if (path === "init") return await this.init(body);
      const s = await this.load();
      if (!s) return path === "host-answer" || path === "host-digits" || path === "caller-answer" ? xmlRes(hangupXml()) : jsonRes({ ok: false, error: "unknown_call" }, 404);
      switch (path) {
        case "host-answer": return await this.hostAnswer(s, body.fields ?? {});
        case "host-digits": return await this.hostDigits(s, body.fields ?? {});
        case "caller-answer": return await this.callerAnswer(s, body.fields ?? {});
        case "conf": return await this.conf(s, body.role as Role, body.fields ?? {});
        case "hangup": return await this.hangup(s, body.role as Role, body.fields ?? {});
        case "cancel": return await this.cancel(s);
        case "watchdog": return await this.watchdog(s);
        default: return jsonRes({ ok: false, error: "not_found" }, 404);
      }
    } catch (e) {
      await trackException(this.env, e, { route: `hf_call.${path}`, handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls" } });
      return path === "host-answer" || path === "host-digits" || path === "caller-answer" ? xmlRes(hangupXml("Sorry, something went wrong. Goodbye.")) : jsonRes({ ok: false, error: "internal" }, 500);
    }
  }

  // ── start: the host rings first ───────────────────────────────────────────────────────────────────────────────
  private async init(b: Record<string, any>): Promise<Response> {
    if (await this.load()) return jsonRes({ ok: true, again: true });
    const now = Date.now();
    const s: S = {
      callId: String(b.callId), callerUid: String(b.callerUid), hostUid: String(b.hostUid),
      rateRupees: Math.trunc(Number(b.rateRupees)), reservedRupees: Math.trunc(Number(b.reservedRupees)), fundsRupees: Math.trunc(Number(b.fundsRupees)),
      maxMinutes: Math.trunc(Number(b.maxMinutes)), limitReason: b.limitReason === "balance" ? "balance" : "time_limit",
      status: "ringing_host", createdAt: now, hostLeg: null, callerLeg: null,
      hostPicked: false, hostAccepted: false, callerPicked: false, callerPickedAt: null,
      inRoom: { host: false, caller: false }, member: {}, anyEnter: false,
      connectedAt: null, endedAt: null, endReason: null, finalStatus: null, hashBy: null,
      finalized: false, tasks: { ring: now + HOST_PHASE_MS }, bill: { attempts: 0 },
    };
    await this.save(s);
    try {
      const to = await verifiedWhatsAppNumber(this.env, s.hostUid);
      if (!to) throw new Error("host has no verified number");
      const u = this.urls(s);
      const r = await getTelephonyProvider(this.env).makeCall({
        from: this.env.HF_CALL_DID || "", to, answerUrl: u.answer("host"), hangupUrl: u.hangup("host"), ringTimeoutSec: HOST_RING_SEC,
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
    if (digit !== "1") {
      await this.finish(s, "host_declined", null, { skipHostLeg: true });
      return xmlRes(hangupXml("Okay. Goodbye."));
    }
    s.hostAccepted = true; s.status = "ringing_caller"; s.tasks.ring = Date.now() + CALLER_PHASE_MS;
    await this.save(s);
    await this.db().prepare("UPDATE hf_calls SET status='ringing_caller' WHERE id=?1").bind(s.callId).run().catch(() => undefined);
    try {
      const to = await verifiedWhatsAppNumber(this.env, s.callerUid);
      if (!to) throw new Error("caller has no verified number");
      const u = this.urls(s);
      const r = await getTelephonyProvider(this.env).makeCall({
        from: this.env.HF_CALL_DID || "", to, answerUrl: u.answer("caller"), hangupUrl: u.hangup("caller"), ringTimeoutSec: CALLER_RING_SEC,
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
      if (s.connectedAt) await this.finish(s, "completed", role === "host" ? "host_hangup" : "caller_hangup");
      else await this.save(s);
    }
    return xmlRes(emptyXml());
  }

  private async connect(s: S, guessed: boolean): Promise<void> {
    const now = Date.now();
    s.connectedAt = now; s.status = "connected"; delete s.tasks.ring; delete s.tasks.guess;
    const limitMs = s.maxMinutes * 60_000;
    s.tasks.limit = now + limitMs;
    if (limitMs > (WARN_BEFORE_LIMIT_SEC + 5) * 1000) s.tasks.warn = now + limitMs - WARN_BEFORE_LIMIT_SEC * 1000;
    await this.save(s);
    await this.db().prepare("UPDATE hf_calls SET status='connected', connected_at=?1 WHERE id=?2").bind(now, s.callId).run().catch(() => undefined);
    this.emit(s.callerUid, "hf_call_connected", { call_id: s.callId, max_minutes: s.maxMinutes, guessed });
  }

  // ── hangup webhooks ───────────────────────────────────────────────────────────────────────────────────────────
  private async hangup(s: S, role: Role, _f: Record<string, string>): Promise<Response> {
    if (s.finalized) return xmlRes(emptyXml());
    if (s.connectedAt) { await this.finish(s, "completed", role === "host" ? "host_hangup" : "caller_hangup"); return xmlRes(emptyXml()); }
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
    await this.finish(s, "failed", "caller_hangup");
    return jsonRes({ ok: true, status: "failed" });
  }

  private async watchdog(s: S): Promise<Response> {
    const now = Date.now();
    if (s.finalized) { if (!s.bill.post) await this.settleAndPost(s); return jsonRes({ ok: true, finalized: true }); }
    if (!s.connectedAt && now - s.createdAt > 3 * 60_000) await this.finish(s, s.status === "ringing_caller" ? "caller_no_answer" : "no_answer", null, { tellHost: s.status === "ringing_caller" });
    else if (s.connectedAt && now > s.connectedAt + (s.maxMinutes + 2) * 60_000) await this.finish(s, "completed", s.limitReason);
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
        if (due("retry")) { delete s.tasks.retry; await this.save(s); await this.settleAndPost(s); }
        return;
      }
      if (due("limit")) { await this.finish(s, "completed", s.limitReason); return; }
      if (due("warn")) {
        delete s.tasks.warn; await this.save(s);
        await Promise.all((["host", "caller"] as Role[]).map((r) =>
          speakIntoCall(this.env, { room: this.room(s), memberId: s.member[r], callUuid: r === "host" ? s.hostLeg : s.callerLeg, text: LIMIT_WARNING_TEXT })));
      }
      if (due("guess")) {
        delete s.tasks.guess;
        // Vobiz sent no conference callbacks at all: assume both legs are in the room (the caller answered and the host accepted).
        if (!s.connectedAt && !s.anyEnter && s.callerPicked && s.hostAccepted) await this.connect(s, true);
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

  // ── finish: hang up, record, free the host, bill, announce ───────────────────────────────────────────────────
  private async finish(s: S, status: string, endReason: string | null, o: { hashBy?: Role; skipHostLeg?: boolean; skipCallerLeg?: boolean; tellHost?: boolean } = {}): Promise<void> {
    if (s.finalized) return;
    s.finalized = true; s.endedAt = Date.now(); s.finalStatus = status; s.endReason = endReason; s.hashBy = o.hashBy ?? null; s.tasks = {};
    s.status = status;
    await this.save(s);

    const provider = getTelephonyProvider(this.env);
    const legs: Promise<unknown>[] = [];
    if (o.tellHost && s.hostLeg) {
      legs.push(provider.transferCall({ callUuid: s.hostLeg, legs: "aleg", alegUrl: this.urls(s).hostNoPickup }).catch(() => provider.hangupCall(s.hostLeg as string).catch(() => undefined)));
    } else if (s.hostLeg && !o.skipHostLeg) legs.push(provider.hangupCall(s.hostLeg).catch(() => undefined));
    if (s.callerLeg && !o.skipCallerLeg) legs.push(provider.hangupCall(s.callerLeg).catch(() => undefined));
    await Promise.allSettled(legs);

    await this.db().prepare("UPDATE hf_calls SET status=?1, ended_at=?2, end_reason=?3, host_leg_uuid=?4, caller_leg_uuid=?5 WHERE id=?6")
      .bind(status, s.endedAt, endReason, s.hostLeg, s.callerLeg, s.callId).run()
      .catch((e) => trackException(this.env, e, { route: "hf_call.finish", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "row" } }));
    await releaseHost(this.env, s.hostUid).catch(() => undefined);

    if (o.hashBy) await this.recordBlock(s, o.hashBy);
    await this.settleAndPost(s);
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
    this.emit(blocker, "hf_call_blocked", { call_id: s.callId, by });
  }

  // ── billing (idempotent steps, persisted; failures retry from the alarm) ──────────────────────────────────────
  private async settleAndPost(s: S): Promise<void> {
    const ok = await this.settle(s);
    if (!ok || s.bill.post) return;
    s.bill.post = true; await this.save(s);
    const billed = s.bill.plan?.billedMinutes ?? 0;
    this.emit(s.callerUid, "hf_call_ended", { call_id: s.callId, billed_minutes: billed, end_reason: s.endReason ?? s.finalStatus });
    if (billed >= 1) {
      const row = await this.db().prepare("SELECT * FROM hf_calls WHERE id=?1").bind(s.callId).first<HfCallRow>().catch(() => null);
      if (row) await onCallCompleted(this.env, undefined, row).catch(() => undefined);
    }
  }

  private async settle(s: S): Promise<boolean> {
    const b = s.bill;
    try {
      if (!b.plan) {
        const seconds = s.connectedAt ? Math.floor(((s.endedAt ?? Date.now()) - s.connectedAt) / 1000) : 0;
        let funds = s.reservedRupees;
        const wantCharge = Math.min(billedMinutes(seconds) * s.rateRupees, s.fundsRupees);
        if (wantCharge > funds) {
          // Secure the rest of the charge (never more than the balance at start). Two op ids: a refused reserve is cached by op_id.
          const extra = wantCharge - funds;
          const r1 = await hfReserve(this.env, s.callerUid, extra, s.callId, "reserve2");
          if (r1.ok) funds += extra;
          else if (r1.status === 402 && r1.available > 0) {
            const part = Math.min(extra, r1.available);
            const r2 = await hfReserve(this.env, s.callerUid, part, s.callId, "reserve3");
            if (r2.ok) funds += part; else if (r2.status !== 402) throw new Error(`reserve3 ${r2.status}`);
          } else if (r1.status !== 402) throw new Error(`reserve2 ${r1.status}`);
        }
        b.funds = funds;
        const st = settleCall({ connectedSeconds: seconds, rateRupees: s.rateRupees, fundsRupees: funds });
        let hostTokens = 0;
        if (st.hostEarningPaise > 0) {
          const prior = await this.db().prepare("SELECT COALESCE(SUM(host_earning_paise),0) AS p, COALESCE(SUM(host_earned_tokens),0) AS t FROM hf_calls WHERE host_uid=?1 AND id<>?2")
            .bind(s.hostUid, s.callId).first<{ p: number; t: number }>();
          hostTokens = Math.min(st.chargeRupees, hostTokensToCredit(Number(prior?.p ?? 0), Number(prior?.t ?? 0), st.hostEarningPaise));
        }
        b.plan = { billedMinutes: st.billedMinutes, chargeRupees: st.chargeRupees, hostEarningPaise: st.hostEarningPaise, hostTokens, capped: st.capped };
        await this.save(s);
      }
      const plan = b.plan;
      if (b.consumed == null) {
        if (plan.chargeRupees > 0) {
          const c = await hfConsume(this.env, s.callerUid, plan.chargeRupees, s.callId, s.hostUid);
          if (!c.ok) throw new Error("consume failed");
          b.consumed = c.consumed;
        } else b.consumed = 0;
        await this.save(s);
      }
      if (!b.released) {
        if (!(await hfRelease(this.env, s.callerUid, s.callId))) throw new Error("release failed");
        b.released = true; await this.save(s);
      }
      if (plan.hostTokens > 0 && !b.earned) {
        if (!(await hfEarn(this.env, s.hostUid, plan.hostTokens, s.callId, s.callerUid, Math.max(0, (b.consumed ?? 0) - plan.hostTokens)))) throw new Error("earn failed");
        b.earned = true; await this.save(s);
      }
      if (!b.saved) {
        await this.db().prepare("UPDATE hf_calls SET billed_minutes=?1, charged_paise=?2, host_earning_paise=?3, host_earned_tokens=?4 WHERE id=?5")
          .bind(plan.billedMinutes, (b.consumed ?? 0) * 100, plan.hostEarningPaise, plan.hostTokens, s.callId).run();
        b.saved = true; await this.save(s);
      }
      return true;
    } catch (e) {
      b.attempts += 1;
      await trackException(this.env, e, { route: "hf_call.settle", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "billing", attempt: b.attempts, call: s.callId } });
      if (b.attempts < MAX_BILL_ATTEMPTS) s.tasks.retry = Date.now() + 20_000 * b.attempts;
      await this.save(s);
      return false;
    }
  }
}

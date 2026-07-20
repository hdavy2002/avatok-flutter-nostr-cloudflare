// CampaignDO — [AVA-CAMP-B2-DO] per-campaign alarm-driven dial-loop scheduler
// for outbound AI calling campaigns (Specs/OUTBOUND-AI-CALLING-CAMPAIGNS.md
// §2, §5, §6.3, §6.4, §6.5, §6.6, §15). One instance per campaign id
// (`env.CAMPAIGN_DO.get(env.CAMPAIGN_DO.idFromName(campaignId))`).
//
// OWNERSHIP: D1 (`campaigns`, `campaign_contacts`, `campaign_call_attempts`,
// via `metaDb(env)`) is the AUTHORITATIVE store (§1.5, §2). This DO is an
// EXECUTOR that reconstructs everything from D1 on every alarm tick — it
// holds no durable business state of its own beyond:
//   - an EPHEMERAL in-flight map (attempt_uuid → {contactId, callUuid,
//     didE164, reservedAt}), lost on eviction by design (a re-attach after
//     eviction just means the next onCallEnded/webhook still lands via D1 +
//     the attempt row; nothing is "stranded" because the DialerGateDO permit
//     and the wallet reservation are both independently recoverable — see
//     TODO(reconciliation) below), and
//   - a tiny DO-SQLite circuit-breaker counter table (`cb`), which DOES need
//     to survive eviction (§6.5's "20 consecutive failures" must not reset
//     just because the DO was swapped out), so it lives in `state.storage.sql`
//     rather than in-memory.
//
// Alarms are AT-LEAST-ONCE (Cloudflare docs) — every branch below is written
// to be safe to re-enter: the conditional D1 UPDATE in acquireContact() is
// the single source of dial-race-safety, wallet ops are idempotent on
// `attempt_uuid:<verb>`, and DialerGateDO permits are explicitly released
// whenever a permit is granted but not spent.
//
// [AVA-CAMP-B2-DO]: `worker/src/lib/call_fsm.ts` now exists (landed from
// Phase B2's FSM task) and this file routes its two DO-driven attempt
// transitions ('dial_reserved'->'calling' on successful dial, and the
// billing-lifecycle '...'->'settled' marker in onCallEnded) through
// `applyAttemptTransition` so `fsm_transitions` audit rows get written for
// every attempt-state change this DO drives. The retry-taxonomy (§6.4)
// classification in `classifyOutcome()` is unrelated to FSM legality — it
// only decides campaign_contacts.status / retry scheduling — and stays
// inline here by design; it does not write to `campaign_call_attempts.outcome`
// (the FSM/route own that column exclusively now).
import type { Env } from "../types";
import { json } from "../util";
import { metaDb } from "../db/shard";
import { track } from "../hooks";
import { getTelephonyProvider } from "../lib/telephony_provider";
import { walletReserve, walletConsumeReserved, walletReleaseReservation } from "../routes/wallet";
import { applyAttemptTransition } from "../lib/call_fsm";

// Same callback-base convention as routes/pstn.ts (PUBLIC_BASE is not
// exported from there, so it is duplicated here — keep in lock-step if it
// ever changes; both are the production API host).
const PUBLIC_BASE = "https://api.avatok.ai";

const RESERVE_TOKENS = 60;              // 10 min AI @ 6/min (§5)
const RING_TIMEOUT_SEC = 30;            // §6.3 step 3 / §7 single ring-timeout authority
const TIME_LIMIT_SEC = 615;             // 10-min hard cap + margin (§4 AI hard cap 10 min)
const DIAL_TICK_MS = 2_000;             // "alarm(+2s) for the next dial while capacity remains"
const RETRY_BACKOFF_MS = 180 * 60_000;  // 180 min (§6.4)
const MAX_ATTEMPTS_DEFAULT = 2;         // "max 2 attempts" (§6.4)
const IST_OFFSET_MIN = 330;             // UTC+5:30
const MIN_PER_DAY = 1440;
const CIRCUIT_BREAKER_CONSECUTIVE = 20; // §6.5
const CIRCUIT_BREAKER_WINDOW_MS = 5 * 60_000;
const CIRCUIT_BREAKER_5XX_RATE = 0.5;
const HEARTBEAT_MIN_INTERVAL_MS = 60_000; // §15 "every 60-120s while not progressing"

type CampaignRow = {
  id: string; uid: string; status: string;
  did_e164: string | null;
  concurrency: number;
  window_start_min: number; window_end_min: number;
  retry_policy: string | null;
  spend_cap_tokens: number;
  tokens_spent: number; seconds_talked: number;
  n_total: number; n_done: number; n_answered: number; n_missed: number;
  n_busy: number; n_machine: number; n_failed: number; n_dnc: number;
  prompt_version: number | null; tool_runtime_version: number | null;
  fsm_version: number | null; kb_version: number | null;
  analytics_schema_version: number | null; kb_store: string | null;
  started_at: number | null; completed_at: number | null;
};

type ContactRow = { id: string; name: string | null; e164: string | null; attempts: number; status: string };

interface InFlight { contactId: string; callUuid: string | null; didE164: string; reservedAt: number; }

interface RetryPolicy { maxAttempts: number; backoffMs: number; }

export class CampaignDO {
  private env: Env;
  private state: DurableObjectState;
  private sql: SqlStorage;
  private campaignId: string | null = null;

  // Ephemeral (lost on eviction by design — see class docblock).
  private inFlight: Map<string, InFlight> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.state = state;
    this.sql = state.storage.sql;
    // Circuit-breaker counters — the one piece of durable DO-local state
    // (§6.5 must survive a DO eviction/restart, unlike everything else here).
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS cb (k INTEGER PRIMARY KEY, consecutive_failures INTEGER NOT NULL DEFAULT 0, " +
      "window_start INTEGER NOT NULL DEFAULT 0, window_total INTEGER NOT NULL DEFAULT 0, window_5xx INTEGER NOT NULL DEFAULT 0, " +
      "tripped INTEGER NOT NULL DEFAULT 0)",
    );
    this.sql.exec("INSERT OR IGNORE INTO cb (k) VALUES (1)");
    // Heartbeat throttle (§15) — also worth surviving eviction so a rapid
    // evict/restart cycle can't spam heartbeats.
    this.sql.exec("CREATE TABLE IF NOT EXISTS hb (k INTEGER PRIMARY KEY, last_at INTEGER NOT NULL DEFAULT 0)");
    this.sql.exec("INSERT OR IGNORE INTO hb (k, last_at) VALUES (1,0)");
  }

  // ---------------------------------------------------------------------
  // fetch() op API
  // ---------------------------------------------------------------------
  async fetch(req: Request): Promise<Response> {
    let body: any = {};
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const campaignId = String(body.campaignId || this.campaignId || "");
    if (!campaignId) return json({ error: "campaignId required" }, 400);
    this.campaignId = campaignId;
    // Persist so a fresh instance's alarm() (e.g. after an eviction that
    // happened before this DO ever ran alarm() once) can still recover which
    // campaign it belongs to — see alarm()'s fallback read of this key.
    await this.state.storage.put("campaignId", campaignId);

    switch (body.op) {
      case "kick": return this.opKick(campaignId, body);
      case "pause": return this.opPause(campaignId);
      case "resume": return this.opResume(campaignId);
      case "cancel": return this.opCancel(campaignId);
      case "status": return this.opStatus(campaignId);
      case "onCallEnded": return this.opOnCallEnded(campaignId, body);
      case "reload": return this.opReload(campaignId);
      default: return json({ error: "unknown op" }, 400);
    }
  }

  private async loadCampaign(campaignId: string): Promise<CampaignRow | null> {
    const row = await metaDb(this.env).prepare("SELECT * FROM campaigns WHERE id=?1").bind(campaignId).first<any>();
    return (row as CampaignRow) ?? null;
  }

  private async setStatus(campaignId: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
    const keys = Object.keys(extra);
    const set = ["status=?2"].concat(keys.map((k, i) => `${k}=?${i + 3}`)).join(", ");
    await metaDb(this.env).prepare(`UPDATE campaigns SET ${set} WHERE id=?1`)
      .bind(campaignId, status, ...keys.map((k) => extra[k])).run();
  }

  // ---------------------------------------------------------------------
  // ops
  // ---------------------------------------------------------------------

  /** kick — start/resume the dial loop by scheduling an immediate alarm.
   *  Defensively no-ops if `disabled:true` is passed (the launch route is
   *  expected to have already checked feature flags — this is a belt-and-
   *  braces guard, not the primary gate). */
  private async opKick(campaignId: string, body: any): Promise<Response> {
    if (body.disabled === true) return json({ ok: false, reason: "disabled" });
    await this.state.storage.setAlarm(Date.now());
    return json({ ok: true });
  }

  /** pause — transitional if a call is in flight (no new dials; the in-flight
   *  call is left to finish naturally — cancel() is the one that force-ends
   *  a call). Settles to 'paused' once onCallEnded drains the in-flight set. */
  private async opPause(campaignId: string): Promise<Response> {
    const row = await this.loadCampaign(campaignId);
    if (!row) return json({ error: "campaign not found" }, 404);
    if (["completed", "cancelled"].includes(row.status)) return json({ ok: true, status: row.status });
    const next = this.inFlight.size > 0 ? "pausing" : "paused";
    await this.setStatus(campaignId, next);
    if (next === "pausing") await this.state.storage.setAlarm(Date.now() + DIAL_TICK_MS);
    return json({ ok: true, status: next });
  }

  /** resume — only meaningful from paused/window_wait/out_of_tokens/pausing;
   *  the next alarm tick re-validates window/spend-cap/DID/circuit-breaker
   *  admission from scratch, so a premature resume just gets re-blocked. */
  private async opResume(campaignId: string): Promise<Response> {
    const row = await this.loadCampaign(campaignId);
    if (!row) return json({ error: "campaign not found" }, 404);
    if (["completed", "cancelled", "cancelling"].includes(row.status)) {
      return json({ ok: false, reason: `cannot resume from ${row.status}` }, 409);
    }
    await this.setStatus(campaignId, "running", row.started_at ? {} : { started_at: Date.now() });
    await this.state.storage.setAlarm(Date.now());
    return json({ ok: true, status: "running" });
  }

  /** cancel — transitional 'cancelling' with a 30s wrap cue for any in-flight
   *  call (§6.6), then a forced hangup via the provider. Contacts still
   *  pending are left `pending` (harmless — the campaign is terminal, so
   *  nothing will ever pick them up again). */
  private async opCancel(campaignId: string): Promise<Response> {
    const row = await this.loadCampaign(campaignId);
    if (!row) return json({ error: "campaign not found" }, 404);
    if (["completed", "cancelled"].includes(row.status)) return json({ ok: true, status: row.status });
    if (this.inFlight.size === 0) {
      await this.setStatus(campaignId, "cancelled", { completed_at: Date.now() });
      return json({ ok: true, status: "cancelled" });
    }
    await this.setStatus(campaignId, "cancelling");
    await this.state.storage.put("cancel_wrap_deadline", Date.now() + 30_000);
    await this.state.storage.setAlarm(Date.now() + 30_000);
    return json({ ok: true, status: "cancelling" });
  }

  private async opStatus(campaignId: string): Promise<Response> {
    const row = await this.loadCampaign(campaignId);
    if (!row) return json({ error: "campaign not found" }, 404);
    const cb = this.cbSnapshot();
    return json({
      campaign: row,
      in_flight: [...this.inFlight.entries()].map(([attemptUuid, v]) => ({ attempt_uuid: attemptUuid, ...v })),
      circuit_breaker: cb,
    });
  }

  /** reload — reconstruct from D1 and, if still `running`, resume ticking.
   *  Since this DO keeps no durable business state beyond the circuit
   *  breaker + heartbeat throttle, "reconstruct" is simply: re-read D1 and
   *  kick the loop if appropriate. Safe to call any time (e.g. after a
   *  deploy) as a resync. */
  private async opReload(campaignId: string): Promise<Response> {
    const row = await this.loadCampaign(campaignId);
    if (!row) return json({ error: "campaign not found" }, 404);
    if (row.status === "running" || row.status === "pausing" || row.status === "cancelling") {
      await this.state.storage.setAlarm(Date.now());
    }
    return json({ ok: true, status: row.status });
  }

  /** onCallEnded — webhook-driven settlement (called by the campaign-pstn
   *  route handlers, not by Vobiz directly). The route has already driven
   *  the attempt's TERMINAL outcome transition (answered|no_answer|busy|
   *  machine|failed|canceled) through CallFSM before calling here — this
   *  method only owns the BILLING-LIFECYCLE 'settled' marker (§4), never the
   *  `outcome` column itself. Idempotent: wallet ops are deduped on op_id and
   *  the FSM's 'settled' transition dedupes on an existing fsm_transitions
   *  row, but campaign-counter / contact-status mutation is NOT naturally
   *  idempotent (a bare UPDATE ... SET n_done=n_done+1 double-counts on
   *  redelivery), so it is additionally guarded by a settled-row existence
   *  check below (§4 "duplicate webhooks are idempotent"). */
  private async opOnCallEnded(campaignId: string, body: any): Promise<Response> {
    const attemptUuid = String(body.attempt_uuid || "");
    if (!attemptUuid) return json({ error: "attempt_uuid required" }, 400);
    const outcome = String(body.outcome || "failed");
    const hangupCauseRaw = body.hangup_cause_raw != null ? String(body.hangup_cause_raw) : null;
    const aiDurationS = Math.max(0, Number(body.ai_duration_s) || 0);
    const pstnTotalDurationS = Math.max(0, Number(body.pstn_total_duration_s) || 0);

    const db = metaDb(this.env);
    const attempt = await db.prepare(
      "SELECT attempt_uuid, campaign_id, contact_id, outcome, ended_at, tokens_reserved FROM campaign_call_attempts WHERE attempt_uuid=?1",
    ).bind(attemptUuid).first<any>();
    if (!attempt) return json({ error: "attempt not found" }, 404);

    const row = await this.loadCampaign(campaignId);
    const contact = await db.prepare("SELECT id, name, e164, attempts, status FROM campaign_contacts WHERE id=?1")
      .bind(attempt.contact_id).first<ContactRow>();

    const now = Date.now();

    // Billable tokens are computed from the actual call duration (§5 "AI
    // talk time 6 tokens/min"), not trusted from the webhook body — falls
    // back to ai_duration_s if the PSTN-leg duration wasn't reported. A
    // minimum of 1 token is charged for any attempt that reaches settlement
    // (covers e.g. a machine/answered call with a sub-minute duration).
    const tokensSpent = Math.max(1, Math.ceil((pstnTotalDurationS || aiDurationS || 0) / 60) * 6);

    // Record the terminal facts on the attempt row. `outcome` itself is NOT
    // written here — CallFSM (via the route's applyAttemptTransition call)
    // already owns and persisted that column; re-writing it here would be a
    // second, unaudited writer of the same fact.
    await db.prepare(
      `UPDATE campaign_call_attempts SET ended_at=?2, hangup_cause_raw=?3, ai_duration_s=?4, pstn_total_duration_s=?5, tokens_spent=?6
       WHERE attempt_uuid=?1`,
    ).bind(attemptUuid, now, hangupCauseRaw, aiDurationS, pstnTotalDurationS, tokensSpent).run();

    // ── Idempotency guard (§4 "duplicate webhooks are idempotent") — checked
    // BEFORE this call's own settlement work lands, so it reflects whether a
    // PRIOR call already settled this attempt. Campaign counters / contact
    // status below are NOT self-deduping (a bare `n_done=n_done+1` double-
    // counts on redelivery), unlike the wallet ops and FSM 'settled'
    // transition, which dedupe internally on op_id / an existing
    // fsm_transitions row respectively.
    const priorSettled = await db
      .prepare(`SELECT 1 FROM fsm_transitions WHERE attempt_uuid=?1 AND to_state='settled' LIMIT 1`)
      .bind(attemptUuid)
      .first();
    const isDuplicate = !!priorSettled;

    // ── Wallet settlement (§5 escrow): move the actually-used amount from
    // reserved→spent, then release whatever's left of the 60-token hold.
    // Both idempotent on op_id, so a duplicate onCallEnded is harmless.
    if (row) {
      await walletConsumeReserved(this.env, row.uid, attemptUuid, tokensSpent, `${attemptUuid}:settle`).catch(() => null);
      await walletReleaseReservation(this.env, row.uid, attemptUuid, `${attemptUuid}:release`).catch(() => null);
    }

    // ── Billing-lifecycle marker (§4): 'settled' is audit-only — it never
    // overwrites `outcome` and dedupes internally on an existing
    // fsm_transitions row, so this is safe to call on every (re)delivery.
    await applyAttemptTransition(db, attemptUuid, "settled", {
      trigger: "system",
      patch: { tokens_spent: tokensSpent },
    });

    if (!isDuplicate) {
      const { retryable, terminalStatus } = classifyOutcome(outcome, hangupCauseRaw);
      const policy = parseRetryPolicy(row?.retry_policy ?? null);
      const attemptsSoFar = contact ? Number(contact.attempts) || 0 : 1;
      const willRetry = retryable && attemptsSoFar < policy.maxAttempts;

      let nextContactStatus: string;
      let nextAttemptAt: number | null = null;
      if (willRetry) {
        nextContactStatus = "missed";
        nextAttemptAt = now + policy.backoffMs;
      } else {
        nextContactStatus = terminalStatus;
        nextAttemptAt = null; // NULL never satisfies `next_attempt_at<=now` — permanently done.
      }

      if (contact) {
        await db.prepare(
          "UPDATE campaign_contacts SET status=?2, next_attempt_at=?3, last_outcome=?4, last_called_at=?5 WHERE id=?1",
        ).bind(contact.id, nextContactStatus, nextAttemptAt, outcome, now).run();
      }

      if (row) {
        // ── Campaign counters.
        const counterCol = outcomeCounterColumn(outcome);
        await db.prepare(
          `UPDATE campaigns SET n_done=n_done+1, ${counterCol}=${counterCol}+1, tokens_spent=tokens_spent+?2, seconds_talked=seconds_talked+?3 WHERE id=?1`,
        ).bind(campaignId, tokensSpent, Math.round(aiDurationS)).run();
      }

      // ── Circuit breaker bookkeeping (§6.5).
      this.cbRecord(outcome === "answered", isProviderFailure(hangupCauseRaw));
      const tripped = this.cbCheckAndMaybeTrip();
      if (tripped && row) {
        await this.setStatus(campaignId, "paused");
        void track(this.env, row.uid, "circuit_breaker_tripped", "avatok", {
          campaign_id: campaignId, consecutive_failures: CIRCUIT_BREAKER_CONSECUTIVE,
        });
      }
    }

    // ── Free the DialerGateDO channel this attempt was holding.
    try {
      const gate = this.env.DIALER_GATE.get(this.env.DIALER_GATE.idFromName(row?.uid ?? ""));
      await gate.fetch("https://dialer-gate/op", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "release", campaignId }),
      });
    } catch { /* best-effort — a leaked pool slot self-heals on next DO restart of DialerGateDO */ }

    this.inFlight.delete(attemptUuid);

    // Keep the loop moving — another contact may be dialable right now.
    await this.state.storage.setAlarm(Date.now());
    return json({ ok: true, duplicate: isDuplicate });
  }

  // ---------------------------------------------------------------------
  // alarm() — the dial tick (§6.3)
  // ---------------------------------------------------------------------
  async alarm(): Promise<void> {
    const campaignId = this.campaignId ?? (await this.state.storage.get<string>("campaignId"));
    if (!campaignId) return; // no campaign bound to this DO instance yet
    if (!this.campaignId) { this.campaignId = campaignId; }
    await this.state.storage.put("campaignId", campaignId);

    const row = await this.loadCampaign(campaignId);
    if (!row) return; // campaign row gone — nothing to reconstruct

    if (row.status === "completed" || row.status === "cancelled") return;

    if (row.status === "cancelling") {
      await this.tickCancelling(campaignId, row);
      return;
    }
    if (row.status === "pausing") {
      if (this.inFlight.size === 0) {
        await this.setStatus(campaignId, "paused");
      } else {
        await this.state.storage.setAlarm(Date.now() + DIAL_TICK_MS);
      }
      return;
    }
    if (row.status !== "running") {
      // draft|ready|paused|window_wait|out_of_tokens — nothing to dial. The
      // window_wait re-arm alarm was already scheduled when we entered that
      // state; everything else waits for an explicit kick/resume.
      return;
    }

    // 1) Calling-window admission (server-enforced IST, §6.6/§14).
    const istMin = istMinuteOfDay();
    if (istMin < row.window_start_min || istMin >= row.window_end_min) {
      await this.setStatus(campaignId, "window_wait");
      const nextAlarm = nextIstWindowStart(row.window_start_min);
      await this.state.storage.setAlarm(nextAlarm);
      await this.heartbeat(campaignId, "window_wait", "window", row);
      return;
    }

    // 2) Spend cap admission (§5).
    if (row.tokens_spent >= row.spend_cap_tokens) {
      await this.setStatus(campaignId, "out_of_tokens");
      void track(this.env, row.uid, "dial_denied", "avatok", { campaign_id: campaignId, reason: "spend_cap" });
      await this.heartbeat(campaignId, "out_of_tokens", "wallet", row);
      return; // resumable only via explicit resume() once the owner raises the cap / tops up
    }

    // 3) DID admission.
    if (!row.did_e164) {
      await this.setStatus(campaignId, "paused");
      await this.heartbeat(campaignId, "paused", "provider", row);
      return;
    }
    const did = await metaDb(this.env).prepare("SELECT status FROM user_dids WHERE e164=?1").bind(row.did_e164).first<{ status: string }>();
    if (!did || did.status !== "active") {
      await this.setStatus(campaignId, "paused");
      void track(this.env, row.uid, "dial_denied", "avatok", { campaign_id: campaignId, reason: "did_inactive" });
      await this.heartbeat(campaignId, "paused", "provider", row);
      return;
    }

    // 4) Circuit breaker admission.
    if (this.cbSnapshot().tripped) {
      await this.setStatus(campaignId, "paused");
      await this.heartbeat(campaignId, "paused", "provider", row);
      return;
    }

    // 5) Ask DialerGateDO for a permit.
    const gate = this.env.DIALER_GATE.get(this.env.DIALER_GATE.idFromName(row.uid));
    const permitRes = await gate.fetch("https://dialer-gate/op", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "requestDialPermit", campaignId, didE164: row.did_e164, capacity: row.concurrency }),
    });
    const permit = await permitRes.json().catch(() => ({} as any)) as any;
    if (!permit?.permit) {
      const retryAfterMs = Math.max(250, Number(permit?.retryAfterMs) || 1000);
      await this.state.storage.setAlarm(Date.now() + retryAfterMs);
      void track(this.env, row.uid, "dial_denied", "avatok", { campaign_id: campaignId, reason: permit?.reason ?? "channels" });
      await this.heartbeat(campaignId, "running", permit?.reason === "did_cps" || permit?.reason === "account_cps" ? "cps" : "channels", row);
      return;
    }

    // 6) Permit granted — acquire a contact via the conditional D1 UPDATE
    // race pattern (D1 has no UPDATE...LIMIT, so SELECT 1 then guard the
    // UPDATE on the expected prior status and check changes===1).
    const won = await this.acquireContact(campaignId, Date.now());
    if (!won) {
      // No contact was available right now — release the unused permit.
      await this.releaseGate(row.uid, campaignId);
      const stillOutstanding = await this.contactsRemaining(campaignId);
      if (!stillOutstanding && this.inFlight.size === 0) {
        await this.setStatus(campaignId, "completed", { completed_at: Date.now() });
        void track(this.env, row.uid, "call_completed", "avatok", { campaign_id: campaignId, event: "campaign_completed" });
        return;
      }
      // Either a race was lost (another tick took the last contact) or every
      // remaining contact is `calling` already / not yet due for retry —
      // either way, try again shortly.
      await this.state.storage.setAlarm(Date.now() + DIAL_TICK_MS);
      await this.heartbeat(campaignId, "running", "no_contacts", row);
      return;
    }

    // 7) Won a contact — mint the attempt, reserve tokens, dial.
    await this.dialContact(campaignId, row, won);
  }

  private async tickCancelling(campaignId: string, row: CampaignRow): Promise<void> {
    if (this.inFlight.size === 0) {
      await this.setStatus(campaignId, "cancelled", { completed_at: Date.now() });
      return;
    }
    const deadline = (await this.state.storage.get<number>("cancel_wrap_deadline")) ?? 0;
    if (Date.now() >= deadline) {
      const provider = getTelephonyProvider(this.env, "vobiz");
      for (const [attemptUuid, f] of this.inFlight) {
        try { if (f.callUuid) await provider.hangupCall(f.callUuid); } catch { /* best-effort forced hangup */ }
        void attemptUuid;
      }
      // The forced hangup will land a hangup webhook → onCallEnded drains
      // `inFlight`; give it a short grace window before re-checking.
      await this.state.storage.setAlarm(Date.now() + 5_000);
      return;
    }
    await this.state.storage.setAlarm(deadline);
  }

  // ---------------------------------------------------------------------
  // contact acquisition (race-safe, §6.3 step 2)
  // ---------------------------------------------------------------------
  private async acquireContact(campaignId: string, now: number): Promise<ContactRow | null> {
    const db = metaDb(this.env);
    // Prefer never-tried contacts over due retries, then oldest-due retry first.
    const candidate = await db.prepare(
      `SELECT id, name, e164, attempts, status FROM campaign_contacts
       WHERE campaign_id=?1 AND e164 IS NOT NULL AND (status='pending' OR (status='missed' AND next_attempt_at<=?2))
       ORDER BY (status='pending') DESC, next_attempt_at ASC LIMIT 1`,
    ).bind(campaignId, now).first<ContactRow>();
    if (!candidate) return null;

    const upd = await db.prepare(
      "UPDATE campaign_contacts SET status='dial_reserved' WHERE id=?1 AND status=?2",
    ).bind(candidate.id, candidate.status).run();
    const changes = (upd as any)?.meta?.changes ?? (upd as any)?.changes ?? 0;
    if (Number(changes) !== 1) return null; // lost the race to another tick
    return candidate;
  }

  private async contactsRemaining(campaignId: string): Promise<boolean> {
    const db = metaDb(this.env);
    const r = await db.prepare(
      `SELECT COUNT(*) AS n FROM campaign_contacts
       WHERE campaign_id=?1 AND (
         (e164 IS NOT NULL AND status IN ('pending','dial_reserved','calling'))
         OR (status='missed' AND next_attempt_at IS NOT NULL)
       )`,
    ).bind(campaignId).first<{ n: number }>();
    return Number(r?.n ?? 0) > 0;
  }

  private async releaseGate(uid: string, campaignId: string): Promise<void> {
    try {
      const gate = this.env.DIALER_GATE.get(this.env.DIALER_GATE.idFromName(uid));
      await gate.fetch("https://dialer-gate/op", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "release", campaignId }),
      });
    } catch { /* best-effort */ }
  }

  // ---------------------------------------------------------------------
  // dial (§6.3 steps 2-3, §5 reservation, §1.6 idempotency)
  // ---------------------------------------------------------------------
  private async dialContact(campaignId: string, row: CampaignRow, contact: ContactRow): Promise<void> {
    const db = metaDb(this.env);
    const attemptUuid = crypto.randomUUID();
    const now = Date.now();

    // attempt_uuid minted + persisted BEFORE any network call (§1.6, §6.3 step 2).
    await db.prepare(
      `INSERT INTO campaign_call_attempts
         (attempt_uuid, campaign_id, contact_id, purpose,
          prompt_version, tool_runtime_version, fsm_version, kb_version, analytics_schema_version,
          kb_store_name, created_at, tokens_reserved)
       VALUES (?1,?2,?3,'LIVE', ?4,?5,?6,?7,?8, ?9, ?10, ?11)`,
    ).bind(
      attemptUuid, campaignId, contact.id,
      row.prompt_version, row.tool_runtime_version, row.fsm_version, row.kb_version, row.analytics_schema_version,
      row.kb_store, now, RESERVE_TOKENS,
    ).run();

    const reserve = await walletReserve(this.env, row.uid, RESERVE_TOKENS, attemptUuid, `${attemptUuid}:reserve`);
    if (!reserve.ok) {
      // Insufficient balance — put the contact back, release the permit,
      // stop the campaign for a manual top-up/resume (§5, §6.6 "wallet
      // empty → out_of_tokens, resumable").
      await db.prepare("UPDATE campaign_contacts SET status=?2 WHERE id=?1").bind(contact.id, contact.status).run();
      await db.prepare("DELETE FROM campaign_call_attempts WHERE attempt_uuid=?1").bind(attemptUuid).run();
      await this.releaseGate(row.uid, campaignId);
      await this.setStatus(campaignId, "out_of_tokens");
      void track(this.env, row.uid, "dial_denied", "avatok", { campaign_id: campaignId, reason: "wallet" });
      await this.heartbeat(campaignId, "out_of_tokens", "wallet", row);
      return;
    }

    void track(this.env, row.uid, "dial_permitted", "avatok", { campaign_id: campaignId, attempt_uuid: attemptUuid, contact_id: contact.id });

    const secret = this.env.VOBIZ_WEBHOOK_SECRET || "";
    const answerUrl = `${PUBLIC_BASE}/api/campaign-pstn/answer/${encodeURIComponent(secret)}/${attemptUuid}`;
    const ringUrl = `${PUBLIC_BASE}/api/campaign-pstn/ring/${encodeURIComponent(secret)}/${attemptUuid}`;
    const hangupUrl = `${PUBLIC_BASE}/api/campaign-pstn/hangup/${encodeURIComponent(secret)}/${attemptUuid}`;
    const machineDetectionUrl = `${PUBLIC_BASE}/api/campaign-pstn/amd/${encodeURIComponent(secret)}/${attemptUuid}`;

    const provider = getTelephonyProvider(this.env, "vobiz");
    let callUuid: string | null = null;
    try {
      const r = await provider.makeCall({
        from: row.did_e164!, to: contact.e164!,
        answerUrl, ringUrl, hangupUrl,
        machineDetection: "true", machineDetectionUrl,
        ringTimeoutSec: RING_TIMEOUT_SEC, timeLimitSec: TIME_LIMIT_SEC,
      });
      callUuid = r.callUuid;
    } catch (e) {
      // TODO(call_fsm): §1.6/§6.3 say an uncertain POST (timeout) must be
      // resolved via provider.getCallState(call_uuid) BEFORE any retry —
      // but makeCall throwing means we never got a call_uuid to query, so
      // there is nothing to disambiguate with today. Until VobizProvider (or
      // call_fsm.ts) exposes a "list recent calls to <to>" / idempotency-key
      // based lookup, treat a thrown makeCall as a hard failure: apply the
      // FSM's dial_reserved->failed transition (audited), release the
      // reservation, apply the retry taxonomy like any other failed attempt,
      // and move on. This is the one place this file falls short of the
      // literal §1.6 requirement — flagged for the call_fsm.ts owner.
      await applyAttemptTransition(db, attemptUuid, "failed", {
        trigger: "system",
        patch: { ended_at: Date.now(), hangup_cause_raw: "make_call_error" },
      });
      await walletReleaseReservation(this.env, row.uid, attemptUuid, `${attemptUuid}:release`).catch(() => null);
      const policy = parseRetryPolicy(row.retry_policy);
      const attemptsSoFar = Number(contact.attempts) || 0;
      const willRetry = attemptsSoFar < policy.maxAttempts;
      await db.prepare("UPDATE campaign_contacts SET status=?2, next_attempt_at=?3, last_outcome='failed', attempts=attempts+1 WHERE id=?1")
        .bind(contact.id, willRetry ? "missed" : "failed", willRetry ? Date.now() + policy.backoffMs : null).run();
      await db.prepare("UPDATE campaigns SET n_done=n_done+1, n_failed=n_failed+1 WHERE id=?1").bind(campaignId).run();
      this.cbRecord(false, true);
      const tripped = this.cbCheckAndMaybeTrip();
      await this.releaseGate(row.uid, campaignId);
      if (tripped) {
        await this.setStatus(campaignId, "paused");
        void track(this.env, row.uid, "circuit_breaker_tripped", "avatok", { campaign_id: campaignId });
      } else {
        await this.state.storage.setAlarm(Date.now() + DIAL_TICK_MS);
      }
      return;
    }

    // dial_reserved -> calling (audited FSM transition). The `calling` state
    // is derived purely from `call_uuid` being set (see deriveAttemptState in
    // lib/call_fsm.ts) — ring_at is intentionally NOT stamped here; it is set
    // by the FSM's 'ringing' transition when the ring webhook actually lands
    // (handleRing in routes/campaign_pstn.ts), so a dial that never rings
    // never falsely reports a ring.
    await applyAttemptTransition(db, attemptUuid, "calling", {
      trigger: "system",
      patch: { call_uuid: callUuid },
    });
    await db.prepare("UPDATE campaign_contacts SET status='calling', attempts=attempts+1, last_called_at=?2 WHERE id=?1")
      .bind(contact.id, Date.now()).run();

    this.inFlight.set(attemptUuid, { contactId: contact.id, callUuid, didE164: row.did_e164!, reservedAt: Date.now() });
    void track(this.env, row.uid, "call_started", "avatok", { campaign_id: campaignId, attempt_uuid: attemptUuid, call_uuid: callUuid });

    // Keep dialing while capacity remains — the next tick re-checks every
    // admission gate from scratch (spend cap may have just been hit, etc).
    await this.state.storage.setAlarm(Date.now() + DIAL_TICK_MS);
  }

  // ---------------------------------------------------------------------
  // circuit breaker (§6.5)
  // ---------------------------------------------------------------------
  private cbRecord(answered: boolean, was5xx: boolean): void {
    const now = Date.now();
    const row = this.sql.exec("SELECT consecutive_failures, window_start, window_total, window_5xx, tripped FROM cb WHERE k=1").one() as any;
    let windowStart = Number(row.window_start) || 0;
    let windowTotal = Number(row.window_total) || 0;
    let window5xx = Number(row.window_5xx) || 0;
    if (now - windowStart > CIRCUIT_BREAKER_WINDOW_MS) { windowStart = now; windowTotal = 0; window5xx = 0; }
    windowTotal += 1;
    if (was5xx) window5xx += 1;
    const consecutive = answered ? 0 : (Number(row.consecutive_failures) || 0) + 1;
    this.sql.exec(
      "UPDATE cb SET consecutive_failures=?1, window_start=?2, window_total=?3, window_5xx=?4 WHERE k=1",
      consecutive, windowStart, windowTotal, window5xx,
    );
  }

  private cbCheckAndMaybeTrip(): boolean {
    const row = this.sql.exec("SELECT consecutive_failures, window_total, window_5xx, tripped FROM cb WHERE k=1").one() as any;
    if (Number(row.tripped)) return true;
    const consecutive = Number(row.consecutive_failures) || 0;
    const windowTotal = Number(row.window_total) || 0;
    const window5xx = Number(row.window_5xx) || 0;
    const rate5xx = windowTotal > 0 ? window5xx / windowTotal : 0;
    const trip = consecutive >= CIRCUIT_BREAKER_CONSECUTIVE || (windowTotal >= 5 && rate5xx >= CIRCUIT_BREAKER_5XX_RATE);
    if (trip) this.sql.exec("UPDATE cb SET tripped=1 WHERE k=1");
    return trip;
  }

  private cbSnapshot(): { consecutiveFailures: number; windowTotal: number; window5xx: number; tripped: boolean } {
    const row = this.sql.exec("SELECT consecutive_failures, window_total, window_5xx, tripped FROM cb WHERE k=1").one() as any;
    return {
      consecutiveFailures: Number(row.consecutive_failures) || 0,
      windowTotal: Number(row.window_total) || 0,
      window5xx: Number(row.window_5xx) || 0,
      tripped: !!Number(row.tripped),
    };
  }

  // ---------------------------------------------------------------------
  // heartbeat (§15) — throttled to at most once per HEARTBEAT_MIN_INTERVAL_MS
  // so a hot retry loop (e.g. repeated cps denials) doesn't spam PostHog.
  // ---------------------------------------------------------------------
  private async heartbeat(
    campaignId: string, status: string, blockedReason: string, row: CampaignRow,
  ): Promise<void> {
    const hbRow = this.sql.exec("SELECT last_at FROM hb WHERE k=1").one() as any;
    const now = Date.now();
    if (now - (Number(hbRow.last_at) || 0) < HEARTBEAT_MIN_INTERVAL_MS) return;
    this.sql.exec("UPDATE hb SET last_at=?1 WHERE k=1", now);

    const db = metaDb(this.env);
    const counts = await db.prepare(
      "SELECT status, COUNT(*) AS n FROM campaign_contacts WHERE campaign_id=?1 GROUP BY status",
    ).bind(campaignId).all();
    const byStatus: Record<string, number> = {};
    for (const r of (counts.results ?? []) as any[]) byStatus[String(r.status)] = Number(r.n);
    const nextAlarm = await this.state.storage.getAlarm();

    void track(this.env, row.uid, "campaign_heartbeat", "avatok", {
      campaign_id: campaignId,
      status,
      blocked_reason: blockedReason,
      pending: (byStatus["pending"] ?? 0) + (byStatus["missed"] ?? 0),
      calling: byStatus["calling"] ?? 0,
      available_channels: row.concurrency,
      next_alarm_at: nextAlarm ?? null,
    });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Current minute-of-day in IST (UTC+5:30), server-enforced calling window
 *  (§6.6, §14 — stricter than TRAI's 10-21, this is the campaign's own
 *  configurable 10:00-19:00 default). */
function istMinuteOfDay(now = Date.now()): number {
  const istMs = now + IST_OFFSET_MIN * 60_000;
  const d = new Date(istMs);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Epoch ms of the next time IST minute-of-day hits `windowStartMin` (today
 *  if it hasn't passed yet in IST, else tomorrow). */
function nextIstWindowStart(windowStartMin: number, now = Date.now()): number {
  const istMs = now + IST_OFFSET_MIN * 60_000;
  const istDate = new Date(istMs);
  const todayIstMidnightUtcMs = Date.UTC(istDate.getUTCFullYear(), istDate.getUTCMonth(), istDate.getUTCDate());
  const curMin = istDate.getUTCHours() * 60 + istDate.getUTCMinutes();
  const targetDayOffset = curMin < windowStartMin ? 0 : 1;
  const targetIstMs = todayIstMidnightUtcMs + (targetDayOffset * MIN_PER_DAY + windowStartMin) * 60_000;
  return targetIstMs - IST_OFFSET_MIN * 60_000; // back to real UTC epoch ms
}

function parseRetryPolicy(policyJson: string | null): RetryPolicy {
  try {
    const p = policyJson ? JSON.parse(policyJson) : {};
    return {
      maxAttempts: Number.isFinite(Number(p.maxAttempts)) && Number(p.maxAttempts) > 0 ? Number(p.maxAttempts) : MAX_ATTEMPTS_DEFAULT,
      backoffMs: Number.isFinite(Number(p.backoffMin)) && Number(p.backoffMin) > 0 ? Number(p.backoffMin) * 60_000 : RETRY_BACKOFF_MS,
    };
  } catch {
    return { maxAttempts: MAX_ATTEMPTS_DEFAULT, backoffMs: RETRY_BACKOFF_MS };
  }
}

/** §6.4 retry taxonomy, applied to the raw provider hangup cause + our own
 *  outcome classification. `terminalStatus` is what campaign_contacts.status
 *  becomes if `retryable` is false OR retries are exhausted. */
function classifyOutcome(outcome: string, hangupCauseRaw: string | null): { retryable: boolean; terminalStatus: string } {
  const cause = (hangupCauseRaw || "").toUpperCase();
  if (outcome === "answered") return { retryable: false, terminalStatus: "done" };
  if (outcome === "machine") return { retryable: false, terminalStatus: "voicemail" }; // silent-hangup default (§6.4)
  if (outcome === "canceled") return { retryable: false, terminalStatus: "failed" };
  if (cause.includes("DND") || cause.includes("SUPPRESS")) return { retryable: false, terminalStatus: "dnd_blocked" };
  if (cause === "UNALLOCATED" || cause.includes("INVALID") || cause.includes("UNASSIGNED")) {
    return { retryable: false, terminalStatus: "invalid" };
  }
  if (cause === "CALL_REJECTED" || cause.includes("REJECT")) return { retryable: false, terminalStatus: "failed" };
  if (outcome === "busy" || cause.includes("USER_BUSY") || cause.includes("BUSY")) {
    return { retryable: true, terminalStatus: "busy" };
  }
  if (outcome === "no_answer" || cause.includes("NO_ANSWER") || cause.includes("NOANSWER")) {
    return { retryable: true, terminalStatus: "missed" };
  }
  // Anything else we treat as a recoverable network/5xx/congestion failure.
  return { retryable: true, terminalStatus: "failed" };
}

/** §6.5's "≥50% provider 5xx" — a coarse classifier over the raw cause since
 *  Vobiz's cause strings aren't literally HTTP status codes. */
function isProviderFailure(hangupCauseRaw: string | null): boolean {
  const cause = (hangupCauseRaw || "").toUpperCase();
  return cause.includes("5") && (cause.includes("ERROR") || cause.includes("SERVER") || cause.includes("CONGEST"))
    || cause.includes("PROVIDER") || cause.includes("TIMEOUT") || cause.startsWith("MAKECALL_ERROR");
}

function outcomeCounterColumn(outcome: string): "n_answered" | "n_missed" | "n_busy" | "n_machine" | "n_failed" | "n_dnc" {
  switch (outcome) {
    case "answered": return "n_answered";
    case "busy": return "n_busy";
    case "machine": return "n_machine";
    case "no_answer": return "n_missed";
    default: return "n_failed";
  }
}

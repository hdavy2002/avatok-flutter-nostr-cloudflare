// Provider-neutral connected-time authority for one Messenger authorization.
//
// One SQLite-backed DO is keyed by authorization_id. D1 freezes the contract,
// WalletDO owns allowance/balance arithmetic, and this DO owns the serialized
// provider-presence interval. It never trusts provider/rate/payer data from a
// client: init is called only by the already-authorized Worker path and Stream
// lifecycle events arrive only after the signed webhook adapter verifies them.

import type { Env } from "../types";
import { json } from "../util";
import { track } from "../hooks";
import {
  consumeMessengerCallUsage,
  messengerCallReservationStatus,
  reserveMessengerCall,
  releaseMessengerCallReservation,
} from "../routes/wallet";
import { readConfig } from "../routes/config";
import type { MessengerMedia, MessengerQualitySku } from "../lib/messenger_call_billing";

const TICK_MS = 15_000;
const MAX_ID = 256;
const MAX_UID = 128;

type BillingStatus = "authorized" | "connected" | "funds_exhausted" | "finalizing" | "ended" | "reconciliation_pending";
type BillingEventKind = "joined" | "left" | "session_ended";

export interface MessengerCallBillingAuthorizationSnapshot {
  authorization_id: string;
  call_id: string;
  attempt_id: string;
  payer_uid: string;
  callee_uid: string;
  media: MessengerMedia;
  quality_sku: MessengerQualitySku;
  provider: "cloudflare" | "stream";
  rate_centitokens_per_participant_minute: number;
  price_version: number;
  daily_audio_allowance_participant_seconds: number;
  allowance_day: string | null;
  reservation_ref: string | null;
  expires_at: number;
}

export interface MessengerStreamBillingEvent {
  authorization_id: string;
  call_id: string;
  event_id: string;
  kind: BillingEventKind;
  participant_uid?: string | null;
  generation?: string | null;
  occurred_at_ms?: number;
  ending_reason?: string;
}

interface BillingStateRow {
  authorization_id: string;
  call_id: string;
  attempt_id: string;
  payer_uid: string;
  callee_uid: string;
  media: MessengerMedia;
  quality_sku: MessengerQualitySku;
  provider: "cloudflare" | "stream";
  rate_centitokens_per_participant_minute: number;
  price_version: number;
  daily_audio_allowance_participant_seconds: number;
  allowance_day: string | null;
  reservation_ref: string | null;
  expires_at: number;
  status: BillingStatus;
  generation: string;
  last_metered_ms: number | null;
  connected_since_ms: number | null;
  connected_wall_seconds: number;
  participant_seconds: number;
  free_participant_seconds: number;
  paid_participant_seconds: number;
  charged_centitoken_seconds: number;
  tokens_charged: number;
  ending_reason: string | null;
  reserved_tokens: number;
  low_balance_notified: number;
  last_renewal_slot: number;
}

interface ParticipantRow {
  uid: string;
  present: number;
  generation: string;
  joined_at_ms: number;
  last_event_at_ms: number;
}

function text(value: unknown, max = MAX_ID): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function uid(value: unknown): string {
  const out = text(value, MAX_UID);
  return /^[A-Za-z0-9_:@.-]+$/.test(out) ? out : "";
}

function positiveMs(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function validSnapshot(input: unknown): input is MessengerCallBillingAuthorizationSnapshot {
  const b = input as Partial<MessengerCallBillingAuthorizationSnapshot> | null;
  // Keep the explicit media guard visible: video and paid audio are Stream;
  // only zero-rate free audio is accepted with the Cloudflare provider below.
  const mediaIsVideo = !!b && b.media === "video";
  const video = b?.media === "video" &&
    (b.quality_sku === "video_sd" || b.quality_sku === "video_hd" || b.quality_sku === "video_2k" || b.quality_sku === "video_4k") &&
    b.provider === "stream";
  const audio = b?.media === "audio" && b.quality_sku === "audio" &&
    ((b.provider === "cloudflare" && b.rate_centitokens_per_participant_minute === 0 && (b.reservation_ref === null || b.reservation_ref === undefined)) ||
      (b.provider === "stream" && Number.isInteger(b.rate_centitokens_per_participant_minute) && b.rate_centitokens_per_participant_minute > 0 && text(b.reservation_ref) !== ""));
  return !!b && (mediaIsVideo || b.media === "audio") && text(b.authorization_id) !== "" && text(b.call_id) !== "" && text(b.attempt_id) !== "" &&
    uid(b.payer_uid) !== "" && uid(b.callee_uid) !== "" && b.payer_uid !== b.callee_uid &&
    (audio || video) && Number.isInteger(b.rate_centitokens_per_participant_minute) && b.rate_centitokens_per_participant_minute >= 0 &&
    (b.media !== "audio" || (b.provider === "cloudflare" ? (b.rate_centitokens_per_participant_minute === 0 && (b.reservation_ref === null || b.reservation_ref === undefined)) : b.rate_centitokens_per_participant_minute > 0 && text(b.reservation_ref) !== "")) &&
    Number.isInteger(b.price_version) && b.price_version >= 1 &&
    Number.isInteger(b.daily_audio_allowance_participant_seconds) && b.daily_audio_allowance_participant_seconds >= 0 &&
    (b.allowance_day === null || b.allowance_day === undefined || /^\d{4}-\d{2}-\d{2}$/.test(b.allowance_day)) &&
    (b.reservation_ref === null || b.reservation_ref === undefined || text(b.reservation_ref) !== "") &&
    Number.isFinite(b.expires_at);
}

export class MessengerCallBillingDO {
  private readonly env: Env;
  private readonly state: DurableObjectState;
  private readonly sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.state = state;
    this.sql = state.storage.sql;
    // Schema-only initialization. No network or other external I/O is held in
    // blockConcurrencyWhile; each request persists its transition before await.
    void state.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS billing_state (
        k INTEGER PRIMARY KEY CHECK (k=1), authorization_id TEXT NOT NULL UNIQUE,
        call_id TEXT NOT NULL UNIQUE, attempt_id TEXT NOT NULL, payer_uid TEXT NOT NULL, callee_uid TEXT NOT NULL,
        media TEXT NOT NULL, quality_sku TEXT NOT NULL, provider TEXT NOT NULL,
        rate_centitokens_per_participant_minute INTEGER NOT NULL, price_version INTEGER NOT NULL,
        allowance_day TEXT, reservation_ref TEXT, expires_at INTEGER NOT NULL,
        daily_audio_allowance_participant_seconds INTEGER NOT NULL DEFAULT 28800,
        status TEXT NOT NULL, generation TEXT NOT NULL DEFAULT '', last_metered_ms INTEGER,
        connected_since_ms INTEGER, connected_wall_seconds INTEGER NOT NULL DEFAULT 0,
        participant_seconds INTEGER NOT NULL DEFAULT 0, free_participant_seconds INTEGER NOT NULL DEFAULT 0,
        paid_participant_seconds INTEGER NOT NULL DEFAULT 0, charged_centitoken_seconds INTEGER NOT NULL DEFAULT 0,
        tokens_charged INTEGER NOT NULL DEFAULT 0, ending_reason TEXT,
        reserved_tokens INTEGER NOT NULL DEFAULT 0, low_balance_notified INTEGER NOT NULL DEFAULT 0,
        last_renewal_slot INTEGER NOT NULL DEFAULT -1
      )`);
      try { this.sql.exec("ALTER TABLE billing_state ADD COLUMN reserved_tokens INTEGER NOT NULL DEFAULT 0"); } catch { /* existing schema */ }
      try { this.sql.exec("ALTER TABLE billing_state ADD COLUMN low_balance_notified INTEGER NOT NULL DEFAULT 0"); } catch { /* existing schema */ }
      try { this.sql.exec("ALTER TABLE billing_state ADD COLUMN last_renewal_slot INTEGER NOT NULL DEFAULT -1"); } catch { /* existing schema */ }
      try { this.sql.exec("ALTER TABLE billing_state ADD COLUMN attempt_id TEXT NOT NULL DEFAULT ''"); } catch { /* existing schema */ }
      this.sql.exec(`CREATE TABLE IF NOT EXISTS billing_participants (
        uid TEXT PRIMARY KEY, present INTEGER NOT NULL DEFAULT 0,
        generation TEXT NOT NULL DEFAULT '', joined_at_ms INTEGER NOT NULL DEFAULT 0,
        last_event_at_ms INTEGER NOT NULL DEFAULT 0
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS billing_events (
        event_id TEXT PRIMARY KEY, kind TEXT NOT NULL, participant_uid TEXT,
        generation TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', received_at_ms INTEGER NOT NULL
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS billing_ticks (
        tick_id TEXT PRIMARY KEY, interval_start_ms INTEGER NOT NULL, interval_end_ms INTEGER NOT NULL,
        participant_seconds INTEGER NOT NULL, free_participant_seconds INTEGER NOT NULL,
        paid_participant_seconds INTEGER NOT NULL, charged_centitoken_seconds INTEGER NOT NULL,
        tokens_charged INTEGER NOT NULL, ledger_status TEXT NOT NULL DEFAULT 'pending'
      )`);
    });
  }

  async fetch(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try { body = await request.json() as Record<string, unknown>; } catch { return json({ error: "bad json" }, 400); }
    try {
      switch (body.op) {
        case "init": return await this.init(body.snapshot);
        case "stream_event": return await this.streamEvent(body);
        case "media_event": return await this.providerEvent(body);
        case "finalize": return await this.finalizeCall(body);
        case "reconcile": return await this.reconcile(body);
        case "status": return json({ ok: true, state: this.readState() });
        default: return json({ error: "unknown billing operation" }, 400);
      }
    } catch (error) {
      await this.markReconciliationPending("do_exception");
      return json({ ok: false, error: error instanceof Error ? error.message : "billing authority unavailable" }, 503);
    }
  }

  async alarm(): Promise<void> {
    const row = this.readState();
    if (!row || (row.status !== "connected" && row.status !== "authorized")) return;
    const now = Date.now();
    const result = await this.meterAt(now);
    const metered = this.readState();
    if (result.ok && metered?.status === "connected") {
      const runway = await this.ensureReservationRunway(metered, now);
      if (!runway.ok) return;
      if (this.readState()?.status === "connected") await this.armAlarm(Date.now() + TICK_MS);
    }
  }

  private readState(): BillingStateRow | null {
    const row = this.sql.exec("SELECT * FROM billing_state WHERE k=1").toArray()[0] as BillingStateRow | undefined;
    return row ?? null;
  }

  private readParticipant(participantUid: string): ParticipantRow | null {
    const row = this.sql.exec("SELECT uid,present,generation,joined_at_ms,last_event_at_ms FROM billing_participants WHERE uid=?1", participantUid).toArray()[0] as ParticipantRow | undefined;
    return row ?? null;
  }

  private bothPresent(row: BillingStateRow): boolean {
    const a = this.readParticipant(row.payer_uid);
    const b = this.readParticipant(row.callee_uid);
    return !!a && !!b && a.present === 1 && b.present === 1 && a.generation === row.generation && b.generation === row.generation;
  }

  private emitBillingTelemetry(row: BillingStateRow, event: string, props: Record<string, unknown> = {}): void {
    // Billing truth is local SQL/WalletDO state. Queue telemetry is diagnostic
    // only and must never extend the critical path or turn a queue outage into
    // a billing failure.
    void track(this.env, row.payer_uid, event, "avatok", {
      authorization_id: row.authorization_id, call_id: row.call_id, attempt_id: row.attempt_id, provider: row.provider,
      media: row.media, quality_sku: row.quality_sku, price_version: row.price_version,
      ...props,
    }).catch(() => undefined);
  }

  private async notifyBillingState(row: BillingStateRow, type: "billing_low_balance" | "billing_renewal_failed" | "billing_exhausted", props: Record<string, unknown> = {}): Promise<void> {
    if (row.provider === "cloudflare") {
      try {
        const room = this.env.CALL_ROOMS.get(this.env.CALL_ROOMS.idFromName(row.call_id));
        await room.fetch("https://call-room/billing-update", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ callId: row.call_id, type, ...props }),
        });
      } catch {
        // A failed client update is telemetry/control uncertainty; callers that
        // need teardown still use endProviderCall and retain the reservation.
      }
    }
    this.emitBillingTelemetry(row, type === "billing_low_balance" ? "messenger_call_low_balance" :
      type === "billing_renewal_failed" ? "messenger_call_renewal_failed" : "messenger_call_funds_exhausted", props);
  }

  private async ensureReservationRunway(row: BillingStateRow, now: number): Promise<{ ok: boolean }> {
    // Only paid Stream calls hold/renew caller funds. Free Cloudflare audio
    // has no reservation and ends at the allowance boundary.
    if (row.provider !== "stream" || !row.reservation_ref || row.status !== "connected") return { ok: true };
    const config = await readConfig(this.env).catch(() => null);
    if (!config) {
      await this.handleRenewalFailure(row, "renewal_config_unavailable");
      return { ok: false };
    }
    const reservation = await messengerCallReservationStatus(this.env, row.payer_uid, row.reservation_ref).catch(() => ({ ok: false, status: 503, body: {} }));
    if (!reservation.ok) {
      await this.handleRenewalFailure(row, "renewal_status_unavailable");
      return { ok: false };
    }
    const body = reservation.body as Record<string, unknown>;
    const reservedTokens = Math.max(0, Math.trunc(Number(body.reserved_tokens ?? 0)));
    const expiresAt = Math.max(0, Math.trunc(Number(body.expires_at ?? 0)));
    this.sql.exec("UPDATE billing_state SET reserved_tokens=?1 WHERE k=1", reservedTokens);
    const rate = Math.max(0, Math.trunc(row.rate_centitokens_per_participant_minute));
    if (rate <= 0) return { ok: true };
    const reservationWallSeconds = Math.max(1, Math.trunc(config.messengerCallReservationWallSeconds));
    const warningWallSeconds = Math.max(1, Math.trunc(config.messengerCallLowBalanceWarningWallSeconds));
    const remainingWallSeconds = Math.floor(reservedTokens * 6000 / (rate * 2));
    if (remainingWallSeconds > warningWallSeconds) {
      this.sql.exec("UPDATE billing_state SET low_balance_notified=0 WHERE k=1");
      return { ok: true };
    }
    const updated = this.readState() ?? row;
    // One renewal targets at least the warning runway plus one second. This
    // avoids a repeated top-up loop when an operator configures the warning
    // window larger than the normal reservation window.
    const targetSeconds = Math.max(reservationWallSeconds, warningWallSeconds + 1);
    const topUpSeconds = Math.max(1, targetSeconds - remainingWallSeconds);
    const topUpTokens = Math.max(1, Math.ceil(rate * topUpSeconds * 2 / 6000));
    // Use a fixed UTC-minute id rather than the remotely-configured runway as
    // the idempotency window. A config change must not turn the same renewal
    // attempt into a second hold after a DO restart.
    const slot = Math.floor(now / 60_000);
    if (updated.last_renewal_slot === slot) return { ok: true };
    this.sql.exec("UPDATE billing_state SET last_renewal_slot=?1 WHERE k=1", slot);
    const renewedExpiresAt = Math.max(expiresAt, now + targetSeconds * 1000);
    const renewed = await reserveMessengerCall(this.env, row.payer_uid, topUpTokens, row.reservation_ref,
      `${row.authorization_id}:renew:${slot}`, renewedExpiresAt).catch(() => ({ ok: false, status: 503, body: {} }));
    if (!renewed.ok) {
      if (updated.low_balance_notified === 0) {
        await this.notifyBillingState(updated, "billing_low_balance", {
          low_balance: true, warning: true, reserved_tokens: reservedTokens,
          remaining_paid_wall_seconds: remainingWallSeconds,
          renewal_funding_failed: true,
        });
        this.sql.exec("UPDATE billing_state SET low_balance_notified=1 WHERE k=1");
      }
      await this.handleRenewalFailure(row, "renewal_failed");
      return { ok: false };
    }
    const totalReserved = Math.max(0, Math.trunc(Number(renewed.body?.reservedTotal ?? reservedTokens + topUpTokens)));
    this.sql.exec("UPDATE billing_state SET reserved_tokens=?1, low_balance_notified=0 WHERE k=1", totalReserved);
    try {
      await this.env.DB_WALLET.prepare("UPDATE messenger_call_authorizations SET reservation_tokens=?1, expires_at=MAX(expires_at,?2) WHERE authorization_id=?3 AND status='connected'")
        .bind(totalReserved, renewedExpiresAt, row.authorization_id).run();
    } catch {
      await this.handleRenewalFailure(row, "renewal_authorization_sync_failed");
      return { ok: false };
    }
    const postRenewRemainingWallSeconds = Math.floor(totalReserved * 6000 / (rate * 2));
    if (postRenewRemainingWallSeconds <= warningWallSeconds) {
      const afterRenew = this.readState() ?? row;
      if (afterRenew.low_balance_notified === 0) {
        await this.notifyBillingState(afterRenew, "billing_low_balance", {
          low_balance: true, warning: true, reserved_tokens: totalReserved,
          remaining_paid_wall_seconds: postRenewRemainingWallSeconds,
          renewal_funding_partial: true,
        });
        this.sql.exec("UPDATE billing_state SET low_balance_notified=1 WHERE k=1");
      }
    }
    this.emitBillingTelemetry(row, "messenger_call_reservation_result", {
      reservation_action: "renewal", reservation_tokens: topUpTokens,
      reserved_tokens: totalReserved, renewal_slot: slot,
    });
    return { ok: true };
  }

  private async handleRenewalFailure(row: BillingStateRow, reason: string): Promise<void> {
    await this.notifyBillingState(row, "billing_renewal_failed", {
      renewal_failed: true, reason, low_balance: true,
      reserved_tokens: row.reserved_tokens,
    });
    const providerEnded = await this.endProviderCall(row.call_id);
    if (!providerEnded) {
      await this.markReconciliationPending(`provider_end_after_${reason}`);
      return;
    }
    const closed = await this.meterAt(Date.now());
    if (!closed.ok) {
      if (this.readState()?.status === "ended") return;
      await this.markReconciliationPending(closed.error || "renewal_settlement_failed");
      return;
    }
    this.sql.exec("UPDATE billing_state SET status='funds_exhausted', ending_reason=?1 WHERE k=1", reason);
    await this.markD1FundsExhausted(row);
    await this.notifyBillingState(this.readState() ?? row, "billing_exhausted", {
      funds_exhausted: true, reason, low_balance: true,
    });
    const finalized = await this.finalizeInternal(reason, Date.now());
    if (!finalized.ok) await this.markReconciliationPending(finalized.error || "renewal_finalization_failed");
  }

  private async init(snapshot: unknown): Promise<Response> {
    if (!validSnapshot(snapshot)) return json({ ok: false, error: "invalid authorization snapshot" }, 400);
    const existing = this.readState();
    if (existing) {
      const same = existing.authorization_id === snapshot.authorization_id && existing.call_id === snapshot.call_id && existing.attempt_id === snapshot.attempt_id &&
        existing.payer_uid === snapshot.payer_uid && existing.callee_uid === snapshot.callee_uid &&
        existing.media === snapshot.media && existing.quality_sku === snapshot.quality_sku &&
        existing.provider === snapshot.provider && existing.rate_centitokens_per_participant_minute === snapshot.rate_centitokens_per_participant_minute &&
        existing.price_version === snapshot.price_version &&
        existing.allowance_day === (snapshot.allowance_day ?? null) &&
        existing.reservation_ref === (snapshot.reservation_ref ?? null) &&
        existing.expires_at === snapshot.expires_at &&
        existing.daily_audio_allowance_participant_seconds === snapshot.daily_audio_allowance_participant_seconds;
      return same ? json({ ok: true, idempotent: true, status: existing.status }) : json({ ok: false, error: "authorization snapshot mismatch" }, 409);
    }
    this.sql.exec("INSERT INTO billing_state (k,authorization_id,call_id,attempt_id,payer_uid,callee_uid,media,quality_sku,provider,rate_centitokens_per_participant_minute,price_version,allowance_day,reservation_ref,expires_at,daily_audio_allowance_participant_seconds,status) VALUES (1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'authorized')",
      snapshot.authorization_id, snapshot.call_id, snapshot.attempt_id, snapshot.payer_uid, snapshot.callee_uid, snapshot.media, snapshot.quality_sku, snapshot.provider,
      snapshot.rate_centitokens_per_participant_minute, snapshot.price_version, snapshot.allowance_day ?? null, snapshot.reservation_ref ?? null, snapshot.expires_at,
      snapshot.daily_audio_allowance_participant_seconds);
    this.sql.exec("INSERT OR IGNORE INTO billing_participants (uid) VALUES (?1), (?2)", snapshot.payer_uid, snapshot.callee_uid);
    return json({ ok: true, status: "authorized" });
  }

  private async streamEvent(body: Record<string, unknown>): Promise<Response> {
    const row = this.readState();
    if (!row) return json({ ok: false, error: "billing authorization not initialized" }, 409);
    const eventId = text(body.event_id);
    const callId = text(body.call_id);
    const authId = text(body.authorization_id);
    const kind = body.kind === "joined" || body.kind === "left" || body.kind === "session_ended" ? body.kind as BillingEventKind : null;
    const participantUid = body.participant_uid == null ? "" : uid(body.participant_uid);
    const generation = text(body.generation || "default", 128) || "default";
    const occurredAt = positiveMs(body.occurred_at_ms, Date.now());
    if (!eventId || !callId || !authId || !kind || callId !== row.call_id || authId !== row.authorization_id || eventId.length > MAX_ID) {
      return json({ ok: false, error: "invalid provider billing event" }, 400);
    }
    if (kind !== "session_ended" && participantUid !== row.payer_uid && participantUid !== row.callee_uid) {
      return json({ ok: false, error: "unauthorized provider participant" }, 403);
    }
    const priorEvent = this.sql.exec("SELECT status FROM billing_events WHERE event_id=?1", eventId).toArray()[0] as { status?: string } | undefined;
    if (priorEvent?.status === "applied") return json({ ok: true, duplicate: true, status: row.status });
    if (!priorEvent) {
      this.sql.exec("INSERT OR IGNORE INTO billing_events (event_id,kind,participant_uid,generation,occurred_at_ms,status,received_at_ms) VALUES (?1,?2,?3,?4,?5,'pending',?6)",
        eventId, kind, participantUid || null, generation, occurredAt, Date.now());
    }
    if (row.status === "ended") {
      this.sql.exec("UPDATE billing_events SET status='applied' WHERE event_id=?1", eventId);
      return json({ ok: true, duplicate: true, status: row.status });
    }
    if (kind === "session_ended") {
      const finalized = await this.finalizeInternal(text(body.ending_reason, 128) || "session_ended", occurredAt);
      if (!finalized.ok) return json(finalized, finalized.status ?? 503);
      this.sql.exec("UPDATE billing_events SET status='applied' WHERE event_id=?1", eventId);
      return json(finalized);
    }
    // Events from an older provider session are stale after a reconnect joined
    // a new generation. The provider session id is the primary discriminator;
    // occurred_at protects against a late old join arriving after the new one.
    const payerParticipant = this.readParticipant(row.payer_uid);
    const calleeParticipant = this.readParticipant(row.callee_uid);
    const latestParticipantEvent = Math.max(payerParticipant?.last_event_at_ms ?? 0, calleeParticipant?.last_event_at_ms ?? 0);
    if (row.generation && ((generation === row.generation && occurredAt < latestParticipantEvent) ||
      (generation !== row.generation && (kind === "left" || occurredAt < latestParticipantEvent)))) {
      this.sql.exec("UPDATE billing_events SET status='applied' WHERE event_id=?1", eventId);
      return json({ ok: true, stale_generation: true, status: row.status });
    }
    const metered = await this.meterAt(occurredAt);
    if (!metered.ok) return json({ ok: false, error: metered.error, reconciliation_pending: metered.reconciliation_pending, disconnect: metered.disconnect, provider_ended: metered.provider_ended }, 503);
    if (kind === "joined" && generation !== row.generation) {
      this.sql.exec("UPDATE billing_state SET generation=?1, status=CASE WHEN status='authorized' THEN 'authorized' ELSE status END, connected_since_ms=NULL, last_metered_ms=NULL WHERE k=1", generation);
      this.sql.exec("UPDATE billing_participants SET present=0, generation=?1 WHERE uid IN (?2,?3)", generation, row.payer_uid, row.callee_uid);
    }
    const latest = this.readState();
    if (!latest) return json({ ok: false, error: "billing state disappeared" }, 503);
    const generationToUse = latest.generation || generation;
    this.sql.exec("UPDATE billing_participants SET present=?1, generation=?2, joined_at_ms=CASE WHEN ?1=1 THEN ?3 ELSE joined_at_ms END, last_event_at_ms=?3 WHERE uid=?4",
      kind === "joined" ? 1 : 0, generationToUse, occurredAt, participantUid);
    const after = this.readState();
    if (!after) return json({ ok: false, error: "billing state disappeared" }, 503);
    const nowBoth = this.bothPresent(after);
    const canConnect = after.status === "authorized" || after.status === "connected";
    if (nowBoth && canConnect) {
      const p = this.readParticipant(after.payer_uid);
      const c = this.readParticipant(after.callee_uid);
      const start = Math.max(p?.joined_at_ms ?? occurredAt, c?.joined_at_ms ?? occurredAt);
      this.sql.exec("UPDATE billing_state SET status='connected', connected_since_ms=COALESCE(connected_since_ms,?1), last_metered_ms=COALESCE(last_metered_ms,?1) WHERE k=1 AND status IN ('authorized','connected')", start);
      try {
        await this.env.DB_WALLET.prepare("UPDATE messenger_call_authorizations SET status='connected', connected_at=COALESCE(connected_at,?1) WHERE authorization_id=?2 AND status IN ('authorized','connected')").bind(start, row.authorization_id).run();
      } catch {
        await this.markReconciliationPending("authorization_connected_sync_failed");
        return json({ ok: false, error: "authorization_connected_sync_failed", reconciliation_pending: true }, 503);
      }
      this.emitBillingTelemetry(after, "messenger_call_connected", {
        connected_at_ms: start, generation: generationToUse,
        participant_count: 2,
      });
      this.emitBillingTelemetry(after, "messenger_call_quality_observed", {
        requested_quality_sku: after.quality_sku, quality_source: "authorization_snapshot",
      });
      await this.armAlarm(Date.now() + TICK_MS);
    } else if (kind === "left" || (nowBoth && !canConnect)) {
      this.sql.exec("UPDATE billing_state SET status=CASE WHEN status='connected' THEN 'authorized' ELSE status END, connected_since_ms=NULL, last_metered_ms=NULL WHERE k=1");
      await this.state.storage.deleteAlarm();
    }
    this.sql.exec("UPDATE billing_events SET status='applied' WHERE event_id=?1", eventId);
    return json({ ok: true, status: this.readState()?.status, both_present: nowBoth });
  }

  // Cloudflare audio uses the same provider-neutral state transition. Keeping
  // a separate operation name prevents a future Stream webhook from becoming
  // an audio admission path while preserving the old test/telemetry boundary.
  private async providerEvent(body: Record<string, unknown>): Promise<Response> {
    return this.streamEvent(body);
  }

  private async endProviderCall(callId: string, reason = "insufficient_balance"): Promise<boolean> {
    const current = this.readState();
    // Cloudflare audio is terminated by the CallRoom authority. There is no
    // remote provider API to compensate, and returning true here means the
    // caller's confirmed CallRoom teardown can settle immediately.
    if (current?.provider === "cloudflare") {
      try {
        const room = this.env.CALL_ROOMS.get(this.env.CALL_ROOMS.idFromName(callId));
        const response = await room.fetch("https://call-room/billing-exhausted", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ callId, reason }),
        });
        return response.ok;
      } catch { return false; }
    }
    if (!this.env.STREAM_VIDEO_API_KEY || !this.env.STREAM_VIDEO_API_SECRET) return false;
    const header = (value: string | Uint8Array): string => {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    };
    const hmac = async (data: string): Promise<string> => {
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(this.env.STREAM_VIDEO_API_SECRET as string), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
      return header(sig);
    };
    const now = Math.floor(Date.now() / 1000);
    const jwtHeader = header(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const jwtBody = header(JSON.stringify({ server: true, iat: now, exp: now + 900 }));
    const token = `${jwtHeader}.${jwtBody}.${await hmac(`${jwtHeader}.${jwtBody}`)}`;
    const url = `https://video.stream-io-api.com/api/v2/video/call/default/${encodeURIComponent(callId)}/mark_ended?api_key=${encodeURIComponent(this.env.STREAM_VIDEO_API_KEY)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2_000);
        const response = await fetch(url, { method: "POST", headers: { Authorization: token, "stream-auth-type": "jwt" }, signal: controller.signal });
        clearTimeout(timer);
        if (response.ok || response.status === 404) return true;
      } catch { /* retry; uncertainty retains the reservation */ }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 100));
    }
    return false;
  }

  private async markD1FundsExhausted(row: BillingStateRow, reason = "insufficient_balance"): Promise<void> {
    await this.env.DB_WALLET.prepare("UPDATE messenger_call_authorizations SET status='funds_exhausted', terminal_reason=?1 WHERE authorization_id=?2 AND status IN ('authorized','connected')").bind(reason, row.authorization_id).run();
  }

  private async meterAt(atMs: number): Promise<{ ok: boolean; error?: string; reconciliation_pending?: boolean; disconnect?: boolean; provider_ended?: boolean }> {
    const row = this.readState();
    if (!row || row.status === "reconciliation_pending" || row.status === "ended" || row.status === "finalizing" || row.status === "funds_exhausted") return { ok: row?.status !== "reconciliation_pending" };
    // Both providers use this authority, but only Stream paid audio/video has
    // a reservation. Cloudflare is the free-audio lane and WalletDO will end
    // it exactly when the daily allowance is exhausted.
    if (row.provider !== "stream" && row.provider !== "cloudflare") return { ok: false, error: "unknown_provider" };
    if (!this.bothPresent(row) || row.last_metered_ms == null) return { ok: true };
    const end = Math.max(row.last_metered_ms, Math.min(atMs, Date.now() + 60_000));
    const wallSeconds = Math.floor((end - row.last_metered_ms) / 1000);
    if (wallSeconds < 1) return { ok: true };
    const intervalEnd = row.last_metered_ms + wallSeconds * 1000;
    const tickId = `${row.authorization_id}:tick:${intervalEnd}`;
    const wallet = await consumeMessengerCallUsage(this.env, row.payer_uid, {
      op_id: tickId, call_id: row.call_id, authorization_id: row.authorization_id,
      day: row.allowance_day || new Date(intervalEnd).toISOString().slice(0, 10),
      wall_seconds: wallSeconds, media: row.media, quality_sku: row.quality_sku,
      price_version: row.price_version, rate_centitokens_per_participant_minute: row.rate_centitokens_per_participant_minute,
      daily_audio_allowance_participant_seconds: row.daily_audio_allowance_participant_seconds, allow_free: false, reservation_ref: row.reservation_ref ?? undefined,
    });
    if (!wallet.ok) {
      if (wallet.status === 402 && wallet.body?.disconnect === true) {
        const exhaustionReason = wallet.body?.reason === "free_allowance_exhausted"
          ? "free_allowance_exhausted" : "insufficient_balance";
        let partialFreePersisted = true;
        try {
          // A boundary-crossing tick may have consumed a free prefix before
          // WalletDO denied the paid suffix. Persist that accepted prefix
          // before provider teardown/finalization so allowance usage and the
          // receipt remain accurate without recording denied paid seconds.
          await this.persistDeniedFreeTick(row, tickId, row.last_metered_ms, wallet.body as Record<string, unknown>);
        } catch {
          partialFreePersisted = false;
          await this.markReconciliationPending("partial_free_tick_persist_failed");
        }
        // provider=cloudflare free-audio exhaustion is a confirmed CallRoom teardown;
        // paid Stream exhaustion uses the signed Stream mark_ended path.
        const providerEnded = await this.endProviderCall(row.call_id, exhaustionReason);
        if (!providerEnded) {
          await this.markReconciliationPending("provider_end_after_funds_exhausted_unconfirmed");
          await this.env.DB_WALLET.prepare("UPDATE messenger_call_authorizations SET status='reconciliation_pending', terminal_reason='provider_end_after_funds_exhausted_unconfirmed' WHERE authorization_id=?1 AND status IN ('authorized','connected','funds_exhausted')").bind(row.authorization_id).run();
          return { ok: false, error: "provider_end_unconfirmed", reconciliation_pending: true };
        }
        if (!partialFreePersisted) {
          return { ok: false, error: "partial_free_tick_persist_failed", reconciliation_pending: true, provider_ended: true };
        }
        this.sql.exec("UPDATE billing_state SET status='funds_exhausted', ending_reason=?1 WHERE k=1", exhaustionReason);
        await this.markD1FundsExhausted(row, exhaustionReason);
        await this.state.storage.deleteAlarm();
        // Provider teardown is confirmed, so finalize immediately. Waiting
        // for a webhook here would leak the receipt/reservation if that
        // webhook is dropped after Stream has already ended the call.
        const finalized = await this.finalizeInternal(exhaustionReason, Date.now());
        if (finalized.ok) return { ok: false, error: exhaustionReason, disconnect: true, provider_ended: true };
        return { ok: false, error: finalized.error || "finalization_failed", reconciliation_pending: true, disconnect: true, provider_ended: true };
      }
      await this.markReconciliationPending("wallet_tick_failed");
      return { ok: false, error: "wallet_tick_failed", reconciliation_pending: true };
    }
    const body = wallet.body as Record<string, unknown>;
    const participantSeconds = Math.max(0, Math.trunc(Number(body.participant_seconds ?? wallSeconds * 2)));
    const freeSeconds = Math.max(0, Math.trunc(Number(body.free_participant_seconds ?? 0)));
    const paidSeconds = Math.max(0, Math.trunc(Number(body.paid_participant_seconds ?? 0)));
    const charged = Math.max(0, Math.trunc(Number(body.charged_centitoken_seconds ?? 0)));
    const tokens = Math.max(0, Math.trunc(Number(body.tokens_charged ?? 0)));
    if (row.reservation_ref && Number.isFinite(Number(body.reservation_remaining))) {
      this.sql.exec("UPDATE billing_state SET reserved_tokens=?1 WHERE k=1", Math.max(0, Math.trunc(Number(body.reservation_remaining))));
    }
    this.sql.exec("INSERT OR IGNORE INTO billing_ticks (tick_id,interval_start_ms,interval_end_ms,participant_seconds,free_participant_seconds,paid_participant_seconds,charged_centitoken_seconds,tokens_charged,ledger_status) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'pending')",
      tickId, row.last_metered_ms, intervalEnd, participantSeconds, freeSeconds, paidSeconds, charged, tokens);
    this.sql.exec("UPDATE billing_state SET last_metered_ms=?1, connected_wall_seconds=connected_wall_seconds+?2, participant_seconds=participant_seconds+?3, free_participant_seconds=free_participant_seconds+?4, paid_participant_seconds=paid_participant_seconds+?5, charged_centitoken_seconds=charged_centitoken_seconds+?6, tokens_charged=tokens_charged+?7 WHERE k=1",
      intervalEnd, wallSeconds, participantSeconds, freeSeconds, paidSeconds, charged, tokens);
    try {
      await this.appendLedger(row, tickId, row.last_metered_ms, intervalEnd, participantSeconds, freeSeconds, paidSeconds, charged, tokens);
      this.sql.exec("UPDATE billing_ticks SET ledger_status='written' WHERE tick_id=?1", tickId);
      this.emitBillingTelemetry(row, "messenger_call_usage_tick", {
        participant_seconds: participantSeconds, free_participant_seconds: freeSeconds,
        paid_participant_seconds: paidSeconds, tokens_charged: tokens,
      });
      return { ok: true };
    } catch {
      await this.markReconciliationPending("ledger_write_failed");
      return { ok: false, error: "ledger_write_failed", reconciliation_pending: true };
    }
  }

  private async appendLedger(row: BillingStateRow, tickId: string, start: number, end: number, participantSeconds: number, freeSeconds: number, paidSeconds: number, charged: number, tokens: number): Promise<void> {
    const result = await this.env.DB_WALLET.prepare("INSERT OR IGNORE INTO messenger_call_usage_ledger (tick_id,authorization_id,call_id,payer_uid,provider,quality_sku,interval_start_ms,interval_end_ms,participant_count,participant_seconds,free_participant_seconds,paid_participant_seconds,charged_centitoken_seconds,tokens_funded,price_version,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,2,?9,?10,?11,?12,?13,?14,?15)").bind(
      tickId, row.authorization_id, row.call_id, row.payer_uid, row.provider, row.quality_sku, start, end, participantSeconds, freeSeconds, paidSeconds, charged, tokens, row.price_version, Date.now(),
    ).run();
    if ((result.meta?.changes ?? 0) === 0) {
      const prior = await this.env.DB_WALLET.prepare("SELECT authorization_id,call_id,payer_uid,provider,quality_sku,interval_start_ms,interval_end_ms,participant_seconds,free_participant_seconds,paid_participant_seconds,charged_centitoken_seconds,tokens_funded,price_version FROM messenger_call_usage_ledger WHERE tick_id=?1").bind(tickId).first<Record<string, unknown>>();
      const matches = prior && prior.authorization_id === row.authorization_id && prior.call_id === row.call_id && prior.payer_uid === row.payer_uid &&
        prior.provider === row.provider && prior.quality_sku === row.quality_sku &&
        Number(prior.interval_start_ms) === start && Number(prior.interval_end_ms) === end && Number(prior.participant_seconds) === participantSeconds &&
        Number(prior.free_participant_seconds) === freeSeconds && Number(prior.paid_participant_seconds) === paidSeconds &&
        Number(prior.charged_centitoken_seconds) === charged && Number(prior.tokens_funded) === tokens && Number(prior.price_version) === row.price_version;
      if (!matches) throw new Error("immutable_tick_mismatch");
    }
  }

  /**
   * WalletDO may consume the final free prefix of a boundary-crossing tick
   * before denying its paid suffix (402). Persist only that accepted prefix;
   * denied paid seconds never enter local totals, the D1 ledger, or the receipt.
   * The tick key and immutable ledger comparison make teardown retries safe.
   */
  private async persistDeniedFreeTick(
    row: BillingStateRow,
    tickId: string,
    start: number,
    body: Record<string, unknown>,
  ): Promise<boolean> {
    const freeSeconds = Math.max(0, Math.trunc(Number(body.free_participant_seconds ?? 0)));
    if (freeSeconds <= 0) return true;
    // A 1:1 tick always contributes two participant-seconds per connected
    // wall-second. WalletDO therefore returns an even accepted prefix. Any
    // odd/corrupt value must not create a receipt whose participant and wall
    // totals disagree; leave it for reconciliation instead.
    if (freeSeconds % 2 !== 0) throw new Error("partial_free_tick_not_whole_wall_second");
    const acceptedWallSeconds = freeSeconds / 2;
    const partialEnd = start + acceptedWallSeconds * 1000;
    const existing = this.sql.exec("SELECT participant_seconds,free_participant_seconds,paid_participant_seconds,charged_centitoken_seconds,tokens_charged FROM billing_ticks WHERE tick_id=?1", tickId).toArray()[0] as Record<string, unknown> | undefined;
    if (!existing) {
      this.sql.exec("INSERT INTO billing_ticks (tick_id,interval_start_ms,interval_end_ms,participant_seconds,free_participant_seconds,paid_participant_seconds,charged_centitoken_seconds,tokens_charged,ledger_status) VALUES (?1,?2,?3,?4,?5,0,0,0,'pending')",
        tickId, start, partialEnd, freeSeconds, freeSeconds);
      this.sql.exec("UPDATE billing_state SET connected_wall_seconds=connected_wall_seconds+?1, participant_seconds=participant_seconds+?2, free_participant_seconds=free_participant_seconds+?3 WHERE k=1",
        acceptedWallSeconds, freeSeconds, freeSeconds);
    } else if (Number(existing.participant_seconds) !== freeSeconds || Number(existing.free_participant_seconds) !== freeSeconds ||
      Number(existing.paid_participant_seconds) !== 0 || Number(existing.charged_centitoken_seconds) !== 0 || Number(existing.tokens_charged) !== 0) {
      throw new Error("immutable_partial_free_tick_mismatch");
    }
    await this.appendLedger(row, tickId, start, partialEnd, freeSeconds, freeSeconds, 0, 0, 0);
    this.sql.exec("UPDATE billing_ticks SET ledger_status='written' WHERE tick_id=?1 AND ledger_status='pending'", tickId);
    return true;
  }

  /** Drain wallet-successful local ticks without charging the WalletDO again. */
  private async drainPendingTicks(row: BillingStateRow): Promise<void> {
    const pending = this.sql.exec("SELECT tick_id,interval_start_ms,interval_end_ms,participant_seconds,free_participant_seconds,paid_participant_seconds,charged_centitoken_seconds,tokens_charged FROM billing_ticks WHERE ledger_status='pending' ORDER BY interval_start_ms ASC").toArray() as Array<Record<string, unknown>>;
    for (const tick of pending) {
      await this.appendLedger(
        row,
        String(tick.tick_id),
        Number(tick.interval_start_ms), Number(tick.interval_end_ms),
        Number(tick.participant_seconds), Number(tick.free_participant_seconds),
        Number(tick.paid_participant_seconds), Number(tick.charged_centitoken_seconds),
        Number(tick.tokens_charged),
      );
      this.sql.exec("UPDATE billing_ticks SET ledger_status='written' WHERE tick_id=?1 AND ledger_status='pending'", String(tick.tick_id));
    }
  }

  private repairTotalsFromDurableTicks(): void {
    const totals = this.sql.exec("SELECT COALESCE(SUM((interval_end_ms-interval_start_ms)/1000),0) AS wall_seconds, COALESCE(SUM(participant_seconds),0) AS participant_seconds, COALESCE(SUM(free_participant_seconds),0) AS free_seconds, COALESCE(SUM(paid_participant_seconds),0) AS paid_seconds, COALESCE(SUM(charged_centitoken_seconds),0) AS charged, COALESCE(SUM(tokens_charged),0) AS tokens FROM billing_ticks").one<Record<string, number>>();
    this.sql.exec("UPDATE billing_state SET connected_wall_seconds=MAX(connected_wall_seconds,?1), participant_seconds=MAX(participant_seconds,?2), free_participant_seconds=MAX(free_participant_seconds,?3), paid_participant_seconds=MAX(paid_participant_seconds,?4), charged_centitoken_seconds=MAX(charged_centitoken_seconds,?5), tokens_charged=MAX(tokens_charged,?6) WHERE k=1",
      Number(totals?.wall_seconds ?? 0), Number(totals?.participant_seconds ?? 0), Number(totals?.free_seconds ?? 0), Number(totals?.paid_seconds ?? 0), Number(totals?.charged ?? 0), Number(totals?.tokens ?? 0));
  }

  private async finalizeCall(body: Record<string, unknown>): Promise<Response> {
    const reason = text(body.ending_reason, 128) || "session_ended";
    const result = await this.finalizeInternal(reason, positiveMs(body.ended_at_ms, Date.now()));
    return json(result, result.status ?? (result.ok ? 200 : 503));
  }

  private async finalizeInternal(reason: string, endedAt: number): Promise<{ ok: boolean; status?: number; error?: string; reconciliation_pending?: boolean; receipt?: boolean }> {
    let row = this.readState();
    if (!row) return { ok: false, status: 409, error: "billing authorization not initialized" };
    if (row.status === "ended") return { ok: true, receipt: true };
    if (row.status === "reconciliation_pending") return { ok: false, status: 503, error: "reconciliation_pending", reconciliation_pending: true };
    const metered = row.status === "finalizing" ? { ok: true } : await this.meterAt(endedAt);
    if (!metered.ok && this.readState()?.status !== "funds_exhausted") return { ok: false, status: 503, error: metered.error, reconciliation_pending: metered.reconciliation_pending };
    row = this.readState();
    if (!row) return { ok: false, status: 503, error: "billing state disappeared" };
    this.sql.exec("UPDATE billing_state SET status='finalizing', ending_reason=?1 WHERE k=1", reason);
    row = this.readState();
    if (!row) return { ok: false, status: 503, error: "billing state disappeared" };
    try {
      // Retry/replay pending billing_ticks through appendLedger before receipt.
      const pendingTickCount = Number(this.sql.exec("SELECT COUNT(*) AS count FROM billing_ticks WHERE ledger_status='pending'").one<{ count: number }>()?.count ?? 0);
      if (pendingTickCount > 0) await this.drainPendingTicks(row);
      this.repairTotalsFromDurableTicks();
      row = this.readState();
      if (!row) throw new Error("billing state disappeared");
      const receiptInsert = await this.env.DB_WALLET.prepare("INSERT OR IGNORE INTO messenger_call_receipts (authorization_id,call_id,payer_uid,media,quality_sku,provider,connected_wall_seconds,participant_seconds,free_participant_seconds,paid_participant_seconds,rate_centitokens_per_participant_minute,price_version,tokens_charged,ending_reason,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)").bind(
        row.authorization_id, row.call_id, row.payer_uid, row.media, row.quality_sku, row.provider, row.connected_wall_seconds, row.participant_seconds,
        row.free_participant_seconds, row.paid_participant_seconds, row.rate_centitokens_per_participant_minute, row.price_version, row.tokens_charged, reason, Date.now(),
      ).run();
      if ((receiptInsert.meta?.changes ?? 0) === 0) {
        const prior = await this.env.DB_WALLET.prepare("SELECT authorization_id,call_id,payer_uid,media,quality_sku,provider,connected_wall_seconds,participant_seconds,free_participant_seconds,paid_participant_seconds,rate_centitokens_per_participant_minute,price_version,tokens_charged,ending_reason FROM messenger_call_receipts WHERE authorization_id=?1").bind(row.authorization_id).first<Record<string, unknown>>();
        const matches = prior && prior.authorization_id === row.authorization_id && prior.call_id === row.call_id && prior.payer_uid === row.payer_uid &&
          prior.media === row.media && prior.quality_sku === row.quality_sku && prior.provider === row.provider &&
          Number(prior.connected_wall_seconds) === row.connected_wall_seconds && Number(prior.participant_seconds) === row.participant_seconds &&
          Number(prior.free_participant_seconds) === row.free_participant_seconds && Number(prior.paid_participant_seconds) === row.paid_participant_seconds &&
          Number(prior.rate_centitokens_per_participant_minute) === row.rate_centitokens_per_participant_minute &&
          Number(prior.price_version) === row.price_version && Number(prior.tokens_charged) === row.tokens_charged && prior.ending_reason === reason;
        if (!matches) throw new Error("immutable_receipt_mismatch");
      }
      if (row.reservation_ref) {
        const released = await releaseMessengerCallReservation(this.env, row.payer_uid, row.reservation_ref, `${row.authorization_id}:finalize:release`);
        if (!released.ok) throw new Error("reservation_release_failed");
      }
      await this.env.DB_WALLET.prepare("UPDATE messenger_call_authorizations SET status='ended', ended_at=?1, terminal_reason=?2 WHERE authorization_id=?3 AND status IN ('authorized','connected','funds_exhausted','finalizing','reconciliation_pending','cancelled')").bind(endedAt, reason, row.authorization_id).run();
      this.sql.exec("UPDATE billing_state SET status='ended', ending_reason=?1 WHERE k=1", reason);
      await this.state.storage.deleteAlarm();
      this.emitBillingTelemetry(row, "messenger_call_settlement_result", {
        result: "settled", participant_seconds: row.participant_seconds,
        free_participant_seconds: row.free_participant_seconds,
        paid_participant_seconds: row.paid_participant_seconds,
        tokens_charged: row.tokens_charged, ending_reason: reason,
      });
      this.emitBillingTelemetry(row, "messenger_call_receipt_created", {
        participant_seconds: row.participant_seconds, tokens_charged: row.tokens_charged,
      });
      return { ok: true, receipt: true };
    } catch {
      await this.markReconciliationPending("finalization_failed");
      return { ok: false, status: 503, error: "finalization_failed", reconciliation_pending: true };
    }
  }

  private async reconcile(body: Record<string, unknown>): Promise<Response> {
    const row = this.readState();
    if (!row) return json({ ok: false, error: "billing authorization not initialized" }, 409);
    if (body.provider_confirmed !== true) {
      await this.markReconciliationPending(text(body.reason, 128) || "provider_state_uncertain");
      return json({ ok: false, reconciliation_pending: true }, 503);
    }
    const persistedReason = row.ending_reason || text(body.ending_reason, 128) || "reconciled";
    if (row.status === "reconciliation_pending") {
      this.sql.exec("UPDATE billing_state SET status='finalizing', ending_reason=?1 WHERE k=1", persistedReason);
    }
    const result = await this.finalizeInternal(persistedReason, positiveMs(body.ended_at_ms, Date.now()));
    return json(result, result.status ?? (result.ok ? 200 : 503));
  }

  private async markReconciliationPending(reason: string): Promise<void> {
    // Preserve a previously persisted terminal reason (and the receipt's
    // immutable reason) across partial-finalization retries.
    this.sql.exec("UPDATE billing_state SET status='reconciliation_pending', ending_reason=COALESCE(ending_reason,?1) WHERE k=1 AND status NOT IN ('ended')", reason.slice(0, 128));
    await this.state.storage.deleteAlarm();
    const row = this.readState();
    if (row) {
      await this.env.DB_WALLET.prepare("UPDATE messenger_call_authorizations SET status='reconciliation_pending', terminal_reason=?1 WHERE authorization_id=?2 AND status IN ('authorized','connected','funds_exhausted')").bind(reason.slice(0, 128), row.authorization_id).run().catch(() => undefined);
      this.emitBillingTelemetry(row, "messenger_call_settlement_result", {
        result: "reconciliation_pending", reason, reservation_retained: true,
      });
    }
  }

  private async armAlarm(at: number): Promise<void> {
    await this.state.storage.setAlarm(at);
  }
}

export function messengerCallBillingStub(env: Env, authorizationId: string): DurableObjectStub {
  return env.MESSENGER_CALL_BILLING.get(env.MESSENGER_CALL_BILLING.idFromName(`authorization:${authorizationId}`));
}

export async function initializeMessengerCallBilling(env: Env, snapshot: MessengerCallBillingAuthorizationSnapshot): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const response = await messengerCallBillingStub(env, snapshot.authorization_id).fetch("https://messenger-billing/init", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "init", snapshot }) });
  return { ok: response.status === 200, status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}

export async function forwardMessengerStreamEvent(env: Env, event: MessengerStreamBillingEvent): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const response = await messengerCallBillingStub(env, event.authorization_id).fetch("https://messenger-billing/stream-event", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "stream_event", ...event }) });
  return { ok: response.status === 200, status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}

/** CallRoom adapter for the Cloudflare audio lane. The event is already bound
 * to the authenticated seat by CallRoom; this helper only forwards the
 * provider-neutral lifecycle event to the per-authorization authority. */
export async function forwardMessengerCloudflareEvent(
  env: Env,
  event: Omit<MessengerStreamBillingEvent, "authorization_id"> & { authorization_id: string },
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const response = await messengerCallBillingStub(env, event.authorization_id).fetch("https://messenger-billing/media-event", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "media_event", ...event }),
  });
  return { ok: response.status === 200, status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}

/** Resolve the server-owned authorization by call_id; webhook payloads never
 * supply payer/rate/provider terms to the DO. Non-Messenger calls are ignored
 * so the legacy Stream webhook behavior remains unchanged. */
export async function forwardMessengerStreamEventByCall(
  env: Env,
  event: Omit<MessengerStreamBillingEvent, "authorization_id">,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const row = await env.DB_WALLET.prepare(
    "SELECT authorization_id FROM messenger_call_authorizations WHERE call_id=?1 AND provider='stream' LIMIT 1",
  ).bind(event.call_id).first<{ authorization_id: string }>();
  if (!row?.authorization_id) return { ok: true, status: 204, body: { ok: true, ignored: true } };
  return forwardMessengerStreamEvent(env, { ...event, authorization_id: row.authorization_id });
}

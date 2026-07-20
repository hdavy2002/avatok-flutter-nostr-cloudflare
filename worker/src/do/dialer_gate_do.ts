// DialerGateDO — [AVA-CAMP-B1-GATE] per-user outbound-dial admission gate for AI
// calling campaigns (Specs/OUTBOUND-AI-CALLING-CAMPAIGNS.md §2, §6.3). One
// instance per owner uid (keyed the same way as WalletDO/UserBrain — the caller
// does `env.DIALER_GATE.idFromName(uid)`). Owns ONLY admission math: it never
// touches money (WalletDO), never dials (CampaignDO + provider), never writes D1.
// It is the single serialized checkpoint a CampaignDO tick calls before every
// dial so channel/rate limits are enforced per-user, not per-campaign.
//
// Public surface (fetch, JSON body { op, ... }):
//   requestDialPermit(campaignId, capacity?) → { permit: true }
//                                             | { permit: false, retryAfterMs }
//   release(campaignId)                       → { ok: true }   (call finished; frees a channel slot)
//   setCapacity(capacity)                     → { ok: true }   (caller-supplied channel cap; §2/§6.3
//                                                                 says "capacity is passed in / read from
//                                                                 D1 by the caller for now" — this DO does
//                                                                 not read D1 itself, by design, so it stays
//                                                                 a pure admission function with no D1 fan-out)
//   status()                                  → snapshot for debugging/tests
//
// PHASE B1 SCAFFOLDING — nothing calls this DO yet (campaignDialerEnabled
// defaults false; CampaignDO's dial loop lands in a later B-phase). It must be
// SAFE TO DEPLOY DARK: correct, self-contained, conservative. Cross-phase hooks
// are marked TODO(AVA-CAMP-B2).
//
// ── Design (§6.3) ──────────────────────────────────────────────────────────
// 1. Channel pool: `activeChannels` counts calls currently "in flight" for this
//    user (reserved by requestDialPermit, freed by release()). Capacity is
//    supplied by the caller on each request (or via setCapacity) rather than
//    read from D1 here — D1 is the authoritative source for a user's purchased
//    channel count, and only the Worker route layer (which already reads D1 for
//    other admission checks in the dial loop, §6.3 step 1) has clean access to
//    it. Keeping this DO ignorant of D1 keeps it a small, fast, race-free
//    admission checkpoint — exactly the "single writer, serialized" value a DO
//    is for. TODO(AVA-CAMP-B2): if profiling shows the per-tick capacity lookup
//    is a hot path, consider caching the last-known capacity here with a TTL.
// 2. Token-bucket rate limiting: two buckets —
//      - per-DID bucket, capacity 1, refill 1 token/sec  (CPS=1 per DID, §2/§6.3)
//      - per-account bucket, capacity/refill = accountCps (default 1, tier-
//        adjustable via setCapacity's `accountCps` field; §6.3 "per-account CPS
//        from tier")
//    A permit requires BOTH buckets to have a token; consuming a token from
//    each is atomic within this DO's single-threaded fetch handler.
// 3. Round-robin fairness across a user's running campaigns: campaigns that
//    have requested least recently are served first, so one large campaign
//    can't starve a smaller concurrent one. Implemented as a simple
//    last-served timestamp per campaignId — cheap, deterministic, no separate
//    queue structure to keep durable.
// 4. Reserved-inbound-channel rule for shared receptionist DIDs (§6.3 "Shared-
//    DID reservation"): `effective_outbound_capacity = total_channels −
//    reserved_inbound − current_inbound_capacity`. This DO has no visibility
//    into receptionist inbound-call state (that lives in D1 / ReceptionRoom*),
//    so `reservedInbound` and `currentInboundCalls` are accepted as OPTIONAL
//    fields on the request (caller-supplied, defaulting to 0 = no reservation
//    applied) — a documented hook, not a real read. TODO(AVA-CAMP-B2): wire the
//    caller (CampaignDO / the dial-loop route) to look up the DID's
//    `purpose='shared'` + live inbound-call count and pass them through on every
//    requestDialPermit call once the receptionist-state read exists.
//
// Durable storage: DO SQLite (`state.storage.sql`), matching WalletDO's pattern
// (registered new_sqlite_classes in wrangler.toml). Two tiny tables: `pool`
// (single-row active-channel counter) and `buckets` (token-bucket state, one
// row for the account bucket + one per DID). Campaign fairness timestamps are
// small enough to keep in a `campaigns` table too, rather than in-memory, so a
// DO eviction/restart doesn't reset fairness ordering.
import type { Env } from "../types";
import { json } from "../util";

const DID_BUCKET_CAPACITY = 1;      // CPS=1 per DID (§2, §6.3)
const DID_BUCKET_REFILL_PER_MS = 1 / 1000; // 1 token/sec
const DEFAULT_ACCOUNT_CPS = 1;      // conservative default; tier can raise via setCapacity
const DEFAULT_CHANNEL_CAPACITY = 1; // conservative default until the caller supplies the real D1 value
const RETRY_AFTER_FLOOR_MS = 250;   // never advise a near-zero retry (avoids hot-loop ticks)
const RETRY_AFTER_CEIL_MS = 5_000;  // cap the advised backoff so a stuck campaign still ticks often

interface Bucket { tokens: number; capacity: number; refillPerMs: number; updatedAt: number; }

export class DialerGateDO {
  private env: Env;
  private state: DurableObjectState;
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.state = state;
    this.sql = state.storage.sql;

    // Channel pool: one row, k=1. `capacity` persists the last value the caller
    // supplied via setCapacity/requestDialPermit so a mid-tick DO restart
    // doesn't silently fall back to DEFAULT_CHANNEL_CAPACITY.
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS pool (k INTEGER PRIMARY KEY, active INTEGER NOT NULL DEFAULT 0, capacity INTEGER NOT NULL DEFAULT 1)",
    );
    this.sql.exec("INSERT OR IGNORE INTO pool (k, active, capacity) VALUES (1,0,?1)", DEFAULT_CHANNEL_CAPACITY);

    // Token buckets. bucket_id = 'account' for the per-account CPS ceiling,
    // or the DID e164 string for a per-DID CPS=1 bucket.
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS buckets (bucket_id TEXT PRIMARY KEY, tokens REAL NOT NULL, capacity REAL NOT NULL, refill_per_ms REAL NOT NULL, updated_at INTEGER NOT NULL)",
    );

    // Round-robin fairness: last time a campaign was granted a permit (0 = never
    // served → highest priority). Rows are lazily created on first request.
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS campaigns (campaign_id TEXT PRIMARY KEY, last_served_at INTEGER NOT NULL DEFAULT 0, active_calls INTEGER NOT NULL DEFAULT 0)",
    );
  }

  async fetch(req: Request): Promise<Response> {
    let body: any = {};
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

    switch (body.op) {
      case "requestDialPermit": return this.requestDialPermit(body);
      case "release": return this.release(body);
      case "setCapacity": return this.setCapacity(body);
      case "status": return json(this.snapshot());
      default: return json({ error: "unknown op" }, 400);
    }
  }

  // ---- channel pool + bucket plumbing ---------------------------------

  private getPool(): { active: number; capacity: number } {
    const r = this.sql.exec("SELECT active, capacity FROM pool WHERE k=1").one() as any;
    return { active: Number(r.active), capacity: Number(r.capacity) };
  }

  private setPoolActive(active: number): void {
    this.sql.exec("UPDATE pool SET active=?1 WHERE k=1", Math.max(0, active));
  }

  private getBucket(id: string, capacity: number, refillPerMs: number, now: number): Bucket {
    const row = this.sql.exec("SELECT tokens, capacity, refill_per_ms, updated_at FROM buckets WHERE bucket_id=?1", id).toArray()[0] as any;
    if (!row) {
      // New bucket starts full so the first call after a cold DO isn't
      // penalized by an empty-bucket wait.
      const b: Bucket = { tokens: capacity, capacity, refillPerMs, updatedAt: now };
      this.sql.exec(
        "INSERT INTO buckets (bucket_id, tokens, capacity, refill_per_ms, updated_at) VALUES (?1,?2,?3,?4,?5)",
        id, b.tokens, b.capacity, b.refillPerMs, b.updatedAt,
      );
      return b;
    }
    // Refill based on elapsed time since last touch (lazy refill — no timers).
    const elapsed = Math.max(0, now - Number(row.updated_at));
    const tokens = Math.min(capacity, Number(row.tokens) + elapsed * refillPerMs);
    return { tokens, capacity, refillPerMs, updatedAt: now };
  }

  private saveBucket(id: string, b: Bucket): void {
    this.sql.exec(
      "INSERT INTO buckets (bucket_id, tokens, capacity, refill_per_ms, updated_at) VALUES (?1,?2,?3,?4,?5) " +
      "ON CONFLICT(bucket_id) DO UPDATE SET tokens=excluded.tokens, capacity=excluded.capacity, refill_per_ms=excluded.refill_per_ms, updated_at=excluded.updated_at",
      id, b.tokens, b.capacity, b.refillPerMs, b.updatedAt,
    );
  }

  /** ms until `bucket` has >=1 token, given its current (already-refilled) state. */
  private waitForToken(b: Bucket): number {
    if (b.tokens >= 1) return 0;
    const need = 1 - b.tokens;
    return Math.ceil(need / b.refillPerMs);
  }

  // ---- ops --------------------------------------------------------------

  /**
   * requestDialPermit(campaignId) → { permit:true } | { permit:false, retryAfterMs }
   *
   * Optional fields on the request (all documented hooks for the caller, per
   * §6.3 — this DO does no D1/state reads of its own):
   *   didE164            — DID about to be used; gates the per-DID CPS=1 bucket.
   *                         Omitted → no per-DID gate is applied for this call
   *                         (caller is responsible for DID-level dedupe if it
   *                         matters for its use case).
   *   capacity           — total channel count for this user (from D1). If
   *                         provided it becomes the pool's new capacity (like
   *                         calling setCapacity first); if omitted the DO uses
   *                         the last value it was told (default 1).
   *   accountCps         — per-account CPS ceiling (tier-based). Same
   *                         "last known value wins" behavior as capacity.
   *   reservedInbound     — TODO(AVA-CAMP-B2): channels permanently reserved for
   *   currentInboundCalls    a shared receptionist DID. Both default 0 (no
   *                         reservation) until the receptionist-state read is
   *                         wired into the caller. When non-zero,
   *                         effective_capacity = capacity - reservedInbound -
   *                         currentInboundCalls, floored at 0, per §6.3
   *                         "Inbound always wins".
   */
  private requestDialPermit(body: any): Response {
    const campaignId = String(body.campaignId || "");
    if (!campaignId) return json({ error: "campaignId required" }, 400);
    const now = Date.now();

    // 1) Channel pool capacity (caller-supplied; see class docblock).
    const pool = this.getPool();
    const capacity = Number.isFinite(Number(body.capacity)) && Number(body.capacity) >= 0
      ? Number(body.capacity) : pool.capacity;
    if (capacity !== pool.capacity) this.sql.exec("UPDATE pool SET capacity=?1 WHERE k=1", capacity);

    // TODO(AVA-CAMP-B2): reservedInbound/currentInboundCalls are placeholders
    // until the caller wires in a real receptionist-state read (§6.3 shared-DID
    // reservation rule). Effective capacity floors at 0 — never negative.
    const reservedInbound = Math.max(0, Number(body.reservedInbound) || 0);
    const currentInboundCalls = Math.max(0, Number(body.currentInboundCalls) || 0);
    const effectiveCapacity = Math.max(0, capacity - reservedInbound - currentInboundCalls);

    if (pool.active >= effectiveCapacity) {
      return json(this.deny(now, "channel_pool_full"));
    }

    // 2) Token buckets — both must have a token available right now.
    const accountCps = Number.isFinite(Number(body.accountCps)) && Number(body.accountCps) > 0
      ? Number(body.accountCps) : DEFAULT_ACCOUNT_CPS;
    const acctBucket = this.getBucket("account", accountCps, accountCps / 1000, now);
    if (acctBucket.tokens < 1) {
      this.saveBucket("account", acctBucket); // persist refill progress even on deny
      return json(this.deny(now, "account_cps", this.waitForToken(acctBucket)));
    }

    const didE164 = body.didE164 ? String(body.didE164) : null;
    let didBucket: Bucket | null = null;
    if (didE164) {
      didBucket = this.getBucket(`did:${didE164}`, DID_BUCKET_CAPACITY, DID_BUCKET_REFILL_PER_MS, now);
      if (didBucket.tokens < 1) {
        this.saveBucket(`did:${didE164}`, didBucket);
        return json(this.deny(now, "did_cps", this.waitForToken(didBucket)));
      }
    }

    // 3) Round-robin fairness: if OTHER campaigns for this user are waiting
    // (i.e. have a campaigns row with an older last_served_at than this one
    // would get), and we're not strictly out of channel room, prefer whichever
    // campaign has gone longest without a permit. Cheap heuristic: only apply
    // when more than one campaign is registered AND this campaign was served
    // more recently than the oldest-waiting campaign — in that case make this
    // campaign wait one short tick so the older campaign's next request (which
    // the CampaignDO alarm loop will retry) gets a fair shot first.
    this.touchCampaign(campaignId, 0); // ensure a row exists, don't stamp yet
    const oldest = this.sql.exec(
      "SELECT campaign_id, last_served_at FROM campaigns WHERE campaign_id != ?1 ORDER BY last_served_at ASC LIMIT 1",
      campaignId,
    ).toArray()[0] as any;
    if (oldest) {
      const mine = this.sql.exec("SELECT last_served_at FROM campaigns WHERE campaign_id=?1", campaignId).one() as any;
      const myLast = Number(mine?.last_served_at ?? 0);
      // Only defer if there's actual contention for channel room (pool nearly
      // full) — with spare capacity, fairness ordering doesn't matter.
      const contentious = pool.active >= Math.max(1, effectiveCapacity - 1);
      if (contentious && Number(oldest.last_served_at) < myLast) {
        return json(this.deny(now, "fairness_round_robin", RETRY_AFTER_FLOOR_MS));
      }
    }

    // Admitted: consume both buckets, bump the pool, stamp fairness + record
    // the call against this campaign so release() can find it.
    acctBucket.tokens -= 1; this.saveBucket("account", acctBucket);
    if (didE164 && didBucket) { didBucket.tokens -= 1; this.saveBucket(`did:${didE164}`, didBucket); }
    this.setPoolActive(pool.active + 1);
    this.touchCampaign(campaignId, now);
    this.sql.exec("UPDATE campaigns SET active_calls = active_calls + 1 WHERE campaign_id=?1", campaignId);

    return json({ permit: true });
  }

  private deny(now: number, reason: string, waitMs = 0): { permit: false; retryAfterMs: number; reason: string } {
    const retryAfterMs = Math.min(RETRY_AFTER_CEIL_MS, Math.max(RETRY_AFTER_FLOOR_MS, waitMs || RETRY_AFTER_FLOOR_MS));
    return { permit: false, retryAfterMs, reason };
  }

  private touchCampaign(campaignId: string, lastServedAt: number): void {
    this.sql.exec(
      "INSERT INTO campaigns (campaign_id, last_served_at, active_calls) VALUES (?1,?2,0) " +
      "ON CONFLICT(campaign_id) DO UPDATE SET last_served_at = CASE WHEN ?2 > 0 THEN ?2 ELSE campaigns.last_served_at END",
      campaignId, lastServedAt,
    );
  }

  /** release(campaignId) — call this when a dialed attempt settles (answered,
   *  no-answer, busy, failed — any terminal outcome), so the channel returns to
   *  the pool. Safe to call even if nothing was reserved (floors at 0). */
  private release(body: any): Response {
    const campaignId = String(body.campaignId || "");
    if (!campaignId) return json({ error: "campaignId required" }, 400);
    const pool = this.getPool();
    this.setPoolActive(pool.active - 1);
    this.sql.exec(
      "UPDATE campaigns SET active_calls = MAX(0, active_calls - 1) WHERE campaign_id=?1",
      campaignId,
    );
    return json({ ok: true, active: this.getPool().active });
  }

  /** setCapacity — explicit capacity/accountCps push, independent of a permit
   *  request (e.g. called right after a DID purchase/release changes the
   *  user's channel count, so the next requestDialPermit reflects it without
   *  needing a value passed on that call too). */
  private setCapacity(body: any): Response {
    const capacity = Number(body.capacity);
    if (Number.isFinite(capacity) && capacity >= 0) {
      this.sql.exec("UPDATE pool SET capacity=?1 WHERE k=1", capacity);
    }
    if (Number.isFinite(Number(body.accountCps)) && Number(body.accountCps) > 0) {
      const now = Date.now();
      const b = this.getBucket("account", Number(body.accountCps), Number(body.accountCps) / 1000, now);
      // Re-cap tokens to the new capacity so a downgrade takes effect immediately.
      b.tokens = Math.min(b.tokens, b.capacity);
      this.saveBucket("account", b);
    }
    return json({ ok: true, ...this.getPool() });
  }

  private snapshot(): Record<string, unknown> {
    const pool = this.getPool();
    const campaigns = this.sql.exec("SELECT campaign_id, last_served_at, active_calls FROM campaigns").toArray();
    return { pool, campaigns };
  }
}

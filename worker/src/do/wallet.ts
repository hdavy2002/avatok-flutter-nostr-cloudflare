// WalletDO — per-user atomic coin balance (§10.1). One DO per uid. ALL balance
// math happens here, inside the DO's own SQLite, so it is strictly serialized and
// race-free. D1 (avatok-wallet) is only the async audit trail, written by the
// wallet-transactions queue consumer. The DO also serves a WebSocket that pushes
// live balance to an open app, and runs a self-scheduled alarm to release matured
// 7-day earning holds (held → spendable).
//
// Reached via stub.fetch with JSON { op, ... }. Ops: balance | credit | spend |
// earn | release | history-noop. WS: GET upgrade on any path with Upgrade header.
// Phase 2 (double-entry layer): every mutating op MAY carry
//   op_id  — idempotency id; the DO dedupes (ops table) and replays return the
//            original result without re-applying. Idempotency at the authority.
//   ledger — { debit, credit, type, ref?, meta? } double-entry row, emitted to
//            Q_WALLET by the DO itself (single writer) with id = op_id, so
//            DO-truth and the D1 ledger always correspond.
//
// [AVA-CAMP-B1-WALLET] Escrow ops for outbound campaigns (Specs/OUTBOUND-AI-
// CALLING-CAMPAIGNS.md §2/§5): reserve | consume_reserved | release. These are
// ADDITIVE — they never touch the `bal`/`acct` schema and never change the
// behavior of balance/credit/spend/earn/debit_hold/release. A per-ref escrow
// bucket lives in its own `resv` table:
//   reserve         — admits if headroom >= amount + ALL other outstanding
//                      reservations for this uid (this DO IS the uid), then
//                      adds `amount` into resv.reserved for `ref`. Does NOT
//                      touch bal.balance (money stays "real" until consumed);
//                      it only shrinks what other reservations may admit.
//   consume_reserved — moves up to `amount` from resv.reserved into resv.spent
//                      (clamped so a ref can never over-consume its own
//                      reservation) and, in the same step, performs the REAL,
//                      permanent deduction from bal.balance/acct (via setBal/
//                      free/bonus), mirroring how `spend` already debits.
//   release          — zeroes out whatever remains in resv.reserved for `ref`
//                      (marks it released) so that capacity becomes available
//                      to other reservations again. No bal.balance mutation —
//                      reserve() never removed it from bal.balance, so nothing
//                      to refund there; consume_reserved() already made any
//                      real deduction permanent.
//
// [AI-WALLET-SPENDABLE-2] (2026-07-25, Part VIII §52 of Specs/ROOT-CAUSE-REPORT-
// RECURRING-ISSUES-2026-07-25.md) — `reserve`/`consume_reserved` now carry an
// EXPLICIT, REQUIRED `allow_free` policy (no default, enforced both at compile
// time via the WalletOperation union in routes/wallet.ts AND here at runtime,
// because the DO parses `req.json()` as `any` and TypeScript's enforcement
// evaporates at that boundary):
//   allow_free:false — headroom/drawdown from PAID `balance` only (campaign
//                      escrow, payouts — real, withdrawable money).
//   allow_free:true  — headroom/drawdown from `free + bonus + balance`
//                      (internal AI/feature cost — can NEVER fund a payout).
// §58's cross-policy correctness fix: outstandingReservations() sums ALL
// unreleased reservations REGARDLESS of policy, and BOTH headroom checks
// subtract that same global sum. A same-policy-only subtraction would let an
// AI job and a campaign escrow both ultimately commit the SAME paid token —
// campaign escrow is real, withdrawable money, so it is the one that would
// lose. This conservative "subtract everything from both" rule is the
// specified launch behavior; the asymmetric optimization in §58 is deferred
// behind property tests, not implemented here.
// A reservation's policy is persisted (`resv.allow_free`) and a consume under
// a different policy than the ref was created with is rejected (409).
//
// AI reservations (`ref LIKE 'aijob:%'`) now carry a caller-supplied bounded
// `expires_at`, and `reserve()` schedules the DO alarm for it (preserving any
// earlier hold/outbox alarm) — previously `reserve()` scheduled NO alarm at
// all, which is why a crashed job's reservation could strand a user's own
// headroom for up to 6 hours with no scheduled wakeup.
//
// `settle_ai_cost` is the new ATOMIC AI-accrual settlement op — one DO round
// trip, so there is no Worker-side read-modify-write race across two separate
// walletOp calls (the real race §57 identified: read debt, compute, write
// debt, with a second job's settle landing in between). It folds the actual
// marked-up provider cost into `acct.debt_micro_usd` (a STRICT remainder,
// invariant 0 <= debt_micro_usd < 10,000 micro-USD = 1 wallet token), charges
// only the whole tokens now due, and reports any shortfall as
// `unrecovered_micro_usd` — platform loss, NEVER hidden user debt, NEVER a
// claim on a future top-up. See computeAiSettlement() below (pure, exported,
// unit-testable independent of the DO runtime).
//
// betaFreePremium (KV flag, same short-circuit as feature_pricing.ts
// chargeAmount): while ON, admission never blocks on balance and
// consume_reserved/settle_ai_cost skip the real deduction — mirrors "all
// services free in beta" without special-casing campaigns.
import type { Env } from "../types";
import { json } from "../util";
import { readConfig } from "../routes/config";
import { track, trackException } from "../hooks";
import {
  computeHumanCallUsage,
  HUMAN_CALL_FREE_PARTICIPANT_SECONDS,
} from "../lib/human_call_usage_math";
import {
  computeCallerFundedTick,
  type MessengerMedia,
  type MessengerQualitySku,
} from "../lib/messenger_call_billing";

const HOLD_MS = 7 * 86_400_000; // 7-day earnings hold
const OPS_TTL_MS = 48 * 3_600_000; // generic dedupe window for op_id replays
/**
 * Marketplace listing charges have a durable D1 operation record and may be
 * retried long after the generic wallet replay cache would normally expire.
 * Keep only this namespaced class of wallet operation forever; every other
 * wallet operation retains the bounded cache so the DO cannot grow without
 * limit for unrelated callers.
 */
export const PERMANENT_WALLET_OP_PREFIX = "listing:";

export function isPermanentWalletOpId(opId: string | undefined): boolean {
  return typeof opId === "string" && opId.startsWith(PERMANENT_WALLET_OP_PREFIX);
}
// [TOKENS-100-GRANT-1] (owner decision 2026-07-23): the daily renewable free-coin
// grant is RETIRED. New users now get a SINGLE, one-time, non-renewable 100-token
// "join and explore" grant — the persistent welcome bonus (`acct.bonus`, credited
// once at signup by routes/welcome_bonus.ts). Setting this to 0 means maybeGrant()
// never tops the daily `free` bucket back up, so the balance never refills daily or
// monthly. The old value was 250, which stacked with the 100 welcome bonus to show
// a "350" starting balance that then reset every UTC day; both behaviours are gone.
// Spend still draws free -> bonus -> paid (see spend()); with free pinned at 0 the
// welcome bonus is the first thing consumed. Do NOT raise this above 0 without an
// explicit owner decision — a non-zero value re-introduces a renewing grant.
const DAILY_FREE_GRANT = 0;

// [AI-WALLET-SPENDABLE-2] Cost basis: 1 wallet token == $0.01 == 10,000 micro-USD
// (the user-facing price is \u20b91/token; near-parity, 1 US cent = \u20b90.964). Matches
// the canonical site-wide rate documented in routes/wallet.ts (TOKENS_PER_USD =
// 100) and worker/src/lib/ai_billing.ts (AI_TOKENS_PER_USD = 100). Defined
// locally (not imported) because do/wallet.ts is the Durable Object module and
// must not import from lib/ai_billing.ts or routes/wallet.ts at module scope —
// this is a pure numeric constant duplicated by definition, not by accident;
// if the site-wide rate ever changes, all three call sites must change together.
export const TOKEN_MICRO_USD = 10_000;

// [AI-BUDGET-AUTH-2 / B4] Bounded reservation TTL for the ai_daily_budget /
// ai_unrecovered_budget tables — mirrors ai_billing.ts's
// CHAT_RESERVATION_TTL_MS (5 minutes). Duplicated here BY DEFINITION, not by
// accident (do/wallet.ts must not import from lib/ai_billing.ts at module
// scope — see the header comment). If the chat reservation TTL ever changes,
// both constants must change together. Root cause: these two tables carried
// created_at/updated_at but no expires_at, so an SSE client disconnecting
// mid-stream, a Worker eviction between reserve and settle, or any
// settle/release call that itself failed (all `.catch(() => {})` in
// ai_billing.ts) left an orphaned 'reserved' row counted at its WORST-CASE
// values for the rest of the UTC day with nothing to expire it — the exact
// §59c orphaned-reservation failure mode reproduced on these newer tables.
const AI_BUDGET_RESERVATION_TTL_MS = 5 * 60_000;

export interface AiSettlementInput {
  /** acct.debt_micro_usd BEFORE this settlement — a running sub-cent remainder. */
  debtMicroUsdBefore: number;
  /** The ALREADY marked-up actual provider cost for this one job, in micro-USD. */
  actualCostMicroUsd: number;
  /** resv.reserved for this ref, in whole wallet tokens, at settle time. */
  reservedTokens: number;
  /** free + bonus + paid balance, in whole wallet tokens, at settle time. */
  spendableTokens: number;
}
/**
 * [AFF-G6-WALLET-1] One reservation released by reapExpiredReservations().
 * `kind` distinguishes the legacy AI-job case (which keeps its exact prior
 * telemetry/audit behaviour) from every other expired ref (payouts today).
 */
export interface ReapedReservation {
  ref: string;
  reserved: number;
  uid: string;
  kind: "aijob" | "other";
}

export interface AiSettlementResult {
  chargedTokens: number;
  debtMicroUsdAfter: number;
  unrecoveredMicroUsd: number;
}

/**
 * [AI-WALLET-SPENDABLE-2] Pure accrual math for the `settle_ai_cost` op (Part
 * VIII §52 of Specs/ROOT-CAUSE-REPORT-RECURRING-ISSUES-2026-07-25.md). Folds
 * `actualCostMicroUsd` into the running sub-cent `debtMicroUsdBefore`
 * remainder, then charges only the WHOLE tokens now due from the COMBINED
 * total — so a run of sub-token jobs (e.g. 100 tiny chat turns) is billed at
 * its correct cumulative price instead of each one independently rounding UP
 * to a whole token (the old microUsdToTokens-per-job behavior). Never charges
 * more than THIS job's own reservation, and never more than the account's
 * CURRENT spendable funds — whatever is due beyond both is UNRECOVERED
 * PLATFORM LOSS, never carried forward as `debt_micro_usd` (that field is a
 * strictly-<1-token remainder by construction: `debtMicroUsdAfter` is always
 * `totalMicroUsd mod TOKEN_MICRO_USD`, so `0 <= debtMicroUsdAfter <
 * TOKEN_MICRO_USD` unconditionally) and never a claim on a future top-up.
 *
 * Pure and side-effect-free by design so it is unit-testable independent of
 * the DO/SQLite runtime — see worker/test/ai_billing_accrual.test.ts.
 */
export function computeAiSettlement(input: AiSettlementInput): AiSettlementResult {
  const debtBefore = Math.max(0, Math.trunc(input.debtMicroUsdBefore || 0));
  const actualCost = Math.max(0, Math.trunc(input.actualCostMicroUsd || 0));
  const reserved = Math.max(0, Math.trunc(input.reservedTokens || 0));
  const spendable = Math.max(0, Math.trunc(input.spendableTokens || 0));

  const totalMicroUsd = debtBefore + actualCost;
  const tokensDue = Math.floor(totalMicroUsd / TOKEN_MICRO_USD);
  const debtMicroUsdAfter = totalMicroUsd - tokensDue * TOKEN_MICRO_USD;

  const chargedTokens = Math.max(0, Math.min(tokensDue, reserved, spendable));
  const unrecoveredMicroUsd = Math.max(0, tokensDue - chargedTokens) * TOKEN_MICRO_USD;

  return { chargedTokens, debtMicroUsdAfter, unrecoveredMicroUsd };
}

// [WALLET-TXMETA-1] Rich charge metadata, passed through untouched from the charge
// call site (feature_pricing.chargeAmount → walletOp body) onto the Q_WALLET message
// so the consumer can land it on the wallet_transactions row. Purely descriptive —
// it NEVER participates in balance math. Every field is optional; keys whose value is
// absent are omitted entirely so old callers produce byte-identical messages.
function txMeta(b: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof b?.category === "string" && b.category) out.category = b.category.slice(0, 40);
  if (typeof b?.context === "string" && b.context) out.context = b.context.slice(0, 120);
  if (typeof b?.counterparty_name === "string" && b.counterparty_name) out.counterparty_name = b.counterparty_name.slice(0, 120);
  const dur = Number(b?.duration_sec);
  if (Number.isFinite(dur)) out.duration_sec = Math.max(0, Math.trunc(dur));
  const rate = Number(b?.rate_per_min);
  if (Number.isFinite(rate)) out.rate_per_min = rate;
  return out;
}

export class WalletDO {
  private env: Env;
  private state: DurableObjectState;
  private sql: SqlStorage;
  private sockets = new Set<WebSocket>();

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS bal (k INTEGER PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0, held INTEGER NOT NULL DEFAULT 0)",
    );
    this.sql.exec("INSERT OR IGNORE INTO bal (k, balance, held) VALUES (1,0,0)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS holds (id TEXT PRIMARY KEY, amount INTEGER NOT NULL, available_at INTEGER NOT NULL, released INTEGER NOT NULL DEFAULT 0)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS ops (op_id TEXT PRIMARY KEY, result TEXT NOT NULL, ts INTEGER NOT NULL)",
    );
    // Promotional free-coin pool + premium flag (Cloudflare-native AI metering).
    // Separate from `bal` (which is real, paid/earned coins) so promo coins can
    // pay ONLY for our AI costs, never seller payouts.
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS acct (k INTEGER PRIMARY KEY, free INTEGER NOT NULL DEFAULT 0, premium INTEGER NOT NULL DEFAULT 0, last_grant_day TEXT NOT NULL DEFAULT '')",
    );
    this.sql.exec("INSERT OR IGNORE INTO acct (k, free, premium, last_grant_day) VALUES (1,0,0,'')");
    // [WELCOME-100-1] Persistent promo bucket (welcome bonus). Unlike `free`
    // (RESET to DAILY_FREE_GRANT each UTC day, zeroed on the premium flip),
    // `bonus` persists until spent. Same spending rules as free coins: draws on
    // allow_free feature costs only, NEVER part of paid `balance`, so it can
    // never fund a payout. Self-migrating column add (throws when it exists).
    try { this.sql.exec("ALTER TABLE acct ADD COLUMN bonus INTEGER NOT NULL DEFAULT 0"); } catch { /* column already exists */ }
    // [AI-WALLET-SPENDABLE-2] Sub-cent AI-cost remainder ONLY — invariant
    // 0 <= debt_micro_usd < TOKEN_MICRO_USD at all times. Never hidden user
    // debt beyond that: any shortfall a settlement cannot cover from the
    // reservation + current spendable funds is recorded as platform
    // `unrecovered_micro_usd` telemetry/ledger instead, never accumulated
    // here. Self-migrating column add, same pattern as acct.bonus above.
    try { this.sql.exec("ALTER TABLE acct ADD COLUMN debt_micro_usd INTEGER NOT NULL DEFAULT 0"); } catch { /* column already exists */ }
    // [HUMAN-CALL-POOL-1] Server-authoritative monthly participant seconds and
    // a persistent fractional overage bucket. `centitoken_seconds` retains
    // sub-centitoken precision for short (15s) billing ticks: 6,000 units = one
    // whole wallet token = 100 centitokens. The row is per UTC calendar month;
    // the bucket is deliberately account-wide and carries across months/calls.
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS human_call_usage (period TEXT PRIMARY KEY, participant_seconds INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS human_call_credit (k INTEGER PRIMARY KEY, centitoken_seconds INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
    );
    this.sql.exec("INSERT OR IGNORE INTO human_call_credit (k, centitoken_seconds, updated_at) VALUES (1,0,0)");
    // [MESSENGER-CALL-BILLING-FOUNDATION] Separate daily allowance and
    // fractional paid-time state. Never reuse human_call_usage/credit: those
    // tables implement the superseded monthly, per-seat human-call product.
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS messenger_audio_daily_usage (day TEXT PRIMARY KEY, participant_seconds INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS messenger_call_credit (k INTEGER PRIMARY KEY, centitoken_seconds INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
    );
    this.sql.exec("INSERT OR IGNORE INTO messenger_call_credit (k, centitoken_seconds, updated_at) VALUES (1,0,0)");
    // [AVA-CAMP-B1-WALLET] Escrow reservations, keyed by caller-supplied `ref`
    // (e.g. campaign_call_attempts.attempt_uuid). Brand-new table, additive only
    // — does not touch `bal`/`acct`/`holds`/`ops`.
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS resv (ref TEXT PRIMARY KEY, reserved INTEGER NOT NULL DEFAULT 0, spent INTEGER NOT NULL DEFAULT 0, released INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    );
    // [AI-BILLING-CORE-1] finding 3: additive column so the lazy reaper (below)
    // can emit a real uid on its audit/telemetry rows instead of a synthetic
    // "server" actor. Self-migrating (ALTER throws once the column exists;
    // that's expected and swallowed), same pattern as acct.bonus above.
    try { this.sql.exec("ALTER TABLE resv ADD COLUMN uid TEXT NOT NULL DEFAULT ''"); } catch { /* column already exists */ }
    // [AI-WALLET-SPENDABLE-2] Persist the admission POLICY a reservation was
    // created under (0 = allow_free:false / paid-only escrow, 1 = allow_free:
    // true / internal AI-and-feature cost) so `consume_reserved`/`settle_ai_cost`
    // can reject an attempt to consume it under a DIFFERENT policy than it was
    // reserved with — the exact cross-policy confusion §58 warns about.
    try { this.sql.exec("ALTER TABLE resv ADD COLUMN allow_free INTEGER NOT NULL DEFAULT 0"); } catch { /* column already exists */ }
    // [AI-WALLET-SPENDABLE-2] Bounded, caller-supplied expiry for AI-job
    // reservations (`ref LIKE 'aijob:%'`). 0 = no explicit expiry (campaign
    // escrow keeps its own explicit release/consume lifecycle and is NEVER
    // reaped by expires_at or the aijob-only reaper below).
    try { this.sql.exec("ALTER TABLE resv ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0"); } catch { /* column already exists */ }
    // [AI-BUDGET-AUTH-1] Atomic, per-account daily AI budget reservations.
    // A request first reserves its maximum budget, then settles actual usage or
    // releases. Keeping request rows makes retries idempotent and lets concurrent
    // admissions see each other's headroom synchronously inside this DO.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS ai_daily_budget (
         request_id TEXT PRIMARY KEY,
         day TEXT NOT NULL,
         status TEXT NOT NULL,
         input_reserved INTEGER NOT NULL DEFAULT 0,
         output_reserved INTEGER NOT NULL DEFAULT 0,
         cost_reserved INTEGER NOT NULL DEFAULT 0,
         input_actual INTEGER NOT NULL DEFAULT 0,
         output_actual INTEGER NOT NULL DEFAULT 0,
         cost_actual INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );
    // [AI-BUDGET-AUTH-2 / B4] Self-migrating additive column, same idiom as
    // acct.bonus / resv.uid / resv.expires_at above. 0 = no bound (pre-
    // migration rows only — every reservation created from now on always
    // gets a real value at insert time).
    try { this.sql.exec("ALTER TABLE ai_daily_budget ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0"); } catch { /* column already exists */ }
    this.sql.exec("CREATE INDEX IF NOT EXISTS idx_ai_daily_budget_day ON ai_daily_budget(day, status)");
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS ai_unrecovered_budget (
         request_id TEXT PRIMARY KEY,
         day TEXT NOT NULL,
         status TEXT NOT NULL,
         amount_reserved INTEGER NOT NULL DEFAULT 0,
         amount_actual INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );
    // [AI-BUDGET-AUTH-2 / B4] Same additive expiry column as ai_daily_budget above.
    try { this.sql.exec("ALTER TABLE ai_unrecovered_budget ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0"); } catch { /* column already exists */ }
    this.sql.exec("CREATE INDEX IF NOT EXISTS idx_ai_unrecovered_budget_day ON ai_unrecovered_budget(day, status)");
  }

  /** Replay guard: return the stored result for a seen op_id, else null. */
  private seenOp(opId: string | undefined): Response | null {
    if (!opId) return null;
    const rows = this.sql.exec("SELECT result FROM ops WHERE op_id=?1", opId).toArray() as any[];
    if (!rows.length) return null;
    return json({ ...JSON.parse(String(rows[0].result)), duplicate: true });
  }

  private recordOp(opId: string | undefined, result: object): void {
    if (!opId) return;
    this.sql.exec("INSERT OR IGNORE INTO ops (op_id, result, ts) VALUES (?1,?2,?3)", opId, JSON.stringify(result), Date.now());
    // Lazy prune of old generic dedupe rows. Listing operations are deliberately
    // excluded: listing_billing stores the same namespaced operation in D1 so a
    // publish retry months later must replay the original debit result rather
    // than risk issuing a second debit after this cache was pruned.
    this.sql.exec("DELETE FROM ops WHERE ts < ?1 AND op_id NOT LIKE 'listing:%'", Date.now() - OPS_TTL_MS);
  }

  private bal(): { balance: number; held: number } {
    const r = this.sql.exec("SELECT balance, held FROM bal WHERE k=1").one() as any;
    return { balance: Number(r.balance), held: Number(r.held) };
  }

  private setBal(balance: number, held: number): void {
    this.sql.exec("UPDATE bal SET balance=?1, held=?2 WHERE k=1", balance, held);
  }

  private acct(): { free: number; premium: number; last_grant_day: string; bonus: number; debt_micro_usd: number } {
    const r = this.sql.exec("SELECT free, premium, last_grant_day, bonus, debt_micro_usd FROM acct WHERE k=1").one() as any;
    return {
      free: Number(r.free), premium: Number(r.premium), last_grant_day: String(r.last_grant_day),
      bonus: Number(r.bonus ?? 0), debt_micro_usd: Number(r.debt_micro_usd ?? 0),
    };
  }

  // Free-coin daily grant. Non-premium users get DAILY_FREE_GRANT reset (NOT added
  // — no rollover) on the first touch of a new UTC day. Premium users never hold
  // free coins. Called on every DO touch, so it self-heals without a cron.
  private maybeGrant(): void {
    const a = this.acct();
    if (a.premium) {
      if (a.free !== 0) this.sql.exec("UPDATE acct SET free=0 WHERE k=1");
      return;
    }
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    if (a.last_grant_day !== today) {
      this.sql.exec("UPDATE acct SET free=?1, last_grant_day=?2 WHERE k=1", DAILY_FREE_GRANT, today);
    }
  }

  // Full balance snapshot the client sees: paid `balance`, `held`, promo `free`
  // (daily grant + persistent bonus combined, so existing clients render the
  // welcome bonus with no change), `bonus` (the persistent slice alone),
  // `premium`, `spendable` = free + bonus + paid, and `debt_micro_usd` (a
  // sub-cent AI-cost remainder, invariant 0 <= debt_micro_usd < 10,000 —
  // exposed for observability/support; it does NOT reduce `spendable`, since
  // by construction it can never reach a whole token).
  private snap(): { balance: number; held: number; free: number; bonus: number; premium: number; spendable: number; debt_micro_usd: number } {
    const b = this.bal();
    const a = this.acct();
    return {
      balance: b.balance, held: b.held, free: a.free + a.bonus, bonus: a.bonus, premium: a.premium,
      spendable: a.free + a.bonus + b.balance, debt_micro_usd: a.debt_micro_usd,
    };
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") === "websocket") return this.handleWs();

    let body: any = {};
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const uid: string = body.uid || "";

    // Lazily release matured holds + apply the daily free-coin grant on every touch.
    this.releaseMatured();
    this.maybeGrant();

    // Idempotency at the authority: replay of a seen op_id returns the original
    // result without re-applying (and without re-emitting the ledger row).
    if (
      body.op === "credit" || body.op === "spend" || body.op === "earn" || body.op === "debit_hold" || body.op === "promo_credit" ||
      body.op === "hard_reset" || // [TOKENS-100-GRANT-1] one-time balance reset (idempotent per op_id)
      body.op === "reserve" || body.op === "consume_reserved" || body.op === "release_reservation" || // [AVA-CAMP-B1-WALLET]
      body.op === "settle_ai_cost" || body.op === "clear_ai_remainder" || // [AI-WALLET-SPENDABLE-2]
      body.op === "ai_budget_reserve" || body.op === "ai_budget_settle" ||
      body.op === "ai_budget_release" || body.op === "ai_unrecovered_reserve" ||
      body.op === "ai_unrecovered_settle" || body.op === "ai_unrecovered_release" // [AI-BUDGET-AUTH-1]
      || body.op === "call_usage_consume" // [HUMAN-CALL-POOL-1]
      || body.op === "messenger_call_usage_consume" // [MESSENGER-CALL-BILLING-FOUNDATION]
    ) {
      const dup = this.seenOp(body.op_id);
      if (dup) return dup;
    }

    switch (body.op) {
      case "balance": return json({ ...this.snap(), uid });
      case "credit": return this.credit(uid, body);
      case "promo_credit": return this.promoCredit(uid, body); // [WELCOME-100-1] persistent promo bucket
      case "hard_reset": return this.hardReset(uid, body); // [TOKENS-100-GRANT-1] one-time balance reset to a fixed amount
      case "spend": return this.spend(uid, body);
      case "earn": return this.earn(uid, body);
      case "debit_hold": return this.debitHold(uid, body); // refund clawback within hold
      case "release": { const released = this.releaseMatured(); return json({ released, ...this.bal() }); }
      // [AVA-CAMP-B1-WALLET] Outbound-campaign escrow (§5). "release_reservation"
      // (not "release") to avoid colliding with the existing hold-release op above.
      case "reserve": return this.reserve(uid, body);
      case "consume_reserved": return this.consumeReserved(uid, body);
      case "release_reservation": return this.releaseReservation(uid, body);
      // [AI-WALLET-SPENDABLE-2]
      case "settle_ai_cost": return this.settleAiCost(uid, body);
      case "ai_budget_reserve": return this.aiBudgetReserve(body);
      case "ai_budget_settle": return this.aiBudgetSettle(body);
      case "ai_budget_release": return this.aiBudgetRelease(body);
      case "ai_unrecovered_status": return this.aiUnrecoveredStatus(body);
      case "ai_unrecovered_reserve": return this.aiUnrecoveredReserve(body);
      case "ai_unrecovered_settle": return this.aiUnrecoveredSettle(body);
      case "ai_unrecovered_release": return this.aiUnrecoveredRelease(body);
      case "clear_ai_remainder": return this.clearAiRemainder(uid, body);
      case "call_usage_consume": return this.consumeHumanCallUsage(uid, body);
      case "messenger_call_usage_consume": return this.consumeMessengerCallUsage(uid, body);
      case "messenger_call_usage_status": return this.messengerCallUsageStatus(uid, body);
      case "messenger_call_reservation_status": return this.messengerCallReservationStatus(uid, body);
      default: return json({ error: "unknown op" }, 400);
    }
  }

  // Immediate spendable credit (topup, refund).
  private async credit(uid: string, b: any): Promise<Response> {
    const amount = Math.trunc(Number(b.amount));
    if (!(amount > 0)) return json({ error: "amount>0 required" }, 400);
    const cur = this.bal();
    const balance = cur.balance + amount;
    this.setBal(balance, cur.held);
    // First real top-up flips the user to sticky premium: stop the daily free
    // grant and zero any remaining free coins (Specs: paid users pay-as-they-go).
    if (b.type === "topup") this.sql.exec("UPDATE acct SET premium=1, free=0 WHERE k=1");
    const result = { ok: true, ...this.snap() };
    this.recordOp(b.op_id, result);
    await this.audit(uid, { type: b.type || "topup", amount, balance_after: balance, app_name: b.app_name, ref: b.ref, ...txMeta(b) }, b);
    this.broadcast();
    return json(result);
  }

  // [WELCOME-100-1] Credit the PERSISTENT promo bucket (welcome bonus). Never
  // touches paid `balance`, so promo grants can never be paid out — only spent
  // on allow_free feature costs (drawn after the daily free coins). Idempotent
  // via op_id like every mutating op.
  private async promoCredit(uid: string, b: any): Promise<Response> {
    const amount = Math.trunc(Number(b.amount));
    if (!(amount > 0)) return json({ error: "amount>0 required" }, 400);
    this.sql.exec("UPDATE acct SET bonus=bonus+?1 WHERE k=1", amount);
    const result = { ok: true, ...this.snap() };
    this.recordOp(b.op_id, result);
    await this.audit(uid, { type: b.type || "promo", amount, balance_after: this.snap().spendable, app_name: b.app_name, ref: b.ref, ...txMeta(b) }, b);
    this.broadcast();
    return json(result);
  }

  // [TOKENS-100-GRANT-1] HARD RESET the entire wallet to exactly `amount` spendable
  // tokens, delivered as the persistent welcome/promo bucket (so it behaves like the
  // one-time "join and explore" grant and never funds a payout). This is a
  // DESTRUCTIVE operation used ONLY by the one-time owner-directed reset (routes/
  // token_reset.ts, admin/secret-gated) — it ZEROES paid `balance`, `held`, the daily
  // `free` bucket AND all outstanding 7-day earning holds, then sets `bonus` = amount.
  // premium is cleared so every account lands in the same fresh "explore" state.
  // last_grant_day is pinned to today so maybeGrant() cannot re-grant on this touch.
  // [AI-WALLET-SPENDABLE-2] A hard reset means a genuinely FRESH grant: it also
  // zeroes the sub-cent `debt_micro_usd` remainder and releases every outstanding
  // AI-job reservation (`ref LIKE 'aijob:%'`) for this uid, so neither can eat into
  // the new balance via a later settle_ai_cost/consume_reserved call. Campaign
  // escrow reservations are NEVER touched here — they keep their own explicit
  // lifecycle. The cleared remainder is recorded in the audit metadata.
  // Idempotent on op_id (`hardreset:v1:<uid>`), so a re-run of the backfill no-ops.
  private async hardReset(uid: string, b: any): Promise<Response> {
    const amount = Math.max(0, Math.trunc(Number(b.amount ?? 100)));
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const clearedDebtMicroUsd = this.acct().debt_micro_usd;
    this.setBal(0, 0);
    this.sql.exec("DELETE FROM holds");
    this.sql.exec("UPDATE acct SET free=0, premium=0, bonus=?1, last_grant_day=?2, debt_micro_usd=0 WHERE k=1", amount, today);
    // [HUMAN-CALL-POOL-1] A hard wallet reset is a fresh account baseline;
    // never carry prepaid call credit or prior monthly usage into it.
    this.sql.exec("DELETE FROM human_call_usage");
    this.sql.exec("UPDATE human_call_credit SET centitoken_seconds=0, updated_at=?1 WHERE k=1", Date.now());
    const releasedRows = this.sql.exec(
      "SELECT ref FROM resv WHERE released=0 AND reserved>0 AND ref LIKE 'aijob:%'",
    ).toArray() as any[];
    if (releasedRows.length) {
      this.sql.exec("UPDATE resv SET reserved=0, released=1, updated_at=?1 WHERE released=0 AND ref LIKE 'aijob:%'", Date.now());
    }
    const result = {
      ok: true, ...this.snap(),
      cleared_debt_micro_usd: clearedDebtMicroUsd, released_ai_reservations: releasedRows.length,
    };
    this.recordOp(b.op_id, result);
    await this.audit(uid, {
      type: "adjustment", amount, balance_after: this.snap().spendable, app_name: "token_hard_reset", ref: b.ref,
      cleared_debt_micro_usd: clearedDebtMicroUsd, released_ai_reservations: releasedRows.length,
    }, b);
    this.broadcast();
    return json(result);
  }

  // Atomic debit. Refuses to go negative.
  //   b.allow_free === true  → AI/feature cost: spend promo FREE coins first, then
  //                            paid. (Internal cost; never a seller payout.)
  //   otherwise              → real money (marketplace/payout): PAID balance only,
  //                            so promotional coins can never fund a payout.
  private async spend(uid: string, b: any): Promise<Response> {
    const amount = Math.trunc(Number(b.amount));
    if (!(amount > 0)) return json({ error: "amount>0 required" }, 400);
    const a = this.acct();
    const cur = this.bal();
    const allowFree = b.allow_free === true;

    let freeUsed = 0;
    let bonusUsed = 0; // [WELCOME-100-1] persistent promo bucket, drawn after daily free
    let paidUsed = amount;
    if (allowFree) {
      const total = a.free + a.bonus + cur.balance;
      if (total < amount) return json({ error: "insufficient balance", ...this.snap() }, 402);
      freeUsed = Math.min(a.free, amount);
      bonusUsed = Math.min(a.bonus, amount - freeUsed);
      paidUsed = amount - freeUsed - bonusUsed;
    } else if (cur.balance < amount) {
      return json({ error: "insufficient balance", ...this.snap() }, 402);
    }

    if (freeUsed > 0) this.sql.exec("UPDATE acct SET free=free-?1 WHERE k=1", freeUsed);
    if (bonusUsed > 0) this.sql.exec("UPDATE acct SET bonus=bonus-?1 WHERE k=1", bonusUsed);
    const balance = cur.balance - paidUsed;
    this.setBal(balance, cur.held);

    const txType = b.type === "payout" || b.type === "refund" ? b.type : "spend";
    const result = { ok: true, ...this.snap(), free_used: freeUsed, bonus_used: bonusUsed, paid_used: paidUsed };
    this.recordOp(b.op_id, result);
    await this.audit(uid, { type: txType, amount: -amount, balance_after: this.snap().spendable, app_name: b.app_name, counterparty_uid: b.counterparty_uid, ref: b.ref, ...txMeta(b) }, b);
    this.broadcast();
    return json(result);
  }

  /**
   * [HUMAN-CALL-POOL-1] Consume connected participant seconds for the new,
   * explicitly opt-in human-call billing lane. This lives inside WalletDO so
   * allowance, fractional overage credit and wallet debit are one serialized
   * operation per account. Legacy paid-call escrow remains untouched/dark.
   */
  private async consumeHumanCallUsage(uid: string, b: any): Promise<Response> {
    let enabled = false;
    try { enabled = (await readConfig(this.env)).humanCallParticipantBillingEnabled === true; } catch {
      // A config outage must never turn a dark/unknown rollout into an
      // unexpected charge. The call remains usable and the caller can retry a
      // later tick once the flag is readable.
      const result = { ok: true, metered: false, disconnect: false, reason: "config_unavailable" };
      this.recordOp(b.op_id, result);
      return json(result);
    }
    if (!enabled) {
      const result = { ok: true, metered: false, disconnect: false, reason: "feature_disabled" };
      this.recordOp(b.op_id, result);
      return json(result);
    }

    const participantSeconds = Math.trunc(Number(b.participant_seconds));
    const media = b.media === "video" ? "video" : b.media === "audio" ? "audio" : null;
    // This is an internal operation, but keep a hard bound so a compromised
    // caller cannot submit an accidental multi-year debit in one op.
    if (!Number.isFinite(participantSeconds) || participantSeconds < 1 || participantSeconds > 86_400 || !media) {
      return json({ error: "participant_seconds 1..86400 and media audio|video required" }, 400);
    }

    const period = new Date().toISOString().slice(0, 7);
    const usageRow = this.sql.exec(
      "SELECT participant_seconds FROM human_call_usage WHERE period=?1", period,
    ).toArray()[0] as any;
    const priorParticipantSeconds = Number(usageRow?.participant_seconds ?? 0);
    const creditRow = this.sql.exec(
      "SELECT centitoken_seconds FROM human_call_credit WHERE k=1",
    ).one() as any;
    const priorCentitokenSeconds = Number(creditRow?.centitoken_seconds ?? 0);
    const math = computeHumanCallUsage({
      priorParticipantSeconds,
      priorCentitokenSeconds,
      participantSeconds,
      media,
    });
    const spendable = this.snap().spendable;

    // Do not partially commit a tick that crosses into an unpaid token. The
    // participant is disconnected by the owning call room, while already
    // settled ticks remain durable and all other participants continue.
    if (math.tokensToFund > spendable) {
      const now = Date.now();
      // A tick may straddle the free-pool boundary. Commit the free portion
      // before refusing the unpaid overage, otherwise a caller that retries
      // with short ticks could reuse the same final free seconds forever.
      if (math.freeSecondsApplied > 0) {
        this.sql.exec(
          "INSERT INTO human_call_usage (period, participant_seconds, updated_at) VALUES (?1,?2,?3) " +
          "ON CONFLICT(period) DO UPDATE SET participant_seconds=participant_seconds+excluded.participant_seconds, updated_at=excluded.updated_at",
          period, math.freeSecondsApplied, now,
        );
      }
      const result = {
        ok: false, metered: true, disconnect: true, exhausted: true,
        error: "insufficient_balance", reason: "insufficient_balance",
        participant_seconds_requested: participantSeconds,
        participant_seconds_total: priorParticipantSeconds + math.freeSecondsApplied,
        free_seconds_used: math.freeSecondsApplied,
        overage_seconds_denied: math.overageSeconds,
        free_seconds_remaining: Math.max(0, HUMAN_CALL_FREE_PARTICIPANT_SECONDS - priorParticipantSeconds - math.freeSecondsApplied),
        tokens_due: math.tokensToFund,
        spendable,
        centitoken_seconds: priorCentitokenSeconds,
      };
      this.recordOp(b.op_id, result);
      Promise.resolve(track(this.env, uid, "human_call_usage_blocked", "human_call", {
        ref: b.ref, media, participant_seconds: participantSeconds,
        participant_seconds_total: priorParticipantSeconds + math.freeSecondsApplied, tokens_due: math.tokensToFund,
        spendable, reason: "insufficient_balance",
      })).catch(() => {});
      return json(result, 402);
    }

    const a = this.acct();
    const cur = this.bal();
    const tokensDue = math.tokensToFund;
    const freeUsed = Math.min(a.free, tokensDue);
    const bonusUsed = Math.min(a.bonus, tokensDue - freeUsed);
    const paidUsed = tokensDue - freeUsed - bonusUsed;
    if (freeUsed > 0) this.sql.exec("UPDATE acct SET free=free-?1 WHERE k=1", freeUsed);
    if (bonusUsed > 0) this.sql.exec("UPDATE acct SET bonus=bonus-?1 WHERE k=1", bonusUsed);
    if (paidUsed > 0) this.setBal(cur.balance - paidUsed, cur.held);

    const now = Date.now();
    this.sql.exec(
      "INSERT INTO human_call_usage (period, participant_seconds, updated_at) VALUES (?1,?2,?3) " +
      "ON CONFLICT(period) DO UPDATE SET participant_seconds=participant_seconds+excluded.participant_seconds, updated_at=excluded.updated_at",
      period, participantSeconds, now,
    );
    this.sql.exec(
      "UPDATE human_call_credit SET centitoken_seconds=?1, updated_at=?2 WHERE k=1",
      math.centitokenSecondsRemainder, now,
    );
    const result = {
      ok: true, metered: true, disconnect: false,
      participant_seconds: participantSeconds,
      participant_seconds_total: math.participantSecondsTotal,
      free_seconds_used: math.freeSecondsApplied,
      free_seconds_remaining: Math.max(0, HUMAN_CALL_FREE_PARTICIPANT_SECONDS - math.participantSecondsTotal),
      overage_seconds: math.overageSeconds,
      tokens_charged: tokensDue,
      free_used: freeUsed, bonus_used: bonusUsed, paid_used: paidUsed,
      centitoken_seconds: math.centitokenSecondsRemainder,
    };
    this.recordOp(b.op_id, result);
    if (tokensDue > 0) {
      await this.audit(uid, {
        type: "human_call_overage", amount: -tokensDue,
        balance_after: this.snap().spendable, app_name: "human_call", ref: b.ref,
        context: media, duration_sec: participantSeconds,
        rate_per_min: media === "video" ? 0.10 : 0.05,
      }, b);
      Promise.resolve(track(this.env, uid, "human_call_usage_billed", "human_call", {
        ref: b.ref, media, participant_seconds: participantSeconds,
        participant_seconds_total: math.participantSecondsTotal,
        tokens_charged: tokensDue, overage_seconds: math.overageSeconds,
      })).catch(() => {});
      this.broadcast();
    }
    return json(result);
  }

  /**
   * [MESSENGER-CALL-BILLING-FOUNDATION] Atomic caller-funded Messenger tick.
   *
   * This operation is separate from consumeHumanCallUsage(): the latter is
   * the dark legacy monthly/per-seat meter. This operation owns one payer's
   * daily audio allowance, fractional paid remainder, and caller-only token
   * debit in one serialized WalletDO transaction. The callee is never accepted
   * as a payer input. A future call authority must provide the frozen rate and
   * price version from its authorization record.
   */
  private async consumeMessengerCallUsage(uid: string, b: any): Promise<Response> {
    if (b.payer_uid !== undefined || b.callee_uid !== undefined) {
      return json({ error: "payer and callee wallet identities are authority-bound" }, 400);
    }
    let enabled = false;
    try { enabled = (await readConfig(this.env)).messengerCallBillingEnabled === true; } catch {
      return json({ ok: false, metered: false, disconnect: false, reason: "config_unavailable" }, 503);
    }
    if (!enabled) {
      const result = { ok: false, metered: false, disconnect: false, reason: "feature_disabled" };
      this.recordOp(b.op_id, result);
      return json(result, 409);
    }

    const opId = typeof b.op_id === "string" ? b.op_id : "";
    const callId = typeof b.call_id === "string" ? b.call_id : "";
    const authorizationId = typeof b.authorization_id === "string" ? b.authorization_id : "";
    const day = typeof b.day === "string" ? b.day : "";
    const media = b.media === "audio" || b.media === "video" ? b.media as MessengerMedia : null;
    const quality = typeof b.quality_sku === "string" ? b.quality_sku as MessengerQualitySku : null;
    const wallSeconds = Math.trunc(Number(b.wall_seconds));
    const rate = Math.trunc(Number(b.rate_centitokens_per_participant_minute));
    const dailyAllowance = Math.trunc(Number(b.daily_audio_allowance_participant_seconds));
    const priceVersion = Math.trunc(Number(b.price_version));
    if (!opId || opId.length > 256 || !callId || callId.length > 256 || !authorizationId || authorizationId.length > 256) {
      return json({ error: "op_id, call_id and authorization_id are required" }, 400);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: "day must be YYYY-MM-DD" }, 400);
    if (!media || !quality) return json({ error: "media and quality_sku are required" }, 400);
    if ((media === "audio" && quality !== "audio") || (media === "video" && !["video_sd", "video_hd", "video_2k", "video_4k"].includes(quality))) {
      return json({ error: "media and quality_sku mismatch" }, 400);
    }
    if (!Number.isInteger(wallSeconds) || wallSeconds < 1 || wallSeconds > 86_400) {
      return json({ error: "wall_seconds must be 1..86400" }, 400);
    }
    if (!Number.isInteger(rate) || rate < 0 || !Number.isInteger(dailyAllowance) || dailyAllowance < 0 || !Number.isInteger(priceVersion) || priceVersion < 1) {
      return json({ error: "invalid frozen Messenger billing contract" }, 400);
    }
    if (typeof b.allow_free !== "boolean") return json({ error: "allow_free boolean required" }, 400);
    const reservationRef = typeof b.reservation_ref === "string" && b.reservation_ref.length > 0
      ? b.reservation_ref : null;

    const usageRow = this.sql.exec(
      "SELECT participant_seconds FROM messenger_audio_daily_usage WHERE day=?1", day,
    ).toArray()[0] as any;
    const priorDaily = Math.max(0, Number(usageRow?.participant_seconds ?? 0));
    const creditRow = this.sql.exec(
      "SELECT centitoken_seconds FROM messenger_call_credit WHERE k=1",
    ).one() as any;
    const priorCredit = Math.max(0, Number(creditRow?.centitoken_seconds ?? 0));

    // Cloudflare is the free-audio provider only. Its frozen rate is zero and
    // it must stop at the daily allowance boundary rather than falling into a
    // paid Cloudflare suffix. Keep this branch separate from the paid
    // calculator so a zero rate can never be interpreted as free overage.
    if (media === "audio" && rate === 0) {
      const participantSeconds = wallSeconds * 2;
      const freeParticipantSeconds = Math.min(participantSeconds, Math.max(0, dailyAllowance - priorDaily));
      const paidParticipantSeconds = participantSeconds - freeParticipantSeconds;
      const now = Date.now();
      if (freeParticipantSeconds > 0) {
        this.sql.exec(
          "INSERT INTO messenger_audio_daily_usage (day, participant_seconds, updated_at) VALUES (?1,?2,?3) " +
          "ON CONFLICT(day) DO UPDATE SET participant_seconds=participant_seconds+excluded.participant_seconds, updated_at=excluded.updated_at",
          day, freeParticipantSeconds, now,
        );
      }
      const base = {
        metered: true, exhausted: paidParticipantSeconds > 0,
        participant_seconds: freeParticipantSeconds,
        daily_allowance_participant_seconds_total: priorDaily + freeParticipantSeconds,
        free_participant_seconds: freeParticipantSeconds,
        paid_participant_seconds_denied: paidParticipantSeconds,
        daily_audio_allowance_remaining: Math.max(0, dailyAllowance - priorDaily - freeParticipantSeconds),
        tokens_due: 0, available: 0, reservation_required: false, reservation_remaining: 0,
        call_id: callId, authorization_id: authorizationId, day, price_version: priceVersion,
      };
      if (paidParticipantSeconds > 0) {
        const result = { ok: false, ...base, disconnect: true, reason: "free_allowance_exhausted", error: "free audio allowance exhausted" };
        this.recordOp(opId, result);
        return json(result, 402);
      }
      const result = { ok: true, ...base, disconnect: false, paid_participant_seconds: 0, charged_centitoken_seconds: 0, tokens_charged: 0 };
      this.recordOp(opId, result);
      return json(result);
    }

    let math;
    try {
      math = computeCallerFundedTick({
        priorDailyParticipantSeconds: priorDaily,
        priorCentitokenSeconds: priorCredit,
        wallSeconds,
        participantCount: 2,
        dailyAudioAllowanceParticipantSeconds: dailyAllowance,
        media,
        rateCentitokensPerParticipantMinute: rate,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid Messenger billing contract";
      const code = message.includes("non-zero rate") ? "pricing_unavailable" : "invalid_billing_contract";
      return json({ ok: false, metered: false, disconnect: false, reason: code, error: message }, 409);
    }

    const a = this.acct();
    const cur = this.bal();
    const tokensDue = math.tokensToFund;
    // Paid connected time is admissible only against the reservation created
    // by authorization. A stale balance read or an unreserved direct tick must
    // never turn an insufficient-boundary result into billable paid seconds.
    const reservation = reservationRef ? this.getResv(reservationRef) : null;
    const reservationRemaining = reservation && !reservation.released
      ? Math.max(0, reservation.reserved) : 0;
    const available = Math.min(cur.balance, reservationRemaining);
    if (tokensDue > 0 && (!reservationRef || !reservation || reservation.released || reservation.allow_free !== 0 || tokensDue > available)) {
      if (math.freeParticipantSeconds > 0) {
        this.sql.exec(
          "INSERT INTO messenger_audio_daily_usage (day, participant_seconds, updated_at) VALUES (?1,?2,?3) " +
          "ON CONFLICT(day) DO UPDATE SET participant_seconds=participant_seconds+excluded.participant_seconds, updated_at=excluded.updated_at",
          day, math.freeParticipantSeconds, Date.now(),
        );
      }
      const result = {
        ok: false, metered: true, disconnect: true, exhausted: true,
        reason: !reservationRef ? "reservation_required" : "insufficient_balance",
        error: !reservationRef ? "paid time requires an active caller reservation" : "insufficient_balance",
        participant_seconds: math.participantSeconds,
        daily_allowance_participant_seconds_total: math.dailyAllowanceParticipantSecondsTotal,
        free_participant_seconds: math.freeParticipantSeconds,
        paid_participant_seconds_denied: math.paidParticipantSeconds,
        daily_audio_allowance_remaining: math.dailyAudioAllowanceRemaining,
        tokens_due: tokensDue, available,
        reservation_required: !reservationRef,
        reservation_remaining: reservationRemaining,
      };
      this.recordOp(opId, result);
      return json(result, 402);
    }

    const freeUsed = tokensDue > 0 ? 0 : (b.allow_free ? Math.min(a.free, tokensDue) : 0);
    const bonusUsed = tokensDue > 0 ? 0 : (b.allow_free ? Math.min(a.bonus, tokensDue - freeUsed) : 0);
    const paidUsed = tokensDue - freeUsed - bonusUsed;
    if (freeUsed > 0) this.sql.exec("UPDATE acct SET free=free-?1 WHERE k=1", freeUsed);
    if (bonusUsed > 0) this.sql.exec("UPDATE acct SET bonus=bonus-?1 WHERE k=1", bonusUsed);
    if (paidUsed > 0) this.setBal(cur.balance - paidUsed, cur.held);
    if (paidUsed > 0 && reservationRef) {
      this.sql.exec(
        "UPDATE resv SET reserved=reserved-?1, spent=spent+?1, updated_at=?2 WHERE ref=?3 AND released=0 AND reserved>=?1",
        paidUsed, Date.now(), reservationRef,
      );
    }

    const now = Date.now();
    if (math.freeParticipantSeconds > 0) {
      this.sql.exec(
        "INSERT INTO messenger_audio_daily_usage (day, participant_seconds, updated_at) VALUES (?1,?2,?3) " +
        "ON CONFLICT(day) DO UPDATE SET participant_seconds=participant_seconds+excluded.participant_seconds, updated_at=excluded.updated_at",
        day, math.freeParticipantSeconds, now,
      );
    }
    this.sql.exec(
      "UPDATE messenger_call_credit SET centitoken_seconds=?1, updated_at=?2 WHERE k=1",
      math.centitokenSecondsRemainder, now,
    );
    const result = {
      ok: true, metered: true, disconnect: false,
      participant_seconds: math.participantSeconds,
      daily_allowance_participant_seconds_total: math.dailyAllowanceParticipantSecondsTotal,
      free_participant_seconds: math.freeParticipantSeconds,
      paid_participant_seconds: math.paidParticipantSeconds,
      charged_centitoken_seconds: math.chargedCentitokenSeconds,
      daily_audio_allowance_remaining: math.dailyAudioAllowanceRemaining,
      tokens_charged: tokensDue, free_used: freeUsed, bonus_used: bonusUsed, paid_used: paidUsed,
      centitoken_seconds_remainder: math.centitokenSecondsRemainder,
      call_id: callId, authorization_id: authorizationId, day, price_version: priceVersion,
      reservation_ref: reservationRef,
      reservation_remaining: reservationRef ? Math.max(0, Number(this.getResv(reservationRef)?.reserved ?? 0)) : 0,
    };
    this.recordOp(opId, result);
    if (tokensDue > 0) {
      await this.audit(uid, {
        type: "messenger_call_overage", amount: -tokensDue,
        balance_after: this.snap().spendable, app_name: "messenger_call",
        ref: `messenger-call:${authorizationId}`, context: quality,
        duration_sec: wallSeconds, rate_per_min: rate / 100,
      }, b);
      this.broadcast();
    }
    return json(result);
  }

  /** Read-only caller-owned daily allowance state; no callee identity accepted. */
  private async messengerCallUsageStatus(uid: string, b: any): Promise<Response> {
    if (b.payer_uid !== undefined || b.callee_uid !== undefined) {
      return json({ error: "payer and callee wallet identities are authority-bound" }, 400);
    }
    const day = typeof b.day === "string" ? b.day : "";
    const allowance = Math.trunc(Number(b.daily_audio_allowance_participant_seconds));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isInteger(allowance) || allowance < 0) {
      return json({ error: "valid day and allowance are required" }, 400);
    }
    const row = this.sql.exec("SELECT participant_seconds FROM messenger_audio_daily_usage WHERE day=?1", day).one() as any;
    const used = Math.max(0, Number(row?.participant_seconds ?? 0));
    const balance = this.snap();
    return json({
      ok: true, uid, day,
      daily_audio_allowance_participant_seconds: allowance,
      daily_allowance_participant_seconds_used: used,
      daily_audio_allowance_remaining: Math.max(0, allowance - used),
      spendable_tokens: balance.spendable,
    });
  }

  /** Read-only reservation state for the Messenger billing authority. The
   * WalletDO remains the sole source of reserved capacity and spendable funds;
   * no client-provided payer/callee identity is accepted. */
  private async messengerCallReservationStatus(uid: string, b: any): Promise<Response> {
    if (b.payer_uid !== undefined || b.callee_uid !== undefined) {
      return json({ error: "payer and callee wallet identities are authority-bound" }, 400);
    }
    const ref = typeof b.reservation_ref === "string" ? b.reservation_ref.trim() : "";
    if (!ref || ref.length > 256) return json({ error: "reservation_ref required" }, 400);
    const row = this.getResv(ref);
    const balance = this.snap();
    if (!row) return json({ ok: false, error: "reservation_not_found", ref, spendable_tokens: balance.spendable }, 404);
    return json({
      ok: true, uid, ref, released: row.released !== 0,
      reserved_tokens: Math.max(0, row.reserved), spent_tokens: Math.max(0, row.spent),
      expires_at: row.expires_at, spendable_tokens: balance.spendable,
    });
  }

  // Earn into a 7-day hold (not spendable until matured). commission already deducted
  // by the caller; `amount` is the net credited to the creator.
  private async earn(uid: string, b: any): Promise<Response> {
    const amount = Math.trunc(Number(b.amount));
    if (!(amount > 0)) return json({ error: "amount>0 required" }, 400);
    const cur = this.bal();
    const held = cur.held + amount;
    this.setBal(cur.balance, held);
    // Commercial marketplace settlements may snapshot a different payout hold
    // at checkout. Existing callers omit hold_hours and retain the legacy
    // seven-day hold byte-for-byte.
    const requestedHoldHours = Number(b.hold_hours);
    const holdMs = Number.isFinite(requestedHoldHours)
      && requestedHoldHours >= 0
      && requestedHoldHours <= 365 * 24
      ? Math.trunc(requestedHoldHours * 3_600_000)
      : HOLD_MS;
    const availableAt = Date.now() + holdMs;
    const id = crypto.randomUUID();
    this.sql.exec("INSERT INTO holds (id, amount, available_at, released) VALUES (?1,?2,?3,0)", id, amount, availableAt);
    await this.state.storage.setAlarm(availableAt);
    const result = { ok: true, balance: cur.balance, held, available_at: availableAt };
    this.recordOp(b.op_id, result);
    await this.audit(uid, { type: "earn", amount, balance_after: cur.balance, app_name: b.app_name, counterparty_uid: b.counterparty_uid, commission: Math.trunc(Number(b.commission || 0)), ref: b.ref, hold_until: availableAt }, b);
    this.broadcast();
    return json(result);
  }

  // Claw back from the held pool (refund of a still-held earning). Removes matching
  // unreleased holds first; floors at 0.
  private async debitHold(uid: string, b: any): Promise<Response> {
    const amount = Math.trunc(Number(b.amount));
    if (!(amount > 0)) return json({ error: "amount>0 required" }, 400);
    const cur = this.bal();
    const take = Math.min(amount, cur.held);
    this.setBal(cur.balance, cur.held - take);
    // Drop newest unreleased holds covering `take` (best-effort bookkeeping).
    this.sql.exec("DELETE FROM holds WHERE id IN (SELECT id FROM holds WHERE released=0 ORDER BY available_at DESC LIMIT 50)");
    const result = { ok: true, clawed: take, balance: cur.balance, held: cur.held - take };
    this.recordOp(b.op_id, result);
    await this.audit(uid, { type: "refund", amount: -take, balance_after: cur.balance, app_name: b.app_name, ref: b.ref }, b);
    this.broadcast();
    return json(result);
  }

  // ---- [AVA-CAMP-B1-WALLET] outbound-campaign escrow (Specs/OUTBOUND-AI-CALLING-CAMPAIGNS.md §5) ----
  // ---- [AI-WALLET-SPENDABLE-2] now shared, policy-gated, with AI accrual settlement ----

  private getResv(ref: string): { ref: string; reserved: number; spent: number; released: number; allow_free: number; expires_at: number } | null {
    const rows = this.sql.exec("SELECT ref, reserved, spent, released, allow_free, expires_at FROM resv WHERE ref=?1", ref).toArray() as any[];
    if (!rows.length) return null;
    const r = rows[0];
    return {
      ref: String(r.ref), reserved: Number(r.reserved), spent: Number(r.spent), released: Number(r.released),
      allow_free: Number(r.allow_free ?? 0), expires_at: Number(r.expires_at ?? 0),
    };
  }

  /** Sum of currently-outstanding (unreleased) reservations across ALL refs for this uid (= this DO), REGARDLESS of policy — see §58 in the header comment for why this must NOT be filtered to "same policy only". */
  private outstandingReservations(): number {
    const r = this.sql.exec("SELECT COALESCE(SUM(reserved),0) AS t FROM resv WHERE released=0").one() as any;
    return Number(r.t);
  }

  /** betaFreePremium short-circuit — mirrors feature_pricing.ts chargeAmount(). Best-effort: a config read failure meters normally. */
  private async betaFree(): Promise<boolean> {
    try { return (await readConfig(this.env)).betaFreePremium === true; } catch { return false; }
  }

  /** Schedules the DO alarm for `candidateMs` UNLESS an earlier alarm (a pending earning hold, an audit-outbox retry, or another reservation's own earlier expiry) is already scheduled — never pushes a wakeup LATER than one already set. Best-effort: never blocks a reserve on alarm-scheduling failure. */
  private async scheduleEarliestAlarm(candidateMs: number): Promise<void> {
    try {
      const current = await this.state.storage.getAlarm();
      if (current == null || candidateMs < current) {
        await this.state.storage.setAlarm(candidateMs);
      }
    } catch { /* best-effort */ }
  }

  // reserve({opId, uid, amount, ref, allow_free}): admits if headroom (paid-only
  // when allow_free:false, else free+bonus+paid) covers amount + ALL other
  // outstanding reservations (§58 — conservative, cross-policy-safe), then grows
  // resv.reserved for `ref` by `amount` and persists the ref's policy. Never
  // touches bal.balance/acct — reserving only shrinks headroom for OTHER
  // reservations until consumed or released. Idempotent on opId. `expires_at`
  // (if >0, used by AI-job refs) schedules the DO alarm so an abandoned
  // reservation self-heals without waiting for this uid's next request.
  private async reserve(uid: string, b: any): Promise<Response> {
    const amount = Math.trunc(Number(b.amount));
    const ref = String(b.ref || "");
    if (!(amount > 0)) return json({ error: "amount>0 required" }, 400);
    if (!ref) return json({ error: "ref required" }, 400);
    // [AI-WALLET-SPENDABLE-2] REQUIRED, no default — a missing/non-boolean
    // allow_free fails safe with 400 rather than silently picking a policy.
    // This is the runtime half of the enforcement; routes/wallet.ts's typed
    // WalletOperation union is the compile-time half.
    if (typeof b.allow_free !== "boolean") return json({ error: "allow_free (boolean) required" }, 400);
    const allowFree = b.allow_free === true;

    // [AI-BILLING-CORE-1] finding 3: lazy reaper runs BEFORE admission on every
    // reserve() call — a crashed/abandoned aijob reservation must not eat into
    // this (or anyone else's, since outstandingReservations() sums ALL refs for
    // this uid) headroom forever. Cheap: bounded to this uid's own resv rows.
    // [AFF-G6-WALLET-1] now reaps ANY expired reservation, not just aijob refs.
    await this.reapExpiredReservations();

    const existing = this.getResv(ref);
    if (existing && !existing.released && existing.allow_free !== (allowFree ? 1 : 0)) {
      const result = { ok: false, error: "policy_mismatch", ref };
      this.recordOp(b.op_id, result);
      return json(result, 409);
    }

    const now = Date.now();
    const expiresAt = Math.max(0, Math.trunc(Number(b.expires_at || 0)));
    this.sql.exec(
      "INSERT INTO resv (ref, reserved, spent, released, created_at, updated_at, uid, allow_free, expires_at) VALUES (?1,0,0,0,?2,?2,?3,?4,?5) " +
      "ON CONFLICT(ref) DO UPDATE SET uid=excluded.uid, allow_free=excluded.allow_free, " +
      "expires_at=CASE WHEN excluded.expires_at>0 THEN excluded.expires_at ELSE resv.expires_at END",
      ref, now, uid, allowFree ? 1 : 0, expiresAt,
    );

    const beta = await this.betaFree();
    const cur = this.bal();
    const a = this.acct();
    // [§58] Conservative, cross-policy-safe: subtract ALL outstanding
    // reservations (any policy) from BOTH headroom kinds.
    const outstandingAll = this.outstandingReservations(); // includes this ref's current (possibly 0) reserved
    const headroom = allowFree ? (a.free + a.bonus + cur.balance) : cur.balance;
    if (!beta && headroom < outstandingAll + amount) {
      const result = {
        ok: false, error: "insufficient balance", reservedTotal: this.getResv(ref)?.reserved ?? 0,
        available: Math.max(0, headroom - outstandingAll),
      };
      this.recordOp(b.op_id, result);
      return json(result, 402);
    }

    this.sql.exec("UPDATE resv SET reserved=reserved+?1, updated_at=?2 WHERE ref=?3", amount, now, ref);
    const row = this.getResv(ref)!;
    const available = Math.max(0, headroom - (outstandingAll + amount));
    const result = { ok: true, ref, reservedTotal: row.reserved, available, allow_free: allowFree };
    this.recordOp(b.op_id, result);
    // Reservations do not move money. Keep them in DO-local `ops`/`resv`, not
    // the user-facing wallet_transactions statement as noisy -0 rows.
    // [AI-WALLET-SPENDABLE-2] reserve() previously scheduled NO alarm at all —
    // schedule one now for this reservation's own expiry (created OR extended),
    // preserving any earlier hold/outbox alarm already pending.
    if (expiresAt > 0) await this.scheduleEarliestAlarm(expiresAt);
    this.broadcast();
    return json(result);
  }

  // consumeReserved({opId, ref, amount, allow_free}): moves up to `amount` from
  // resv.reserved into resv.spent (clamped — never over-consumes the
  // reservation) and makes the REAL, permanent deduction in the same step
  // (unless betaFreePremium): allow_free:false draws PAID balance only;
  // allow_free:true draws free -> bonus -> paid, exactly mirroring spend().
  // Rejects consuming a reservation under a DIFFERENT policy than it was
  // reserved with (409). Idempotent on opId. Used per-second during a call (§5).
  private async consumeReserved(uid: string, b: any): Promise<Response> {
    const amount = Math.trunc(Number(b.amount));
    const ref = String(b.ref || "");
    if (!(amount > 0)) return json({ error: "amount>0 required" }, 400);
    if (!ref) return json({ error: "ref required" }, 400);
    if (typeof b.allow_free !== "boolean") return json({ error: "allow_free (boolean) required" }, 400);
    const allowFree = b.allow_free === true;

    const row = this.getResv(ref);
    if (!row || row.released) {
      // [AFF-G6-WALLET-1] §4.7/§B2: a 404 here is AMBIGUOUS — it means either
      // "already consumed successfully" (the op_id replay cache has since aged
      // out at OPS_TTL_MS = 48h) or "never reserved at all". It must never be
      // read as failure and never as success. These three additive fields are
      // the DO's local half of the disambiguation; the AUTHORITATIVE answer is
      // the `wallet_ledger` row for this ref (§4.7 step 5), because the resv
      // row alone cannot survive a DO that never saw the reserve.
      const result = {
        ok: false, error: "no_active_reservation", ref, consumed: 0,
        existed: !!row,
        already_spent: row ? row.spent : 0,
        expired: !!row && row.expires_at > 0 && row.expires_at <= Date.now(),
      };
      this.recordOp(b.op_id, result);
      return json(result, 404);
    }
    if (row.allow_free !== (allowFree ? 1 : 0)) {
      const result = { ok: false, error: "policy_mismatch", ref, consumed: 0 };
      this.recordOp(b.op_id, result);
      return json(result, 409);
    }

    const clamp = Math.max(0, Math.min(amount, row.reserved)); // never over-consume the reservation
    const now = Date.now();
    this.sql.exec("UPDATE resv SET reserved=reserved-?1, spent=spent+?1, updated_at=?2 WHERE ref=?3", clamp, now, ref);

    const beta = await this.betaFree();
    let freeUsed = 0, bonusUsed = 0, paidUsed = 0;
    let balanceAfter = this.bal().balance;
    if (!beta && clamp > 0) {
      if (allowFree) {
        const a = this.acct();
        freeUsed = Math.min(a.free, clamp);
        bonusUsed = Math.min(a.bonus, clamp - freeUsed);
        paidUsed = clamp - freeUsed - bonusUsed;
        if (freeUsed > 0) this.sql.exec("UPDATE acct SET free=free-?1 WHERE k=1", freeUsed);
        if (bonusUsed > 0) this.sql.exec("UPDATE acct SET bonus=bonus-?1 WHERE k=1", bonusUsed);
        const cur = this.bal();
        balanceAfter = Math.max(0, cur.balance - paidUsed);
        this.setBal(balanceAfter, cur.held);
      } else {
        paidUsed = clamp;
        const cur = this.bal();
        balanceAfter = Math.max(0, cur.balance - clamp); // permanent debit — mirrors spend()
        this.setBal(balanceAfter, cur.held);
      }
    }

    const after = this.getResv(ref)!;
    const result = {
      ok: true, ref, consumed: clamp, reservedRemaining: after.reserved, totalSpent: after.spent, balance: balanceAfter,
      free_used: freeUsed, bonus_used: bonusUsed, paid_used: paidUsed,
    };
    this.recordOp(b.op_id, result);
    if (clamp > 0) {
      // [AFF-G6-WALLET-1] §4.6: `type` was HARDCODED to "campaign_call" while
      // `app_name` was already overridable, so a payout consumed through this
      // op would be filed in the user's statement AND in `wallet_ledger` as a
      // campaign charge. Backward-compatible by construction: every existing
      // campaign caller passes no `type` and still gets "campaign_call".
      // Compile-time half is `type?: string` on the consume_reserved arm of the
      // WalletOperation union in routes/wallet.ts.
      const auditType = typeof b.type === "string" && b.type ? b.type : "campaign_call";
      await this.audit(uid, { type: auditType, amount: -clamp, balance_after: balanceAfter, app_name: b.app_name || "campaign", ref, ...txMeta(b) }, b);
    }
    this.broadcast();
    return json(result);
  }

  // release({opId, ref}): refunds whatever remains reserved for `ref` back to
  // "available" — since reserve() never touched bal.balance, this only zeroes the
  // outstanding-reservation bookkeeping (freeing headroom for other reservations),
  // it does not credit bal.balance. Idempotent on opId; a ref already released
  // (or unknown) is a no-op success.
  private async releaseReservation(uid: string, b: any): Promise<Response> {
    const ref = String(b.ref || "");
    if (!ref) return json({ error: "ref required" }, 400);

    const row = this.getResv(ref);
    const now = Date.now();
    const refunded = row && !row.released ? row.reserved : 0;
    if (row && !row.released) {
      this.sql.exec("UPDATE resv SET reserved=0, released=1, updated_at=?1 WHERE ref=?2", now, ref);
    }
    const cur = this.bal();
    const available = Math.max(0, cur.balance - this.outstandingReservations());
    const result = { ok: true, ref, refunded, available };
    this.recordOp(b.op_id, result);
    // Releasing unused headroom does not move money, so it is intentionally not
    // written to the financial statement.
    this.broadcast();
    return json(result);
  }

  // [AI-WALLET-SPENDABLE-2] settle_ai_cost({opId, ref, allow_free-only,
  // actual_cost_micro_usd}): the ONE atomic AI-accrual settlement op — a
  // single DO round trip so there is no Worker-side read-modify-write race
  // between two separate walletOp calls (§57). Validates the ref is an
  // ACTIVE allow_free:true reservation (never campaign escrow/payouts/seller
  // earnings — those never carry allow_free:true), folds the actual
  // marked-up provider cost into acct.debt_micro_usd via the pure
  // computeAiSettlement(), charges only the whole tokens now due (clamped to
  // this ref's own reservation AND current spendable funds), deducts
  // free -> bonus -> paid, releases the reservation, and reports any shortfall
  // as unrecovered_micro_usd (platform loss — never hidden debt, never a
  // claim on the next top-up). Idempotent on opId.
  private async settleAiCost(uid: string, b: any): Promise<Response> {
    const ref = String(b.ref || "");
    if (!ref) return json({ error: "ref required" }, 400);
    const rawCost = Number(b.actual_cost_micro_usd);
    if (!Number.isFinite(rawCost) || rawCost < 0) return json({ error: "actual_cost_micro_usd>=0 required" }, 400);
    const actualCostMicroUsd = Math.trunc(rawCost);

    const row = this.getResv(ref);
    if (!row || row.released) {
      const result = { ok: false, error: "no_active_reservation", ref };
      this.recordOp(b.op_id, result);
      return json(result, 404);
    }
    // settle_ai_cost is EXCLUSIVELY for AI-metered (allow_free:true)
    // reservations — never campaign escrow, payouts, seller earnings, or any
    // other transferable value.
    if (row.allow_free !== 1) {
      const result = { ok: false, error: "not_an_ai_reservation", ref };
      this.recordOp(b.op_id, result);
      return json(result, 409);
    }

    const beta = await this.betaFree();
    const a = this.acct();
    const debtBefore = a.debt_micro_usd;

    if (beta) {
      // Beta: no real charge (mirrors chargeAmount's own betaFreePremium
      // short-circuit elsewhere), but still fold the accrual so the remainder
      // stays meaningful the moment beta ends, and always release the
      // reservation (terminal either way).
      const settlement = computeAiSettlement({
        debtMicroUsdBefore: debtBefore, actualCostMicroUsd, reservedTokens: Number.MAX_SAFE_INTEGER, spendableTokens: Number.MAX_SAFE_INTEGER,
      });
      this.sql.exec("UPDATE resv SET reserved=0, spent=spent+?1, released=1, updated_at=?2 WHERE ref=?3 AND released=0", 0, Date.now(), ref);
      this.sql.exec("UPDATE acct SET debt_micro_usd=?1 WHERE k=1", settlement.debtMicroUsdAfter);
      const result = {
        ok: true, charged_tokens: 0, debt_micro_usd_before: debtBefore, debt_micro_usd_after: settlement.debtMicroUsdAfter,
        // [AI-WALLET-SPENDABLE-2] `actualCostMicroUsd` arrives ALREADY marked up
        // (cost x AI_MARKUP_BPS). Naming it provider_cost_micro_usd here would
        // re-introduce the exact raw-vs-marked-up swap the settle path was fixed
        // for. The RAW provider cost is reported by ai_billing.ts, not by the DO.
        charged_cost_micro_usd: actualCostMicroUsd, unrecovered_micro_usd: 0,
      };
      this.recordOp(b.op_id, result);
      // Beta-free settlement changes no balance. ai_job_completed telemetry and
      // the DO op record retain the operational trace without a -0 statement row.
      this.broadcast();
      return json(result);
    }

    const cur = this.bal();
    const spendableTokens = a.free + a.bonus + cur.balance;
    const settlement = computeAiSettlement({
      debtMicroUsdBefore: debtBefore, actualCostMicroUsd, reservedTokens: row.reserved, spendableTokens,
    });
    const chargedTokens = settlement.chargedTokens;

    let freeUsed = 0, bonusUsed = 0, paidUsed = 0;
    if (chargedTokens > 0) {
      freeUsed = Math.min(a.free, chargedTokens);
      bonusUsed = Math.min(a.bonus, chargedTokens - freeUsed);
      paidUsed = chargedTokens - freeUsed - bonusUsed;
      if (freeUsed > 0) this.sql.exec("UPDATE acct SET free=free-?1 WHERE k=1", freeUsed);
      if (bonusUsed > 0) this.sql.exec("UPDATE acct SET bonus=bonus-?1 WHERE k=1", bonusUsed);
      if (paidUsed > 0) this.setBal(Math.max(0, cur.balance - paidUsed), cur.held);
    }
    this.sql.exec("UPDATE acct SET debt_micro_usd=?1 WHERE k=1", settlement.debtMicroUsdAfter);
    // Terminal for this ref either way — settle_ai_cost folds what used to be
    // TWO separate walletOp calls (consume_reserved + release_reservation)
    // into ONE DO round trip, closing the race window between them.
    this.sql.exec(
      "UPDATE resv SET reserved=0, spent=spent+?1, released=1, updated_at=?2 WHERE ref=?3 AND released=0",
      Math.min(chargedTokens, row.reserved), Date.now(), ref,
    );

    const result = {
      ok: true, charged_tokens: chargedTokens, debt_micro_usd_before: debtBefore, debt_micro_usd_after: settlement.debtMicroUsdAfter,
      // [AI-WALLET-SPENDABLE-2] ALREADY marked-up — see the beta branch above.
      charged_cost_micro_usd: actualCostMicroUsd, unrecovered_micro_usd: settlement.unrecoveredMicroUsd,
      free_used: freeUsed, bonus_used: bonusUsed, paid_used: paidUsed,
    };
    this.recordOp(b.op_id, result);
    await this.audit(uid, {
      type: "ai_settle", amount: -chargedTokens, balance_after: this.snap().spendable, app_name: b.app_name || "ai_billing", ref,
      unrecovered_micro_usd: settlement.unrecoveredMicroUsd, ...txMeta(b),
    }, b);
    // [AI-WALLET-SPENDABLE-2] Deliberately NOT emitting `ai_cost_unrecovered`
    // here. ai_billing.recordUnrecoveredLoss() already fires that event with the
    // RAW provider cost, the per-account day counters and the platform-alert
    // threshold. A second emission from the DO would double-count every
    // platform-loss dashboard, and the DO only has the marked-up figure.
    // `unrecovered_micro_usd` is returned in `result` for the caller to report.
    this.broadcast();
    return json(result);
  }

  private validAiBudgetKey(dayRaw: unknown, requestRaw?: unknown): { day: string; requestId?: string } | null {
    const day = String(dayRaw ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    if (requestRaw === undefined) return { day };
    const requestId = String(requestRaw ?? "").trim();
    if (!requestId || requestId.length > 160) return null;
    return { day, requestId };
  }

  // [AI-BUDGET-AUTH-2 / B4] `now` defaults to Date.now() but is threaded
  // explicitly from aiBudgetReserve so a single admission call uses ONE
  // consistent instant for both its pre- and post-insert totals reads. A
  // 'reserved' row past its OWN expires_at no longer counts toward ANY of
  // turns/input/output/cost — an expired reservation must stop consuming the
  // turn cap too, not just the token/cost caps (§59c / B4).
  private aiBudgetTotals(day: string, now: number = Date.now()): {
    turns: number; inputTokens: number; outputTokens: number; costMicroUsd: number;
  } {
    const r = this.sql.exec(
      `SELECT
         COUNT(*) AS turns,
         COALESCE(SUM(CASE WHEN status='reserved' THEN input_reserved ELSE input_actual END),0) AS input_tokens,
         COALESCE(SUM(CASE WHEN status='reserved' THEN output_reserved ELSE output_actual END),0) AS output_tokens,
         COALESCE(SUM(CASE WHEN status='reserved' THEN cost_reserved ELSE cost_actual END),0) AS cost_micro_usd
       FROM ai_daily_budget
       WHERE day=?1 AND status IN ('reserved','settled')
         AND NOT (status='reserved' AND expires_at>0 AND expires_at<?2)`,
      day, now,
    ).one() as any;
    return {
      turns: Math.max(0, Number(r?.turns ?? 0)),
      inputTokens: Math.max(0, Number(r?.input_tokens ?? 0)),
      outputTokens: Math.max(0, Number(r?.output_tokens ?? 0)),
      costMicroUsd: Math.max(0, Number(r?.cost_micro_usd ?? 0)),
    };
  }

  // [AI-BUDGET-AUTH-1] Atomic check+reserve. No await occurs between reading
  // totals and inserting the reservation, so concurrent requests to this
  // per-user DO cannot all pass against the same stale headroom.
  private aiBudgetReserve(b: any): Response {
    const key = this.validAiBudgetKey(b.day, b.request_id);
    if (!key?.requestId) return json({ error: "valid day and request_id required" }, 400);
    const nonNeg = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
    };
    const input = nonNeg(b.input_tokens);
    const output = nonNeg(b.output_tokens);
    const cost = nonNeg(b.cost_micro_usd);
    const inputLimit = nonNeg(b.daily_input_limit);
    const outputLimit = nonNeg(b.daily_output_limit);
    const costLimit = nonNeg(b.daily_cost_limit);
    const turnLimit = nonNeg(b.turn_limit);
    if ([input, output, cost, inputLimit, outputLimit, costLimit, turnLimit].some((v) => v === null)) {
      return json({ error: "AI budget values must be finite non-negative integers" }, 400);
    }
    // [AI-BUDGET-AUTH-2 / B4] One consistent `now` for the whole call — the
    // pre-insert totals read, the row's own expires_at, and the post-insert
    // totals read must all agree on "when this admission happened".
    const now = Date.now();
    // Keep a short audit window without allowing one row per chat turn to grow
    // this per-user SQLite database forever.
    const retentionCutoff = new Date(now - 8 * 86_400_000).toISOString().slice(0, 10);
    this.sql.exec("DELETE FROM ai_daily_budget WHERE day < ?1", retentionCutoff);
    this.sql.exec("DELETE FROM ai_unrecovered_budget WHERE day < ?1", retentionCutoff);

    const existing = this.sql.exec(
      "SELECT status FROM ai_daily_budget WHERE request_id=?1 AND day=?2",
      key.requestId, key.day,
    ).toArray() as any[];
    if (existing.length) {
      const totals = this.aiBudgetTotals(key.day, now);
      const result = { ok: true, duplicate: true, request_id: key.requestId, day: key.day, ...totals };
      this.recordOp(b.op_id, result);
      return json(result);
    }

    const totals = this.aiBudgetTotals(key.day, now);
    const blocked =
      ((turnLimit as number) > 0 && totals.turns + 1 > (turnLimit as number)) ||
      ((inputLimit as number) > 0 && totals.inputTokens + (input as number) > (inputLimit as number)) ||
      ((outputLimit as number) > 0 && totals.outputTokens + (output as number) > (outputLimit as number)) ||
      ((costLimit as number) > 0 && totals.costMicroUsd + (cost as number) > (costLimit as number));
    if (blocked) {
      const result = {
        ok: false, error: "daily_ai_budget_exhausted", request_id: key.requestId, day: key.day,
        ...totals,
      };
      this.recordOp(b.op_id, result);
      return json(result, 429);
    }

    // [AI-BUDGET-AUTH-2 / B4] Bounded expiry on every new reservation — see
    // AI_BUDGET_RESERVATION_TTL_MS above.
    const expiresAt = now + AI_BUDGET_RESERVATION_TTL_MS;
    this.sql.exec(
      `INSERT INTO ai_daily_budget
         (request_id,day,status,input_reserved,output_reserved,cost_reserved,created_at,updated_at,expires_at)
       VALUES (?1,?2,'reserved',?3,?4,?5,?6,?6,?7)`,
      key.requestId, key.day, input, output, cost, now, expiresAt,
    );
    const after = this.aiBudgetTotals(key.day, now);
    const result = { ok: true, request_id: key.requestId, day: key.day, ...after };
    this.recordOp(b.op_id, result);
    return json(result);
  }

  private aiBudgetSettle(b: any): Response {
    const key = this.validAiBudgetKey(b.day, b.request_id);
    if (!key?.requestId) return json({ error: "valid day and request_id required" }, 400);
    const vals = [b.input_tokens, b.output_tokens, b.cost_micro_usd].map(Number);
    if (vals.some((n) => !Number.isFinite(n) || n < 0)) {
      return json({ error: "actual AI budget values must be finite and non-negative" }, 400);
    }
    const row = this.sql.exec(
      "SELECT status FROM ai_daily_budget WHERE request_id=?1 AND day=?2",
      key.requestId, key.day,
    ).toArray() as any[];
    if (!row.length) return json({ error: "AI budget reservation not found" }, 404);
    if (row[0].status === "reserved") {
      this.sql.exec(
        `UPDATE ai_daily_budget
         SET status='settled', input_actual=?1, output_actual=?2, cost_actual=?3, updated_at=?4
         WHERE request_id=?5 AND day=?6 AND status='reserved'`,
        Math.trunc(vals[0]), Math.trunc(vals[1]), Math.trunc(vals[2]), Date.now(), key.requestId, key.day,
      );
    }
    const totals = this.aiBudgetTotals(key.day);
    const result = { ok: true, request_id: key.requestId, day: key.day, ...totals };
    this.recordOp(b.op_id, result);
    return json(result);
  }

  private aiBudgetRelease(b: any): Response {
    const key = this.validAiBudgetKey(b.day, b.request_id);
    if (!key?.requestId) return json({ error: "valid day and request_id required" }, 400);
    this.sql.exec(
      "UPDATE ai_daily_budget SET status='released', updated_at=?1 WHERE request_id=?2 AND day=?3 AND status='reserved'",
      Date.now(), key.requestId, key.day,
    );
    const totals = this.aiBudgetTotals(key.day);
    const result = { ok: true, request_id: key.requestId, day: key.day, ...totals };
    this.recordOp(b.op_id, result);
    return json(result);
  }

  // [AI-BUDGET-AUTH-2 / B4] `now` defaults to Date.now() so existing callers
  // (aiUnrecoveredReserve's duplicate-branch replay) don't need to change,
  // but aiUnrecoveredReserve below threads its own single `now` through both
  // its pre- and post-insert reads, same reasoning as aiBudgetTotals. A
  // 'reserved' row past its OWN expires_at no longer counts toward the sum —
  // this is also what B3's admission-time pre-flight check reads, so an
  // orphaned worst-case-estimate row (from any OTHER, non-ai_billing caller
  // that still reserves) cannot wedge an account's cap open forever either.
  private aiUnrecoveredStatus(b: any, now: number = Date.now()): Response {
    const key = this.validAiBudgetKey(b.day);
    if (!key) return json({ error: "valid day required" }, 400);
    const row = this.sql.exec(
      `SELECT COALESCE(SUM(
         CASE WHEN status='reserved' THEN amount_reserved ELSE amount_actual END
       ),0) AS amount_micro_usd
       FROM ai_unrecovered_budget
       WHERE day=?1 AND status IN ('reserved','settled')
         AND NOT (status='reserved' AND expires_at>0 AND expires_at<?2)`,
      key.day, now,
    ).one() as any;
    return json({ ok: true, day: key.day, amount_micro_usd: Math.max(0, Number(row?.amount_micro_usd ?? 0)) });
  }

  private aiUnrecoveredReserve(b: any): Response {
    const key = this.validAiBudgetKey(b.day, b.request_id);
    const amount = Number(b.amount_micro_usd);
    const limit = Number(b.daily_limit_micro_usd);
    if (!key?.requestId || !Number.isFinite(amount) || amount < 0 || !Number.isFinite(limit) || limit < 0) {
      return json({ error: "valid day, request_id, amount and daily limit required" }, 400);
    }
    const now = Date.now();
    // [AI-BUDGET-AUTH-2 / B4] Fold in the SAME retention sweep aiBudgetReserve
    // runs. Previously ONLY aiBudgetReserve pruned ai_unrecovered_budget, so a
    // metered-only account (one whose capability never calls
    // ai_budget_reserve — e.g. a pure image job) never got its own
    // ai_unrecovered_budget rows swept at all.
    const retentionCutoff = new Date(now - 8 * 86_400_000).toISOString().slice(0, 10);
    this.sql.exec("DELETE FROM ai_daily_budget WHERE day < ?1", retentionCutoff);
    this.sql.exec("DELETE FROM ai_unrecovered_budget WHERE day < ?1", retentionCutoff);

    const existing = this.sql.exec(
      "SELECT status FROM ai_unrecovered_budget WHERE request_id=?1",
      key.requestId,
    ).toArray() as any[];
    if (existing.length) {
      const status = this.aiUnrecoveredStatus({ day: key.day }, now);
      this.recordOp(b.op_id, { ok: true, duplicate: true, request_id: key.requestId, day: key.day });
      return status;
    }
    const current = this.sql.exec(
      `SELECT COALESCE(SUM(
         CASE WHEN status='reserved' THEN amount_reserved ELSE amount_actual END
       ),0) AS n
       FROM ai_unrecovered_budget
       WHERE day=?1 AND status IN ('reserved','settled')
         AND NOT (status='reserved' AND expires_at>0 AND expires_at<?2)`,
      key.day, now,
    ).one() as any;
    const used = Math.max(0, Number(current?.n ?? 0));
    const n = Math.trunc(amount);
    if (limit > 0 && used + n > Math.trunc(limit)) {
      const result = { ok: false, error: "AI_UNRECOVERED_LIMIT", day: key.day, amount_micro_usd: used };
      this.recordOp(b.op_id, result);
      return json(result, 429);
    }
    // [AI-BUDGET-AUTH-2 / B4] Bounded expiry, same TTL as ai_daily_budget.
    const expiresAt = now + AI_BUDGET_RESERVATION_TTL_MS;
    this.sql.exec(
      `INSERT INTO ai_unrecovered_budget
         (request_id,day,status,amount_reserved,created_at,updated_at,expires_at)
       VALUES (?1,?2,'reserved',?3,?4,?4,?5)`,
      key.requestId, key.day, n, now, expiresAt,
    );
    const result = { ok: true, day: key.day, request_id: key.requestId, amount_micro_usd: used + n };
    this.recordOp(b.op_id, result);
    return json(result);
  }

  // [AI-BUDGET-AUTH-2 / B3] Upsert, not update-only. Since B3's fix stops
  // ai_billing.ts's reserveAiJob from reserving the worst-case estimate
  // against this cap at admission time (Opus gate finding: that inverted
  // §66's settled-LOSS cap into a worst-case-CHARGE cap on a live $0.05
  // default), there is normally no pre-existing 'reserved' row for a given
  // request_id by the time settlement runs — the loss is recorded directly,
  // for the first time, right here. This single atomic DO-local write still
  // does both: it settles a legacy 'reserved' row when one exists (any OTHER
  // caller that still reserves first, e.g. a future non-free-chat lane) via
  // the ON CONFLICT branch, and inserts a fresh 'settled' row when nothing
  // was reserved. Either way it is ONE per-uid-serialized write, so the
  // running per-account total stays race-free exactly as before — this is
  // the "genuine improvement over the old stale-counter read" B3 asks to
  // preserve even though the admission-time reservation itself is removed.
  private aiUnrecoveredSettle(b: any): Response {
    const key = this.validAiBudgetKey(b.day, b.request_id);
    const amount = Number(b.amount_micro_usd);
    if (!key?.requestId || !Number.isFinite(amount) || amount < 0) {
      return json({ error: "valid day, request_id and amount required" }, 400);
    }
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO ai_unrecovered_budget (request_id,day,status,amount_actual,created_at,updated_at,expires_at)
       VALUES (?1,?2,'settled',?3,?4,?4,0)
       ON CONFLICT(request_id) DO UPDATE SET
         status='settled', amount_actual=excluded.amount_actual, updated_at=excluded.updated_at`,
      key.requestId, key.day, Math.trunc(amount), now,
    );
    const result = { ok: true, day: key.day, request_id: key.requestId };
    this.recordOp(b.op_id, result);
    return json(result);
  }

  private aiUnrecoveredRelease(b: any): Response {
    const key = this.validAiBudgetKey(b.day, b.request_id);
    if (!key?.requestId) return json({ error: "valid day and request_id required" }, 400);
    this.sql.exec(
      `UPDATE ai_unrecovered_budget SET status='released', updated_at=?1
       WHERE request_id=?2 AND day=?3 AND status='reserved'`,
      Date.now(), key.requestId, key.day,
    );
    const result = { ok: true, day: key.day, request_id: key.requestId };
    this.recordOp(b.op_id, result);
    return json(result);
  }

  // [AI-WALLET-SPENDABLE-2] clear_ai_remainder({opId}): account-deletion
  // cascade hook. Clears the sub-cent debt_micro_usd remainder and releases
  // every outstanding AI-job reservation WITHOUT touching balance/free/bonus
  // (unlike hardReset(), which is a full destructive reset) — see
  // BUG-account-delete-not-cascading.md and the HANDOFF note to the
  // coordinator for wiring this into consumers/src/deletion.ts's wallet step.
  private async clearAiRemainder(uid: string, b: any): Promise<Response> {
    const clearedDebtMicroUsd = this.acct().debt_micro_usd;
    this.sql.exec("UPDATE acct SET debt_micro_usd=0 WHERE k=1");
    const releasedRows = this.sql.exec(
      "SELECT ref FROM resv WHERE released=0 AND reserved>0 AND ref LIKE 'aijob:%'",
    ).toArray() as any[];
    if (releasedRows.length) {
      this.sql.exec("UPDATE resv SET reserved=0, released=1, updated_at=?1 WHERE released=0 AND ref LIKE 'aijob:%'", Date.now());
    }
    const budgetRows = Number((this.sql.exec("SELECT COUNT(*) AS n FROM ai_daily_budget").one() as any)?.n ?? 0);
    const unrecoveredRows = Number((this.sql.exec("SELECT COUNT(*) AS n FROM ai_unrecovered_budget").one() as any)?.n ?? 0);
    this.sql.exec("DELETE FROM ai_daily_budget");
    this.sql.exec("DELETE FROM ai_unrecovered_budget");
    const result = {
      ok: true,
      cleared_debt_micro_usd: clearedDebtMicroUsd,
      released_ai_reservations: releasedRows.length,
      cleared_ai_budget_rows: budgetRows,
      cleared_ai_unrecovered_rows: unrecoveredRows,
    };
    this.recordOp(b.op_id, result);
    await this.audit(uid, {
      type: "adjustment", amount: 0, balance_after: this.bal().balance, app_name: "account_delete_ai_remainder_clear", ref: b.ref,
      cleared_debt_micro_usd: clearedDebtMicroUsd, released_ai_reservations: releasedRows.length,
    }, b);
    this.broadcast();
    return json(result);
  }

  // [AI-BILLING-CORE-1] finding 3, [AI-WALLET-SPENDABLE-2]: a crash between
  // reserveAiJob() and settleAiJob()/releaseAiJob() (worker/src/lib/ai_billing.ts)
  // would otherwise strand headroom forever — outstandingReservations() would
  // keep counting a dead reservation against this uid's balance indefinitely.
  // This lazily releases any reservation past its OWN bounded `expires_at`
  // (the normal case now that reserve() always sets one for AI-job refs), and
  // falls back to the legacy fixed AIJOB_RESV_TTL_MS age cutoff only for rows
  // with no expires_at (expires_at=0 — pre-migration rows, or any caller that
  // didn't supply one).
  //
  // SCOPE — [AFF-G6-WALLET-1] (Specs/proposals/PROPOSAL-AFFILIATE-UPI-2026-08-05.md
  // §B1 + §4.3) GENERALISED from "aijob refs only" to "any reservation whose
  // caller gave it an explicit `expires_at`". The old predicate was
  // `ref LIKE 'aijob:%'`, which meant a `upi_payout:<id>` reservation could
  // carry `expires_at` and still never be reaped — setting the field was inert.
  // Two cases now, and the split is deliberate:
  //
  //   (a) expires_at > 0  — ANY ref. The caller made an explicit, bounded
  //       promise about when this reservation stops being valid, so honouring
  //       it is exactly what it asked for. This is the payout path (§4.3
  //       requires `expires_at` on every payout reservation) and the normal
  //       AI-job path.
  //   (b) expires_at = 0  — STRICTLY `ref LIKE 'aijob:%'`, legacy fallback on
  //       AIJOB_RESV_TTL_MS age. UNCHANGED, and it must stay aijob-only:
  //       campaign escrow ([AVA-CAMP-B1-WALLET], ref = the call's
  //       attempt_uuid, no prefix, no expires_at) is NEVER reaped on age — a
  //       live outbound call can legitimately hold its reservation open for
  //       the call's full multi-minute duration, campaigns already have their
  //       own explicit release/consume path on call end, and reaping them
  //       early would let a still-running call's cost blow past its escrowed
  //       budget. A campaign reservation therefore still never appears here.
  //
  // The aijob behaviour is preserved EXACTLY as one case: same
  // `ai_budget_released` telemetry, same `ai_reservation_reaped` audit row,
  // same `ai_job_reaper` app_name. Non-aijob refs get their own distinguishable
  // pair (`wallet_reservation_expired` / `reservation_expired`) so §4.7's
  // reconciler can tell "expired and released" from "never existed" from the
  // ledger alone.
  //
  // Idempotent by construction: a reaped row flips released=1, dropping it out
  // of the WHERE clause, so it can never be reaped twice — no op_id needed.
  private readonly AIJOB_RESV_TTL_MS = 6 * 3_600_000; // legacy fallback only (aijob rows with no expires_at)
  private async reapExpiredReservations(): Promise<ReapedReservation[]> {
    const now = Date.now();
    const legacyCutoff = now - this.AIJOB_RESV_TTL_MS;
    const rows = this.sql.exec(
      "SELECT ref, reserved, uid FROM resv WHERE released=0 AND reserved>0 " +
      "AND ((expires_at>0 AND expires_at<=?1) OR (expires_at=0 AND ref LIKE 'aijob:%' AND created_at<?2))",
      now, legacyCutoff,
    ).toArray() as any[];
    if (!rows.length) return [];
    const reaped: ReapedReservation[] = [];
    for (const r of rows) {
      const ref = String(r.ref);
      const refunded = Number(r.reserved);
      const uid = String(r.uid || "") || "server"; // pre-migration rows may predate the uid column
      const kind: ReapedReservation["kind"] = ref.startsWith("aijob:") ? "aijob" : "other";
      // Guard against a race with a concurrent settle/release between the SELECT
      // above and this UPDATE — only flip rows still outstanding.
      this.sql.exec("UPDATE resv SET reserved=0, released=1, updated_at=?1 WHERE ref=?2 AND released=0", now, ref);
      if (kind === "aijob") {
        Promise.resolve(track(this.env, uid, "ai_budget_released", "ai_billing", {
          ref, reserved: refunded, used: 0, released: refunded, reason: "reaper",
        })).catch(() => {});
        await this.audit(uid, {
          type: "ai_reservation_reaped", amount: 0, balance_after: this.bal().balance,
          app_name: "ai_job_reaper", ref, reason: "reaper",
        });
      } else {
        // Distinguishable signal for every non-AI expiry (payouts today, any
        // future escrow with a bounded TTL). Amount 0 — a reservation never
        // moved money, so this is a bookkeeping row, not a charge.
        Promise.resolve(track(this.env, uid, "wallet_reservation_expired", "avatok", {
          ref, reserved: refunded, released: refunded, reason: "expiry_reaper",
        })).catch(() => {});
        await this.audit(uid, {
          type: "reservation_expired", amount: 0, balance_after: this.bal().balance,
          app_name: "wallet_reservation_reaper", ref, reason: "expiry_reaper",
        });
      }
      reaped.push({ ref, reserved: refunded, uid, kind });
    }
    this.broadcast();
    return reaped;
  }

  private releaseMatured(): number {
    const now = Date.now();
    const rows = this.sql.exec("SELECT id, amount FROM holds WHERE released=0 AND available_at<=?1", now).toArray() as any[];
    if (!rows.length) return 0;
    let sum = 0;
    for (const r of rows) sum += Number(r.amount);
    const cur = this.bal();
    this.setBal(cur.balance + sum, Math.max(0, cur.held - sum));
    this.sql.exec("UPDATE holds SET released=1 WHERE released=0 AND available_at<=?1", now);
    return sum;
  }

  async alarm(): Promise<void> {
    const outboxFailed = await this.retryAuditOutbox();
    const released = this.releaseMatured();
    // [AI-BILLING-CORE-1] finding 3, [AI-WALLET-SPENDABLE-2]: piggyback the
    // aijob reaper on the DO's existing alarm (holds release / outbox retry /
    // AI reservation expiry) so a DO that never gets another reserve() call
    // (e.g. the crash that stranded the reservation was the user's LAST-ever
    // call) still eventually self-heals instead of relying solely on the next
    // reserve() to trigger it. This is the path the "expired AI reservation is
    // released by a scheduled alarm with no further request" test exercises.
    await this.reapExpiredReservations();
    if (released > 0) this.broadcast();
    // Reschedule for the next pending hold or the next outstanding reservation
    // expiry, whichever is sooner.
    // [AFF-G6-WALLET-1] the `ref LIKE 'aijob:%'` filter is GONE from this query
    // (§B1): with it, the DO would never even WAKE for a `upi_payout:` expiry,
    // so the reaper above — however general — would only ever run when some
    // unrelated alarm happened to fire. Any ref with a bounded expires_at now
    // schedules its own wakeup.
    const next = this.sql.exec("SELECT MIN(available_at) AS t FROM holds WHERE released=0").one() as any;
    const nextResv = this.sql.exec(
      "SELECT MIN(expires_at) AS t FROM resv WHERE released=0 AND reserved>0 AND expires_at>0",
    ).one() as any;
    const pending = await this.state.storage.list({ prefix: "wallet:audit:", limit: 1 });
    // Keep the outbox alive even when there are no earning holds. A failed
    // queue send must never disappear merely because the DO had no other alarm.
    if (next?.t || nextResv?.t || pending.size > 0) {
      // Modest backoff while the outbox keeps failing (still bounded so a hold
      // release is never delayed past its own due time): 30s, 60s, 120s, ...
      // capped at 5 minutes. Resets to 30s the moment a retry round is clean.
      const backoffMs = outboxFailed ? Math.min(5 * 60_000, 30_000 * Math.pow(2, Math.min(4, await this.outboxFailStreak()))) : 30_000;
      const candidates = [next?.t ? Number(next.t) : null, nextResv?.t ? Number(nextResv.t) : null, Date.now() + backoffMs]
        .filter((t): t is number => t != null);
      await this.state.storage.setAlarm(Math.min(...candidates));
    }
  }

  /** Consecutive failed alarm rounds for the outbox (for modest backoff only; not correctness-critical). */
  private async outboxFailStreak(): Promise<number> {
    return (await this.state.storage.get<number>("wallet:outbox_fail_streak")) ?? 0;
  }

  /** Retries pending outbox messages oldest-first (by original enqueue ts). Returns true if any retry still failed. */
  private async retryAuditOutbox(): Promise<boolean> {
    const rows = await this.state.storage.list({ prefix: "wallet:audit:", limit: 100 });
    const entries = [...rows.entries()].sort(
      (a, b) => Number((a[1] as any)?.ts ?? 0) - Number((b[1] as any)?.ts ?? 0),
    );
    let anyFailed = false;
    for (const [key, value] of entries) {
      try {
        await this.env.Q_WALLET.send(value as Record<string, unknown>);
        await this.state.storage.delete(key);
        // Telemetry must never throw out of the alarm (Q_ANALYTICS.send rejection).
        Promise.resolve(track(this.env, String((value as any).uid ?? "server"), "wallet_ledger_outbox_sent", "avatok", {
          call_path: "wallet_do_alarm", tx_id: String((value as any).id ?? ""),
        })).catch(() => {});
      } catch (e) {
        anyFailed = true;
        Promise.resolve(trackException(this.env, e, {
          uid: String((value as any).uid ?? "server"), route: "WalletDO.alarm",
          method: "Q_WALLET.send", handled: true,
          extra: {
            subsystem: "wallet_ledger_outbox", tx_id: String((value as any).id ?? ""),
            txid: String((value as any).id ?? ""), outbox_persisted: true, stage: "alarm_retry",
          },
        })).catch(() => {});
      }
    }
    if (anyFailed) {
      const streak = (await this.outboxFailStreak()) + 1;
      await this.state.storage.put("wallet:outbox_fail_streak", streak);
    } else {
      await this.state.storage.delete("wallet:outbox_fail_streak");
    }
    return anyFailed;
  }

  // D1 audit trail via the wallet-transactions queue. The DO remains the
  // balance authority, but every queue message is first persisted in a small
  // DO-local outbox. This closes the old best-effort loss window between a
  // successful balance mutation and a transient Queue API failure.
  // Phase 2: the DO is the SINGLE WRITER of double-entry ledger rows for user
  // accounts — when the op carries `ledger`, the message id is the op_id so the
  // consumer's wallet_ledger insert is a PK no-op on any replay.
  private async audit(uid: string, tx: Record<string, unknown>, b?: any): Promise<void> {
    const id = (b?.op_id as string) || crypto.randomUUID();
    const ledger = b?.ledger && b.ledger.debit && b.ledger.credit
      ? { debit: String(b.ledger.debit), credit: String(b.ledger.credit), type: String(b.ledger.type || tx.type), ref: b.ledger.ref ?? tx.ref ?? null, meta: b.ledger.meta ?? null }
      : undefined;
    const msg = { uid, id, ts: Date.now(), ...tx, ...(ledger ? { ledger } : {}) };
    const key = `wallet:audit:${id}`;
    await this.state.storage.put(key, msg);
    try {
      await this.env.Q_WALLET.send(msg);
      await this.state.storage.delete(key);
      // Telemetry must never throw out of the balance path (Q_ANALYTICS.send rejection
      // would 500 a succeeded wallet op) — fire-and-forget with swallow.
      Promise.resolve(track(this.env, uid, "wallet_ledger_enqueued", "avatok", { tx_id: id, source: "wallet_do" })).catch(() => {});
    } catch (e) {
      Promise.resolve(trackException(this.env, e, {
        uid, route: "WalletDO.audit", method: "Q_WALLET.send", handled: true,
        extra: { subsystem: "wallet_ledger_outbox", tx_id: id, txid: id, outbox_persisted: true, stage: "enqueue" },
      })).catch(() => {});
      Promise.resolve(track(this.env, uid, "wallet_ledger_enqueue_deferred", "avatok", {
        tx_id: id, source: "wallet_do", retry: "durable_outbox",
      })).catch(() => {});
      // The alarm MUST be scheduled regardless of telemetry outcome.
      await this.state.storage.setAlarm(Date.now() + 30_000);
    }
  }

  // ---- live balance over WebSocket ----
  private handleWs(): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this.sockets.add(server);
    this.maybeGrant();
    try { server.send(JSON.stringify({ type: "balance", ...this.snap() })); } catch { /* ignore */ }
    server.addEventListener("close", () => this.sockets.delete(server));
    server.addEventListener("error", () => this.sockets.delete(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcast(): void {
    const msg = JSON.stringify({ type: "balance", ...this.snap() });
    for (const ws of [...this.sockets]) {
      try { ws.send(msg); } catch { this.sockets.delete(ws); }
    }
  }
}

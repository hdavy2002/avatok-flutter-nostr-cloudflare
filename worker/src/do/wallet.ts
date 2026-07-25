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

const HOLD_MS = 7 * 86_400_000; // 7-day earnings hold
const OPS_TTL_MS = 48 * 3_600_000; // dedupe window for op_id replays
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

// [AI-WALLET-SPENDABLE-2] 1 wallet token == $0.01 == 10,000 micro-USD. Matches
// the canonical site-wide rate documented in routes/wallet.ts (TOKENS_PER_USD =
// 100) and worker/src/lib/ai_billing.ts (AI_TOKENS_PER_USD = 100). Defined
// locally (not imported) because do/wallet.ts is the Durable Object module and
// must not import from lib/ai_billing.ts or routes/wallet.ts at module scope —
// this is a pure numeric constant duplicated by definition, not by accident;
// if the site-wide rate ever changes, all three call sites must change together.
export const TOKEN_MICRO_USD = 10_000;

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
    // Lazy prune of old dedupe rows.
    this.sql.exec("DELETE FROM ops WHERE ts < ?1", Date.now() - OPS_TTL_MS);
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
      body.op === "settle_ai_cost" || body.op === "clear_ai_remainder" // [AI-WALLET-SPENDABLE-2]
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
      case "clear_ai_remainder": return this.clearAiRemainder(uid, body);
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

  // Earn into a 7-day hold (not spendable until matured). commission already deducted
  // by the caller; `amount` is the net credited to the creator.
  private async earn(uid: string, b: any): Promise<Response> {
    const amount = Math.trunc(Number(b.amount));
    if (!(amount > 0)) return json({ error: "amount>0 required" }, 400);
    const cur = this.bal();
    const held = cur.held + amount;
    this.setBal(cur.balance, held);
    const availableAt = Date.now() + HOLD_MS;
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
    await this.reapStaleAiJobReservations();

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
    await this.audit(uid, { type: "campaign_reserve", amount: 0, balance_after: cur.balance, app_name: b.app_name || "campaign", ref }, b);
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
      const result = { ok: false, error: "no_active_reservation", ref, consumed: 0 };
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
      await this.audit(uid, { type: "campaign_call", amount: -clamp, balance_after: balanceAfter, app_name: b.app_name || "campaign", ref, ...txMeta(b) }, b);
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
    if (refunded > 0) {
      await this.audit(uid, { type: "campaign_release", amount: 0, balance_after: cur.balance, app_name: b.app_name || "campaign", ref }, b);
    }
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
      await this.audit(uid, { type: "ai_settle", amount: 0, balance_after: this.bal().balance, app_name: b.app_name || "ai_billing", ref, beta: true }, b);
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
    const result = { ok: true, cleared_debt_micro_usd: clearedDebtMicroUsd, released_ai_reservations: releasedRows.length };
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
  // SCOPE: STRICTLY `ref LIKE 'aijob:%'` (the exact prefix reserveAiJob() uses,
  // `aijob:<opId>`). Campaign escrow reservations ([AVA-CAMP-B1-WALLET], ref =
  // the call's attempt_uuid, no prefix) are NEVER touched here — a live outbound
  // call can legitimately hold its reservation open for the call's full
  // multi-minute duration, campaigns already have their own explicit
  // release/consume path on call end, and reaping them early would let a
  // still-running call's cost blow past its escrowed budget. Only ai_billing's
  // own aijob refs are provably safe to time out this way, since ai_billing
  // itself always resolves (settle or release) within one HTTP request.
  //
  // Idempotent by construction: a reaped row flips released=1, dropping it out
  // of the WHERE clause, so it can never be reaped twice — no op_id needed.
  private readonly AIJOB_RESV_TTL_MS = 6 * 3_600_000; // legacy fallback only (rows with no expires_at)
  private async reapStaleAiJobReservations(): Promise<number> {
    const now = Date.now();
    const legacyCutoff = now - this.AIJOB_RESV_TTL_MS;
    const rows = this.sql.exec(
      "SELECT ref, reserved, uid FROM resv WHERE released=0 AND reserved>0 AND ref LIKE 'aijob:%' " +
      "AND ((expires_at>0 AND expires_at<?1) OR (expires_at=0 AND created_at<?2))",
      now, legacyCutoff,
    ).toArray() as any[];
    if (!rows.length) return 0;
    for (const r of rows) {
      const ref = String(r.ref);
      const refunded = Number(r.reserved);
      const uid = String(r.uid || "") || "server"; // pre-migration rows may predate the uid column
      // Guard against a race with a concurrent settle/release between the SELECT
      // above and this UPDATE — only flip rows still outstanding.
      this.sql.exec("UPDATE resv SET reserved=0, released=1, updated_at=?1 WHERE ref=?2 AND released=0", now, ref);
      Promise.resolve(track(this.env, uid, "ai_budget_released", "ai_billing", {
        ref, reserved: refunded, used: 0, released: refunded, reason: "reaper",
      })).catch(() => {});
      await this.audit(uid, {
        type: "ai_reservation_reaped", amount: 0, balance_after: this.bal().balance,
        app_name: "ai_job_reaper", ref, reason: "reaper",
      });
    }
    this.broadcast();
    return rows.length;
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
    await this.reapStaleAiJobReservations();
    if (released > 0) this.broadcast();
    // Reschedule for the next pending hold or the next outstanding AI-job
    // reservation expiry, whichever is sooner.
    const next = this.sql.exec("SELECT MIN(available_at) AS t FROM holds WHERE released=0").one() as any;
    const nextResv = this.sql.exec(
      "SELECT MIN(expires_at) AS t FROM resv WHERE released=0 AND reserved>0 AND ref LIKE 'aijob:%' AND expires_at>0",
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

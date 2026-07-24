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
//   reserve         — admits if balance >= amount + ALL other outstanding
//                      reservations for this uid (this DO IS the uid), then
//                      adds `amount` into resv.reserved for `ref`. Does NOT
//                      touch bal.balance (money stays "real" until consumed);
//                      it only shrinks what other reservations may admit.
//   consume_reserved — moves up to `amount` from resv.reserved into resv.spent
//                      (clamped so a ref can never over-consume its own
//                      reservation) and, in the same step, performs the REAL,
//                      permanent deduction from bal.balance (via setBal),
//                      mirroring how `spend` already debits real balance.
//   release          — zeroes out whatever remains in resv.reserved for `ref`
//                      (marks it released) so that capacity becomes available
//                      to other reservations again. No bal.balance mutation —
//                      reserve() never removed it from bal.balance, so nothing
//                      to refund there; consume_reserved() already made any
//                      real deduction permanent.
// betaFreePremium (KV flag, same short-circuit as feature_pricing.ts
// chargeAmount): while ON, admission never blocks on balance and
// consume_reserved skips the real bal.balance deduction — mirrors "all
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
    // [AVA-CAMP-B1-WALLET] Escrow reservations, keyed by caller-supplied `ref`
    // (e.g. campaign_call_attempts.attempt_uuid). Brand-new table, additive only
    // — does not touch `bal`/`acct`/`holds`/`ops`.
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS resv (ref TEXT PRIMARY KEY, reserved INTEGER NOT NULL DEFAULT 0, spent INTEGER NOT NULL DEFAULT 0, released INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    );
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

  private acct(): { free: number; premium: number; last_grant_day: string; bonus: number } {
    const r = this.sql.exec("SELECT free, premium, last_grant_day, bonus FROM acct WHERE k=1").one() as any;
    return { free: Number(r.free), premium: Number(r.premium), last_grant_day: String(r.last_grant_day), bonus: Number(r.bonus ?? 0) };
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
  // `premium`, and `spendable` = free + bonus + paid.
  private snap(): { balance: number; held: number; free: number; bonus: number; premium: number; spendable: number } {
    const b = this.bal();
    const a = this.acct();
    return { balance: b.balance, held: b.held, free: a.free + a.bonus, bonus: a.bonus, premium: a.premium, spendable: a.free + a.bonus + b.balance };
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
      body.op === "reserve" || body.op === "consume_reserved" || body.op === "release_reservation" // [AVA-CAMP-B1-WALLET]
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
  // Idempotent on op_id (`hardreset:v1:<uid>`), so a re-run of the backfill no-ops.
  private async hardReset(uid: string, b: any): Promise<Response> {
    const amount = Math.max(0, Math.trunc(Number(b.amount ?? 100)));
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    this.setBal(0, 0);
    this.sql.exec("DELETE FROM holds");
    this.sql.exec("UPDATE acct SET free=0, premium=0, bonus=?1, last_grant_day=?2 WHERE k=1", amount, today);
    const result = { ok: true, ...this.snap() };
    this.recordOp(b.op_id, result);
    await this.audit(uid, { type: "adjustment", amount, balance_after: this.snap().spendable, app_name: "token_hard_reset", ref: b.ref }, b);
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

  private getResv(ref: string): { ref: string; reserved: number; spent: number; released: number } | null {
    const rows = this.sql.exec("SELECT ref, reserved, spent, released FROM resv WHERE ref=?1", ref).toArray() as any[];
    if (!rows.length) return null;
    const r = rows[0];
    return { ref: String(r.ref), reserved: Number(r.reserved), spent: Number(r.spent), released: Number(r.released) };
  }

  /** Sum of currently-outstanding (unreleased) reservations across ALL refs for this uid (= this DO). */
  private outstandingReservations(): number {
    const r = this.sql.exec("SELECT COALESCE(SUM(reserved),0) AS t FROM resv WHERE released=0").one() as any;
    return Number(r.t);
  }

  /** betaFreePremium short-circuit — mirrors feature_pricing.ts chargeAmount(). Best-effort: a config read failure meters normally. */
  private async betaFree(): Promise<boolean> {
    try { return (await readConfig(this.env)).betaFreePremium === true; } catch { return false; }
  }

  // reserve({opId, uid, amount, ref}): admits if balance >= amount + all other
  // outstanding reservations, then grows resv.reserved for `ref` by `amount`.
  // Never touches bal.balance — reserving only shrinks headroom for OTHER
  // reservations until consumed or released. Idempotent on opId.
  private async reserve(uid: string, b: any): Promise<Response> {
    const amount = Math.trunc(Number(b.amount));
    const ref = String(b.ref || "");
    if (!(amount > 0)) return json({ error: "amount>0 required" }, 400);
    if (!ref) return json({ error: "ref required" }, 400);

    const now = Date.now();
    this.sql.exec(
      "INSERT INTO resv (ref, reserved, spent, released, created_at, updated_at) VALUES (?1,0,0,0,?2,?2) ON CONFLICT(ref) DO NOTHING",
      ref, now,
    );
    const beta = await this.betaFree();
    const cur = this.bal();
    const outstandingBefore = this.outstandingReservations(); // includes this ref's current (possibly 0) reserved
    if (!beta && cur.balance < outstandingBefore + amount) {
      const result = { ok: false, error: "insufficient balance", reservedTotal: this.getResv(ref)?.reserved ?? 0, available: Math.max(0, cur.balance - outstandingBefore) };
      this.recordOp(b.op_id, result);
      return json(result, 402);
    }

    this.sql.exec("UPDATE resv SET reserved=reserved+?1, updated_at=?2 WHERE ref=?3", amount, now, ref);
    const row = this.getResv(ref)!;
    const available = Math.max(0, cur.balance - (outstandingBefore + amount));
    const result = { ok: true, ref, reservedTotal: row.reserved, available };
    this.recordOp(b.op_id, result);
    await this.audit(uid, { type: "campaign_reserve", amount: 0, balance_after: cur.balance, app_name: b.app_name || "campaign", ref }, b);
    this.broadcast();
    return json(result);
  }

  // consumeReserved({opId, ref, amount}): moves up to `amount` from resv.reserved
  // into resv.spent (clamped — never over-consumes the reservation) and makes the
  // REAL, permanent bal.balance deduction in the same step (unless betaFreePremium).
  // Idempotent on opId. Used per-second during a call (§5).
  private async consumeReserved(uid: string, b: any): Promise<Response> {
    const amount = Math.trunc(Number(b.amount));
    const ref = String(b.ref || "");
    if (!(amount > 0)) return json({ error: "amount>0 required" }, 400);
    if (!ref) return json({ error: "ref required" }, 400);

    const row = this.getResv(ref);
    if (!row || row.released) {
      const result = { ok: false, error: "no_active_reservation", ref, consumed: 0 };
      this.recordOp(b.op_id, result);
      return json(result, 404);
    }

    const clamp = Math.max(0, Math.min(amount, row.reserved)); // never over-consume the reservation
    const now = Date.now();
    this.sql.exec("UPDATE resv SET reserved=reserved-?1, spent=spent+?1, updated_at=?2 WHERE ref=?3", clamp, now, ref);

    const beta = await this.betaFree();
    let balanceAfter = this.bal().balance;
    if (!beta && clamp > 0) {
      const cur = this.bal();
      balanceAfter = Math.max(0, cur.balance - clamp); // permanent debit — mirrors spend()
      this.setBal(balanceAfter, cur.held);
    }

    const after = this.getResv(ref)!;
    const result = { ok: true, ref, consumed: clamp, reservedRemaining: after.reserved, totalSpent: after.spent, balance: balanceAfter };
    this.recordOp(b.op_id, result);
    if (clamp > 0) {
      await this.audit(uid, { type: "campaign_call", amount: -clamp, balance_after: balanceAfter, app_name: b.app_name || "campaign", ref }, b);
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
    if (released > 0) this.broadcast();
    // Reschedule for the next pending hold, if any.
    const next = this.sql.exec("SELECT MIN(available_at) AS t FROM holds WHERE released=0").one() as any;
    const pending = await this.state.storage.list({ prefix: "wallet:audit:", limit: 1 });
    // Keep the outbox alive even when there are no earning holds. A failed
    // queue send must never disappear merely because the DO had no other alarm.
    if (next?.t || pending.size > 0) {
      // Modest backoff while the outbox keeps failing (still bounded so a hold
      // release is never delayed past its own due time): 30s, 60s, 120s, ...
      // capped at 5 minutes. Resets to 30s the moment a retry round is clean.
      const backoffMs = outboxFailed ? Math.min(5 * 60_000, 30_000 * Math.pow(2, Math.min(4, await this.outboxFailStreak()))) : 30_000;
      await this.state.storage.setAlarm(Math.min(
        next?.t ? Number(next.t) : Date.now() + backoffMs,
        Date.now() + backoffMs,
      ));
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

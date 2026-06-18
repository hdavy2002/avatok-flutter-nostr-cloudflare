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
import type { Env } from "../types";
import { json } from "../util";

const HOLD_MS = 7 * 86_400_000; // 7-day earnings hold
const OPS_TTL_MS = 48 * 3_600_000; // dedupe window for op_id replays
// AvaCoins granted free each UTC day (no rollover). Non-premium users only.
// See Specs/AVA-AI-COIN-PRICING-PROPOSAL.md. Spend draws free coins first, then
// paid. The first top-up flips the user to sticky premium (free grant stops).
const DAILY_FREE_GRANT = 250;

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

  private acct(): { free: number; premium: number; last_grant_day: string } {
    const r = this.sql.exec("SELECT free, premium, last_grant_day FROM acct WHERE k=1").one() as any;
    return { free: Number(r.free), premium: Number(r.premium), last_grant_day: String(r.last_grant_day) };
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

  // Full balance snapshot the client sees: paid `balance`, `held`, promo `free`,
  // `premium`, and `spendable` = free + paid.
  private snap(): { balance: number; held: number; free: number; premium: number; spendable: number } {
    const b = this.bal();
    const a = this.acct();
    return { balance: b.balance, held: b.held, free: a.free, premium: a.premium, spendable: a.free + b.balance };
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
    if (body.op === "credit" || body.op === "spend" || body.op === "earn" || body.op === "debit_hold") {
      const dup = this.seenOp(body.op_id);
      if (dup) return dup;
    }

    switch (body.op) {
      case "balance": return json({ ...this.snap(), uid });
      case "credit": return this.credit(uid, body);
      case "spend": return this.spend(uid, body);
      case "earn": return this.earn(uid, body);
      case "debit_hold": return this.debitHold(uid, body); // refund clawback within hold
      case "release": { const released = this.releaseMatured(); return json({ released, ...this.bal() }); }
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
    await this.audit(uid, { type: b.type || "topup", amount, balance_after: balance, app_name: b.app_name, ref: b.ref }, b);
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
    let paidUsed = amount;
    if (allowFree) {
      const total = a.free + cur.balance;
      if (total < amount) return json({ error: "insufficient balance", ...this.snap() }, 402);
      freeUsed = Math.min(a.free, amount);
      paidUsed = amount - freeUsed;
    } else if (cur.balance < amount) {
      return json({ error: "insufficient balance", ...this.snap() }, 402);
    }

    if (freeUsed > 0) this.sql.exec("UPDATE acct SET free=free-?1 WHERE k=1", freeUsed);
    const balance = cur.balance - paidUsed;
    this.setBal(balance, cur.held);

    const txType = b.type === "payout" || b.type === "refund" ? b.type : "spend";
    const result = { ok: true, ...this.snap(), free_used: freeUsed, paid_used: paidUsed };
    this.recordOp(b.op_id, result);
    await this.audit(uid, { type: txType, amount: -amount, balance_after: this.snap().spendable, app_name: b.app_name, counterparty_npub: b.counterparty_npub, ref: b.ref }, b);
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
    await this.audit(uid, { type: "earn", amount, balance_after: cur.balance, app_name: b.app_name, counterparty_npub: b.counterparty_npub, commission: Math.trunc(Number(b.commission || 0)), ref: b.ref, hold_until: availableAt }, b);
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
    const released = this.releaseMatured();
    if (released > 0) this.broadcast();
    // Reschedule for the next pending hold, if any.
    const next = this.sql.exec("SELECT MIN(available_at) AS t FROM holds WHERE released=0").one() as any;
    if (next?.t) await this.state.storage.setAlarm(Number(next.t));
  }

  // D1 audit trail via the wallet-transactions queue (never blocks the user).
  // Phase 2: the DO is the SINGLE WRITER of double-entry ledger rows for user
  // accounts — when the op carries `ledger`, the message id is the op_id so the
  // consumer's wallet_ledger insert is a PK no-op on any replay.
  private async audit(uid: string, tx: Record<string, unknown>, b?: any): Promise<void> {
    const id = (b?.op_id as string) || crypto.randomUUID();
    const ledger = b?.ledger && b.ledger.debit && b.ledger.credit
      ? { debit: String(b.ledger.debit), credit: String(b.ledger.credit), type: String(b.ledger.type || tx.type), ref: b.ledger.ref ?? tx.ref ?? null, meta: b.ledger.meta ?? null }
      : undefined;
    try { await this.env.Q_WALLET.send({ uid, id, ts: Date.now(), ...tx, ...(ledger ? { ledger } : {}) }); } catch { /* best-effort */ }
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

// WalletDO — per-user atomic coin balance (§10.1). One DO per npub. ALL balance
// math happens here, inside the DO's own SQLite, so it is strictly serialized and
// race-free. D1 (avatok-wallet) is only the async audit trail, written by the
// wallet-transactions queue consumer. The DO also serves a WebSocket that pushes
// live balance to an open app, and runs a self-scheduled alarm to release matured
// 7-day earning holds (held → spendable).
//
// Reached via stub.fetch with JSON { op, ... }. Ops: balance | credit | spend |
// earn | release | history-noop. WS: GET upgrade on any path with Upgrade header.
import type { Env } from "../types";
import { json } from "../util";

const HOLD_MS = 7 * 86_400_000; // 7-day earnings hold

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
  }

  private bal(): { balance: number; held: number } {
    const r = this.sql.exec("SELECT balance, held FROM bal WHERE k=1").one() as any;
    return { balance: Number(r.balance), held: Number(r.held) };
  }

  private setBal(balance: number, held: number): void {
    this.sql.exec("UPDATE bal SET balance=?1, held=?2 WHERE k=1", balance, held);
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") === "websocket") return this.handleWs();

    let body: any = {};
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const npub: string = body.npub || "";

    // Lazily release matured holds on every touch.
    this.releaseMatured();

    switch (body.op) {
      case "balance": return json({ ...this.bal(), npub });
      case "credit": return this.credit(npub, body);
      case "spend": return this.spend(npub, body);
      case "earn": return this.earn(npub, body);
      case "release": { const released = this.releaseMatured(); return json({ released, ...this.bal() }); }
      default: return json({ error: "unknown op" }, 400);
    }
  }

  // Immediate spendable credit (topup, refund).
  private async credit(npub: string, b: any): Promise<Response> {
    const amount = Math.trunc(Number(b.amount));
    if (!(amount > 0)) return json({ error: "amount>0 required" }, 400);
    const cur = this.bal();
    const balance = cur.balance + amount;
    this.setBal(balance, cur.held);
    await this.audit(npub, { type: b.type || "topup", amount, balance_after: balance, app_name: b.app_name, ref: b.ref });
    this.broadcast();
    return json({ ok: true, balance, held: cur.held });
  }

  // Atomic debit. Refuses to go negative.
  private async spend(npub: string, b: any): Promise<Response> {
    const amount = Math.trunc(Number(b.amount));
    if (!(amount > 0)) return json({ error: "amount>0 required" }, 400);
    const cur = this.bal();
    if (cur.balance < amount) return json({ error: "insufficient balance", balance: cur.balance }, 402);
    const balance = cur.balance - amount;
    this.setBal(balance, cur.held);
    await this.audit(npub, { type: "spend", amount: -amount, balance_after: balance, app_name: b.app_name, counterparty_npub: b.counterparty_npub, ref: b.ref });
    this.broadcast();
    return json({ ok: true, balance, held: cur.held });
  }

  // Earn into a 7-day hold (not spendable until matured). commission already deducted
  // by the caller; `amount` is the net credited to the creator.
  private async earn(npub: string, b: any): Promise<Response> {
    const amount = Math.trunc(Number(b.amount));
    if (!(amount > 0)) return json({ error: "amount>0 required" }, 400);
    const cur = this.bal();
    const held = cur.held + amount;
    this.setBal(cur.balance, held);
    const availableAt = Date.now() + HOLD_MS;
    const id = crypto.randomUUID();
    this.sql.exec("INSERT INTO holds (id, amount, available_at, released) VALUES (?1,?2,?3,0)", id, amount, availableAt);
    await this.state.storage.setAlarm(availableAt);
    await this.audit(npub, { type: "earn", amount, balance_after: cur.balance, app_name: b.app_name, counterparty_npub: b.counterparty_npub, commission: Math.trunc(Number(b.commission || 0)), ref: b.ref, hold_until: availableAt });
    this.broadcast();
    return json({ ok: true, balance: cur.balance, held, available_at: availableAt });
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
  private async audit(npub: string, tx: Record<string, unknown>): Promise<void> {
    try { await this.env.Q_WALLET.send({ npub, id: crypto.randomUUID(), ts: Date.now(), ...tx }); } catch { /* best-effort */ }
  }

  // ---- live balance over WebSocket ----
  private handleWs(): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this.sockets.add(server);
    try { server.send(JSON.stringify({ type: "balance", ...this.bal() })); } catch { /* ignore */ }
    server.addEventListener("close", () => this.sockets.delete(server));
    server.addEventListener("error", () => this.sockets.delete(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcast(): void {
    const msg = JSON.stringify({ type: "balance", ...this.bal() });
    for (const ws of [...this.sockets]) {
      try { ws.send(msg); } catch { this.sockets.delete(ws); }
    }
  }
}

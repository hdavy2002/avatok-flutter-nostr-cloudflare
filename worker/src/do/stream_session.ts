// StreamSessionDO — one per live stream (§10.1 / §23). Viewers send gifts; the DO
// AGGREGATES them and settles to the creator's WalletDO every ~5s (one earn per
// flush instead of one per gift → far fewer DO writes during a gift storm). Gifts
// carry the 30% 'gifts' commission. The creator's net is an earn (7-day hold).
import type { Env } from "../types";
import { json } from "../util";

const FLUSH_MS = 5_000;
const GIFT_COMMISSION = 0.30; // §10.1 gifts 30%

export class StreamSessionDO {
  private env: Env;
  private state: DurableObjectState;
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS meta (k INTEGER PRIMARY KEY, creator_npub TEXT, pending INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, gifters INTEGER NOT NULL DEFAULT 0)",
    );
    this.sql.exec("INSERT OR IGNORE INTO meta (k, creator_npub, pending, total, gifters) VALUES (1, NULL, 0, 0, 0)");
  }

  async fetch(req: Request): Promise<Response> {
    let body: any = {};
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    switch (body.op) {
      case "init": {
        this.sql.exec("UPDATE meta SET creator_npub=?1 WHERE k=1", String(body.creator_npub || ""));
        return json({ ok: true });
      }
      case "gift": {
        const amount = Math.trunc(Number(body.amount));
        if (!(amount > 0)) return json({ error: "amount>0 required" }, 400);
        this.sql.exec("UPDATE meta SET pending=pending+?1, total=total+?1, gifters=gifters+1 WHERE k=1", amount);
        await this.state.storage.setAlarm(Date.now() + FLUSH_MS); // coalesces; one flush per window
        return json({ ok: true });
      }
      case "stats": {
        const m = this.sql.exec("SELECT creator_npub, pending, total, gifters FROM meta WHERE k=1").one() as any;
        return json({ creator_npub: m.creator_npub, pending: Number(m.pending), total: Number(m.total), gifters: Number(m.gifters) });
      }
      case "flush": { await this.flush(); return json({ ok: true }); }
      default: return json({ error: "unknown op" }, 400);
    }
  }

  async alarm(): Promise<void> { await this.flush(); }

  private async flush(): Promise<void> {
    const m = this.sql.exec("SELECT creator_npub, pending FROM meta WHERE k=1").one() as any;
    const pending = Number(m.pending);
    const creator = m.creator_npub as string | null;
    if (!creator || pending <= 0) return;
    const commission = Math.round(pending * GIFT_COMMISSION);
    const net = pending - commission;
    // Settle to the creator's WalletDO as an earn (7-day hold).
    const stub = this.env.WALLET_DO.get(this.env.WALLET_DO.idFromName(creator));
    await stub.fetch("https://wallet/op", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "earn", uid: creator, amount: net, commission, app_name: "avalive", ref: "stream-gifts" }),
    });
    this.sql.exec("UPDATE meta SET pending=0 WHERE k=1");
  }
}

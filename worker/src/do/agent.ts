// AgentDO — per-user agent coordinator (§20). Enforces two guardrails in its own
// SQLite (atomic): (1) max 5 agent conversations per app per day (§20.9 / §27.25);
// (2) a per-user DAILY neuron budget circuit-breaker (§6.4 / §20.9). Keyed by npub.
import type { Env } from "../types";
import { json } from "../util";

const MAX_CONVOS_PER_APP_DAY = 5;
const DAILY_NEURON_BUDGET = 5000; // conservative per-user/day agent inference cap

function today(): string { return new Date().toISOString().slice(0, 10); }

export class AgentDO {
  private sql: SqlStorage;
  constructor(state: DurableObjectState, _env: Env) {
    this.sql = state.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS convos (app TEXT, day TEXT, n INTEGER, PRIMARY KEY (app, day))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS neurons (day TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0)");
  }

  async fetch(req: Request): Promise<Response> {
    let b: any = {}; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    switch (b.op) {
      case "reserve": return json(this.reserve(String(b.app || "")));
      case "addNeurons": return json(this.addNeurons(Math.max(0, Math.trunc(Number(b.n || 0)))));
      case "status": return json(this.status());
      default: return json({ error: "unknown op" }, 400);
    }
  }

  private convoCount(app: string): number {
    const r = this.sql.exec("SELECT n FROM convos WHERE app=?1 AND day=?2", app, today()).toArray() as any[];
    return r.length ? Number(r[0].n) : 0;
  }
  private neuronsUsed(): number {
    const r = this.sql.exec("SELECT used FROM neurons WHERE day=?1", today()).toArray() as any[];
    return r.length ? Number(r[0].used) : 0;
  }

  // Reserve a conversation slot for `app` today. Refuses if over rate limit or budget.
  private reserve(app: string): { ok: boolean; reason?: string; remaining?: number } {
    if (this.neuronsUsed() >= DAILY_NEURON_BUDGET) return { ok: false, reason: "neuron_budget_exceeded" };
    const used = this.convoCount(app);
    if (used >= MAX_CONVOS_PER_APP_DAY) return { ok: false, reason: "rate_limit", remaining: 0 };
    this.sql.exec(
      "INSERT INTO convos (app, day, n) VALUES (?1,?2,1) ON CONFLICT(app, day) DO UPDATE SET n=n+1",
      app, today(),
    );
    return { ok: true, remaining: MAX_CONVOS_PER_APP_DAY - used - 1 };
  }

  private addNeurons(n: number): { used: number; budget: number; tripped: boolean } {
    this.sql.exec("INSERT INTO neurons (day, used) VALUES (?1,?2) ON CONFLICT(day) DO UPDATE SET used=used+?2", today(), n);
    const used = this.neuronsUsed();
    return { used, budget: DAILY_NEURON_BUDGET, tripped: used >= DAILY_NEURON_BUDGET };
  }

  private status() {
    return { day: today(), neurons_used: this.neuronsUsed(), neuron_budget: DAILY_NEURON_BUDGET, max_convos_per_app_day: MAX_CONVOS_PER_APP_DAY };
  }
}

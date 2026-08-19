// [AI-WALLET-SPENDABLE-2] Integration-style tests for WalletDO's reservation
// policy (Part VIII §52/§58 of Specs/ROOT-CAUSE-REPORT-RECURRING-ISSUES-
// 2026-07-25.md): the `allow_free` admission/drawdown rule, cross-policy
// headroom safety, idempotent replay, and the AI-job reservation lifecycle
// (expiry + scheduled-alarm reaping, hardReset clearing).
//
// There is no Miniflare/`@cloudflare/vitest-pool-workers` harness in this
// repo (worker/package.json has no such devDependency — confirmed by
// inspection before writing this file), so these tests instantiate the REAL
// `WalletDO` class against a hand-written, purpose-built fake `SqlStorage` +
// `DurableObjectStorage` that recognizes the EXACT SQL statement text
// do/wallet.ts issues (verified against the current source at the time this
// file was written) and executes the equivalent operation against small
// in-memory JS structures. This exercises the ACTUAL production code path
// (WalletDO.fetch -> the private op handlers), not a parallel reimplementation
// of its logic — only the SQLite engine underneath it is faked.
//
// If do/wallet.ts's SQL text ever changes, the matching fake handler below
// must change in the SAME commit (a mismatch throws a descriptive error from
// FakeSql.run() rather than silently misbehaving).
//
//   npm test   (vitest run)
import { describe, it, expect, beforeEach } from "vitest";
import { WalletDO } from "../src/do/wallet";
import type { Env } from "../src/types";

// ---------------------------------------------------------------------------
// FakeSql — recognizes the finite, known set of SQL statements WalletDO
// issues and executes them against small in-memory structures.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;

class FakeSql {
  bal = { balance: 0, held: 0 };
  acct = { free: 0, premium: 0, last_grant_day: "", bonus: 0, debt_micro_usd: 0 };
  ops = new Map<string, { result: string; ts: number }>();
  resv = new Map<string, {
    reserved: number; spent: number; released: number; created_at: number; updated_at: number;
    uid: string; allow_free: number; expires_at: number;
  }>();
  holds = new Map<string, { amount: number; available_at: number; released: number }>();

  exec(sqlText: string, ...binds: any[]): { toArray(): Row[]; one(): Row } {
    const s = sqlText.replace(/\s+/g, " ").trim();
    const rows = this.run(s, binds);
    return {
      toArray: () => rows,
      one: () => {
        if (!rows.length) throw new Error("FakeSql.one(): no rows for: " + s);
        return rows[0];
      },
    };
  }

  // eslint-disable-next-line complexity
  private run(s: string, b: any[]): Row[] {
    // DDL is a no-op in the fake: the schema is modelled by the in-memory maps
    // below, so CREATE TABLE / ALTER TABLE / CREATE INDEX only need to not throw.
    // (CREATE INDEX arrived with the ai_daily_budget/ai_unrecovered_budget tables.)
    if (s.startsWith("CREATE TABLE") || s.startsWith("ALTER TABLE") || s.startsWith("CREATE INDEX")) return [];
    // The ai_daily_budget / ai_unrecovered_budget tables are the FREE-lane
    // budget authority and are deliberately OUT OF SCOPE for this harness,
    // which models the paid reservation/settlement path only. Several ops
    // (clear_ai_remainder, hardReset, the retention sweep) touch them
    // incidentally. Rather than hand-mirror a second schema here — and pay the
    // same brittleness tax again on every future edit — treat any statement
    // against those two tables as a no-op with an empty result. That is
    // honest: no test in this file ever writes a budget row, so every count is
    // genuinely 0. ai_free_budget.test.ts and ai_billing_accrual.test.ts are
    // where those tables are actually exercised.
    if (/\bai_daily_budget\b|\bai_unrecovered_budget\b/.test(s)) {
      return s.startsWith("SELECT COUNT(") ? [{ n: 0 }] : [];
    }
    if (s === "INSERT OR IGNORE INTO bal (k, balance, held) VALUES (1,0,0)") return [];
    if (s === "INSERT OR IGNORE INTO acct (k, free, premium, last_grant_day) VALUES (1,0,0,'')") return [];

    if (s === "SELECT result FROM ops WHERE op_id=?1") {
      const row = this.ops.get(String(b[0]));
      return row ? [{ result: row.result }] : [];
    }
    if (s === "INSERT OR IGNORE INTO ops (op_id, result, ts) VALUES (?1,?2,?3)") {
      const id = String(b[0]);
      if (!this.ops.has(id)) this.ops.set(id, { result: String(b[1]), ts: Number(b[2]) });
      return [];
    }
    if (s === "DELETE FROM ops WHERE ts < ?1 AND op_id NOT LIKE 'listing:%'") {
      const cutoff = Number(b[0]);
      for (const [k, v] of this.ops) if (v.ts < cutoff && !k.startsWith("listing:")) this.ops.delete(k);
      return [];
    }

    if (s === "SELECT balance, held FROM bal WHERE k=1") return [{ balance: this.bal.balance, held: this.bal.held }];
    if (s === "UPDATE bal SET balance=?1, held=?2 WHERE k=1") {
      this.bal.balance = Number(b[0]); this.bal.held = Number(b[1]); return [];
    }

    if (s === "SELECT free, premium, last_grant_day, bonus, debt_micro_usd FROM acct WHERE k=1") return [{ ...this.acct }];
    if (s === "UPDATE acct SET free=0 WHERE k=1") { this.acct.free = 0; return []; }
    if (s === "UPDATE acct SET free=?1, last_grant_day=?2 WHERE k=1") {
      this.acct.free = Number(b[0]); this.acct.last_grant_day = String(b[1]); return [];
    }
    if (s === "UPDATE acct SET premium=1, free=0 WHERE k=1") { this.acct.premium = 1; this.acct.free = 0; return []; }
    if (s === "UPDATE acct SET bonus=bonus+?1 WHERE k=1") { this.acct.bonus += Number(b[0]); return []; }
    if (s === "UPDATE acct SET free=0, premium=0, bonus=?1, last_grant_day=?2, debt_micro_usd=0 WHERE k=1") {
      this.acct.free = 0; this.acct.premium = 0; this.acct.bonus = Number(b[0]);
      this.acct.last_grant_day = String(b[1]); this.acct.debt_micro_usd = 0;
      return [];
    }
    if (s === "UPDATE acct SET free=free-?1 WHERE k=1") { this.acct.free -= Number(b[0]); return []; }
    if (s === "UPDATE acct SET bonus=bonus-?1 WHERE k=1") { this.acct.bonus -= Number(b[0]); return []; }
    if (s === "UPDATE acct SET debt_micro_usd=?1 WHERE k=1") { this.acct.debt_micro_usd = Number(b[0]); return []; }
    if (s === "UPDATE acct SET debt_micro_usd=0 WHERE k=1") { this.acct.debt_micro_usd = 0; return []; }

    if (s === "SELECT ref FROM resv WHERE released=0 AND reserved>0 AND ref LIKE 'aijob:%'") {
      const out: Row[] = [];
      for (const [ref, row] of this.resv) if (row.released === 0 && row.reserved > 0 && ref.startsWith("aijob:")) out.push({ ref });
      return out;
    }
    if (s === "UPDATE resv SET reserved=0, released=1, updated_at=?1 WHERE released=0 AND ref LIKE 'aijob:%'") {
      const ts = Number(b[0]);
      for (const [ref, row] of this.resv) if (row.released === 0 && ref.startsWith("aijob:")) { row.reserved = 0; row.released = 1; row.updated_at = ts; }
      return [];
    }

    if (s === "SELECT ref, reserved, spent, released, allow_free, expires_at FROM resv WHERE ref=?1") {
      const ref = String(b[0]);
      const row = this.resv.get(ref);
      return row ? [{ ref, reserved: row.reserved, spent: row.spent, released: row.released, allow_free: row.allow_free, expires_at: row.expires_at }] : [];
    }
    if (s === "SELECT COALESCE(SUM(reserved),0) AS t FROM resv WHERE released=0") {
      let sum = 0;
      for (const row of this.resv.values()) if (row.released === 0) sum += row.reserved;
      return [{ t: sum }];
    }

    const RESV_UPSERT = "INSERT INTO resv (ref, reserved, spent, released, created_at, updated_at, uid, allow_free, expires_at) VALUES " +
      "(?1,0,0,0,?2,?2,?3,?4,?5) ON CONFLICT(ref) DO UPDATE SET uid=excluded.uid, allow_free=excluded.allow_free, " +
      "expires_at=CASE WHEN excluded.expires_at>0 THEN excluded.expires_at ELSE resv.expires_at END";
    if (s === RESV_UPSERT) {
      const ref = String(b[0]), now = Number(b[1]), uid = String(b[2]), allowFree = Number(b[3]), expiresAt = Number(b[4]);
      const existing = this.resv.get(ref);
      if (!existing) {
        this.resv.set(ref, { reserved: 0, spent: 0, released: 0, created_at: now, updated_at: now, uid, allow_free: allowFree, expires_at: expiresAt });
      } else {
        existing.uid = uid; existing.allow_free = allowFree;
        if (expiresAt > 0) existing.expires_at = expiresAt;
      }
      return [];
    }
    if (s === "UPDATE resv SET reserved=reserved+?1, updated_at=?2 WHERE ref=?3") {
      const amt = Number(b[0]), ts = Number(b[1]), ref = String(b[2]);
      const row = this.resv.get(ref); if (row) { row.reserved += amt; row.updated_at = ts; }
      return [];
    }
    if (s === "UPDATE resv SET reserved=reserved-?1, spent=spent+?1, updated_at=?2 WHERE ref=?3") {
      const amt = Number(b[0]), ts = Number(b[1]), ref = String(b[2]);
      const row = this.resv.get(ref); if (row) { row.reserved -= amt; row.spent += amt; row.updated_at = ts; }
      return [];
    }
    if (s === "UPDATE resv SET reserved=0, released=1, updated_at=?1 WHERE ref=?2") {
      const ts = Number(b[0]), ref = String(b[1]);
      const row = this.resv.get(ref); if (row) { row.reserved = 0; row.released = 1; row.updated_at = ts; }
      return [];
    }
    if (s === "UPDATE resv SET reserved=0, spent=spent+?1, released=1, updated_at=?2 WHERE ref=?3 AND released=0") {
      const amt = Number(b[0]), ts = Number(b[1]), ref = String(b[2]);
      const row = this.resv.get(ref); if (row && row.released === 0) { row.reserved = 0; row.spent += amt; row.released = 1; row.updated_at = ts; }
      return [];
    }
    if (s === "UPDATE resv SET reserved=0, released=1, updated_at=?1 WHERE ref=?2 AND released=0") {
      const ts = Number(b[0]), ref = String(b[1]);
      const row = this.resv.get(ref); if (row && row.released === 0) { row.reserved = 0; row.released = 1; row.updated_at = ts; }
      return [];
    }
    // [AFF-G6-WALLET-1] generalised reaper predicate: ANY ref with an explicit
    // expires_at, plus the legacy age fallback for aijob rows only.
    if (s === "SELECT ref, reserved, uid FROM resv WHERE released=0 AND reserved>0 AND " +
      "((expires_at>0 AND expires_at<=?1) OR (expires_at=0 AND ref LIKE 'aijob:%' AND created_at<?2))") {
      const now = Number(b[0]), legacyCutoff = Number(b[1]);
      const out: Row[] = [];
      for (const [ref, row] of this.resv) {
        if (row.released !== 0 || row.reserved <= 0) continue;
        if ((row.expires_at > 0 && row.expires_at <= now) ||
            (row.expires_at === 0 && ref.startsWith("aijob:") && row.created_at < legacyCutoff)) {
          out.push({ ref, reserved: row.reserved, uid: row.uid });
        }
      }
      return out;
    }

    if (s === "SELECT id, amount FROM holds WHERE released=0 AND available_at<=?1") {
      const now = Number(b[0]); const out: Row[] = [];
      for (const [id, row] of this.holds) if (row.released === 0 && row.available_at <= now) out.push({ id, amount: row.amount });
      return out;
    }
    if (s === "UPDATE holds SET released=1 WHERE released=0 AND available_at<=?1") {
      const now = Number(b[0]);
      for (const row of this.holds.values()) if (row.released === 0 && row.available_at <= now) row.released = 1;
      return [];
    }
    if (s === "DELETE FROM holds") { this.holds.clear(); return []; }
    if (s === "SELECT MIN(available_at) AS t FROM holds WHERE released=0") {
      let min: number | null = null;
      for (const row of this.holds.values()) if (row.released === 0) min = min == null ? row.available_at : Math.min(min, row.available_at);
      return [{ t: min }];
    }
    // [AFF-G6-WALLET-1] the aijob filter is gone — the DO must also wake for a
    // `upi_payout:` expiry.
    if (s === "SELECT MIN(expires_at) AS t FROM resv WHERE released=0 AND reserved>0 AND expires_at>0") {
      let min: number | null = null;
      for (const row of this.resv.values()) {
        if (row.released === 0 && row.reserved > 0 && row.expires_at > 0) min = min == null ? row.expires_at : Math.min(min, row.expires_at);
      }
      return [{ t: min }];
    }
    if (s === "INSERT INTO holds (id, amount, available_at, released) VALUES (?1,?2,?3,0)") {
      this.holds.set(String(b[0]), { amount: Number(b[1]), available_at: Number(b[2]), released: 0 });
      return [];
    }
    if (s === "DELETE FROM holds WHERE id IN (SELECT id FROM holds WHERE released=0 ORDER BY available_at DESC LIMIT 50)") {
      const unreleased = [...this.holds.entries()].filter(([, r]) => r.released === 0).sort((a, b2) => b2[1].available_at - a[1].available_at).slice(0, 50);
      for (const [id] of unreleased) this.holds.delete(id);
      return [];
    }

    throw new Error("FakeSql: unhandled statement (update the fake alongside do/wallet.ts): " + s);
  }
}

class FakeStorage {
  kv = new Map<string, unknown>();
  alarmAt: number | null = null;
  sql: FakeSql;
  constructor(sql: FakeSql) { this.sql = sql; }
  async put(key: string, value: unknown) { this.kv.set(key, value); }
  async get(key: string) { return this.kv.get(key); }
  async delete(key: string) { this.kv.delete(key); }
  async list(opts: { prefix?: string; limit?: number } = {}) {
    const entries = [...this.kv.entries()].filter(([k]) => !opts.prefix || k.startsWith(opts.prefix));
    const limited = opts.limit ? entries.slice(0, opts.limit) : entries;
    return new Map(limited);
  }
  async getAlarm() { return this.alarmAt; }
  async setAlarm(t: number) { this.alarmAt = t; }
}

function makeWallet(): { wallet: WalletDO; sql: FakeSql; storage: FakeStorage; sent: any[] } {
  const sql = new FakeSql();
  const storage = new FakeStorage(sql);
  const state = { storage } as unknown as DurableObjectState;
  // [AFF-G6-WALLET-1] Q_WALLET messages ARE the audit trail (the consumer turns
  // each one into a wallet_transactions row and, when `ledger` is present, a
  // wallet_ledger entry), so capturing them is how the audit-`type` tests below
  // assert what a payout would actually be filed as.
  const sent: any[] = [];
  // betaFree() reads env.TOKENS via routes/config.readConfig — force
  // betaFreePremium:false so admission/accrual logic actually runs (the real
  // DEFAULTS have betaFreePremium:true for the free launch, which would
  // short-circuit every admission check in these tests).
  const env = {
    Q_WALLET: { send: async (m: any) => { sent.push(m); return {}; } },
    TOKENS: { get: async () => ({ betaFreePremium: false }) },
  } as unknown as Env;
  const wallet = new WalletDO(state, env);
  return { wallet, sql, storage, sent };
}

async function op(wallet: WalletDO, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const req = new Request("https://wallet/op", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const res = await wallet.fetch(req);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

let ctx: ReturnType<typeof makeWallet>;
beforeEach(() => { ctx = makeWallet(); });

describe("allow_free is required at runtime (§52/§57)", () => {
  it("reserve without allow_free -> 400", async () => {
    const r = await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 1, ref: "aijob:a" });
    expect(r.status).toBe(400);
  });
  it("reserve with a non-boolean allow_free -> 400", async () => {
    const r = await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 1, ref: "aijob:a", allow_free: "yes" });
    expect(r.status).toBe(400);
  });
  it("consume_reserved without allow_free -> 400", async () => {
    const r = await op(ctx.wallet, { op: "consume_reserved", uid: "u1", amount: 1, ref: "aijob:a" });
    expect(r.status).toBe(400);
  });
});

describe("bonus-only wallet — allow_free:true admits and consumes it, allow_free:false never does", () => {
  it("reserves and consumes one internal-cost token from a bonus-only wallet", async () => {
    await op(ctx.wallet, { op: "promo_credit", uid: "u1", amount: 5 }); // bonus=5, balance=0
    const r1 = await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 1, ref: "aijob:x", allow_free: true, op_id: "x:reserve" });
    expect(r1.status).toBe(200);
    expect(r1.body.ok).toBe(true);
    const r2 = await op(ctx.wallet, { op: "consume_reserved", uid: "u1", amount: 1, ref: "aijob:x", allow_free: true, op_id: "x:settle" });
    expect(r2.status).toBe(200);
    expect(r2.body.consumed).toBe(1);
    expect(r2.body.bonus_used).toBe(1);
    expect(r2.body.paid_used).toBe(0);
    const bal = await op(ctx.wallet, { op: "balance", uid: "u1" });
    expect(bal.body.bonus).toBe(4);
    expect(bal.body.balance).toBe(0);
  });

  it("cannot reserve campaign/payout value (allow_free:false) even though bonus covers it", async () => {
    await op(ctx.wallet, { op: "promo_credit", uid: "u1", amount: 50 }); // bonus=50, balance=0
    const r = await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 10, ref: "campaign:c1", allow_free: false, op_id: "c1:reserve" });
    expect(r.status).toBe(402);
    expect(r.body.ok).toBe(false);
  });
});

describe("§58 cross-policy headroom — conservative 'subtract everything from both'", () => {
  it("a 50-token campaign reservation on a 50-bonus/50-paid wallet refuses an overlapping 60-token AI reservation", async () => {
    await op(ctx.wallet, { op: "credit", uid: "u1", amount: 50, type: "topup" }); // balance=50 paid... but topup flips premium=1/free=0, doesn't touch bonus
    await op(ctx.wallet, { op: "promo_credit", uid: "u1", amount: 50 }); // bonus=50
    const camp = await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 50, ref: "campaign:big", allow_free: false, op_id: "big:reserve" });
    expect(camp.status).toBe(200);

    // spendable = bonus(50) + paid(50) = 100; outstandingAll already = 50 (the
    // campaign's own). A 60-token AI reserve needs headroom 100 - 50 = 50,
    // which is LESS than 60 -> must be refused, not admitted against the
    // campaign's already-claimed paid balance.
    const ai = await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 60, ref: "aijob:big", allow_free: true, op_id: "aijob-big:reserve" });
    expect(ai.status).toBe(402);
    expect(ai.body.ok).toBe(false);
  });
});

describe("idempotent replay — reserve and settle_ai_cost", () => {
  it("replaying the same reserve op_id does not double-reserve", async () => {
    await op(ctx.wallet, { op: "promo_credit", uid: "u1", amount: 10 });
    const first = await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 3, ref: "aijob:r1", allow_free: true, op_id: "r1:reserve" });
    const second = await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 3, ref: "aijob:r1", allow_free: true, op_id: "r1:reserve" });
    expect(second.body.duplicate).toBe(true);
    expect(second.body.reservedTotal).toBe(first.body.reservedTotal);
    expect(ctx.sql.resv.get("aijob:r1")?.reserved).toBe(3); // NOT 6
  });

  it("replaying the same settle_ai_cost op_id does not double charge or double debt", async () => {
    await op(ctx.wallet, { op: "promo_credit", uid: "u1", amount: 10 });
    await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 5, ref: "aijob:s1", allow_free: true, op_id: "s1:reserve" });
    const first = await op(ctx.wallet, {
      op: "settle_ai_cost", uid: "u1", ref: "aijob:s1", op_id: "s1:settle", actual_cost_micro_usd: 25_000, // 2.5 tokens worth
    });
    expect(first.status).toBe(200);
    expect(first.body.charged_tokens).toBe(2);
    const second = await op(ctx.wallet, {
      op: "settle_ai_cost", uid: "u1", ref: "aijob:s1", op_id: "s1:settle", actual_cost_micro_usd: 25_000,
    });
    expect(second.body.duplicate).toBe(true);
    const bal = await op(ctx.wallet, { op: "balance", uid: "u1" });
    expect(bal.body.bonus).toBe(8); // 10 - 2, NOT 10 - 4
    expect(bal.body.debt_micro_usd).toBe(5_000); // NOT 10_000 (double-counted)
  });
});

describe("marketplace listing op retention beyond the generic 48-hour cache", () => {
  it("replays a stale listing debit while pruning unrelated stale operations", async () => {
    const first = await op(ctx.wallet, {
      op: "credit", uid: "u1", amount: 10, op_id: "listing:seller-1:1",
    });
    expect(first.status).toBe(200);
    ctx.sql.ops.set("generic:old", { result: JSON.stringify({ ok: true }), ts: Date.now() - 49 * 3_600_000 });
    const listing = ctx.sql.ops.get("listing:seller-1:1");
    if (!listing) throw new Error("listing operation was not recorded");
    listing.ts = Date.now() - 49 * 3_600_000;

    await op(ctx.wallet, { op: "credit", uid: "u1", amount: 1, op_id: "generic:new" });
    expect(ctx.sql.ops.has("generic:old")).toBe(false);
    expect(ctx.sql.ops.has("listing:seller-1:1")).toBe(true);

    const replay = await op(ctx.wallet, {
      op: "credit", uid: "u1", amount: 10, op_id: "listing:seller-1:1",
    });
    expect(replay.body.duplicate).toBe(true);
    expect((await op(ctx.wallet, { op: "balance", uid: "u1" })).body.balance).toBe(11);
  });
});

describe("settle_ai_cost accrual, invariants and unrecovered loss", () => {
  it("a large job reserves and settles multiple tokens in one shot", async () => {
    await op(ctx.wallet, { op: "promo_credit", uid: "u1", amount: 100 });
    await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 20, ref: "aijob:big", allow_free: true, op_id: "big:reserve" });
    const settle = await op(ctx.wallet, {
      op: "settle_ai_cost", uid: "u1", ref: "aijob:big", op_id: "big:settle", actual_cost_micro_usd: 150_000, // 15 tokens
    });
    expect(settle.body.charged_tokens).toBe(15);
    expect(settle.body.unrecovered_micro_usd).toBe(0);
    const bal = await op(ctx.wallet, { op: "balance", uid: "u1" });
    expect(bal.body.bonus).toBe(85);
  });

  it("100 sub-cent jobs settle cumulatively at the correct batch price, never rounding up per-job", async () => {
    await op(ctx.wallet, { op: "promo_credit", uid: "u1", amount: 100 });
    // Each job costs 150 micro-USD (well under one token = 10,000 micro-USD).
    // 100 jobs * 150 = 15,000 micro-USD total = exactly 1 token + 5,000
    // remainder. Charging each job independently (the old
    // microUsdToTokens-per-job behavior) would have billed 100 tokens (each
    // ceiling up from a fraction) instead of 1.
    for (let i = 0; i < 100; i++) {
      await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 1, ref: `aijob:sub${i}`, allow_free: true, op_id: `sub${i}:reserve` });
    }
    let totalCharged = 0;
    for (let i = 0; i < 100; i++) {
      const r = await op(ctx.wallet, {
        op: "settle_ai_cost", uid: "u1", ref: `aijob:sub${i}`, op_id: `sub${i}:settle`, actual_cost_micro_usd: 150,
      });
      totalCharged += r.body.charged_tokens;
    }
    expect(totalCharged).toBe(1);
    const bal = await op(ctx.wallet, { op: "balance", uid: "u1" });
    expect(bal.body.debt_micro_usd).toBe(5_000);
    expect(bal.body.bonus).toBe(99);
  });

  it("an underestimated provider result records unrecovered_micro_usd, never leaves debt_micro_usd >= 10,000, and never consumes the next top-up", async () => {
    await op(ctx.wallet, { op: "promo_credit", uid: "u1", amount: 2 }); // only 2 tokens spendable
    await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 2, ref: "aijob:under", allow_free: true, op_id: "under:reserve" });
    // Actual cost comes back at 5 tokens' worth — far more than reserved (2)
    // AND more than spendable (2).
    const settle = await op(ctx.wallet, {
      op: "settle_ai_cost", uid: "u1", ref: "aijob:under", op_id: "under:settle", actual_cost_micro_usd: 50_000,
    });
    expect(settle.body.charged_tokens).toBe(2); // clamped to reserved AND spendable
    expect(settle.body.unrecovered_micro_usd).toBe(30_000); // 3 tokens' worth the platform ate
    expect(settle.body.debt_micro_usd_after).toBeGreaterThanOrEqual(0);
    expect(settle.body.debt_micro_usd_after).toBeLessThan(10_000);

    const bal = await op(ctx.wallet, { op: "balance", uid: "u1" });
    expect(bal.body.bonus).toBe(0);
    expect(bal.body.balance).toBe(0);

    // A top-up right after must NOT be silently eaten by the unrecovered
    // shortfall — it stays fully spendable.
    await op(ctx.wallet, { op: "credit", uid: "u1", amount: 10, type: "topup" });
    const after = await op(ctx.wallet, { op: "balance", uid: "u1" });
    expect(after.body.balance).toBe(10);
  });
});

describe("failed/released jobs add no debt", () => {
  it("releasing a reservation never touches debt_micro_usd or balance", async () => {
    await op(ctx.wallet, { op: "promo_credit", uid: "u1", amount: 10 });
    await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 5, ref: "aijob:cancel", allow_free: true, op_id: "cancel:reserve" });
    const rel = await op(ctx.wallet, { op: "release_reservation", uid: "u1", ref: "aijob:cancel", op_id: "cancel:release" });
    expect(rel.body.ok).toBe(true);
    expect(rel.body.refunded).toBe(5);
    const bal = await op(ctx.wallet, { op: "balance", uid: "u1" });
    expect(bal.body.bonus).toBe(10);
    expect(bal.body.debt_micro_usd).toBe(0);
  });
});

describe("hardReset clears the sub-cent remainder and AI reservations", () => {
  it("zeroes debt_micro_usd and releases outstanding aijob reservations, but leaves campaign escrow alone", async () => {
    await op(ctx.wallet, { op: "promo_credit", uid: "u1", amount: 100 });
    await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 5, ref: "aijob:pending", allow_free: true, op_id: "pending:reserve" });
    await op(ctx.wallet, { op: "settle_ai_cost", uid: "u1", ref: "aijob:pending", op_id: "pending:settle", actual_cost_micro_usd: 3_000 });
    let bal = await op(ctx.wallet, { op: "balance", uid: "u1" });
    expect(bal.body.debt_micro_usd).toBe(3_000);

    await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 2, ref: "aijob:stranded", allow_free: true, op_id: "stranded:reserve" });

    const reset = await op(ctx.wallet, { op: "hard_reset", uid: "u1", amount: 100, op_id: "reset:1" });
    expect(reset.body.cleared_debt_micro_usd).toBe(3_000);
    expect(reset.body.released_ai_reservations).toBe(1); // the still-outstanding "stranded" ref

    bal = await op(ctx.wallet, { op: "balance", uid: "u1" });
    expect(bal.body.debt_micro_usd).toBe(0);
    expect(bal.body.bonus).toBe(100);
    expect(ctx.sql.resv.get("aijob:stranded")?.released).toBe(1);
  });
});

describe("expired AI reservation is released by a scheduled alarm with no further request", () => {
  it("reserve() schedules the DO alarm at expires_at, and alarm() reaps it", async () => {
    await op(ctx.wallet, { op: "promo_credit", uid: "u1", amount: 10 });
    const now = Date.now();
    const r = await op(ctx.wallet, {
      op: "reserve", uid: "u1", amount: 5, ref: "aijob:expiring", allow_free: true, op_id: "expiring:reserve",
      expires_at: now - 1, // already in the past by the time alarm() runs
    });
    expect(r.status).toBe(200);
    expect(ctx.storage.alarmAt).toBe(now - 1); // alarm scheduled for the reservation's own expiry

    // Simulate the Cloudflare runtime firing the alarm — no further request
    // from the caller is needed.
    await ctx.wallet.alarm();

    const outstanding = ctx.sql.exec("SELECT COALESCE(SUM(reserved),0) AS t FROM resv WHERE released=0").one();
    expect(Number(outstanding.t)).toBe(0);
    expect(ctx.sql.resv.get("aijob:expiring")?.released).toBe(1);
  });
});

describe("sequential admission against the same final token (§57 — the DO's single-threaded input gate turns 'concurrent' requests into exactly this order)", () => {
  it("two jobs cannot both spend the last token", async () => {
    await op(ctx.wallet, { op: "promo_credit", uid: "u1", amount: 1 }); // exactly 1 token spendable
    const first = await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 1, ref: "aijob:first", allow_free: true, op_id: "first:reserve" });
    const second = await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 1, ref: "aijob:second", allow_free: true, op_id: "second:reserve" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(402); // the DO already committed `first`'s reservation
  });
});

describe("consuming a reservation under a different policy than it was created with is rejected", () => {
  it("consume_reserved with allow_free:false on an allow_free:true ref -> 409", async () => {
    await op(ctx.wallet, { op: "promo_credit", uid: "u1", amount: 10 });
    await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 3, ref: "aijob:pol", allow_free: true, op_id: "pol:reserve" });
    const bad = await op(ctx.wallet, { op: "consume_reserved", uid: "u1", amount: 1, ref: "aijob:pol", allow_free: false, op_id: "pol:settle" });
    expect(bad.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// [AFF-G6-WALLET-1] G6 of Specs/proposals/PROPOSAL-AFFILIATE-UPI-2026-08-05.md
// (§B1, §4.3, §4.6, §4.7): the reservation reaper is generalised beyond
// `aijob:` refs, the alarm reschedules for ANY bounded expiry, and
// consume_reserved's audit row can be labelled by the caller.
// ---------------------------------------------------------------------------

describe("[AFF-G6-WALLET-1] §B1/§4.3 — expiry reaping is no longer aijob-only", () => {
  it("reaps an EXPIRED upi_payout reservation and frees its headroom (fails before G6)", async () => {
    await op(ctx.wallet, { op: "credit", uid: "u1", amount: 1000 }); // paid balance
    const now = Date.now();
    const r = await op(ctx.wallet, {
      op: "reserve", uid: "u1", amount: 400, ref: "upi_payout:req1", allow_free: false,
      op_id: "payout_reserve:req1", expires_at: now - 1,
    });
    expect(r.status).toBe(200);
    expect(ctx.storage.alarmAt).toBe(now - 1); // scheduled for its OWN expiry

    // The runtime fires the alarm; no further request from anyone is needed.
    await ctx.wallet.alarm();

    expect(ctx.sql.resv.get("upi_payout:req1")?.released).toBe(1);
    expect(ctx.sql.resv.get("upi_payout:req1")?.reserved).toBe(0);
    const outstanding = ctx.sql.exec("SELECT COALESCE(SUM(reserved),0) AS t FROM resv WHERE released=0").one();
    expect(Number(outstanding.t)).toBe(0); // headroom released, not stranded
  });

  it("emits a DISTINGUISHABLE audit row for a non-aijob expiry (§4.3.3)", async () => {
    await op(ctx.wallet, { op: "credit", uid: "u1", amount: 100 });
    await op(ctx.wallet, {
      op: "reserve", uid: "u1", amount: 10, ref: "upi_payout:req2", allow_free: false,
      op_id: "payout_reserve:req2", expires_at: Date.now() - 1,
    });
    ctx.sent.length = 0;
    await ctx.wallet.alarm();

    const reapRow = ctx.sent.find((m) => m.ref === "upi_payout:req2");
    expect(reapRow).toBeTruthy();
    // NOT the aijob label — a payout expiry must be legible as its own thing.
    expect(reapRow.type).toBe("reservation_expired");
    expect(reapRow.app_name).toBe("wallet_reservation_reaper");
    expect(reapRow.amount).toBe(0); // a reservation never moved money
    expect(reapRow.uid).toBe("u1");
  });

  it("REGRESSION — an expired aijob reservation keeps its exact prior behaviour", async () => {
    await op(ctx.wallet, { op: "promo_credit", uid: "u1", amount: 10 });
    await op(ctx.wallet, {
      op: "reserve", uid: "u1", amount: 5, ref: "aijob:legacy1", allow_free: true,
      op_id: "legacy1:reserve", expires_at: Date.now() - 1,
    });
    ctx.sent.length = 0;
    await ctx.wallet.alarm();

    expect(ctx.sql.resv.get("aijob:legacy1")?.released).toBe(1);
    const reapRow = ctx.sent.find((m) => m.ref === "aijob:legacy1");
    expect(reapRow.type).toBe("ai_reservation_reaped");
    expect(reapRow.app_name).toBe("ai_job_reaper");
    expect(reapRow.reason).toBe("reaper");
  });

  it("REGRESSION — the legacy age fallback (expires_at=0) still reaps aijob rows", async () => {
    await op(ctx.wallet, { op: "promo_credit", uid: "u1", amount: 10 });
    await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 5, ref: "aijob:noexp", allow_free: true, op_id: "noexp:reserve" });
    const row = ctx.sql.resv.get("aijob:noexp")!;
    expect(row.expires_at).toBe(0);
    row.created_at = Date.now() - 7 * 3_600_000; // older than AIJOB_RESV_TTL_MS (6h)
    await ctx.wallet.alarm();
    expect(ctx.sql.resv.get("aijob:noexp")?.released).toBe(1);
  });

  it("REGRESSION — campaign escrow (no prefix, no expires_at) is NEVER reaped on age", async () => {
    await op(ctx.wallet, { op: "credit", uid: "u1", amount: 100 });
    await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 20, ref: "attempt-uuid-1", allow_free: false, op_id: "camp:reserve" });
    const row = ctx.sql.resv.get("attempt-uuid-1")!;
    expect(row.expires_at).toBe(0);
    row.created_at = Date.now() - 30 * 3_600_000; // 30h old — a long but legitimate call
    await ctx.wallet.alarm();
    // Still outstanding: a live outbound call must keep its escrow.
    expect(ctx.sql.resv.get("attempt-uuid-1")?.released).toBe(0);
    expect(ctx.sql.resv.get("attempt-uuid-1")?.reserved).toBe(20);
  });
});

describe("[AFF-G6-WALLET-1] §B1 — alarm() reschedules for a NON-aijob expiry", () => {
  it("picks up a future upi_payout expiry as the next wakeup", async () => {
    await op(ctx.wallet, { op: "credit", uid: "u1", amount: 100 });
    const expiry = Date.now() + 5_000; // sooner than the 30s outbox backoff floor
    await op(ctx.wallet, {
      op: "reserve", uid: "u1", amount: 10, ref: "upi_payout:future", allow_free: false,
      op_id: "payout_reserve:future", expires_at: expiry,
    });

    ctx.storage.alarmAt = null; // forget reserve()'s own scheduling
    await ctx.wallet.alarm();

    // Before G6 the nextResv query filtered `ref LIKE 'aijob:%'`, so this was
    // null and the DO would never wake for the payout at all.
    expect(ctx.storage.alarmAt).toBe(expiry);
    expect(ctx.sql.resv.get("upi_payout:future")?.released).toBe(0); // not yet due
  });
});

describe("[AFF-G6-WALLET-1] §4.1 — release_reservation is idempotent", () => {
  it("a second release returns refunded:0, ok:true (and writes no statement row)", async () => {
    await op(ctx.wallet, { op: "credit", uid: "u1", amount: 100 });
    await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 30, ref: "upi_payout:rej", allow_free: false, op_id: "rej:reserve" });
    const first = await op(ctx.wallet, { op: "release_reservation", uid: "u1", ref: "upi_payout:rej", op_id: "rej:release" });
    expect(first.body.ok).toBe(true);
    expect(first.body.refunded).toBe(30);
    // A DIFFERENT op_id, so this is a real second call, not an ops-table replay.
    const second = await op(ctx.wallet, { op: "release_reservation", uid: "u1", ref: "upi_payout:rej", op_id: "rej:release:retry" });
    expect(second.status).toBe(200);
    expect(second.body.ok).toBe(true);
    expect(second.body.refunded).toBe(0);
    // Releasing moved no money, so the balance is untouched.
    const bal = await op(ctx.wallet, { op: "balance", uid: "u1" });
    expect(bal.body.balance).toBe(100);
  });

  it("releasing a ref this DO has never seen is a no-op success", async () => {
    const r = await op(ctx.wallet, { op: "release_reservation", uid: "u1", ref: "upi_payout:ghost", op_id: "ghost:release" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.refunded).toBe(0);
  });
});

describe("[AFF-G6-WALLET-1] §4.1 — allow_free:false can never touch free/bonus (welcome tokens are structurally un-withdrawable)", () => {
  it("refuses to reserve a payout that only the bonus bucket could cover", async () => {
    await op(ctx.wallet, { op: "promo_credit", uid: "u1", amount: 500 }); // welcome/bonus only
    const r = await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 100, ref: "upi_payout:bonus", allow_free: false, op_id: "bonus:reserve" });
    expect(r.status).toBe(402);
    expect(r.body.ok).toBe(false);
  });

  it("consumes ONLY paid balance, leaving bonus intact", async () => {
    await op(ctx.wallet, { op: "promo_credit", uid: "u1", amount: 500 }); // bonus
    await op(ctx.wallet, { op: "credit", uid: "u1", amount: 40 }); // paid
    await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 40, ref: "upi_payout:paid", allow_free: false, op_id: "paid:reserve" });
    const c = await op(ctx.wallet, {
      op: "consume_reserved", uid: "u1", amount: 40, ref: "upi_payout:paid", allow_free: false,
      op_id: "payout_consume:paid", type: "payout", app_name: "avapayout",
    });
    expect(c.status).toBe(200);
    expect(c.body.consumed).toBe(40);
    expect(c.body.paid_used).toBe(40);
    expect(c.body.free_used).toBe(0);
    expect(c.body.bonus_used).toBe(0);
    const bal = await op(ctx.wallet, { op: "balance", uid: "u1" });
    expect(bal.body.balance).toBe(0);
    expect(bal.body.bonus).toBe(500); // untouched
  });
});

describe("[AFF-G6-WALLET-1] §4.6 — consume_reserved audit type is caller-labelled, defaulting to campaign_call", () => {
  it("type:'payout' files the statement/ledger row as a payout, not a campaign charge", async () => {
    await op(ctx.wallet, { op: "credit", uid: "u1", amount: 100 });
    await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 25, ref: "upi_payout:lbl", allow_free: false, op_id: "lbl:reserve" });
    ctx.sent.length = 0;
    await op(ctx.wallet, {
      op: "consume_reserved", uid: "u1", amount: 25, ref: "upi_payout:lbl", allow_free: false,
      op_id: "payout_consume:lbl", type: "payout", app_name: "avapayout",
      ledger: { debit: "user:u1", credit: "external:payout", type: "payout", ref: "upi_payout:lbl" },
    });
    const msg = ctx.sent.find((m) => m.ref === "upi_payout:lbl");
    expect(msg).toBeTruthy();
    expect(msg.type).toBe("payout"); // NOT "campaign_call"
    expect(msg.app_name).toBe("avapayout");
    expect(msg.amount).toBe(-25);
    expect(msg.ledger.type).toBe("payout"); // wallet_ledger reads payout too
  });

  it("BACKWARD COMPATIBILITY — a campaign caller passing no `type` still gets campaign_call/campaign", async () => {
    await op(ctx.wallet, { op: "credit", uid: "u1", amount: 100 });
    await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 5, ref: "attempt-uuid-2", allow_free: false, op_id: "camp2:reserve" });
    ctx.sent.length = 0;
    await op(ctx.wallet, {
      op: "consume_reserved", uid: "u1", amount: 5, ref: "attempt-uuid-2", allow_free: false, op_id: "camp2:consume",
    });
    const msg = ctx.sent.find((m) => m.ref === "attempt-uuid-2");
    expect(msg.type).toBe("campaign_call");
    expect(msg.app_name).toBe("campaign");
  });

  it("an empty or non-string `type` falls back to campaign_call rather than writing a blank label", async () => {
    await op(ctx.wallet, { op: "credit", uid: "u1", amount: 100 });
    await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 5, ref: "attempt-uuid-3", allow_free: false, op_id: "camp3:reserve" });
    ctx.sent.length = 0;
    await op(ctx.wallet, {
      op: "consume_reserved", uid: "u1", amount: 5, ref: "attempt-uuid-3", allow_free: false, op_id: "camp3:consume", type: "",
    });
    expect(ctx.sent.find((m) => m.ref === "attempt-uuid-3").type).toBe("campaign_call");
  });
});

describe("[AFF-G6-WALLET-1] §4.7/§B2 — the AMBIGUOUS re-consume, and what the reconciler must do about it", () => {
  // §4.7 step 4: within OPS_TTL_MS (48h) a retry on the FROZEN op_id replays the
  // original success verbatim, so it is genuinely free. Beyond 48h the ops row
  // is pruned and the same retry issues a REAL consume — which lands here.
  //
  // A 404 `no_active_reservation` is therefore AMBIGUOUS: it means either
  //   (a) the money already moved (consumed, then released/reaped), or
  //   (b) the reservation never existed on this DO at all.
  // It must NEVER be read as failure and NEVER as success. §4.7 step 5 is the
  // resolution: query `wallet_ledger` for ref = upi_payout:<id>, type='payout'
  // — row present => paid; row absent AND released/expired => released/failed;
  // anything else => needs_reconciliation + alert. The `existed` /
  // `already_spent` / `expired` fields below are the DO's LOCAL hint only; they
  // cannot survive DO state loss, so the ledger stays the arbiter.
  it("a consume after the ref was released returns 404 no_active_reservation", async () => {
    await op(ctx.wallet, { op: "credit", uid: "u1", amount: 100 });
    await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 20, ref: "upi_payout:amb", allow_free: false, op_id: "amb:reserve" });
    await op(ctx.wallet, {
      op: "consume_reserved", uid: "u1", amount: 20, ref: "upi_payout:amb", allow_free: false, op_id: "payout_consume:amb", type: "payout",
    });
    await op(ctx.wallet, { op: "release_reservation", uid: "u1", ref: "upi_payout:amb", op_id: "amb:release" });

    // Same call, fresh op_id — i.e. exactly what a >48h retry looks like once
    // the ops replay cache has aged out.
    const retry = await op(ctx.wallet, {
      op: "consume_reserved", uid: "u1", amount: 20, ref: "upi_payout:amb", allow_free: false, op_id: "payout_consume:amb:late", type: "payout",
    });
    expect(retry.status).toBe(404);
    expect(retry.body.error).toBe("no_active_reservation");
    expect(retry.body.consumed).toBe(0); // and it did NOT charge twice
    // Local hint: this DO HAS seen the ref and it already spent 20.
    expect(retry.body.existed).toBe(true);
    expect(retry.body.already_spent).toBe(20);

    const bal = await op(ctx.wallet, { op: "balance", uid: "u1" });
    expect(bal.body.balance).toBe(80); // charged exactly once
  });

  it("a consume on a ref this DO never reserved ALSO returns 404 — the other half of the ambiguity", async () => {
    const r = await op(ctx.wallet, {
      op: "consume_reserved", uid: "u1", amount: 20, ref: "upi_payout:never", allow_free: false, op_id: "payout_consume:never", type: "payout",
    });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("no_active_reservation");
    expect(r.body.existed).toBe(false); // the ONLY thing distinguishing it locally
    expect(r.body.already_spent).toBe(0);
  });

  it("an EXPIRED-then-reaped ref reports expired:true, so a late consume is not read as a payment", async () => {
    await op(ctx.wallet, { op: "credit", uid: "u1", amount: 100 });
    await op(ctx.wallet, {
      op: "reserve", uid: "u1", amount: 20, ref: "upi_payout:exp", allow_free: false,
      op_id: "exp:reserve", expires_at: Date.now() - 1,
    });
    await ctx.wallet.alarm(); // reaped

    const late = await op(ctx.wallet, {
      op: "consume_reserved", uid: "u1", amount: 20, ref: "upi_payout:exp", allow_free: false, op_id: "payout_consume:exp", type: "payout",
    });
    expect(late.status).toBe(404);
    expect(late.body.existed).toBe(true);
    expect(late.body.expired).toBe(true);
    expect(late.body.already_spent).toBe(0); // nothing was ever consumed
    const bal = await op(ctx.wallet, { op: "balance", uid: "u1" });
    expect(bal.body.balance).toBe(100); // no money moved
  });

  it("re-consuming a FULLY-consumed but not-yet-released ref is ok:true/consumed:0, never a second charge", async () => {
    // Documented deliberately: this is a THIRD outcome the reconciler must not
    // confuse with a fresh successful payment. `consumed: 0` is the tell.
    await op(ctx.wallet, { op: "credit", uid: "u1", amount: 100 });
    await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 30, ref: "upi_payout:twice", allow_free: false, op_id: "twice:reserve" });
    await op(ctx.wallet, {
      op: "consume_reserved", uid: "u1", amount: 30, ref: "upi_payout:twice", allow_free: false, op_id: "payout_consume:twice", type: "payout",
    });
    const again = await op(ctx.wallet, {
      op: "consume_reserved", uid: "u1", amount: 30, ref: "upi_payout:twice", allow_free: false, op_id: "payout_consume:twice:late", type: "payout",
    });
    expect(again.status).toBe(200);
    expect(again.body.consumed).toBe(0); // clamped by the ref's own reservation
    const bal = await op(ctx.wallet, { op: "balance", uid: "u1" });
    expect(bal.body.balance).toBe(70); // charged exactly once
  });
});

describe("account-deletion cascade hook", () => {
  it("clear_ai_remainder zeroes debt and releases aijob reservations without touching balance/bonus", async () => {
    await op(ctx.wallet, { op: "credit", uid: "u1", amount: 10 });
    await op(ctx.wallet, { op: "promo_credit", uid: "u1", amount: 5 });
    await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 2, ref: "aijob:leftover", allow_free: true, op_id: "leftover:reserve" });
    await op(ctx.wallet, { op: "settle_ai_cost", uid: "u1", ref: "aijob:leftover", op_id: "leftover:settle", actual_cost_micro_usd: 4_000 });
    await op(ctx.wallet, { op: "reserve", uid: "u1", amount: 1, ref: "aijob:stranded2", allow_free: true, op_id: "stranded2:reserve" });

    const cleared = await op(ctx.wallet, { op: "clear_ai_remainder", uid: "u1", op_id: "delete:1" });
    expect(cleared.body.cleared_debt_micro_usd).toBe(4_000);
    expect(cleared.body.released_ai_reservations).toBe(1);

    const bal = await op(ctx.wallet, { op: "balance", uid: "u1" });
    expect(bal.body.debt_micro_usd).toBe(0);
    expect(bal.body.balance).toBe(10); // untouched
    expect(bal.body.bonus).toBe(5); // untouched (leftover's charge already happened before deletion)
  });
});

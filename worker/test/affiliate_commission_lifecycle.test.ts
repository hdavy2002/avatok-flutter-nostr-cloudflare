// [AFF-COMM-LIFECYCLE-1] Affiliate commission lifecycle — top-up accrual,
// 30-day qualification, promotion, reversal.
// Spec: Specs/proposals/PROPOSAL-AFFILIATE-UPI-2026-08-05.md §6.1 / §6.2 / §7.
//
// The invariant under test, in one line: A COMMISSION THAT HAS NOT QUALIFIED
// DOES NOT EXIST IN ANY WALLET. payAffiliateOnTopup() writes D1 only; the money
// is created exactly once, later, by runAffiliateQualification().
//
// These run against a REAL SQLite (node:sqlite) wrapped in a D1-shaped shim, and
// the migration-hazard test executes the REAL migration file — so the SQL that
// will be applied to prod is exercised here, not a paraphrase of it.
//
//   npm test   (vitest run)
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// node:sqlite is a runtime built-in that Vite's resolver does not know about
// (it tries to load a package literally named "sqlite" and fails), so pull it in
// through require rather than a static import. Node 22.5+ / this repo runs 26.
type DatabaseSync = any;
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => any;
};

// --- mocks (hoisted state so vi.mock factories can see it) -----------------
const H = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  walletOps: [] as any[],
  walletReply: { status: 200, body: {} as any },
}));

vi.mock("../src/routes/config", () => ({
  readConfig: async () => H.cfg,
}));
vi.mock("../src/routes/wallet", () => ({
  walletOp: async (_env: unknown, _uid: string, op: any) => {
    H.walletOps.push(op);
    return { status: H.walletReply.status, body: H.walletReply.body };
  },
  commissionRate: async () => 0.1,
}));
vi.mock("../src/hooks", () => ({
  track: () => undefined,
  trackUser: async () => undefined,
  metric: () => undefined,
  trackException: async () => undefined,
}));
vi.mock("../src/lib/identity", () => ({
  emailFor: async () => "affiliate@example.com",
}));

const { payAffiliateOnTopup, runAffiliateQualification, reverseAffiliate } =
  await import("../src/routes/affiliate");

// --- D1-shaped shim over node:sqlite ---------------------------------------
// Rewrites D1's ?N placeholders to sqlite named params so a repeated ?2 (the
// reversal UPDATE uses one) binds correctly instead of shifting positions.
function d1(db: DatabaseSync): any {
  return {
    prepare(sql: string) {
      const named = sql.replace(/\?(\d+)/g, (_m, n) => `$p${n}`);
      const params: Record<string, unknown> = {};
      let bound = false;
      const exec = <T>(fn: (st: any) => T): T => {
        const st = db.prepare(named);
        return bound ? fn(st) : fn(st);
      };
      const args = () => (bound ? [params] : []);
      const self = {
        bind(...vals: unknown[]) {
          bound = true;
          vals.forEach((v, i) => { params[`p${i + 1}`] = v === undefined ? null : v; });
          return self;
        },
        async run() {
          const r = exec((st) => st.run(...args()));
          return { meta: { changes: Number((r as any).changes ?? 0) } };
        },
        async first() {
          return exec((st) => st.get(...args())) ?? null;
        },
        async all() {
          return { results: exec((st) => st.all(...args())) as any[] };
        },
      };
      return self;
    },
  };
}

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../migrations/2026-08-05-affiliate-commission-status.sql", import.meta.url)),
  "utf8",
);

// Pre-migration shape of the two tables, verbatim from migrations/affiliate_wallet.sql
// and migrations/wallet.sql. Deliberately WITHOUT qualify_at/promoted_at/risk_flags —
// the migration under test adds them.
const WALLET_SCHEMA_V0 = `
CREATE TABLE affiliate_commissions (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, link_id TEXT NOT NULL,
  affiliate_uid TEXT NOT NULL, referred_uid TEXT NOT NULL, listing_id TEXT NOT NULL,
  app TEXT NOT NULL, gross_coins INTEGER NOT NULL, affiliate_coins INTEGER NOT NULL,
  admin_coins INTEGER NOT NULL, reversed_coins INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE topup_records (
  id TEXT PRIMARY KEY, uid TEXT NOT NULL, amount_coins INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
);
`;
const META_SCHEMA = `
CREATE TABLE affiliates (
  uid TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
);
CREATE TABLE affiliate_attributions (
  referred_uid TEXT NOT NULL, listing_id TEXT NOT NULL, link_id TEXT NOT NULL,
  affiliate_uid TEXT NOT NULL, bound_at INTEGER NOT NULL, source TEXT NOT NULL,
  PRIMARY KEY (referred_uid, listing_id)
);
`;

const DAY = 86_400_000;
const T0 = 1_800_000_000_000;
const AFF = "aff_uid";
const REF = "referred_uid";

let wallet: DatabaseSync;
let meta: DatabaseSync;
let env: any;

/** Fresh databases with the migration APPLIED (the normal, post-deploy world). */
function setup(seed: (w: DatabaseSync, m: DatabaseSync) => void = () => {}) {
  wallet = new DatabaseSync(":memory:");
  meta = new DatabaseSync(":memory:");
  wallet.exec(WALLET_SCHEMA_V0);
  meta.exec(META_SCHEMA);
  seed(wallet, meta);
  wallet.exec(MIGRATION);
  env = { DB_WALLET: d1(wallet), DB_META: d1(meta) };
}

function seedAffiliate(status = "active") {
  meta.prepare("INSERT INTO affiliates (uid, code, status, created_at) VALUES (?,?,?,?)")
    .run(AFF, "abc123", status, T0 - 90 * DAY);
  meta.prepare(
    "INSERT INTO affiliate_attributions (referred_uid, listing_id, link_id, affiliate_uid, bound_at, source) VALUES (?,?,?,?,?,?)",
  ).run(REF, "listing1", "link1", AFF, T0 - 60 * DAY, "link");
}

const rowOf = (id: string) =>
  wallet.prepare("SELECT * FROM affiliate_commissions WHERE id=?").get(id) as any;

beforeEach(() => {
  H.walletOps.length = 0;
  H.walletReply = { status: 200, body: {} };
  H.cfg = {
    avaAffiliateEnabled: true,
    affiliateQualifyDays: 30,
    affiliateMinQualifyingTopupCoins: 100,
    affiliateDailyEarnCapCoins: 2000,
    affiliateMonthlyEarnCapCoins: 20000,
    affiliatePerReferredCapCoins: 1000,
  };
  setup();
  seedAffiliate();
});

// ---------------------------------------------------------------------------
describe("§6.1 accrual — a top-up creates D1 debt, never wallet money", () => {
  it("writes a pending row with qualify_at and performs NO wallet operation", async () => {
    const accrued = await payAffiliateOnTopup(env, REF, 1000, "topup1");
    expect(accrued).toBe(100); // 10%

    const r = rowOf("aff_topup:topup1");
    expect(r).toBeTruthy();
    expect(r.status).toBe("pending");
    expect(r.affiliate_coins).toBe(100);
    expect(r.promoted_at).toBeNull();
    // 30 days out, ±1 minute of wall clock.
    expect(Math.abs(r.qualify_at - (r.created_at + 30 * DAY))).toBeLessThan(60_000);

    // THE invariant: nothing reached a wallet.
    expect(H.walletOps).toEqual([]);
  });

  it("is idempotent per top-up id (ON CONFLICT DO NOTHING, one row)", async () => {
    await payAffiliateOnTopup(env, REF, 1000, "topup1");
    await payAffiliateOnTopup(env, REF, 1000, "topup1");
    const n = wallet.prepare("SELECT COUNT(*) AS n FROM affiliate_commissions").get() as any;
    expect(Number(n.n)).toBe(1);
    expect(H.walletOps).toEqual([]);
  });

  it("accrues nothing when the master flag is off", async () => {
    H.cfg.avaAffiliateEnabled = false;
    expect(await payAffiliateOnTopup(env, REF, 1000, "topupX")).toBe(0);
    expect(rowOf("aff_topup:topupX")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
/** Insert a post-migration pending commission directly, with an explicit clock. */
function pending(id: string, over: Partial<Record<string, unknown>> = {}) {
  const v = {
    id, order_id: id.replace("aff_topup:", ""), link_id: "link1",
    affiliate_uid: AFF, referred_uid: REF, listing_id: "topup", app: "avawallet",
    gross_coins: 1000, affiliate_coins: 100, admin_coins: 0, reversed_coins: 0,
    status: "pending", created_at: T0 - 31 * DAY, qualify_at: T0 - 1 * DAY,
    promoted_at: null, risk_flags: null, ...over,
  } as any;
  wallet.prepare(
    `INSERT INTO affiliate_commissions
     (id, order_id, link_id, affiliate_uid, referred_uid, listing_id, app, gross_coins,
      affiliate_coins, admin_coins, reversed_coins, status, created_at, qualify_at, promoted_at, risk_flags)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    v.id, v.order_id, v.link_id, v.affiliate_uid, v.referred_uid, v.listing_id, v.app,
    v.gross_coins, v.affiliate_coins, v.admin_coins, v.reversed_coins, v.status,
    v.created_at, v.qualify_at, v.promoted_at, v.risk_flags,
  );
  return v;
}

describe("§6.1 promotion — the money is created here, exactly once", () => {
  it("does NOT promote before qualify_at", async () => {
    pending("aff_topup:t1", { qualify_at: T0 + 5 * DAY });
    const r = await runAffiliateQualification(env, T0);
    expect(r).toMatchObject({ scanned: 0, promoted: 0 });
    expect(H.walletOps).toEqual([]);
    expect(rowOf("aff_topup:t1").status).toBe("pending");
  });

  it("promotes a due row with walletOp earn keyed on the commission id", async () => {
    pending("aff_topup:t1");
    const r = await runAffiliateQualification(env, T0);
    expect(r).toMatchObject({ scanned: 1, promoted: 1, promoted_coins: 100 });

    expect(H.walletOps).toHaveLength(1);
    expect(H.walletOps[0]).toMatchObject({
      op: "earn", uid: AFF, amount: 100, op_id: "aff_topup:t1",
    });

    const row = rowOf("aff_topup:t1");
    expect(row.status).toBe("held");
    expect(row.promoted_at).toBe(T0);
  });

  it("running the cron twice credits ONCE (same op_id, row no longer pending)", async () => {
    pending("aff_topup:t1");
    const a = await runAffiliateQualification(env, T0);
    const b = await runAffiliateQualification(env, T0 + 3_600_000);
    expect(a.promoted).toBe(1);
    expect(b).toMatchObject({ scanned: 0, promoted: 0 });
    expect(H.walletOps).toHaveLength(1);
    expect(H.walletOps[0].op_id).toBe("aff_topup:t1");
  });

  it("a transient wallet failure leaves the row pending for the next tick", async () => {
    pending("aff_topup:t1");
    H.walletReply = { status: 500, body: { error: "boom" } };
    const a = await runAffiliateQualification(env, T0);
    expect(a).toMatchObject({ promoted: 0, failed: 1 });
    expect(rowOf("aff_topup:t1").status).toBe("pending");

    H.walletReply = { status: 200, body: {} };
    const b = await runAffiliateQualification(env, T0 + 3_600_000);
    expect(b.promoted).toBe(1);
  });

  it("promotes nothing while the master flag is off (rows just wait)", async () => {
    pending("aff_topup:t1");
    H.cfg.avaAffiliateEnabled = false;
    expect(await runAffiliateQualification(env, T0)).toMatchObject({ scanned: 0, promoted: 0 });
    expect(rowOf("aff_topup:t1").status).toBe("pending");
  });

  it("end-to-end: accrue, then promote once the window has passed", async () => {
    await payAffiliateOnTopup(env, REF, 5000, "e2e");
    expect(H.walletOps).toEqual([]);
    const created = rowOf("aff_topup:e2e");

    // A tick inside the window does nothing…
    await runAffiliateQualification(env, created.qualify_at - 1);
    expect(H.walletOps).toEqual([]);
    // …and one after it pays exactly once.
    const r = await runAffiliateQualification(env, created.qualify_at + 1);
    expect(r.promoted).toBe(1);
    expect(H.walletOps).toHaveLength(1);
    expect(H.walletOps[0].amount).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// THE HIGHEST-RISK TEST IN THIS FILE.
// ---------------------------------------------------------------------------
describe("MIGRATION HAZARD — rows credited under the old immediate-earn path", () => {
  /** Build a DB seeded PRE-migration, then apply the real migration file. */
  function legacyWorld() {
    setup((w) => {
      const ins = w.prepare(
        `INSERT INTO affiliate_commissions
         (id, order_id, link_id, affiliate_uid, referred_uid, listing_id, app, gross_coins,
          affiliate_coins, admin_coins, reversed_coins, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      // Every status the old code could leave behind — all of them ALREADY paid.
      ins.run("aff_topup:old_held", "old_held", "link1", AFF, REF, "topup", "avawallet", 1000, 100, 0, 0, "held", T0 - 400 * DAY);
      ins.run("aff_topup:old_settled", "old_settled", "link1", AFF, REF, "topup", "avawallet", 2000, 200, 0, 0, "settled", T0 - 400 * DAY);
      // The nastiest case: a legacy row that somehow reads 'pending'. It was still
      // credited by the old path, so it must NOT be promotable either.
      ins.run("aff_topup:old_pending", "old_pending", "link1", AFF, REF, "topup", "avawallet", 3000, 300, 0, 0, "pending", T0 - 400 * DAY);
    });
    seedAffiliate();
  }

  it("the migration backfills promoted_at and leaves nothing in 'pending'", () => {
    legacyWorld();
    const rows = wallet.prepare("SELECT id, status, promoted_at, qualify_at FROM affiliate_commissions").all() as any[];
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.promoted_at).not.toBeNull();
      expect(r.qualify_at).toBeNull();   // legacy rows never get a window
      expect(r.status).not.toBe("pending");
    }
    expect(rowOf("aff_topup:old_settled").status).toBe("available"); // 'settled' renamed
    expect(rowOf("aff_topup:old_pending").status).toBe("held");
  });

  it("the cron NEVER promotes a pre-migration row — no second payment", async () => {
    legacyWorld();
    // Run far in the future: if any time-based guard were the only protection,
    // this is where the double-credit would happen.
    const r = await runAffiliateQualification(env, T0 + 10_000 * DAY);
    expect(r).toMatchObject({ scanned: 0, promoted: 0, promoted_coins: 0 });
    expect(H.walletOps).toEqual([]);
  });

  it("even forcing a legacy row back to 'pending' cannot promote it (qualify_at IS NULL)", async () => {
    legacyWorld();
    wallet.exec("UPDATE affiliate_commissions SET status='pending' WHERE id='aff_topup:old_held'");
    const r = await runAffiliateQualification(env, T0 + 10_000 * DAY);
    expect(r.promoted).toBe(0);
    expect(H.walletOps).toEqual([]);
  });

  it("a NEW row written after the migration still promotes normally", async () => {
    legacyWorld();
    pending("aff_topup:new1");
    const r = await runAffiliateQualification(env, T0);
    expect(r.promoted).toBe(1);
    expect(H.walletOps.map((o) => o.op_id)).toEqual(["aff_topup:new1"]);
  });
});

// ---------------------------------------------------------------------------
describe("§6.2 promotion-time gates", () => {
  it("a suspended affiliate is parked in held_review, not paid", async () => {
    pending("aff_topup:t1");
    meta.exec(`UPDATE affiliates SET status='suspended' WHERE uid='${AFF}'`);
    const r = await runAffiliateQualification(env, T0);
    expect(r).toMatchObject({ promoted: 0, review: 1 });
    expect(H.walletOps).toEqual([]);
    const row = rowOf("aff_topup:t1");
    expect(row.status).toBe("held_review");
    expect(JSON.parse(row.risk_flags)).toContain("affiliate_not_active");
  });

  it("a refunded source top-up reverses instead of paying", async () => {
    pending("aff_topup:t1");
    wallet.prepare("INSERT INTO topup_records (id, uid, amount_coins, status, created_at) VALUES (?,?,?,?,?)")
      .run("t1", REF, 1000, "refunded", T0 - 31 * DAY);
    const r = await runAffiliateQualification(env, T0);
    expect(r).toMatchObject({ promoted: 0, reversed: 1 });
    expect(H.walletOps).toEqual([]);
    expect(rowOf("aff_topup:t1").status).toBe("reversed");
  });

  it("a missing topup_records row is not treated as a refund (Play top-ups have none)", async () => {
    pending("aff_topup:t1");
    const r = await runAffiliateQualification(env, T0);
    expect(r.promoted).toBe(1);
  });

  it("a below-minimum top-up is dust-farming and reverses", async () => {
    pending("aff_topup:t1", { gross_coins: 50, affiliate_coins: 5 });
    const r = await runAffiliateQualification(env, T0);
    expect(r.reversed).toBe(1);
    expect(H.walletOps).toEqual([]);
    expect(JSON.parse(rowOf("aff_topup:t1").risk_flags)).toContain("below_min_topup");
  });

  it("a blocking clustering flag parks the row for a human", async () => {
    pending("aff_topup:t1", { risk_flags: JSON.stringify(["device_cluster"]) });
    const r = await runAffiliateQualification(env, T0);
    expect(r.review).toBe(1);
    expect(H.walletOps).toEqual([]);
    expect(rowOf("aff_topup:t1").status).toBe("held_review");
  });

  it("self-referral is re-checked at promotion time and reverses", async () => {
    pending("aff_topup:t1", { referred_uid: AFF });
    const r = await runAffiliateQualification(env, T0);
    expect(r.reversed).toBe(1);
    expect(H.walletOps).toEqual([]);
  });

  it("a cap breach keeps the row PENDING and flags it — never dropped, never paid", async () => {
    H.cfg.affiliateDailyEarnCapCoins = 50; // below the 100-coin commission
    pending("aff_topup:t1");
    const r = await runAffiliateQualification(env, T0);
    expect(r).toMatchObject({ promoted: 0, flagged: 1, reversed: 0, review: 0 });
    expect(H.walletOps).toEqual([]);

    const row = rowOf("aff_topup:t1");
    expect(row.status).toBe("pending");          // still owed
    expect(row.promoted_at).toBeNull();
    expect(JSON.parse(row.risk_flags)).toContain("cap_daily");

    // …and it promotes once the cap is raised (retried, not lost).
    H.cfg.affiliateDailyEarnCapCoins = 2000;
    const r2 = await runAffiliateQualification(env, T0 + 3_600_000);
    expect(r2.promoted).toBe(1);
    expect(H.walletOps).toHaveLength(1);
  });

  it("the per-referred cap counts only PROMOTED coins", async () => {
    H.cfg.affiliatePerReferredCapCoins = 150;
    // An already-promoted 100 inside the window + a new 100 = 200 > 150.
    pending("aff_topup:done", { status: "held", promoted_at: T0 - 2 * DAY, qualify_at: T0 - 3 * DAY });
    pending("aff_topup:t1");
    const r = await runAffiliateQualification(env, T0);
    expect(r).toMatchObject({ promoted: 0, flagged: 1 });
    expect(JSON.parse(rowOf("aff_topup:t1").risk_flags)).toContain("cap_per_referred");
  });
});

// ---------------------------------------------------------------------------
describe("§6.1 reversal — pending costs nothing to unwind", () => {
  it("a refund on a PENDING commission is a pure D1 flip, no wallet clawback", async () => {
    pending("aff_topup:t1");
    const clawed = await reverseAffiliate(env, "t1", 1000, "chargeback", "op1");

    expect(clawed).toBe(0);              // nothing was recovered because nothing was paid
    expect(H.walletOps).toEqual([]);     // no debit_hold, no spend
    const row = rowOf("aff_topup:t1");
    expect(row.status).toBe("reversed");
    expect(row.reversed_coins).toBe(100);
    expect(JSON.parse(row.risk_flags)).toContain("refunded_before_qualification");
  });

  it("a reversed-while-pending row is never promoted afterwards", async () => {
    pending("aff_topup:t1");
    await reverseAffiliate(env, "t1", 1000, "chargeback", "op1");
    const r = await runAffiliateQualification(env, T0);
    expect(r.promoted).toBe(0);
    expect(H.walletOps).toEqual([]);
  });

  it("a PARTIAL refund while pending stays pending and promotes the remainder", async () => {
    pending("aff_topup:t1");
    await reverseAffiliate(env, "t1", 400, "partial", "op1"); // 40% → claw 40
    const row = rowOf("aff_topup:t1");
    expect(row.status).toBe("pending");
    expect(row.reversed_coins).toBe(40);
    expect(H.walletOps).toEqual([]);

    // Gate 1 reverses anything already partly refunded rather than paying a
    // reduced amount — the refund is itself the risk signal.
    const r = await runAffiliateQualification(env, T0);
    expect(r).toMatchObject({ promoted: 0, reversed: 1 });
    expect(H.walletOps).toEqual([]);
  });

  it("a refund AFTER promotion still claws back from the wallet (unchanged path)", async () => {
    pending("aff_topup:t1");
    await runAffiliateQualification(env, T0);
    expect(H.walletOps).toHaveLength(1);          // the earn
    H.walletOps.length = 0;
    H.walletReply = { status: 200, body: { clawed: 100 } };

    const clawed = await reverseAffiliate(env, "t1", 1000, "chargeback", "op1");
    expect(clawed).toBe(100);
    expect(H.walletOps).toHaveLength(1);
    expect(H.walletOps[0]).toMatchObject({
      op: "debit_hold", uid: AFF, amount: 100, op_id: "affrev:aff_topup:t1:op1",
    });
    const row = rowOf("aff_topup:t1");
    expect(row.status).toBe("reversed");
    expect(row.reversed_coins).toBe(100);
  });

  it("a matured (available) commission claws back hold-first, then spendable", async () => {
    pending("aff_topup:t1", { status: "available", promoted_at: T0 - 8 * DAY });
    H.walletReply = { status: 200, body: { clawed: 30 } };  // only 30 left in hold
    const clawed = await reverseAffiliate(env, "t1", 1000, "chargeback", "op1");
    expect(clawed).toBe(100);
    expect(H.walletOps.map((o) => o.op)).toEqual(["debit_hold", "spend"]);
    expect(H.walletOps[1]).toMatchObject({ amount: 70, op_id: "affrev:aff_topup:t1:op1:rest" });
  });
});

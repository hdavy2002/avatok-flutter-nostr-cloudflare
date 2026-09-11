// [SETTLE-CHECKIN-1] Contract tests for the creator check-in settlement decision
// (RULEBOOK-PAID-SESSIONS.md §2 C1/C2, Specs/PLAN-2026-09-11-WAITING-ROOM-BUILD.md WP3).
// Source-text contracts, matching this repo's convention for settlement wiring
// (commercial_lifecycle_contract.test.ts, commercial_hardening_contract.test.ts) —
// the settlement executor is DB-driven end to end, so its cross-module wiring is
// verified this way rather than by standing up a fake D1.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const settlement = readFileSync(resolve(root, "src/commercial_settlement.ts"), "utf8");
const moneyEngine = readFileSync(resolve(root, "src/money_engine.ts"), "utf8");
const rules = readFileSync(resolve(root, "src/rules.ts"), "utf8");
const migration = readFileSync(resolve(root, "migrations/2026-09-11-settle-checkin-receipt-meta.sql"), "utf8");
const lifecycle = readFileSync(resolve(root, "src/routes/commercial_lifecycle.ts"), "utf8");

describe("consult settlement uses the check-in decision, not two-party overlap", () => {
  it("branches consult_1to1 away from deliveryError and onto consultCheckInDecision", () => {
    expect(settlement).toContain("async function consultCheckInDecision(");
    expect(settlement).toContain("if (authority.kind === \"consult_1to1\")");
    expect(settlement).toContain("consultCheckInDecision(env, job.commercial_session_id, authority.booking_id, authority.scheduled_at, authority.creator_id)");
    // live events still take the two-party overlap path — only the else branch calls it.
    const branch = settlement.slice(settlement.indexOf("if (authority.kind === \"consult_1to1\")"));
    expect(branch.indexOf("consultCheckInDecision")).toBeLessThan(branch.indexOf("await deliveryError("));
  });

  it("checked-in evidence is session_attendance(role='host', THIS creator) OR a creator participant interval, OVERLAPPING the bounded window (fix 3)", () => {
    expect(settlement).toContain("session_id=?1 AND role='host' AND user_id=?2");
    expect(settlement).toContain("m.role='creator' AND i.account_id=?2");
    // fix 3: bounded on both sides — a check-in the day before starts_at must not count.
    expect(settlement).toContain("export function consultCheckInWindow(");
    expect(settlement).toContain("joined_at<=?3 AND COALESCE(left_at,?4)>=?5");
    expect(settlement).toContain("async function checkInWindowMs(env: Env)");
    expect(settlement).toContain("cfg.sessionCreatorCheckInMin");
    expect(settlement).toContain("readConfig(env)");
  });

  it("checked in settles full through the existing release path; not checked in refunds + strikes through the existing refund path", () => {
    expect(settlement).toContain("checkIn = { rule: \"creator_checked_in\", checkedInAt: evidence.checkedInAt as number };");
    expect(settlement).toContain("await releaseSnapshot(env, authority);");
    expect(settlement).toContain("await finishSettlement(env, job, authority, checkIn);");
    expect(settlement).toContain("const outcome = await refundCreatorNoShow(env, job, authority);");
    expect(settlement).toContain("await insertNoShowStrike(env, authority.creator_id, authority.order_id, job.commercial_session_id);");
    // refundCreatorNoShow reuses the SAME executeCommercialRefund/finalizeCommercialRefund
    // primitives as the live-event no-show branch and the overdue sweep — one refund rail,
    // four call sites (live no-show, refundCreatorNoShow, finalizeOverdueNoShow, and
    // [LIVE-GRACE-1]'s settleLiveHostNoReturn — the per-ticket unconsumed-share refund).
    expect(settlement.match(/executeCommercialRefund\(env, \{/g)?.length).toBe(4);
    expect(settlement.match(/finalizeCommercialRefund\(env, \{/g)?.length).toBe(4);
  });

  it("mirrors the account_strikes insert pattern from money_engine.ts, deterministic + idempotent (fix 7)", () => {
    expect(settlement).toContain("INSERT OR IGNORE INTO account_strikes");
    expect(settlement).toContain("'marketplace_no_show'");
    expect(settlement).toContain("'commercial_settlement','strike'");
    expect(settlement).toContain("`strike:no-show:${orderId}`");
    expect(moneyEngine).toContain("INSERT INTO account_strikes");
    expect(moneyEngine).toContain("'refund_engine','strike'");
  });

  it("loadOverdueNoShowAuthorities uses starts_at + check_in_ms via readConfig, not a hardcoded 15 min", () => {
    expect(settlement).not.toContain("Date.now() - 15 * 60_000");
    expect(settlement).toContain("Date.now() - checkInMs");
    expect(settlement).toContain("const checkInMs = await checkInWindowMs(env);");
  });

  it("receipt gains rule + checked_in_at (nullable, additive migration — not applied)", () => {
    expect(settlement).toContain("rule,checked_in_at)");
    expect(settlement).toContain("(receipt.rule ?? null) !== rule");
    expect(settlement).toContain("(receipt.checked_in_at ?? null) !== checkedInAt");
    expect(migration).toContain("ALTER TABLE commercial_receipts ADD COLUMN rule TEXT;");
    expect(migration).toContain("ALTER TABLE commercial_receipts ADD COLUMN checked_in_at INTEGER;");
  });

  it("fix 6: a pre-migration receipt (rule IS NULL) is never a replay mismatch", () => {
    expect(settlement).toContain('((receipt.rule ?? null) !== null');
    expect(settlement).toContain("(receipt.rule ?? null) !== rule || (receipt.checked_in_at ?? null) !== checkedInAt))");
  });

  it("fix 2: the overdue-no-show sweep asks consultCheckInDecision before refunding, and skips (settles later, in full) when checked in", () => {
    expect(settlement).toContain('Promise<"refunded" | "review_pending" | "skipped">');
    const body = settlement.slice(settlement.indexOf("async function finalizeOverdueNoShow("));
    expect(body.indexOf("consultCheckInDecision")).toBeLessThan(body.indexOf("executeCommercialRefund"));
    expect(settlement).toContain('return "skipped";');
  });

  it("fix 1: the orphan no-show sweep is scoped by SETTLE-CHECKIN-2 (commercial_lifecycle.ts owns the SQL)", () => {
    expect(lifecycle).toContain("import { consultCheckInWindow } from \"../commercial_settlement\";");
    expect(lifecycle).toContain("session_attendance");
    expect(lifecycle).not.toContain("Date.now() - 15 * 60_000;\n  const safeLimit");
  });
});

// [SETTLE-CHECKIN-2] Behavioral coverage for the pieces cheap to isolate: the check-in
// decision itself (DB-only, no wallet/ledger side effects) and strike idempotency.
describe("consultCheckInDecision + insertNoShowStrike (node:sqlite)", () => {
  it("creator checked in at minute 18 -> checkedIn=true; a check-in the day before starts_at -> checkedIn=false", async () => {
    const { createRequire } = await import("node:module");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => any };
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE session_attendance (
        session_id TEXT, order_id TEXT, user_id TEXT, role TEXT, joined_at INTEGER, left_at INTEGER
      );
      CREATE TABLE commercial_participant_intervals (
        interval_id TEXT PRIMARY KEY, commercial_session_id TEXT, account_id TEXT,
        provider_user_id TEXT, provider_session_id TEXT, joined_event_id TEXT, left_event_id TEXT,
        joined_at INTEGER, left_at INTEGER, connected_ms INTEGER, reconciliation_state TEXT,
        created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE commercial_session_members (
        commercial_session_id TEXT, account_id TEXT, entitlement_id TEXT, provider_user_id TEXT,
        role TEXT, order_id TEXT, added_at INTEGER, removed_at INTEGER
      );
    `);
    function makeStatement(sql: string) {
      let named = ""; let next = 1; const used = new Set<number>();
      for (let i = 0; i < sql.length; i++) {
        if (sql[i] !== "?") { named += sql[i]; continue; }
        let j = i + 1;
        while (j < sql.length && /\d/.test(sql[j])) j++;
        if (j > i + 1) { const index = Number(sql.slice(i + 1, j)); named += `$p${index}`; used.add(index); next = Math.max(next, index + 1); i = j - 1; }
        else { named += `$p${next}`; used.add(next); next++; }
      }
      let params: Record<string, unknown> = {};
      return {
        bind(...values: unknown[]) { params = {}; for (const index of used) params[`p${index}`] = values[index - 1] === undefined ? null : values[index - 1]; return this; },
        async run() { const r = db.prepare(named).run(params); return { meta: { changes: Number(r.changes ?? 0) } }; },
        async first<T = any>() { return (db.prepare(named).get(params) as T | undefined) ?? null; },
        async all<T = any>() { return { results: db.prepare(named).all(params) as T[] }; },
      };
    }
    const env = { DB_META: { prepare: makeStatement }, TOKENS: { get: async () => null } } as any;
    const { consultCheckInDecision } = await import("../src/commercial_settlement");

    const startsAt = Date.now() - 80 * 60_000;
    db.prepare("INSERT INTO session_attendance (session_id,order_id,user_id,role,joined_at,left_at) VALUES (?,?,?,?,?,?)")
      .run("booking-1", "order-1", "creator-1", "host", startsAt + 18 * 60_000, null);
    const checkedIn = await consultCheckInDecision(env, "session-1", "booking-1", startsAt, "creator-1");
    expect(checkedIn.checkedIn).toBe(true);

    const dayBefore = startsAt - 24 * 60 * 60_000;
    db.prepare("INSERT INTO session_attendance (session_id,order_id,user_id,role,joined_at,left_at) VALUES (?,?,?,?,?,?)")
      .run("booking-2", "order-2", "creator-1", "host", dayBefore, dayBefore + 5 * 60_000);
    const notCheckedIn = await consultCheckInDecision(env, "session-2", "booking-2", startsAt, "creator-1");
    expect(notCheckedIn.checkedIn).toBe(false);
  });

  it("insertNoShowStrike is idempotent per order_id (INSERT OR IGNORE on a deterministic id)", async () => {
    const { createRequire } = await import("node:module");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => any };
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE account_strikes (
        id TEXT PRIMARY KEY, uid TEXT, clerk_user_id TEXT, category TEXT, evidence_url TEXT,
        ai_confidence REAL, source TEXT, action_taken TEXT, created_at INTEGER
      );
    `);
    function makeStatement(sql: string) {
      let named = ""; let next = 1; const used = new Set<number>();
      for (let i = 0; i < sql.length; i++) {
        if (sql[i] !== "?") { named += sql[i]; continue; }
        let j = i + 1;
        while (j < sql.length && /\d/.test(sql[j])) j++;
        if (j > i + 1) { const index = Number(sql.slice(i + 1, j)); named += `$p${index}`; used.add(index); next = Math.max(next, index + 1); i = j - 1; }
        else { named += `$p${next}`; used.add(next); next++; }
      }
      let params: Record<string, unknown> = {};
      return {
        bind(...values: unknown[]) { params = {}; for (const index of used) params[`p${index}`] = values[index - 1] === undefined ? null : values[index - 1]; return this; },
        async run() { const r = db.prepare(named).run(params); return { meta: { changes: Number(r.changes ?? 0) } }; },
        async first<T = any>() { return (db.prepare(named).get(params) as T | undefined) ?? null; },
        async all<T = any>() { return { results: db.prepare(named).all(params) as T[] }; },
      };
    }
    const env = { DB_META: { prepare: makeStatement } } as any;
    const { insertNoShowStrike } = await import("../src/commercial_settlement");

    await insertNoShowStrike(env, "creator-1", "order-strike-1", "session-1");
    await insertNoShowStrike(env, "creator-1", "order-strike-1", "session-1-retry");
    const rows = db.prepare("SELECT COUNT(*) n FROM account_strikes WHERE uid=?").get("creator-1") as any;
    expect(rows.n).toBe(1);
  });
});

describe("money_engine.ts delegates commercial consult orders", () => {
  it("never moves money for bookings.kind='consult_1to1' — returns a logged noop instead", () => {
    expect(moneyEngine).toContain("async function isCommercialBooking(env: Env, msg: MoneyMsg)");
    expect(moneyEngine).toContain("bookings WHERE id=?1");
    expect(moneyEngine).toContain("row?.kind === \"consult_1to1\"");
    expect(moneyEngine).toContain("if (await isCommercialBooking(env, msg))");
    expect(moneyEngine).toContain("console.log(`[money_engine] delegation guard:");
    expect(moneyEngine).toContain("commercial_settlement.ts owns this order");
    expect(moneyEngine.indexOf("isCommercialBooking(env, msg)")).toBeLessThan(moneyEngine.indexOf("const ctx = await loadCtx(env, msg.sid, msg.kind);"));
  });
});

describe("rules.ts R2 pays the creator in full on buyer no-show (no pro-rata)", () => {
  it("releases the whole order gross to the creator and settles the order", () => {
    expect(rules).toContain("R2 buyer no-show, creator waited    → creator paid IN FULL, no refund");
    expect(rules).toContain("{ kind: \"release\", orderId: o.id, gross: o.amount, rule: \"R2\", email: \"settlement_paid\" }");
    expect(rules).toContain("{ kind: \"set_status\", orderId: o.id, status: \"settled\" }");
    expect(rules).not.toContain("prorata");
  });
});

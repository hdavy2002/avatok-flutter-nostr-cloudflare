import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

vi.mock("../src/hooks", () => ({ track: async () => undefined, metric: () => undefined }));
vi.mock("../src/routes/config", () => ({
  readConfig: async () => ({ liveHostGraceMin: 10 } as unknown as Record<string, unknown>),
}));
const sessionOpMock = vi.fn(async () => ({ ok: true }));
vi.mock("../src/routes/live", () => ({ sessionOp: (...args: unknown[]) => sessionOpMock(...args) }));
const notifyCommercialUserMock = vi.fn(async () => undefined);
const notifyLiveAudienceMock = vi.fn(async () => ({ attempted: 0, failed: 0 }));
vi.mock("../src/lib/commercial_notifications", () => ({
  notifyCommercialUser: (...args: unknown[]) => notifyCommercialUserMock(...args),
  notifyLiveAudience: (...args: unknown[]) => notifyLiveAudienceMock(...args),
}));
vi.mock("../src/routes/listings", () => ({
  systemMarkListingCompleted: async () => ({ ok: true }),
}));
vi.mock("../src/lib/creator_stats", () => ({ refreshCreatorStats: async () => undefined }));

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => any;
};

// [LIVE-GRACE-1] Same minimal D1-shaped node:sqlite wrapper as
// commercial_session_clock.test.ts.
function d1(db: any): any {
  function makeStatement(sql: string) {
    let named = "";
    let next = 1;
    const used = new Set<number>();
    for (let i = 0; i < sql.length; i++) {
      if (sql[i] !== "?") { named += sql[i]; continue; }
      let j = i + 1;
      while (j < sql.length && /\d/.test(sql[j])) j++;
      if (j > i + 1) {
        const index = Number(sql.slice(i + 1, j));
        named += `$p${index}`; used.add(index); next = Math.max(next, index + 1); i = j - 1;
      } else { named += `$p${next}`; used.add(next); next++; }
    }
    let params: Record<string, unknown> = {};
    const wrapped = {
      bind(...values: unknown[]) {
        const maxIndex = used.size ? Math.max(...used) : 0;
        if (values.length > maxIndex) throw new Error(`too many binds: ${values.length} > ${maxIndex}`);
        params = {};
        for (const index of used) params[`p${index}`] = values[index - 1] === undefined ? null : values[index - 1];
        return wrapped;
      },
      async run() {
        const result = db.prepare(named).run(params);
        return { meta: { changes: Number(result.changes ?? 0) } };
      },
      async first<T = any>(): Promise<T | null> {
        return (db.prepare(named).get(params) as T | undefined) ?? null;
      },
      async all<T = any>(): Promise<{ results: T[] }> {
        return { results: db.prepare(named).all(params) as T[] };
      },
    };
    return wrapped;
  }
  return {
    prepare: makeStatement,
    async batch(statements: ReturnType<typeof makeStatement>[]) {
      const results = [];
      for (const stmt of statements) results.push(await stmt.run());
      return results;
    },
  };
}

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE commercial_sessions (
      commercial_session_id TEXT PRIMARY KEY, kind TEXT NOT NULL, listing_id TEXT NOT NULL,
      booking_id TEXT, order_id TEXT, creator_id TEXT NOT NULL, provider TEXT NOT NULL,
      provider_call_type TEXT NOT NULL, provider_call_id TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 1, scheduled_at INTEGER NOT NULL,
      backstage_opened_at INTEGER, live_started_at INTEGER, ended_at INTEGER,
      state TEXT NOT NULL, state_version INTEGER NOT NULL DEFAULT 1,
      settlement_state TEXT NOT NULL DEFAULT 'not_ready',
      recording_state TEXT NOT NULL DEFAULT 'disabled', replay_state TEXT NOT NULL DEFAULT 'disabled',
      policy_snapshot_id TEXT, reconnect_deadline_ms INTEGER, end_outcome TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE commercial_live_outages (
      outage_id TEXT PRIMARY KEY, commercial_session_id TEXT NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE commercial_participant_intervals (
      interval_id TEXT PRIMARY KEY, commercial_session_id TEXT NOT NULL, account_id TEXT NOT NULL,
      provider_user_id TEXT NOT NULL, provider_session_id TEXT NOT NULL, joined_event_id TEXT NOT NULL,
      left_event_id TEXT, joined_at INTEGER NOT NULL, left_at INTEGER, connected_ms INTEGER,
      reconciliation_state TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE commercial_settlement_jobs (
      settlement_job_id TEXT PRIMARY KEY, commercial_session_id TEXT NOT NULL, order_id TEXT NOT NULL,
      state TEXT NOT NULL, terminal_event_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      funds_verified_at INTEGER, ledger_confirmed_at INTEGER, last_error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE commercial_policy_snapshots (
      policy_snapshot_id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, listing_id TEXT NOT NULL,
      booking_id TEXT, buyer_id TEXT NOT NULL, creator_id TEXT NOT NULL, kind TEXT NOT NULL,
      gross_amount INTEGER NOT NULL, currency TEXT NOT NULL, creator_fee_pct INTEGER NOT NULL,
      settlement_hold_hours INTEGER NOT NULL, platform_fee_amount INTEGER NOT NULL,
      creator_amount INTEGER NOT NULL, cancellation_policy_json TEXT NOT NULL,
      conversion_snapshot_json TEXT, policy_version TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE commercial_entitlements (
      entitlement_id TEXT PRIMARY KEY, kind TEXT NOT NULL, listing_id TEXT NOT NULL, booking_id TEXT,
      order_id TEXT, account_id TEXT NOT NULL, role TEXT NOT NULL, state TEXT NOT NULL,
      starts_at INTEGER, ends_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  return { db, env: { DB_META: d1(db) } };
}

function insertSession(db: any, args: { id: string; listingId: string; state: string; reconnectDeadlineMs?: number | null }) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO commercial_sessions
     (commercial_session_id,kind,listing_id,booking_id,order_id,creator_id,provider,
      provider_call_type,provider_call_id,scheduled_at,state,reconnect_deadline_ms,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    args.id, "live_event", args.listingId, null, null, "creator-1", "getstream",
    "avatok_livestream", `call-${args.id}`, now, args.state, args.reconnectDeadlineMs ?? null, now, now,
  );
}

let lib: typeof import("../src/lib/live_grace");
let currentDb: any;
beforeEach(async () => {
  vi.resetModules();
  sessionOpMock.mockClear();
  notifyCommercialUserMock.mockClear();
  notifyLiveAudienceMock.mockClear();
  lib = await import("../src/lib/live_grace");
});
afterEach(() => { currentDb?.close(); currentDb = null; });

describe("armLiveGrace [LIVE-GRACE-1]", () => {
  it("sets reconnect_deadline_ms, opens an outage row, arms the DO alarm, pushes the creator", async () => {
    const { db, env } = setup();
    currentDb = db;
    insertSession(db, { id: "session-1", listingId: "listing-1", state: "live" });
    const leftAt = Date.now();

    await lib.armLiveGrace(env as any, { commercialSessionId: "session-1", listingId: "listing-1", creatorId: "creator-1" }, leftAt);

    const session = db.prepare("SELECT reconnect_deadline_ms FROM commercial_sessions WHERE commercial_session_id=?").get("session-1") as any;
    expect(Number(session.reconnect_deadline_ms)).toBe(leftAt + 10 * 60_000);

    const outage = db.prepare("SELECT started_at,ended_at FROM commercial_live_outages WHERE commercial_session_id=?").get("session-1") as any;
    expect(Number(outage.started_at)).toBe(leftAt);
    expect(outage.ended_at).toBeNull();

    expect(sessionOpMock).toHaveBeenCalledTimes(1);
    expect(sessionOpMock.mock.calls[0][1]).toBe("live:listing-1");
    expect(sessionOpMock.mock.calls[0][2]).toMatchObject({ op: "live_grace_arm", t: leftAt + 10 * 60_000 });

    expect(notifyCommercialUserMock).toHaveBeenCalledTimes(1);
    expect(notifyCommercialUserMock.mock.calls[0][1]).toBe("creator-1");
    expect(notifyCommercialUserMock.mock.calls[0][2]).toMatchObject({ type: "commercial_reconnect", listingId: "listing-1" });
  });

  it("is idempotent — a replayed left webhook does not re-arm or double-push", async () => {
    const { db, env } = setup();
    currentDb = db;
    const leftAt = Date.now();
    insertSession(db, { id: "session-2", listingId: "listing-2", state: "live", reconnectDeadlineMs: leftAt + 10 * 60_000 });

    await lib.armLiveGrace(env as any, { commercialSessionId: "session-2", listingId: "listing-2", creatorId: "creator-1" }, leftAt + 1000);

    const session = db.prepare("SELECT reconnect_deadline_ms FROM commercial_sessions WHERE commercial_session_id=?").get("session-2") as any;
    expect(Number(session.reconnect_deadline_ms)).toBe(leftAt + 10 * 60_000); // unchanged
    expect(sessionOpMock).not.toHaveBeenCalled();
    expect(notifyCommercialUserMock).not.toHaveBeenCalled();
    const outages = db.prepare("SELECT COUNT(*) n FROM commercial_live_outages WHERE commercial_session_id=?").get("session-2") as any;
    expect(outages.n).toBe(0);
  });
});

describe("clearLiveGrace [LIVE-GRACE-1]", () => {
  it("clears the deadline and closes the open outage on host rejoin", async () => {
    const { db, env } = setup();
    currentDb = db;
    const leftAt = Date.now() - 60_000;
    insertSession(db, { id: "session-3", listingId: "listing-3", state: "live", reconnectDeadlineMs: leftAt + 10 * 60_000 });
    db.prepare(
      "INSERT INTO commercial_live_outages (outage_id,commercial_session_id,started_at,created_at,updated_at) VALUES (?,?,?,?,?)",
    ).run("outage-1", "session-3", leftAt, leftAt, leftAt);

    const rejoinAt = Date.now();
    await lib.clearLiveGrace(env as any, { commercialSessionId: "session-3", listingId: "listing-3", creatorId: "creator-1" }, rejoinAt);

    const session = db.prepare("SELECT reconnect_deadline_ms FROM commercial_sessions WHERE commercial_session_id=?").get("session-3") as any;
    expect(session.reconnect_deadline_ms).toBeNull();
    const outage = db.prepare("SELECT ended_at FROM commercial_live_outages WHERE outage_id=?").get("outage-1") as any;
    expect(Number(outage.ended_at)).toBe(rejoinAt);
    expect(sessionOpMock).toHaveBeenCalledWith(env, "live:listing-3", { op: "live_grace_clear" });
  });

  it("is a no-op when there is no open grace window", async () => {
    const { db, env } = setup();
    currentDb = db;
    insertSession(db, { id: "session-4", listingId: "listing-4", state: "live" });
    await lib.clearLiveGrace(env as any, { commercialSessionId: "session-4", listingId: "listing-4", creatorId: "creator-1" }, Date.now());
    expect(sessionOpMock).not.toHaveBeenCalled();
  });
});

describe("endLiveOnHostNoReturn [LIVE-GRACE-1]", () => {
  it("ends the session with end_outcome='host_no_return', closes intervals/outage, queues settlement", async () => {
    const { db, env } = setup();
    currentDb = db;
    const leftAt = Date.now() - 11 * 60_000;
    const deadline = leftAt + 10 * 60_000;
    insertSession(db, { id: "session-5", listingId: "listing-5", state: "live", reconnectDeadlineMs: deadline });
    db.prepare(
      "INSERT INTO commercial_live_outages (outage_id,commercial_session_id,started_at,created_at,updated_at) VALUES (?,?,?,?,?)",
    ).run("outage-5", "session-5", leftAt, leftAt, leftAt);
    db.prepare(
      `INSERT INTO commercial_participant_intervals
       (interval_id,commercial_session_id,account_id,provider_user_id,provider_session_id,
        joined_event_id,joined_at,reconciliation_state,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run("interval-buyer", "session-5", "buyer-1", "buyer-1", "sess", "evt-1", leftAt - 60_000, "open", leftAt, leftAt);
    db.prepare(
      `INSERT INTO commercial_policy_snapshots
       (policy_snapshot_id,order_id,listing_id,booking_id,buyer_id,creator_id,kind,gross_amount,currency,
        creator_fee_pct,settlement_hold_hours,platform_fee_amount,creator_amount,cancellation_policy_json,
        policy_version,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run("policy:order-1", "order-1", "listing-5", null, "buyer-1", "creator-1", "live_event", 1000, "INR", 20, 24, 200, 800, "{}", "v1", Date.now());
    db.prepare(
      `INSERT INTO commercial_entitlements (entitlement_id,kind,listing_id,booking_id,order_id,account_id,role,state,starts_at,ends_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run("ent-1", "live_event", "listing-5", null, "order-1", "buyer-1", "viewer", "active", leftAt, leftAt, leftAt, leftAt);

    await lib.endLiveOnHostNoReturn(env as any, "listing-5");

    const session = db.prepare("SELECT state,end_outcome,reconnect_deadline_ms,settlement_state FROM commercial_sessions WHERE commercial_session_id=?").get("session-5") as any;
    expect(session.state).toBe("ended");
    expect(session.end_outcome).toBe("host_no_return");
    expect(session.reconnect_deadline_ms).toBeNull();
    expect(session.settlement_state).toBe("pending");

    const interval = db.prepare("SELECT reconciliation_state,left_at FROM commercial_participant_intervals WHERE interval_id=?").get("interval-buyer") as any;
    expect(interval.reconciliation_state).toBe("closed");
    expect(interval.left_at).toBeTruthy();

    const outage = db.prepare("SELECT ended_at FROM commercial_live_outages WHERE outage_id=?").get("outage-5") as any;
    expect(outage.ended_at).toBeTruthy();

    const job = db.prepare("SELECT state FROM commercial_settlement_jobs WHERE commercial_session_id=? AND order_id=?").get("session-5", "order-1") as any;
    expect(job.state).toBe("pending");

    const entitlement = db.prepare("SELECT state FROM commercial_entitlements WHERE entitlement_id=?").get("ent-1") as any;
    expect(entitlement.state).toBe("consumed");
  });

  it("is a no-op when the host already rejoined (deadline cleared)", async () => {
    const { db, env } = setup();
    currentDb = db;
    insertSession(db, { id: "session-6", listingId: "listing-6", state: "live" }); // reconnect_deadline_ms NULL
    await lib.endLiveOnHostNoReturn(env as any, "listing-6");
    const session = db.prepare("SELECT state FROM commercial_sessions WHERE commercial_session_id=?").get("session-6") as any;
    expect(session.state).toBe("live");
  });

  it("is a no-op on an already-ended session (stale alarm)", async () => {
    const { db, env } = setup();
    currentDb = db;
    insertSession(db, { id: "session-7", listingId: "listing-7", state: "ended", reconnectDeadlineMs: Date.now() - 1000 });
    await lib.endLiveOnHostNoReturn(env as any, "listing-7");
    const session = db.prepare("SELECT end_outcome FROM commercial_sessions WHERE commercial_session_id=?").get("session-7") as any;
    expect(session.end_outcome).toBeNull();
  });
});

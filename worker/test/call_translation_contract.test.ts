import { beforeEach, describe, expect, it, vi } from "vitest";

// [CALL-TRANSLATE-OBS-3] `requireUser` is the ONE dependency of these routes that
// cannot be faked through `env` — it verifies a Clerk JWT over the network. Every
// other collaborator (D1, the wallet DO, the CallRoom DO, the analytics queue,
// the config KV) is reached through `env` and is a plain object below, so the
// code under test is the real handler, not a re-implementation of it.
vi.mock("../src/authz", () => ({
  isFail: (x: { error?: string }) => x.error !== undefined,
  requireUser: async () => ({ uid: "u_payer" }),
}));

import {
  CALL_TRANSLATION_LANGS, CALL_TRANSLATION_MIN_START, CALL_TRANSLATION_RATE, CALL_TRANSLATION_MODEL,
  CALL_TRANSLATION_API_VERSION, CALL_TRANSLATION_AUTH_TOKEN_URL, callTranslationAuthTokenBody,
  CALL_TRANSLATION_SOURCE_BRIDGE_ENABLED, mintFailureClass, stopEndReason, stopReasonOrDefault,
  mintRetryable, CALL_TRANSLATION_MINT_TIMEOUT_MS, CALL_TRANSLATION_MINT_MAX_ATTEMPTS,
  STOP_BODY_TIMEOUT_MS,
  callTranslationStart, callTranslationActivate, callTranslationRenew, callTranslationStop,
} from "../src/routes/call_translation";
import type { Env } from "../src/types";
import { bustConfigMemo } from "../src/routes/config";

// [AVA-CFG-CACHE-1 fix 2026-08-07] Reset the config memo between cases — see the
// longer note in test/ai_free_budget.test.ts. `memoKey(env)` is
// `env.ENVIRONMENT_NAME ?? "prod"`, so every env built in this file shares one
// key and the first test's flags were pinned for 10s. Here it surfaced as the
// paid-only case getting a 502 instead of a 402: flipping the flag off had no
// effect because the memo still held it on.
beforeEach(() => bustConfigMemo());

describe("[CALL-TRANSLATE-1] contract", () => {
  it("uses the documented Gemini model and paid one-minute tariff", () => {
    expect(CALL_TRANSLATION_MODEL).toBe("gemini-3.5-live-translate-preview");
    expect(CALL_TRANSLATION_RATE).toBe(5);
    expect(CALL_TRANSLATION_MIN_START).toBe(5);
  });

  it("accepts the complete server-owned language set", () => {
    expect(CALL_TRANSLATION_LANGS.size).toBeGreaterThanOrEqual(70);
    expect(CALL_TRANSLATION_LANGS.has("en")).toBe(true);
    expect(CALL_TRANSLATION_LANGS.has("hi")).toBe(true);
    expect(CALL_TRANSLATION_LANGS.has("zh-Hant")).toBe(true);
  });

  it("allows the reviewed decoded-playback Android bridge", () => {
    expect(CALL_TRANSLATION_SOURCE_BRIDGE_ENABLED).toBe(true);
  });

  it("matches the current model-specific Live Translate ephemeral-token contract", () => {
    expect(CALL_TRANSLATION_API_VERSION).toBe("v1beta");
    expect(CALL_TRANSLATION_AUTH_TOKEN_URL).toBe(
      "https://generativelanguage.googleapis.com/v1beta/auth_tokens",
    );

    const body = callTranslationAuthTokenBody("es", Date.parse("2026-08-15T08:30:00Z"));
    expect(body).toEqual({
      uses: 1,
      expireTime: "2026-08-15T08:30:00.000Z",
      liveConnectConstraints: {
        model: "models/gemini-3.5-live-translate-preview",
        config: {
          responseModalities: ["AUDIO"],
          translationConfig: {
            targetLanguageCode: "es",
            echoTargetLanguage: false,
          },
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain("bidiGenerateContentSetup");
    expect(CALL_TRANSLATION_AUTH_TOKEN_URL).not.toContain("v1alpha");
  });

  it("bounds the provider watchdog and retries only transient failures", () => {
    expect(CALL_TRANSLATION_MINT_TIMEOUT_MS).toBe(6_000);
    expect(CALL_TRANSLATION_MINT_MAX_ATTEMPTS).toBe(2);
    expect(mintRetryable(0)).toBe(true);
    expect(mintRetryable(408)).toBe(true);
    expect(mintRetryable(503)).toBe(true);
    expect(mintRetryable(400)).toBe(false);
    expect(mintRetryable(401)).toBe(false);
    expect(mintRetryable(429)).toBe(false);
  });
});

describe("[CALL-TRANSLATE-OBS-2] telemetry categories", () => {
  // These strings are what a dashboard breaks down on, so they are a contract.
  // The 2026-08-04 outage was a 400 (we sent a field name that only exists in
  // the SDK) — `bad_request` is the class that must have said "it's us".
  it("classifies the mint failure that actually happened as bad_request", () => {
    expect(mintFailureClass(400)).toBe("bad_request");
  });

  it("separates our fault, the account's fault and Google's fault", () => {
    expect(mintFailureClass(401)).toBe("auth");
    expect(mintFailureClass(403)).toBe("auth");
    expect(mintFailureClass(404)).toBe("not_found");
    expect(mintFailureClass(408)).toBe("timeout");
    expect(mintFailureClass(429)).toBe("quota");
    expect(mintFailureClass(500)).toBe("provider_error");
    expect(mintFailureClass(503)).toBe("provider_error");
    expect(mintFailureClass(504)).toBe("timeout");
    expect(mintFailureClass(418)).toBe("http_other");
  });

  it("maps stop reasons through a closed set, defaulting to user_stop", () => {
    expect(stopEndReason("dead_translation")).toBe("dead_translation");
    expect(stopEndReason("provider_failure")).toBe("provider_failure");
    expect(stopEndReason("call_ended")).toBe("call_ended");
    // Every build in the field today sends no reason at all.
    expect(stopEndReason(undefined)).toBe("user_stop");
    expect(stopEndReason("")).toBe("user_stop");
    // A client must never be able to inject a free string into the taxonomy.
    expect(stopEndReason("whatever the user typed")).toBe("user_stop");
    expect(stopEndReason({ nope: 1 })).toBe("user_stop");
  });
});

// ---------------------------------------------------------------------------
// [CALL-TRANSLATE-OBS-3] Harness for the routes that move money and emit the
// outcome funnel.
//
// The point of these tests is the `changes === 1` guards and the reaper — the
// logic that decides whether a session gets counted once, twice or not at all,
// and whether a row can be taken out from under a payer mid-charge. All of it is
// concurrency-shaped, so the fake D1 below supports `db.interrupt(...)`: a
// one-shot hook that fires immediately BEFORE a chosen statement executes, which
// is how a "concurrent /stop landed between the load and the UPDATE" is written
// down as a test rather than as a comment.
// ---------------------------------------------------------------------------

const UID = "u_payer";
const MIN = 60_000;

type Row = {
  id: string; payer_uid: string; call_ref: string; target_lang: string;
  source_lease: string; status: string; started_at: number | null;
  last_billed_minute: number; billed_tokens: number; updated_at: number;
  device_nonce: string | null;
};

function row(over: Partial<Row> & { id: string }): Row {
  return {
    payer_uid: UID, call_ref: "call-" + over.id, target_lang: "fr",
    source_lease: "lease-" + over.id, status: "pending", started_at: null,
    last_billed_minute: 0, billed_tokens: 0, updated_at: Date.now(),
    device_nonce: null, ...over,
  };
}

class FakeDb {
  rows = new Map<string, Row>();
  sql: string[] = [];
  private hooks: Array<{ match: RegExp; fn: () => void }> = [];

  seed(...rs: Row[]) { for (const r of rs) this.rows.set(r.id, { ...r }); }
  /** Fire [fn] exactly once, just before the next statement matching [match]. */
  interrupt(match: RegExp, fn: () => void) { this.hooks.push({ match, fn }); }

  private fire(sql: string) {
    const i = this.hooks.findIndex((h) => h.match.test(sql));
    if (i >= 0) { const h = this.hooks[i]; this.hooks.splice(i, 1); h.fn(); }
  }

  prepare(sql: string) {
    const db = this;
    const flat = sql.replace(/\s+/g, " ").trim();
    return {
      bind(...a: unknown[]) {
        const enter = () => { db.sql.push(flat); db.fire(flat); };
        return {
          async first<T>(): Promise<T | null> { enter(); return (db.select(flat, a)[0] ?? null) as T | null; },
          async all<T>(): Promise<{ results: T[] }> { enter(); return { results: db.select(flat, a) as T[] }; },
          async run() { enter(); return { meta: { changes: db.mutate(flat, a) } }; },
        };
      },
    };
  }

  private select(sql: string, a: unknown[]): Row[] {
    if (sql.startsWith("SELECT * FROM translation_call_sessions WHERE id=?1")) {
      const r = this.rows.get(String(a[0]));
      return r ? [{ ...r }] : [];
    }
    if (sql.includes("status IN ('pending','activating') AND updated_at < ?2")) {
      return [...this.rows.values()]
        .filter((r) => r.payer_uid === a[0] && (r.status === "pending" || r.status === "activating") && r.updated_at < Number(a[1]))
        .sort((x, y) => x.updated_at - y.updated_at)
        .slice(0, Number(a[2]))
        .map((r) => ({ ...r }));
    }
    if (sql.startsWith("SELECT id FROM translation_call_sessions")) {
      return [...this.rows.values()]
        .filter((r) => r.payer_uid === a[0] && r.call_ref === a[1] && ["pending", "activating", "active"].includes(r.status))
        .slice(0, 1).map((r) => ({ ...r }));
    }
    throw new Error("FakeDb: unhandled SELECT " + sql);
  }

  private mutate(sql: string, a: unknown[]): number {
    if (sql.startsWith("INSERT INTO translation_call_sessions")) {
      const dup = [...this.rows.values()].some((r) => r.payer_uid === a[1] && r.call_ref === a[2] && ["pending", "activating", "active"].includes(r.status));
      if (dup) throw new Error("UNIQUE constraint failed");
      this.rows.set(String(a[0]), row({
        id: String(a[0]), payer_uid: String(a[1]), call_ref: String(a[2]), target_lang: String(a[3]),
        source_lease: String(a[4]), status: "pending", updated_at: Number(a[5]),
        device_nonce: (a[6] as string | null) ?? null,
      }));
      return 1;
    }
    const r = this.rows.get(String(a[0]));
    if (!r) return 0;
    const upd = (guard: boolean, apply: () => void) => { if (!guard) return 0; apply(); return 1; };

    if (sql.includes("SET status='stopped'") && sql.includes("status IN ('pending','activating')")) {
      return upd(r.status === "pending" || r.status === "activating", () => { r.status = "stopped"; r.updated_at = Number(a[1]); });
    }
    if (sql.includes("SET status='stopped'") && sql.includes("status NOT IN")) {
      return upd(!["stopped", "funds-stopped", "provider-stopped"].includes(r.status), () => { r.status = "stopped"; r.updated_at = Number(a[1]); });
    }
    if (sql.includes("SET status='funds-stopped'")) {
      return upd(r.status === "active", () => { r.status = "funds-stopped"; r.updated_at = Number(a[1]); });
    }
    if (sql.includes("SET status='provider-stopped'") && sql.includes("status='pending'")) {
      return upd(r.status === "pending", () => { r.status = "provider-stopped"; r.updated_at = Number(a[1]); });
    }
    if (sql.includes("SET status='activating'")) {
      return upd(r.status === "pending", () => { r.status = "activating"; r.updated_at = Number(a[1]); });
    }
    if (sql.startsWith("UPDATE translation_call_sessions SET updated_at=?2 WHERE id=?1 AND status='activating'")) {
      return upd(r.status === "activating", () => { r.updated_at = Number(a[1]); });
    }
    if (sql.includes("SET status='active',started_at=?2")) {
      return upd(r.status === "activating", () => {
        r.status = "active"; r.started_at = Number(a[1]); r.updated_at = Number(a[1]);
        r.last_billed_minute = 1; r.billed_tokens = Number(a[2]);
      });
    }
    if (sql.includes("SET status='pending'")) {
      return upd(r.status === "activating", () => { r.status = "pending"; r.updated_at = Number(a[1]); });
    }
    if (sql.includes("SET last_billed_minute=?2")) {
      return upd(r.last_billed_minute < Number(a[1]), () => {
        r.last_billed_minute = Number(a[1]);
        r.billed_tokens = Math.max(r.billed_tokens, Number(a[2]));
        r.updated_at = Number(a[3]);
      });
    }
    if (sql.includes("SET target_lang=?2")) {
      return upd(r.status === "active", () => { r.target_lang = String(a[1]); r.updated_at = Number(a[2]); });
    }
    throw new Error("FakeDb: unhandled UPDATE " + sql);
  }
}

type Harness = {
  env: Env;
  db: FakeDb;
  events: Array<{ event: string; uid: string; props: Record<string, unknown> }>;
  charges: Array<{ op_id: string; rowAtCharge: Row | undefined }>;
  /** [CALL-TRANSLATE-FREE-1] Full spend bodies — `charges` deliberately keeps only
   *  the op id and the row snapshot, but the wallet POLICY (`allow_free`) has to be
   *  assertable too, because it is the half of the gate/charge pair that is easy to
   *  change alone. */
  spends: Array<Record<string, unknown>>;
  outcomes: () => Array<Record<string, unknown>>;
  named: (name: string) => Array<Record<string, unknown>>;
};

function harness(opts: { spendOk?: boolean; inCall?: boolean; paidBalance?: number; allowFree?: boolean } = {}): Harness {
  const db = new FakeDb();
  const events: Harness["events"] = [];
  // [CALL-TRANSLATE-FREE-1] `allowFree` undefined means "write no override", so
  // the route falls through to DEFAULTS — which is the thing worth testing: the
  // shipped default must let free tokens pay.
  const kv = new Map<string, string>([["platform_config", JSON.stringify({
    translationEnabled: true,
    callTranslationEnabled: true,
    ...(opts.allowFree === undefined ? {} : { callTranslationAllowFreeTokens: opts.allowFree }),
  })]]);
  const charges: Harness["charges"] = [];
  const spends: Harness["spends"] = [];
  const spendOk = opts.spendOk ?? true;
  const inCall = opts.inCall ?? true;

  const callRoom = {
    fetch: async (req: Request) => {
      const u = new URL(req.url);
      if (!inCall) return new Response("{}", { status: 404 });
      if (u.pathname === "/participants") return new Response(JSON.stringify({ ok: true, callerUid: UID, calleeUid: "u_peer" }), { status: 200 });
      return new Response(JSON.stringify({ session: { session_state: "connected", terminal: false } }), { status: 200 });
    },
  };
  const wallet = {
    fetch: async (_u: string, init: { body: string }) => {
      const op = JSON.parse(init.body) as { op: string; op_id?: string; ref?: string } & Record<string, unknown>;
      if (op.op !== "balance") spends.push(op);
      if (op.op === "balance") {
        const paid = opts.paidBalance ?? 100;
        return new Response(JSON.stringify({ balance: paid, spendable: paid + 25 }), { status: 200 });
      }
      // Snapshot the row AS IT IS at the instant money moves. That snapshot is
      // the whole subject of the stuck-claim test below.
      charges.push({ op_id: String(op.op_id), rowAtCharge: db.rows.get(String(op.ref)) ? { ...db.rows.get(String(op.ref))! } : undefined });
      return new Response(JSON.stringify(spendOk ? { ok: true } : { error: "insufficient" }), { status: spendOk ? 200 : 402 });
    },
  };

  const env = {
    DB_META: db,
    TOKENS: {
      get: async (k: string, type?: string) => {
        const v = kv.get(k) ?? null;
        return v !== null && type === "json" ? JSON.parse(v) : v;
      },
      put: async (k: string, v: string) => { kv.set(k, v); },
    },
    Q_ANALYTICS: { send: async (m: { event: string; uid: string; props: Record<string, unknown> }) => { events.push(m); } },
    CALL_ROOMS: { idFromName: (n: string) => n, get: () => callRoom },
    WALLET_DO: { idFromName: (n: string) => n, get: () => wallet },
    // No GEMINI_API_KEY on purpose: the provider mint short-circuits (and says so
    // on its own event) so no test here ever reaches out to Google.
  } as unknown as Env;

  const named = (name: string) => events.filter((e) => e.event === name).map((e) => e.props);
  return { env, db, events, charges, spends, outcomes: () => named("call_translation_outcome"), named };
}

function post(body: unknown): Request {
  return new Request("https://api.avatok.ai/x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

describe("[CALL-TRANSLATE-OBS-3] reapAbandoned", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  // The reaper runs inside /start, before the dedupe read. Driving it through
  // the real route is deliberate: a reaper that works but is wired in after the
  // 409 would still leave the payer locked out.
  const start = (callRef: string) => callTranslationStart(
    post({ call_ref: callRef, target_lang: "fr", source_capability: "webrtc_same_capture_pcm16_v1" }), h.env,
  );

  it("closes only rows that are old enough, and only this payer's", async () => {
    const now = Date.now();
    h.db.seed(
      row({ id: "old1", call_ref: "c1", updated_at: now - 20 * MIN }),
      row({ id: "old2", call_ref: "c2", status: "activating", updated_at: now - 11 * MIN }),
      row({ id: "young", call_ref: "c3", updated_at: now - 60_000 }),
      row({ id: "other", call_ref: "c4", payer_uid: "u_someone_else", updated_at: now - 30 * MIN }),
    );
    // The mint has no API key, so /start ends 502 — the reap has already run.
    const res = await start("c_new");
    expect(res.status).toBe(502);

    expect(h.db.rows.get("old1")!.status).toBe("stopped");
    expect(h.db.rows.get("old2")!.status).toBe("stopped");
    expect(h.db.rows.get("young")!.status).toBe("pending");
    expect(h.db.rows.get("other")!.status).toBe("pending");

    const out = h.outcomes();
    expect(out.map((o) => o.session_id).sort()).toEqual(["old1", "old2"]);
    for (const o of out) {
      expect(o.end_reason).toBe("abandoned");
      expect(o.reached_active).toBe(false);
      expect(o.outcome).toBe("never_activated");
      expect(o.reaped_at_start).toBe(true);
      expect(String(o.discovered_by_session).length).toBeGreaterThan(0);
      expect(o.undetected_ms as number).toBeGreaterThan(10 * MIN);
      // A reaped row cannot vouch for its own billing state (defect 5).
      expect(o.billed_minutes_verified).toBe(false);
    }
  });

  it("bounds one /start to ABANDON_REAP_LIMIT rows so it can never fan out", async () => {
    const now = Date.now();
    for (let i = 0; i < 9; i++) h.db.seed(row({ id: "z" + i, call_ref: "c" + i, updated_at: now - (20 + i) * MIN }));
    await start("c_new");
    const closed = [...h.db.rows.values()].filter((r) => r.status === "stopped");
    expect(closed).toHaveLength(5);
    expect(h.outcomes()).toHaveLength(5);
    // Oldest first — the rows that have been dead longest are the ones freed.
    expect(closed.map((r) => r.id).sort()).toEqual(["z4", "z5", "z6", "z7", "z8"]);
  });

  it("emits no outcome for a row that activates underneath the reaper", async () => {
    const now = Date.now();
    h.db.seed(
      row({ id: "raced", call_ref: "c1", updated_at: now - 20 * MIN }),
      row({ id: "dead", call_ref: "c2", updated_at: now - 21 * MIN }),
    );
    // The row wakes up between the reaper's SELECT and its guarded UPDATE.
    h.db.interrupt(/SET status='stopped'.*status IN \('pending','activating'\)/, () => {
      const r = h.db.rows.get("raced")!;
      r.status = "active"; r.started_at = Date.now(); r.last_billed_minute = 1; r.billed_tokens = 5;
    });
    await start("c_new");

    expect(h.db.rows.get("raced")!.status).toBe("active");
    expect(h.db.rows.get("dead")!.status).toBe("stopped");
    // Only the writer that actually closed a row reports one.
    expect(h.outcomes().map((o) => o.session_id)).toEqual(["dead"]);
  });

  it("frees a wedged row for the same call_ref instead of 409ing forever", async () => {
    h.db.seed(row({ id: "wedged", call_ref: "c_same", updated_at: Date.now() - 30 * MIN }));
    const res = await start("c_same");
    // Not the 409 "translation already active" the wedged row used to force.
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "provider_unavailable" });
    expect(h.named("call_translation_start_failed").map((p) => p.reason)).toContain("provider_unavailable");
  });
});

describe("[CALL-TRANSLATE-WATCHDOG-1] start admission", () => {
  it("queues a duplicate behind the pending winner without contacting the provider", async () => {
    const h = harness();
    h.db.seed(row({ id: "winner", call_ref: "c_queue", status: "pending" }));

    const res = await callTranslationStart(post({
      call_ref: "c_queue", target_lang: "fr",
      source_capability: "webrtc_same_capture_pcm16_v1",
    }), h.env);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "translation_start_in_progress", session_id: "winner",
      retry_after_ms: 750, billable: false,
    });
    expect(h.named("call_translation_mint")).toHaveLength(0);
    expect(h.named("call_translation_provider_watchdog")).toContainEqual(
      expect.objectContaining({ state: "queued_behind_existing", existing_session_id: "winner" }),
    );
  });

  it("releases a winning claim immediately when provider provisioning fails", async () => {
    const h = harness();
    const res = await startWith(h, "c_release");

    expect(res.status).toBe(502);
    const created = [...h.db.rows.values()].find((r) => r.call_ref === "c_release");
    expect(created?.status).toBe("provider-stopped");
    expect(h.named("call_translation_provider_watchdog")).toContainEqual(
      expect.objectContaining({ state: "claim_released" }),
    );
  });
});

describe("[CALL-TRANSLATE-OBS-3] outcome is emitted once, by the writer that closed the row", () => {
  it("/stop counts a session once however many times it is called", async () => {
    const h = harness();
    h.db.seed(row({ id: "s1", status: "active", started_at: Date.now() - 3 * MIN, last_billed_minute: 3, billed_tokens: 15 }));

    const first = await callTranslationStop(post({ reason: "call_ended" }), h.env, "s1");
    const second = await callTranslationStop(post({ reason: "call_ended" }), h.env, "s1");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // The convergence event still fires twice; the FUNNEL event must not.
    expect(h.named("call_translation_stopped")).toHaveLength(2);
    const out = h.outcomes();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      session_id: "s1", end_reason: "call_ended", reached_active: true,
      outcome: "activated", status_at_end: "active", billed_minutes: 3,
      billed_minutes_verified: true,
    });
  });

  it("/renew does NOT emit insufficient_funds when a concurrent /stop closed the row", async () => {
    const h = harness({ spendOk: false });
    h.db.seed(row({ id: "s2", status: "active", started_at: Date.now() - 3 * MIN, last_billed_minute: 1, billed_tokens: 5 }));
    // /stop lands between renew's load() and its funds-stopped UPDATE. This is
    // defect 1: the emit used to run unconditionally, so this session was counted
    // twice — once as `user_stop`, once as `insufficient_funds`.
    h.db.interrupt(/SET status='funds-stopped'/, () => { h.db.rows.get("s2")!.status = "stopped"; });

    const res = await callTranslationRenew(post({}), h.env, "s2");
    expect(res.status).toBe(402);
    expect(h.db.rows.get("s2")!.status).toBe("stopped");
    expect(h.named("call_translation_funds_stopped")).toHaveLength(1);
    expect(h.outcomes()).toHaveLength(0);
  });

  it("/renew emits exactly one insufficient_funds outcome when it is the writer", async () => {
    const h = harness({ spendOk: false });
    h.db.seed(row({ id: "s3", status: "active", started_at: Date.now() - 3 * MIN, last_billed_minute: 1, billed_tokens: 5 }));
    const res = await callTranslationRenew(post({}), h.env, "s3");
    expect(res.status).toBe(402);
    expect(h.db.rows.get("s3")!.status).toBe("funds-stopped");
    const out = h.outcomes();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      session_id: "s3", end_reason: "insufficient_funds", stopped_at_minute: 2,
      reached_active: true, billed_minutes: 1, billed_minutes_verified: true,
    });
  });

  it("two concurrent /renew calls that both run out of funds report one ending", async () => {
    const h = harness({ spendOk: false });
    h.db.seed(row({ id: "s4", status: "active", started_at: Date.now() - 3 * MIN, last_billed_minute: 1, billed_tokens: 5 }));
    // Both loaded `active`; both failed the same minute. One UPDATE wins.
    const [a, b] = await Promise.all([
      callTranslationRenew(post({}), h.env, "s4"),
      callTranslationRenew(post({}), h.env, "s4"),
    ]);
    expect(a.status).toBe(402);
    expect(b.status).toBe(402);
    expect(h.outcomes()).toHaveLength(1);
  });
});

describe("[CALL-TRANSLATE-OBS-3] /stop is not blockable by the request body", () => {
  it("closes the row before the body is read, then falls back to user_stop", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.db.seed(row({ id: "s5", status: "active", started_at: Date.now() - MIN, last_billed_minute: 1, billed_tokens: 5 }));
      // A client that announces a body and then stalls forever.
      const stalled = { json: () => new Promise<never>(() => {}) } as unknown as Request;

      const pending = callTranslationStop(stalled, h.env, "s5");
      // Let every microtask up to (and past) the terminal UPDATE settle. No real
      // timer is involved before it — only the hung body is on a timer.
      for (let i = 0; i < 50; i++) await Promise.resolve();
      // The product outcome — meter stopped, audio restored — has already landed
      // while the body is still hanging.
      expect(h.db.rows.get("s5")!.status).toBe("stopped");

      await vi.advanceTimersByTimeAsync(STOP_BODY_TIMEOUT_MS + 1);
      const res = await pending;
      expect(res.status).toBe(200);
      expect(h.outcomes()).toHaveLength(1);
      expect(h.outcomes()[0].end_reason).toBe("user_stop");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still honours a body that arrives in time", async () => {
    const reason = await stopReasonOrDefault(post({ reason: "dead_translation" }), 50);
    expect(reason).toBe("dead_translation");
  });

  it("gives up on a stalled body and returns the documented default", async () => {
    const stalled = { json: () => new Promise<never>(() => {}) } as unknown as Request;
    expect(await stopReasonOrDefault(stalled, 5)).toBe("user_stop");
  });
});

describe("[CALL-TRANSLATE-OBS-3 / A2] stuck-claim repair holds the row before charging", () => {
  const activate = (h: Harness, id: string, lease: string) => callTranslationActivate(
    post({ source_lease: lease, source_ready: true }), h.env, id,
  );

  it("refreshes updated_at before the charge, so a reaper cannot take the row mid-repair", async () => {
    const h = harness();
    const stale = Date.now() - 20 * MIN;
    h.db.seed(row({ id: "a1", status: "activating", source_lease: "lease-a1", updated_at: stale }));

    const res = await activate(h, "a1", "lease-a1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, billed_minute: 1 });
    expect(h.db.rows.get("a1")!.status).toBe("active");

    // The repair was recognised as a repair...
    expect(h.named("call_translation_activation_repaired")).toHaveLength(1);
    // ...and by the time money moved, the row was no longer reapable: its
    // `updated_at` had been refreshed out of the abandoned window.
    expect(h.charges).toHaveLength(1);
    expect(h.charges[0].op_id).toBe("call-translation:a1:minute:1");
    expect(h.charges[0].rowAtCharge!.updated_at).toBeGreaterThan(Date.now() - MIN);
  });

  it("never charges when the row is lost before the repair takes it", async () => {
    const h = harness();
    h.db.seed(row({ id: "a2", status: "activating", source_lease: "lease-a2", updated_at: Date.now() - 20 * MIN }));
    // A concurrent reaper/stop closes the row an instant before the hold.
    h.db.interrupt(/^UPDATE translation_call_sessions SET updated_at=\?2 WHERE id=\?1 AND status='activating'/, () => {
      h.db.rows.get("a2")!.status = "stopped";
    });

    const res = await activate(h, "a2", "lease-a2");
    expect(res.status).toBe(409);
    // No money moved, so the refusal must not claim it did.
    expect(await res.json()).toMatchObject({ error: "stopped", billable: false });
    expect(h.charges).toHaveLength(0);
  });

  it("still converges to 200 if the row went active while the repair was in flight", async () => {
    const h = harness();
    h.db.seed(row({ id: "a3", status: "activating", source_lease: "lease-a3", updated_at: Date.now() - 20 * MIN }));
    h.db.interrupt(/^UPDATE translation_call_sessions SET updated_at=\?2 WHERE id=\?1 AND status='activating'/, () => {
      const r = h.db.rows.get("a3")!;
      r.status = "active"; r.started_at = Date.now(); r.last_billed_minute = 1; r.billed_tokens = 5;
    });
    const res = await activate(h, "a3", "lease-a3");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, reconciled: "already_active", billed_minute: 1 });
    expect(h.charges).toHaveLength(0);
  });

  it("a fresh pending claim is unaffected — no repair, one charge, one active row", async () => {
    const h = harness();
    h.db.seed(row({ id: "a4", status: "pending", source_lease: "lease-a4", updated_at: Date.now() - 2_000 }));
    const res = await activate(h, "a4", "lease-a4");
    expect(res.status).toBe(200);
    expect(h.named("call_translation_activation_repaired")).toHaveLength(0);
    expect(h.charges).toHaveLength(1);
    expect(h.db.rows.get("a4")!.status).toBe("active");
    expect(h.db.rows.get("a4")!.last_billed_minute).toBe(1);
  });
});

describe("[CALL-TRANSLATE-OBS-3] telemetry never carries an unbounded client string", () => {
  it("caps the rejected language on the unsupported_lang event", async () => {
    const h = harness();
    const res = await callTranslationStart(post({
      call_ref: "c_len", target_lang: "x".repeat(5000), source_capability: "webrtc_same_capture_pcm16_v1",
    }), h.env);
    expect(res.status).toBe(400);
    const failed = h.named("call_translation_start_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBe("unsupported_lang");
    expect(String(failed[0].language)).toHaveLength(32);
  });

  it("caps a call_ref that has not been validated yet", async () => {
    const h = harness();
    const res = await callTranslationStart(post({
      call_ref: "c".repeat(4000), target_lang: "fr", source_capability: "nope",
    }), h.env);
    expect(res.status).toBe(412);
    expect(String(h.named("call_translation_start_failed")[0].call_ref)).toHaveLength(128);
  });
});

/**
 * [CALL-TRANSLATE-FREE-1] OWNER 2026-08-05 — free/bonus tokens pay for translation.
 *
 * The bug this locks down: every tester holds only the 100-token welcome grant and
 * the daily free grant, so a gate on the PAID balance 402'd all of them on the
 * first tap ("your remaining 67 Tokens are free/bonus Tokens, which it cannot
 * use"). The harness wallet reports `spendable = paid + 25`, i.e. a user with
 * paid 0 still holds 25 non-paid tokens — exactly the shape that used to fail.
 *
 * The invariant under test is NOT just "0 paid now passes". It is that the /start
 * GATE and the per-minute CHARGE read the same flag. If they ever diverge you get
 * a user who passes /start and fails /activate: charged expectations, no
 * translation. Hence the `allow_free` assertion on the spend op below.
 */
const startWith = (h: Harness, callRef: string) => callTranslationStart(
  post({ call_ref: callRef, target_lang: "fr", source_capability: "webrtc_same_capture_pcm16_v1" }), h.env,
);

describe("[CALL-TRANSLATE-FREE-1] free/bonus tokens pay for call translation", () => {
  it("by DEFAULT lets a payer with zero PAID tokens past the /start gate", async () => {
    // No KV override: this asserts the shipped DEFAULTS value, which is what
    // actually reaches production users.
    const h = harness({ paidBalance: 0 });
    const res = await startWith(h, "c_free");
    // 502 is the provider mint short-circuiting (no GEMINI_API_KEY in tests) —
    // i.e. execution got PAST the money gate, which is the whole point. A 402
    // here is the regression.
    expect(res.status).toBe(502);
    expect(h.named("call_translation_start_failed").map((e) => e.reason))
      .not.toContain("insufficient_tokens");
  });

  it("still refuses when even the non-paid buckets cannot cover the minimum", async () => {
    // spendable = paid + 25, so -25 puts total spendable at 0.
    const h = harness({ paidBalance: -25 });
    const res = await startWith(h, "c_empty");
    expect(res.status).toBe(402);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("insufficient_tokens");
    // Free tokens ARE allowed, so this refusal is NOT about the wrong bucket.
    // Telling an empty wallet to "top up, your tokens are the wrong kind" is the
    // visibly-wrong copy this field exists to prevent.
    expect(body.paid_only).toBe(false);
  });

  it("restores paid-only when the flag is turned off, and says so in the 402", async () => {
    const h = harness({ paidBalance: 0, allowFree: false });
    const res = await startWith(h, "c_paidonly");
    expect(res.status).toBe(402);
    const body = await res.json() as Record<string, unknown>;
    expect(body.paid_only).toBe(true);
    expect(body.balance).toBe(0);
    expect(body.spendable).toBe(25);
  });

  it("charges with allow_free matching the gate, so /start and /activate agree", async () => {
    const h = harness({ paidBalance: 0 });
    h.db.seed(row({ id: "s_free", call_ref: "c_act", status: "pending", source_lease: "lease-free" }));
    await callTranslationActivate(post({ source_lease: "lease-free", source_ready: true }), h.env, "s_free");
    const spend = h.spends.at(-1);
    expect(spend).toBeDefined();
    expect(spend!.allow_free).toBe(true);
  });
});

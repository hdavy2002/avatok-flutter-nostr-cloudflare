// @ts-nocheck -- node:sqlite is available in the Worker test runtime.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

vi.mock("../authz", () => ({
  requireUser: async (req: Request) => ({ uid: req.headers.get("x-test-uid") ?? "u1" }),
  isFail: (value: any) => !!value?.error,
}));
vi.mock("../money", () => ({ rateLimit: async () => null }));
vi.mock("../hooks", () => ({ track: async () => {}, trackException: async () => {} }));

import { hfRegistrationRoute, normalizeHfUsername } from "./hf_registration";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
let db: any;
let env: any;

function setup() {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT, updated_at INTEGER);
    CREATE TABLE hf_user_registration (
      uid TEXT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      terms_accepted_at INTEGER NOT NULL, privacy_accepted_at INTEGER NOT NULL,
      disclaimer_accepted_at INTEGER NOT NULL, community_accepted_at INTEGER NOT NULL,
      engagement_accepted_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    INSERT INTO users(uid) VALUES ('u1'), ('u2');
  `);
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => db.prepare(sql).get(...values) ?? null,
    run: async () => {
      const result = db.prepare(sql).run(...values);
      return { meta: { changes: Number(result.changes) } };
    },
  });
  env = {
    DB_META: {
      prepare: (sql: string) => statement(sql),
      batch: async (items: any[]) => Promise.all(items.map((item) => item.run())),
    },
  };
}

const policies = ["terms", "privacy", "disclaimer", "community", "engagement"];
const request = (path: string, method = "GET", body?: unknown, uid = "u1") => new Request(`https://x${path}`, {
  method,
  headers: { "content-type": "application/json", "x-test-uid": uid },
  body: body === undefined ? undefined : JSON.stringify(body),
});

beforeEach(setup);

describe("HF immutable registration username", () => {
  it("normalizes an allowed username", () => {
    expect(normalizeHfUsername("  Maya.Connect_27 ")).toBe("maya.connect_27");
  });

  it.each(["ma", "27maya", "maya..connect", "maya-connect", "maya connect", "a".repeat(31)])(
    "rejects %s",
    (value) => expect(normalizeHfUsername(value)).toBeNull(),
  );

  it("checks availability and saves every accepted policy", async () => {
    const available = await hfRegistrationRoute(request("/api/hf/me/username?value=Maya"), env, "/api/hf/me/username");
    expect(await available!.json()).toEqual({ available: true, username: "maya" });
    const response = await hfRegistrationRoute(request("/api/hf/me/registration", "POST", {
      firstName: "Maya", lastName: "Sharma", username: "Maya", acceptedPolicies: policies,
    }), env, "/api/hf/me/registration");
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({ ok: true, username: "maya", registrationComplete: true });
    expect(db.prepare("SELECT display_name FROM users WHERE uid='u1'").get().display_name).toBe("Maya Sharma");
    expect(db.prepare("SELECT terms_accepted_at FROM hf_user_registration WHERE uid='u1'").get().terms_accepted_at).toBeGreaterThan(0);
  });

  it("requires all five policies and never writes a partial registration", async () => {
    const response = await hfRegistrationRoute(request("/api/hf/me/registration", "POST", {
      firstName: "Maya", lastName: "Sharma", username: "maya", acceptedPolicies: policies.slice(0, 4),
    }), env, "/api/hf/me/registration");
    expect(response!.status).toBe(400);
    expect((await response!.json()).missing).toEqual(["engagement"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM hf_user_registration").get().n).toBe(0);
  });

  it("keeps a username immutable and unavailable to another account", async () => {
    const body = { firstName: "Maya", lastName: "Sharma", username: "maya", acceptedPolicies: policies };
    expect((await hfRegistrationRoute(request("/api/hf/me/registration", "POST", body), env, "/api/hf/me/registration"))!.status).toBe(200);
    const changed = await hfRegistrationRoute(request("/api/hf/me/registration", "POST", { ...body, username: "maya2" }), env, "/api/hf/me/registration");
    expect(changed!.status).toBe(409);
    expect((await changed!.json()).error).toBe("username_locked");
    const other = await hfRegistrationRoute(request("/api/hf/me/username?value=maya", "GET", undefined, "u2"), env, "/api/hf/me/username");
    expect(await other!.json()).toEqual({ available: false, username: "maya" });
  });
});

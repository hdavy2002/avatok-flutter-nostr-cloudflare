// [ADMIN2-USERS 2026-09-26] Admin 2 Users: list, detail, block/unblock, sign out
// everywhere, delete — through the real Admin 2 dispatcher against real SQLite
// (node:sqlite). Auth, telemetry, the Clerk API (fetch) and the delete cascade are mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const H = vi.hoisted(() => ({
  uid: "admin1" as string | null, exceptions: 0,
  events: [] as Array<{ event: string; props: any }>,
  deletes: [] as string[], deleteStatus: 200,
}));
vi.mock("../src/authz", () => ({
  requireUser: async () => (H.uid ? { uid: H.uid } : { error: "unauthorized", status: 401 }),
  isFail: (v: any) => Boolean(v?.error),
}));
vi.mock("../src/hooks", () => ({
  track: async (_env: unknown, _uid: string, event: string, _app: string, props: any) => { H.events.push({ event, props }); },
  trackUser: async () => {},
  trackException: async () => { H.exceptions++; },
}));
vi.mock("../src/lib/identity", () => ({ emailFor: async (_env: unknown, uid: string) => (uid === "nomail" ? null : `${uid}@example.com`) }));
vi.mock("../src/routes/admin_delete_user", () => ({
  adminDeleteUser: async (req: Request) => {
    const uid = new URL(req.url).searchParams.get("uid") ?? "";
    H.deletes.push(uid);
    return new Response(JSON.stringify(H.deleteStatus === 200 ? { ok: true, uid, enqueued: true, immediate: true } : { error: "boom" }),
      { status: H.deleteStatus, headers: { "content-type": "application/json" } });
  },
}));

import { admin2Route } from "../src/routes/admin2";
import { buildUsersQuery, parseFilters, parseSort, readOffset, offsetCursor, shapeClerkUser } from "../src/routes/admin2_users";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => any };
const mig = (f: string) => readFileSync(fileURLToPath(new URL(`../migrations/${f}`, import.meta.url)), "utf8");

function d1(db: any): any {
  return {
    prepare(sql: string) {
      let named = "", next = 1; const used = new Set<number>();
      for (let i = 0; i < sql.length; i++) {
        if (sql[i] !== "?") { named += sql[i]; continue; }
        let j = i + 1; while (j < sql.length && /\d/.test(sql[j])) j++;
        if (j > i + 1) { const n = Number(sql.slice(i + 1, j)); named += `$p${n}`; used.add(n); next = Math.max(next, n + 1); i = j - 1; }
        else { named += `$p${next}`; used.add(next); next++; }
      }
      let params: Record<string, unknown> = {};
      const w = {
        bind(...values: unknown[]) { params = {}; for (const n of used) params[`p${n}`] = values[n - 1] === undefined ? null : values[n - 1]; return w; },
        async run() { const r = db.prepare(named).run(params); return { meta: { changes: Number(r.changes ?? 0) } }; },
        async first<T = any>(): Promise<T | null> { return (db.prepare(named).get(params) as T | undefined) ?? null; },
        async all<T = any>(): Promise<{ results: T[] }> { return { results: db.prepare(named).all(params) as T[] }; },
      };
      return w;
    },
  };
}

const NOW = Date.UTC(2026, 8, 26, 6, 0, 0);
const H1 = 3_600_000;

async function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE listings (id TEXT PRIMARY KEY, creator_id TEXT, kind TEXT, title TEXT, description TEXT, category TEXT,
      price INTEGER, free_entry INTEGER DEFAULT 0, cover_media TEXT, attrs TEXT, starts_at INTEGER, duration_min INTEGER,
      capacity INTEGER, status TEXT, expires_at INTEGER, is_example INTEGER DEFAULT 0);
    CREATE TABLE listing_categories (id TEXT PRIMARY KEY, label TEXT, sort INTEGER, active INTEGER DEFAULT 1);
    CREATE TABLE orders (id TEXT PRIMARY KEY, listing_id TEXT, buyer_id TEXT, creator_id TEXT, amount INTEGER, promo_id TEXT,
      status TEXT, created_at INTEGER, updated_at INTEGER, kind TEXT);
    CREATE TABLE commercial_policy_snapshots (order_id TEXT PRIMARY KEY, gross_amount INTEGER, gst_amount INTEGER);
    CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT, first_name TEXT, last_name TEXT, avatar_url TEXT,
      email_hash TEXT, phone_hash TEXT, private_number TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE phone_otp (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, phone_hash TEXT, e164 TEXT, session_id TEXT,
      status TEXT, attempts INTEGER DEFAULT 0, created_at INTEGER, verified_at INTEGER);
    CREATE TABLE account_status (clerk_user_id TEXT PRIMARY KEY, uid TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      reason TEXT, blocked_until INTEGER, blocked_at INTEGER, appealed INTEGER DEFAULT 0);
    CREATE TABLE deletion_requests (uid TEXT PRIMARY KEY, clerk_user_id TEXT, pubkey_hex TEXT, requested_at INTEGER NOT NULL,
      scheduled_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', processed_at INTEGER, stores_done TEXT);
  `);
  db.exec(mig("contact_verification.sql"));
  db.exec(mig("2026-07-11-clerk-uid-alias.sql"));
  db.exec(mig("2026-09-17-hdfc-sms-payments.sql"));
  db.exec(mig("2026-09-26-admin2-user-blocks.sql"));
  for (const f of ["refunds", "user-profile-extras", "user-addresses", "user-vpas"]) db.exec(mig(`2026-09-25-dash2-${f}.sql`));
  db.exec(`
    INSERT INTO listing_categories VALUES ('puja','Puja',1,1);
    INSERT INTO listings (id,kind,title,category,price,starts_at,duration_min,status) VALUES
      ('L1','live_event','Ganesh Puja','puja',501,${NOW + 72 * H1},60,'published'),
      ('L0','live_event','Old Havan','puja',1100,${NOW - 72 * H1},60,'completed');
    INSERT INTO users (uid,display_name,first_name,last_name,avatar_url,created_at) VALUES
      ('alice','Alice Devi',NULL,NULL,'https://img/a.png',${NOW - 900 * H1}),
      ('bob',NULL,'Bob','Kumar',NULL,${NOW - 800 * H1}),
      ('carol',NULL,NULL,NULL,NULL,${NOW - 700 * H1}),
      ('zed','Zed',NULL,NULL,NULL,${NOW - 10 * H1}),
      ('admin1','Owner',NULL,NULL,NULL,${NOW - 1000 * H1}),
      ('admin2','Second Admin',NULL,NULL,NULL,${NOW - 950 * H1});
    INSERT INTO phone_otp (uid,phone_hash,e164,status,created_at,verified_at) VALUES
      ('alice','h','+919876543210','verified',${NOW - 100 * H1},${NOW - 100 * H1});
    INSERT INTO contact_verification (uid,phone_verified,phone_hash,updated_at) VALUES ('bob',1,'hb',${NOW});
    INSERT INTO orders (id,listing_id,buyer_id,amount,status,created_at,kind) VALUES
      ('o1','L1','alice',501,'held',${NOW - 5 * H1},'live_event'),
      ('o2','L0','alice',1100,'held',${NOW - 80 * H1},'live_event'),
      ('o3','L1','bob',501,'refunded',${NOW - 6 * H1},'live_event'),
      ('o4','L1','carol',0,'free',${NOW - 3 * H1},'live_event');
    INSERT INTO commercial_policy_snapshots VALUES ('o2',1100,198);
    INSERT INTO hdfc_sms_payment_intents (intent_id,uid,listing_id,kind,amount_paise,status,bank_reference,commercial_order_id,expires_at,created_at,updated_at) VALUES
      ('i1','alice','L1','live_event',62700,'confirmed','512345678901','o1',${NOW},${NOW - 5 * H1},${NOW - 5 * H1 + 1000}),
      ('i2','zed','L1','live_event',62700,'payment_received','UTR55501',NULL,${NOW + H1},${NOW - 1 * H1},${NOW - 1 * H1});
    INSERT INTO refunds (id,payment_id,uid,amount_paise,reason,status,refund_vpa,refund_utr,requested_at,refunded_at,admin_uid) VALUES
      ('r2','o2','alice',129800,'Partial','refunded','alice@okhdfc','UTR1',${NOW - 50 * H1},${NOW - 49 * H1},'admin1');
    UPDATE refunds SET amount_paise=29800 WHERE id='r2';
    INSERT INTO clerk_uid_alias (alias_clerk_id, canonical_uid, reason, created_at) VALUES ('alice_new','alice','email_relink',${NOW});
  `);
  const wallet = new DatabaseSync(":memory:");
  wallet.exec("CREATE TABLE admin_audit (id TEXT PRIMARY KEY, admin_id TEXT, action TEXT, target TEXT, meta TEXT, created_at INTEGER)");
  return { raw: db, wallet, env: { DB_META: d1(db), DB_WALLET: d1(wallet), ADMIN_UIDS: "admin1, admin2", CLERK_SECRET_KEY: "sk_test" } as any };
}

/** Clerk Backend API fake. */
const C = { calls: [] as string[], fail: false, sessions: { alice: ["s1", "s2"], alice_new: ["s3"] } as Record<string, string[]> };
function clerkFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  C.calls.push(`${method} ${url.pathname}${url.search}`);
  const ok = (b: unknown) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } }));
  if (C.fail) return Promise.resolve(new Response("{}", { status: 500 }));
  if (url.pathname === "/v1/users" && method === "GET") {
    const ids = url.searchParams.getAll("user_id");
    if (url.searchParams.get("query")) return ok(url.searchParams.get("query") === "kumar@gmail" ? [{ id: "bob" }] : []);
    return ok(ids.map((id) => ({
      id, first_name: id, last_name: null, image_url: `https://clerk/${id}.png`, has_image: true,
      primary_email_address_id: "e1", email_addresses: [{ id: "e1", email_address: `${id}@example.com`, verification: { status: "verified" } }],
      phone_numbers: [], created_at: NOW - 1000 * H1, last_sign_in_at: NOW - 2 * H1, last_active_at: NOW - H1, banned: false, locked: false,
    })));
  }
  if (/^\/v1\/users\/[^/]+\/(ban|unban)$/.test(url.pathname)) return ok({});
  if (url.pathname === "/v1/sessions") return ok((C.sessions[url.searchParams.get("user_id") ?? ""] ?? []).map((id) => ({ id })));
  if (/^\/v1\/sessions\/[^/]+\/revoke$/.test(url.pathname)) return ok({});
  return Promise.resolve(new Response("{}", { status: 404 }));
}

const call = async (env: any, method: string, path: string, body?: unknown) => {
  const url = `https://api.test${path}`;
  const req = new Request(url, {
    method, headers: { authorization: "Bearer t", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const res = await admin2Route(req, env, new URL(url).pathname);
  if (!res) return { status: 0, body: null as any, text: "" };
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
  let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* csv */ }
  return { status: res.status, body: parsed, text, res };
};

beforeEach(() => {
  H.uid = "admin1"; H.exceptions = 0; H.events = []; H.deletes = []; H.deleteStatus = 200;
  C.calls = []; C.fail = false;
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.stubGlobal("fetch", vi.fn(clerkFetch));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("guard", () => {
  it("is admin-only on every users route", async () => {
    const { env } = await setup();
    H.uid = "alice";
    for (const [m, p] of [["GET", "/api/admin/v2/users"], ["GET", "/api/admin/v2/users/bob"], ["POST", "/api/admin/v2/users/bob/block"],
      ["POST", "/api/admin/v2/users/bob/unblock"], ["POST", "/api/admin/v2/users/bob/signout-all"], ["DELETE", "/api/admin/v2/users/bob"]] as const) {
      const r = await call(env, m, p, m === "GET" ? undefined : {});
      expect(r.status, p).toBe(403);
      expect(r.body.error).toBe("admin_only");
    }
    expect(H.deletes).toEqual([]);
  });
});

describe("GET /api/admin/v2/users", () => {
  it("lists every account with Clerk info, spend net of refunds, bookings, status", async () => {
    const { env } = await setup();
    const r = await call(env, "GET", "/api/admin/v2/users");
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.items.map((i: any) => [i.uid, i]));
    expect(Object.keys(by).sort()).toEqual(["admin1", "admin2", "alice", "bob", "carol", "zed"]);
    // Sorted newest joiner first.
    expect(r.body.items[0].uid).toBe("zed");
    // alice: 627.00 (intent) + 1298.00 paid for o2 of which 298.00 refunded -> 627 + 1000 = 1627.00
    expect(by.alice.spent_paise).toBe(62700 + 100000);
    expect(by.alice.bookings).toBe(2);
    expect(by.alice.email).toBe("alice@example.com");
    expect(by.alice.photo_url).toBe("https://img/a.png");
    expect(by.alice.phone_masked).toBe("+91 98•••••210");
    expect(by.alice.phone_verified).toBe(true);
    expect(by.alice.last_active_at).toBe(NOW - H1);
    expect(by.bob.name).toBe("Bob Kumar");
    expect(by.bob.phone_verified).toBe(true);
    expect(by.bob.spent_paise).toBe(0); // fully refunded
    expect(by.carol.bookings).toBe(1); // free seat
    expect(by.carol.name).toBe("carol"); // falls back to Clerk's name
    expect(by.zed.spent_paise).toBe(0); // pending UPI is not spent
    expect(by.admin1.is_admin && by.admin1.is_self).toBe(true);
    expect(by.admin2.is_admin).toBe(true);
    expect(by.alice.status).toBe("active");
    expect(r.body.totals.users).toBe(6);
    // One Clerk batch call for the page.
    expect(C.calls.filter((c) => c.startsWith("GET /v1/users?")).length).toBe(1);
  });

  it("filters, sorts and pages", async () => {
    const { env, raw } = await setup();
    raw.exec("INSERT INTO account_status (clerk_user_id, uid, status) VALUES ('carol','carol','perm_banned')");
    const ids = async (qs: string) => (await call(env, "GET", `/api/admin/v2/users?${qs}`)).body.items.map((i: any) => i.uid);
    expect(await ids("filter=verified")).toEqual(["bob", "alice"]);
    expect((await ids("filter=not_verified")).sort()).toEqual(["admin1", "admin2", "carol", "zed"]);
    expect(await ids("filter=blocked")).toEqual(["carol"]);
    expect(await ids("filter=has_spent")).toEqual(["alice"]);
    expect(await ids("filter=verified,has_spent")).toEqual(["alice"]);
    expect((await ids(`joined_from=${NOW - 850 * H1}&joined_to=${NOW - 600 * H1}`))).toEqual(["carol", "bob"]);
    expect((await ids("sort=spent"))[0]).toBe("alice");
    expect(await ids("sort=name")).toEqual(["alice", "bob", "carol", "admin1", "admin2", "zed"].sort((a, b) => {
      const n: Record<string, string> = { alice: "alice devi", bob: "bob kumar", carol: "~", admin1: "owner", admin2: "second admin", zed: "zed" };
      return n[a] < n[b] ? -1 : n[a] > n[b] ? 1 : a < b ? -1 : 1;
    }));
    // Search: name, and Clerk's own (partial email) search.
    expect(await ids("q=devi")).toEqual(["alice"]);
    expect(await ids("q=kumar%40gmail")).toEqual(["bob"]);
    const carol = (await call(env, "GET", "/api/admin/v2/users?filter=blocked")).body.items[0];
    expect(carol.status).toBe("blocked");
  });

  it("uses offset cursors and rejects a bad one", async () => {
    expect(readOffset(offsetCursor(50))).toBe(50);
    expect(readOffset(null)).toBe(0);
    expect(readOffset("garbage!!")).toBeNull();
    const { env } = await setup();
    expect((await call(env, "GET", "/api/admin/v2/users?cursor=zzz")).status).toBe(400);
    const q = buildUsersQuery(NOW, { offset: 50, limit: 51, sort: "spent" });
    expect(q.sql).toMatch(/ORDER BY p\.spent_paise DESC.*LIMIT 51 OFFSET 50$/s);
    expect(parseFilters("verified,nope,blocked")).toEqual(["verified", "blocked"]);
    expect(parseSort("hack")).toBe("joined");
  });

  it("exports CSV", async () => {
    const { env } = await setup();
    const r = await call(env, "GET", "/api/admin/v2/users?format=csv&filter=has_spent");
    expect(r.status).toBe(200);
    expect(r.res!.headers.get("content-disposition")).toContain("saathum-users-2026-09-26.csv");
    const lines = r.text.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toContain("Total spent (INR)");
    expect(lines[1]).toContain("alice@example.com");
    expect(lines[1]).toContain("1627.00");
    expect(lines.length).toBe(2);
  });

  it("survives a Clerk outage (falls back to the cached email)", async () => {
    const { env } = await setup();
    C.fail = true;
    const r = await call(env, "GET", "/api/admin/v2/users?filter=has_spent");
    expect(r.status).toBe(200);
    expect(r.body.items[0].email).toBe("alice@example.com");
    expect(r.body.items[0].last_active_at).toBeNull();
  });
});

describe("GET /api/admin/v2/users/:uid", () => {
  it("returns profile, money, bookings, payments and account info", async () => {
    const { env } = await setup();
    const r = await call(env, "GET", "/api/admin/v2/users/alice");
    expect(r.status).toBe(200);
    expect(r.body.profile.name).toBe("Alice Devi");
    expect(r.body.profile.phone.verified).toBe(true);
    expect(r.body.money).toMatchObject({ spent_paise: 162700, payments: 2, refunds: 1, refunded_paise: 29800, bookings: 2 });
    expect(r.body.bookings.length).toBe(2);
    expect(r.body.payments.length).toBe(2);
    expect(r.body.account).toMatchObject({ status: "active", is_admin: false, is_self: false, deleting: false });
    expect(r.body.account.clerk.last_sign_in_at).toBe(NOW - 2 * H1);
    expect((await call(env, "GET", "/api/admin/v2/users/nobody")).status).toBe(404);
  });
});

describe("actions", () => {
  it("block bans in Clerk (uid + aliases), refuses the API via account_status, records and audits", async () => {
    const { env, raw, wallet } = await setup();
    const r = await call(env, "POST", "/api/admin/v2/users/alice/block", { reason: "Chargeback abuse" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: "blocked", reason: "Chargeback abuse" });
    expect(C.calls).toContain("POST /v1/users/alice/ban");
    expect(C.calls).toContain("POST /v1/users/alice_new/ban");
    expect(raw.prepare("SELECT status FROM account_status WHERE clerk_user_id='alice'").get().status).toBe("perm_banned");
    expect(raw.prepare("SELECT admin_uid, reason FROM admin2_user_blocks WHERE uid='alice'").get()).toMatchObject({ admin_uid: "admin1", reason: "Chargeback abuse" });
    expect(wallet.prepare("SELECT action, target, admin_id FROM admin_audit").all()).toEqual([{ action: "user_block", target: "alice", admin_id: "admin1" }]);
    expect(H.events).toContainEqual(expect.objectContaining({ event: "admin2_user_action", props: expect.objectContaining({ action: "block", ok: true }) }));
    const d = await call(env, "GET", "/api/admin/v2/users/alice");
    expect(d.body.account.status).toBe("blocked");
    expect(d.body.account.blocked).toMatchObject({ by: "admin1", reason: "Chargeback abuse" });

    const u = await call(env, "POST", "/api/admin/v2/users/alice/unblock", {});
    expect(u.status).toBe(200);
    expect(C.calls).toContain("POST /v1/users/alice/unban");
    expect(raw.prepare("SELECT status FROM account_status WHERE clerk_user_id='alice'").get().status).toBe("active");
    expect(raw.prepare("SELECT COUNT(*) AS n FROM admin2_user_blocks").get().n).toBe(0);
  });

  it("block reports a Clerk failure but keeps the API refusal", async () => {
    const { env, raw } = await setup();
    C.fail = true;
    const r = await call(env, "POST", "/api/admin/v2/users/bob/block", {});
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ error: "clerk_failed", partial: true });
    expect(raw.prepare("SELECT status FROM account_status WHERE clerk_user_id='bob'").get().status).toBe("perm_banned");
    expect(H.events).toContainEqual(expect.objectContaining({ props: expect.objectContaining({ action: "block", ok: false }) }));
  });

  it("refuses to act on yourself or another admin", async () => {
    const { env, raw } = await setup();
    for (const target of ["admin1", "admin2"]) {
      for (const [m, p, b] of [["POST", "block", {}], ["POST", "signout-all", {}], ["DELETE", "", { confirm: `${target}@example.com` }]] as const) {
        const r = await call(env, m, `/api/admin/v2/users/${target}${p ? "/" + p : ""}`, b);
        expect(r.status, `${m} ${target} ${p}`).toBe(403);
        expect(r.body.error).toBe("protected_account");
      }
    }
    expect(raw.prepare("SELECT COUNT(*) AS n FROM account_status").get().n).toBe(0);
    expect(H.deletes).toEqual([]);
    expect(C.calls.some((c) => c.startsWith("POST"))).toBe(false);
  });

  it("sign out everywhere revokes every active Clerk session (aliases too)", async () => {
    const { env, wallet } = await setup();
    const r = await call(env, "POST", "/api/admin/v2/users/alice/signout-all", {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, revoked: 3 });
    expect(C.calls.filter((c) => c.endsWith("/revoke")).sort()).toEqual(["POST /v1/sessions/s1/revoke", "POST /v1/sessions/s2/revoke", "POST /v1/sessions/s3/revoke"]);
    expect(wallet.prepare("SELECT action FROM admin_audit").get().action).toBe("user_signout_all");
    expect(H.events).toContainEqual(expect.objectContaining({ props: expect.objectContaining({ action: "signout_all", ok: true }) }));
  });

  it("delete needs the typed email, then runs the existing delete-user cascade", async () => {
    const { env, wallet } = await setup();
    const bad = await call(env, "DELETE", "/api/admin/v2/users/bob", { confirm: "someone@else.com" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("confirm_mismatch");
    expect(H.deletes).toEqual([]);
    const ok = await call(env, "DELETE", "/api/admin/v2/users/bob", { confirm: "BOB@example.com" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, deleting: true });
    expect(H.deletes).toEqual(["bob"]);
    expect(wallet.prepare("SELECT action, target FROM admin_audit").all()).toEqual([{ action: "user_delete", target: "bob" }]);
    expect(H.events.filter((e) => e.props.action === "delete").map((e) => e.props.ok)).toEqual([false, true]);
  });

  it("delete of a user with no email confirms with the uid; a cascade failure is reported", async () => {
    const { env } = await setup();
    H.deleteStatus = 500;
    const r = await call(env, "DELETE", "/api/admin/v2/users/nomail", { confirm: "nomail" });
    expect(r.status).toBe(500);
    expect(r.body.error).toBe("delete_failed");
    expect(H.deletes).toEqual(["nomail"]);
  });
});

describe("shapeClerkUser", () => {
  it("reads the primary email and ignores a default avatar", () => {
    const c = shapeClerkUser({ primary_email_address_id: "b", email_addresses: [{ id: "a", email_address: "x@y.z" }, { id: "b", email_address: "p@q.r", verification: { status: "verified" } }], has_image: false, image_url: "https://default", banned: true });
    expect(c).toMatchObject({ email: "p@q.r", email_verified: true, image_url: null, banned: true, last_active_at: null });
  });
});

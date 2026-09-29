// [SAATHUM-TEMPLE-FIELD-1 2026-09-29] Temple directory: migration seed, admin API
// (list / create / duplicate), temple_id validation on event save, and the public read.
// Runs the REAL migration against node:sqlite through a tiny D1-shaped adapter.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const H = vi.hoisted(() => ({ uid: "admin1" as string | null }));
vi.mock("../src/authz", () => ({
  requireUser: async () => (H.uid ? { uid: H.uid } : { error: "unauthorized", status: 401 }),
  isFail: (v: any) => Boolean(v?.error),
}));
vi.mock("../src/hooks", () => ({
  track: async () => {},
  trackUser: async () => {},
  trackException: async () => {},
}));

import { adminTempleCreate, adminTemplesList, checkTempleInput } from "../src/routes/admin2_events";
import { admin2Route } from "../src/routes/admin2";
import { normalizeTempleInput, parseTempleIdInput, setListingTemple, templeForListing, templeLabel } from "../src/lib/temples";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => any };
const migration = readFileSync(fileURLToPath(new URL("../migrations/2026-09-29-saathum-temples.sql", import.meta.url)), "utf8");

function fakeEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE listings (id TEXT PRIMARY KEY, title TEXT)");
  db.exec("CREATE TABLE admin_audit (id TEXT, admin_id TEXT, action TEXT, target TEXT, meta TEXT, created_at INTEGER)");
  db.exec(migration);
  db.exec("INSERT INTO listings (id, title) VALUES ('ev1','Havan'), ('ev2','Puja')");
  const d1 = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const st = {
        bind(...b: unknown[]) { binds = b; return st; },
        async run() { const r = db.prepare(sql).run(...binds); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...binds) ?? null; },
        async all() { return { results: db.prepare(sql).all(...binds) }; },
      };
      return st;
    },
  };
  return { DB_META: d1, DB_WALLET: d1, ADMIN_UIDS: "admin1", db } as any;
}

const post = (body: unknown) => new Request("https://x.test/api/admin/v2/temples", {
  method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t" }, body: JSON.stringify(body),
});
const get = () => new Request("https://x.test/api/admin/v2/temples", { headers: { authorization: "Bearer t" } });

let env: ReturnType<typeof fakeEnv>;
beforeEach(() => { H.uid = "admin1"; env = fakeEnv(); });

describe("migration", () => {
  it("seeds the 20 temples and adds listings.temple_id", () => {
    expect(env.db.prepare("SELECT COUNT(*) n FROM saathum_temples").get().n).toBe(20);
    const kunja = env.db.prepare("SELECT name, region FROM saathum_temples WHERE name='Kunjapuri Devi Temple'").get();
    expect(kunja.region).toBe("rishikesh");
    expect(env.db.prepare("SELECT temple_id FROM listings WHERE id='ev1'").get().temple_id).toBeNull();
  });
});

describe("normalizeTempleInput", () => {
  it("trims, collapses spaces and enforces 2-80 characters", () => {
    expect(normalizeTempleInput({ name: "  Kunjapuri   Devi Temple ", place: " Rishikesh " })).toEqual({ name: "Kunjapuri Devi Temple", place: "Rishikesh" });
    expect(normalizeTempleInput({ name: "A", place: "Rishikesh" })).toMatchObject({ field: "name" });
    expect(normalizeTempleInput({ name: "Ok name", place: "x" })).toMatchObject({ field: "place" });
    expect(normalizeTempleInput({ name: "n".repeat(81), place: "Rishikesh" })).toMatchObject({ field: "name" });
    expect(normalizeTempleInput({ name: "Ok name", place: "p".repeat(81) })).toMatchObject({ field: "place" });
    expect(normalizeTempleInput({ name: 5, place: null })).toMatchObject({ field: "name" });
  });
});

describe("admin temple API", () => {
  it("lists the seeded temples, sorted by name", async () => {
    const res = await adminTemplesList(get(), env);
    const b: any = await res.json();
    expect(res.status).toBe(200);
    expect(b.temples).toHaveLength(20);
    const names = b.temples.map((t: any) => t.name.toLowerCase());
    expect(names).toEqual([...names].sort());
  });
  it("creates a temple (201) and lists it", async () => {
    const res = await adminTempleCreate(post({ name: "Chandi Devi Temple", place: "Haridwar" }), env);
    const b: any = await res.json();
    expect(res.status).toBe(201);
    expect(b.created).toBe(true);
    expect(b.temple).toMatchObject({ name: "Chandi Devi Temple", place: "Haridwar", region: null });
    const list: any = await (await adminTemplesList(get(), env)).json();
    expect(list.temples).toHaveLength(21);
    expect(env.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='temple_create'").get().n).toBe(1);
  });
  it("returns the existing row for a case-insensitive duplicate, and adds nothing", async () => {
    const res = await adminTempleCreate(post({ name: "  kunjapuri DEVI temple", place: " RISHIKESH " }), env);
    const b: any = await res.json();
    expect(res.status).toBe(200);
    expect(b.created).toBe(false);
    expect(b.temple.id).toBe("temple_kunjapuri-devi-temple");
    expect(env.db.prepare("SELECT COUNT(*) n FROM saathum_temples").get().n).toBe(20);
  });
  it("rejects bad names/places with a 400 naming the field", async () => {
    const r1 = await adminTempleCreate(post({ name: "X", place: "Rishikesh" }), env);
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as any).field).toBe("name");
    const r2 = await adminTempleCreate(post({ name: "Fine Temple", place: "" }), env);
    expect(((await r2.json()) as any).field).toBe("place");
    expect(env.db.prepare("SELECT COUNT(*) n FROM saathum_temples").get().n).toBe(20);
  });
  it("is admin-only (401 signed out, 403 for a non-admin) via the real dispatcher", async () => {
    H.uid = null;
    expect((await admin2Route(get(), env, "/api/admin/v2/temples"))!.status).toBe(401);
    H.uid = "someone";
    expect((await admin2Route(post({ name: "Fine Temple", place: "Haridwar" }), env, "/api/admin/v2/temples"))!.status).toBe(403);
    H.uid = "admin1";
    expect((await admin2Route(get(), env, "/api/admin/v2/temples"))!.status).toBe(200);
  });
});

describe("temple_id on event save", () => {
  it("parses absent / clear / set", () => {
    expect(parseTempleIdInput({})).toEqual({ present: false });
    expect(parseTempleIdInput({ temple_id: null })).toEqual({ present: true, value: null });
    expect(parseTempleIdInput({ temple_id: "" })).toEqual({ present: true, value: null });
    expect(parseTempleIdInput({ temple_id: "temple_x" })).toEqual({ present: true, value: "temple_x" });
    expect(parseTempleIdInput({ temple_id: 7 })).toHaveProperty("error");
  });
  it("accepts an existing temple, allows clearing, rejects an unknown id with 400", async () => {
    expect(await checkTempleInput(env, { temple_id: "temple_kunjapuri-devi-temple" })).toEqual({ present: true, value: "temple_kunjapuri-devi-temple" });
    expect(await checkTempleInput(env, { temple_id: null })).toEqual({ present: true, value: null });
    expect(await checkTempleInput(env, {})).toEqual({ present: false });
    const bad = (await checkTempleInput(env, { temple_id: "temple_nope" })) as Response;
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).field).toBe("temple_id");
  });
  it("saves on the event, feeds the public read, and clears", async () => {
    expect(await templeForListing(env, "ev1")).toBeNull();
    await setListingTemple(env, "ev1", "temple_kunjapuri-devi-temple");
    const t = await templeForListing(env, "ev1");
    expect(t).toEqual({ id: "temple_kunjapuri-devi-temple", name: "Kunjapuri Devi Temple", place: "Rishikesh" });
    expect(templeLabel(t!)).toBe("Kunjapuri Devi Temple, Rishikesh");
    expect(await templeForListing(env, "ev2")).toBeNull();
    await setListingTemple(env, "ev1", null);
    expect(await templeForListing(env, "ev1")).toBeNull();
  });
  it("public read never throws before the migration has run", async () => {
    const bare = new DatabaseSync(":memory:");
    bare.exec("CREATE TABLE listings (id TEXT PRIMARY KEY)");
    const e: any = { DB_META: { prepare: (sql: string) => ({ bind: () => ({ first: async () => bare.prepare(sql).get() }) }) } };
    expect(await templeForListing(e, "ev1")).toBeNull();
  });
});

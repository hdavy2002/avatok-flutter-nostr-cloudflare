// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-NATIVE-S2/S3] GET /api/hf/hosts + GET /api/hf/options against real SQLite (the real migrations, the real SQL).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

let cfg: Record<string, unknown> = {};
let currentUid: string | null = null;
vi.mock("../hooks", () => ({ track: async () => undefined, trackException: async () => undefined }));
vi.mock("./config", () => ({ readConfig: async () => cfg }));
vi.mock("../authz", () => ({
  requireUser: async () => (currentUid ? { uid: currentUid } : { error: "unauthorized", status: 401 }),
  isFail: (u: any) => !!u?.error,
}));

import { hfHostsListRoute } from "./hf_hosts_list";
import { hfHostsPublicRoute } from "./hf_hosts_public";
import { parseHostList, listCacheKey } from "../lib/hf_hosts_list";
import { buildHfOptions, TOPICS, TOPIC_SLUGS, MOOD_GROUPS, LANGUAGES, STYLES } from "../lib/hf_options";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
const mig = (f: string) => readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8");

let prepares = 0;
function makeEnv() {
  const db = new DatabaseSync(":memory:");
  for (const f of ["2026-10-09-hf-hosts.sql", "2026-10-09-hf-presence.sql", "2026-10-09-hf-reviews.sql", "2026-10-09-hf-lane-access.sql", "2026-10-10-hf-hosts-list-idx.sql"]) db.exec(mig(f));
  db.exec(`CREATE TABLE hf_kyc (uid TEXT PRIMARY KEY, gender TEXT, verified_at INTEGER);`);
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  return { db, env: { BLOSSOM_BASE_URL: "https://m.test", DB_META: { prepare: (q: string) => { prepares++; return stmt(q); } } } as any };
}

type H = { uid: string; slug: string | null; name: string; status?: string; presence: string; price: number; langs: string[]; topics: string[]; live: number; women?: number; lgbtq?: number; stars?: number[] };
const HOSTS: H[] = [
  { uid: "u1", slug: "ana-aaaa", name: "Ana", presence: "online", price: 10, langs: ["Hindi", "English"], topics: ["breakup", "exam-ki-tension"], live: 100, stars: [5, 5] },
  { uid: "u2", slug: "bina-bbbb", name: "Bina", presence: "busy", price: 20, langs: ["Hindi"], topics: ["din-kharab-tha"], live: 200, stars: [4, 4] },
  { uid: "u3", slug: "chit-cccc", name: "Chitra", presence: "offline", price: 30, langs: ["Tamil", "English"], topics: ["breakup"], live: 300, women: 1 },
  { uid: "u4", slug: "dev-dddd", name: "Dev", presence: "online", price: 15, langs: ["Bengali"], topics: ["naukri-ki-chinta"], live: 400, lgbtq: 1, stars: [3] },
  { uid: "u5", slug: "esha-eeee", name: "Esha", presence: "online", price: 50, langs: ["Hindi"], topics: ["breakup"], live: 500, stars: [5, 4] },
  { uid: "u6", slug: "fay-ffff", name: "Fay", status: "pending_review", presence: "online", price: 10, langs: ["Hindi"], topics: ["breakup"], live: 600 },
  { uid: "u7", slug: null, name: "Gus", presence: "online", price: 10, langs: ["Hindi"], topics: ["breakup"], live: 700 },
];
function seed(db: any) {
  let n = 0;
  for (const h of HOSTS) {
    db.prepare(`INSERT INTO hf_hosts (uid, slug, status, display_name, languages_json, topics_json, price_per_min, women_lane, lgbtq_lane, lgbtq_public, presence, live_at, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1)`).run(h.uid, h.slug, h.status ?? "live", h.name, JSON.stringify(h.langs), JSON.stringify(h.topics), h.price, h.women ?? 0, h.lgbtq ?? 0, h.lgbtq ?? 0, h.presence, h.live);
    for (const s of h.stars ?? []) db.prepare(`INSERT INTO hf_reviews (id, call_id, caller_uid, host_uid, stars, status, created_at) VALUES (?,?,?,?,?,'approved',1)`).run(`r${++n}`, `c${n}`, "x", h.uid, s);
  }
  // pending + rejected reviews must not move a rating
  db.prepare(`INSERT INTO hf_reviews (id, call_id, caller_uid, host_uid, stars, status, created_at) VALUES ('rp','cp','x','u4',5,'pending',1),('rr','cr','x','u4',5,'rejected',1)`).run();
}

let E: ReturnType<typeof makeEnv>;
const get = (qs = "", headers: Record<string, string> = {}, path = "/api/hf/hosts") => hfHostsListRoute(new Request(`https://api.test${path}${qs ? "?" + qs : ""}`, { headers }), E.env);
const slugs = async (qs = "") => ((await (await get(qs))!.json()) as any).items.map((i: any) => i.slug.slice(0, -5));

beforeEach(() => { E = makeEnv(); seed(E.db); cfg = { hostsPublicEnabled: true }; currentUid = null; prepares = 0; });
afterEach(() => { delete (globalThis as any).caches; });

describe("GET /api/hf/hosts", () => {
  it("returns published hosts only, in the public card shape, with total", async () => {
    const res = (await get())!;
    expect(res.status).toBe(200);
    const b: any = await res.json();
    expect(b.total).toBe(5);
    expect(b.nextOffset).toBeNull();
    expect(b.items.map((i: any) => i.slug)).not.toContain("fay-ffff");
    expect(Object.keys(b.items[0]).sort()).toEqual(
      ["avatarUrl", "displayName", "introAudioUrl", "introMime", "introSeconds", "languages", "lgbtqFriendly", "pricePerMin", "rating", "ratingBreakdown", "regulars", "reviewCount", "slug", "status", "style", "tagline", "talkedTo", "topics", "womenOnly"],
    );
  });

  it("cards are identical to /api/hosts/public cards", async () => {
    const pub: any[] = await (await hfHostsPublicRoute(new Request("https://api.test/api/hosts/public?limit=48"), E.env))!.json();
    const mine: any = await (await get("limit=48"))!.json();
    const by = (a: any[]) => Object.fromEntries(a.map((c) => [c.slug, c]));
    expect(by(mine.items)).toEqual(by(pub));
    expect(Array.isArray(pub)).toBe(true); // the web's route keeps its bare-array shape
  });

  it("sort online_first: online, then busy, then offline, then rating", async () => {
    expect(await slugs()).toEqual(["ana", "esha", "dev", "bina", "chit"]);
    expect(await slugs("sort=online_first")).toEqual(["ana", "esha", "dev", "bina", "chit"]);
  });
  it("sort price_low and rating (unrated last; pending/rejected reviews ignored)", async () => {
    expect(await slugs("sort=price_low")).toEqual(["ana", "dev", "bina", "chit", "esha"]);
    expect(await slugs("sort=rating")).toEqual(["ana", "esha", "bina", "dev", "chit"]);
    const items: any[] = ((await (await get("sort=rating"))!.json()) as any).items;
    expect(items.find((i) => i.slug === "dev-dddd").rating).toBe(3); // pending 5s did not count
    expect(items.find((i) => i.slug === "esha-eeee").rating).toBe(4.5);
  });

  it("filters by topic (any of), language (codes or names), price range and online", async () => {
    expect(await slugs("topic=breakup")).toEqual(["ana", "esha", "chit"]);
    expect(await slugs("topic=din-kharab-tha,naukri-ki-chinta")).toEqual(["dev", "bina"]);
    expect(await slugs("lang=hi")).toEqual(["ana", "esha", "bina"]);
    expect(await slugs("lang=hi,en")).toEqual(["ana", "esha", "bina", "chit"]);
    expect(await slugs("lang=Tamil")).toEqual(["chit"]);
    expect(await slugs("maxPrice=20")).toEqual(["ana", "dev", "bina"]);
    expect(await slugs("minPrice=20&maxPrice=30")).toEqual(["bina", "chit"]);
    expect(await slugs("online=1")).toEqual(["ana", "esha", "dev"]);
    expect(await slugs("topic=breakup&lang=en&maxPrice=30&online=1")).toEqual(["ana"]);
    const none: any = await (await get("topic=breakup&maxPrice=5"))!.json();
    expect(none).toEqual({ items: [], nextOffset: null, total: 0 });
  });

  it("paginates with nextOffset and total", async () => {
    const p1: any = await (await get("limit=2"))!.json();
    expect(p1.items.map((i: any) => i.slug.slice(0, -5))).toEqual(["ana", "esha"]);
    expect(p1.nextOffset).toBe(2);
    expect(p1.total).toBe(5);
    const p2: any = await (await get("limit=2&offset=2"))!.json();
    expect(p2.items.map((i: any) => i.slug.slice(0, -5))).toEqual(["dev", "bina"]);
    expect(p2.nextOffset).toBe(4);
    const p3: any = await (await get("limit=2&offset=4"))!.json();
    expect(p3.items.map((i: any) => i.slug.slice(0, -5))).toEqual(["chit"]);
    expect(p3.nextOffset).toBeNull();
    const past: any = await (await get("limit=2&offset=40"))!.json();
    expect(past).toEqual({ items: [], nextOffset: null, total: 5 });
  });

  it("clamps limit/offset/price and ignores junk numbers", async () => {
    const q = (s: string) => (parseHostList(new URLSearchParams(s)) as any).q;
    expect(q("limit=999").limit).toBe(48);
    expect(q("limit=0").limit).toBe(1);
    expect(q("limit=-5").limit).toBe(1);
    expect(q("limit=abc").limit).toBe(24);
    expect(q("").limit).toBe(24);
    expect(q("offset=-3").offset).toBe(0);
    expect(q("offset=99999999").offset).toBe(10_000);
    expect(q("maxPrice=1").maxPrice).toBe(5);
    expect(q("maxPrice=9999").maxPrice).toBe(100);
    expect(q("minPrice=0").minPrice).toBe(5);
    expect(q("maxPrice=x").maxPrice).toBeNull();
    expect(q("online=0").online).toBe(false);
    expect(((await (await get("limit=0"))!.json()) as any).items).toHaveLength(1);
  });

  it("rejects unknown topic, language, sort and lane with 400", async () => {
    for (const [qs, code] of [["topic=nope", "bad_topic"], ["topic=breakup,nope", "bad_topic"], ["lang=xx", "bad_lang"], ["sort=newest", "bad_sort"], ["lane=men", "bad_lane"]]) {
      const r = (await get(qs))!;
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error).toBe(code);
    }
  });

  it("is 404 not_enabled when hostsPublicEnabled is off, and ignores other methods/paths", async () => {
    cfg = { hostsPublicEnabled: false };
    const r = (await get())!;
    expect(r.status).toBe(404);
    expect(((await r.json()) as any).error).toBe("not_enabled");
    expect(await hfHostsListRoute(new Request("https://api.test/api/hf/hosts", { method: "POST" }), E.env)).toBeNull();
    expect(await hfHostsListRoute(new Request("https://api.test/api/hf/hosts/ana-aaaa/notify"), E.env)).toBeNull();
  });

  describe("lanes", () => {
    it("anonymous lane request is 401", async () => {
      expect((await get("lane=women"))!.status).toBe(401);
    });
    it("signed in without lane access is 403 lane_required (women and lgbtq)", async () => {
      currentUid = "viewer";
      for (const lane of ["women", "lgbtq"]) {
        const r = (await get(`lane=${lane}`, { authorization: "Bearer t" }))!;
        expect(r.status).toBe(403);
        expect(((await r.json()) as any).error).toBe("lane_required");
      }
    });
    it("with access the lane list is filtered and never cached", async () => {
      currentUid = "viewer";
      E.db.exec(`INSERT INTO hf_kyc VALUES ('viewer','F',1); INSERT INTO hf_lane_access (uid, lane, verified_at) VALUES ('viewer','women',1),('viewer','lgbtq',1);`);
      const w = (await get("lane=women", { authorization: "Bearer t" }))!;
      expect(w.status).toBe(200);
      expect(w.headers.get("cache-control")).toBe("private, no-store");
      const wb: any = await w.json();
      expect(wb.items.map((i: any) => i.slug)).toEqual(["chit-cccc"]);
      expect(wb.items[0].womenOnly).toBe(true);
      expect(wb.total).toBe(1);
      const l: any = await (await get("lane=lgbtq&online=1", { authorization: "Bearer t" }))!.json();
      expect(l.items.map((i: any) => i.slug)).toEqual(["dev-dddd"]);
    });
    it("women lane needs a female/transgender Aadhaar even with a lane row", async () => {
      currentUid = "viewer";
      E.db.exec(`INSERT INTO hf_kyc VALUES ('viewer','M',1); INSERT INTO hf_lane_access (uid, lane, verified_at) VALUES ('viewer','women',1);`);
      expect((await get("lane=women", { authorization: "Bearer t" }))!.status).toBe(403);
    });
  });

  describe("edge cache", () => {
    function stubCaches() {
      const store = new Map<string, Response>();
      (globalThis as any).caches = { default: { match: async (r: Request) => store.get(r.url)?.clone(), put: async (r: Request, res: Response) => { store.set(r.url, res); } } };
      return store;
    }
    it("caches anonymous non-lane responses for 45 s, keyed by the canonical query", async () => {
      const store = stubCaches();
      const a = (await get("topic=breakup&lang=hi&online=1&junk=1"))!;
      expect(a.headers.get("cache-control")).toBe("public, max-age=45");
      const after = prepares;
      const b = (await get("online=true&lang=hi&topic=breakup&other=2"))!; // same query, different order/noise
      expect(prepares).toBe(after); // served from cache, D1 untouched
      expect(await b.json()).toEqual(await a.json());
      expect(store.size).toBe(1);
      await get("topic=breakup&lang=hi"); // different filter = different key
      expect(store.size).toBe(2);
    });
    it("never caches authenticated or lane responses", async () => {
      const store = stubCaches();
      const r = (await get("", { authorization: "Bearer t" }))!;
      expect(r.headers.get("cache-control")).toBe("private, no-store");
      currentUid = "viewer";
      await get("lane=women", { authorization: "Bearer t" });
      expect(store.size).toBe(0);
    });
    it("does not cache errors", async () => {
      const store = stubCaches();
      await get("sort=bad");
      cfg = { hostsPublicEnabled: false };
      await get();
      expect(store.size).toBe(0);
    });
    it("cache key is order-independent and excludes lane", () => {
      const k = (s: string) => listCacheKey((parseHostList(new URLSearchParams(s)) as any).q);
      expect(k("topic=breakup,exam-ki-tension&lang=en,hi")).toBe(k("lang=hi,en&topic=exam-ki-tension,breakup"));
      expect(k("lane=women")).toBe(k(""));
    });
  });
});

describe("GET /api/hf/options", () => {
  it("is public, cached for 1 h, and has the documented shape", async () => {
    cfg = {}; // not flag-gated
    const r = (await get("", {}, "/api/hf/options"))!;
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, max-age=3600");
    const b: any = await r.json();
    expect(Object.keys(b).sort()).toEqual(["languages", "moodGroups", "priceMax", "priceMin", "styles", "topics"]);
    expect(b.topics).toHaveLength(TOPICS.length);
    expect(b.topics[0]).toEqual({ slug: "roz-thodi-baat", label: "roz thodi baat", group: "Naye dost" });
    expect(b.moodGroups).toEqual([
      { slug: "naye-dost", label: "Naye dost" }, { slug: "mann-ki-baat", label: "Mann ki baat" },
      { slug: "tension", label: "Tension" }, { slug: "zindagi-ki-baatein", label: "Zindagi ki baatein" },
    ]);
    expect(b.languages[0]).toEqual({ code: "hi", label: "Hindi" });
    expect(b.languages).toHaveLength(LANGUAGES.length);
    expect(b.styles[0]).toEqual({ slug: "warm", label: "Warm" });
    expect(b.styles).toHaveLength(STYLES.length);
    expect([b.priceMin, b.priceMax]).toEqual([5, 100]);
  });
  it("every topic belongs to a listed mood group and every language code resolves in the host-list filter", () => {
    const o = buildHfOptions();
    const groups = new Set(MOOD_GROUPS.map((g) => g.label));
    for (const t of o.topics) { expect(groups.has(t.group)).toBe(true); expect(TOPIC_SLUGS.has(t.slug)).toBe(true); }
    for (const l of o.languages) expect(parseHostList(new URLSearchParams({ lang: l.code })).ok).toBe(true);
  });
});

// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-SEARCH-FILTERS-1] GET /api/hf/search over approved intro influencers: one box (name, handle, verified social, category, language, description),
// the filters (category, lang, avail, price, verified, women), sort, paging, the flag gate and the old-build compatibility.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

let cfg: Record<string, unknown> = {};
vi.mock("./config", () => ({ readConfig: async () => cfg }));
vi.mock("../hooks", () => ({ track: async () => {}, trackException: async () => {} }));
vi.mock("../authz", () => ({ requireUser: async () => ({ uid: "u1" }), isFail: (u: any) => !!u?.error }));
vi.mock("../money", () => ({ rateLimit: async () => null }));
vi.mock("../lib/preview", () => ({ isAdminUid: () => false }));

import { hfSearchRoute } from "./hf_search";
import { parseIntroSearch, buildIntroWhere } from "../lib/hf_intro_search";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
let db: any, env: any;
const mig = (f: string) => readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8");

function makeEnv() {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, slug TEXT, status TEXT NOT NULL DEFAULT 'draft', display_name TEXT, about TEXT, tagline TEXT, price_per_min INTEGER NOT NULL DEFAULT 0,
    category TEXT, presence TEXT NOT NULL DEFAULT 'offline', call_mode TEXT NOT NULL DEFAULT 'online', avatar_id TEXT, women_lane INTEGER DEFAULT 0, languages_json TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE hf_avatars (id TEXT PRIMARY KEY, image_key TEXT);
    CREATE TABLE hf_host_media (id TEXT PRIMARY KEY, uid TEXT, kind TEXT, r2_key TEXT, status TEXT, created_at INTEGER);
    CREATE TABLE hf_user_registration (uid TEXT PRIMARY KEY, username TEXT);`);
  db.exec(mig("2026-10-19-hf-channels.sql"));
  db.exec(mig("2026-10-28-hf-intro-video-alters.sql"));
  db.exec(mig("2026-10-28-hf-intro-video-tables.sql"));
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
    run: async () => ({ meta: { changes: 0 } }),
  });
  env = { DB_META: { prepare: (q: string) => stmt(q) }, BLOSSOM_BASE_URL: "https://media.test", TOKENS: { get: async () => null, put: async () => {} } };
}

let n = 0;
interface H { uid: string; name?: string; about?: string; rate?: number; presence?: string; mode?: string; option?: "A" | "B" | null; cats?: string[]; langs?: string[]; women?: number; user?: string; approved?: number | null; status?: string; socials?: [string, string][]; poster?: boolean }
function add(h: H) {
  n++;
  const vid = "hfin_" + n.toString(16).padStart(20, "0");
  const appr = h.approved === undefined ? 1000 + n : h.approved;
  db.prepare("INSERT INTO hf_intro_videos (id, uid, r2_key, poster_key, mime, bytes, duration_ms, width, height, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(vid, h.uid, `intro-video/${h.uid}/${vid}.mp4`, h.poster === false ? null : `intro-video/${h.uid}/${vid}.jpg`, "video/mp4", 100, 12000, 720, 1280, "approved", 1, 1);
  db.prepare("INSERT INTO hf_hosts (uid, slug, status, display_name, about, price_per_min, presence, call_mode, women_lane, languages_json, categories_json, call_option, intro_video_id, intro_approved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(h.uid, "s-" + h.uid, h.status ?? "live", h.name ?? "Name " + h.uid, h.about ?? "", h.rate ?? 20, h.presence ?? "offline", h.mode ?? "online", h.women ?? 0, JSON.stringify(h.langs ?? ["hi"]), JSON.stringify(h.cats ?? ["other"]), h.option === null ? null : h.option ?? "A", vid, appr);
  if (h.user) db.prepare("INSERT INTO hf_user_registration (uid, username) VALUES (?,?)").run(h.uid, h.user);
  for (const [platform, handle] of h.socials ?? [])
    db.prepare("INSERT INTO hf_channels (id, host_uid, platform, handle, followers, status, verified_at, created_at, platform_user_id, provider_ref, url) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(`ch_${h.uid}_${platform}`, h.uid, platform, handle, 1000, "approved", 1, 1, `pu_${h.uid}${platform}`, `${platform}-oauth`, `https://example.com/${handle}`);
}
const get = async (qs = "") => {
  const r = await hfSearchRoute(new Request("https://x/api/hf/search" + qs), env, "/api/hf/search");
  return { status: r.status, ...(await r.json()) };
};
const slugs = (j: any) => j.items.map((i: any) => i.host.slug);

beforeEach(() => {
  makeEnv(); n = 0;
  cfg = { hfReelsEnabled: true, hfIntroReelsEnabled: true };
  add({ uid: "meera", name: "Meera Joshi", about: "I teach Vedic astrology and kundli reading", rate: 30, presence: "online", option: "B", cats: ["astrology", "spirituality"], langs: ["hi", "en"], user: "meera_jyotish", socials: [["youtube", "@MeeraTalks"], ["instagram", "meera.insta"]] });
  add({ uid: "kabir", name: "Kabir Rao", about: "Stand up comedy and roasts", rate: 10, presence: "offline", option: "A", cats: ["comedy"], langs: ["Hindi"], socials: [["facebook", "kabirfun"]] });
  add({ uid: "anu", name: "Anu Iyer", about: "Carnatic music lessons", rate: 50, presence: "busy", option: "B", cats: ["music", "women_to_women"], langs: ["ta"], women: 1, socials: [["youtube", "anusings"]] });
  add({ uid: "late", name: "Late Joiner", about: "Gaming tips", rate: 20, presence: "online", option: "B", cats: ["gaming"], langs: ["en"] });
  add({ uid: "unapproved", name: "Not Approved", approved: null, presence: "online", option: "B" });
  add({ uid: "draft", name: "Draft Host", status: "draft" });
  add({ uid: "legacy", name: "No Option", option: null });
});

describe("listing", () => {
  it("lists only approved intro influencers, offline ones included, with the card fields", async () => {
    const j = await get();
    expect(j).toMatchObject({ status: 200, ok: true, intro: true, total: 4, nextOffset: null });
    expect(slugs(j).sort()).toEqual(["s-anu", "s-kabir", "s-late", "s-meera"]);
    const k = j.items.find((i: any) => i.host.slug === "s-kabir");
    expect(k).toMatchObject({ kind: "intro", callState: "appointments", callOption: "A", greenTick: true, ratePaise: 1000 });
    expect(k.posterUrl).toMatch(/intro-video/);
    expect(k.categories).toEqual([{ id: "comedy", label: "Comedy" }]);
    expect(k.languages).toEqual(["Hindi"]);
    expect(k.socials[0]).toMatchObject({ platform: "facebook" });
    const m = j.items.find((i: any) => i.host.slug === "s-meera");
    expect(m.languages).toEqual(["Hindi", "English"]);
    expect(m.socials.map((s: any) => s.platform)).toEqual(["youtube", "instagram"]);
    // old builds still get online[] / offline[]
    expect(j.online.map((h: any) => h.slug).sort()).toEqual(["s-anu", "s-late", "s-meera"]);
    expect(j.offline.map((h: any) => h.slug)).toEqual(["s-kabir"]);
    expect(j.offline[0]).toMatchObject({ name: "Kabir Rao", ratePaise: 1000, presence: "offline" });
  });

  it("hfReelsEnabled off is still not_enabled", async () => {
    cfg = { hfReelsEnabled: false, hfIntroReelsEnabled: true };
    expect((await get()).status).toBe(404);
  });
});

describe("one search box", () => {
  it.each([
    ["name", "?q=meera", ["s-meera"]],
    ["name, case and partial", "?q=KAB", ["s-kabir"]],
    ["@handle (registration username)", "?q=@meera_jyotish", ["s-meera"]],
    ["verified YouTube handle", "?q=MeeraTalks", ["s-meera"]],
    ["verified Instagram handle", "?q=meera.insta", ["s-meera"]],
    ["verified Facebook handle", "?q=kabirfun", ["s-kabir"]],
    ["platform word", "?q=facebook", ["s-kabir"]],
    ["category label", "?q=comedy", ["s-kabir"]],
    ["category id with underscore word", "?q=women", ["s-anu"]],
    ["language name", "?q=tamil", ["s-anu"]],
    ["language stored as a code", "?q=hindi", ["s-kabir", "s-meera"]],
    ["description word", "?q=kundli", ["s-meera"]],
    ["two words must both match", "?q=vedic%20english", ["s-meera"]],
    ["nothing", "?q=zzzz", []],
  ])("matches %s", async (_n, qs, want) => {
    expect(slugs(await get(qs)).sort()).toEqual([...want].sort());
  });

  it("a wildcard is not a wildcard", async () => {
    expect(slugs(await get("?q=%25"))).toEqual([]);
  });

  it("an unverified social handle is not searchable", async () => {
    db.prepare("UPDATE hf_channels SET provider_ref='bio-code' WHERE host_uid='kabir'").run();
    expect(slugs(await get("?q=kabirfun"))).toEqual([]);
  });
});

describe("filters", () => {
  it("category (any-of) and unknown ids are ignored", async () => {
    expect(slugs(await get("?category=comedy,gaming")).sort()).toEqual(["s-kabir", "s-late"]);
    expect(slugs(await get("?category=astrology")).sort()).toEqual(["s-meera"]);
    expect((await get("?category=nonsense")).total).toBe(4);
  });
  it("language by code or name", async () => {
    expect(slugs(await get("?lang=ta"))).toEqual(["s-anu"]);
    expect(slugs(await get("?lang=English")).sort()).toEqual(["s-late", "s-meera"]);
    expect(slugs(await get("?lang=hi")).sort()).toEqual(["s-kabir", "s-meera"]); // Kabir stored the name, Meera the code
  });
  it("availability: online now / takes bookings", async () => {
    expect(slugs(await get("?avail=online")).sort()).toEqual(["s-anu", "s-late", "s-meera"]);
    expect(slugs(await get("?avail=bookings"))).toEqual(["s-kabir"]);
    db.prepare("UPDATE hf_hosts SET call_mode='bookings_only' WHERE uid='late'").run();
    expect(slugs(await get("?avail=bookings")).sort()).toEqual(["s-kabir", "s-late"]);
    expect(slugs(await get("?avail=online")).sort()).toEqual(["s-anu", "s-meera"]);
  });
  it("price per minute range, inclusive; reversed bounds are swapped", async () => {
    expect(slugs(await get("?priceMax=20")).sort()).toEqual(["s-kabir", "s-late"]);
    expect(slugs(await get("?priceMin=30")).sort()).toEqual(["s-anu", "s-meera"]);
    expect(slugs(await get("?priceMin=20&priceMax=30")).sort()).toEqual(["s-late", "s-meera"]);
    expect(slugs(await get("?priceMin=30&priceMax=20")).sort()).toEqual(["s-late", "s-meera"]);
  });
  it("verified on (any-of, login-proven only)", async () => {
    expect(slugs(await get("?verified=youtube")).sort()).toEqual(["s-anu", "s-meera"]);
    expect(slugs(await get("?verified=instagram"))).toEqual(["s-meera"]);
    expect(slugs(await get("?verified=facebook,instagram")).sort()).toEqual(["s-kabir", "s-meera"]);
    db.prepare("UPDATE hf_channels SET provider_ref='treg' WHERE host_uid='anu'").run();
    expect(slugs(await get("?verified=youtube"))).toEqual(["s-meera"]);
  });
  it("women-only", async () => {
    expect(slugs(await get("?women=1"))).toEqual(["s-anu"]);
  });
  it("filters combine (AND across filters)", async () => {
    expect(slugs(await get("?verified=youtube&avail=online&priceMax=40"))).toEqual(["s-meera"]);
    expect(slugs(await get("?q=music&women=1&lang=ta"))).toEqual(["s-anu"]);
  });
  it("there is no gender filter: gender / lgbtq / kyc params change nothing", async () => {
    expect((await get("?gender=female&space=lgbtq&kyc=1&topic=x")).total).toBe(4);
  });
  it("old app params: platform=youtube behaves as verified, space=women as women", async () => {
    expect(slugs(await get("?platform=youtube")).sort()).toEqual(["s-anu", "s-meera"]);
    expect(slugs(await get("?space=women"))).toEqual(["s-anu"]);
  });
});

describe("sort and paging", () => {
  it("recommended = online first, then busy, then offline", async () => {
    const j = await get();
    expect(j.items.map((i: any) => i.host.presence)).toEqual(["online", "online", "busy", "offline"]);
    expect(slugs(j)[0]).toBe("s-meera"); // more verified socials than "late"
  });
  it("online first sorts by name inside a group", async () => {
    expect(slugs(await get("?sort=online"))).toEqual(["s-late", "s-meera", "s-anu", "s-kabir"]);
  });
  it("price low to high", async () => {
    expect(slugs(await get("?sort=price_low"))).toEqual(["s-kabir", "s-late", "s-meera", "s-anu"]);
  });
  it("newest = latest approval first", async () => {
    expect(slugs(await get("?sort=newest"))).toEqual(["s-late", "s-anu", "s-kabir", "s-meera"]);
  });
  it("unknown sort falls back to recommended; limit / offset page the result with a total", async () => {
    expect(slugs(await get("?sort=bogus"))).toEqual(slugs(await get()));
    const p1 = await get("?sort=newest&limit=3");
    expect(p1).toMatchObject({ total: 4, nextOffset: 3 });
    expect(slugs(p1)).toHaveLength(3);
    const p2 = await get("?sort=newest&limit=3&offset=3");
    expect(slugs(p2)).toEqual(["s-meera"]);
    expect(p2.nextOffset).toBeNull();
  });
});

describe("parser", () => {
  it("clamps and sanitises", () => {
    const f = parseIntroSearch(new URLSearchParams("q=%20%40Hi%20there%20&category=astrology,bad&lang=hi,xx&avail=zzz&priceMin=-5&priceMax=abc&verified=youtube,twitter&limit=999&offset=-3"));
    expect(f).toMatchObject({ words: ["hi", "there"], categories: ["astrology"], langs: ["hi"], avail: "", priceMin: null, priceMax: null, verified: ["youtube"], limit: 30, offset: 0 });
  });
  it("stays well under D1's 100 bound values even for a one-letter query", () => {
    const f = parseIntroSearch(new URLSearchParams("q=a%20e%20i%20o%20a%20e&category=astrology,teacher,traveller,cook&lang=hi,en,ta,te,kn,ml&verified=youtube,instagram,facebook&priceMin=1&priceMax=9"));
    expect(buildIntroWhere(f).binds.length).toBeLessThan(100);
  });
});

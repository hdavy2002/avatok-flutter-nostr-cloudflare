// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-WIRE-3] influencer Channels: flag, auth, own data only, providers (mocked fetch), ownership code, follower minimum, one channel per person.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

let cfg: Record<string, unknown> = {};
let authFail: { status: number; error: string } | null = null;
vi.mock("./config", () => ({ readConfig: async () => cfg }));
vi.mock("../hooks", () => ({ track: async () => {}, trackUser: async () => {}, trackException: async () => {} }));
vi.mock("../lib/identity", () => ({ emailFor: async () => null }));
vi.mock("../authz", () => ({
  requireUser: async (req: Request) => authFail ?? { uid: req.headers.get("x-test-uid") ?? "u1" },
  isFail: (u: any) => !!u?.error,
}));

import { hfChannelsRoute, recheckAllChannels, MAX_CHANNELS } from "./hf_channels";
import { parseInstagramHandle, parseYoutubeRef, bioHasCode, makeVerifyCode } from "../lib/hf_channel_providers";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
let db: any, env: any, kv: Map<string, string>;

// What the fake providers answer. ytItems = YouTube `items`; ig = treg body; *Status = HTTP status.
let yt: { status: number; items: any[] };
let ig: { status: number; body: any };
let seen: { url: string; headers: Record<string, string> }[];

const ytChannel = (id: string, subs: number, description = "", extra: any = {}) =>
  ({ id, snippet: { customUrl: "@maya", description, title: "Maya" }, statistics: { subscriberCount: String(subs), hiddenSubscriberCount: false, ...extra } });
const igBody = (id: string, followers: number, bio = "", extra: any = {}) =>
  ({ success: true, data: { user: { id, username: "maya.reels", biography: bio, edge_followed_by: { count: followers }, is_private: false, ...extra } } });

function makeEnv(withKeys = true) {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'draft', display_name TEXT, slug TEXT, price_per_min INTEGER NOT NULL DEFAULT 20, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX idx_hf_hosts_slug ON hf_hosts(slug);`);
  db.exec(readFileSync(new URL("../../migrations/2026-10-19-hf-channels.sql", import.meta.url), "utf8"));
  kv = new Map();
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  env = {
    DB_META: { prepare: (q: string) => stmt(q) },
    TOKENS: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); }, delete: async (k: string) => { kv.delete(k); } },
    ...(withKeys ? { YOUTUBE_API_KEY: "yt-secret-key", TREG_API_KEY: "trg_live_secret" } : {}),
  };
}

beforeEach(() => {
  makeEnv();
  cfg = { hfChannelsEnabled: true, hfInfluencerMinFollowers: 10 };
  authFail = null;
  yt = { status: 200, items: [ytChannel("UC1234567890123456789012", 500)] };
  ig = { status: 200, body: igBody("1783", 500) };
  seen = [];
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    seen.push({ url: String(url), headers: init.headers ?? {} });
    if (String(url).startsWith("https://www.googleapis.com/")) return new Response(JSON.stringify({ items: yt.items }), { status: yt.status });
    if (String(url).startsWith("https://treg.to/")) return new Response(JSON.stringify(ig.body), { status: ig.status });
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const CONSENT = { version: "ch-1", embeds: true, counts: true, ownChannel: true };
const call = (method: string, path = "/api/hf/channels", body?: unknown, uid = "u1") =>
  hfChannelsRoute(new Request("https://x" + path, { method, headers: { "x-test-uid": uid, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env, path);
const add = (platform = "youtube", handleOrUrl = "@maya", uid = "u1", consent: any = CONSENT) =>
  call("POST", "/api/hf/channels", { platform, handleOrUrl, consent }, uid);
const hostStatus = (uid = "u1") => db.prepare("SELECT status FROM hf_hosts WHERE uid=?").get(uid)?.status ?? null;

describe("hf channels: gates", () => {
  it("is 404 not_enabled when the flag is off, before auth", async () => {
    cfg = {};
    authFail = { status: 401, error: "auth" };
    for (const [m, p] of [["GET", "/api/hf/channels"], ["POST", "/api/hf/channels"], ["DELETE", "/api/hf/channels/hfch_abcdefgh1234"], ["POST", "/api/hf/channels/hfch_abcdefgh1234/check"]]) {
      const r = await call(m, p, m === "POST" ? {} : undefined);
      expect(r.status).toBe(404);
      expect((await r.json()).error).toBe("not_enabled");
    }
  });

  it("is 401 when signed out", async () => {
    authFail = { status: 401, error: "auth: missing" };
    expect((await call("GET")).status).toBe(401);
    expect((await add()).status).toBe(401);
  });

  it("ignores other paths and rejects other methods", async () => {
    expect(await call("GET", "/api/hf/other")).toBeNull();
    expect((await call("DELETE")).status).toBe(405);
    expect((await call("GET", "/api/hf/channels/hfch_abcdefgh1234/check")).status).toBe(405);
  });
});

describe("hf channels: connecting", () => {
  it("rejects facebook (coming soon), unknown platforms, missing consent and bad handles", async () => {
    let r = await add("facebook");
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("platform_unsupported");
    expect((await add("tiktok")).status).toBe(400);
    r = await add("youtube", "@maya", "u1", { ...CONSENT, ownChannel: false });
    expect((await r.json()).error).toBe("consent_required");
    r = await add("youtube", "@maya", "u1", { embeds: true, counts: true, ownChannel: true });
    expect((await r.json()).error).toBe("consent_required"); // version missing
    r = await add("instagram", "not a handle!!");
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_field");
    r = await add("youtube", "https://example.com/x");
    expect((await r.json()).field).toBe("handleOrUrl");
    expect(seen.length).toBe(0); // nothing reached a provider
  });

  it("says provider_not_configured when the secret is missing", async () => {
    makeEnv(false);
    for (const [pl, h] of [["youtube", "@maya"], ["instagram", "maya.reels"]]) {
      const r = await add(pl, h);
      expect(r.status).toBe(503);
      expect((await r.json()).error).toBe("provider_not_configured");
    }
    expect(db.prepare("SELECT COUNT(*) c FROM hf_channels").get().c).toBe(0);
  });

  it("a provider outage is provider_unavailable and a missing channel is channel_not_found", async () => {
    yt = { status: 500, items: [] };
    expect((await (await add()).json()).error).toBe("provider_unavailable");
    yt = { status: 200, items: [] };
    const r = await add();
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("channel_not_found");
    ig = { status: 200, body: { success: true, error: "not_found", errorStatus: 404, data: { user: null } } };
    expect((await (await add("instagram", "ghost")).json()).error).toBe("channel_not_found");
  });

  it("creates a pending channel with a one-time code and a pending_check host", async () => {
    const r = await add("youtube", "https://www.youtube.com/@maya");
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.verifyCode).toMatch(/^HF-[2-9A-HJ-NP-Z]{5}$/);
    expect(b.instructions).toContain(b.verifyCode);
    expect(b.channel.state).toBe("checking");
    expect(b.channel.needsCode).toBe(true);
    expect(b.minFollowers).toBe(10);
    expect(hostStatus()).toBe("pending_check");
    const row = db.prepare("SELECT * FROM hf_channels").get();
    expect(row.consent_version).toBe("ch-1");
    expect(row.consent_at).toBeGreaterThan(0);
    expect(row.verified_at).toBeNull();
    // the secret key never leaves the server
    expect(JSON.stringify(b)).not.toContain("yt-secret-key");
    // adding the same channel again shows the SAME code, not a second row
    const again = await (await add("youtube", "@maya")).json();
    expect(again.verifyCode).toBe(b.verifyCode);
    expect(db.prepare("SELECT COUNT(*) c FROM hf_channels").get().c).toBe(1);
  });

  it("limits the number of connected channels", async () => {
    for (let i = 0; i < MAX_CHANNELS; i++) {
      yt = { status: 200, items: [ytChannel("UC" + String(i).padStart(22, "0"), 50)] };
      expect((await add("youtube", "@maya" + i)).status).toBe(200);
    }
    yt = { status: 200, items: [ytChannel("UC" + "9".repeat(22), 50)] };
    const r = await add("youtube", "@onemore");
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("limit_reached");
  });
});

describe("hf channels: checking ownership and followers", () => {
  it("code missing -> not approved, retry allowed", async () => {
    const { channel } = await (await add()).json();
    const r = await call("POST", `/api/hf/channels/${channel.id}/check`);
    const b = await r.json();
    expect(r.status).toBe(200);
    expect(b.result).toBe("code_missing");
    expect(b.channel.state).toBe("checking");
    expect(b.qualified).toBe(false);
    expect(hostStatus()).toBe("pending_check");
    expect(db.prepare("SELECT verified_at FROM hf_channels").get().verified_at).toBeNull();
    const again = await call("POST", `/api/hf/channels/${channel.id}/check`);
    expect((await again.json()).result).toBe("code_missing");
  });

  it("YouTube: code present but fewer than 10 subscribers -> verified, not approved", async () => {
    const { channel, verifyCode } = await (await add()).json();
    yt = { status: 200, items: [ytChannel("UC1234567890123456789012", 9, `Hello! ${verifyCode.toLowerCase()} bye`)] };
    const b = await (await call("POST", `/api/hf/channels/${channel.id}/check`)).json();
    expect(b.result).toBe("needs_followers");
    expect(b.channel.state).toBe("needs_followers");
    expect(b.channel.verified).toBe(true);
    expect(b.qualified).toBe(false);
    expect(hostStatus()).toBe("pending_check");
  });

  it("YouTube: code present and 10 subscribers -> approved and the host is approved", async () => {
    const { channel, verifyCode } = await (await add()).json();
    yt = { status: 200, items: [ytChannel("UC1234567890123456789012", 10, `my channel ${verifyCode}`)] };
    const b = await (await call("POST", `/api/hf/channels/${channel.id}/check`)).json();
    expect(b.result).toBe("approved");
    expect(b.channel.state).toBe("approved");
    expect(b.channel.verifyCode).toBeUndefined();
    expect(b.qualified).toBe(true);
    expect(b.hostStatus).toBe("approved");
    expect(hostStatus()).toBe("approved");
    // [HF-WIRE-18] HF-REEL-37: a new influencer starts at Rs 5/min, not the table default of 20
    expect(db.prepare("SELECT price_per_min AS p FROM hf_hosts WHERE uid='u1'").get().p).toBe(5);
    const list = await (await call("GET")).json();
    expect(list.qualified).toBe(true);
    expect(list.channels[0].followers).toBe(10);
  });

  it("the follower minimum comes from config", async () => {
    cfg = { hfChannelsEnabled: true, hfInfluencerMinFollowers: 1000 };
    const { channel, verifyCode, minFollowers } = await (await add()).json();
    expect(minFollowers).toBe(1000);
    yt = { status: 200, items: [ytChannel("UC1234567890123456789012", 500, verifyCode)] };
    const b = await (await call("POST", `/api/hf/channels/${channel.id}/check`)).json();
    expect(b.result).toBe("needs_followers");
    expect(b.message).toContain("1000");
  });

  it("Instagram goes through treg with the token header, and the code is read from the bio", async () => {
    const { channel, verifyCode } = await (await add("instagram", "@Maya.Reels")).json();
    const lookup = seen.find((s) => s.url.startsWith("https://treg.to/call/"));
    expect(lookup.url).toContain("scrapecreators.instagram.user.profile");
    expect(lookup.url).toContain("handle=maya.reels");
    expect(lookup.url).not.toContain("cache_max_age"); // ownership checks are never cached
    expect(lookup.headers["X-Treg-Token"]).toBe("trg_live_secret");
    ig = { status: 200, body: igBody("1783", 42, `Reels | ${verifyCode}`) };
    const b = await (await call("POST", `/api/hf/channels/${channel.id}/check`)).json();
    expect(b.result).toBe("approved");
    expect(hostStatus()).toBe("approved");
    expect(JSON.stringify(b)).not.toContain("trg_live_secret");
  });

  it("a private Instagram account is refused with a clear message", async () => {
    ig = { status: 200, body: igBody("1783", 500, "", { is_private: true }) };
    const r = await add("instagram", "maya.reels");
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("channel_private");
  });

  it("retries after a provider outage keep the channel pending", async () => {
    const { channel } = await (await add()).json();
    yt = { status: 503, items: [] };
    const r = await call("POST", `/api/hf/channels/${channel.id}/check`);
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe("provider_unavailable");
    expect(db.prepare("SELECT status FROM hf_channels").get().status).toBe("pending");
  });
});

describe("hf channels: one channel, one person; own data only", () => {
  async function approve(uid: string, platform = "youtube") {
    const { channel, verifyCode } = await (await add(platform, platform === "youtube" ? "@maya" : "maya.reels", uid)).json();
    yt = { status: 200, items: [ytChannel("UC1234567890123456789012", 50, verifyCode)] };
    ig = { status: 200, body: igBody("1783", 50, verifyCode) };
    await call("POST", `/api/hf/channels/${channel.id}/check`, undefined, uid);
    return channel.id;
  }

  it("another person cannot claim a verified channel (409 at connect)", async () => {
    await approve("u1");
    yt = { status: 200, items: [ytChannel("UC1234567890123456789012", 50)] };
    const r = await add("youtube", "@maya", "u2");
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("channel_claimed");
    expect(db.prepare("SELECT COUNT(*) c FROM hf_channels WHERE host_uid='u2'").get().c).toBe(0);
    expect(hostStatus("u2")).toBeNull();
  });

  it("a second person who was pending cannot verify once the first has (409 at check)", async () => {
    yt = { status: 200, items: [ytChannel("UC1234567890123456789012", 50)] };
    const c1 = (await (await add("youtube", "@maya", "u1")).json());
    const c2 = (await (await add("youtube", "@maya", "u2")).json());
    yt = { status: 200, items: [ytChannel("UC1234567890123456789012", 50, c1.verifyCode + " " + c2.verifyCode)] };
    expect((await (await call("POST", `/api/hf/channels/${c1.channel.id}/check`, undefined, "u1")).json()).result).toBe("approved");
    const r = await call("POST", `/api/hf/channels/${c2.channel.id}/check`, undefined, "u2");
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("channel_claimed");
    expect(hostStatus("u2")).toBe("pending_check");
  });

  it("the same person cannot connect a verified channel twice", async () => {
    await approve("u1");
    const r = await add("youtube", "@maya", "u1");
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("already_connected");
  });

  it("returns only the caller's channels and 404s on someone else's id", async () => {
    const id = await approve("u1");
    expect((await (await call("GET", "/api/hf/channels", undefined, "u2")).json()).channels).toEqual([]);
    for (const [m, p] of [["POST", `/api/hf/channels/${id}/check`], ["POST", `/api/hf/channels/${id}/resync`], ["DELETE", `/api/hf/channels/${id}`]]) {
      const r = await call(m, p, undefined, "u2");
      expect(r.status).toBe(404);
    }
    expect(db.prepare("SELECT status FROM hf_channels WHERE id=?").get(id).status).toBe("approved");
    const mine = await (await call("GET")).json();
    expect(mine.channels.length).toBe(1);
    expect(JSON.stringify(mine)).not.toContain("host_uid");
  });

  it("removing the only approved channel disconnects it, drops the host to pending_check and frees the channel", async () => {
    const id = await approve("u1");
    expect(hostStatus()).toBe("approved");
    const r = await call("DELETE", `/api/hf/channels/${id}`);
    expect((await r.json()).channel.state).toBe("disconnected");
    expect(hostStatus()).toBe("pending_check");
    expect((await call("DELETE", `/api/hf/channels/${id}`)).status).toBe(200); // idempotent
    expect((await call("POST", `/api/hf/channels/${id}/check`)).status).toBe(409);
    // now someone else may connect it
    yt = { status: 200, items: [ytChannel("UC1234567890123456789012", 50)] };
    expect((await add("youtube", "@maya", "u2")).status).toBe(200);
  });

  it("never overwrites the status of a web-onboarding host", async () => {
    db.prepare("INSERT INTO hf_hosts (uid,status,created_at,updated_at) VALUES ('u1','live',1,1)").run();
    await approve("u1");
    expect(hostStatus()).toBe("live");
  });

  // [HF-WIRE-10] approval must leave a slug or the feed and profile skip the influencer.
  const slugOf = (uid: string) => db.prepare("SELECT slug FROM hf_hosts WHERE uid=?").get(uid)?.slug ?? null;
  it("approval assigns a unique slug from the channel handle and keeps it on re-check", async () => {
    await approve("u1");
    const s1 = slugOf("u1");
    expect(s1).toMatch(/^[a-z0-9]{1,16}-[a-z0-9]{4}$/);
    const id = db.prepare("SELECT id FROM hf_channels WHERE host_uid='u1'").get().id;
    await call("POST", `/api/hf/channels/${id}/check`, undefined, "u1");
    expect(slugOf("u1")).toBe(s1);
  });
  it("never overwrites an existing slug", async () => {
    db.prepare("INSERT INTO hf_hosts (uid,status,display_name,slug,created_at,updated_at) VALUES ('u2','live','Asha K','asha-keep',1,1)").run();
    await approve("u2");
    expect(slugOf("u2")).toBe("asha-keep");
  });
  it("uses display_name when set and heals a live host without a slug", async () => {
    db.prepare("INSERT INTO hf_hosts (uid,status,display_name,created_at,updated_at) VALUES ('u3','live','Ravi Kumar',1,1)").run();
    await approve("u3");
    expect(slugOf("u3")).toMatch(/^ravi-[a-z0-9]{4}$/);
  });
});

describe("hf channels: resync and the daily re-check", () => {
  it("resync refreshes followers without asking for the code again and can drop below the minimum", async () => {
    const { channel, verifyCode } = await (await add()).json();
    yt = { status: 200, items: [ytChannel("UC1234567890123456789012", 50, verifyCode)] };
    await call("POST", `/api/hf/channels/${channel.id}/check`);
    expect(hostStatus()).toBe("approved");
    yt = { status: 200, items: [ytChannel("UC1234567890123456789012", 4, "code removed from bio")] };
    const b = await (await call("POST", `/api/hf/channels/${channel.id}/resync`)).json();
    expect(b.result).toBe("needs_followers");
    expect(b.channel.followers).toBe(4);
    expect(b.qualified).toBe(false);
    expect(hostStatus()).toBe("pending_check");
  });

  it("recheckAllChannels only touches stale verified channels, demotes a host with none left, and is a no-op when the flag is off", async () => {
    const { channel, verifyCode } = await (await add()).json();
    yt = { status: 200, items: [ytChannel("UC1234567890123456789012", 50, verifyCode)] };
    await call("POST", `/api/hf/channels/${channel.id}/check`);
    // fresh: not touched
    expect(await recheckAllChannels(env)).toEqual({ scanned: 0, updated: 0, failed: 0, demoted: 0 });
    db.prepare("UPDATE hf_channels SET last_sync_at = ?").run(Date.now() - 25 * 3600 * 1000);
    yt = { status: 200, items: [ytChannel("UC1234567890123456789012", 2)] };
    cfg = {};
    expect((await recheckAllChannels(env)).scanned).toBe(0);
    cfg = { hfChannelsEnabled: true, hfInfluencerMinFollowers: 10 };
    const out = await recheckAllChannels(env);
    expect(out).toEqual({ scanned: 1, updated: 1, failed: 0, demoted: 1 });
    expect(hostStatus()).toBe("pending_check");
    expect(db.prepare("SELECT status, followers FROM hf_channels").get()).toEqual({ status: "rejected", followers: 2 });
  });
});

describe("provider helpers", () => {
  it("parses handles and URLs", () => {
    expect(parseInstagramHandle("https://www.instagram.com/Maya.Reels/?hl=en")).toBe("maya.reels");
    expect(parseInstagramHandle("@maya_1")).toBe("maya_1");
    expect(() => parseInstagramHandle("instagram.com/p/abc")).toThrow();
    expect(() => parseInstagramHandle("a b")).toThrow();
    expect(parseYoutubeRef("https://youtube.com/@Maya")).toEqual({ kind: "handle", value: "@Maya" });
    expect(parseYoutubeRef("https://www.youtube.com/channel/UC1234567890123456789012")).toEqual({ kind: "id", value: "UC1234567890123456789012" });
    expect(parseYoutubeRef("maya")).toEqual({ kind: "handle", value: "@maya" });
    expect(() => parseYoutubeRef("https://youtube.com/watch?v=abc")).toThrow();
  });
  it("codes are readable and matched loosely", () => {
    for (let i = 0; i < 50; i++) expect(makeVerifyCode()).toMatch(/^HF-[2-9A-HJ-NP-Z]{5}$/);
    expect(bioHasCode("hello hf 7k3q9 !", "HF-7K3Q9")).toBe(true);
    expect(bioHasCode("hello", "HF-7K3Q9")).toBe(false);
    expect(bioHasCode("anything", "")).toBe(false);
  });
});

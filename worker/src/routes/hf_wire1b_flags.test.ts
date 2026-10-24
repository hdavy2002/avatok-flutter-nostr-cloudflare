// @ts-nocheck -- response bodies are read as untyped JSON
// [HF-WIRE-1B] Reels-app flags: declared in DEFAULTS, public in /api/config, flippable after deploy (the fake-flag rule).
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../authz", () => ({
  requireUser: async (req: Request) => ({ uid: req.headers.get("x-test-uid") ?? "admin" }),
  isFail: (u: any) => !!u?.error,
}));

import { getConfig, putConfig, readConfig, bustConfigMemo } from "./config";

let store: Map<string, unknown>;
const env: any = {
  ADMIN_UIDS: "admin",
  TOKENS: {
    get: async (k: string, t?: string) => { const v = store.get(k); return v === undefined ? null : t === "json" ? JSON.parse(JSON.stringify(v)) : String(v); },
    put: async (k: string, v: string) => { store.set(k, JSON.parse(v)); },
    delete: async (k: string) => { store.delete(k); },
  },
};
const put = (body: unknown) =>
  putConfig(new Request("https://x/api/admin/config", { method: "PUT", headers: { "content-type": "application/json", "x-test-uid": "admin" }, body: JSON.stringify(body) }), env);

beforeEach(() => { store = new Map(); bustConfigMemo(); });

describe("HF reels flags [HF-WIRE-1B]", () => {
  it("defaults: everything dark except demo influencers; min followers 20; all public", async () => {
    const pub = await (await getConfig(env)).json();
    for (const k of ["hfReelsEnabled", "hfChannelsEnabled", "hfFavouritesEnabled", "hfInvitesEnabled", "hfPayoutsEnabled"]) expect(pub[k]).toBe(false);
    expect(pub.hfDemoInfluencersVisible).toBe(true);
    expect(pub.hfInfluencerMinFollowers).toBe(20);
    const srv = await readConfig(env);
    expect(srv.hfReelsEnabled).toBe(false);
    expect(srv.hfInfluencerMinFollowers).toBe(20);
  });
  it("can be flipped after deploy; the follower count stays a number", async () => {
    const r = await put({ hfReelsEnabled: true, hfDemoInfluencersVisible: false, hfInfluencerMinFollowers: 1000 });
    expect(r.status).toBe(200);
    bustConfigMemo();
    const pub = await (await getConfig(env)).json();
    expect(pub.hfReelsEnabled).toBe(true);
    expect(pub.hfDemoInfluencersVisible).toBe(false);
    expect(pub.hfInfluencerMinFollowers).toBe(1000);
  });
  it("refuses a text or negative follower minimum", async () => {
    expect((await put({ hfInfluencerMinFollowers: "10" })).status).toBe(400);
    expect((await put({ hfInfluencerMinFollowers: -1 })).status).toBe(400);
  });
});

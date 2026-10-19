// @ts-nocheck -- node:sqlite D1 shim
// [HF-WIRE-5] Presence usable by the reels app (hfReelsEnabled), online count, Notify me de-dupe.
import { describe, it, expect, beforeEach, vi } from "vitest";
const st = vi.hoisted(() => ({ uid: "h1" as string | null, cfg: {} as Record<string, unknown>, notified: [] as string[] }));
vi.mock("../authz", () => ({ requireUser: async () => (st.uid ? { uid: st.uid } : { error: "unauthorized", status: 401 }), isFail: (x: any) => x.error !== undefined }));
vi.mock("./config", () => ({ readConfig: async () => st.cfg }));
vi.mock("../hooks", () => ({ track: async () => undefined, trackException: async () => undefined }));
vi.mock("../money", () => ({ rateLimit: async () => null }));
vi.mock("./wallet", () => ({ walletOp: async () => ({ status: 200, body: {} }) }));
vi.mock("../lib/hf_exit", () => ({ isClosing: async () => false, forceHostOffline: async () => undefined, CLOSING_MESSAGE: "x" }));
vi.mock("../lib/whatsapp_notify", () => ({ verifiedWhatsAppNumber: async () => "+919999999999" }));
vi.mock("../lib/hf_reviews", () => ({ hfCallsOn: async () => st.cfg.hfCallsEnabled === true }));
vi.mock("../lib/hf_notify", async (orig) => ({ ...(await orig()), notifyHostOnline: async (_e: any, _c: any, uid: string) => { st.notified.push(uid); } }));

import { makeDb } from "../lib/hf_token_d1_shim";
import { hfCallsRoute } from "./hf_calls";
import { hfNotifyRoute } from "../lib/hf_notify";
import { hfOnlineCountRoute } from "./hf_online_count";

let env: any;
const MIGS = ["2026-10-09-hf-hosts.sql", "2026-10-09-hf-presence.sql", "2026-10-11-hf-presence-nudge.sql", "2026-10-09-hf-calls.sql", "2026-10-09-hf-reviews.sql"];
const host = (uid: string, presence = "offline", status = "live") =>
  env.DB_META._raw.prepare("INSERT INTO hf_hosts (uid,slug,status,display_name,presence,created_at,updated_at) VALUES (?,?,?,'Priya Rao',?,1,1)").run(uid, `host-${uid}`, status, presence);
const put = (online: any) => hfCallsRoute(new Request("https://api.test/api/hosts/me/presence", { method: "PUT", body: JSON.stringify({ online }) }), env, "/api/hosts/me/presence");
const get = () => hfCallsRoute(new Request("https://api.test/api/hosts/me/presence"), env, "/api/hosts/me/presence");
const presenceOf = (uid: string) => env.DB_META._raw.prepare("SELECT presence FROM hf_hosts WHERE uid=?").get(uid).presence;

beforeEach(() => {
  st.uid = "h1"; st.cfg = { hfReelsEnabled: true }; st.notified = [];
  env = { DB_META: makeDb(MIGS, { alters: true }) };
  try { env.DB_META._raw.exec("ALTER TABLE hf_hosts ADD COLUMN presence_call_id TEXT"); } catch {}
  host("h1");
});

describe("presence PUT/GET", () => {
  it("401 when signed out", async () => { st.uid = null; expect((await put(true)).status).toBe(401); });
  it("404 when neither calls nor reels is open", async () => { st.cfg = {}; expect((await put(true)).status).toBe(404); });
  it("works with only hfReelsEnabled, and with only hfCallsEnabled", async () => {
    expect(await (await put(true)).json()).toMatchObject({ ok: true, presence: "online" });
    st.cfg = { hfCallsEnabled: true };
    expect(await (await put(false)).json()).toMatchObject({ ok: true, presence: "offline" });
  });
  it("only touches the caller's own host row", async () => {
    host("h2");
    await put(true);
    expect(presenceOf("h1")).toBe("online");
    expect(presenceOf("h2")).toBe("offline");
  });
  it("a non-host account cannot set presence", async () => { st.uid = "fan"; expect((await put(true)).status).toBe(409); });
  it("busy is server-owned: the client cannot set it, and going online keeps a live call busy", async () => {
    expect((await put("busy")).status).toBe(400);
    env.DB_META._raw.prepare("UPDATE hf_hosts SET presence='busy', presence_call_id='call_x' WHERE uid='h1'").run();
    expect(await (await put(true)).json()).toMatchObject({ presence: "busy" });
    expect(await (await get()).json()).toMatchObject({ presence: "busy" });
    expect(st.notified).toEqual([]); // busy is not an offline->online transition
  });
  it("triggers Notify me only on the offline -> online transition", async () => {
    await put(true); await put(true);
    expect(st.notified).toEqual(["h1"]);
  });
});

describe("GET /api/hf/online-count", () => {
  const count = () => hfOnlineCountRoute(new Request("https://api.test/api/hf/online-count"), env);
  it("counts live online hosts only, public, cached 60s", async () => {
    host("a", "online"); host("b", "busy"); host("c", "online", "draft"); host("d", "offline");
    const r = await count();
    expect(await r.json()).toEqual({ count: 1 });
    expect(r.headers.get("cache-control")).toBe("public, max-age=60");
  });
  it("404 when flags are off", async () => { st.cfg = {}; expect((await count()).status).toBe(404); });
});

describe("Notify me route under hfReelsEnabled", () => {
  const call = (method: string, slug = "host-h1") => hfNotifyRoute(new Request(`https://api.test/api/hf/hosts/${slug}/notify`, { method }), env);
  it("401 signed out", async () => { st.uid = null; expect((await call("POST")).status).toBe(401); });
  it("404 when flags are off", async () => { st.cfg = {}; expect((await call("POST")).status).toBe(404); });
  it("one pending subscription per fan+host", async () => {
    st.uid = "fan";
    await call("POST"); await call("POST");
    expect(env.DB_META._raw.prepare("SELECT COUNT(*) n FROM hf_notify").get().n).toBe(1);
    expect(await (await call("GET")).json()).toEqual({ subscribed: true });
  });
  it("a host cannot subscribe to herself", async () => { expect((await call("POST")).status).toBe(409); });
});

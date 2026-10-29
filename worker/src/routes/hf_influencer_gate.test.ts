// [HF-INFLUENCER-GATE-1 2026-10-29] G4 (every account needs a profile + cover photo before a call, a queue join or a booking) and the status model.
import { describe, it, expect, vi, beforeEach } from "vitest";

let cfg: Record<string, unknown> = {};
let activeKinds: string[] = [];
vi.mock("../authz", () => ({ requireUser: async () => ({ uid: "caller1" }), isFail: (u: any) => !!u?.error }));
vi.mock("../money", () => ({ rateLimit: async () => null }));
vi.mock("../hooks", () => ({ track: async () => {}, trackUser: async () => {}, trackException: async () => {} }));
vi.mock("./config", () => ({ readConfig: async () => ({ hfCallsEnabled: true, hfBookingsEnabled: true, ...cfg }) }));
vi.mock("../lib/hf_exit", () => ({ isClosing: async () => false, forceHostOffline: async () => {}, CLOSING_MESSAGE: "closing" }));
vi.mock("../lib/whatsapp_notify", () => ({ verifiedWhatsAppNumber: async () => "+910000000000" }));
vi.mock("../lib/hf_calls_store", async (orig) => ({ ...(await orig() as object), callsConfigured: () => true }));

import { hfCallsRoute } from "./hf_calls";
import { hfBookingsRoute } from "./hf_bookings";
import { photosRequiredBlock, missingPhotos } from "../lib/hf_user_photos";
import { isInfluencer } from "../lib/hf_influencer";

const env = {
  HF_CALL: {},
  DB_META: {
    prepare: (sql: string) => ({
      bind: (..._a: unknown[]) => ({
        first: async () => {
          if (sql.includes("hf_age_confirm")) return { confirmed_at: 1 };
          if (sql.includes("FROM hf_hosts")) return { uid: "h1", slug: "priya-aaaa", status: "live", display_name: "Priya", price_per_min: 12, category: null, women_lane: 0, lgbtq_lane: 0, presence: "online" };
          return null;
        },
        all: async () => ({ results: sql.includes("hf_user_photos") ? activeKinds.map((kind) => ({ kind })) : [] }),
        run: async () => ({ meta: { changes: 0 } }),
      }),
    }),
  },
} as any;

const post = (path: string, body: unknown) => new Request("https://x" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { cfg = {}; activeKinds = []; });

describe("isInfluencer", () => {
  it("only live and paused are influencers; every other status (including the retired ones) is not", () => {
    expect(isInfluencer("live")).toBe(true);
    expect(isInfluencer("paused")).toBe(true);
    for (const s of ["draft", "approved", "pending_check", "pending_review", "generating", "pending_host", "rejected", "archived", "", null, undefined]) expect(isInfluencer(s as any)).toBe(false);
  });
});

describe("G4: photos_required", () => {
  it("missingPhotos: an active profile (or influencer photo) plus an active cover", () => {
    expect(missingPhotos(new Set())).toEqual(["profile", "cover"]);
    expect(missingPhotos(new Set(["profile"]))).toEqual(["cover"]);
    expect(missingPhotos(new Set(["host", "cover"]))).toEqual([]);
  });
  it("the gate is ON when the flag is unset, and 403 photos_required carries the plain message", async () => {
    const r = await photosRequiredBlock(env, "u1", "call");
    expect(r!.status).toBe(403);
    expect(await r!.json()).toMatchObject({ ok: false, error: "photos_required", message: "Add your photo and cover photo first.", missing: ["profile", "cover"] });
  });
  it("hfPhotosRequiredEnabled=false is the kill switch; photos present passes", async () => {
    cfg = { hfPhotosRequiredEnabled: false };
    expect(await photosRequiredBlock(env, "u1", "call")).toBeNull();
    cfg = {}; activeKinds = ["profile", "cover"];
    expect(await photosRequiredBlock(env, "u1", "booking")).toBeNull();
  });
  it("placing a call without both photos -> 403 photos_required", async () => {
    activeKinds = ["profile"];
    const r = await hfCallsRoute(post("/api/hf/calls", { hostSlug: "priya-aaaa" }), env, "/api/hf/calls");
    expect(r!.status).toBe(403);
    expect(await r!.json()).toMatchObject({ error: "photos_required", missing: ["cover"] });
  });
  it("creating a booking quote without photos -> 403 photos_required; with both photos the gate lets it through", async () => {
    const body = { hostSlug: "priya-aaaa", startUtc: "2026-11-01T10:00:00Z", durationMinutes: 30 };
    const r = await hfBookingsRoute(post("/api/hf/bookings/quote", body), env);
    expect(r!.status).toBe(403);
    expect(((await r!.json()) as any).error).toBe("photos_required");
    activeKinds = ["profile", "cover"];
    const ok = await hfBookingsRoute(post("/api/hf/bookings/quote", body), env);
    expect(((await ok!.json().catch(() => ({}))) as any).error).not.toBe("photos_required");
  });
});

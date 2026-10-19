// [HF-WIRE-14] HF-REEL-34: a demo host never takes a call or a booking -> 409 demo_host "This is a demo profile. Calls open soon."
import { describe, it, expect, vi } from "vitest";

vi.mock("../authz", () => ({ requireUser: async () => ({ uid: "caller1" }), isFail: (u: any) => !!u?.error }));
vi.mock("../money", () => ({ rateLimit: async () => null }));
vi.mock("../hooks", () => ({ track: async () => {}, trackUser: async () => {}, trackException: async () => {} }));
vi.mock("./config", () => ({ readConfig: async () => ({ hfCallsEnabled: true, hfBookingsEnabled: true }) }));
vi.mock("../lib/hf_exit", () => ({ isClosing: async () => false, forceHostOffline: async () => {}, CLOSING_MESSAGE: "closing" }));
vi.mock("../lib/whatsapp_notify", () => ({ verifiedWhatsAppNumber: async () => "+910000000000" }));
vi.mock("../lib/hf_calls_store", async (orig) => ({ ...(await orig() as object), callsConfigured: () => true }));

import { hfCallsRoute } from "./hf_calls";
import { hfBookingsRoute } from "./hf_bookings";

const env = {
  HF_CALL: {},
  DB_META: {
    prepare: (sql: string) => ({
      bind: (..._a: unknown[]) => ({
        first: async () => {
          if (sql.includes("hf_demo_hosts")) return { x: 1 };
          if (sql.includes("FROM hf_hosts")) return { uid: "demo_abc", slug: "priya-demo", status: "approved", display_name: "Priya", price_per_min: 12, category: null, women_lane: 0, lgbtq_lane: 0, presence: "online" };
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 0 } }),
      }),
    }),
  },
} as any;

const post = (path: string, body: unknown) => new Request("https://x" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("demo hosts take no calls or bookings", () => {
  it("call start -> 409 demo_host with the friendly message", async () => {
    const r = await hfCallsRoute(post("/api/hf/calls", { hostSlug: "priya-demo" }), env, "/api/hf/calls");
    expect(r!.status).toBe(409);
    expect(await r!.json()).toMatchObject({ error: "demo_host", message: "This is a demo profile. Calls open soon." });
  });
  it("booking quote -> 409 demo_host", async () => {
    const r = await hfBookingsRoute(post("/api/hf/bookings/quote", { hostSlug: "priya-demo", startUtc: "2026-11-01T10:00:00Z", durationMinutes: 30 }), env);
    expect(r!.status).toBe(409);
    expect(await r!.json()).toMatchObject({ error: "demo_host", message: "This is a demo profile. Calls open soon." });
  });
});

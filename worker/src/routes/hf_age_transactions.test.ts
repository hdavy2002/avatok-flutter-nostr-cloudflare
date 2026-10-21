import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import type { BookingRow } from "./hf_bookings";
vi.mock("../authz", () => ({ requireUser: async () => ({ uid: "fan" }), isFail: () => false }));
vi.mock("./config", () => ({ readConfig: async () => ({ hfCallsEnabled: true, hfBookingsEnabled: true }) }));
vi.mock("../money", () => ({ rateLimit: async () => null }));
vi.mock("../lib/hf_demo", () => ({ isDemoHost: async () => false, DEMO_MESSAGE: "demo" }));
vi.mock("../lib/hf_calls_store", async orig => ({ ...(await orig() as object), callsConfigured: () => true }));
import { hfCallsRoute } from "./hf_calls";
import { quoteRoute, startBookingCore } from "./hf_bookings";

function fixture(fails = false) {
  const writes = vi.fn();
  const provider = vi.fn();
  const reads: string[] = [];
  const env = {
    DB_META: {
      prepare: (sql: string) => ({ bind: (..._args: unknown[]) => ({
        first: async () => {
          reads.push(sql);
          if (sql.includes("hf_age_confirm")) { if (fails) throw new Error("db"); return null; }
          if (sql.includes("hf_hosts")) return { uid: "host", status: "live", slug: "host-one" };
          throw new Error("Unexpected read after age gate: " + sql);
        },
        run: writes,
      }) }),
      batch: writes,
    },
    HF_CALL: { idFromName: (id: string) => id, get: () => ({ fetch: provider }) },
  } as unknown as Env;
  return { env, writes, provider, reads };
}
const post = (path: string, body: unknown) => new Request("https://example.test" + path, { method: "POST", body: JSON.stringify(body) });
describe("AGE-01 / AGE-04 transaction boundaries", () => {
  for (const failure of [false, true]) {
    it(`instant call denies before reservation/provider (storage failure=${failure})`, async () => {
      const f = fixture(failure);
      const r = await hfCallsRoute(post("/api/hf/calls", { hostSlug: "host-one" }), f.env, "/api/hf/calls");
      expect(r?.status).toBe(failure ? 503 : 403);
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.provider).not.toHaveBeenCalled();
      expect(f.reads).toHaveLength(1);
    });
    it(`quote denies before quote insertion (storage failure=${failure})`, async () => {
      const f = fixture(failure);
      const r = await quoteRoute(post("/api/hf/bookings/quote", { hostSlug: "host-one", startUtc: "2026-11-01T10:00:00Z", durationMinutes: 30 }), f.env);
      expect(r.status).toBe(failure ? 503 : 403);
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.provider).not.toHaveBeenCalled();
    });
    for (const status of ["confirmed", "starting", "active"]) {
      it(`legacy scheduled ${status} cannot start/recover without age (storage failure=${failure})`, async () => {
        const f = fixture(failure);
        const row = { id: "booking-1", customer_uid: "fan", host_uid: "host", status } as BookingRow;
        const r = await startBookingCore(f.env, row, null, Date.now());
        expect(r.status).toBe(failure ? 503 : 403);
        expect(f.writes).not.toHaveBeenCalled();
        expect(f.provider).not.toHaveBeenCalled();
        expect(f.reads).toHaveLength(1);
      });
    }
  }
});
